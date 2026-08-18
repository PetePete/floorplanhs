/**
 * The quiet corner: which storey is showing, an optional perf readout, and
 * transient toasts.
 *
 * Toasts are an imperative API rather than a property because they are events,
 * not state — `toast()` is called from the card's intent handler and the
 * message must survive the config round-trip that follows. The Undo action on a
 * placement toast is the cheapest possible safety net: the card already holds
 * the previous config, so undoing is one swap.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon, type IconName } from '@/ui/icons';

export interface ToastAction {
  label: string;
  run: () => void;
  icon?: IconName;
}

export interface ToastInput {
  message: string;
  /** Shorthand for a single action; equivalent to one entry in `actions`. */
  actionLabel?: string;
  action?: () => void;
  /** Several choices — "Copy YAML" / "Discard" on an unsaved view. */
  actions?: ToastAction[];
  /** Milliseconds on screen. Toasts with an action get longer by default. */
  duration?: number;
}

interface Toast extends ToastInput {
  id: number;
  leaving: boolean;
}

const MAX_TOASTS = 3;

@defineFp('fp3d-hud')
export class Fp3dHud extends FpBaseElement {
  static override styles = [
    FpBaseElement.styles,
    css`
      :host {
        display: block;
        pointer-events: none;
      }

      .stack {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 11px;
        border-radius: var(--fp3d-chrome-radius);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: var(--fp3d-label-tracking);
        text-transform: uppercase;
        color: var(--fp3d-text-dim);
      }

      .badge .fp-icon {
        width: 15px;
        height: 15px;
      }

      .stats {
        font-variant-numeric: tabular-nums;
      }

      .toasts {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .toast {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px 10px;
        max-width: min(360px, 76vw);
        padding: 8px 8px 8px 14px;
        border-radius: var(--fp3d-radius);
        font-size: 13px;
        color: var(--fp3d-text);
        animation: fp3d-toast-in var(--fp3d-normal) var(--fp3d-ease);
      }

      .toast.leaving {
        animation: fp3d-toast-out var(--fp3d-fast) var(--fp3d-ease) forwards;
      }

      .toast .msg {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .toast .undo {
        flex: none;
        min-height: 32px;
        padding: 0 10px;
        color: var(--fp3d-accent);
        font-weight: 600;
      }

      @keyframes fp3d-toast-in {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.98);
        }
      }

      @keyframes fp3d-toast-out {
        to {
          opacity: 0;
          transform: translateY(4px);
        }
      }
    `,
  ];

  @property({ type: Boolean }) showStats = false;
  @property({ type: String }) levelName: string | null = null;
  /** Pulled rather than pushed: the card would otherwise repaint every frame. */
  @property({ attribute: false }) getFps: (() => number) | null = null;

  @state() private fps = 0;
  @state() private toasts: Toast[] = [];

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncStatsTimer();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopStats();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    if (changed.has('showStats')) this.syncStatsTimer();
  }

  private syncStatsTimer(): void {
    this.stopStats();
    if (!this.showStats || !this.isConnected) return;
    // Twice a second: fast enough to be useful, slow enough to read.
    this.statsTimer = setInterval(() => {
      this.fps = Math.round(this.getFps?.() ?? 0);
    }, 500);
  }

  private stopStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  /** Show a transient message. Returns the id so a caller can dismiss it early. */
  toast(input: ToastInput): number {
    const id = this.nextId++;
    const toast: Toast = { ...input, id, leaving: false };
    const next = [...this.toasts, toast];
    this.toasts = next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;

    const duration = input.duration ?? (input.action || input.actions?.length ? 8000 : 3500);
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), duration),
    );
    return id;
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);

    if (this.reducedMotion) {
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
      return;
    }
    this.toasts = this.toasts.map((toast) =>
      toast.id === id ? { ...toast, leaving: true } : toast,
    );
    setTimeout(() => {
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
    }, 160);
  }

  /** Legacy single action folded in, so callers can use either shape. */
  private actionsOf(toast: Toast): ToastAction[] {
    const actions = [...(toast.actions ?? [])];
    if (toast.action && toast.actionLabel) {
      actions.unshift({ label: toast.actionLabel, run: toast.action, icon: 'undo' });
    }
    return actions;
  }

  private runAction(toast: Toast, action: ToastAction): void {
    this.dismiss(toast.id);
    try {
      action.run();
    } catch (err) {
      console.error('[floorplan-3d] toast action threw', err);
    }
  }

  protected override render(): TemplateResult | typeof nothing {
    const showBadge = Boolean(this.levelName) || this.showStats;
    if (!showBadge && this.toasts.length === 0) return nothing;

    return html`
      <div class="stack">
        <div class="toasts" role="status" aria-live="polite">
          ${repeat(
            this.toasts,
            (toast) => toast.id,
            (toast) => html`
              <div class="toast surface ${toast.leaving ? 'leaving' : ''}">
                <span class="msg">${toast.message}</span>
                ${this.actionsOf(toast).map(
                  (action) => html`
                    <button class="undo text-btn" @click=${() => this.runAction(toast, action)}>
                      ${action.icon ? icon(action.icon) : nothing}${action.label}
                    </button>
                  `,
                )}
              </div>
            `,
          )}
        </div>
        ${showBadge
          ? html`<div class="badge surface">
              ${this.levelName
                ? html`${icon('layers')}<span>${this.levelName}</span>`
                : nothing}
              ${this.showStats
                ? html`<span class="stats">${this.fps} ${this.t('ui.hud.fps', 'fps')}</span>`
                : nothing}
            </div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-hud': Fp3dHud;
  }
}
