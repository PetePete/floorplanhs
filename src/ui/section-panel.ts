/**
 * Cross-section controls: one storey selector and five cuts.
 *
 * Two rules make or break this panel.
 *
 * Dragging a slider must move the cut *while* you drag. A control that only
 * applies on release turns "find the right plane" into a guessing game. `input`
 * events therefore emit a live change (coalesced to one animation frame, since
 * a slider fires far faster than the compositor cares about) and `change` emits
 * the persistable one.
 *
 * And every slider runs the same way: from nothing at the left to the far side
 * of the house at the right. The numbers are depths in metres taken off that
 * face, not coordinates, so "front" and "back" do not count in opposite
 * directions and zero always means the house is whole. Which face is which is
 * answered by pointing at a row: the plan outlines it.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon } from '@/ui/icons';
import {
  AXIS_INDEX,
  CUT_GEOMETRY,
  OPPOSITE_SIDE,
  cutHeadroom,
} from '@/engine/section/cut-sides';
import {
  CUT_SIDES,
  DEFAULT_SECTION_STATE,
  type CutSide,
  type LevelDefinition,
  type SectionCuts,
  type SectionState,
  type Vec3,
} from '@/types/config';

interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Fallback span per axis before the model has loaded, so the sliders still move. */
const FALLBACK_EXTENT = 10;

@defineFp('fp3d-section-panel')
export class Fp3dSectionPanel extends FpBaseElement {
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
        width: 268px;
        max-width: 100%;
        max-height: 100%;
        min-height: 0;
      }

      .body {
        padding: 10px 14px 14px;
        min-height: 0;
      }

      .cut {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: var(--fp3d-touch);
      }

      .cut .name {
        flex: none;
        width: 44px;
        font-size: 11.5px;
        font-weight: 600;
        color: var(--fp3d-text-dim);
        transition: color var(--fp3d-fast) var(--fp3d-ease);
      }

      .cut[data-active='true'] .name {
        color: var(--fp3d-accent);
      }

      .cut input[type='range'] {
        flex: 1 1 auto;
        min-width: 0;
      }

      .cut input[type='range']:disabled {
        opacity: 0.35;
      }

      .value {
        flex: none;
        width: 46px;
        text-align: right;
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        color: var(--fp3d-text-dim);
      }

      .clear {
        flex: none;
        width: 26px;
        height: 26px;
        border-radius: var(--fp3d-chrome-radius);
      }

      .clear .fp-icon {
        width: 15px;
        height: 15px;
      }

      /* Holds the row height steady whether or not the button is there. */
      .clear[hidden] {
        display: block;
        visibility: hidden;
      }

      .hint {
        margin: 2px 0 6px;
        font-size: 11px;
        line-height: 1.35;
        color: var(--fp3d-text-dim);
        opacity: 0.8;
      }

      .cap-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .cap-row label {
        flex: 1;
        font-size: 12px;
        color: var(--fp3d-text-dim);
      }

      .foot {
        display: flex;
        justify-content: flex-end;
        margin-top: 12px;
      }
    `,
  ];

  @property({ attribute: false }) section: SectionState = { ...DEFAULT_SECTION_STATE };
  @property({ attribute: false }) levels: LevelDefinition[] = [];
  @property({ attribute: false }) bounds: Bounds | null = null;

  private liveFrame = 0;
  private pendingLive: SectionState | null = null;
  private previewing: CutSide | null = null;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.liveFrame) cancelAnimationFrame(this.liveFrame);
    this.liveFrame = 0;
    // The outline belongs to the pointer, and the pointer is gone with us.
    if (this.previewing) this.preview(null);
  }

  /** One emit per frame while dragging; the last value always wins. */
  private emitLive(section: SectionState): void {
    this.pendingLive = section;
    if (this.liveFrame) return;
    this.liveFrame = requestAnimationFrame(() => {
      this.liveFrame = 0;
      const pending = this.pendingLive;
      this.pendingLive = null;
      if (pending) this.emit('fp3d-section-change', { section: pending, live: true });
    });
  }

  private emitCommit(section: SectionState): void {
    if (this.liveFrame) {
      cancelAnimationFrame(this.liveFrame);
      this.liveFrame = 0;
      this.pendingLive = null;
    }
    this.emit('fp3d-section-change', { section, live: false });
  }

  private preview(side: CutSide | null): void {
    if (this.previewing === side) return;
    this.previewing = side;
    this.emit('fp3d-section-preview', { side });
    this.requestUpdate();
  }

  private cuts(): SectionCuts {
    return this.section.cuts ?? {};
  }

  private depth(side: CutSide): number {
    const value = this.cuts()[side];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  private withCut(side: CutSide, depth: number): SectionState {
    const cuts: SectionCuts = { ...this.cuts() };
    if (depth > 0) cuts[side] = Number(depth.toFixed(3));
    else delete cuts[side];
    return { ...this.section, cuts };
  }

  /**
   * How far this side can be cut: the model's reach along that axis, less
   * whatever the side facing it has already taken. Two cuts that meet in the
   * middle leave nothing between them and no way to tell which slider to pull
   * back, so the slider stops where the other one starts.
   */
  private range(side: CutSide): number {
    const index = AXIS_INDEX[CUT_GEOMETRY[side].axis];
    if (!this.bounds) return FALLBACK_EXTENT;
    const facing = OPPOSITE_SIDE[side];
    const room = cutHeadroom(
      this.bounds.min[index],
      this.bounds.max[index],
      facing ? this.depth(facing) : 0,
    );
    // A genuine zero means the facing cut has taken the lot, and the slider
    // should say so by refusing to move rather than quietly allowing more.
    return room;
  }

  private sideLabel(side: CutSide): string {
    const fallback: Record<CutSide, string> = {
      top: 'Top',
      left: 'Left',
      right: 'Right',
      front: 'Front',
      back: 'Back',
    };
    return this.t(`ui.section.side_${side}`, fallback[side]);
  }

  private setLevel(levelId: string): void {
    this.emitCommit({
      ...this.section,
      levelId: levelId || null,
      mode: levelId ? 'level' : 'none',
    });
  }

  private reset(): void {
    this.emitCommit({ ...DEFAULT_SECTION_STATE, cuts: {}, capColor: this.section.capColor });
  }

  private renderCut(side: CutSide): TemplateResult {
    const depth = this.depth(side);
    const max = this.range(side);
    const label = this.sideLabel(side);
    const clear = this.t('ui.section.clear_cut', 'Undo this cut');
    return html`
      <div class="cut" data-active=${depth > 0 || this.previewing === side ? 'true' : 'false'}>
        <span class="name">${label}</span>
        <input
          type="range"
          min="0"
          max=${max}
          step=${Math.max(0.01, Number((max / 200).toFixed(3)))}
          .value=${String(Math.min(depth, max))}
          ?disabled=${max <= 0}
          aria-label=${label}
          @pointerenter=${() => this.preview(side)}
          @pointerleave=${() => this.preview(null)}
          @focus=${() => this.preview(side)}
          @blur=${() => this.preview(null)}
          @input=${(event: Event) =>
            this.emitLive(this.withCut(side, Number((event.target as HTMLInputElement).value)))}
          @change=${(event: Event) =>
            this.emitCommit(this.withCut(side, Number((event.target as HTMLInputElement).value)))}
        />
        <span class="value">${depth > 0 ? `${depth.toFixed(2)} m` : '—'}</span>
        <button
          class="icon-btn clear"
          ?hidden=${depth === 0}
          aria-label=${clear}
          title=${clear}
          @click=${() => this.emitCommit(this.withCut(side, 0))}
        >
          ${icon('close')}
        </button>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const levelId = this.section.mode === 'level' ? (this.section.levelId ?? '') : '';

    return html`
      <div class="panel surface solid" role="region" aria-label=${this.t('ui.toolbar.section', 'Section')}>
        <div class="sheet-title">
          ${icon('section')}
          <span>${this.t('ui.toolbar.section', 'Section')}</span>
          <span class="spacer"></span>
          <button
            class="icon-btn"
            aria-label=${this.t('ui.action.close', 'Close')}
            @click=${() => this.emit('fp3d-section-close', {})}
          >
            ${icon('close')}
          </button>
        </div>
        <div class="body scroll-y">
          ${this.levels.length > 1
            ? html`
                <div class="section-label">${this.t('ui.section.storey', 'Storey')}</div>
                <select
                  aria-label=${this.t('ui.section.storey', 'Storey')}
                  .value=${levelId}
                  @change=${(event: Event) => this.setLevel((event.target as HTMLSelectElement).value)}
                >
                  <option value="" ?selected=${levelId === ''}>
                    ${this.t('ui.section.whole_house', 'Whole house')}
                  </option>
                  ${this.levels.map(
                    (level) =>
                      html`<option value=${level.id} ?selected=${levelId === level.id}>
                        ${level.name}
                      </option>`,
                  )}
                </select>
              `
            : nothing}
          <div class="section-label">${this.t('ui.section.cuts', 'Cut in from')}</div>
          <p class="hint">
            ${this.t('ui.section.cuts_hint', 'Point at a side to see where it cuts.')}
          </p>
          ${CUT_SIDES.map((side) => this.renderCut(side))}
          <div class="section-label">${this.t('ui.section.appearance', 'Appearance')}</div>
          <div class="cap-row">
            <label for="fp3d-cap-color">${this.t('ui.section.cap_color', 'Cut colour')}</label>
            <input
              id="fp3d-cap-color"
              type="color"
              aria-label=${this.t('ui.section.cap_color', 'Cut colour')}
              .value=${this.section.capColor ?? '#8a8f98'}
              @change=${(event: Event) =>
                this.emitCommit({
                  ...this.section,
                  capColor: (event.target as HTMLInputElement).value,
                })}
            />
          </div>
          <div class="foot">
            <button class="text-btn" @click=${this.reset}>
              ${icon('refresh')}${this.t('ui.action.reset', 'Reset')}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-section-panel': Fp3dSectionPanel;
  }
}
