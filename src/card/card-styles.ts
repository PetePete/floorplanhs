/**
 * Every style in the card, as Lit `css` templates.
 *
 * Two rules run through all of it:
 *
 *  1. **Theme first.** Colours come from Home Assistant's CSS custom properties
 *     with a literal fallback on every single one, so the card inherits a
 *     user's theme instead of fighting it — and still looks right in a bare
 *     page (the dev harness) where none of them are defined.
 *  2. **The canvas owns the pointer.** Chrome containers are
 *     `pointer-events: none`; only the control surfaces themselves opt back in.
 *     Anything else steals orbit drags from the 3D view.
 */

import { css } from 'lit';

/* --------------------------------------------------------------- tokens */

/**
 * `color-mix` is what makes the glass panels follow the theme instead of
 * shipping two hardcoded greys, but it is Chrome 111+/Safari 16.2+ and the HA
 * companion app still ships older Android WebViews. The plain rgba values are
 * the real baseline; the `@supports` block is the upgrade.
 */
export const themeTokens = css`
  :host {
    /* Native controls — a select's popup, a scrollbar, a date picker — are
       painted by the browser, not by us. This is the only thing that tells it
       which way round we are. */
    color-scheme: light;
    /* A select's popup is painted by the browser in its own window, so it
       cannot use a translucent surface — it has nothing to be translucent
       over. Opaque, and separate from the panel tokens for that reason. */
    --fp3d-popup-bg: #ffffff;
    --fp3d-popup-text: #212121;
    --fp3d-accent: var(--primary-color, #03a9f4);
    --fp3d-accent-text: var(--text-primary-color, #fff);
    --fp3d-text: var(--primary-text-color, #212121);
    --fp3d-text-dim: var(--secondary-text-color, #727272);
    --fp3d-card-bg: var(--card-background-color, var(--ha-card-background, #fff));
    --fp3d-divider: var(--divider-color, rgba(0, 0, 0, 0.12));
    --fp3d-error: var(--error-color, #db4437);
    --fp3d-warning: var(--warning-color, #ffa600);
    --fp3d-success: var(--success-color, #43a047);
    --fp3d-active: var(--state-icon-active-color, #fdd835);

    /*
     * The chrome uses its own typeface rather than the dashboard's. A control
     * surface floating over a 3D model reads as an instrument panel, and the
     * squared-off technical letterforms are what say so — the same reason CAD
     * and avionics UIs do not use the system UI font. --fp3d-font is the
     * escape hatch: set it in a theme and the card follows.
     */
    --fp3d-font: 'Chakra Petch', var(--paper-font-body1_-_font-family, system-ui),
      -apple-system, 'Segoe UI', Roboto, sans-serif;
    /* Slightly open, because squared letterforms tighten up at small sizes. */
    --fp3d-tracking: 0.015em;

    --fp3d-radius: var(--ha-card-border-radius, 12px);
    --fp3d-radius-sm: 8px;
    /*
     * The chrome is an instrument panel over a technical drawing, so it is cut
     * square and framed rather than rounded: pills read as phone UI and fight
     * the line work behind them. Everything that floats over the canvas uses
     * this radius; the card's own frame keeps the dashboard's.
     */
    --fp3d-chrome-radius: 3px;
    /** Spaced capitals for machine labels — never for text the user typed. */
    --fp3d-label-tracking: 0.14em;
    --fp3d-touch: 44px;
    --fp3d-gap: 8px;
    --fp3d-chrome-inset: 16px;

    --fp3d-surface: rgba(252, 252, 253, 0.74);
    --fp3d-surface-strong: rgba(252, 252, 253, 0.92);
    --fp3d-hairline: rgba(255, 255, 255, 0.5);
    --fp3d-ring: rgba(0, 0, 0, 0.1);
    --fp3d-shadow: 0 6px 22px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.1);
    --fp3d-hover: rgba(0, 0, 0, 0.06);
    --fp3d-press: rgba(0, 0, 0, 0.11);
    --fp3d-accent-soft: rgba(3, 169, 244, 0.16);

    --fp3d-ease: cubic-bezier(0.2, 0, 0, 1);
    --fp3d-fast: 150ms;
    --fp3d-normal: 200ms;
    --fp3d-slow: 250ms;
  }

  :host([dark]) {
    color-scheme: dark;
    --fp3d-popup-bg: #202124;
    --fp3d-popup-text: #e8eaed;
    --fp3d-surface: rgba(32, 33, 36, 0.7);
    --fp3d-surface-strong: rgba(32, 33, 36, 0.92);
    --fp3d-hairline: rgba(255, 255, 255, 0.12);
    --fp3d-ring: rgba(0, 0, 0, 0.4);
    --fp3d-shadow: 0 8px 26px rgba(0, 0, 0, 0.44), 0 1px 3px rgba(0, 0, 0, 0.3);
    --fp3d-hover: rgba(255, 255, 255, 0.09);
    --fp3d-press: rgba(255, 255, 255, 0.16);
    --fp3d-accent-soft: rgba(3, 169, 244, 0.24);
  }

  @supports (background: color-mix(in srgb, red 50%, blue)) {
    :host {
      --fp3d-surface: color-mix(in srgb, var(--fp3d-card-bg) 76%, transparent);
      --fp3d-surface-strong: color-mix(in srgb, var(--fp3d-card-bg) 94%, transparent);
      --fp3d-hover: color-mix(in srgb, var(--fp3d-text) 8%, transparent);
      --fp3d-press: color-mix(in srgb, var(--fp3d-text) 15%, transparent);
      --fp3d-accent-soft: color-mix(in srgb, var(--fp3d-accent) 18%, transparent);
    }
    :host([dark]) {
      --fp3d-surface: color-mix(in srgb, var(--fp3d-card-bg) 68%, transparent);
      --fp3d-accent-soft: color-mix(in srgb, var(--fp3d-accent) 26%, transparent);
    }
  }
`;

/* -------------------------------------------------------------- surfaces */

export const surfaceStyles = css`
  .surface {
    pointer-events: auto;
    background: var(--fp3d-surface);
    color: var(--fp3d-text);
    border: 1px solid var(--fp3d-hairline);
    border-radius: var(--fp3d-chrome-radius);
    box-shadow: var(--fp3d-shadow);
    /* Saturation lifts the panel off a washed-out daytime render; the blur
       alone is not enough to stay legible over bright glass and sky. */
    -webkit-backdrop-filter: blur(14px) saturate(180%);
    backdrop-filter: blur(14px) saturate(180%);
    box-sizing: border-box;
  }

  /* Non-transparent variant for the sheets that carry dense text. */
  .surface.solid {
    background: var(--fp3d-surface-strong);
  }

  .sheet-title {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px 10px 14px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--fp3d-text);
    border-bottom: 1px solid var(--fp3d-divider);
  }

  .sheet-title .spacer {
    flex: 1;
  }

  .section-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: var(--fp3d-label-tracking);
    text-transform: uppercase;
    color: var(--fp3d-text-dim);
    margin: 14px 0 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* The rule that runs on from a heading, as on a drawing sheet. */
  .section-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--fp3d-divider);
  }

  .hint {
    font-size: 12px;
    line-height: 1.45;
    color: var(--fp3d-text-dim);
  }
`;

/* --------------------------------------------------------------- buttons */

export const buttonStyles = css`
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    margin: 0;
    padding: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  button:disabled {
    opacity: 0.38;
    cursor: default;
  }

  .fp-icon {
    width: 22px;
    height: 22px;
    display: block;
    flex: none;
    fill: currentColor;
  }

  /* Visual size stays 40px; the 44px touch target is added outside the box so
     it never changes the layout rhythm. */
  .icon-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--fp3d-chrome-radius);
    color: var(--fp3d-text);
    transition:
      background-color var(--fp3d-fast) var(--fp3d-ease),
      color var(--fp3d-fast) var(--fp3d-ease),
      transform var(--fp3d-fast) var(--fp3d-ease);
  }

  .icon-btn::after {
    content: '';
    position: absolute;
    inset: 50% auto auto 50%;
    width: var(--fp3d-touch);
    height: var(--fp3d-touch);
    transform: translate(-50%, -50%);
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--fp3d-hover);
  }

  .icon-btn:active:not(:disabled) {
    background: var(--fp3d-press);
    transform: scale(0.94);
  }

  /*
   * An engaged control is *latched*: framed in the accent and lit from behind,
   * rather than merely tinted. On a panel of identical glyphs the frame is what
   * carries across the room; the tint alone does not.
   */
  .icon-btn[aria-pressed='true'],
  .icon-btn.active {
    background: var(--fp3d-accent-soft);
    color: var(--fp3d-accent);
    box-shadow:
      inset 0 0 0 1px var(--fp3d-accent),
      0 0 10px -2px var(--fp3d-accent);
  }

  .text-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 14px;
    border-radius: var(--fp3d-chrome-radius);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: var(--fp3d-label-tracking);
    text-transform: uppercase;
    color: var(--fp3d-text);
    transition:
      background-color var(--fp3d-fast) var(--fp3d-ease),
      color var(--fp3d-fast) var(--fp3d-ease);
  }

  .text-btn:hover:not(:disabled) {
    background: var(--fp3d-hover);
  }

  .text-btn.primary {
    background: var(--fp3d-accent);
    color: var(--fp3d-accent-text);
  }

  .text-btn.primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .text-btn.danger {
    color: var(--fp3d-error);
  }

  .text-btn .fp-icon {
    width: 18px;
    height: 18px;
  }
`;

/* -------------------------------------------------------------- controls */

export const controlStyles = css`
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px;
    border-radius: var(--fp3d-chrome-radius);
    border: 1px solid var(--fp3d-divider);
    background: transparent;
    color: var(--fp3d-text);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: var(--fp3d-label-tracking);
    text-transform: uppercase;
    white-space: nowrap;
    transition:
      background-color var(--fp3d-fast) var(--fp3d-ease),
      border-color var(--fp3d-fast) var(--fp3d-ease),
      color var(--fp3d-fast) var(--fp3d-ease);
  }

  .chip:hover:not(:disabled) {
    background: var(--fp3d-hover);
  }

  .chip[aria-pressed='true'],
  .chip.active {
    background: var(--fp3d-accent-soft);
    border-color: var(--fp3d-accent);
    color: var(--fp3d-accent);
    box-shadow: 0 0 10px -2px var(--fp3d-accent);
  }

  .chip .fp-icon {
    width: 16px;
    height: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }

  .field > label,
  .field-label {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--fp3d-text-dim);
  }

  input[type='text'],
  input[type='number'],
  select {
    font: inherit;
    font-size: 13px;
    box-sizing: border-box;
    width: 100%;
    min-height: 36px;
    padding: 6px 10px;
    color: var(--fp3d-text);
    background: var(--fp3d-hover);
    border: 1px solid transparent;
    border-radius: var(--fp3d-radius-sm);
    transition: border-color var(--fp3d-fast) var(--fp3d-ease);
  }

  /*
   * Chrome on Windows paints a select's dropdown with the page's colour scheme
   * and not the element's, so color-scheme: dark on the panel is not enough:
   * the list came up white while its text kept the dark theme's pale grey, and
   * the options were unreadable. Stating both colours is what actually lands.
   */
  option {
    background-color: var(--fp3d-popup-bg);
    color: var(--fp3d-popup-text);
  }

  option:checked {
    background-color: var(--fp3d-accent);
    color: var(--fp3d-accent-text);
  }

  input[type='text']:focus,
  input[type='number']:focus,
  select:focus {
    outline: none;
    border-color: var(--fp3d-accent);
  }

  input[type='color'] {
    width: 40px;
    height: 32px;
    padding: 2px;
    border: 1px solid var(--fp3d-divider);
    border-radius: var(--fp3d-radius-sm);
    background: transparent;
    cursor: pointer;
  }

  /* A finger needs a fat track: 24px of hit area around a 4px visual rail. */
  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 24px;
    margin: 0;
    background: transparent;
    cursor: pointer;
    touch-action: pan-y;
  }

  input[type='range']::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: var(--fp3d-press);
  }

  input[type='range']::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: var(--fp3d-press);
  }

  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    margin-top: -6px;
    border-radius: 50%;
    background: var(--fp3d-accent);
    border: 2px solid var(--fp3d-card-bg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform var(--fp3d-fast) var(--fp3d-ease);
  }

  input[type='range']::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--fp3d-accent);
    border: 2px solid var(--fp3d-card-bg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }

  input[type='range']:active::-webkit-slider-thumb {
    transform: scale(1.25);
  }

  .switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 36px;
    width: 100%;
    font-size: 13px;
    color: var(--fp3d-text);
    text-align: left;
  }

  .switch .track {
    position: relative;
    flex: none;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: var(--fp3d-press);
    transition: background-color var(--fp3d-normal) var(--fp3d-ease);
  }

  .switch .track::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--fp3d-card-bg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: transform var(--fp3d-normal) var(--fp3d-ease);
  }

  .switch[aria-checked='true'] .track {
    background: var(--fp3d-accent);
  }

  .switch[aria-checked='true'] .track::after {
    transform: translateX(16px);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .scroll-x,
  .scroll-y {
    scrollbar-width: thin;
    scrollbar-color: var(--fp3d-press) transparent;
  }

  .scroll-x {
    overflow-x: auto;
    overflow-y: hidden;
    scroll-behavior: smooth;
  }

  .scroll-y {
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }

  .scroll-x::-webkit-scrollbar,
  .scroll-y::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  .scroll-x::-webkit-scrollbar-thumb,
  .scroll-y::-webkit-scrollbar-thumb {
    background: var(--fp3d-press);
    border-radius: 3px;
  }

  .scroll-x::-webkit-scrollbar-track,
  .scroll-y::-webkit-scrollbar-track {
    background: transparent;
  }
`;

/* ------------------------------------------------------- a11y and motion */

export const a11yStyles = css`
  :host {
    -webkit-font-smoothing: antialiased;
    font-family: var(--fp3d-font);
    letter-spacing: var(--fp3d-tracking);
  }

  /* font: inherit on controls resets to the UA font, not the host's. */
  button,
  select,
  input,
  textarea {
    font-family: var(--fp3d-font);
    letter-spacing: var(--fp3d-tracking);
  }

  *:focus {
    outline: none;
  }

  *:focus-visible {
    outline: 2px solid var(--fp3d-accent);
    outline-offset: 2px;
    border-radius: var(--fp3d-radius-sm);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition-duration: 1ms !important;
      animation-duration: 1ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
    }
  }
`;

/** Everything a chrome component needs. Applied by `FpBaseElement`. */
export const uiBaseStyles = [
  themeTokens,
  surfaceStyles,
  buttonStyles,
  controlStyles,
  a11yStyles,
];

/* ------------------------------------------------------------- the card */

export const cardStyles = css`
  :host {
    font-family: var(--fp3d-font);
    letter-spacing: var(--fp3d-tracking);

    display: block;
    position: relative;
    container-type: inline-size;
    container-name: fp3d-card;
  }

  /*
   * The starting point, and all an embed needs. On a dashboard the card
   * measures the view box and writes a pixel height over this one, because
   * height: 100% is a question the boxes Home Assistant wraps a card in do not
   * answer — and the content it would fall back to is a canvas, which has no
   * size of its own.
   */
  :host([full]) {
    height: 100%;
    /* Both, because a wrapper may size us as a block or stretch us as a flex or
       grid item, and which one it is depends on the dashboard's layout. */
    align-self: stretch;
    flex: 1 1 auto;
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: var(--fp3d-card-height, 520px);
    background: var(--fp3d-card-bg);
    border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0, 0, 0, 0.14));
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, transparent);
    color: var(--fp3d-text);
    box-sizing: border-box;
  }

  :host([full]) .card {
    height: 100%;
    border-radius: 0;
    box-shadow: none;
    border: none;
  }

  :host([aspect]) .card {
    height: auto;
    aspect-ratio: var(--fp3d-aspect, 16 / 9);
  }

  .viewport {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    isolation: isolate;
  }

  .canvas-host {
    position: absolute;
    inset: 0;
    /* The engine's pointer router binds here; nothing above may be opaque to
       pointer events or orbiting dies. */
    touch-action: none;
  }

  /* A soft top/bottom vignette keeps white chrome readable over a bright sky
     without dimming the middle of the render. */
  .vignette {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
    background:
      linear-gradient(to bottom, rgba(0, 0, 0, 0.16), rgba(0, 0, 0, 0) 18%),
      linear-gradient(to top, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0) 22%);
    opacity: 0.65;
    transition: opacity var(--fp3d-slow) var(--fp3d-ease);
  }

  .chrome {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-rows: auto 1fr auto;
    grid-template-areas:
      'topleft  top     topright'
      'left     center  right'
      'bottom   bottom  bottom';
    gap: var(--fp3d-gap);
    /*
     * Breathing room between the controls and the card edge. This has to stay
     * equal to the ViewCube's own canvas margin (view-cube.ts DEFAULTS.margin.x)
     * or the zoom control below the cube stops lining up with it — the cube is
     * painted on the canvas and knows nothing about this box.
     */
    padding: var(--fp3d-chrome-inset);
  }

  .chrome > * {
    pointer-events: none;
    min-width: 0;
    min-height: 0;
  }

  .at-topleft {
    grid-area: topleft;
    justify-self: start;
    align-self: start;
  }
  /*
   * Spans both upper rows on purpose. An auto row grows to its tallest cell,
   * and this cluster is tall — toolbar, the strip reserved for the orientation
   * cube, then the zoom gauge. Left in row one it made that row some 370 px
   * high and squeezed everything in the middle row, which is where the side
   * panels live. Spanning lets the flexible row absorb the height instead.
   */
  .at-topright {
    grid-area: topright;
    grid-row: 1 / 3;
    justify-self: end;
    align-self: start;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }

  /*
   * The orientation cube is drawn by the engine straight onto the canvas, so
   * the chrome cannot lay itself out around it — this reserves the strip the
   * cube occupies so the zoom control lands underneath rather than behind it.
   */
  .cube-gap {
    height: var(--fp3d-cube-gap, 136px);
    flex: none;
    pointer-events: none;
  }

  /*
   * Centres the zoom control on the cube's axis rather than on the right edge:
   * a box exactly the cube's width, right-aligned inside the same inset the
   * cube uses, puts its centre on the cube's centre. The width mirrors
   * view-cube.ts DEFAULTS (size 96 / compactSize 72); the cube is drawn on the
   * canvas and has no DOM box to align against.
   */
  .cube-column {
    width: var(--fp3d-cube-size, 96px);
    display: flex;
    justify-content: center;
    flex: none;
  }

  :host([data-layout='narrow']) .cube-gap {
    --fp3d-cube-gap: 112px;
  }

  /*
   * No toolbar (a panel view) means the cube moves up to the top inset — see
   * placeViewCube in the card — so the strip it occupies starts higher and is
   * that much shorter. The two numbers have to move together or the cube lands
   * on the zoom control.
   */
  .chrome.no-toolbar .cube-gap {
    --fp3d-cube-gap: 114px;
  }
  :host([data-layout='narrow']) .chrome.no-toolbar .cube-gap {
    --fp3d-cube-gap: 90px;
  }
  :host([data-layout='narrow']) .cube-column {
    --fp3d-cube-size: 72px;
  }
  /*
   * A sheet is a panel, not a tooltip: it runs the height of the viewport with
   * the chrome's own inset as its margin, rather than floating half way down
   * the side. A zero min-height is what lets the list inside it scroll instead of
   * pushing the sheet past the bottom edge.
   */
  .at-left {
    grid-area: left;
    /* From the top inset down to the bottom row: a panel you pick from wants
       every pixel the card can spare. */
    grid-row: 1 / 3;
    justify-self: start;
    align-self: stretch;
    display: flex;
    align-items: stretch;
    gap: var(--fp3d-gap);
    max-height: 100%;
    min-height: 0;
  }

  /*
   * The palette opens *beside* the navigator rather than over it: picking an
   * entity and picking the storey to drop it on are two halves of one job, and
   * a panel that covers the other one turns that into a memory game.
   */
  .at-left > .sheet {
    min-height: 0;
    max-height: 100%;
  }
  .at-right {
    grid-area: right;
    justify-self: end;
    align-self: stretch;
    display: flex;
    align-items: center;
    max-height: 100%;
  }
  .at-bottom {
    grid-area: bottom;
    justify-self: stretch;
    align-self: end;
    min-width: 0;
  }
  /* A card with a title keeps the corner for it, and the rail starts below. */
  .chrome.has-title .at-left {
    grid-row: 2;
  }

  .at-hud {
    grid-area: left;
    justify-self: start;
    align-self: end;
  }

  .title-chip {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    max-width: 46vw;
    padding: 7px 14px;
    border-radius: var(--fp3d-chrome-radius);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: var(--fp3d-label-tracking);
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: var(--fp3d-surface);
    border: 1px solid var(--fp3d-hairline);
    box-shadow: var(--fp3d-shadow);
    -webkit-backdrop-filter: blur(14px) saturate(180%);
    backdrop-filter: blur(14px) saturate(180%);
  }

  /* Sheets: side panels on a roomy card, bottom sheets on a phone-sized one. */
  .sheet {
    display: flex;
    /* Explicit, not left to flex stretch: everything inside sizes itself in
       percentages, and a percentage against an indefinite height is how a list
       ends up pushing the panel past the bottom of the card. */
    height: 100%;
    max-height: 100%;
    min-height: 0;
    animation: fp3d-slide-right var(--fp3d-normal) var(--fp3d-ease);
  }

  /* Sheets become bottom sheets, but they stack *above* the preset bar rather
     than replacing it — the bar is the card's primary navigation. */
  :host([data-layout='narrow']) .at-right,
  :host([data-layout='narrow']) .at-left {
    grid-area: center;
    justify-self: stretch;
    align-self: end;
    max-height: 100%;
  }

  :host([data-layout='narrow']) .sheet {
    width: 100%;
    animation: fp3d-slide-up var(--fp3d-normal) var(--fp3d-ease);
  }

  /* The HUD badge is the only thing that gives way on a phone-sized card. The
     preset bar never does; it just scrolls. */
  :host([data-layout='narrow']) .at-hud {
    display: none;
  }

  .overlay {
    position: absolute;
    inset: 0;
    z-index: 3;
  }

  @keyframes fp3d-slide-right {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
  }

  @keyframes fp3d-slide-up {
    from {
      opacity: 0;
      transform: translateY(16px);
    }
  }

  /* Container queries do the cosmetic tightening; the ResizeObserver-driven
     data-layout attribute does the structural work, because which controls
     collapse into an overflow menu is a decision only JS can make. */
  @container fp3d-card (max-width: 520px) {
    .chrome {
      gap: 6px;
      padding: 6px;
    }
    .title-chip {
      font-size: 12px;
      padding: 5px 11px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }
`;
