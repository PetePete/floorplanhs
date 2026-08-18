/**
 * Saved camera views as a scrollable strip of chips.
 *
 * In view mode it is one tap to fly somewhere. In edit mode the same strip
 * gains save, rename, reorder, delete, set-default and tour toggles — inline,
 * because a modal dialog for renaming a camera view is an interruption nobody
 * asked for.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon, resolveIconName } from '@/ui/icons';
import type { CameraPreset } from '@/types/config';

@defineFp('fp3d-preset-bar')
export class Fp3dPresetBar extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        display: block;
        pointer-events: none;
      }

      .bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px;
        border-radius: var(--fp3d-chrome-radius);
        max-width: 100%;
      }

      .strip {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1 1 auto;
        min-width: 0;
        padding: 1px;
        /* The scrollport must not swallow a vertical page scroll on touch. */
        touch-action: pan-x;
      }

      /*
       * A tab on a console rather than a pill: square, with the accent riding
       * up its leading edge when it is the view you are in. The label keeps the
       * user's own capitalisation — spaced capitals are for machine labels, and
       * a preset name is not one.
       */
      .preset {
        position: relative;
        display: flex;
        align-items: center;
        gap: 7px;
        flex: none;
        height: 36px;
        padding: 0 12px;
        border-radius: var(--fp3d-chrome-radius);
        font-size: 12.5px;
        font-weight: 500;
        letter-spacing: 0.02em;
        color: var(--fp3d-text);
        white-space: nowrap;
        transition:
          background-color var(--fp3d-fast) var(--fp3d-ease),
          color var(--fp3d-fast) var(--fp3d-ease),
          transform var(--fp3d-fast) var(--fp3d-ease);
      }

      .preset:hover {
        background: var(--fp3d-hover);
      }

      .preset.active {
        background: var(--fp3d-accent-soft);
        color: var(--fp3d-accent);
        box-shadow:
          inset 2px 0 0 var(--fp3d-accent),
          0 0 10px -3px var(--fp3d-accent);
      }

      .preset.dragging {
        opacity: 0.4;
      }

      /* A hairline ring plus a badge says "not committed" without shouting. */
      .preset.local {
        box-shadow: inset 0 0 0 1px var(--fp3d-divider);
      }

      .local-badge {
        flex: none;
        padding: 1px 6px;
        border-radius: 1px;
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: var(--fp3d-label-tracking);
        text-transform: uppercase;
        color: var(--fp3d-warning);
        border: 1px dashed currentColor;
      }

      .save-cta {
        white-space: nowrap;
      }

      .preset.drop-before::before,
      .preset.drop-after::after {
        content: '';
        position: absolute;
        top: 4px;
        bottom: 4px;
        width: 2px;
        border-radius: 1px;
        background: var(--fp3d-accent);
      }

      .preset.drop-before::before {
        left: -4px;
      }

      .preset.drop-after::after {
        right: -4px;
      }

      .preset .fp-icon {
        width: 17px;
        height: 17px;
      }

      .thumb {
        width: 34px;
        height: 22px;
        border-radius: 4px;
        object-fit: cover;
        flex: none;
        background: var(--fp3d-hover);
        box-shadow: 0 0 0 1px var(--fp3d-hairline) inset;
      }

      /* A chip is a <button>; the edit affordance cannot nest inside one. */
      .slot {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex: none;
      }

      .edit-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--fp3d-chrome-radius);
        color: var(--fp3d-text-dim);
        opacity: 0.75;
        transition:
          opacity var(--fp3d-fast) var(--fp3d-ease),
          background-color var(--fp3d-fast) var(--fp3d-ease);
      }

      .edit-chip:hover,
      .edit-chip:focus-visible {
        opacity: 1;
        background: var(--fp3d-hover);
        color: var(--fp3d-text);
      }

      .edit-chip .fp-icon {
        width: 15px;
        height: 15px;
      }

      .badges {
        display: flex;
        align-items: center;
        gap: 2px;
        margin-left: 1px;
        opacity: 0.8;
      }

      .badges .fp-icon {
        width: 13px;
        height: 13px;
      }

      .tools {
        display: flex;
        align-items: center;
        gap: 2px;
        flex: none;
        padding-left: 5px;
        border-left: 1px solid var(--fp3d-divider);
      }

      .tools .icon-btn {
        width: 34px;
        height: 34px;
      }

      .tools .icon-btn .fp-icon {
        width: 19px;
        height: 19px;
      }

      .name-entry {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: none;
        height: 36px;
        padding: 0 4px 0 10px;
        border-radius: var(--fp3d-chrome-radius);
        background: var(--fp3d-hover);
      }

      .name-entry input {
        width: 130px;
        min-height: 28px;
        padding: 2px 6px;
        background: transparent;
      }

      .empty {
        flex: 1;
        padding: 0 12px;
        font-size: 12.5px;
        color: var(--fp3d-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .editor {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin-top: 6px;
        padding: 6px;
        animation: fp3d-editor-in var(--fp3d-fast) var(--fp3d-ease);
      }

      .editor input[type='text'] {
        width: 140px;
        min-height: 30px;
      }

      @keyframes fp3d-editor-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
      }
    `,
  ];

  @property({ attribute: false }) presets: CameraPreset[] = [];
  @property({ type: String }) activeId: string | null = null;
  @property({ type: Boolean }) editMode = false;
  /**
   * Saving is an *additive* action, so it is offered whenever author tools are
   * shown — not only in edit mode. Rotating with the view cube and keeping the
   * result is the single most requested thing this bar does.
   */
  @property({ type: Boolean }) canSave = false;
  /** Ids of views held in this browser only; badged so nobody is surprised. */
  @property({ attribute: false }) localIds: string[] = [];
  /** Mirrors `tour.showControls`; hides the tour badge and its edit toggle. */
  @property({ type: Boolean }) tourControls = true;
  /**
   * Views generated from the model's storeys. They have no config entry to
   * write back to, so every editing affordance is withheld rather than shown
   * and then silently doing nothing.
   */
  @property({ attribute: false }) generatedIds: string[] = [];
  /** Preset id -> data URL. Session-only; see the card's thumbnail capture. */
  @property({ attribute: false }) thumbnails: Record<string, string> = {};
  @property({ type: Boolean }) thumbnailsEnabled = false;

  @state() private naming = false;
  @state() private draftName = '';
  @state() private editingId: string | null = null;
  @state() private dragId: string | null = null;
  @state() private dropIndex: number | null = null;

  private select(preset: CameraPreset): void {
    this.emit('fp3d-preset-select', { presetId: preset.id });
  }

  private patch(presetId: string, patch: Partial<CameraPreset>): void {
    this.emit('fp3d-preset-patch', { presetId, patch });
  }

  private startNaming(): void {
    this.naming = true;
    this.draftName = '';
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLInputElement>('.name-entry input')?.focus();
    });
  }

  private commitName(): void {
    const name = this.draftName.trim() || this.t('ui.preset.untitled', 'New view');
    this.naming = false;
    this.draftName = '';
    this.emit('fp3d-preset-save', { name });
  }

  private onNameKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitName();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.naming = false;
    }
  }

  private deletePreset(preset: CameraPreset): void {
    const message = this.t('ui.preset.delete_confirm', 'Delete the view "{name}"?', {
      name: preset.name,
    });
    if (typeof confirm === 'function' && !confirm(message)) return;
    this.editingId = null;
    this.emit('fp3d-preset-remove', { presetId: preset.id });
  }

  /* ------------------------------------------------------------- reorder */

  private onDragStart(event: DragEvent, preset: CameraPreset): void {
    if (!this.editMode || this.localIds.includes(preset.id)) return;
    this.dragId = preset.id;
    event.dataTransfer?.setData('text/plain', preset.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  private onDragOverChip(event: DragEvent, index: number): void {
    if (!this.dragId) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    this.dropIndex = after ? index + 1 : index;
  }

  private onDrop(event: DragEvent): void {
    if (!this.dragId || this.dropIndex === null) return;
    event.preventDefault();
    const from = this.presets.findIndex((preset) => preset.id === this.dragId);
    let to = this.dropIndex;
    if (from < to) to -= 1;
    if (from >= 0 && to !== from) {
      this.emit('fp3d-preset-move', { presetId: this.dragId, toIndex: to });
    }
    this.dragId = null;
    this.dropIndex = null;
  }

  /** Keyboard reorder: dragging a chip with a keyboard is otherwise impossible. */
  private onChipKeyDown(event: KeyboardEvent, index: number, preset: CameraPreset): void {
    if (!this.editMode || !event.altKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const to = index + (event.key === 'ArrowRight' ? 1 : -1);
    if (to < 0 || to >= this.presets.length) return;
    this.emit('fp3d-preset-move', { presetId: preset.id, toIndex: to });
  }

  /* -------------------------------------------------------------- render */

  private renderChip(preset: CameraPreset, index: number): TemplateResult {
    const thumb = this.thumbnails[preset.id];
    const active = this.activeId === preset.id;
    const local = this.localIds.includes(preset.id);
    const generated = this.generatedIds.includes(preset.id);
    return html`
      <span class="slot">
      <button
        class=${classMap({
          preset: true,
          active,
          local,
          dragging: this.dragId === preset.id,
          'drop-before': this.dropIndex === index,
          'drop-after': this.dropIndex === index + 1 && index === this.presets.length - 1,
        })}
        role="tab"
        aria-selected=${active ? 'true' : 'false'}
        aria-label=${preset.name}
        draggable=${this.editMode && !local && !generated ? 'true' : 'false'}
        @click=${() => this.select(preset)}
        @dblclick=${() => {
          if ((this.editMode || local) && !generated) this.editingId = preset.id;
        }}
        @dragstart=${(event: DragEvent) => this.onDragStart(event, preset)}
        @dragover=${(event: DragEvent) => this.onDragOverChip(event, index)}
        @dragend=${() => {
          this.dragId = null;
          this.dropIndex = null;
        }}
        @keydown=${(event: KeyboardEvent) => this.onChipKeyDown(event, index, preset)}
      >
        ${thumb
          ? html`<img class="thumb" src=${thumb} alt="" aria-hidden="true" />`
          : icon(resolveIconName(preset.icon, preset.orthographic ? 'orthographic' : 'camera'))}
        <span>${preset.name}</span>
        ${local
          ? html`<span
              class="local-badge"
              title=${this.t(
                'ui.preset.local_hint',
                'Saved in this browser only. Copy it into the card config to keep it.',
              )}
              >${this.t('ui.preset.local', 'local')}</span
            >`
          : nothing}
        ${preset.default || (preset.inTour && this.tourControls)
          ? html`<span class="badges" aria-hidden="true">
              ${preset.default ? icon('star') : nothing}${preset.inTour && this.tourControls
                ? icon('play')
                : nothing}
            </span>`
          : nothing}
      </button>
      ${(this.editMode || local) && !generated
        ? html`<button
            class="edit-chip"
            title=${this.t('ui.preset.edit', 'Edit this view')}
            aria-label=${this.t('ui.preset.edit', 'Edit this view')}
            @click=${(event: Event) => {
              event.stopPropagation();
              this.editingId = preset.id;
            }}
          >
            ${icon('pencil')}
          </button>`
        : nothing}
      </span>
    `;
  }

  private renderEditor(preset: CameraPreset): TemplateResult {
    const local = this.localIds.includes(preset.id);
    return html`
      <div
        class="editor surface"
        role="group"
        aria-label=${this.t('ui.preset.title', 'Camera views')}
      >
        ${local
          ? nothing
          : html`<input
              type="text"
              .value=${preset.name}
              aria-label=${this.t('ui.preset.name', 'Name')}
              @change=${(event: Event) =>
                this.patch(preset.id, { name: (event.target as HTMLInputElement).value })}
            />`}
        ${local
          ? html`<span class="hint"
              >${this.t(
                'ui.preset.local_hint',
                'Saved in this browser only. Copy it into the card config to keep it.',
              )}</span
            >`
          : html`
              <button
                class="chip"
                aria-pressed=${preset.default ? 'true' : 'false'}
                @click=${() => this.patch(preset.id, { default: !preset.default })}
              >
                ${icon(preset.default ? 'star' : 'starOutline')}
                ${this.t('ui.preset.make_default', 'Open with this view')}
              </button>
              ${this.tourControls
                ? html`<button
                    class="chip"
                    aria-pressed=${preset.inTour ? 'true' : 'false'}
                    @click=${() => this.patch(preset.id, { inTour: !preset.inTour })}
                  >
                    ${icon('play')}${this.t('ui.preset.include_in_tour', 'Include in tour')}
                  </button>`
                : nothing}
            `}
        <button class="chip" @click=${() => this.deletePreset(preset)}>
          ${icon('trash')}${this.t('ui.preset.delete', 'Delete view')}
        </button>
        <button
          class="icon-btn"
          aria-label=${this.t('ui.action.close', 'Close')}
          @click=${() => {
            this.editingId = null;
          }}
        >
          ${icon('close')}
        </button>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const editing = this.editingId
      ? (this.presets.find((preset) => preset.id === this.editingId) ?? null)
      : null;

    return html`
      <div
        class=${classMap({ bar: true, surface: true, editing: this.editMode })}
        @drop=${this.onDrop}
        @dragover=${(event: DragEvent) => {
          if (this.dragId) event.preventDefault();
        }}
      >
        <div
          class="strip scroll-x"
          role="tablist"
          aria-label=${this.t('ui.preset.title', 'Camera views')}
        >
          ${this.presets.length === 0
            ? html`<span class="empty"
                >${this.canSave
                  ? this.t(
                      'ui.preset.empty',
                      'No saved views yet — position the camera and save one.',
                    )
                  : this.t('ui.preset.empty_readonly', 'No saved views.')}</span
              >`
            : nothing}
          ${repeat(
            this.presets,
            (preset) => preset.id,
            (preset, index) => this.renderChip(preset, index),
          )}
          ${this.naming
            ? html`<div class="name-entry">
                <input
                  type="text"
                  .value=${this.draftName}
                  placeholder=${this.t('ui.preset.name_placeholder', 'Living room')}
                  aria-label=${this.t('ui.preset.name', 'Name')}
                  @input=${(event: Event) => {
                    this.draftName = (event.target as HTMLInputElement).value;
                  }}
                  @keydown=${this.onNameKey}
                />
                <button
                  class="icon-btn"
                  aria-label=${this.t('ui.action.save', 'Save')}
                  @click=${this.commitName}
                >
                  ${icon('check')}
                </button>
              </div>`
            : nothing}
        </div>
        ${this.canSave
          ? html`<div class="tools">
              ${this.size === 'narrow'
                ? html`<button
                    class="icon-btn save-cta"
                    aria-label=${this.t('ui.preset.save_current', 'Save current view')}
                    title=${this.t('ui.preset.save_current', 'Save current view')}
                    @click=${this.startNaming}
                  >
                    ${icon('save')}
                  </button>`
                : html`<button
                    class=${classMap({
                      'text-btn': true,
                      'save-cta': true,
                      primary: this.presets.length === 0,
                    })}
                    aria-label=${this.t('ui.preset.save_current', 'Save current view')}
                    @click=${this.startNaming}
                  >
                    ${icon('save')}${this.t('ui.preset.save_current', 'Save current view')}
                  </button>`}
              ${this.editMode
                ? html`<button
                    class="icon-btn"
                    aria-pressed=${this.thumbnailsEnabled ? 'true' : 'false'}
                    aria-label=${this.t('ui.preset.thumbnails', 'Capture thumbnails')}
                    title=${this.t('ui.preset.thumbnails', 'Capture thumbnails')}
                    @click=${() => this.emit('fp3d-thumbnails', { enabled: !this.thumbnailsEnabled })}
                  >
                    ${icon('camera')}
                  </button>`
                : nothing}
            </div>`
          : nothing}
      </div>
      ${editing ? this.renderEditor(editing) : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-preset-bar': Fp3dPresetBar;
  }
}
