/**
 * Cross-section controls.
 *
 * The one rule that makes or breaks this panel: dragging a slider must move the
 * cut *while* you drag. A control that only applies on release turns "find the
 * right plane" into a guessing game. `input` events therefore emit a live
 * change (coalesced to one animation frame, since a slider fires far faster
 * than the compositor cares about) and `change` emits the persistable one.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon } from '@/ui/icons';
import {
  DEFAULT_SECTION_STATE,
  type Axis,
  type ClipPlaneState,
  type LevelDefinition,
  type SectionMode,
  type SectionState,
  type Vec3,
} from '@/types/config';

const AXES: Axis[] = ['x', 'y', 'z'];
const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

interface Bounds {
  min: Vec3;
  max: Vec3;
}

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

      .modes {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 4px;
        padding: 3px;
        border-radius: var(--fp3d-chrome-radius);
        background: var(--fp3d-hover);
      }

      .mode {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 32px;
        padding: 0 6px;
        border-radius: var(--fp3d-chrome-radius);
        font-size: 11.5px;
        font-weight: 600;
        color: var(--fp3d-text-dim);
        transition:
          background-color var(--fp3d-fast) var(--fp3d-ease),
          color var(--fp3d-fast) var(--fp3d-ease);
      }

      .mode[aria-pressed='true'] {
        background: var(--fp3d-card-bg);
        color: var(--fp3d-accent);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
      }

      .axis {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: var(--fp3d-touch);
      }

      .axis-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: none;
        width: 30px;
        height: 30px;
        border-radius: var(--fp3d-chrome-radius);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--fp3d-text-dim);
        border: 1px solid var(--fp3d-divider);
        transition:
          background-color var(--fp3d-fast) var(--fp3d-ease),
          color var(--fp3d-fast) var(--fp3d-ease),
          border-color var(--fp3d-fast) var(--fp3d-ease);
      }

      .axis-toggle[aria-pressed='true'] {
        background: var(--fp3d-accent-soft);
        border-color: transparent;
        color: var(--fp3d-accent);
      }

      .axis input[type='range'] {
        flex: 1 1 auto;
        min-width: 0;
      }

      .axis input[type='range']:disabled {
        opacity: 0.35;
      }

      .axis .flip {
        flex: none;
        width: 30px;
        height: 30px;
        border-radius: var(--fp3d-chrome-radius);
      }

      .axis .flip .fp-icon {
        width: 17px;
        height: 17px;
      }

      .value {
        flex: none;
        width: 44px;
        text-align: right;
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
        color: var(--fp3d-text-dim);
      }

      .cap-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .cap-row .switch {
        flex: 1;
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

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.liveFrame) cancelAnimationFrame(this.liveFrame);
    this.liveFrame = 0;
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

  private planes(): ClipPlaneState[] {
    const existing = this.section.planes ?? [];
    return AXES.map(
      (axis) =>
        existing.find((plane) => plane.axis === axis) ?? {
          axis,
          position: 0,
          enabled: false,
          invert: false,
        },
    );
  }

  private withPlane(axis: Axis, patch: Partial<ClipPlaneState>): SectionState {
    return {
      ...this.section,
      planes: this.planes().map((plane) => (plane.axis === axis ? { ...plane, ...patch } : plane)),
    };
  }

  /** Slider range follows the model, with a metre of slack at each end. */
  private range(axis: Axis): { min: number; max: number; step: number } {
    const index = AXIS_INDEX[axis];
    const min = this.bounds ? this.bounds.min[index] - 0.5 : -10;
    const max = this.bounds ? this.bounds.max[index] + 0.5 : 10;
    return { min, max, step: Math.max(0.01, (max - min) / 400) };
  }

  private setMode(mode: SectionMode): void {
    const next: SectionState = { ...this.section, mode };
    // Isolating a level with nothing selected does nothing visible; pick the
    // lowest storey so the control always has an effect.
    if (mode === 'level' && !next.levelId && this.levels.length) {
      next.levelId = [...this.levels].sort((a, b) => a.elevation - b.elevation)[0].id;
    }
    if (mode === 'plane' && !this.planes().some((plane) => plane.enabled)) {
      next.planes = this.planes().map((plane) =>
        plane.axis === 'y'
          ? { ...plane, enabled: true, position: this.midpoint('y') }
          : { ...plane },
      );
    }
    this.emitCommit(next);
  }

  private midpoint(axis: Axis): number {
    const { min, max } = this.range(axis);
    return Number(((min + max) / 2).toFixed(3));
  }

  private reset(): void {
    this.emitCommit({
      ...DEFAULT_SECTION_STATE,
      planes: DEFAULT_SECTION_STATE.planes.map((plane) => ({ ...plane })),
      caps: this.section.caps,
      capColor: this.section.capColor,
    });
  }

  private renderModes(): TemplateResult {
    const modes: Array<{ mode: SectionMode; label: string }> = [
      { mode: 'none', label: this.t('ui.section.none', 'Off') },
      { mode: 'level', label: this.t('ui.section.level', 'Level') },
      { mode: 'plane', label: this.t('ui.section.plane', 'Plane') },
    ];
    return html`<div class="modes" role="group" aria-label=${this.t('ui.toolbar.section', 'Section')}>
      ${modes.map(
        (entry) => html`
          <button
            class="mode"
            aria-pressed=${this.section.mode === entry.mode ? 'true' : 'false'}
            @click=${() => this.setMode(entry.mode)}
          >
            ${entry.label}
          </button>
        `,
      )}
    </div>`;
  }

  private renderAxis(plane: ClipPlaneState): TemplateResult {
    const { min, max, step } = this.range(plane.axis);
    const label = this.t(`ui.section.axis_${plane.axis}`, `${plane.axis.toUpperCase()} axis`);
    return html`
      <div class="axis">
        <button
          class="axis-toggle"
          aria-pressed=${plane.enabled ? 'true' : 'false'}
          aria-label=${label}
          title=${label}
          @click=${() => this.emitCommit(this.withPlane(plane.axis, { enabled: !plane.enabled }))}
        >
          ${plane.axis}
        </button>
        <input
          type="range"
          min=${min}
          max=${max}
          step=${step}
          .value=${String(plane.position)}
          ?disabled=${!plane.enabled}
          aria-label=${label}
          @input=${(event: Event) =>
            this.emitLive(
              this.withPlane(plane.axis, {
                position: Number((event.target as HTMLInputElement).value),
              }),
            )}
          @change=${(event: Event) =>
            this.emitCommit(
              this.withPlane(plane.axis, {
                position: Number((event.target as HTMLInputElement).value),
              }),
            )}
        />
        <span class="value">${plane.position.toFixed(2)}</span>
        <button
          class="icon-btn flip"
          aria-pressed=${plane.invert ? 'true' : 'false'}
          aria-label=${this.t('ui.section.invert', 'Flip side')}
          title=${this.t('ui.section.invert', 'Flip side')}
          ?disabled=${!plane.enabled}
          @click=${() => this.emitCommit(this.withPlane(plane.axis, { invert: !plane.invert }))}
        >
          ${icon(plane.invert ? 'arrowLeft' : 'arrowRight')}
        </button>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const mode = this.section.mode;
    const showPlanes = mode === 'plane';

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
          ${this.renderModes()}
          ${mode === 'level'
            ? html`
                <div class="section-label">${this.t('ui.section.level', 'Isolate level')}</div>
                <select
                  aria-label=${this.t('ui.section.level', 'Isolate level')}
                  .value=${this.section.levelId ?? ''}
                  @change=${(event: Event) =>
                    this.emitCommit({
                      ...this.section,
                      levelId: (event.target as HTMLSelectElement).value || null,
                    })}
                >
                  ${this.levels.map(
                    (level) =>
                      html`<option value=${level.id} ?selected=${this.section.levelId === level.id}>
                        ${level.name}
                      </option>`,
                  )}
                </select>
              `
            : nothing}
          ${showPlanes
            ? html`
                <div class="section-label">${this.t('ui.section.planes', 'Cut planes')}</div>
                ${this.planes().map((plane) => this.renderAxis(plane))}
              `
            : nothing}
          <div class="section-label">${this.t('ui.section.appearance', 'Appearance')}</div>
          <div class="cap-row">
            <button
              class="switch"
              role="switch"
              aria-checked=${this.section.caps !== false ? 'true' : 'false'}
              @click=${() => this.emitCommit({ ...this.section, caps: this.section.caps === false })}
            >
              <span>${this.t('ui.section.caps', 'Solid cuts')}</span>
              <span class="track"></span>
            </button>
            <input
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
