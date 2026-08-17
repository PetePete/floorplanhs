/**
 * The Viewer wires the whole engine together: it owns the RenderContext,
 * constructs every subsystem, drives the frame and translates card-level calls
 * (config / hass / edit mode) into subsystem calls.
 *
 * Two design rules dominate this file:
 *
 *  1. A broken subsystem must never take the card down. Every `init`, `update`
 *     and cross-subsystem call goes through a guard that disables just that
 *     subsystem and emits `error`.
 *  2. `updateHass` runs on every single HA state push, on every dashboard, all
 *     day. It must do nothing at all when nothing changed.
 */

import * as THREE from 'three';
import {
  DEFAULT_RENDER_CONFIG,
  DEFAULT_SECTION_STATE,
  type CameraPreset,
  type Floorplan3dCardConfig,
  type LevelDefinition,
  type PlacedEntity,
  type RenderConfig,
  type SectionState,
  type Vec3,
} from '@/types/config';
import type { HassEntity, HomeAssistant } from '@/types/hass';
import type {
  ICameraController,
  IEntityLayer,
  ILightingSystem,
  IModelManager,
  IPlacementController,
  IPostFx,
  ISectionController,
  IViewer,
  RenderContext,
  Subsystem,
  ViewerEventName,
  ViewerEvents,
} from '@/engine/contracts';
import { Emitter } from '@/util/events';
import { vRound } from '@/util/math';
import { EdgeOverlay } from '@/engine/model/edge-overlay';
import type { RoomFillSource } from '@/engine/lighting/room-fill';
import { RenderCore, WebGLUnavailableError } from '@/engine/core/render-core';
import { RenderLoop } from '@/engine/core/render-loop';
import { resolveBackground } from '@/engine/core/background';
import { ModelManager } from '@/engine/model/model-manager';
import { SectionController } from '@/engine/section/section-controller';
import { CameraController } from '@/engine/camera/camera-controller';
import { LightingSystem } from '@/engine/lighting/lighting-system';
import { PostFx } from '@/engine/lighting/post-fx';
import { EntityLayer } from '@/engine/entities/entity-layer';
import { PlacementController } from '@/engine/interaction/placement-controller';
import { PointerRouter } from '@/engine/interaction/pointer-router';
import { toEntityVisual, toLightSample } from '@/ha/state-mapper';

export { WebGLUnavailableError } from '@/engine/core/render-core';

type SubsystemName =
  | 'model'
  | 'section'
  | 'camera'
  | 'lighting'
  | 'postfx'
  | 'entities'
  | 'placement'
  | 'pointer';

/** Optional capability: subsystems that dress differently while editing. */
interface EditAware {
  setEditMode?(enabled: boolean): void;
}

/** Optional capability: a camera controller that can be reconfigured live. */
interface Reconfigurable {
  setConfig?(config: Floorplan3dCardConfig['camera']): void;
}

const ORIGIN = new THREE.Vector3();

/** How long the cut-plane handles stay up after the last section change. */
const HANDLE_LINGER_MS = 1400;

/** Edge-line ink. Not pure black/white — both read as harsh against a render. */
const EDGE_INK_ON_DARK = '#d6dbe2';
const EDGE_INK_ON_LIGHT = '#1b1f24';

export class Viewer implements IViewer {
  private readonly emitter = new Emitter<ViewerEvents>();
  private readonly failed = new Set<SubsystemName>();
  /** Last `HassEntity` object seen per placed entity — see updateHass. */
  private readonly prevStates = new Map<string, HassEntity | undefined>();

  private config: Floorplan3dCardConfig = { type: 'floorplan-3d-card' };
  private renderCfg: Required<RenderConfig> = { ...DEFAULT_RENDER_CONFIG };

  private core: RenderCore | null = null;
  private loop: RenderLoop | null = null;
  private unsubResize: (() => void) | null = null;

  private _model: IModelManager | null = null;
  private _section: ISectionController | null = null;
  private _cameraCtl: ICameraController | null = null;
  private _lighting: ILightingSystem | null = null;
  private _postFx: IPostFx | null = null;
  private _entities: IEntityLayer | null = null;
  private _placement: IPlacementController | null = null;
  private _pointer: Subsystem | null = null;

  private hass: HomeAssistant | null = null;
  private prevSun: HassEntity | undefined = undefined;
  private daylightApplied = false;
  private editMode = false;
  private mounted = false;
  private disposed = false;

  /* ------------------------------------------------------------ accessors */

  get ctx(): RenderContext | null {
    return this.core;
  }

  get model(): IModelManager {
    return this.require(this._model, 'model');
  }

  get section(): ISectionController {
    return this.require(this._section, 'section');
  }

  get cameraCtl(): ICameraController {
    return this.require(this._cameraCtl, 'camera');
  }

  get lighting(): ILightingSystem {
    return this.require(this._lighting, 'lighting');
  }

  get entities(): IEntityLayer {
    return this.require(this._entities, 'entities');
  }

  get placement(): IPlacementController {
    return this.require(this._placement, 'placement');
  }

  /** Smoothed fps for the optional overlay; 0 before mount. */
  get fps(): number {
    return this.loop?.fps ?? 0;
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  get isEditMode(): boolean {
    return this.editMode;
  }

  /** Subsystems that failed to start; the card can grey out their controls. */
  get disabledSubsystems(): readonly string[] {
    return [...this.failed];
  }

  on<K extends ViewerEventName>(event: K, cb: (payload: ViewerEvents[K]) => void): () => void {
    return this.emitter.on(event, cb);
  }

  /* ---------------------------------------------------------------- mount */

  async mount(container: HTMLElement, config: Floorplan3dCardConfig): Promise<void> {
    if (this.disposed) throw new Error('Viewer has been disposed');
    if (this.mounted) throw new Error('Viewer is already mounted');

    this.config = cloneConfig(config);
    const rawRender = this.config.render ?? {};
    this.renderCfg = { ...DEFAULT_RENDER_CONFIG, ...rawRender };

    this.emit('load-progress', { phase: 'prepare', message: 'Starting renderer' });

    try {
      this.core = new RenderCore({
        container,
        render: rawRender,
        camera: this.config.camera,
        themeDark: this.themeDark,
        onContextLost: () =>
          this.emitError('The 3D view lost its graphics context and is being restored'),
        onContextRestored: () => this.core?.invalidate(),
      });
    } catch (err) {
      const message =
        err instanceof WebGLUnavailableError
          ? 'This browser cannot render 3D content (WebGL2 unavailable)'
          : 'The 3D renderer could not start';
      this.emitError(message, err);
      this.emit('load-progress', { phase: 'error', message });
      throw err;
    }

    this.mounted = true;
    const ctx: RenderContext = this.core;

    this.loop = new RenderLoop(ctx, {
      fpsLimit: this.renderCfg.fpsLimit,
      onDemand: this.renderCfg.onDemand,
    });
    this.core.attachScheduler(this.loop);
    this.loop.setFrameCallback(this.onFrame);
    this.unsubResize = this.core.onResize(this.handleResize);

    this.constructSubsystems();
    this.initSubsystems(ctx);

    // Rule 7: the shell paints immediately, the model streams in behind it.
    this.loop.start();
    this.pushRenderSettings();
    this.pushCameraSettings();

    await this.loadModel();
    if (this.disposed) return;

    this.guard('entities', this._entities, (s) => s.setEntities(this.config.entities ?? []));
    this.guard('section', this._section, (s) =>
      s.setState(this.config.section ?? { ...DEFAULT_SECTION_STATE }, false),
    );

    await this.applyInitialViewpoint();
    if (this.disposed) return;

    // The card usually pushes hass before mount() resolves; replay it now that
    // the subsystems exist.
    if (this.hass) this.updateHass(this.hass);

    this.emit('load-progress', { phase: 'done' });
    this.emit('ready', undefined);
    this.core.invalidate();
  }

  private constructSubsystems(): void {
    this._model = new ModelManager();
    this._section = new SectionController();
    this._cameraCtl = new CameraController(this.config.camera ?? {});
    this._lighting = new LightingSystem(this.renderCfg);
    this._postFx = new PostFx(this.renderCfg);
    this._entities = new EntityLayer();
    this._placement = new PlacementController(this._model, this._entities, this._cameraCtl);
    this._pointer = new PointerRouter(
      this._entities,
      this._placement,
      this._cameraCtl,
      this.emitter,
    );
  }

  private initSubsystems(ctx: RenderContext): void {
    for (const [name, subsystem] of this.registry()) {
      if (!subsystem) continue;
      try {
        subsystem.init(ctx);
      } catch (err) {
        this.disable(name, `Subsystem "${name}" failed to initialise`, err);
      }
    }
  }

  /** Cross-subsystem subscriptions are set up once, on the first model load. */
  private wired = false;
  private readonly unwire: Array<() => void> = [];
  private handleHideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly edges = new EdgeOverlay();
  /** Mirrors the dashboard theme; the card pushes it. See `setThemeDark`. */
  private themeDark = true;

  /**
   * The card owns the theme (it can read HA's CSS custom properties; the engine
   * cannot). Anything the engine draws that has to contrast with the *page*
   * rather than with the model depends on this.
   */
  setThemeDark(dark: boolean): void {
    if (this.themeDark === dark) return;
    this.themeDark = dark;
    this.core?.setThemeDark(dark);
    if (this.mounted) this.applyRenderStyle();
  }

  /** Dependency order: everything before the things that depend on it. */
  private registry(): Array<[SubsystemName, Subsystem | null]> {
    return [
      ['model', this._model],
      ['section', this._section],
      ['camera', this._cameraCtl],
      ['lighting', this._lighting],
      ['postfx', this._postFx],
      ['entities', this._entities],
      ['placement', this._placement],
      ['pointer', this._pointer],
    ];
  }

  private async loadModel(): Promise<void> {
    const manager = this._model;
    const core = this.core;
    if (!manager || !core || this.failed.has('model')) return;

    const previousRoot = manager.model?.root ?? null;
    try {
      const loaded = await manager.load(this.config.model ?? {}, (progress) =>
        this.emit('load-progress', progress),
      );
      if (this.disposed) return;

      // The ModelManager may already have parented the result; only adopt it
      // when it did not, so we never end up with two houses in the scene.
      if (previousRoot && previousRoot !== loaded.root && previousRoot.parent === core.modelRoot) {
        previousRoot.removeFromParent();
      }
      if (!loaded.root.parent) core.modelRoot.add(loaded.root);

      this.guard('section', this._section, (s) => {
        s.setBounds(loaded.bounds);
        // Without the storey list, `level` mode has nothing to isolate.
        s.setLevels(loaded.levels);
      });
      this.guard('camera', this._cameraCtl, (c) => c.setBounds(loaded.bounds));

      // Markers that name a room draw a leader back to it, so they need to know
      // where the rooms are before the first frame.
      this.guard('entities', this._entities, (e) => e.setRoomAnchors(roomAnchors(loaded.root)));

      // Room-fill lighting indexes the rooms and stamps the geometry, so it has
      // to see the model before the first frame is drawn with it.
      this.guard('lighting', this._lighting, (l) =>
        (
          l as ILightingSystem & {
            setModel?(root: THREE.Object3D, levels: readonly LevelDefinition[]): void;
          }
        ).setModel?.(loaded.root, loaded.levels),
      );

      // Edge lines are parented under the model root on purpose: they must be
      // cut by the section planes exactly like the walls they trace.
      // Before `build`, so every edge geometry is stamped with its room as it
      // is created rather than needing a second pass.
      this.guard('lighting', this._lighting, (l) => {
        const lighting = l as ILightingSystem & {
          fillSource?: RoomFillSource;
          setFillListener?(cb: (() => void) | null): void;
        };
        if (lighting.fillSource) this.edges.setRoomSource(lighting.fillSource);
        lighting.setFillListener?.(() => this.edges.refreshRoomColors());
      });

      this.edges.build(loaded.root, core.clippingPlanes);
      if (!this.edges.object.parent) core.modelRoot.add(this.edges.object);
      this.applyRenderStyle();

      core.markShadowsDirty();
      this.wireSubsystems();
      this.emit('model-loaded', loaded);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Model failed to load';
      this.emitError(`Model failed to load: ${message}`, err);
      this.emit('load-progress', { phase: 'error', message });
    }
  }

  /**
   * Subscriptions that cross subsystem boundaries. Set up after the first
   * successful load, because before that the section controller has no bounds
   * and the camera has nothing to return to.
   */
  private wireSubsystems(): void {
    if (this.wired) return;
    const section = this._section;
    const camera = this._cameraCtl;
    if (!section || !camera) return;
    this.wired = true;

    // Dragging a cut plane must not also orbit the camera.
    this.unwire.push(
      section.onHandleDragStart(() => camera.setEnabled(false)),
      section.onHandleDragEnd(() => camera.setEnabled(true)),
      section.onChange((state) => {
        // Cut planes move geometry out of the shadow casters.
        this.core?.markShadowsDirty();
        this.flashSectionHandles();
        this.config = { ...this.config, section: state };
        this.emit('section-changed', state);
        this.emit('edit-intent', { kind: 'set-section', section: state });
      }),
    );

    // Dragging an existing marker inside the canvas is an edit like any other;
    // without this it would look like it worked and silently revert on the next
    // config round-trip. Palette drops are raised by the card itself, so only
    // moves are emitted here.
    const placement = this._placement;
    if (placement) {
      this.unwire.push(
        placement.on('placement-commit', ({ entityId, mode, result }) => {
          this.core?.markShadowsDirty();
          if (mode !== 'move') return;
          this.emit('edit-intent', {
            kind: 'move-entity',
            entityId,
            position: vRound(result.position),
            level: result.levelId,
          });
        }),
      );
    }

    camera.setDefaultPreset(this.findDefaultPreset());
  }

  /** Default preset if there is one, otherwise frame whatever we loaded. */
  private async applyInitialViewpoint(): Promise<void> {
    const preset = this.findDefaultPreset();
    if (preset) {
      await this.applyPresetInternal(preset, false, false);
      return;
    }
    const bounds = this._model?.model?.bounds;
    if (bounds) this.guard('camera', this._cameraCtl, (c) => c.frameObject(bounds, false));
  }

  private findDefaultPreset(): CameraPreset | null {
    const presets = this.config.presets ?? [];
    return presets.find((p) => p.default) ?? presets[0] ?? null;
  }

  /* ---------------------------------------------------------------- frame */

  private readonly onFrame = (dt: number, ctx: RenderContext): void => {
    const core = this.core;
    if (!core || !core.canRender) return;

    core.applyShadowUpdate();

    // Camera first: everything else positions itself relative to the view.
    this.tick('camera', this._cameraCtl, dt, ctx);
    this.syncCameraRig(core);

    this.tick('model', this._model, dt, ctx);
    this.tick('section', this._section, dt, ctx);
    this.tick('lighting', this._lighting, dt, ctx);
    this.tick('entities', this._entities, dt, ctx);
    this.tick('placement', this._placement, dt, ctx);
    this.tick('pointer', this._pointer, dt, ctx);

    // Always through the post-processing chain, at every quality tier. It is
    // what applies tone mapping and the sRGB encode to the whole frame; render
    // straight to the canvas instead and every material that opts out of tone
    // mapping comes out brighter, so the card visibly changed appearance with
    // the quality setting. PostFx itself decides whether bloom is affordable.
    const postFx = this._postFx;
    try {
      if (postFx && !this.failed.has('postfx')) {
        try {
          postFx.render(dt);
          return;
        } catch (err) {
          this.disable('postfx', 'Post-processing failed; falling back to direct rendering', err);
        }
      }
      core.renderer.render(core.scene, core.activeCamera);
    } finally {
      // The ViewCube lives in its own scene and is scissored into a corner
      // after everything else, so bloom, tone mapping and the section clipping
      // planes cannot touch it. It must run on the postfx path too, hence the
      // `finally` around the early return above.
      this.guard('camera', this._cameraCtl, (c) =>
        (c as ICameraController & { renderOverlay?(): void }).renderOverlay?.(),
      );
    }
  };

  private syncCameraRig(core: RenderCore): void {
    if (!this._cameraCtl || this.failed.has('camera')) {
      core.syncCameras(ORIGIN);
      return;
    }
    try {
      core.setOrthographic(this._cameraCtl.isOrthographic());
      core.syncCameras(this._cameraCtl.controls.target);
    } catch (err) {
      this.disable('camera', 'Camera controller failed', err);
      core.syncCameras(ORIGIN);
    }
  }

  private readonly handleResize = (width: number, height: number): void => {
    for (const [name, subsystem] of this.registry()) {
      if (!subsystem?.resize || this.failed.has(name)) continue;
      try {
        subsystem.resize(width, height);
      } catch (err) {
        this.disable(name, `Subsystem "${name}" failed on resize`, err);
      }
    }
  };

  resize(): void {
    this.core?.resize();
  }

  /* --------------------------------------------------------------- config */

  async updateConfig(config: Floorplan3dCardConfig): Promise<void> {
    const previous = this.config;
    const next = cloneConfig(config);
    this.config = next;

    if (!this.core || !this.mounted || this.disposed) return;

    const renderChanged = !deepEqual(previous.render, next.render);
    const cameraChanged = !deepEqual(previous.camera, next.camera);
    const modelChanged = !deepEqual(previous.model, next.model);
    const entitiesChanged = !deepEqual(previous.entities, next.entities);
    const sectionChanged = !deepEqual(previous.section, next.section);
    // `ui` is mostly the card's own DOM, but three of its flags are engine-side
    // — ghosted storeys, the orientation cube and marker depth testing — and
    // without this diff they were only ever picked up when something in the
    // `render` block happened to change alongside them.
    const uiChanged = !deepEqual(previous.ui, next.ui);

    if (renderChanged) {
      this.renderCfg = { ...DEFAULT_RENDER_CONFIG, ...(next.render ?? {}) };
      this.core.applyRenderConfig(next.render ?? {});
      this.loop?.setFpsLimit(this.renderCfg.fpsLimit);
      this.loop?.setOnDemand(this.renderCfg.onDemand);
      this.pushRenderSettings();
    }

    if (renderChanged || uiChanged) this.applyRenderStyle();

    if (cameraChanged) this.pushCameraSettings();

    // Every field of ModelConfig (url, demo, scale, rotation, offset, levels,
    // glassNodes, dracoPath) changes the loaded result, so any diff means a
    // reload. Nothing else in this method rebuilds anything.
    if (modelChanged) {
      await this.loadModel();
      if (this.disposed) return;
      const section = this.config.section ?? { ...DEFAULT_SECTION_STATE };
      this.guard('section', this._section, (s) => s.setState(section, false));
    } else if (sectionChanged && next.section) {
      const section = next.section;
      this.guard('section', this._section, (s) => s.setState(section, true));
    }

    if (entitiesChanged || modelChanged) {
      this.applyEntities(previous.entities ?? [], next.entities ?? []);
    }

    this.core.invalidate();
  }

  /** Push render settings that live inside subsystems rather than the core. */
  private pushRenderSettings(): void {
    const settings = this.core?.qualitySettings;
    const bloom = this.renderCfg.bloom && settings?.bloom !== false;
    this.guard('postfx', this._postFx, (fx) => {
      fx.setExposure(this.renderCfg.exposure);
      fx.setBloom(
        bloom,
        this.renderCfg.bloomStrength,
        this.renderCfg.bloomRadius,
        this.renderCfg.bloomThreshold,
      );
    });
    this.guard('lighting', this._lighting, (l) => {
      l.setShadowsEnabled(settings?.shadows ?? this.renderCfg.shadows);
      if (!this.renderCfg.daylight) {
        l.setDaylight(0, 0, false);
        this.daylightApplied = false;
        this.prevSun = undefined;
      }
    });
    if (this.renderCfg.daylight && this.hass) {
      this.daylightApplied = false;
      this.syncDaylight(this.hass);
    }
  }

  private pushCameraSettings(): void {
    const cameraConfig = this.config.camera ?? {};
    this.guard('camera', this._cameraCtl, (c) => {
      (c as ICameraController & Reconfigurable).setConfig?.(cameraConfig);
      c.setAutoRotate(cameraConfig.autoRotate === true);
    });
  }

  private applyEntities(previous: PlacedEntity[], next: PlacedEntity[]): void {
    const nextIds = new Set(next.map((e) => e.entity));
    for (const entity of previous) {
      if (nextIds.has(entity.entity)) continue;
      this.guard('lighting', this._lighting, (l) => l.removeLight(entity.entity));
    }
    // A changed marker/light config has to be re-applied even when the HA
    // state object itself is untouched, so drop the identity cache wholesale.
    this.prevStates.clear();
    this.guard('entities', this._entities, (e) => e.setEntities(next));
    if (this.hass) this.updateHass(this.hass);
  }

  /* ----------------------------------------------------------------- hass */

  /**
   * HA replaces the `HassEntity` object whenever anything about the entity
   * changes and keeps the same reference otherwise, so identity comparison is
   * a complete and essentially free dirty check.
   */
  updateHass(hass: HomeAssistant): void {
    this.hass = hass;
    if (!this.core || !this.mounted || this.disposed) return;

    let changed = false;
    for (const placed of this.config.entities ?? []) {
      const state = hass.states[placed.entity];
      if (this.prevStates.has(placed.entity) && this.prevStates.get(placed.entity) === state) {
        continue;
      }
      this.prevStates.set(placed.entity, state);
      this.syncEntity(placed, state, hass);
      changed = true;
    }

    if (this.syncDaylight(hass)) changed = true;
    // Only a real state change can alter a shadow map; camera movement cannot.
    if (changed) this.core.markShadowsDirty();
  }

  private syncEntity(placed: PlacedEntity, state: HassEntity | undefined, hass: HomeAssistant): void {
    if (!state) {
      this.guard('lighting', this._lighting, (l) => l.removeLight(placed.entity));
      this.guard('entities', this._entities, (e) =>
        e.updateVisual(placed.entity, {
          entityId: placed.entity,
          state: 'unavailable',
          active: false,
          label: placed.name ?? placed.entity,
          icon: placed.marker?.icon ?? 'mdi:help-circle-outline',
          color: placed.marker?.color ?? '#8a8f98',
          unavailable: true,
        }),
      );
      return;
    }

    if (isLightLike(placed)) {
      this.guard('lighting', this._lighting, (l) => l.syncLight(placed, toLightSample(state, placed)));
    }
    this.guard('entities', this._entities, (e) =>
      e.updateVisual(placed.entity, toEntityVisual(state, placed, hass)),
    );
  }

  private syncDaylight(hass: HomeAssistant): boolean {
    if (!this.renderCfg.daylight) return false;
    const sun = hass.states[this.renderCfg.daylightEntity];
    if (this.daylightApplied && sun === this.prevSun) return false;
    this.prevSun = sun;
    this.daylightApplied = true;
    const elevation = numberAttr(sun?.attributes.elevation, 35);
    const azimuth = numberAttr(sun?.attributes.azimuth, 180);
    this.guard('lighting', this._lighting, (l) => l.setDaylight(elevation, azimuth, true));
    return true;
  }

  /* ------------------------------------------------------------ edit mode */

  /**
   * The cut-plane handles are a tool, not part of the picture. They appear
   * while the user is adjusting a cut and fade out once it settles, so what is
   * left is the thing they were cutting towards — the open storey — rather
   * than a gizmo sitting in the middle of it.
   */
  private flashSectionHandles(): void {
    this.guard('section', this._section, (s) => s.setHandlesVisible(true));
    if (this.handleHideTimer) clearTimeout(this.handleHideTimer);
    this.handleHideTimer = setTimeout(() => {
      this.handleHideTimer = null;
      if (this.disposed) return;
      this.guard('section', this._section, (s) => s.setHandlesVisible(false));
      this.core?.invalidate();
    }, HANDLE_LINGER_MS);
  }

  setEditMode(enabled: boolean): void {
    this.editMode = enabled;
    // Edit mode no longer pins the handles on; `flashSectionHandles` owns them.
    if (!enabled) this.guard('section', this._section, (s) => s.setHandlesVisible(false));
    this.guard('entities', this._entities, (e) => {
      e.setMarkersVisible(true);
      (e as IEntityLayer & EditAware).setEditMode?.(enabled);
    });
    this.guard('placement', this._placement, (p) =>
      (p as IPlacementController & EditAware).setEditMode?.(enabled),
    );
    this.guard('pointer', this._pointer, (p) => (p as Subsystem & EditAware).setEditMode?.(enabled));
    this.core?.invalidate();
  }

  /* -------------------------------------------------- coupled view helpers */

  /**
   * Applies a preset *and* the state it carries (section + visible levels).
   * The camera controller only owns the viewpoint, so the coupling lives here.
   */
  async applyPreset(presetId: string, animate = true): Promise<void> {
    const preset = (this.config.presets ?? []).find((p) => p.id === presetId);
    if (!preset) return;
    await this.applyPresetInternal(preset, animate);
  }

  /**
   * `resetState` is false for the preset applied on load. A user *clicking* a
   * preset wants a complete viewpoint, so a preset carrying no section clears
   * the current cut. But doing that on mount would throw away the `section:`
   * block the user wrote in their YAML — and, because the reset travels back
   * out as an edit intent, overwrite it with `none` in their saved config.
   */
  private async applyPresetInternal(
    preset: CameraPreset,
    animate: boolean,
    resetState = true,
  ): Promise<void> {
    // A preset is a complete viewpoint, not a camera move layered on top of
    // whatever the user was doing. One that carries no section of its own
    // therefore *clears* the cut rather than inheriting it — otherwise picking
    // "Overview" while a storey is isolated leaves you looking at a sliced
    // house from outside, which reads as a bug.
    const section = preset.section ?? (resetState ? { ...DEFAULT_SECTION_STATE } : null);
    if (section) {
      this.guard('section', this._section, (s) => s.setState(section, animate));
      this.core?.markShadowsDirty();
    }
    // Likewise, no explicit level list means "show the whole building".
    if (preset.visibleLevels !== undefined || resetState) {
      this.setVisibleLevels(preset.visibleLevels ?? null);
    }

    if (this._cameraCtl && !this.failed.has('camera')) {
      try {
        await this._cameraCtl.applyPreset(preset, animate);
      } catch (err) {
        this.disable('camera', 'Camera preset could not be applied', err);
      }
    }
    this.emit('preset-applied', { presetId: preset.id });
    this.core?.invalidate();
  }

  /** Reads `render.style` / `render.edgeColor` and pushes them to the overlay. */
  private applyRenderStyle(): void {
    const render = this.config.render ?? {};
    const palette = render.palette ?? DEFAULT_RENDER_CONFIG.palette;
    this.edges.setPalette(palette);

    // The ink has to contrast with whatever ends up *behind* the model: the
    // configured background if it is opaque, otherwise the Home Assistant card
    // showing through a transparent canvas. Getting this wrong makes
    // `style: wireframe` render nothing visible at all.
    //
    // Precedence: explicit colour, then the mono palettes — where the lines sit
    // on the flattened surface rather than on the ground — then the backdrop.
    const color = render.edgeColor?.trim();
    const groundInk = resolveBackground(render.background, this.themeDark).dark
      ? EDGE_INK_ON_DARK
      : EDGE_INK_ON_LIGHT;
    const paletteInk =
      palette === 'mono-dark'
        ? EDGE_INK_ON_DARK
        : palette === 'mono-light'
          ? EDGE_INK_ON_LIGHT
          : groundInk;
    this.edges.setColor(color || paletteInk);
    this.edges.setStyle(render.style ?? DEFAULT_RENDER_CONFIG.style);
    // `wireframe` hides every surface, so the shadows they cast must go too.
    this.core?.markShadowsDirty();

    this.guard('camera', this._cameraCtl, (c) =>
      (c as ICameraController & { setViewCubeVisible?(v: boolean): void }).setViewCubeVisible?.(
        this.config.ui?.showViewCube !== false,
      ),
    );

    // Hidden-line drawings have no visible surface for a marker to hide behind,
    // so depth-testing one there just makes it vanish with nothing to explain
    // why. Markers always draw through in `wireframe`.
    const style = render.style ?? DEFAULT_RENDER_CONFIG.style;
    const depthTested = style !== 'wireframe' && this.config.ui?.markersThroughWalls !== true;
    this.guard('entities', this._entities, (e) =>
      (e as IEntityLayer & { setDepthTested?(v: boolean): void }).setDepthTested?.(depthTested),
    );

    this.guard('placement', this._placement, (p) =>
      (p as Subsystem & { setSnapPlacement?(v: boolean): void }).setSnapPlacement?.(
        this.config.ui?.snapPlacement === true,
      ),
    );

    // Whether ghosted storeys appear at all is a decision about the card, not
    // about one viewpoint, so it overrides every preset's own section state.
    this.guard('section', this._section, (s) =>
      (s as ISectionController & { setGhostOverride?(v: boolean | null): void }).setGhostOverride?.(
        this.config.ui?.ghostAbove ?? null,
      ),
    );

    // Recognising a double tap costs every tap 300 ms of latency, so it stays
    // off unless some placed entity actually configures one.
    const wantsDoubleTap = (this.config.entities ?? []).some((e) => e.double_tap_action);
    this.guard('pointer', this._pointer, (p) =>
      (p as Subsystem & { setDoubleTapEnabled?(v: boolean): void }).setDoubleTapEnabled?.(
        wantsDoubleTap,
      ),
    );
    this.edges.setVisibleLevels(this._model?.getVisibleLevels?.() ?? null);
    this.core?.invalidate();
  }

  /**
   * Recentre and zoom so the building fills the canvas, keeping the current
   * viewing direction — the CAD "fit to screen".
   *
   * It frames what is actually on screen, not the whole model: with a storey
   * isolated, fitting to the entire house would zoom *out* to include the
   * storeys the user just hid, which is the opposite of what the button says.
   */
  fitToView(animate = true): void {
    const box = this.visibleBounds();
    if (!box || box.isEmpty()) return;
    this.guard('camera', this._cameraCtl, (c) => c.frameObject(box, animate));
  }

  /** World bounds of the geometry currently drawn, or null when there is none. */
  private visibleBounds(): THREE.Box3 | null {
    const root = this.core?.modelRoot;
    if (!root) return null;

    const levels = this._model?.getVisibleLevels?.() ?? null;
    const wanted = levels && levels.length > 0 ? new Set(levels) : null;
    const box = new THREE.Box3();

    root.traverseVisible((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      // Edge lines, cut caps and the room-fill wash mirror the model; including
      // them changes nothing and the wash floats above the floor.
      if (mesh.userData.fp3dInternal === true) return;
      if (wanted) {
        const level = mesh.userData.level;
        // Geometry belonging to no storey (site, terrain) is always drawn, so
        // it must not drag the frame open when one storey is isolated.
        if (typeof level !== 'string' || !wanted.has(level)) return;
      }
      box.expandByObject(mesh);
    });

    // Nothing matched — an unlevelled model, or a level id that no longer
    // exists. Falling back to the whole model beats framing nothing.
    if (box.isEmpty()) {
      const bounds = this._model?.model?.bounds;
      return bounds && !bounds.isEmpty() ? bounds.clone() : null;
    }
    return box;
  }

  setVisibleLevels(levelIds: string[] | null): void {
    this.edges.setVisibleLevels(levelIds);
    this.guard('model', this._model, (m) => m.setVisibleLevels(levelIds));
    // Without this a hidden storey's lamps keep pouring light through the slab
    // that is no longer drawn.
    this.guard('lighting', this._lighting, (l) =>
      (l as ILightingSystem & { setVisibleLevels?(ids: string[] | null): void }).setVisibleLevels?.(
        levelIds,
      ),
    );
    this.core?.markShadowsDirty();
    this.guard('entities', this._entities, (e) => e.setVisibleLevels(levelIds));
    this.emit('levels-changed', { visible: levelIds });
    this.core?.invalidate();
  }

  setSection(state: SectionState, animate = true): void {
    this.guard('section', this._section, (s) => s.setState(state, animate));
    this.emit('section-changed', state);
    this.core?.invalidate();
  }

  /* ------------------------------------------------------------- teardown */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mounted = false;

    if (this.handleHideTimer) {
      clearTimeout(this.handleHideTimer);
      this.handleHideTimer = null;
    }
    this.edges.dispose();
    for (const off of this.unwire) off();
    this.unwire.length = 0;

    this.loop?.setFrameCallback(null);
    this.loop?.dispose();
    this.loop = null;

    // Reverse construction order: dependants before their dependencies.
    for (const [name, subsystem] of this.registry().reverse()) {
      if (!subsystem) continue;
      try {
        subsystem.dispose();
      } catch (err) {
        console.error(`[floorplan-3d] "${name}" threw during dispose`, err);
      }
    }

    this._pointer = null;
    this._placement = null;
    this._entities = null;
    this._postFx = null;
    this._lighting = null;
    this._cameraCtl = null;
    this._section = null;
    this._model = null;

    this.unsubResize?.();
    this.unsubResize = null;
    this.core?.attachScheduler(null);
    this.core?.dispose();
    this.core = null;

    this.prevStates.clear();
    this.failed.clear();
    this.hass = null;
    this.prevSun = undefined;
    this.emitter.clear();
  }

  /* -------------------------------------------------------------- helpers */

  private emit<K extends ViewerEventName>(event: K, payload: ViewerEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  private emitError(message: string, cause?: unknown): void {
    this.emit('error', { message, cause });
  }

  private tick(
    name: SubsystemName,
    subsystem: Subsystem | null,
    dt: number,
    ctx: RenderContext,
  ): void {
    if (!subsystem?.update || this.failed.has(name)) return;
    try {
      subsystem.update(dt, ctx);
    } catch (err) {
      this.disable(name, `Subsystem "${name}" failed during update`, err);
    }
  }

  /** Runs `action` against a live subsystem, disabling only it if it throws. */
  private guard<T extends Subsystem>(
    name: SubsystemName,
    subsystem: T | null,
    action: (s: T) => void,
  ): void {
    if (!subsystem || this.failed.has(name)) return;
    try {
      action(subsystem);
    } catch (err) {
      this.disable(name, `Subsystem "${name}" threw`, err);
    }
  }

  private disable(name: SubsystemName, message: string, cause: unknown): void {
    if (this.failed.has(name)) return;
    this.failed.add(name);
    console.error(`[floorplan-3d] ${message}`, cause);
    this.emitError(message, cause);
  }

  private require<T>(value: T | null, name: SubsystemName): T {
    if (!value) {
      throw new Error(`Viewer: "${name}" is not available before mount() resolves`);
    }
    return value;
  }
}

/* -------------------------------------------------------------- utilities */

function isLightLike(placed: PlacedEntity): boolean {
  if (placed.role) return placed.role === 'light';
  if (placed.light) return true;
  return placed.entity.startsWith('light.');
}

function numberAttr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The config is JSON by contract (ARCHITECTURE.md rule 3), so a round-trip is
 * a safe clone and avoids `structuredClone` on the older Android WebViews the
 * HA companion app ships.
 */
/**
 * Where each room sits, taken from its floor slab: the centre of the footprint,
 * lifted just off the floor so a leader drawn to it is not buried in the slab.
 *
 * Floors rather than the room's whole geometry, because furniture and ceilings
 * would drag the centre off the part of the room a reader is looking at.
 */
function roomAnchors(root: THREE.Object3D): Map<string, Vec3> {
  const boxes = new Map<string, THREE.Box3>();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.part !== 'floor') return;
    const room = mesh.userData.room;
    if (typeof room !== 'string' || !room) return;
    const box = boxes.get(room) ?? new THREE.Box3().makeEmpty();
    box.expandByObject(mesh);
    boxes.set(room, box);
  });

  const anchors = new Map<string, Vec3>();
  const centre = new THREE.Vector3();
  for (const [room, box] of boxes) {
    if (box.isEmpty()) continue;
    box.getCenter(centre);
    anchors.set(room, [centre.x, box.max.y + 0.02, centre.z]);
  }
  return anchors;
}

function cloneConfig(config: Floorplan3dCardConfig): Floorplan3dCardConfig {
  return JSON.parse(JSON.stringify(config)) as Floorplan3dCardConfig;
}

/** Structural equality for config sub-trees. Small objects only. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}
