/**
 * The fallback the user actually sees when something breaks. A custom card that
 * fails silently to a blank rectangle is worse than one that never loaded, so
 * this always says what went wrong, why, and what to do next — with the raw
 * cause tucked into a details block for whoever has to file the bug.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon } from '@/ui/icons';

export type ErrorKind = 'webgl' | 'model' | 'config' | 'unknown';

export interface CardError {
  kind: ErrorKind;
  message: string;
  cause?: unknown;
}

/** The raw cause, flattened to something a user can copy into an issue. */
function describeCause(cause: unknown): string | null {
  if (cause === undefined || cause === null) return null;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}\n${cause.stack ?? ''}`.trim();
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause, null, 2);
  } catch {
    return String(cause);
  }
}

@defineFp('fp3d-error-panel')
export class Fp3dErrorPanel extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        position: absolute;
        inset: 0;
        display: block;
        z-index: 4;
      }

      .wrap {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        box-sizing: border-box;
        background: var(--fp3d-card-bg);
        animation: fp3d-fade var(--fp3d-normal) var(--fp3d-ease);
      }

      .box {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        width: 100%;
        max-width: 420px;
        text-align: center;
      }

      .badge {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        color: var(--fp3d-warning);
        background: var(--fp3d-hover);
      }

      :host([severity='error']) .badge {
        color: var(--fp3d-error);
      }

      .badge .fp-icon {
        width: 28px;
        height: 28px;
      }

      h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--fp3d-text);
      }

      p {
        margin: 0;
        font-size: 13.5px;
        line-height: 1.5;
        color: var(--fp3d-text-dim);
      }

      code {
        font-family: var(--code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 12px;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--fp3d-hover);
      }

      .actions {
        display: flex;
        gap: 8px;
        margin-top: 4px;
      }

      details {
        width: 100%;
        margin-top: 6px;
        text-align: left;
        border-top: 1px solid var(--fp3d-divider);
        padding-top: 10px;
      }

      summary {
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        color: var(--fp3d-text-dim);
        list-style: none;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
      }

      summary::-webkit-details-marker {
        display: none;
      }

      summary .fp-icon {
        width: 16px;
        height: 16px;
        transition: transform var(--fp3d-fast) var(--fp3d-ease);
      }

      details[open] summary .fp-icon {
        transform: rotate(180deg);
      }

      pre {
        margin: 6px 0 0;
        padding: 10px;
        max-height: 180px;
        overflow: auto;
        font-family: var(--code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--fp3d-text);
        background: var(--fp3d-hover);
        border-radius: var(--fp3d-radius-sm);
      }

      @keyframes fp3d-fade {
        from {
          opacity: 0;
        }
      }
    `,
  ];

  @property({ attribute: false }) error: CardError | null = null;

  /** `error` for things that stop the card, `warning` for degraded operation. */
  @property({ type: String, reflect: true }) severity: 'error' | 'warning' = 'error';

  private headline(kind: ErrorKind): string {
    switch (kind) {
      case 'webgl':
        return this.t('ui.error.webgl_title', '3D is not available here');
      case 'model':
        return this.t('ui.error.model_title', 'The model could not be loaded');
      case 'config':
        return this.t('ui.error.config', 'Configuration error');
      default:
        return this.t('ui.error.generic', 'Something went wrong');
    }
  }

  /** What the user can actually do about it — one sentence, no jargon. */
  private advice(kind: ErrorKind): TemplateResult | typeof nothing {
    switch (kind) {
      case 'webgl':
        return html`<p>
          ${this.t(
            'ui.error.webgl',
            'This browser or device has no WebGL support, so the 3D view cannot be shown.',
          )}
        </p>`;
      case 'model':
        return html`<p>
          ${this.t(
            'ui.error.model_advice',
            'Check that the file exists and that the path is reachable from the browser.',
          )}
          <code>/local/…</code>
        </p>`;
      case 'config':
        return html`<p>
          ${this.t(
            'ui.error.config_advice',
            'Fix the highlighted key in the card YAML and the view will reload.',
          )}
        </p>`;
      default:
        return nothing;
    }
  }

  private retry = (): void => {
    this.emit('fp3d-retry', { kind: this.error?.kind ?? 'unknown' });
  };

  protected override render(): TemplateResult | typeof nothing {
    const error = this.error;
    if (!error) return nothing;

    const cause = describeCause(error.cause);
    // Retrying a missing WebGL context or a rejected config just fails again.
    const canRetry = error.kind === 'model' || error.kind === 'unknown';

    return html`
      <div class="wrap" role="alert">
        <div class="box">
          <div class="badge">${icon('alert')}</div>
          <h2>${this.headline(error.kind)}</h2>
          ${this.advice(error.kind)}
          <p>${error.message}</p>
          ${canRetry
            ? html`<div class="actions">
                <button class="text-btn primary" @click=${this.retry}>
                  ${icon('refresh')}${this.t('ui.error.retry', 'Try again')}
                </button>
              </div>`
            : nothing}
          ${cause
            ? html`<details>
                <summary>
                  ${icon('chevronDown')}${this.t('ui.error.details', 'Technical details')}
                </summary>
                <pre>${cause}</pre>
              </details>`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-error-panel': Fp3dErrorPanel;
  }
}
