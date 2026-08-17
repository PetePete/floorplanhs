/**
 * The primary control cluster, floating top-right over the render.
 *
 * The interesting problem here is collapse. A Lovelace card can be 1200 px wide
 * on a desktop or 340 px in a phone column, and hiding controls with CSS would
 * leave them focusable but invisible. So the split is decided in JS: `size`
 * (fed by the card's ResizeObserver) picks how many actions stay inline and the
 * rest move into a real menu.
 */

import { css, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { defineFp, FpBaseElement } from '@/ui/base-element';
import { icon, type IconName } from '@/ui/icons';

export type ToolbarAction =
  | 'reset'
  | 'fit'
  | 'projection'
  | 'section'
  | 'autorotate'
  | 'tour'
  | 'fullscreen'
  | 'edit'
  | 'palette';

interface ToolbarItem {
  action: ToolbarAction;
  glyph: IconName;
  label: string;
  pressed?: boolean;
  hidden?: boolean;
  /** Lower numbers survive longer as the card narrows. */
  rank: number;
}

@defineFp('fp3d-toolbar')
export class Fp3dToolbar extends FpBaseElement {
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
        gap: 2px;
        padding: 3px;
        border-radius: 999px;
      }

      .divider {
        width: 1px;
        height: 22px;
        margin: 0 3px;
        background: var(--fp3d-divider);
        flex: none;
      }

      .menu-wrap {
        position: relative;
        display: flex;
      }

      .menu {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        z-index: 5;
        min-width: 196px;
        padding: 6px;
        border-radius: var(--fp3d-radius);
        display: flex;
        flex-direction: column;
        gap: 2px;
        transform-origin: top right;
        animation: fp3d-menu-in var(--fp3d-fast) var(--fp3d-ease);
      }

      .menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: var(--fp3d-touch);
        padding: 0 12px;
        border-radius: var(--fp3d-radius-sm);
        font-size: 13.5px;
        text-align: left;
        color: var(--fp3d-text);
        box-sizing: border-box;
        transition: background-color var(--fp3d-fast) var(--fp3d-ease);
      }

      .menu-item:hover {
        background: var(--fp3d-hover);
      }

      .menu-item[aria-pressed='true'] {
        color: var(--fp3d-accent);
      }

      .menu-item .fp-icon {
        width: 20px;
        height: 20px;
      }

      .menu-item .check {
        margin-left: auto;
        width: 16px;
        height: 16px;
        opacity: 0;
      }

      .menu-item[aria-pressed='true'] .check {
        opacity: 1;
      }

      /* Tooltip: a title attribute never appears on touch and cannot be themed. */
      .tip {
        position: absolute;
        top: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%) translateY(-3px);
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 11.5px;
        font-weight: 500;
        white-space: nowrap;
        color: var(--fp3d-accent-text);
        background: rgba(30, 30, 32, 0.92);
        opacity: 0;
        pointer-events: none;
        transition:
          opacity var(--fp3d-fast) var(--fp3d-ease),
          transform var(--fp3d-fast) var(--fp3d-ease);
        z-index: 6;
      }

      .btn-wrap {
        position: relative;
        display: flex;
      }

      .btn-wrap:hover .tip,
      .btn-wrap:focus-within .tip {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      @media (hover: none) {
        .tip {
          display: none;
        }
      }

      @keyframes fp3d-menu-in {
        from {
          opacity: 0;
          transform: scale(0.94) translateY(-4px);
        }
      }
    `,
  ];

  @property({ type: String }) openPanel: 'none' | 'section' | 'palette' = 'none';
  @property({ type: Boolean }) orthographic = false;
  @property({ type: Boolean }) autoRotate = false;
  @property({ type: Boolean }) fullscreen = false;
  @property({ type: Boolean }) editing = false;
  @property({ type: Boolean }) canEdit = false;
  /** False hides the section button entirely, so it cannot open a hidden panel. */
  @property({ type: Boolean }) canSection = true;
  @property({ type: Boolean }) sectionActive = false;
  /** False when there is nothing to tour, or the tour controls are switched off. */
  @property({ type: Boolean }) canTour = false;
  @property({ type: Boolean }) tourPlaying = false;

  @state() private menuOpen = false;

  override connectedCallback(): void {
    super.connectedCallback();
    // Any pointer outside the toolbar dismisses the menu, including on the
    // canvas — where the pointer router will happily start orbiting.
    const close = (event: Event) => {
      if (!this.menuOpen) return;
      if (event.composedPath().includes(this)) return;
      this.menuOpen = false;
    };
    document.addEventListener('pointerdown', close, true);
    this.onCleanup(() => document.removeEventListener('pointerdown', close, true));
  }

  private items(): ToolbarItem[] {
    const all: ToolbarItem[] = [
      {
        action: 'reset',
        glyph: 'resetView',
        label: this.t('ui.toolbar.reset_view', 'Reset view'),
        rank: 0,
      },
      // Saved views live in the bottom bar and nowhere else — a toolbar
      // button that opens a list of them is the hierarchy the bar replaces.
      {
        action: 'fit',
        glyph: 'fitToScreen',
        label: this.t('ui.toolbar.fit_view', 'Fit to screen'),
        rank: 1,
      },
      {
        action: 'section',
        glyph: 'section',
        label: this.t('ui.toolbar.section', 'Section'),
        pressed: this.openPanel === 'section' || this.sectionActive,
        hidden: !this.canSection,
        rank: 3,
      },
      {
        action: 'projection',
        glyph: this.orthographic ? 'orthographic' : 'perspective',
        // Says where the button goes, not where you are. The old wording read
        // as a status line and made an isometric view look like a perspective
        // one. `pressed` is deliberately false: it is a switch, not a state.
        label: this.orthographic
          ? this.t('ui.toolbar.to_perspective', 'Switch to perspective')
          : this.t('ui.toolbar.to_isometric', 'Switch to isometric'),
        pressed: false,
        rank: 4,
      },
      {
        action: 'tour',
        glyph: this.tourPlaying ? 'pause' : 'play',
        label: this.tourPlaying
          ? this.t('ui.toolbar.tour_pause', 'Pause tour')
          : this.t('ui.toolbar.tour_play', 'Play tour'),
        pressed: this.tourPlaying,
        hidden: !this.canTour || this.reducedMotion,
        rank: 2,
      },
      {
        action: 'autorotate',
        glyph: 'autorotate',
        label: this.t('ui.toolbar.auto_rotate', 'Auto rotate'),
        pressed: this.autoRotate,
        // Auto-rotate is exactly the kind of motion this setting is about.
        hidden: this.reducedMotion,
        rank: 6,
      },
      {
        action: 'fullscreen',
        glyph: this.fullscreen ? 'fullscreenExit' : 'fullscreen',
        label: this.fullscreen
          ? this.t('ui.toolbar.exit_fullscreen', 'Exit fullscreen')
          : this.t('ui.toolbar.fullscreen', 'Fullscreen'),
        pressed: this.fullscreen,
        hidden: typeof document === 'undefined' || !document.fullscreenEnabled,
        rank: 7,
      },
      {
        action: 'edit',
        glyph: 'pencil',
        label: this.editing
          ? this.t('ui.toolbar.done', 'Done')
          : this.t('ui.toolbar.edit', 'Edit layout'),
        pressed: this.editing,
        hidden: !this.canEdit,
        rank: 5,
      },
    ];
    return all.filter((item) => !item.hidden);
  }

  /** How many actions stay inline before the overflow menu takes over. */
  private inlineBudget(): number {
    if (this.size === 'narrow') return 2;
    if (this.size === 'medium') return 4;
    return 99;
  }

  private fire(action: ToolbarAction): void {
    this.menuOpen = false;
    this.emit('fp3d-toolbar-action', { action });
  }

  private onMenuKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.menuOpen = false;
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>('.menu-item')];
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = buttons[(current + step + buttons.length) % buttons.length];
    next?.focus();
  }

  private renderButton(item: ToolbarItem): TemplateResult {
    return html`<div class="btn-wrap">
      <button
        class=${classMap({ 'icon-btn': true })}
        aria-label=${item.label}
        aria-pressed=${item.pressed ? 'true' : 'false'}
        @click=${() => this.fire(item.action)}
      >
        ${icon(item.glyph)}
      </button>
      <span class="tip" role="presentation">${item.label}</span>
    </div>`;
  }

  protected override render(): TemplateResult {
    const items = this.items();
    const budget = this.inlineBudget();
    const ordered = [...items].sort((a, b) => a.rank - b.rank);
    const inline = ordered.slice(0, budget);
    const overflow = ordered.slice(budget);

    return html`
      <div class="bar surface" role="toolbar" aria-label=${this.t('ui.toolbar.title', 'View controls')}>
        ${inline.map((item) => this.renderButton(item))}
        ${overflow.length
          ? html`
              <span class="divider" role="separator"></span>
              <div class="menu-wrap">
                <button
                  class="icon-btn"
                  aria-label=${this.t('ui.toolbar.more', 'More controls')}
                  aria-haspopup="menu"
                  aria-expanded=${this.menuOpen ? 'true' : 'false'}
                  @click=${() => {
                    this.menuOpen = !this.menuOpen;
                  }}
                >
                  ${icon('overflow')}
                </button>
                ${this.menuOpen
                  ? html`<div
                      class="menu surface solid"
                      role="menu"
                      @keydown=${this.onMenuKeyDown}
                    >
                      ${overflow.map(
                        (item) => html`
                          <button
                            class="menu-item"
                            role="menuitemcheckbox"
                            aria-pressed=${item.pressed ? 'true' : 'false'}
                            aria-checked=${item.pressed ? 'true' : 'false'}
                            @click=${() => this.fire(item.action)}
                          >
                            ${icon(item.glyph)}
                            <span>${item.label}</span>
                            <span class="check">${icon('check')}</span>
                          </button>
                        `,
                      )}
                    </div>`
                  : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fp3d-toolbar': Fp3dToolbar;
  }
}
