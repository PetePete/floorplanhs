/**
 * `<floorplan-3d-card>` — the Lovelace shell around the 3D engine.
 *
 * The card owns four things and delegates everything else:
 *
 *  1. **Lifecycle.** Creating, mounting, and disposing the `Viewer`, including
 *     surviving Home Assistant moving the element around the DOM.
 *  2. **Config persistence.** `EditIntent` in, immutable new config out,
 *     `config-changed` fired, and the applied config kept locally so the UI
 *     never flickers while Lovelace round-trips the YAML.
 *  3. **Chrome layout.** Which panels exist, where they sit, how they collapse.
 *  4. **Failure.** No blank cards: WebGL, model and config failures all land on
 *     a real panel.
 *
 * What it deliberately does *not* do is re-render on `hass`. HA pushes a new
 * `hass` object several times a second; a naive `@property` there would repaint
 * the whole chrome tree on every light that changes anywhere in the house.
 */

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import { cardStyles, themeTokens } from '@/card/card-styles';
import { ensureChakraPetch } from '@/ui/fonts/chakra-petch';
import type {
  EditIntent,
  EntityVisualState,
  LoadedModel,
  ModelLoadProgress,
} from '@/engine/contracts';
import { toEntityVisual } from '@/ha/state-mapper';
import { Viewer, WebGLUnavailableError } from '@/engine/viewer';
import { handleAction, PRESET_EVENT } from '@/ha/actions';
import { ConfigError, normalizeConfig, stubConfig, validateConfig } from '@/ha/config-schema';
import {
  cardMatcher,
  findLovelaceHost,
  substituteCard,
  type CardMatcher,
  type LovelaceHost,
} from '@/ha/lovelace-store';
import { localize } from '@/ha/localize';
import { domainOf, getEntityName, suggestPlacementLevel } from '@/ha/registry';
import { readTheme } from '@/ha/theme';
import { toYaml } from '@/editor/yaml-preview';
import {
  CARD_EDIT_EVENT,
  CARD_TYPE,
  type CardEditDetail,
  DEFAULT_SECTION_STATE,
  EDITOR_TAG,
  type CameraPreset,
  type Floorplan3dCardConfig,
  type LevelDefinition,
  type PlacedEntity,
  type SectionState,
  type TourConfig,
  type Vec3,
} from '@/types/config';
import { DEFAULT_CAMERA_CONFIG, DEFAULT_TOUR_CONFIG } from '@/types/config';
import type { HomeAssistant, LovelaceCard } from '@/types/hass';
import { fireEvent } from '@/util/events';
import { vRound } from '@/util/math';

import type { CardError } from '@/ui/error-panel';
import { recallView, rememberView } from '@/card/view-memory';
import { configKey } from '@/util/config-key';
import {
  authorToolsVisible,
  resolveDark,
  explodeAvailable,
  levelSelectorVisible,
  sectionButtonVisible,
  sectionPanelVisible,
  toolbarVisible,
} from '@/card/chrome-rules';
import { ancestorsAcrossShadow } from '@/util/dom-chain';
import type { Fp3dHud } from '@/ui/hud';
import type { UiSize } from '@/ui/base-element';
import type { ToolbarAction } from '@/ui/toolbar';

import '@/ui/error-panel';
import '@/ui/loading-overlay';
import '@/ui/toolbar';
import '@/ui/zoom-slider';
import '@/ui/level-selector';
import '@/ui/action-dock';
import '@/ui/section-panel';
import '@/ui/entity-palette';
import '@/ui/entity-inspector';
import '@/ui/hud';

/** MIME type the palette writes into `dataTransfer`. Mirrors HA's own picker. */
export const ENTITY_DRAG_MIME = 'application/x-ha-entity';

type PanelId = 'none' | 'section' | 'palette';
type Status = 'idle' | 'loading' | 'ready' | 'error';

interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** HA 2024.11 sections layout. Structural, so no dependency on HA internals. */
interface GridOptions {
  columns?: number | 'full';
  rows?: number | 'auto';
  min_columns?: number;
  min_rows?: number;
}

/**
 * Views saved when Lovelace will not accept a config write live here instead.
 * The key has two parts so a card that gains an entity does not orphan them:
 * `<model+title hash>:<entity list hash>`, and a load falls back to any entry
 * with the same first part.
 */
const LOCAL_VIEWS_PREFIX = 'floorplan-3d-card:views:';

/** Marks a view generated from a detected storey rather than saved by a user. */
const LEVEL_PRESET_PREFIX = 'level:';
/** Generated view of the whole building; see `overviewPreset`. */
const OVERVIEW_PRESET_ID = 'overview:all';

/**
 * True isometric: the camera looks along (1, 1, 1), so the three axes are
 * foreshortened equally — 45° in plan, ~35.26° above the horizon. Combined
 * with an orthographic projection this is the classic CAD axonometric, and it
 * shows rooms *and* storey height at once, which a straight plan cannot.
 */
const ISO = 1 / Math.sqrt(3);

/** FNV-1a. Short, stable across reloads, and no dependency. */
function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Home Assistant only listens for `config-changed` inside the card editor —
 * `hui-dialog-edit-card` and the `hui-card-preview` it wraps. Fired anywhere
 * else (a normal dashboard view, even in edit mode) the event is dropped on the
 * floor, which is why a "save view" button that just fires it loses the user's
 * work silently. Walking the composed ancestry for those elements is the only
 * signal available to a custom card.
 */
function hasLovelaceEditorAncestor(start: Node): boolean {
  for (const el of ancestorsAcrossShadow(start, 60)) {
    const name = el.localName;
    if (name === 'hui-card-preview' || name === 'hui-dialog-edit-card') return true;
    if (name.startsWith('hui-') && name.includes('editor')) return true;
  }
  return false;
}

const NARROW_PX = 400;
const MEDIUM_PX = 660;
/** Deferred teardown window: HA re-parents cards, and a WebGL context is dear. */
const DISPOSE_GRACE_MS = 300;

export class Floorplan3dCard extends LitElement implements LovelaceCard {
  static override styles = [themeTokens, cardStyles];

  /* ---------------------------------------------------------- HA-set props */

  @property({ type: Boolean, reflect: true }) isPanel = false;
  @property({ type: Boolean }) editMode = false;
  /**
   * Escape hatch for hosts that know whether a `config-changed` will stick
   * (embedders, the dev harness). 'auto' sniffs the Lovelace editor.
   */
  @property({ attribute: false }) configPersistence: 'auto' | 'available' | 'unavailable' = 'auto';

  /* -------------------------------------------------------------- UI state */

  @state() private config: Floorplan3dCardConfig | null = null;
  @state() private status: Status = 'idle';
  @state() private progress: ModelLoadProgress | null = null;
  @state() private error: CardError | null = null;
  @state() private panel: PanelId = 'none';
  @state() private layout: UiSize = 'wide';
  @state() private levels: LevelDefinition[] = [];
  @state() private visibleLevels: string[] | null = null;
  @state() private section: SectionState = { ...DEFAULT_SECTION_STATE };
  @state() private activePreset: string | null = null;
  @state() private selectedEntity: string | null = null;
  @state() private autoRotate = false;
  @state() private fullscreen = false;
  @state() private editing = false;
  @property({ type: Boolean, reflect: true }) private dark = false;
  @state() private bounds: Bounds | null = null;
  /** Views saved while Lovelace would not take them. Browser-local. */
  @state() private localPresets: CameraPreset[] = [];
  @state() private tourPlaying = false;
  /** Mirrors the camera's 0..1 zoom so the slider tracks orbiting and presets. */
  @state() private zoom = 0.5;
  /** Storeys pulled apart. A view state, never written back to the config. */
  @state() private exploded = false;
  /**
   * Navigator folded down to a chip. Held here rather than in the panel so it
   * survives the panel being rebuilt, and session-only: "out of the way for a
   * moment" is not a property of the dashboard.
   */
  @state() private levelsCollapsed = false;
  /**
   * Whether the fold state is the user's doing.
   *
   * Until it is, the card decides by width: on a phone the navigator covers a
   * quarter of the house, and a list of places to go is worth less than seeing
   * where you are. Once folded or unfolded by hand, that choice stands however
   * the card is resized.
   */
  private collapseChosen = false;
  /** The shelf folds on its own account; see `levelsCollapsed` for the why. */
  @state() private dockCollapsed = false;
  private dockCollapseChosen = false;

  @query('.canvas-host') private canvasHost?: HTMLDivElement;
  @query('.card') private cardRoot?: HTMLDivElement;
  @query('fp3d-hud') private hud?: Fp3dHud;

  /* -------------------------------------------------------------- internals */

  private _hass?: HomeAssistant;
  private viewer: Viewer | null = null;
  private mounting = false;
  private resizeObserver: ResizeObserver | null = null;
  /** Pending re-measure of the card's box; see `scheduleSizing`. */
  private sizingFrame: number | null = null;
  /** Last line printed by `explainChrome`, so it prints on change only. */
  private chromeExplained = '';
  /** The config object Lovelace handed us, verbatim; see `saveToDashboard`. */
  private rawConfig: unknown = null;
  /** The dashboard config we last submitted, while the save is in flight. */
  private sentDashboard: unknown = null;
  /** Saves run one after another; see `saveToDashboard`. */
  private dashboardWrite: Promise<void> = Promise.resolve();
  /** Pixel height we took for ourselves in a panel view; see `fitToViewBox`. */
  private pinnedHeight: number | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: Array<() => void> = [];
  /** Serialised form of the config we last emitted, to ignore our own echo. */
  private lastEmitted = '';
  private dragEntityId: string | null = null;
  private dragFrame = 0;
  private dragPoint: { x: number; y: number } | null = null;
  /** Said once: a change on a live dashboard cannot be kept. See `commitConfig`. */
  private warnedVolatile = false;
  /** Guards against the engine and the card both persisting the same drop. */
  private recentAdds = new Map<string, number>();
  private localViewsKey: string | null = null;
  private tourTimer: ReturnType<typeof setTimeout> | null = null;
  private tourResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private tourMoveTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a tour-initiated flight is in progress; see onUserCameraInput. */
  private tourMoving = false;

  /* -------------------------------------------------- Lovelace card contract */

  static getConfigElement(): HTMLElement {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig(hass: HomeAssistant): Floorplan3dCardConfig {
    return stubConfig(hass);
  }

  setConfig(config: unknown): void {
    // Kept as handed over, not as validated: this is the object to look for in
    // the dashboard config when a placement has to be written back.
    this.rawConfig = config;
    let next: Floorplan3dCardConfig;
    try {
      next = validateConfig(config);
    } catch (err) {
      // Lovelace renders whatever we throw, so the message is the whole UI.
      const message = err instanceof ConfigError ? err.message : String(err);
      throw new Error(`${CARD_TYPE}: ${message}`);
    }

    const serialised = configKey(next);
    if (serialised === this.lastEmitted && this.config) return;
    this.lastEmitted = serialised;

    const previous = this.config;
    this.config = next;
    this.section = next.section ?? { ...DEFAULT_SECTION_STATE };
    this.autoRotate = next.camera?.autoRotate === true && !this.prefersReducedMotion();
    if (next.model?.levels?.length) this.levels = next.model.levels;
    if (this.error?.kind === 'config') this.error = null;

    if (previous && this.viewer) void this.viewer.updateConfig(next);
  }

  getCardSize(): number {
    const height = this.config?.ui?.height ?? '520px';
    const px = Number.parseFloat(height);
    if (this.isPanel || !Number.isFinite(px) || height.endsWith('%')) return 10;
    return Math.max(3, Math.round(px / 50));
  }

  /** Sections view: a 3D scene is useless in a narrow column, so ask for width. */
  getGridOptions(): GridOptions {
    return { columns: 'full', rows: Math.max(4, this.getCardSize()), min_columns: 6, min_rows: 3 };
  }

  /* ------------------------------------------------------------------- hass */

  set hass(hass: HomeAssistant | undefined) {
    const previous = this._hass;
    this._hass = hass;
    if (!hass) return;

    this.viewer?.updateHass(hass);
    this.forwardHass(hass);

    if (!previous || previous.themes !== hass.themes || previous.selectedTheme !== hass.selectedTheme) {
      this.applyTheme();
    }
    // First push has to paint: everything else is handed to children directly.
    if (!previous) this.requestUpdate();
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  /**
   * Children take `hass` through a non-reactive setter, so pushing it here
   * costs a property write and nothing else. Each child decides for itself
   * whether the change is worth a repaint.
   */
  private forwardHass(hass: HomeAssistant): void {
    const root = this.renderRoot as ParentNode | undefined;
    if (!root) return;
    for (const node of root.querySelectorAll<HTMLElement & { hass?: HomeAssistant }>('[data-hass]')) {
      node.hass = hass;
    }
  }

  /* -------------------------------------------------------------- lifecycle */

  override connectedCallback(): void {
    super.connectedCallback();
    // Not a stylesheet: a font face adopted into a shadow root is ignored, so
    // the family has to be registered on the document. See the font module.
    ensureChakraPetch();
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    window.addEventListener('fullscreenchange', this.onFullscreenChange);
    // A window resize moves the card's top edge without resizing the card
    // itself whenever the dashboard reflows around it.
    window.addEventListener('resize', this.onWindowResize);
    this.addEventListener(PRESET_EVENT, this.onPresetEvent as EventListener);
    // hasUpdated => firstUpdated already ran and will not run again.
    if (this.hasUpdated && !this.viewer) void this.mountViewer();
    // Same reason: `disconnectedCallback` dropped the observer, and Home
    // Assistant re-parents cards routinely. Without this the narrow/medium/wide
    // chrome freezes at whatever it was before the first move.
    if (this.hasUpdated && !this.resizeObserver) this.observeSize();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Here, not in `teardownViewer`: disposal is deferred by DISPOSE_GRACE_MS
    // because Home Assistant re-parents cards, so by the time it runs the card
    // that replaces us has already mounted and looked for this.
    this.rememberView();
    window.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('resize', this.onWindowResize);
    this.removeEventListener(PRESET_EVENT, this.onPresetEvent as EventListener);
    this.clearTourTimers();
    this.tourPlaying = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.unpinHeight();
    if (this.sizingFrame !== null) {
      cancelAnimationFrame(this.sizingFrame);
      this.sizingFrame = null;
    }

    // HA re-parents cards on layout changes: tearing a WebGL context down and
    // building it again inside the same tick is both slow and visible. Wait to
    // see whether we come back first.
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = setTimeout(() => {
      this.disposeTimer = null;
      this.teardownViewer();
    }, DISPOSE_GRACE_MS);
  }

  protected override firstUpdated(): void {
    this.observeSize();
    this.scheduleSizing();
    void this.mountViewer();
  }

  protected override updated(changed: PropertyValues): void {
    {
      // The dashboard decides. There is no switch of our own any more: a card
      // with its own edit mode gives you two of them to keep track of, and the
      // one that matters is the dashboard's — that is the mode in which a change
      // can be saved at all. `authorTools: never` still outranks it.
      //
      // Asked of the dashboard as well as read from the property, because the
      // property is set by whatever wrapper Home Assistant happens to use and a
      // card that missed the memo would show no tools in the one mode that can
      // save. Checked on every update for the same reason: there is no event.
      const wanted =
        this.authorMode !== 'never' &&
        (this.editMode || this.inCardEditor() || findLovelaceHost(this)?.editMode === true);
      if (this.editing !== wanted) {
        this.editing = wanted;
        // Entering it shows the placement tools rather than just enabling them.
        this.panel = wanted ? 'palette' : 'none';
      }
    }
    if (changed.has('config')) {
      this.loadLocalPresets();
      // The setting can change without `hass` moving at all.
      this.applyTheme();
    }
    if ((changed.has('section') || changed.has('visibleLevels')) && this.exploded && !this.canExplode) {
      this.viewer?.setExplode(0, false);
      this.exploded = false;
    }
    if (changed.has('editing')) {
      this.viewer?.setEditMode(this.editing);
      if (!this.editing) {
        this.selectedEntity = null;
        if (this.panel === 'palette') this.panel = 'none';
      }
    }
    if (changed.has('layout')) {
      this.setAttribute('data-layout', this.layout);
      // Anything but a wide card: the panel is around 200 px, which is a third
      // of a phone in portrait and most of what you came to look at.
      if (!this.collapseChosen) this.levelsCollapsed = this.layout !== 'wide';
      if (!this.dockCollapseChosen) this.dockCollapsed = this.layout !== 'wide';
    }
    // Every update, not just when `config` or `isPanel` changed. Home Assistant
    // sets `isPanel` on its own schedule — sometimes before the module that
    // defines this element has even loaded — and a card that missed the memo
    // stays at its configured height in a view meant to be filled. Writing four
    // style properties is not worth the bookkeeping to avoid.
    this.applyHostSizing();
    // …and again once the dashboard has settled. A measurement taken mid-layout
    // is not wrong so much as premature, and nothing else would revisit it.
    this.scheduleSizing();
    this.placeViewCube();
    // setConfig can arrive after the first render (HA does this when a card is
    // created empty and configured afterwards); firstUpdated has been and gone.
    if (changed.has('config') && this.config && !this.viewer && this.isConnected) {
      void this.mountViewer();
    }
    if (this._hass) this.forwardHass(this._hass);
  }

  /**
   * Which way round the card is drawn.
   *
   * `ui.theme` was written into the schema and offered in the editor and then
   * never read: picking Light did nothing at all. It is a real setting, so it
   * decides, and only `auto` asks the dashboard.
   */
  private applyTheme(): void {
    const dark = resolveDark(this.config?.ui?.theme, readTheme(this, this._hass).isDark);
    if (this.dark === dark) return;
    this.dark = dark;
    // The 3D background is transparent, so anything the engine draws over the
    // card — edge lines above all — has to contrast with the dashboard, not
    // with the model.
    this.viewer?.setThemeDark(dark);
  }

  /** Height / aspect ratio live on the host so panel mode can fill the view. */
  private applyHostSizing(): void {
    const ui = this.config?.ui ?? {};
    const height = ui.height ?? '520px';
    const view = this.findViewBox();
    const full = this.isPanel || view.panel || height === '100%' || height === '100vh';
    this.toggleAttribute('full', full);
    this.toggleAttribute('aspect', !full && Boolean(ui.aspectRatio));
    if (ui.aspectRatio) this.style.setProperty('--fp3d-aspect', ui.aspectRatio.replace(':', ' / '));
    this.style.setProperty('--fp3d-card-height', full ? '100%' : height);

    if (!full) {
      this.unpinHeight();
      return;
    }
    this.fitToViewBox(view.container);
  }

  /**
   * Where the dashboard put us: the view box that owns our height, and whether
   * this is a panel view at all.
   *
   * `isPanel` is a property Home Assistant may or may not set — in a panel view
   * the card sits inside `hui-card`, which does not pass it on, so the card can
   * be filling a whole view without ever being told. The DOM around us says it
   * plainly, so read that instead of waiting to be informed.
   *
   * The walk crosses shadow boundaries: `parentElement` stops dead at the edge
   * of a shadow root, and Home Assistant puts one right in this chain.
   */
  private findViewBox(): { container: HTMLElement | null; panel: boolean } {
    let container: HTMLElement | null = null;
    let panel = false;

    for (const el of ancestorsAcrossShadow(this.parentNode ?? this)) {
      const tag = el.localName;
      if (tag === 'body' || tag === 'html') break;
      if (tag === 'hui-panel-view') panel = true;
      // `hui-view-container` is the box the dashboard sizes itself, so it is the
      // one worth measuring; the views inside it are the fallback for a layout
      // that does not have one.
      if (tag === 'hui-view-container') {
        container = el;
        break;
      }
      if (!container && (tag === 'hui-panel-view' || tag === 'hui-view')) container = el;
    }
    return { container, panel };
  }

  /**
   * Take the height from the view box and be done with it.
   *
   * Everything else was tried first: `height: 100%` (a question no ancestor
   * answered), then giving each wrapper a height so it would (defeated by a view
   * sized with `min-height`), then the viewport as a fallback. The box the
   * dashboard sizes is right there and knows its own height — measure from our
   * top edge to its bottom and take that, in pixels, which nothing above can
   * refuse.
   *
   * Measurement alone failed before because a wrong reading stuck. Here it
   * cannot: a reading is only taken once the card is laid out, and it is redone
   * on every resize, every re-parenting and every render, so a premature frame
   * is corrected by the next one instead of becoming the card's height forever.
   */
  private fitToViewBox(container: HTMLElement | null): void {
    if (typeof window === 'undefined') return;
    // No dashboard around us — a dev harness, a storybook, an embed. Whoever
    // put the card there sized their own box; `height: 100%` from the stylesheet
    // is the right answer and a viewport measurement is not.
    if (!container && !this.isPanel) {
      this.unpinHeight();
      return;
    }
    const top = this.getBoundingClientRect().top;
    let bottom = window.innerHeight;
    if (container) {
      const box = container.getBoundingClientRect();
      const pad = Number.parseFloat(getComputedStyle(container).paddingBottom) || 0;
      if (box.height > 0) bottom = Math.min(bottom, box.bottom - pad);
    }

    const span = bottom - top;
    // Whatever the dashboard puts under a card, it is chrome — a row of buttons,
    // not half the screen. Capping it keeps a mismeasurement from collapsing the
    // card to a strip, which is a failure you cannot see your way out of.
    const chrome = Math.min(this.spaceBelow(container), span * 0.4);
    const avail = Math.round(span - chrome);
    // Not laid out yet, or scrolled out of view: no number here is worth having,
    // and the next pass will have a better one.
    if (!Number.isFinite(avail) || avail < 240) return;
    // A tolerance, not thrift: our own height feeds back into the observer that
    // called us, and a one-pixel disagreement must not become a loop.
    if (this.pinnedHeight !== null && Math.abs(avail - this.pinnedHeight) <= 4) return;

    this.pinnedHeight = avail;
    this.style.height = `${avail}px`;
    // `showFps` is the card's debug switch, and a height that comes out wrong is
    // impossible to reason about from a screenshot. These four numbers say which
    // step got it wrong.
    if (this.config?.ui?.showFps === true) {
      console.info(
        '[floorplan-3d] height %dpx = %s bottom %d − card top %d − chrome below %d',
        avail,
        container ? container.localName : 'viewport',
        Math.round(bottom),
        Math.round(top),
        Math.round(chrome),
      );
    }
  }

  /**
   * What sits between our bottom edge and the view box's, and is not ours.
   *
   * Edit mode is the case that matters: Home Assistant wraps every card in its
   * own toolbar — the row with the edit and delete buttons — and that row is a
   * sibling *below* the card. Taking the whole view for ourselves pushed it off
   * the bottom of the screen, so editing a card meant scrolling to find the way
   * in. Everything after us on the way up is counted, plus each wrapper's own
   * bottom padding and border, so this holds for whatever the dashboard adds
   * next without knowing what it is.
   */
  private spaceBelow(container: HTMLElement | null): number {
    // Everything on the way up that sits *below* the card and is not the card:
    // the row with the edit and delete buttons that edit mode puts under every
    // card. It is not a sibling — it lives in `hui-card-options`' shadow root —
    // so both the light-DOM siblings and each wrapper's shadow children are
    // considered, and the deciding test is geometric rather than structural.
    //
    // Measuring a wrapper's own box instead does not work, however tempting: a
    // wrapper stretched to the view is as tall as the view whether it holds a
    // toolbar or not, and subtracting that from the view leaves the card exactly
    // the height it already had. It froze at whatever it happened to be.
    const own = this.getBoundingClientRect().bottom;
    let extra = 0;

    const consider = (el: Element): void => {
      const box = el.getBoundingClientRect();
      if (box.height <= 0) return;
      // Starts above our bottom edge, so it wraps us rather than following us.
      if (box.top < own - 1) return;
      // Overlays are drawn on top of the card and take no room from it.
      if (getComputedStyle(el).position === 'absolute') return;
      extra += box.height;
    };

    for (const el of ancestorsAcrossShadow(this)) {
      if (el === container) break;
      for (let sibling = el.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        consider(sibling);
      }
      for (const child of el.shadowRoot?.children ?? []) consider(child);
    }
    return extra;
  }

  private unpinHeight(): void {
    if (this.pinnedHeight === null) return;
    this.pinnedHeight = null;
    this.style.removeProperty('height');
  }

  /**
   * Re-apply the sizing once the dashboard has finished moving things around.
   *
   * Home Assistant re-parents cards: a view switching layout, an error card
   * being replaced by the real one. Each of those puts us in a different box,
   * and the height we measured belongs to the old one.
   */
  private scheduleSizing(): void {
    if (this.sizingFrame !== null || typeof requestAnimationFrame !== 'function') return;
    this.sizingFrame = requestAnimationFrame(() => {
      this.sizingFrame = requestAnimationFrame(() => {
        this.sizingFrame = null;
        this.applyHostSizing();
        this.viewer?.resize();
      });
    });
  }

  private readonly onWindowResize = (): void => {
    this.scheduleSizing();
  };

  private observeSize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      // Several elements are watched, so the card's own entry has to be picked
      // out — an ancestor's width would put the chrome in the wrong layout.
      const own = entries.find((entry) => entry.target === this)?.contentRect;
      const width = own?.width ?? this.clientWidth;
      if (width <= 0) return;
      this.layout = width < NARROW_PX ? 'narrow' : width < MEDIUM_PX ? 'medium' : 'wide';
      // The card may have moved as well as changed size — a sidebar folding
      // away, a view switching to panel — and its top edge is what the full
      // height is measured from.
      this.applyHostSizing();
      // The renderer watches its own container, but the card is the element
      // whose box the dashboard changes — a view switching to panel, a sidebar
      // folding away. Telling the viewer here costs a measurement and closes
      // the gap where the card had grown and the canvas had not noticed.
      this.viewer?.resize();
    });
    this.resizeObserver.observe(this);
    // Everything between us and the view box, and the box itself. The card's own
    // size is not enough to go on: entering edit mode adds a toolbar *below* the
    // card, which changes a wrapper's height and nothing else — and that is
    // exactly the moment the height has to be recomputed. `parentElement` is
    // null across a shadow boundary, which is where Home Assistant puts us, so
    // the walk crosses those.
    const { container } = this.findViewBox();
    for (const el of ancestorsAcrossShadow(this.parentNode ?? this)) {
      this.resizeObserver.observe(el);
      if (el === container) break;
    }
  }

  /* ---------------------------------------------------------- author mode */

  private get authorMode(): 'auto' | 'never' | 'always' {
    return this.config?.ui?.authorTools ?? 'auto';
  }

  /**
   * One master switch for every authoring affordance. Note that it governs
   * *visibility* only: `always` must not put the engine into edit mode, or
   * tapping a lamp would select it for the inspector instead of switching it on.
   */
  private get showAuthorTools(): boolean {
    return authorToolsVisible(this.authorMode, this.editing);
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /* ------------------------------------------------------------ viewer glue */

  private async mountViewer(): Promise<void> {
    if (this.viewer || this.mounting || !this.config) return;
    const host = this.canvasHost;
    if (!host) return;

    this.mounting = true;
    this.status = 'loading';
    this.error = null;
    // A previous context may have left its canvas behind on a fast remount.
    host.replaceChildren();

    const viewer = new Viewer();
    this.viewer = viewer;
    this.wireViewer(viewer);
    this.bindDropTarget(host);

    try {
      if (this._hass) viewer.updateHass(this._hass);
      // Before mount, so the first frame already has readable edge lines.
      viewer.setThemeDark(this.dark);
      await viewer.mount(host, this.config);
      if (!this.isConnected || this.viewer !== viewer) return;
      this.restoreView(viewer);
      // Mounting is asynchronous, so the card may have been moved into its
      // final place while the model was loading.
      this.scheduleSizing();
      viewer.setEditMode(this.editing);
      if (this.autoRotate) viewer.cameraCtl.setAutoRotate(true);
    } catch (err) {
      if (this.viewer !== viewer) return;
      this.status = 'error';
      this.error =
        err instanceof WebGLUnavailableError
          ? {
              kind: 'webgl',
              message: this.t(
                'ui.error.webgl',
                'This browser or device has no WebGL support, so the 3D view cannot be shown.',
              ),
              cause: err,
            }
          : {
              kind: 'unknown',
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            };
    } finally {
      this.mounting = false;
    }
  }

  /**
   * Identifies this card's view across a remount: the model it shows and the
   * name it goes by. Two cards showing different houses keep their own camera;
   * two showing the same one may share it, which is the harmless case.
   */
  private viewMemoryKey(): string | null {
    const config = this.config;
    if (!config) return null;
    return `${config.model?.url ?? ''}|${config.title ?? ''}`;
  }

  /**
   * Keep the view for the card that replaces us.
   *
   * Editing rebuilds the card — Home Assistant re-creates a view's cards when
   * the dashboard config changes, and in edit mode this card changes it on every
   * placement. Framing the house from scratch each time made the one mode where
   * you work closely with the model the one where it kept jumping away.
   */
  private rememberView(): void {
    const key = this.viewMemoryKey();
    const viewer = this.viewer;
    if (!key || !viewer?.isMounted) return;
    // Only while editing. This exists because saving rebuilds the card mid-work;
    // carrying a view over to an ordinary visit to the dashboard would override
    // the opening view the config asks for, which is not ours to override.
    if (!this.editing) return;
    try {
      rememberView(key, {
        camera: viewer.cameraCtl.capture('resume'),
        section: JSON.parse(JSON.stringify(this.section)) as SectionState,
        visibleLevels: this.visibleLevels,
        explode: viewer.explode,
        activePreset: this.activePreset,
        collapsed: this.levelsCollapsed,
        collapseChosen: this.collapseChosen,
        dockCollapsed: this.dockCollapsed,
        dockCollapseChosen: this.dockCollapseChosen,
      });
    } catch {
      // Camera subsystem already gone; nothing worth keeping.
    }
  }

  /** Storeys first, then the camera: pulling them apart refits the view. */
  private restoreView(viewer: Viewer): void {
    const key = this.viewMemoryKey();
    const memory = key ? recallView(key) : null;
    if (!memory) return;

    if (memory.section) {
      this.section = memory.section;
      viewer.setSection(memory.section, false);
    }
    this.visibleLevels = memory.visibleLevels;
    this.levelsCollapsed = memory.collapsed;
    this.collapseChosen = memory.collapseChosen;
    this.dockCollapsed = memory.dockCollapsed;
    this.dockCollapseChosen = memory.dockCollapseChosen;
    viewer.setVisibleLevels(memory.visibleLevels);
    if (memory.explode > 0) {
      viewer.setExplode(memory.explode, false);
      this.exploded = true;
    }
    try {
      void viewer.cameraCtl.applyPreset(memory.camera, false);
      this.activePreset = memory.activePreset;
    } catch {
      // Without a camera there is nothing to restore it to; the default framing
      // from mount stands.
    }
  }

  private wireViewer(viewer: Viewer): void {
    this.unsubscribers.push(
      viewer.on('ready', () => {
        this.status = 'ready';
        this.progress = null;
        // Subsystems only exist once mount() has resolved, so the camera
        // subscription cannot be set up alongside the other listeners.
        try {
          this.zoom = viewer.cameraCtl.getZoom01();
          this.unsubscribers.push(
            viewer.cameraCtl.onChange(() => {
              this.onUserCameraInput();
              // Wheel, drag and preset flights all move the camera; the slider
              // has to follow, or it lies about where you are.
              this.zoom = viewer.cameraCtl.getZoom01();
            }),
          );
        } catch {
          // Camera subsystem failed to init; the tour simply will not pause.
        }
        if (this.tourCfg.autoplay && !this.prefersReducedMotion()) this.setTourPlaying(true);
      }),
      viewer.on('load-progress', (progress) => {
        this.progress = progress;
        if (progress.phase === 'error' && this.status !== 'ready') {
          this.status = 'error';
          this.error = {
            kind: 'model',
            message: progress.message ?? 'The model could not be loaded.',
          };
        }
      }),
      viewer.on('model-loaded', (model) => this.onModelLoaded(model)),
      viewer.on('error', (payload) => this.onViewerError(payload.message, payload.cause)),
      viewer.on('entity-activate', (payload) => this.onEntityActivate(payload.entityId, payload.action)),
      viewer.on('edit-intent', (intent) => this.applyIntent(intent, true)),
      viewer.on('preset-applied', ({ presetId }) => {
        this.activePreset = presetId;
      }),
      viewer.on('section-changed', (section) => {
        this.section = section;
      }),
      viewer.on('levels-changed', ({ visible }) => {
        this.visibleLevels = visible;
      }),
    );
  }

  private onModelLoaded(model: LoadedModel): void {
    this.levels = model.levels.length ? model.levels : (this.config?.model?.levels ?? []);
    this.bounds = {
      min: [model.bounds.min.x, model.bounds.min.y, model.bounds.min.z],
      max: [model.bounds.max.x, model.bounds.max.y, model.bounds.max.z],
    };
  }

  /**
   * A subsystem failing after the scene is up degrades the card; it does not
   * break it. Only pre-`ready` failures take over the whole surface.
   */
  private onViewerError(message: string, cause?: unknown): void {
    if (this.status === 'ready') {
      this.hud?.toast({ message });
      return;
    }
    this.status = 'error';
    this.error = { kind: 'model', message, cause };
  }

  private teardownViewer(): void {
    this.rememberView();
    for (const off of this.unsubscribers.splice(0)) off();
    this.unbindDropTarget();
    this.viewer?.dispose();
    this.viewer = null;
    this.status = 'idle';
    this.progress = null;
  }

  /* --------------------------------------------------------------- actions */

  private onEntityActivate(entityId: string, action: 'tap' | 'hold' | 'double-tap'): void {
    // In edit mode a tap means "let me configure this", not "toggle my lamp".
    if (this.editing && action === 'tap') {
      this.selectedEntity = entityId;
      return;
    }
    const hass = this._hass;
    const placed = this.config?.entities?.find((entry) => entry.entity === entityId);
    if (!hass || !placed) return;
    void handleAction(this, hass, placed, action);
  }

  private readonly onPresetEvent = (event: CustomEvent<{ presetId: string }>): void => {
    const presetId = event.detail?.presetId;
    if (presetId) void this.viewer?.applyPreset(presetId, !this.prefersReducedMotion());
  };

  private readonly onFullscreenChange = (): void => {
    this.fullscreen = document.fullscreenElement === this.cardRoot;
    this.viewer?.resize();
  };

  private onToolbarAction(action: ToolbarAction): void {
    const viewer = this.viewer;
    switch (action) {
      case 'reset':
        this.resetView();
        break;
      case 'fit':
        viewer?.fitToView(!this.prefersReducedMotion());
        break;
      case 'explode':
        if (!viewer) break;
        // Toggling writes nothing: separating the storeys is a way of looking
        // at the model, and it sticks only if a view is saved with it on.
        viewer.setExplode(viewer.explode > 0 ? 0 : this.explodeGap());
        this.exploded = viewer.explode > 0;
        break;
      case 'autorotate':
        this.autoRotate = !this.autoRotate;
        viewer?.cameraCtl.setAutoRotate(this.autoRotate);
        break;
      case 'tour':
        this.setTourPlaying(!this.tourPlaying);
        break;
      case 'fullscreen':
        this.toggleFullscreen();
        break;
      case 'section':
      case 'palette':
        this.panel = this.panel === action ? 'none' : action;
        break;
    }
  }

  /**
   * How far apart to pull the storeys when the toolbar turns it on. Scaled to
   * the building so a bungalow and a four-storey house both read as separated
   * rather than as scattered.
   */
  private explodeGap(): number {
    const configured = this.config?.ui?.explode ?? 0;
    if (configured > 0) return configured;
    const heights = this.levels.map((level) => level.height).filter((h) => h > 0);
    const typical = heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : 2.7;
    return Math.round(typical * 10) / 10;
  }

  private resetView(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const animate = !this.prefersReducedMotion();
    const preset = this.config?.presets?.find((entry) => entry.default) ?? this.config?.presets?.[0];
    if (preset) {
      void viewer.applyPreset(preset.id, animate);
      return;
    }
    const bounds = viewer.model.model?.bounds;
    if (bounds) viewer.cameraCtl.frameObject(bounds, animate);
  }

  private toggleFullscreen(): void {
    const target = this.cardRoot;
    if (!target) return;
    if (document.fullscreenElement === target) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void target.requestFullscreen?.().catch(() => undefined);
    }
  }

  /* ----------------------------------------------------- config persistence */

  /**
   * The single write path. Applies an intent to a *copy* of the config, keeps
   * the result locally so the chrome updates instantly, and only then tells
   * Lovelace — which will echo the same config back through `setConfig`.
   */
  private applyIntent(intent: EditIntent, fromEngine: boolean): void {
    const current = this.config;
    if (!current) return;

    if (intent.kind === 'add-entity' && this.isDuplicateAdd(intent.entity.entity)) return;

    const next: Floorplan3dCardConfig = JSON.parse(JSON.stringify(current));
    const entities = [...(next.entities ?? [])];
    const presets = [...(next.presets ?? [])];
    const shortcuts = [...(next.shortcuts ?? [])];
    let label: string | null = null;

    switch (intent.kind) {
      case 'add-entity': {
        if (entities.some((entry) => entry.entity === intent.entity.entity)) return;
        entities.push(intent.entity);
        next.entities = entities;
        this.recentAdds.set(intent.entity.entity, Date.now());
        label = this.entityLabel(intent.entity.entity);
        // Select it immediately. Dropping a marker into a 3D scene and getting
        // no acknowledgement leaves you hunting for where it landed — the
        // selection ring answers "where", and the inspector that opens with it
        // answers "on which storey, at which coordinates, and how do I nudge
        // it". This is the whole difference between the drop feeling finished
        // and feeling lost.
        this.selectedEntity = intent.entity.entity;
        break;
      }
      case 'move-entity': {
        const index = entities.findIndex((entry) => entry.entity === intent.entityId);
        if (index < 0) return;
        const moved: PlacedEntity = {
          ...entities[index],
          position: vRound(intent.position),
          level: intent.level,
        };
        // `undefined` means the drop landed inside a room and the position
        // speaks for itself, so the old override is dropped rather than kept.
        if (intent.room === undefined) delete moved.room;
        else if (intent.room) moved.room = intent.room;
        entities[index] = moved;
        next.entities = entities;
        break;
      }
      case 'update-entity': {
        const index = entities.findIndex((entry) => entry.entity === intent.entityId);
        if (index < 0) return;
        entities[index] = { ...entities[index], ...intent.patch };
        next.entities = entities;
        break;
      }
      case 'remove-entity': {
        next.entities = entities.filter((entry) => entry.entity !== intent.entityId);
        if (next.entities.length === entities.length) return;
        if (this.selectedEntity === intent.entityId) this.selectedEntity = null;
        label = this.entityLabel(intent.entityId);
        break;
      }
      case 'add-shortcut': {
        if (shortcuts.some((entry) => entry.entity === intent.entityId)) return;
        shortcuts.push({ entity: intent.entityId });
        next.shortcuts = shortcuts;
        label = this.entityLabel(intent.entityId);
        break;
      }
      case 'remove-shortcut': {
        next.shortcuts = shortcuts.filter((entry) => entry.entity !== intent.entityId);
        if (next.shortcuts.length === shortcuts.length) return;
        label = this.entityLabel(intent.entityId);
        break;
      }
      case 'add-preset': {
        presets.push(intent.preset);
        next.presets = presets;
        break;
      }
      case 'update-preset': {
        const index = presets.findIndex((entry) => entry.id === intent.presetId);
        if (index < 0) return;
        // Only one preset may be the default, or the second never opens.
        if (intent.patch.default) {
          for (let i = 0; i < presets.length; i += 1) {
            if (presets[i].default) presets[i] = { ...presets[i], default: false };
          }
        }
        presets[index] = { ...presets[index], ...intent.patch };
        next.presets = presets;
        break;
      }
      case 'remove-preset': {
        next.presets = presets.filter((entry) => entry.id !== intent.presetId);
        if (next.presets.length === presets.length) return;
        break;
      }
      case 'set-section': {
        next.section = intent.section;
        this.section = intent.section;
        break;
      }
    }

    this.commitConfig(next, { reload: !fromEngine });
    if (label) this.offerUndo(intent, label, current);
  }

  /**
   * Write the placement into the dashboard config, from the dashboard.
   *
   * Home Assistant hands each view a `lovelace` object that owns the config and
   * can save it, which is how this is possible at all. Three things gate it, and
   * all three are the point rather than caution for its own sake: the dashboard
   * must be in edit mode (the same state that put the placement tools on screen),
   * it must be a storage dashboard (a YAML one is the user's file, not ours to
   * rewrite), and this card must be findable in the config beyond doubt — with
   * two identical cards and nothing to tell them apart, saving would move a lamp
   * on the wrong one.
   *
   * Returns whether the save was started; a rejection later is reported as a
   * toast, because by then the placement is on screen and the user must know it
   * did not stick.
   */
  private saveToDashboard(next: Floorplan3dCardConfig): boolean {
    const target = this.dashboardTarget();
    if (!target) return false;

    // Two lamps in a row: `saveConfig` is a round trip, and until it comes back
    // the dashboard still holds the config from before the first one — in which
    // this card no longer matches. So fall back to what we last sent, and the
    // second placement builds on the first instead of being dropped.
    let updated = substituteCard(target.host.config, target.matches, next);
    if (updated === null && this.sentDashboard !== null) {
      updated = substituteCard(this.sentDashboard, target.matches, next);
    }
    if (updated === null) return false;

    // Ours now, so the next placement finds this one and not the config we were
    // originally handed.
    this.rawConfig = next;
    this.sentDashboard = updated;
    // Chained rather than fired in parallel: two saves racing means the loser
    // silently wins the file.
    this.dashboardWrite = this.dashboardWrite
      .then(() => target.host.saveConfig(updated))
      .catch((err: unknown) => {
        this.hud?.toast({
          message: this.t('ui.placement.save_failed', 'Could not save to the dashboard: {error}', {
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      });
    return true;
  }

  /** The dashboard, if it is in a state where this card may write to it. */
  private dashboardTarget(): { host: LovelaceHost; matches: CardMatcher } | null {
    const host = findLovelaceHost(this);
    if (!host || host.editMode !== true) return null;
    if (host.mode !== undefined && host.mode !== 'storage') return null;
    const matches = cardMatcher(host.config, this.rawConfig, CARD_TYPE);
    return matches ? { host, matches } : null;
  }

  /** Whether a change made here survives a reload, by whichever route. */
  private configWritable(): boolean {
    return this.canPersistConfig() || this.dashboardTarget() !== null;
  }

  private isDuplicateAdd(entityId: string): boolean {
    const at = this.recentAdds.get(entityId);
    const now = Date.now();
    for (const [id, time] of this.recentAdds) {
      if (now - time > 1000) this.recentAdds.delete(id);
    }
    return at !== undefined && now - at < 1000;
  }

  private commitConfig(next: Floorplan3dCardConfig, options: { reload: boolean }): void {
    const normalised = normalizeConfig(next);
    this.config = normalised;
    const serialised = configKey(normalised);
    // Nothing changed — a section state re-applied on mount, or the echo of a
    // preset that carries the state it just restored. Emitting anyway marks
    // the config dirty in the editor and rewrites the user's YAML for nothing.
    if (serialised === this.lastEmitted) return;
    this.lastEmitted = serialised;
    // A host that declares itself persistent (the dev harness) listens to the
    // card directly and needs no bridge.
    let adopted = this.configPersistence === 'available';
    // The dashboard's own edit mode is where placing actually happens — the
    // card editor's preview is a postage stamp to work in. There the card
    // writes to the dashboard config itself.
    if (!adopted) adopted = this.saveToDashboard(normalised);
    if (!adopted && this.canPersistConfig()) {
      fireEvent(this, 'config-changed', { config: normalised });
      // The real channel. Lovelace's edit dialog listens to the *editor element*
      // for `config-changed` and ignores the card in its preview entirely, so the
      // event above reached nobody. Our editor hears this one, adopts the config
      // and re-emits it as its own — which the dialog does act on. Listeners run
      // synchronously, so `detail.adopted` tells us whether anyone was there.
      const detail: CardEditDetail = { config: normalised, adopted: false };
      document.dispatchEvent(new CustomEvent(CARD_EDIT_EVENT, { detail, composed: true }));
      adopted = adopted || detail.adopted;
    }
    if (!adopted && !this.warnedVolatile) {
      // Nobody took it: not a storage dashboard, not in edit mode, or this card
      // could not be told apart from another of its kind. The change applies to
      // what is on screen and is gone on the next reload — saying so once beats
      // letting someone place a houseful of lamps and lose them.
      this.warnedVolatile = true;
      this.hud?.toast({
        message: this.t(
          'ui.placement.hint_volatile',
          'Not saved. Placements are written to the dashboard while it is in edit mode — a YAML dashboard has to be edited by hand.',
        ),
      });
    }
    if (options.reload) void this.viewer?.updateConfig(normalised);
  }

  /**
   * Undo for placement is one config swap, and it turns drag & drop from
   * "careful" into "just try it".
   */
  private offerUndo(intent: EditIntent, label: string, previous: Floorplan3dCardConfig): void {
    const level =
      intent.kind === 'add-entity'
        ? this.levelName(intent.entity.level ?? null)
        : null;
    const message =
      intent.kind === 'remove-entity'
        ? this.t('ui.placement.removed', '{name} removed', { name: label })
        : this.t('ui.placement.placed', '{name} placed on {level}', {
            name: label,
            level: level ?? this.t('ui.placement.level_unknown', 'no level'),
          });

    this.hud?.toast({
      message,
      actionLabel: this.t('ui.action.undo', 'Undo'),
      action: () => this.commitConfig(previous, { reload: true }),
    });
  }

  /**
   * What the docked entities are doing, keyed by id.
   *
   * The same mapping the markers use, so a running script reads the same in the
   * panel as it would on the plan. Rebuilt per render: a handful of entities,
   * and `hass` changes under us constantly.
   */
  private shortcutVisuals(): Record<string, EntityVisualState> {
    const hass = this._hass;
    const items = this.config?.shortcuts ?? [];
    if (!hass || items.length === 0) return {};
    const out: Record<string, EntityVisualState> = {};
    for (const item of items) {
      const state = hass.states?.[item.entity];
      if (!state) continue;
      out[item.entity] = toEntityVisual(state, { entity: item.entity, position: [0, 0, 0] }, hass);
    }
    return out;
  }

  /** A docked entity is operated, never placed: tap runs it, hold explains it. */
  private runShortcut(entityId: string): void {
    const hass = this._hass;
    if (!hass) return;
    const item = this.config?.shortcuts?.find((entry) => entry.entity === entityId);
    void handleAction(this, hass, { entity: entityId, ...(item ?? {}) }, 'tap');
  }

  private t(key: string, fallback: string, params?: Record<string, string | number>): string {
    return localize(this._hass, key, fallback, params);
  }

  private entityLabel(entityId: string): string {
    const placed = this.config?.entities?.find((entry) => entry.entity === entityId);
    return placed?.name ?? getEntityName(this._hass, entityId);
  }

  private levelName(levelId: string | null): string | null {
    if (!levelId) return null;
    return this.levels.find((level) => level.id === levelId)?.name ?? levelId;
  }

  /* ------------------------------------------------------- drag & drop glue */

  /**
   * The mouse path. HTML5 drag & drop cannot read `dataTransfer` during
   * `dragover`, so the entity id arrives ahead of time on `fp3d-placement-begin`
   * and is only confirmed from the drop payload.
   */
  private bindDropTarget(host: HTMLElement): void {
    host.addEventListener('dragenter', this.onDragOver);
    host.addEventListener('dragover', this.onDragOver);
    host.addEventListener('dragleave', this.onDragLeave);
    host.addEventListener('drop', this.onDrop);
  }

  private unbindDropTarget(): void {
    const host = this.canvasHost;
    if (!host) return;
    host.removeEventListener('dragenter', this.onDragOver);
    host.removeEventListener('dragover', this.onDragOver);
    host.removeEventListener('dragleave', this.onDragLeave);
    host.removeEventListener('drop', this.onDrop);
    if (this.dragFrame) cancelAnimationFrame(this.dragFrame);
    this.dragFrame = 0;
  }

  private carriesEntity(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (types && Array.prototype.includes.call(types, ENTITY_DRAG_MIME)) return true;
    return this.dragEntityId !== null;
  }

  private readonly onDragOver = (event: DragEvent): void => {
    if (!this.editing || !this.carriesEntity(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.queuePlacementUpdate(event.clientX, event.clientY);
  };

  private readonly onDragLeave = (event: DragEvent): void => {
    const related = event.relatedTarget as Node | null;
    if (related && this.canvasHost?.contains(related)) return;
    this.cancelPlacement();
  };

  private readonly onDrop = (event: DragEvent): void => {
    if (!this.editing) return;
    event.preventDefault();
    const transferred =
      event.dataTransfer?.getData(ENTITY_DRAG_MIME) || event.dataTransfer?.getData('text/plain');
    const entityId = transferred || this.dragEntityId;
    if (!entityId) return;
    this.commitPlacement(entityId, event.clientX, event.clientY);
  };

  /** Coalesce to one raycast per frame; `dragover` fires far more often. */
  private queuePlacementUpdate(x: number, y: number): void {
    this.dragPoint = { x, y };
    if (this.dragFrame) return;
    this.dragFrame = requestAnimationFrame(() => {
      this.dragFrame = 0;
      const point = this.dragPoint;
      if (!point) return;
      this.withPlacement((placement) => placement.updatePlacement(point.x, point.y));
    });
  }

  /** `viewer.placement` throws before mount resolves; never let that escape. */
  private withPlacement<T>(fn: (placement: Viewer['placement']) => T): T | null {
    const viewer = this.viewer;
    if (!viewer?.isMounted) return null;
    try {
      return fn(viewer.placement);
    } catch {
      return null;
    }
  }

  private beginPlacement(entityId: string): void {
    this.dragEntityId = entityId;
    this.withPlacement((placement) => placement.beginPlacement(entityId));
  }

  private cancelPlacement(): void {
    if (!this.dragEntityId) return;
    this.dragEntityId = null;
    this.dragPoint = null;
    this.withPlacement((placement) => placement.cancelPlacement());
  }

  private commitPlacement(entityId: string, x: number, y: number): void {
    const result = this.withPlacement((placement) => placement.commitPlacement(x, y));
    this.dragEntityId = null;
    this.dragPoint = null;
    if (!result) {
      this.hud?.toast({
        message: this.t('ui.placement.hint_invalid', 'Drop on a surface of the house.'),
      });
      return;
    }

    const existing = this.config?.entities?.find((entry) => entry.entity === entityId);
    if (existing) {
      this.applyIntent(
        {
          kind: 'move-entity',
          entityId,
          position: vRound(result.position),
          level: result.levelId,
          room: result.room ?? undefined,
        },
        false,
      );
      return;
    }
    this.applyIntent(
      {
        kind: 'add-entity',
        entity: this.newPlacement(entityId, result.position, result.levelId, result.room),
      },
      false,
    );
    this.selectedEntity = entityId;
  }

  /** Sensible defaults so a dropped light lights the room without extra clicks. */
  private newPlacement(
    entityId: string,
    position: Vec3,
    levelId: string | null,
    room?: string | null,
  ): PlacedEntity {
    const level = levelId ?? suggestPlacementLevel(this._hass, entityId, this.levels);
    const placed: PlacedEntity = { entity: entityId, position: vRound(position), level };
    if (room) placed.room = room;
    if (domainOf(entityId) === 'light') {
      placed.light = { kind: 'point', distance: 6, fixture: { show: true } };
    }
    return placed;
  }

  /* ----------------------------------------------------------- local views */

  /** True inside the card editor's live preview, where a drop can be saved. */
  private inCardEditor(): boolean {
    return hasLovelaceEditorAncestor(this);
  }

  private canPersistConfig(): boolean {
    if (this.configPersistence !== 'auto') return this.configPersistence === 'available';
    return hasLovelaceEditorAncestor(this);
  }

  /** `<prefix><model+title>:<entities>`; see LOCAL_VIEWS_PREFIX. */
  private localViewsKeyParts(): { base: string; full: string } | null {
    const config = this.config;
    if (!config) return null;
    const model = config.model ?? {};
    const base = hash32(`${model.url ?? ''}|${config.title ?? ''}`);
    const entities = hash32(
      (config.entities ?? [])
        .map((entry) => entry.entity)
        .sort()
        .join(','),
    );
    return { base: `${LOCAL_VIEWS_PREFIX}${base}:`, full: `${LOCAL_VIEWS_PREFIX}${base}:${entities}` };
  }

  private readStore(key: string): CameraPreset[] | null {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const presets = (parsed as { presets?: unknown }).presets;
      return Array.isArray(presets) ? (presets as CameraPreset[]) : null;
    } catch {
      // Private browsing, quota, or somebody else's key. Not worth a message.
      return null;
    }
  }

  /**
   * Adding an entity changes the second half of the key, so an exact miss falls
   * back to any entry for the same model and re-homes it. Local views surviving
   * an edit is the whole point of storing them.
   */
  private loadLocalPresets(): void {
    const parts = this.localViewsKeyParts();
    if (!parts) return;
    this.localViewsKey = parts.full;

    let presets = this.readStore(parts.full);
    if (!presets) {
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith(parts.base) || key === parts.full) continue;
          const adopted = this.readStore(key);
          if (adopted?.length) {
            presets = adopted;
            localStorage.removeItem(key);
            break;
          }
        }
      } catch {
        /* storage unavailable */
      }
    }

    const next = presets ?? [];
    // Anything the user has since copied into the YAML is no longer local.
    const persisted = new Set((this.config?.presets ?? []).map((preset) => preset.id));
    const filtered = next.filter((preset) => !persisted.has(preset.id));
    if (filtered.length !== next.length) this.writeLocalPresets(filtered);
    else this.localPresets = filtered;
  }

  private writeLocalPresets(presets: CameraPreset[]): void {
    this.localPresets = presets;
    const key = this.localViewsKey;
    if (!key) return;
    try {
      if (presets.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ v: 1, presets }));
    } catch {
      /* nothing sensible to do; the view still works for this session */
    }
  }

  private isLocalPreset(presetId: string): boolean {
    return this.localPresets.some((preset) => preset.id === presetId);
  }

  private allPresets(): CameraPreset[] {
    return [...(this.config?.presets ?? []), ...this.localPresets, ...this.generatedPresets()];
  }

  /**
   * Views derived from the model rather than saved: the whole building, then a
   * plan per storey. One list, because anything that offers them has to be able
   * to *apply* them too — looked up in half of it, the Overview button was in
   * the bar and did nothing.
   */
  private generatedPresets(): CameraPreset[] {
    return [...this.overviewPreset(), ...this.levelPresets()];
  }

  /**
   * The whole house, and it stays put.
   *
   * Generated like the storey views and for the same reason: it is derived from
   * the model, so it is right about a house nobody has configured yet. It used
   * to step aside as soon as you saved a view of your own, on the theory that
   * your view was the better one — which took away the way back to the building
   * exactly when you had started collecting storey views.
   */
  private overviewPreset(): CameraPreset[] {
    if (this.config?.ui?.levelPresets === false) return [];

    const bounds = this.bounds;
    const spanX = bounds ? bounds.max[0] - bounds.min[0] : 12;
    const spanY = bounds ? bounds.max[1] - bounds.min[1] : 6;
    const spanZ = bounds ? bounds.max[2] - bounds.min[2] : 10;
    const centre: Vec3 = bounds
      ? [
          (bounds.max[0] + bounds.min[0]) / 2,
          (bounds.max[1] + bounds.min[1]) / 2,
          (bounds.max[2] + bounds.min[2]) / 2,
        ]
      : [0, 1.6, 0];
    const reach = Math.max(spanX, spanY, spanZ, 6) * 1.9;

    return [
      {
        id: OVERVIEW_PRESET_ID,
        name: this.t('ui.preset.overview', 'Overview'),
        icon: 'mdi:home',
        position: [centre[0] + reach * ISO, centre[1] + reach * ISO, centre[2] + reach * ISO],
        target: centre,
        visibleLevels: null,
        section: { ...JSON.parse(JSON.stringify(DEFAULT_SECTION_STATE)), mode: 'none' as const },
      },
    ];
  }

  /**
   * One plan view per detected storey, derived from the model instead of saved
   * by hand. The levels are already known — making the user re-create them as
   * presets is busywork, and a model with a storey added would leave the saved
   * ones stale.
   *
   * They are generated, so they are not editable, not draggable and never
   * written to the config; a saved view of the same storey simply sits earlier
   * in the bar and wins the default slot.
   */
  private levelPresets(): CameraPreset[] {
    if (this.config?.ui?.levelPresets === false) return [];
    const levels = this.levels;
    if (levels.length < 2) return [];

    const bounds = this.bounds;
    const spanX = bounds ? bounds.max[0] - bounds.min[0] : 12;
    const spanZ = bounds ? bounds.max[2] - bounds.min[2] : 10;
    const centreX = bounds ? (bounds.max[0] + bounds.min[0]) / 2 : 0;
    const centreZ = bounds ? (bounds.max[2] + bounds.min[2]) / 2 : 0;
    const span = Math.max(spanX, spanZ, 4);

    // Reuse the framing of a saved plan view when there is one, so the
    // generated views sit at the same zoom instead of jumping.
    const reference = (this.config?.presets ?? []).find((preset) => preset.orthoZoom);

    const reach = span * 2.2;

    return levels.map((level) => ({
      id: `${LEVEL_PRESET_PREFIX}${level.id}`,
      name: level.name,
      icon: level.icon,
      position: [centreX + reach * ISO, level.elevation + reach * ISO, centreZ + reach * ISO],
      // Aim slightly above the floor so the storey sits in the middle of the
      // frame rather than hanging off the bottom edge.
      target: [centreX, level.elevation + 1.2, centreZ],
      orthoZoom: reference?.orthoZoom,
      visibleLevels: [level.id],
      section: {
        ...JSON.parse(JSON.stringify(DEFAULT_SECTION_STATE)),
        // Generated views are still *your* views: the cut-cap preference from
        // the `section` block carries over, so there is one place to decide how
        // a storey is presented rather than two.
        caps: this.config?.section?.caps ?? DEFAULT_SECTION_STATE.caps,
        mode: 'level' as const,
        levelId: level.id,
      },
    }));
  }

  private isGeneratedPreset(presetId: string): boolean {
    return presetId.startsWith(LEVEL_PRESET_PREFIX) || presetId === OVERVIEW_PRESET_ID;
  }

  /**
   * The viewer only knows presets that are in its config, so a local one is
   * applied by hand — same coupling the viewer uses: section, then levels,
   * then the camera. A preset without a section resets it, so a view is always
   * a complete state.
   */
  private applyLocalPreset(preset: CameraPreset, animate: boolean): void {
    const viewer = this.viewer;
    if (!viewer) return;
    viewer.setSection(preset.section ?? { ...DEFAULT_SECTION_STATE }, animate);
    viewer.setVisibleLevels(preset.visibleLevels ?? null);
    try {
      void viewer.cameraCtl.applyPreset(preset, animate);
    } catch {
      /* camera subsystem is down; section and levels still applied */
    }
    this.activePreset = preset.id;
  }

  private presetYaml(preset: CameraPreset): string {
    return toYaml({ presets: [JSON.parse(JSON.stringify(preset)) as CameraPreset] });
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* not permitted without a user gesture on some browsers; fall through */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }

  /**
   * The honest half of "save". Lovelace will not take the write, so the view is
   * kept in this browser and the user is told, once, with the two things they
   * can actually do about it.
   */
  private saveLocalPreset(preset: CameraPreset): void {
    this.writeLocalPresets([...this.localPresets, preset]);
    this.activePreset = preset.id;
    this.hud?.toast({
      message: this.t(
        'ui.preset.saved_local',
        'Saved "{name}" in this browser — put the dashboard in edit mode to keep views in the card itself.',
        { name: preset.name },
      ),
      duration: 12000,
      actions: [
        {
          label: this.t('ui.preset.copy_yaml', 'Copy YAML'),
          icon: 'save',
          run: () => {
            void this.copyToClipboard(this.presetYaml(preset)).then((ok) => {
              this.hud?.toast({
                message: ok
                  ? this.t('ui.preset.copied', 'YAML copied — paste it under `presets:` in the card config.')
                  : this.t('ui.preset.copy_failed', 'Could not reach the clipboard.'),
              });
            });
          },
        },
        {
          label: this.t('ui.action.discard', 'Discard'),
          icon: 'trash',
          run: () => this.removeLocalPreset(preset.id),
        },
      ],
    });
  }

  private removeLocalPreset(presetId: string): void {
    this.writeLocalPresets(this.localPresets.filter((preset) => preset.id !== presetId));
    if (this.activePreset === presetId) this.activePreset = null;
  }

  /* --------------------------------------------------------- chrome events */

  private onSectionChange(section: SectionState, live: boolean): void {
    this.section = section;
    if (live) {
      this.viewer?.setSection(section, false);
      return;
    }
    this.viewer?.setSection(section, !this.prefersReducedMotion());
    this.applyIntent({ kind: 'set-section', section }, true);
  }

  /* --------------------------------------------------------------- tour */

  private get tourCfg(): Required<TourConfig> {
    return { ...DEFAULT_TOUR_CONFIG, ...(this.config?.tour ?? {}) };
  }

  /** Views the tour visits, in bar order. */
  private tourStops(): CameraPreset[] {
    const all = this.allPresets();
    if (this.tourCfg.include === 'all') return all;
    const tagged = all.filter((preset) => preset.inTour === true);
    // Tagging nothing and expecting nothing to happen is the surprising
    // reading; tagging nothing means "all of them".
    return tagged.length > 0 ? tagged : all;
  }

  private get tourAvailable(): boolean {
    return this.tourCfg.showControls !== false && this.tourStops().length > 1;
  }

  setTourPlaying(playing: boolean): void {
    this.clearTourTimers();
    this.tourPlaying = playing && this.tourStops().length > 1;
    if (this.tourPlaying) this.scheduleTourStep();
  }

  private scheduleTourStep(): void {
    if (!this.tourPlaying) return;
    const seconds = Math.max(3, this.tourCfg.interval);
    this.tourTimer = setTimeout(() => {
      this.tourTimer = null;
      const stops = this.tourStops();
      if (stops.length < 2) {
        this.tourPlaying = false;
        return;
      }
      const index = stops.findIndex((preset) => preset.id === this.activePreset);
      const next = stops[(index + 1 + stops.length) % stops.length];
      // Flag the change as ours so `pauseOnInteraction` does not read the
      // camera flight it just started as the user grabbing the camera. The
      // flag has to outlive the *whole* flight: `onChange` fires throttled for
      // its entire duration, and clearing early makes the tour pause itself on
      // its own first move.
      this.tourMoving = true;
      if (this.tourMoveTimer) clearTimeout(this.tourMoveTimer);
      const flightMs =
        (this.config?.camera?.transitionDuration ?? DEFAULT_CAMERA_CONFIG.transitionDuration) * 1000;
      this.tourMoveTimer = setTimeout(
        () => {
          this.tourMoveTimer = null;
          this.tourMoving = false;
        },
        flightMs + 400,
      );

      this.onPresetSelect(next.id);
      this.scheduleTourStep();
    }, seconds * 1000);
  }

  /** Called from the viewer's camera-change signal. */
  private onUserCameraInput(): void {
    if (this.tourMoving) return;
    const cfg = this.tourCfg;
    if (!cfg.pauseOnInteraction) return;
    const wasPlaying = this.tourPlaying;
    if (this.tourPlaying) {
      this.clearTourTimers();
      this.tourPlaying = false;
    }
    // Resume what was interrupted — nothing else. Scheduled unconditionally,
    // this started a tour on a card whose tour had never run: touch the camera
    // once, and a minute later the house began flying through its views on its
    // own, with `autoplay` off.
    if (wasPlaying && cfg.resumeAfter > 0) {
      if (this.tourResumeTimer) clearTimeout(this.tourResumeTimer);
      this.tourResumeTimer = setTimeout(() => {
        this.tourResumeTimer = null;
        this.setTourPlaying(true);
      }, cfg.resumeAfter * 1000);
    }
  }

  private clearTourTimers(): void {
    if (this.tourTimer) clearTimeout(this.tourTimer);
    if (this.tourResumeTimer) clearTimeout(this.tourResumeTimer);
    if (this.tourMoveTimer) clearTimeout(this.tourMoveTimer);
    this.tourTimer = null;
    this.tourResumeTimer = null;
    this.tourMoveTimer = null;
    this.tourMoving = false;
  }

  /**
   * Place an entity without dragging, by dropping it on whatever is in the
   * middle of the view. Dragging is precise but fiddly, and it is the only way
   * in at the moment — for "put this lamp roughly there, I will nudge it after"
   * a single click is the right amount of effort.
   */
  private quickAdd(entityId: string): void {
    const viewer = this.viewer;
    const host = this.canvasHost;
    if (!viewer || !host) return;

    const rect = host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    // Reuse the drop path so quick-add and drag & drop cannot drift apart:
    // same validity check, same toast, same move-instead-of-duplicate rule,
    // same selection afterwards.
    viewer.placement.beginPlacement(entityId);
    this.commitPlacement(entityId, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  private onZoomInput(value: number): void {
    this.zoom = value;
    this.viewer?.cameraCtl.setZoom01(value);
  }

  private onPresetSelect(presetId: string): void {
    const animate = !this.prefersReducedMotion();
    // Generated and browser-local views are unknown to the viewer's config, so
    // the card applies them by hand.
    const derived =
      this.localPresets.find((preset) => preset.id === presetId) ??
      (this.isGeneratedPreset(presetId)
        ? this.generatedPresets().find((preset) => preset.id === presetId)
        : undefined);
    if (derived) {
      this.applyLocalPreset(derived, animate);
      this.activePreset = presetId;
      return;
    }
    void this.viewer?.applyPreset(presetId, animate);
  }

  private onPresetSave(name: string): void {
    const viewer = this.viewer;
    if (!viewer) return;
    let preset: CameraPreset;
    try {
      preset = viewer.cameraCtl.capture(name);
    } catch {
      return;
    }
    // `capture()` reads the live OrbitControls rig — which is also what the
    // view cube drives — so a view saved after only spinning the cube is the
    // one on screen. Section and visible levels are the card's to add.
    preset.section = JSON.parse(JSON.stringify(this.section)) as SectionState;
    preset.visibleLevels = this.visibleLevels;

    if (!this.configWritable()) {
      this.saveLocalPreset(preset);
      return;
    }
    this.applyIntent({ kind: 'add-preset', preset }, false);
    this.activePreset = preset.id;
    this.hud?.toast({ message: this.t('ui.preset.saved', 'View "{name}" saved', { name }) });
  }


  private onEntityPatch(entityId: string, patch: Partial<PlacedEntity>): void {
    this.applyIntent({ kind: 'update-entity', entityId, patch }, false);
  }

  private onRetry(): void {
    this.teardownViewer();
    this.error = null;
    void this.mountViewer();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (this.dragEntityId) {
      this.cancelPlacement();
      event.stopPropagation();
      return;
    }
    if (this.selectedEntity) {
      this.selectedEntity = null;
      event.stopPropagation();
      return;
    }
    if (this.panel !== 'none') {
      this.panel = 'none';
      event.stopPropagation();
    }
  };

  /* ---------------------------------------------------------------- render */

  protected override render(): TemplateResult {
    const config = this.config;
    if (!config) return html`<div class="card"></div>`;

    const ui = config.ui ?? {};
    const showChrome = this.status === 'ready';
    const selected = this.selectedEntity
      ? (config.entities?.find((entry) => entry.entity === this.selectedEntity) ?? null)
      : null;

    return html`
      <div class="card" @keydown=${this.onKeyDown}>
        <div class="viewport">
          <div class="canvas-host"></div>
          <div class="vignette"></div>
          ${showChrome ? this.renderChrome(this.toolbarVisible(ui), selected) : nothing}
          ${this.status === 'loading' || this.status === 'idle'
            ? html`<fp3d-loading-overlay
                data-hass
                .dark=${this.dark}
                .progress=${this.progress}
              ></fp3d-loading-overlay>`
            : nothing}
          ${this.status === 'error' && this.error
            ? html`<fp3d-error-panel
                data-hass
                .dark=${this.dark}
                .error=${this.error}
                @fp3d-retry=${this.onRetry}
              ></fp3d-error-panel>`
            : nothing}
        </div>
      </div>
    `;
  }

  /**
   * One switch decides it, everywhere.
   *
   * A panel view used to hide the toolbar unless a second flag opted back in —
   * on the theory that a wall tablet wants only the saved views and the cube.
   * That made `showToolbar: true` a lie in exactly the layout a floorplan is
   * most likely to be given, and the flag that was supposed to fix it was never
   * read by the config schema, so setting it did nothing at all.
   */
  private toolbarVisible(ui: NonNullable<Floorplan3dCardConfig['ui']>): boolean {
    return toolbarVisible(ui);
  }

  /**
   * Where the orientation cube hangs. With a toolbar above it the cube has to
   * clear it; in a panel view there is no toolbar, and leaving the cube down
   * there both wasted the corner and had it sitting on top of the zoom control,
   * which reserves its strip in the chrome grid from the same two numbers.
   */
  private get canExplode(): boolean {
    return explodeAvailable(this.levels.length, this.section, this.visibleLevels);
  }

  /**
   * The zoom slider, and not on a phone unless asked for.
   *
   * It stands at the right edge, exactly where a thumb swipes to turn the
   * house, and a swipe that lands on it zooms instead — which reads as the card
   * doing something different every time. A pinch is the gesture there anyway.
   * `showZoomSlider: true` puts it back.
   */
  private zoomSliderVisible(ui: NonNullable<Floorplan3dCardConfig['ui']>): boolean {
    if (ui.showZoomSlider !== undefined) return ui.showZoomSlider;
    return this.layout !== 'narrow';
  }

  private placeViewCube(): void {
    const camera = this.viewer?.cameraCtl;
    if (!camera) return;
    camera.setViewCubeTopMargin(this.toolbarVisible(this.config?.ui ?? {}) ? 88 : 16);
  }

  /**
   * Why a control is on screen, on the debug channel.
   *
   * "The scissors are back" is a report nobody can act on: three settings and
   * three sources of edit mode feed that one boolean, and a screenshot shows
   * none of them. Printed once per change rather than per frame.
   */
  private explainChrome(
    ui: NonNullable<Floorplan3dCardConfig['ui']>,
    mode: 'auto' | 'never' | 'always',
    canSection: boolean,
  ): void {
    const line =
      `section=${canSection} authorTools=${mode} ` +
      `showSectionControls=${ui.showSectionControls ?? '(unset)'} ` +
      `editing=${this.editing} editMode=${this.editMode} ` +
      `inCardEditor=${this.inCardEditor()} ` +
      `dashboardEditMode=${findLovelaceHost(this)?.editMode ?? '(no dashboard)'}`;
    if (line === this.chromeExplained) return;
    this.chromeExplained = line;
    console.info('[floorplan-3d] %s', line);
  }

  private renderChrome(showToolbar: boolean, selected: PlacedEntity | null): TemplateResult {
    const config = this.config;
    const ui = config?.ui ?? {};
    const author = this.showAuthorTools;
    const mode = this.authorMode;
    // Opt-in only, and deliberately NOT tied to author mode: the lift panel is
    // a second way to do what a saved view already does, and having it appear
    // the moment you start editing is exactly the clutter we removed.
    // Opt-in only, and it does *not* return in edit mode: the preset bar is how
    // you reach a storey, and a second navigator beside it reads as exactly the
    // hierarchy the user asked us to remove.
    // On unless switched off: this panel *is* the card's navigation now — the
    // building, its storeys and your own saved views, in one list.
    const showLevels = levelSelectorVisible(ui);
    const showPalette = this.editing && this.panel === 'palette';
    const canSection = sectionButtonVisible(ui, mode, this.editing);
    if (ui.showFps === true) this.explainChrome(ui, mode, canSection);

    return html`
      <div
        class=${classMap({
          chrome: true,
          'no-toolbar': !showToolbar,
          'has-title': Boolean(config?.title),
        })}
      >
        ${config?.title
          ? html`<div class="at-topleft"><div class="title-chip">${config.title}</div></div>`
          : nothing}
        <div class="at-topright">
          ${showToolbar
            ? html`<fp3d-toolbar
                data-hass
                .dark=${this.dark}
                .size=${this.layout}
                .openPanel=${this.panel}
                .autoRotate=${this.autoRotate}
                .fullscreen=${this.fullscreen}
                .canSection=${canSection}
                .canExplode=${this.canExplode}
                .exploded=${this.exploded}
                .canTour=${this.tourAvailable}
                .tourPlaying=${this.tourPlaying}
                @fp3d-toolbar-action=${(event: CustomEvent<{ action: ToolbarAction }>) =>
                  this.onToolbarAction(event.detail.action)}
              ></fp3d-toolbar>`
            : nothing}
          ${this.zoomSliderVisible(ui)
            ? html`
                ${ui.showViewCube !== false ? html`<div class="cube-gap"></div>` : nothing}
                <div class="cube-column">
                  <fp3d-zoom-slider
                    data-hass
                    .dark=${this.dark}
                    .size=${this.layout}
                    .value=${this.zoom}
                    @fp3d-zoom=${(event: CustomEvent<{ value: number }>) =>
                      this.onZoomInput(event.detail.value)}
                  ></fp3d-zoom-slider>
                </div>
              `
            : nothing}
        </div>
        <div class="at-left">
          ${showPalette
            ? html`<div class="sheet">
                <fp3d-entity-palette
                data-hass
                .dark=${this.dark}
                .size=${this.layout}
                .placed=${config?.entities ?? []}
                .canPersist=${this.configWritable()}
                @fp3d-palette-close=${() => {
                  this.panel = 'none';
                }}
                @fp3d-placement-begin=${(event: CustomEvent<{ entityId: string }>) =>
                  this.beginPlacement(event.detail.entityId)}
                @fp3d-placement-move=${(event: CustomEvent<{ x: number; y: number }>) =>
                  this.queuePlacementUpdate(event.detail.x, event.detail.y)}
                @fp3d-placement-commit=${(event: CustomEvent<{ x: number; y: number }>) =>
                  this.dragEntityId &&
                  this.commitPlacement(this.dragEntityId, event.detail.x, event.detail.y)}
                @fp3d-placement-cancel=${() => this.cancelPlacement()}
                @fp3d-entity-focus=${(event: CustomEvent<{ entityId: string }>) => {
                  this.selectedEntity = event.detail.entityId;
                }}
                @fp3d-quick-add=${(event: CustomEvent<{ entityId: string }>) =>
                  this.quickAdd(event.detail.entityId)}
                @fp3d-entity-remove=${(event: CustomEvent<{ entityId: string }>) =>
                  this.applyIntent({ kind: 'remove-entity', entityId: event.detail.entityId }, false)}
              ></fp3d-entity-palette>
              </div>`
            : nothing}
          ${showLevels && !(showPalette && this.layout === 'narrow')
            ? html`<div class="rail">
              <fp3d-level-selector
                data-hass
                .dark=${this.dark}
                .size=${this.layout}
                .overview=${this.overviewPreset()}
                .levelViews=${this.levelPresets()}
                .presets=${[...(config?.presets ?? []), ...this.localPresets]}
                .activePresetId=${this.activePreset}
                .editMode=${this.editing}
                .canSave=${author}
                .collapsed=${this.levelsCollapsed}
                @fp3d-panel-collapse=${(event: CustomEvent<{ collapsed: boolean }>) => {
                  this.levelsCollapsed = event.detail.collapsed;
                  this.collapseChosen = true;
                }}
                @fp3d-preset-select=${(event: CustomEvent<{ presetId: string }>) =>
                  this.onPresetSelect(event.detail.presetId)}
                @fp3d-preset-save=${(event: CustomEvent<{ name: string }>) =>
                  this.onPresetSave(event.detail.name)}
                @fp3d-preset-patch=${(event: CustomEvent<{ presetId: string; patch: Partial<CameraPreset> }>) =>
                  this.applyIntent(
                    { kind: 'update-preset', presetId: event.detail.presetId, patch: event.detail.patch },
                    false,
                  )}
                @fp3d-preset-remove=${(event: CustomEvent<{ presetId: string }>) =>
                  this.isLocalPreset(event.detail.presetId)
                    ? this.removeLocalPreset(event.detail.presetId)
                    : this.applyIntent(
                        { kind: 'remove-preset', presetId: event.detail.presetId },
                        false,
                      )}
              ></fp3d-level-selector>
              <fp3d-action-dock
                data-hass
                .dark=${this.dark}
                .size=${this.layout}
                .items=${config?.shortcuts ?? []}
                .visuals=${this.shortcutVisuals()}
                .editMode=${this.editing}
                .collapsed=${this.dockCollapsed}
                @fp3d-dock-collapse=${(event: CustomEvent<{ collapsed: boolean }>) => {
                  this.dockCollapsed = event.detail.collapsed;
                  this.dockCollapseChosen = true;
                }}
                @fp3d-shortcut-add=${(event: CustomEvent<{ entityId: string }>) =>
                  this.applyIntent({ kind: 'add-shortcut', entityId: event.detail.entityId }, false)}
                @fp3d-shortcut-remove=${(event: CustomEvent<{ entityId: string }>) =>
                  this.applyIntent(
                    { kind: 'remove-shortcut', entityId: event.detail.entityId },
                    false,
                  )}
                @fp3d-shortcut-run=${(event: CustomEvent<{ entityId: string }>) =>
                  this.runShortcut(event.detail.entityId)}
              ></fp3d-action-dock>
            </div>`
            : nothing}
        </div>
        ${this.renderRightSheet(selected)}
        <div class="at-hud">
          <fp3d-hud
            data-hass
            .dark=${this.dark}
            .showStats=${ui.showFps === true}
            .getFps=${() => this.viewer?.fps ?? 0}
          ></fp3d-hud>
        </div>
      </div>
    `;
  }

  /** Section controls and the inspector share the right rail; selection wins. */
  private renderRightSheet(selected: PlacedEntity | null): TemplateResult | typeof nothing {
    const config = this.config;
    if (this.editing && selected) {
      return html`<div class="at-right sheet">
        <fp3d-entity-inspector
          data-hass
          .dark=${this.dark}
          .size=${this.layout}
          .entity=${selected}
          .levels=${this.levels}
          .presets=${this.allPresets()}
          @fp3d-entity-patch=${(event: CustomEvent<{ entityId: string; patch: Partial<PlacedEntity> }>) =>
            this.onEntityPatch(event.detail.entityId, event.detail.patch)}
          @fp3d-entity-remove=${(event: CustomEvent<{ entityId: string }>) =>
            this.applyIntent({ kind: 'remove-entity', entityId: event.detail.entityId }, false)}
          @fp3d-inspector-close=${() => {
            this.selectedEntity = null;
          }}
        ></fp3d-entity-inspector>
      </div>`;
    }

    if (this.panel !== 'section') return nothing;
    // The same rule as the button that opens it: a panel with no way to close it
    // is worse than no panel.
    if (!sectionPanelVisible(config?.ui ?? {}, this.authorMode, this.editing)) return nothing;
    return html`<div class="at-right sheet">
      <fp3d-section-panel
        data-hass
        .dark=${this.dark}
        .size=${this.layout}
        .section=${this.section}
        .levels=${this.levels}
        .bounds=${this.bounds}
        @fp3d-section-change=${(event: CustomEvent<{ section: SectionState; live: boolean }>) =>
          this.onSectionChange(event.detail.section, event.detail.live)}
        @fp3d-section-close=${() => {
          this.panel = 'none';
        }}
      ></fp3d-section-panel>
    </div>`;
  }

}
