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
import { property } from 'lit/decorators.js';

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

      /* The members, so it is obvious which pile this is. Read-only: they are
         edited by tapping the row itself, out on the plan. */
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
        align-items: baseline;
        gap: 6px;
        font-size: 12.5px;
        color: var(--fp3d-text);
      }

      .members .id {
        font-size: 10.5px;
        color: var(--fp3d-text-dim);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
          <ul class="members">
            ${stack.members.map(
              (member) => html`
                <li>
                  <span>${member.name ?? getEntityName(this.hass, member.entity)}</span>
                  <span class="id">${member.entity}</span>
                </li>
              `,
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
