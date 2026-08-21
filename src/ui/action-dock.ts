/**
 * The shelf for entities that have no place in the house.
 *
 * A script is an errand — "good night", "leave home" — not a thing hanging on a
 * wall. Pinning one to a spot on the floor says something false about it, and
 * puts it behind whichever wall the camera happens to be on the wrong side of.
 * They live here instead, in the order you dropped them, next to the navigator
 * they are shaped after.
 *
 * Anything can go on the shelf, not just scripts: a scene, a switch you reach
 * for constantly, a vacuum. What decides is whether it belongs *somewhere*.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';

import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon, resolveIconName } from '@/ui/icons';
import type { EntityVisualState } from '@/engine/contracts';
import type { ShortcutItem } from '@/types/config';

const ENTITY_DRAG_MIME = 'application/x-ha-entity';

@defineFp('fp3d-action-dock')
export class Fp3dActionDock extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        display: block;
        pointer-events: none;
        min-height: 0;
      }

      .stack {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px;
        border-radius: var(--fp3d-chrome-radius);
        /* One width for both panels in the rail; see --fp3d-rail-width. */
        width: var(--fp3d-rail-width, 208px);
        max-width: 100%;
        box-sizing: border-box;
        max-height: 100%;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        pointer-events: auto;
      }

      .label {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px 4px;
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: var(--fp3d-label-tracking);
        text-transform: uppercase;
        color: var(--fp3d-text-dim);
      }

      .label::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--fp3d-divider);
      }

      /* The fold sits after the rule, at the end of the row. */
      .label .fold {
        order: 3;
        margin: -2px -4px -2px 2px;
      }

      .row {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 36px;
        padding: 0 8px;
        border-radius: var(--fp3d-chrome-radius);
        color: var(--fp3d-text);
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
        text-align: left;
        width: 100%;
        box-sizing: border-box;
        transition:
          background-color var(--fp3d-fast) var(--fp3d-ease),
          color var(--fp3d-fast) var(--fp3d-ease);
      }

      .row:hover {
        background: var(--fp3d-hover);
      }

      /* Running, playing, on: the same "this is happening" the markers use. */
      .row[data-active='true'] {
        color: var(--fp3d-accent);
      }

      /* The row is the frame; this is the part you press. */
      .trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        padding: 0;
        cursor: pointer;
        pointer-events: auto;
      }

      .row .fp-icon {
        width: 17px;
        height: 17px;
        flex: none;
        opacity: 0.8;
      }

      .name {
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
        max-width: 150px;
      }

      .state {
        font-size: 11px;
        color: var(--fp3d-text-dim);
      }

      /* Finger-sized, with a ground of its own: a bare chevron in a corner is
         not a control anyone finds on a phone. */
      .fold {
        min-width: 34px;
        min-height: 26px;
        display: grid;
        place-items: center;
        border: none;
        border-radius: var(--fp3d-chrome-radius);
        background: var(--fp3d-hover);
        color: var(--fp3d-text-dim);
        cursor: pointer;
        pointer-events: auto;
      }

      .fold:hover {
        color: var(--fp3d-text);
      }

      .fold .fp-icon {
        width: 17px;
        height: 17px;
      }

      /* Folded: still says what it is and how much is in it. */
      .peek {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 8px;
        min-height: 34px;
        max-width: 190px;
        border: none;
        border-radius: var(--fp3d-chrome-radius);
        color: var(--fp3d-text);
        font: inherit;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        pointer-events: auto;
      }

      .peek:hover {
        background: var(--fp3d-hover);
      }

      .peek .fp-icon {
        width: 16px;
        height: 16px;
        flex: none;
        opacity: 0.8;
      }

      .drop {
        outline: 1px dashed var(--fp3d-accent);
        outline-offset: -3px;
      }

      /* The invitation, and the only thing on the shelf while it is empty. */
      .hint {
        padding: 8px;
        font-size: 11.5px;
        line-height: 1.35;
        color: var(--fp3d-text-dim);
        max-width: 180px;
      }

      .remove {
        flex: none;
        width: 26px;
        height: 26px;
        display: grid;
        place-items: center;
        border-radius: var(--fp3d-chrome-radius);
        color: var(--fp3d-text-dim);
        pointer-events: auto;
      }

      .remove:hover {
        background: var(--fp3d-hover);
        color: var(--fp3d-danger, #db4437);
      }
    `,
  ];

  @property({ attribute: false }) items: ShortcutItem[] = [];
  /** Live state per entity, keyed by id; the card feeds this from `hass`. */
  @property({ attribute: false }) visuals: Record<string, EntityVisualState> = {};
  @property({ type: Boolean }) editMode = false;
  /** Folded to a chip. Held by the card, like the navigator's. */
  @property({ type: Boolean }) collapsed = false;

  @state() private dropping = false;

  protected override render(): TemplateResult | typeof nothing {
    // Nothing to show and nothing to drop: the shelf is not a decoration.
    if (this.items.length === 0 && !this.editMode) return nothing;

    if (this.collapsed) {
      return html`
        <button
          class="surface peek"
          title=${this.t('ui.dock.expand', 'Show actions')}
          aria-expanded="false"
          @click=${() => this.emit('fp3d-dock-collapse', { collapsed: false })}
        >
          ${icon('play')}
          <span class="name">${this.t('ui.dock.title', 'Actions')}</span>
          ${this.items.length > 0 ? html`<span class="state">${this.items.length}</span>` : nothing}
        </button>
      `;
    }

    return html`
      <div
        class="stack surface ${this.dropping ? 'drop' : ''}"
        role="group"
        aria-label=${this.t('ui.dock.title', 'Actions')}
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        <div class="label">
          ${this.t('ui.dock.title', 'Actions')}
          <button
            class="fold"
            title=${this.t('ui.dock.collapse', 'Hide actions')}
            aria-expanded="true"
            @click=${() => this.emit('fp3d-dock-collapse', { collapsed: true })}
          >
            ${icon('chevronLeft')}
          </button>
        </div>
        ${this.items.map((item) => this.renderItem(item))}
        ${this.items.length === 0
          ? html`<p class="hint">
              ${this.t('ui.dock.empty', 'Drop a script or scene here — things that happen, rather than things that sit somewhere.')}
            </p>`
          : nothing}
      </div>
    `;
  }

  private renderItem(item: ShortcutItem): TemplateResult {
    const visual = this.visuals[item.entity];
    const name = item.name ?? visual?.label ?? item.entity;
    const glyph = resolveIconName(item.icon ?? visual?.icon, 'play');

    return html`
      <div class="row" data-active=${visual?.active === true ? 'true' : 'false'}>
        <button
          class="trigger"
          title=${name}
          @click=${() => this.emit('fp3d-shortcut-run', { entityId: item.entity })}
        >
          ${icon(glyph)}
          <span class="name">${name}</span>
          ${visual?.secondary ? html`<span class="state">${visual.secondary}</span>` : nothing}
        </button>
        ${this.editMode
          ? html`<button
              class="remove"
              aria-label=${this.t('ui.action.remove', 'Remove')}
              @click=${() => this.emit('fp3d-shortcut-remove', { entityId: item.entity })}
            >
              ${icon('trash')}
            </button>`
          : nothing}
      </div>
    `;
  }

  private readonly onDragOver = (event: DragEvent): void => {
    if (!this.editMode || !this.carries(event)) return;
    // Without this the browser refuses the drop outright.
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dropping = true;
  };

  private readonly onDragLeave = (event: DragEvent): void => {
    const related = event.relatedTarget;
    if (related instanceof Node && this.renderRoot.contains(related)) return;
    this.dropping = false;
  };

  private readonly onDrop = (event: DragEvent): void => {
    if (!this.editMode) return;
    event.preventDefault();
    // The canvas is a drop target too, and it is underneath us.
    event.stopPropagation();
    this.dropping = false;
    const entityId =
      event.dataTransfer?.getData(ENTITY_DRAG_MIME) || event.dataTransfer?.getData('text/plain');
    if (entityId) this.emit('fp3d-shortcut-add', { entityId });
  };

  private carries(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    return Boolean(types && Array.prototype.includes.call(types, ENTITY_DRAG_MIME));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-action-dock': Fp3dActionDock;
  }
}
