/**
 * The storey picker, styled after a lift panel: top floor at the top, one
 * button per level, a lit indicator on the active one.
 *
 * Matching physical reality matters more here than it sounds. A list sorted by
 * array order puts the basement above the attic half the time, and users then
 * have to read every label instead of just reaching for the top button.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon } from '@/ui/icons';
import type { LevelDefinition } from '@/types/config';

@defineFp('fp3d-level-selector')
export class Fp3dLevelSelector extends FpBaseElement {
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
        gap: 2px;
        padding: 4px;
        border-radius: 14px;
        max-height: 100%;
      }

      .level {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 0 10px 0 8px;
        border-radius: 10px;
        color: var(--fp3d-text);
        font-size: 13px;
        font-weight: 500;
        white-space: nowrap;
        transition:
          background-color var(--fp3d-fast) var(--fp3d-ease),
          color var(--fp3d-fast) var(--fp3d-ease);
      }

      .level::after {
        content: '';
        position: absolute;
        inset: 50% auto auto 0;
        width: 100%;
        height: var(--fp3d-touch);
        transform: translateY(-50%);
      }

      .level:hover {
        background: var(--fp3d-hover);
      }

      .level[aria-pressed='true'] {
        background: var(--fp3d-accent-soft);
        color: var(--fp3d-accent);
      }

      /* The "car is here" lamp. Solid when isolated, hollow otherwise. */
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

      .level[aria-pressed='true'] .lamp {
        opacity: 1;
        background: currentColor;
        box-shadow: 0 0 0 3px var(--fp3d-accent-soft);
      }

      .name {
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 130px;
      }

      .stack.compact .name {
        display: none;
      }

      .foot {
        display: flex;
        align-items: center;
        justify-content: center;
        margin-top: 2px;
        padding-top: 4px;
        border-top: 1px solid var(--fp3d-divider);
      }

      .ghost-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: 36px;
        border-radius: 8px;
        color: var(--fp3d-text-dim);
        transition:
          background-color var(--fp3d-fast) var(--fp3d-ease),
          color var(--fp3d-fast) var(--fp3d-ease);
      }

      .ghost-btn:hover {
        background: var(--fp3d-hover);
      }

      .ghost-btn[aria-pressed='true'] {
        color: var(--fp3d-accent);
      }
    `,
  ];

  @property({ attribute: false }) levels: LevelDefinition[] = [];
  @property({ type: String }) activeLevelId: string | null = null;
  @property({ type: Boolean }) ghostAbove = false;

  /** Top storey first — a lift panel, not an array dump. */
  private ordered(): LevelDefinition[] {
    return [...this.levels].sort((a, b) => (b.elevation ?? 0) - (a.elevation ?? 0));
  }

  private select(level: LevelDefinition): void {
    const next = this.activeLevelId === level.id ? null : level.id;
    this.emit('fp3d-level-select', { levelId: next });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('.level')];
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  }

  protected override render(): TemplateResult | typeof nothing {
    const levels = this.ordered();
    if (levels.length === 0) return nothing;

    return html`
      <div
        class="stack surface ${this.size === 'narrow' ? 'compact' : ''}"
        role="group"
        aria-label=${this.t('ui.toolbar.levels', 'Levels')}
        @keydown=${this.onKeyDown}
      >
        ${levels.map((level) => {
          const active = this.activeLevelId === level.id;
          return html`
            <button
              class="level"
              aria-pressed=${active ? 'true' : 'false'}
              aria-label=${level.name}
              title=${level.name}
              @click=${() => this.select(level)}
            >
              <span class="lamp" aria-hidden="true"></span>
              <span class="name">${level.name}</span>
            </button>
          `;
        })}
        <div class="foot">
          <button
            class="ghost-btn"
            aria-pressed=${this.ghostAbove ? 'true' : 'false'}
            aria-label=${this.t('ui.section.ghost_above', 'Ghost levels above')}
            title=${this.t('ui.section.ghost_above', 'Ghost levels above')}
            @click=${() => this.emit('fp3d-ghost-above', { enabled: !this.ghostAbove })}
          >
            ${icon(this.ghostAbove ? 'eye' : 'eyeOff')}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-level-selector': Fp3dLevelSelector;
  }
}
