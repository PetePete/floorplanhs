/**
 * Vertical zoom control, sitting under the orientation cube.
 *
 * Built from a rotated horizontal `<input type="range">` rather than a
 * `writing-mode: vertical` one: the vertical form is still inconsistent across
 * the WebViews the Home Assistant companion apps ship, and a slider that reads
 * upside-down on one platform is worse than a transform.
 */

import { css, html, nothing } from 'lit';
import { property, query } from 'lit/decorators.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon } from '@/ui/icons';

/** One button press. Small enough to be a nudge, large enough to be felt. */
const STEP = 0.08;

@defineFp('fp3d-zoom-slider')
export class Fp3dZoomSlider extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        display: block;
        pointer-events: none;
      }

      .wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 4px;
        border-radius: 999px;
        pointer-events: auto;
      }

      .btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 999px;
        color: var(--fp3d-text-dim);
        transition:
          color var(--fp3d-fast) var(--fp3d-ease),
          background-color var(--fp3d-fast) var(--fp3d-ease);
      }

      .btn:hover,
      .btn:focus-visible {
        color: var(--fp3d-text);
        background: var(--fp3d-hover);
      }

      .btn .fp-icon {
        width: 16px;
        height: 16px;
      }

      /*
       * The track is rotated, so the element's own box is horizontal while the
       * slot it occupies is vertical. Width and height are swapped by hand.
       */
      .track {
        position: relative;
        width: 28px;
        height: var(--fp3d-zoom-length, 112px);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      input[type='range'] {
        position: absolute;
        width: var(--fp3d-zoom-length, 112px);
        height: 28px;
        margin: 0;
        transform: rotate(-90deg);
        background: transparent;
        appearance: none;
        -webkit-appearance: none;
        cursor: pointer;
      }

      input[type='range']::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 2px;
        background: var(--fp3d-divider);
      }

      input[type='range']::-moz-range-track {
        height: 4px;
        border-radius: 2px;
        background: var(--fp3d-divider);
      }

      input[type='range']::-webkit-slider-thumb {
        appearance: none;
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        margin-top: -5px;
        border-radius: 50%;
        background: var(--fp3d-accent);
        border: 2px solid var(--fp3d-surface-solid, #fff);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      }

      input[type='range']::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--fp3d-accent);
        border: 2px solid var(--fp3d-surface-solid, #fff);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      }

      input[type='range']:focus-visible {
        outline: none;
      }

      input[type='range']:focus-visible::-webkit-slider-thumb {
        box-shadow: 0 0 0 3px var(--fp3d-focus-ring);
      }

      :host([data-size='narrow']) .track {
        --fp3d-zoom-length: 84px;
      }
    `,
  ];

  /** 0 = furthest away, 1 = closest. */
  @property({ type: Number }) value = 0.5;
  @property({ type: Boolean }) compact = false;

  @query('input') private input?: HTMLInputElement;

  private commit(next: number): void {
    const clamped = Math.min(1, Math.max(0, next));
    this.value = clamped;
    if (this.input) this.input.value = String(clamped);
    this.emit('fp3d-zoom', { value: clamped });
  }

  protected override render() {
    return html`
      <div class="wrap surface" role="group" aria-label=${this.t('ui.zoom.label', 'Zoom')}>
        <button
          class="btn"
          aria-label=${this.t('ui.zoom.in', 'Zoom in')}
          title=${this.t('ui.zoom.in', 'Zoom in')}
          @click=${() => this.commit(this.value + STEP)}
        >
          ${icon('plus')}
        </button>
        <div class="track">
          <input
            type="range"
            min="0"
            max="1"
            step="0.005"
            .value=${String(this.value)}
            aria-label=${this.t('ui.zoom.label', 'Zoom')}
            aria-orientation="vertical"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${Math.round(this.value * 100)}
            @input=${(event: Event) =>
              this.commit(Number((event.target as HTMLInputElement).value))}
          />
        </div>
        <button
          class="btn"
          aria-label=${this.t('ui.zoom.out', 'Zoom out')}
          title=${this.t('ui.zoom.out', 'Zoom out')}
          @click=${() => this.commit(this.value - STEP)}
        >
          ${icon('minus')}
        </button>
      </div>
      ${nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-zoom-slider': Fp3dZoomSlider;
  }
}
