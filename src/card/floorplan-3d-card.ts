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
import type { EditIntent, LoadedModel, ModelLoadProgress } from '@/engine/contracts';
import { Viewer, WebGLUnavailableError } from '@/engine/viewer';
import { handleAction, PRESET_EVENT } from '@/ha/actions';
import { ConfigError, normalizeConfig, stubConfig, validateConfig } from '@/ha/config-schema';
import { localize } from '@/ha/localize';
import { domainOf, getEntityName, suggestPlacementLevel } from '@/ha/registry';
import { readTheme } from '@/ha/theme';
import { toYaml } from '@/editor/yaml-preview';
import {
  CARD_TYPE,
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
import type { Fp3dHud } from '@/ui/hud';
import type { UiSize } from '@/ui/base-element';
import type { ToolbarAction } from '@/ui/toolbar';

import '@/ui/error-panel';
import '@/ui/loading-overlay';
import '@/ui/toolbar';
import '@/ui/preset-bar';
import '@/ui/zoom-slider';
import '@/ui/level-selector';
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
  let node: Node | null = start;
  for (let hops = 0; node && hops < 60; hops += 1) {
    const name = (node as Element).localName;
    if (typeof name === 'string') {
      if (name === 'hui-card-preview' || name === 'hui-dialog-edit-card') return true;
      if (name.startsWith('hui-') && name.includes('editor')) return true;
    }
    node = node.parentNode ?? (node as ShadowRoot).host ?? null;
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
  @state() private orthographic = false;
  @state() private autoRotate = false;
  @state() private fullscreen = false;
  @state() private editing = false;
  @property({ type: Boolean, reflect: true }) private dark = false;
  @state() private bounds: Bounds | null = null;
  /** Session-only preset thumbnails; see `capturePresetThumbnail`. */
  @state() private thumbnails: Record<string, string> = {};
  @state() private thumbnailsEnabled = false;
  /** Views saved while Lovelace would not take them. Browser-local. */
  @state() private localPresets: CameraPreset[] = [];
  @state() private tourPlaying = false;
  /** Mirrors the camera's 0..1 zoom so the slider tracks orbiting and presets. */
  @state() private zoom = 0.5;
  /** Storeys pulled apart. A view state, never written back to the config. */
  @state() private exploded = false;

  @query('.canvas-host') private canvasHost?: HTMLDivElement;
  @query('.card') private cardRoot?: HTMLDivElement;
  @query('fp3d-hud') private hud?: Fp3dHud;

  /* -------------------------------------------------------------- internals */

  private _hass?: HomeAssistant;
  private viewer: Viewer | null = null;
  private mounting = false;
  private resizeObserver: ResizeObserver | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: Array<() => void> = [];
  /** Serialised form of the config we last emitted, to ignore our own echo. */
  private lastEmitted = '';
  private dragEntityId: string | null = null;
  private dragFrame = 0;
  private dragPoint: { x: number; y: number } | null = null;
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
    let next: Floorplan3dCardConfig;
    try {
      next = validateConfig(config);
    } catch (err) {
      // Lovelace renders whatever we throw, so the message is the whole UI.
      const message = err instanceof ConfigError ? err.message : String(err);
      throw new Error(`${CARD_TYPE}: ${message}`);
    }

    const serialised = JSON.stringify(next);
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
      this.dark = readTheme(this, hass).isDark;
      // The 3D background is transparent, so anything the engine draws over the
      // card — edge lines above all — has to contrast with the dashboard, not
      // with the model.
      this.viewer?.setThemeDark(this.dark);
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
    window.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.removeEventListener(PRESET_EVENT, this.onPresetEvent as EventListener);
    this.clearTourTimers();
    this.tourPlaying = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

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
    void this.mountViewer();
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has('editMode') || changed.has('config')) {
      // `never` outranks the dashboard: no palette, no inspector, no gizmos,
      // even while Lovelace itself is in edit mode.
      if (this.authorMode === 'never') this.editing = false;
      else if (changed.has('editMode')) this.editing = this.editMode;
    }
    if (changed.has('editMode') && this.authorMode !== 'never') {
      // Entering the dashboard's edit mode should show the placement tools, not
      // just enable them silently.
      if (this.editMode) this.panel = 'palette';
    }
    if (changed.has('config')) this.loadLocalPresets();
    if (changed.has('editing')) {
      this.viewer?.setEditMode(this.editing);
      if (!this.editing) {
        this.selectedEntity = null;
        if (this.panel === 'palette') this.panel = 'none';
      }
    }
    if (changed.has('layout')) this.setAttribute('data-layout', this.layout);
    // Every update, not just when `config` or `isPanel` changed. Home Assistant
    // sets `isPanel` on its own schedule — sometimes before the module that
    // defines this element has even loaded — and a card that missed the memo
    // stays at its configured height in a view meant to be filled. Writing four
    // style properties is not worth the bookkeeping to avoid.
    this.applyHostSizing();
    this.placeViewCube();
    // setConfig can arrive after the first render (HA does this when a card is
    // created empty and configured afterwards); firstUpdated has been and gone.
    if (changed.has('config') && this.config && !this.viewer && this.isConnected) {
      void this.mountViewer();
    }
    if (this._hass) this.forwardHass(this._hass);
  }

  /** Height / aspect ratio live on the host so panel mode can fill the view. */
  private applyHostSizing(): void {
    const ui = this.config?.ui ?? {};
    const height = ui.height ?? '520px';
    const full = this.isPanel || height === '100%' || height === '100vh';
    this.toggleAttribute('full', full);
    this.toggleAttribute('aspect', !full && Boolean(ui.aspectRatio));
    if (ui.aspectRatio) this.style.setProperty('--fp3d-aspect', ui.aspectRatio.replace(':', ' / '));
    this.style.setProperty('--fp3d-card-height', full ? '100%' : height);
  }

  private observeSize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      const width = box?.width ?? 0;
      if (width <= 0) return;
      this.layout = width < NARROW_PX ? 'narrow' : width < MEDIUM_PX ? 'medium' : 'wide';
      // The renderer watches its own container, but the card is the element
      // whose box the dashboard changes — a view switching to panel, a sidebar
      // folding away. Telling the viewer here costs a measurement and closes
      // the gap where the card had grown and the canvas had not noticed.
      this.viewer?.resize();
    });
    this.resizeObserver.observe(this);
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
    const mode = this.authorMode;
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return this.editing;
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
      viewer.setEditMode(this.editing);
      if (this.autoRotate) viewer.cameraCtl.setAutoRotate(true);
      this.orthographic = viewer.cameraCtl.isOrthographic();
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
      case 'projection':
        if (!viewer) break;
        this.orthographic = !this.orthographic;
        viewer.cameraCtl.setOrthographic(this.orthographic, !this.prefersReducedMotion());
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
      case 'edit':
        this.editing = !this.editing;
        this.panel = this.editing ? 'palette' : 'none';
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
    const serialised = JSON.stringify(normalised);
    // Nothing changed — a section state re-applied on mount, or the echo of a
    // preset that carries the state it just restored. Emitting anyway marks
    // the config dirty in the editor and rewrites the user's YAML for nothing.
    if (serialised === this.lastEmitted) return;
    this.lastEmitted = serialised;
    // Outside the card editor the event is dropped on the floor anyway, and
    // firing it still costs a full normalise plus a chrome re-render — which a
    // slider drag would do once per frame.
    if (this.canPersistConfig()) {
      fireEvent(this, 'config-changed', { config: normalised });
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
   * The whole house, as the first thing in the bar.
   *
   * Generated like the storey views and for the same reason: it is derived from
   * the model, so it is right about a house nobody has configured yet — and
   * without it the bar offers every storey and no way back to the building.
   * A saved view of your own sits earlier in the bar and takes over the job.
   */
  private overviewPreset(): CameraPreset[] {
    if (this.config?.ui?.levelPresets === false) return [];
    if ((this.config?.presets ?? []).length > 0) return [];

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
    const reference = (this.config?.presets ?? []).find(
      (preset) => preset.orthographic && preset.orthoZoom,
    );

    const reach = span * 2.2;

    return levels.map((level) => ({
      id: `${LEVEL_PRESET_PREFIX}${level.id}`,
      name: level.name,
      icon: level.icon,
      position: [centreX + reach * ISO, level.elevation + reach * ISO, centreZ + reach * ISO],
      // Aim slightly above the floor so the storey sits in the middle of the
      // frame rather than hanging off the bottom edge.
      target: [centreX, level.elevation + 1.2, centreZ],
      orthographic: true,
      orthoZoom: reference?.orthoZoom,
      visibleLevels: [level.id],
      section: {
        ...JSON.parse(JSON.stringify(DEFAULT_SECTION_STATE)),
        // Generated views are still *your* views: the cut-cap and ghost
        // preferences from the `section` block carry over, so there is one
        // place to decide how a storey is presented rather than two.
        caps: this.config?.section?.caps ?? DEFAULT_SECTION_STATE.caps,
        ghostAbove: this.config?.section?.ghostAbove ?? DEFAULT_SECTION_STATE.ghostAbove,
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
        'Saved "{name}" in this browser — Lovelace only accepts views from the card editor.',
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
    if (this.tourPlaying) {
      this.clearTourTimers();
      this.tourPlaying = false;
    }
    if (cfg.resumeAfter > 0) {
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
    if (this.thumbnailsEnabled) {
      const thumb = this.capturePresetThumbnail();
      if (thumb) this.thumbnails = { ...this.thumbnails, [preset.id]: thumb };
    }

    if (!this.canPersistConfig()) {
      this.saveLocalPreset(preset);
      return;
    }
    this.applyIntent({ kind: 'add-preset', preset }, false);
    this.activePreset = preset.id;
    this.hud?.toast({ message: this.t('ui.preset.saved', 'View "{name}" saved', { name }) });
  }

  /**
   * The renderer runs with `preserveDrawingBuffer: false` (the right default —
   * it costs memory bandwidth on every frame), so the only safe way to read
   * pixels is to draw and copy inside the same task.
   *
   * The result is kept in memory rather than in the config: `CameraPreset` has
   * no field for it, and a base64 blob has no business in a hand-edited YAML.
   */
  private capturePresetThumbnail(): string | null {
    const ctx = this.viewer?.ctx;
    if (!ctx) return null;
    try {
      ctx.renderer.render(ctx.scene, ctx.activeCamera);
      const source = ctx.renderer.domElement;
      const width = 96;
      const height = Math.max(1, Math.round((source.height / source.width) * width));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(source, 0, 0, width, height);
      const url = canvas.toDataURL('image/jpeg', 0.6);
      return url.length > 200 ? url : null;
    } catch {
      return null;
    }
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
    return ui.showToolbar !== false;
  }

  /**
   * Where the orientation cube hangs. With a toolbar above it the cube has to
   * clear it; in a panel view there is no toolbar, and leaving the cube down
   * there both wasted the corner and had it sitting on top of the zoom control,
   * which reserves its strip in the chrome grid from the same two numbers.
   */
  private placeViewCube(): void {
    const camera = this.viewer?.cameraCtl;
    if (!camera) return;
    camera.setViewCubeTopMargin(this.toolbarVisible(this.config?.ui ?? {}) ? 88 : 16);
  }

  private renderChrome(showToolbar: boolean, selected: PlacedEntity | null): TemplateResult {
    const config = this.config;
    const ui = config?.ui ?? {};
    const presets = this.allPresets();
    const author = this.showAuthorTools;
    const mode = this.authorMode;
    // The edit toggle is how an admin *enters* author mode, so it cannot be
    // gated on author mode already being visible — only on `never`.
    const canEdit = mode !== 'never' && (this.editMode || this._hass?.user?.is_admin === true);
    // Opt-in only, and deliberately NOT tied to author mode: the lift panel is
    // a second way to do what a saved view already does, and having it appear
    // the moment you start editing is exactly the clutter we removed.
    // Opt-in only, and it does *not* return in edit mode: the preset bar is how
    // you reach a storey, and a second navigator beside it reads as exactly the
    // hierarchy the user asked us to remove.
    // On unless switched off: this panel *is* the card's navigation now — the
    // building, its storeys and your own saved views, in one list.
    const showLevels = ui.showLevelSelector !== false;
    const canSection = mode !== 'never' && (ui.showSectionControls === true || author);

    return html`
      <div class=${classMap({ chrome: true, 'no-toolbar': !showToolbar })}>
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
                .orthographic=${this.orthographic}
                .autoRotate=${this.autoRotate}
                .fullscreen=${this.fullscreen}
                .editing=${this.editing}
                .canEdit=${canEdit}
                .canSection=${canSection}
                .canExplode=${this.levels.length > 1}
                .exploded=${this.exploded}
                .canTour=${this.tourAvailable}
                .tourPlaying=${this.tourPlaying}
                .sectionActive=${this.section.mode !== 'none'}
                @fp3d-toolbar-action=${(event: CustomEvent<{ action: ToolbarAction }>) =>
                  this.onToolbarAction(event.detail.action)}
              ></fp3d-toolbar>`
            : nothing}
          ${ui.showZoomSlider !== false
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
        ${showLevels && this.panel !== 'palette'
          ? html`<div class="at-left">
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
            </div>`
          : nothing}
        ${this.renderRightSheet(selected)}
        ${this.editing && this.panel === 'palette'
          ? html`<div class="at-left sheet">
              <fp3d-entity-palette
                data-hass
                .dark=${this.dark}
                .size=${this.layout}
                .placed=${config?.entities ?? []}
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
        ${ui.showPresetBar === true && (presets.length > 0 || author)
          ? html`<div class="at-bottom">
              <fp3d-preset-bar
                data-hass
                .dark=${this.dark}
                .size=${this.layout}
                .presets=${presets}
                .activeId=${this.activePreset}
                .editMode=${this.editing}
                .canSave=${author}
                .localIds=${this.localPresets.map((preset) => preset.id)}
                .thumbnails=${this.thumbnails}
                .thumbnailsEnabled=${this.thumbnailsEnabled}
                .tourControls=${this.tourCfg.showControls !== false}
                .generatedIds=${this.levelPresets().map((preset) => preset.id)}
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
                @fp3d-preset-move=${(event: CustomEvent<{ presetId: string; toIndex: number }>) =>
                  this.reorderPreset(event.detail.presetId, event.detail.toIndex)}
                @fp3d-thumbnails=${(event: CustomEvent<{ enabled: boolean }>) => {
                  this.thumbnailsEnabled = event.detail.enabled;
                }}
              ></fp3d-preset-bar>
            </div>`
          : nothing}
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
    const ui = config?.ui ?? {};
    if (this.authorMode === 'never') return nothing;
    if (ui.showSectionControls !== true && !this.showAuthorTools) return nothing;
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

  private reorderPreset(presetId: string, toIndex: number): void {
    if (this.isLocalPreset(presetId)) return;
    const config = this.config;
    const presets = [...(config?.presets ?? [])];
    const from = presets.findIndex((entry) => entry.id === presetId);
    if (from < 0 || toIndex < 0 || toIndex >= presets.length || from === toIndex) return;
    const [moved] = presets.splice(from, 1);
    presets.splice(toIndex, 0, moved);
    this.commitConfig({ ...(config as Floorplan3dCardConfig), presets }, { reload: false });
  }
}
