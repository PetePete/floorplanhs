/**
 * Settings for a stack, opened by tapping its grab bar.
 *
 * A stack has exactly two things of its own: the room its leader line runs to,
 * and the colour it is drawn in. Everything else belongs to the markers in it —
 * a pile groups chips on the screen and never speaks for the entities inside,
 * so what a lamp is called and which room it hangs in is set on the lamp.
 *
 * That is also why this is a panel of its own rather than a section of the
 * entity inspector: the entity inspector edits one marker, and here the subject
 * is the group.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';

import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon } from '@/ui/icons';
import { getEntityName } from '@/ha/registry';
import { anchorKey } from '@/engine/model/room-anchors';
import type { LevelDefinition, PlacedEntity } from '@/types/config';

/** The ink a pile falls back to, and what the picker opens on. */
const DEFAULT_COLOR = '#03a9f4';

export interface StackSelection {
  id: string;
  members: PlacedEntity[];
}

@defineFp('fp3d-stack-inspector')
export class Fp3dStackInspector extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        display: flex;
        pointer-events: none;
        max-height: 100%;
        min-height: 0;
      }

      .panel {
        display: flex;
        flex-direction: column;
        width: 296px;
        max-width: 100%;
        max-height: 100%;
        min-height: 0;
      }

      .body {
        padding: 4px 14px 14px;
        min-height: 0;
      }

      /* The members, in the order they are drawn. What each of them *is* stays
         out on the plan — tap the row there to edit one. */
      .members {
        list-style: none;
        margin: 8px 0 4px;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .members li {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 30px;
        padding-right: 2px;
        border-radius: var(--fp3d-chrome-radius);
        font-size: 12.5px;
        color: var(--fp3d-text);
      }

      .members li:hover {
        background: var(--fp3d-hover);
      }

      /* Where the row would land: a rule drawn between two rows rather than a
         gap that opens. The list is three or four items long, and things
         jumping about in it is worse than a line. */
      .members li.over-top {
        box-shadow: inset 0 2px 0 var(--fp3d-accent);
      }

      .members li.over-bottom {
        box-shadow: inset 0 -2px 0 var(--fp3d-accent);
      }

      .members li.dragging {
        opacity: 0.45;
      }

      .grip {
        flex: none;
        display: grid;
        place-items: center;
        width: 18px;
        height: 24px;
        color: var(--fp3d-text-dim);
        cursor: grab;
      }

      .grip .fp-icon {
        width: 14px;
        height: 14px;
      }

      .who {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        line-height: 1.2;
      }

      .members .id {
        font-size: 10.5px;
        color: var(--fp3d-text-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Buttons as well as the grip: dragging a list works with a mouse and
         nowhere near a finger, and this card is meant for a wall panel too. */
      .nudge {
        flex: none;
        width: 24px;
        height: 24px;
        display: grid;
        place-items: center;
        border: none;
        border-radius: var(--fp3d-chrome-radius);
        background: none;
        color: var(--fp3d-text-dim);
        cursor: pointer;
      }

      .nudge:hover:not(:disabled) {
        background: var(--fp3d-hover);
        color: var(--fp3d-text);
      }

      .nudge:disabled {
        opacity: 0.25;
        cursor: default;
      }

      .nudge .fp-icon {
        width: 15px;
        height: 15px;
      }

      .color-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .color-row .value {
        flex: 1;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: var(--fp3d-text-dim);
      }

      .link {
        border: none;
        background: none;
        padding: 0;
        font: inherit;
        font-size: 12px;
        color: var(--fp3d-text-dim);
        text-decoration: underline;
        cursor: pointer;
      }

      .link:hover {
        color: var(--fp3d-text);
      }

      .note {
        margin: 10px 0 0;
        font-size: 11.5px;
        line-height: 1.35;
        color: var(--fp3d-text-dim);
      }
    `,
  ];

  @property({ attribute: false }) stack: StackSelection | null = null;
  /** Rooms the model declares, for pointing the pile's line at one by hand. */
  @property({ attribute: false }) rooms: Array<{ id: string; level: string | null }> = [];
  /** Storey names, so a room that exists on several of them can be told apart. */
  @property({ attribute: false }) levels: LevelDefinition[] = [];

  /** The row in hand and the row under the cursor, as positions in the list. */
  @state() private dragRow: number | null = null;
  @state() private overRow: number | null = null;

  /** What the pile says about itself; every member carries the same answer. */
  private get shared(): { room?: string; color?: string } {
    const members = this.stack?.members ?? [];
    return {
      room: members.find((entry) => entry.stackRoom)?.stackRoom,
      color: members.find((entry) => entry.stackColor)?.stackColor,
    };
  }

  /**
   * Every room in the house, not just the ones on the pile's own storey.
   *
   * This is a line on a drawing, and a drawing is allowed to label something on
   * another floor — a shelf of readings parked clear of the plan is exactly the
   * case where the pile and the room it talks about are not in the same place.
   * (An entity's own `room` is a different matter: it says where the thing *is*,
   * and the entity inspector keeps that on its storey.)
   *
   * A room id is unique per storey and not across the building, so a name that
   * turns up twice is written down storey-qualified and shown with the storey.
   */
  private get roomOptions(): Array<{ value: string; label: string }> {
    const counts = new Map<string, number>();
    for (const room of this.rooms) counts.set(room.id, (counts.get(room.id) ?? 0) + 1);

    return this.rooms.map((room) => {
      if (!room.level || (counts.get(room.id) ?? 0) < 2) {
        return { value: room.id, label: room.id };
      }
      const level = this.levels.find((entry) => entry.id === room.level);
      return {
        value: anchorKey(room.level, room.id),
        label: `${room.id} · ${level?.name ?? room.level}`,
      };
    });
  }

  private patch(patch: { stackRoom?: string; stackColor?: string }): void {
    const stack = this.stack;
    if (!stack || stack.members.length === 0) return;
    // Addressed to one member: the card writes what a pile says about itself to
    // all of them, the same way it does when a marker joins.
    this.emit('fp3d-entity-patch', { entityId: stack.members[0].entity, patch });
  }

  /** Move a row, and say so once. */
  private reorder(from: number, to: number): void {
    if (from === to) return;
    this.emit('fp3d-stack-reorder', { from, to });
  }

  private renderMember(member: PlacedEntity, index: number, count: number): TemplateResult {
    const name = member.name ?? getEntityName(this.hass, member.entity);
    // The line goes on the side the row would arrive from, which is the
    // question a drop between two rows is really asking.
    const over =
      this.overRow === index && this.dragRow !== null && this.dragRow !== index
        ? this.dragRow > index
          ? 'over-top'
          : 'over-bottom'
        : '';

    return html`
      <li
        class=${[over, this.dragRow === index ? 'dragging' : ''].filter(Boolean).join(' ')}
        draggable="true"
        @dragstart=${(event: DragEvent) => {
          this.dragRow = index;
          // Firefox refuses to start a drag with an empty payload.
          event.dataTransfer?.setData('text/plain', member.entity);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        }}
        @dragover=${(event: DragEvent) => {
          if (this.dragRow === null) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          this.overRow = index;
        }}
        @drop=${(event: DragEvent) => {
          event.preventDefault();
          // The canvas is a drop target too, and it is underneath us.
          event.stopPropagation();
          const from = this.dragRow;
          this.dragRow = null;
          this.overRow = null;
          if (from !== null) this.reorder(from, index);
        }}
        @dragend=${() => {
          this.dragRow = null;
          this.overRow = null;
        }}
      >
        <span class="grip" aria-hidden="true">${icon('drag')}</span>
        <span class="who">
          <span>${name}</span>
          <span class="id">${member.entity}</span>
        </span>
        <button
          class="nudge"
          ?disabled=${index === 0}
          aria-label=${this.t('ui.stack.move_up', 'Move up')}
          title=${this.t('ui.stack.move_up', 'Move up')}
          @click=${() => this.reorder(index, index - 1)}
        >
          ${icon('chevronUp')}
        </button>
        <button
          class="nudge"
          ?disabled=${index === count - 1}
          aria-label=${this.t('ui.stack.move_down', 'Move down')}
          title=${this.t('ui.stack.move_down', 'Move down')}
          @click=${() => this.reorder(index, index + 1)}
        >
          ${icon('chevronDown')}
        </button>
      </li>
    `;
  }

  protected override render(): TemplateResult | typeof nothing {
    const stack = this.stack;
    if (!stack || stack.members.length < 2) return nothing;

    const shared = this.shared;
    const color = shared.color ?? DEFAULT_COLOR;

    return html`
      <div
        class="panel surface solid"
        role="region"
        aria-label=${this.t('ui.stack.title', 'Stack settings')}
      >
        <div class="sheet-title">
          ${icon('layers')}
          <span>${this.t('ui.stack.title', 'Stack settings')}</span>
          <span class="spacer"></span>
          <button
            class="icon-btn"
            aria-label=${this.t('ui.action.close', 'Close')}
            @click=${() => this.emit('fp3d-stack-close', {})}
          >
            ${icon('close')}
          </button>
        </div>

        <div class="body scroll-y">
          <!-- Listed the way the pile is drawn: bottom row first. That row is
               also the one that keeps the anchor dot and the leader line. -->
          <ul class="members" aria-label=${this.t('ui.stack.members', 'Rows, bottom first')}>
            ${stack.members.map((member, index) =>
              this.renderMember(member, index, stack.members.length),
            )}
          </ul>

          ${this.rooms.length > 0
            ? html`<div class="field">
                <span class="field-label">${this.t('ui.stack.room', 'Line to room')}</span>
                <select
                  aria-label=${this.t('ui.stack.room', 'Line to room')}
                  @change=${(event: Event) =>
                    this.patch({
                      stackRoom: (event.target as HTMLSelectElement).value || undefined,
                    })}
                >
                  <option value="" ?selected=${!shared.room}>
                    ${this.t('ui.stack.room_none', 'no line')}
                  </option>
                  ${this.roomOptions.map(
                    (room) => html`<option value=${room.value} ?selected=${shared.room === room.value}>
                      ${room.label}
                    </option>`,
                  )}
                </select>
              </div>`
            : nothing}

          <div class="field">
            <span class="field-label">${this.t('ui.stack.color', 'Colour')}</span>
            <div class="color-row">
              <input
                type="color"
                .value=${color}
                aria-label=${this.t('ui.stack.color', 'Colour')}
                @change=${(event: Event) =>
                  this.patch({ stackColor: (event.target as HTMLInputElement).value })}
              />
              <span class="value">${shared.color ?? this.t('ui.action.auto', 'Auto')}</span>
              ${shared.color
                ? html`<button class="link" @click=${() => this.patch({ stackColor: undefined })}>
                    ${this.t('ui.action.reset', 'Reset')}
                  </button>`
                : nothing}
            </div>
          </div>

          <p class="note">
            ${this.t(
              'ui.stack.note',
              'A stack groups these markers on screen. Each of them keeps its own room and settings — tap a row to edit one.',
            )}
          </p>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-stack-inspector': Fp3dStackInspector;
  }
}
