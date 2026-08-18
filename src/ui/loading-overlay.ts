/**
 * The first thing anyone sees. ARCHITECTURE.md rule 7 says the shell must paint
 * before the model, which means this overlay is on screen for the whole
 * download — so it gets a real skeleton of a house rather than a spinner on a
 * blank card, and a determinate bar whenever the loader knows a byte total.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import type { ModelLoadProgress } from '@/engine/contracts';

@defineFp('fp3d-loading-overlay')
export class Fp3dLoadingOverlay extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        position: absolute;
        inset: 0;
        display: block;
        pointer-events: none;
        z-index: 3;
      }

      .wrap {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 22px;
        background: var(--fp3d-card-bg);
        transition: opacity var(--fp3d-slow) var(--fp3d-ease);
      }

      :host([exiting]) .wrap {
        opacity: 0;
      }

      /* A flat-shaded house in three tones of the theme's own text colour: it
         reads as "your model is coming" instead of as a broken image. */
      .skeleton {
        width: min(56%, 260px);
        max-height: 46%;
        opacity: 0.14;
        color: var(--fp3d-text);
      }

      .skeleton svg {
        display: block;
        width: 100%;
        height: auto;
        fill: currentColor;
      }

      .sweep {
        position: absolute;
        inset: 0;
        background: linear-gradient(
          105deg,
          transparent 35%,
          var(--fp3d-hover) 50%,
          transparent 65%
        );
        background-size: 260% 100%;
        animation: fp3d-sweep 1900ms linear infinite;
      }

      .panel {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        width: min(78%, 300px);
      }

      .bar {
        position: relative;
        width: 100%;
        height: 4px;
        border-radius: 1px;
        background: var(--fp3d-press);
        overflow: hidden;
      }

      .fill {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: 1px;
        background: var(--fp3d-accent);
        transition: width var(--fp3d-slow) var(--fp3d-ease);
      }

      /* No byte total (a lot of glTF servers send no content-length): keep the
         bar honest by making it indeterminate rather than faking a percentage. */
      .fill.indeterminate {
        width: 38%;
        animation: fp3d-indeterminate 1400ms var(--fp3d-ease) infinite;
      }

      .phase {
        font-size: 12.5px;
        font-weight: 500;
        color: var(--fp3d-text-dim);
        text-align: center;
        min-height: 1.2em;
      }

      .bytes {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--fp3d-text-dim);
        opacity: 0.75;
      }

      @keyframes fp3d-sweep {
        from {
          background-position: 160% 0;
        }
        to {
          background-position: -60% 0;
        }
      }

      @keyframes fp3d-indeterminate {
        0% {
          transform: translateX(-110%);
        }
        100% {
          transform: translateX(320%);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .sweep {
          animation: none;
          opacity: 0.4;
        }
        .fill.indeterminate {
          animation: none;
          width: 100%;
          opacity: 0.5;
        }
      }
    `,
  ];

  @property({ attribute: false }) progress: ModelLoadProgress | null = null;

  /** Set by the card for one frame so the overlay can fade instead of vanish. */
  @property({ type: Boolean, reflect: true }) exiting = false;

  /** Highest fraction seen, so a multi-phase load never appears to go backwards. */
  @state() private ratchet = 0;

  protected override willUpdate(): void {
    const fraction = this.fraction();
    if (fraction !== null && fraction > this.ratchet) this.ratchet = fraction;
  }

  private fraction(): number | null {
    const p = this.progress;
    if (!p) return null;
    if (p.phase === 'done') return 1;
    if (typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0) {
      return Math.min(1, Math.max(0, p.loaded / p.total));
    }
    // Coarse fallback so the bar still advances through the known phases.
    if (p.phase === 'parse') return 0.7;
    if (p.phase === 'prepare') return 0.9;
    return null;
  }

  private phaseText(): string {
    const p = this.progress;
    if (p?.message) return p.message;
    switch (p?.phase) {
      case 'download':
        return this.t('ui.empty.loading_model', 'Loading model…');
      case 'parse':
      case 'prepare':
        return this.t('ui.empty.preparing', 'Preparing scene…');
      default:
        return this.t('ui.empty.preparing', 'Preparing scene…');
    }
  }

  private bytesText(): string | null {
    const p = this.progress;
    if (typeof p?.loaded !== 'number' || typeof p.total !== 'number' || p.total <= 0) return null;
    const mb = (value: number) => (value / 1_048_576).toFixed(1);
    return `${mb(p.loaded)} / ${mb(p.total)} MB`;
  }

  protected override render(): TemplateResult {
    const fraction = this.fraction();
    const value = fraction === null ? this.ratchet : Math.max(this.ratchet, fraction);
    const determinate = value > 0;
    const bytes = this.bytesText();

    return html`
      <div class="wrap" role="status" aria-live="polite">
        <div class="sweep"></div>
        <div class="skeleton" aria-hidden="true">
          <svg viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg">
            <path d="M100 8 L192 62 L176 62 L176 112 L24 112 L24 62 L8 62 Z" opacity="0.55" />
            <path d="M24 62 L100 18 L176 62 L176 112 L100 112 Z" opacity="0.35" />
            <rect x="44" y="76" width="26" height="26" rx="3" opacity="0.9" />
            <rect x="130" y="76" width="26" height="26" rx="3" opacity="0.9" />
            <rect x="88" y="80" width="24" height="32" rx="3" opacity="0.9" />
          </svg>
        </div>
        <div class="panel">
          <div
            class="bar"
            role="progressbar"
            aria-label=${this.phaseText()}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${determinate ? Math.round(value * 100) : 0}
          >
            <div
              class=${classMap({ fill: true, indeterminate: !determinate })}
              style=${determinate ? styleMap({ width: `${(value * 100).toFixed(1)}%` }) : nothing}
            ></div>
          </div>
          <div class="phase">${this.phaseText()}</div>
          ${bytes ? html`<div class="bytes">${bytes}</div>` : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-loading-overlay': Fp3dLoadingOverlay;
  }
}
