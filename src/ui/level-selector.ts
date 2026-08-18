/**
 * The navigator: saved views on top, storeys below, in one panel down the side.
 *
 * These were two controls — a bar of view chips along the bottom and a lift
 * panel on the left — and they answered overlapping questions, which meant
 * reading both to find out where you were. They are one list now, in the order
 * you reach for them: a view is a whole state (camera, cross-section, which
 * storeys are drawn), a storey is only what is drawn.
 *
 * The storey order matches the building — top floor at the top. A list in array
 * order puts the basement above the attic half the time, and then every label
 * has to be read instead of just reaching for the top button.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon, resolveIconName } from '@/ui/icons';
import type { CameraPreset } from '@/types/config';

@defineFp('fp3d-level-selector')
export class Fp3dLevelSelector extends FpBaseElement {
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
        max-height: 100%;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      .group {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-height: 0;
      }

      .group + .group {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px solid var(--fp3d-divider);
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

      .row[aria-pressed='true'] {
        background: var(--fp3d-accent-soft);
        color: var(--fp3d-accent);
        box-shadow: inset 2px 0 0 var(--fp3d-accent);
      }

      /* The "car is here" lamp. Solid when the storey is the one on screen. */
      .lamp {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1.5px solid currentColor;
        opacity: 0.35;
        transition:
          opacity var(--fp3d-fast) var(--fp3d-ease),
          background-color var(--fp3d-fast) var(--fp3d-ease),
          box-shadow var(--fp3d-fast) var(--fp3d-ease);
      }

      .row[aria-pressed='true'] .lamp {
        opacity: 1;
        background: currentColor;
        box-shadow: 0 0 0 3px var(--fp3d-accent-soft);
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

      .stack.compact .name {
        display: none;
      }

      /* Edit affordances, shown for the row you are on. */
      .actions {
        display: flex;
        align-items: center;
        gap: 1px;
        margin-left: auto;
        opacity: 0;
        transition: opacity var(--fp3d-fast) var(--fp3d-ease);
      }

      .entry:hover .actions,
      .entry:focus-within .actions {
        opacity: 1;
      }

      .entry {
        display: flex;
        align-items: center;
      }

      .mini {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: var(--fp3d-chrome-radius);
        color: var(--fp3d-text-dim);
      }

      .mini:hover {
        background: var(--fp3d-press);
        color: var(--fp3d-text);
      }

      .mini[aria-pressed='true'] {
        color: var(--fp3d-accent);
      }

      .mini .fp-icon {
        width: 14px;
        height: 14px;
      }

      .save {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 34px;
        padding: 0 8px;
        border-radius: var(--fp3d-chrome-radius);
        color: var(--fp3d-text-dim);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: var(--fp3d-label-tracking);
        text-transform: uppercase;
      }

      .save:hover {
        background: var(--fp3d-hover);
        color: var(--fp3d-text);
      }

      .save .fp-icon {
        width: 15px;
        height: 15px;
      }

      input {
        width: 100%;
        min-height: 30px;
        font-size: 12.5px;
      }
    `,
  ];

  /** The whole building. Generated; empty when there is no model yet. */
  @property({ attribute: false }) overview: CameraPreset[] = [];
  /** One view per storey, top floor first. Generated from the model. */
  @property({ attribute: false }) levelViews: CameraPreset[] = [];
  /** Views the user saved. These are the only ones that can be edited. */
  @property({ attribute: false }) presets: CameraPreset[] = [];
  @property({ type: String }) activePresetId: string | null = null;
  @property({ type: Boolean }) editMode = false;
  /** False when the dashboard cannot persist, so saving would be a dead end. */
  @property({ type: Boolean }) canSave = false;

  @state() private naming = false;
  @state() private renamingId: string | null = null;
  @state() private draft = '';

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const rows = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('.row')];
    const current = rows.indexOf(event.target as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    rows[(current + step + rows.length) % rows.length]?.focus();
  }

  private commitName(): void {
    const name = this.draft.trim();
    if (!name) {
      this.cancelName();
      return;
    }
    if (this.renamingId) this.emit('fp3d-preset-patch', { presetId: this.renamingId, patch: { name } });
    else this.emit('fp3d-preset-save', { name });
    this.cancelName();
  }

  private cancelName(): void {
    this.naming = false;
    this.renamingId = null;
    this.draft = '';
  }

  private onNameKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitName();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelName();
    }
  }

  private nameField(placeholder: string): TemplateResult {
    return html`<input
      type="text"
      .value=${this.draft}
      placeholder=${placeholder}
      autofocus
      @input=${(event: Event) => {
        this.draft = (event.target as HTMLInputElement).value;
      }}
      @keydown=${this.onNameKey}
      @blur=${() => this.commitName()}
    />`;
  }

  private renderPreset(preset: CameraPreset, editable: boolean): TemplateResult {
    if (this.renamingId === preset.id) {
      return html`<div class="entry">${this.nameField(preset.name)}</div>`;
    }

    const active = this.activePresetId === preset.id;
    return html`
      <div class="entry">
        <button
          class="row"
          aria-pressed=${active ? 'true' : 'false'}
          title=${preset.name}
          @click=${() => this.emit('fp3d-preset-select', { presetId: preset.id })}
        >
          ${icon(resolveIconName(preset.icon, 'camera'))}
          <span class="name">${preset.name}</span>
          ${this.editMode && editable
            ? html`<span class="actions">
                <button
                  class="mini"
                  aria-pressed=${preset.default ? 'true' : 'false'}
                  aria-label=${this.t('ui.preset.make_default', 'Open on this view')}
                  title=${this.t('ui.preset.make_default', 'Open on this view')}
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    this.emit('fp3d-preset-patch', {
                      presetId: preset.id,
                      patch: { default: !preset.default },
                    });
                  }}
                >
                  ${icon(preset.default ? 'star' : 'starOutline')}
                </button>
                <button
                  class="mini"
                  aria-label=${this.t('ui.preset.rename', 'Rename')}
                  title=${this.t('ui.preset.rename', 'Rename')}
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    this.draft = preset.name;
                    this.renamingId = preset.id;
                  }}
                >
                  ${icon('pencil')}
                </button>
                <button
                  class="mini"
                  aria-label=${this.t('ui.preset.delete', 'Delete')}
                  title=${this.t('ui.preset.delete', 'Delete')}
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    this.emit('fp3d-preset-remove', { presetId: preset.id });
                  }}
                >
                  ${icon('trash')}
                </button>
              </span>`
            : nothing}
        </button>
      </div>
    `;
  }

  protected override render(): TemplateResult | typeof nothing {
    const groups: Array<{ label: string; items: CameraPreset[]; editable: boolean }> = [
      { label: this.t('ui.preset.whole_house', 'Building'), items: this.overview, editable: false },
      { label: this.t('ui.toolbar.levels', 'Levels'), items: this.levelViews, editable: false },
      { label: this.t('ui.preset.saved_group', 'Saved views'), items: this.presets, editable: true },
    ];
    const showSave = this.editMode && this.canSave;
    if (groups.every((group) => group.items.length === 0) && !showSave) return nothing;

    return html`
      <div
        class="stack surface ${this.size === 'narrow' ? 'compact' : ''}"
        role="group"
        aria-label=${this.t('ui.preset.title', 'Camera views')}
        @keydown=${this.onKeyDown}
      >
        ${groups.map((group) => {
          const last = group.editable;
          if (group.items.length === 0 && !(last && showSave)) return nothing;
          return html`<div class="group">
            <div class="label">${group.label}</div>
            ${group.items.map((preset) => this.renderPreset(preset, group.editable))}
            ${last && showSave
              ? this.naming
                ? this.nameField(this.t('ui.preset.name_placeholder', 'View name'))
                : html`<button
                    class="save"
                    @click=${() => {
                      this.draft = '';
                      this.naming = true;
                    }}
                  >
                    ${icon('plus')}
                    <span>${this.t('ui.preset.save_current', 'Save current view')}</span>
                  </button>`
              : nothing}
          </div>`;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-level-selector': Fp3dLevelSelector;
  }
}
