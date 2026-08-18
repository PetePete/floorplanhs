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
        padding: 5px 4px;
        border-radius: var(--fp3d-chrome-radius);
        pointer-events: auto;
      }

      /* The value, as an instrument reads it out. */
      .readout {
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: var(--fp3d-label-tracking);
        font-variant-numeric: tabular-nums;
        color: var(--fp3d-text-dim);
        padding-top: 2px;
        user-select: none;
      }

      .btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--fp3d-chrome-radius);
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

      /*
       * Graduations behind the slider, as on a gauge: eight ticks across the
       * travel, with the axis itself running through them. Drawn on the track
       * rather than on the input, because a range element's own track cannot
       * carry a repeating background across browsers.
       */
      .track::before {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image:
          repeating-linear-gradient(
            to bottom,
            var(--fp3d-divider) 0 1px,
            transparent 1px calc(100% / 8)
          ),
          linear-gradient(var(--fp3d-divider), var(--fp3d-divider));
        background-size:
          9px 100%,
          1px 100%;
        background-position:
          center top,
          center top;
        background-repeat: no-repeat;
        opacity: 0.9;
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

      /* The graduations are the track; the input's own is only a hit area. */
      input[type='range']::-webkit-slider-runnable-track {
        height: 4px;
        background: transparent;
      }

      input[type='range']::-moz-range-track {
        height: 4px;
        background: transparent;
      }

      /*
       * A cursor rather than a bead: a flat bar lying across the graduations,
       * which is how an instrument marks a value.
       */
      input[type='range']::-webkit-slider-thumb {
        appearance: none;
        -webkit-appearance: none;
        width: 6px;
        height: 18px;
        margin-top: -7px;
        border-radius: 1px;
        background: var(--fp3d-accent);
        box-shadow: 0 0 8px -1px var(--fp3d-accent);
      }

      input[type='range']::-moz-range-thumb {
        width: 6px;
        height: 18px;
        border: none;
        border-radius: 1px;
        background: var(--fp3d-accent);
        box-shadow: 0 0 8px -1px var(--fp3d-accent);
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
        <span class="readout" aria-hidden="true">${Math.round(this.value * 100)}</span>
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
