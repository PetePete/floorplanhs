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
  DEFAULT_UI_CONFIG,
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
  ISectionController,
  IViewer,
  RenderContext,
  Subsystem,
  ViewerEventName,
  ViewerEvents,
} from '@/engine/contracts';
import { Emitter } from '@/util/events';
import { easeInOutCubic, vRound } from '@/util/math';
import { EdgeOverlay } from '@/engine/model/edge-overlay';
import { explodeOffsets } from '@/engine/model/explode';
import { roomAnchors } from '@/engine/model/room-anchors';
import { joinStack, leaveStack, moveStack, stackFor, stackTarget } from '@/engine/entities/stacks';
import type { RoomFillSource } from '@/engine/lighting/room-fill';
import { RenderCore, WebGLUnavailableError } from '@/engine/core/render-core';
import { RenderLoop } from '@/engine/core/render-loop';
import { resolveBackground } from '@/engine/core/background';
import { ModelManager } from '@/engine/model/model-manager';
import { SectionController } from '@/engine/section/section-controller';
import { CameraController } from '@/engine/camera/camera-controller';
import { LightingSystem } from '@/engine/lighting/lighting-system';
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
  private _entities: IEntityLayer | null = null;
  private _placement: IPlacementController | null = null;
  private _pointer: Subsystem | null = null;

  private hass: HomeAssistant | null = null;
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
  /** Serialises overlapping model loads; see `loadModel`. */
  private loadToken = 0;
  /** Toolbar override for `ui.explode`; see `setExplode`. */
  private explodeOverride: number | null = null;
  /** Metres the storeys are *drawn* apart by right now; see `stepExplode`. */
  private explodeGap = 0;
  private explodeFlight: {
    from: number;
    to: number;
    t: number;
    duration: number;
    /** Reframe once the storeys have stopped; see `flyExplode`. */
    fit: boolean;
  } | null = null;
  private explodeLease: (() => void) | null = null;
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
      ['entities', this._entities],
      ['placement', this._placement],
      ['pointer', this._pointer],
    ];
  }

  private async loadModel(): Promise<void> {
    const manager = this._model;
    const core = this.core;
    if (!manager || !core || this.failed.has('model')) return;

    // Loading is asynchronous and can be asked for again before it finishes —
    // two edits to `model.url` in quick succession, or a harness that swaps the
    // source on startup. Whoever asked last wins; anything else is stale by
    // definition and its result is dropped.
    const token = (this.loadToken += 1);
    try {
      const loaded = await manager.load(this.config.model ?? {}, (progress) =>
        this.emit('load-progress', progress),
      );
      if (this.disposed || token !== this.loadToken) return;

      // Adopt the result and evict anything else. Comparing against the root
      // captured *before* the await is not enough: two loads that overlap both
      // see the same "previous" and neither removes the other, which is how a
      // second house ends up standing inside the first.
      for (const child of [...core.modelRoot.children]) {
        if (child !== loaded.root && child.userData.fp3dInternal !== true) {
          child.removeFromParent();
        }
      }
      if (!loaded.root.parent) core.modelRoot.add(loaded.root);

      this.guard('section', this._section, (s) => {
        s.setBounds(loaded.bounds);
        // Without the storey list, `level` mode has nothing to isolate.
        s.setLevels(loaded.levels);
      });
      this.guard('camera', this._cameraCtl, (c) => c.setBounds(loaded.bounds));

      // Measured before anything is lifted, so these are heights above each
      // storey's own floor rather than positions in the exploded view.
      this.guard('section', this._section, (sc) =>
        (
          sc as ISectionController & {
            setLevelTops?(t: ReadonlyMap<string, number> | null): void;
          }
        ).setLevelTops?.(levelTops(loaded.root, loaded.levels)),
      );

      // Before the room anchors: those are read off the geometry, so the
      // storeys have to be where they are going to be drawn first.
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
        const rooms = lighting.fillSource;
        if (rooms) {
          this.edges.setRoomSource(rooms);
          // Dropping a marker outside a room records the one it came from, so
          // placement needs the same room index the fill and the edges use.
          this.guard('placement', this._placement, (p) =>
            (
              p as IPlacementController & {
                setRoomResolver?(
                  fn: (x: number, y: number, z: number, level?: string | null) => string | null,
                ): void;
              }
            ).setRoomResolver?.((x, y, z, level) => rooms.roomNameAt(x, y, z, level)),
          );
        }
        lighting.setFillListener?.(() => this.edges.refreshRoomColors());
      });

      this.edges.setHideCeilings(this.config.ui?.showCeilings === false);
      this.edges.build(loaded.root, core.clippingPlanes);
      if (!this.edges.object.parent) core.modelRoot.add(this.edges.object);
      this.applyRenderStyle();

      // Last, and that ordering is the whole of it. The room index has to exist
      // before the tint can be told which storey each room is on, and the edge
      // lines bake the model's world matrices into one merged geometry per
      // storey — bake them while the storeys are already lifted and the lift
      // gets applied twice, once in the geometry and once in the group.
      this.applyExplode(loaded.levels);

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
      section.onChange((state, origin) => {
        this.flashSectionHandles();
        this.config = { ...this.config, section: state };
        this.emit('section-changed', state);
        // Only a hand on a cut handle is an edit. Applying a view also lands
        // here, and writing *that* down means every click on a storey rewrites
        // the card's stored `section:` — which is the state the card opens
        // with, so the card would then start on whichever storey was last
        // looked at instead of the view its config asks for.
        if (origin === 'user') this.emit('edit-intent', { kind: 'set-section', section: state });
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
          if (mode !== 'move') return;
          const position = vRound(result.position);
          // The room the marker came from, when it was dragged out of one.
          // Dropping this on the way out is what left a chip parked outside the
          // plan with nothing to say which room it belongs to — the placement
          // works it out, and then nobody wrote it down.
          const room = result.room ?? undefined;
          this.emit('edit-intent', {
            kind: 'move-entity',
            entityId,
            position,
            level: result.levelId,
            room,
          });
          this.adoptMove(entityId, position, result.levelId, room);
        }),
        placement.on('label-commit', ({ entityId, offset }) => {
          // On a stacked marker the label is the handle for that one entity:
          // dragging it out is how you take it off the pile, and where it lands
          // is where it goes. Everywhere else it moves the caption alone.
          const entities = this.config.entities ?? [];
          const stack = stackFor(entities, entityId);
          if (stack) {
            const self = entities.find((entry) => entry.entity === entityId);
            if (self) {
              const position = vRound([
                self.position[0] + offset[0],
                self.position[1],
                self.position[2] + offset[2],
              ]);
              this.emit('edit-intent', {
                kind: 'unstack-entity',
                entityId,
                position,
                level: self.level ?? null,
              });
              this.adoptUnstack(entityId, position);
            }
            return;
          }
          this.adoptLabelOffset(entityId, offset);
        }),
      );
    }

    camera.setDefaultPreset(this.findDefaultPreset());
  }

  /**
   * Take a drag's result into our own copy of the config, straight away.
   *
   * The dashboard is where a placement is *stored*, and it hands the config
   * back on its own schedule — the editor's YAML round-trip, a Lovelace
   * re-render. The marker cannot wait for that: the room it was dragged out of
   * is what its leader line points at, and a chip parked outside the plan with
   * no line is exactly the thing the gesture is for. So the layer is told now,
   * with the same values the dashboard will confirm later.
   */
  /** A marker taken off its stack, in our own copy; see the card for the config. */
  private adoptUnstack(entityId: string, position: Vec3): void {
    const entities = leaveStack(this.config.entities ?? [], entityId).map((entry) =>
      entry.entity === entityId ? { ...entry, position } : entry,
    );
    this.config = { ...this.config, entities };
    this.guard('entities', this._entities, (e) => e.setEntities(entities));
  }

  private adoptMove(
    entityId: string,
    position: Vec3,
    level: string | null,
    room: string | undefined,
  ): void {
    const entities = this.config.entities ?? [];
    const index = entities.findIndex((entry) => entry.entity === entityId);
    if (index < 0) return;

    // Grabbing one marker of a pile moves the pile: the anchor is shared, and
    // leaving the others behind would be moving a thing out of its own place.
    const stack = stackFor(entities, entityId);
    if (stack) {
      const moved = moveStack(entities, stack.id, position, level);
      this.config = { ...this.config, entities: moved };
      this.guard('entities', this._entities, (e) => e.setEntities(moved));
      return;
    }

    const moved: PlacedEntity = { ...entities[index], position, level };
    if (room) moved.room = room;
    else delete moved.room;

    const next = [...entities];
    next[index] = moved;

    // Dropped onto another marker: the same rule the card applies, applied here
    // too. Without it the engine holds two markers at one point with no stack
    // to fan them apart, so one sits invisibly inside the other until the
    // config comes back round — which looks exactly like the marker vanishing.
    const target = stackTarget(next, entityId, position, level);
    const stacked = target ? joinStack(next, entityId, target) : next;

    this.config = { ...this.config, entities: stacked };
    this.guard('entities', this._entities, (e) => e.setEntities(stacked));
  }

  /**
   * A label dragged beside its anchor, into the config and into our own copy.
   *
   * Same reasoning as `adoptMove`: the dashboard stores it and hands it back on
   * its own schedule, and until then the marker has to keep the position the
   * user let go of rather than springing back.
   */
  private adoptLabelOffset(entityId: string, offset: Vec3): void {
    const entities = this.config.entities ?? [];
    const index = entities.findIndex((entry) => entry.entity === entityId);
    if (index < 0) return;

    const current = entities[index];
    const marker = { ...(current.marker ?? {}), offset };
    const next = [...entities];
    next[index] = { ...current, marker };
    this.config = { ...this.config, entities: next };
    this.emit('edit-intent', { kind: 'update-entity', entityId, patch: { marker } });
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

    this.stepExplode(dt);

    // Camera first: everything else positions itself relative to the view.
    this.tick('camera', this._cameraCtl, dt, ctx);
    this.syncCameraRig(core);

    this.tick('model', this._model, dt, ctx);
    this.tick('section', this._section, dt, ctx);
    this.tick('lighting', this._lighting, dt, ctx);
    this.tick('entities', this._entities, dt, ctx);
    this.tick('placement', this._placement, dt, ctx);
    this.tick('pointer', this._pointer, dt, ctx);

    // Straight to the canvas. With no bloom there is nothing a composer would
    // add — and plenty it takes away: it bypasses the canvas' own multisampling,
    // it forces every material through one global tone-mapping pass whether or
    // not the material asked for it, and its render targets are where the
    // transparent background kept getting lost.
    core.renderer.render(core.scene, core.activeCamera);

    // The ViewCube lives in its own scene and is scissored into a corner after
    // everything else, so tone mapping and the section clipping planes cannot
    // touch it.
    this.guard('camera', this._cameraCtl, (c) =>
      (c as ICameraController & { renderOverlay?(): void }).renderOverlay?.(),
    );
  };

  private syncCameraRig(core: RenderCore): void {
    // The projection never changes: the card draws the axonometric and nothing
    // else, so the core is put in it once and left there.
    core.setOrthographic(true);
    if (!this._cameraCtl || this.failed.has('camera')) {
      core.syncCameras(ORIGIN);
      return;
    }
    try {
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
    // `ui` is mostly the card's own DOM, but a few of its flags are engine-side
    // — the orientation cube, marker depth testing, the exploded view — and
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
    // `ui.explode` is as much a view change as pressing the toolbar button, so
    // an edit to it travels rather than teleports.
    if (uiChanged) this.flyExplode(true);

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
      // A marker just created has no state yet, so it shows its entity id until
      // the next push from Home Assistant — which may be a minute away. Replay
      // what we already know instead of letting a fresh drop sit there labelled
      // `light.dusche_shelly_dusche_lavabo`.
      if (this.hass) {
        this.prevStates.clear();
        this.updateHass(this.hass);
      }
    }

    this.core.invalidate();
  }

  /** Push render settings that live inside subsystems rather than the core. */
  private pushRenderSettings(): void {
    this.guard('lighting', this._lighting, (l) => l.setRenderConfig(this.renderCfg));
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

    if (changed) this.core?.invalidate();
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
    const groundDark = resolveBackground(render.background, this.themeDark).dark;
    const groundInk = groundDark ? EDGE_INK_ON_DARK : EDGE_INK_ON_LIGHT;

    // The room tint answers to the same ground: a lamp's near-white colour has
    // to be deepened before it can read against light paper.
    this.guard('lighting', this._lighting, (l) =>
      (l as ILightingSystem & { setGroundDark?(dark: boolean): void }).setGroundDark?.(groundDark),
    );
    // The orientation cube is glazed rather than painted, so its lines answer to
    // the same ground as the model's.
    this.guard('camera', this._cameraCtl, (c) =>
      (c as ICameraController & { setGroundDark?(dark: boolean): void }).setGroundDark?.(groundDark),
    );
    const paletteInk =
      palette === 'mono-dark'
        ? EDGE_INK_ON_DARK
        : palette === 'mono-light'
          ? EDGE_INK_ON_LIGHT
          : groundInk;
    this.edges.setColor(color || paletteInk);
    this.edges.setStyle(render.style ?? DEFAULT_RENDER_CONFIG.style);

    this.guard('camera', this._cameraCtl, (c) =>
      (c as ICameraController & { setViewCubeVisible?(v: boolean): void }).setViewCubeVisible?.(
        this.config.ui?.showViewCube !== false,
      ),
    );

    // Hidden-line drawings have no visible surface for a marker to hide behind,
    // so depth-testing one there just makes it vanish with nothing to explain
    // why. Markers always draw through in `wireframe`.
    const style = render.style ?? DEFAULT_RENDER_CONFIG.style;
    const wire = style === 'wireframe';
    const depthTested = !wire && this.config.ui?.markersThroughWalls !== true;
    this.guard('entities', this._entities, (e) => {
      const layer = e as IEntityLayer & {
        setDepthTested?(v: boolean): void;
        setGroundDark?(v: boolean): void;
      };
      layer.setDepthTested?.(depthTested);
      // A marker is a plate with a hairline on it, and both have to sit on the
      // same side of the paper as the drawing under them.
      layer.setGroundDark?.(groundDark);
    });

    this.guard('placement', this._placement, (p) => {
      const target = p as Subsystem & {
        setSnapPlacement?(v: boolean): void;
        setHiddenLine?(v: boolean): void;
        setGroundDark?(v: boolean): void;
      };
      target.setSnapPlacement?.(this.config.ui?.snapPlacement === true);
      target.setHiddenLine?.(wire);
      target.setGroundDark?.(groundDark);
    });

    const hideCeilings = this.config.ui?.showCeilings === false;
    // Out of the scene entirely, not kept as an invisible depth mask: a mask
    // would go on hiding the storey it belongs to, which is the one thing
    // hiding the ceiling is for.
    this.guard('model', this._model, (m) => m.setCeilingsVisible(!hideCeilings));
    // The line work is merged per storey, so dropping the ceilings from it means
    // rebuilding — cheap enough for something that changes on a click.
    if (this.edges.setHideCeilings(hideCeilings)) this.rebuildEdges();

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

  /**
   * Pull the storeys apart, or put them back. Everything that lives in world
   * space has to agree on the same lift, so this is the one place that hands it
   * out — and the room anchors are re-read afterwards, since they are measured
   * off geometry that just moved.
   */
  private applyExplode(levels: readonly LevelDefinition[], settled = true): void {
    if (settled) this.explodeGap = this.explode;
    const offsets = explodeOffsets(levels, this.explodeGap);
    const value = offsets.size > 0 ? offsets : null;

    this.guard('model', this._model, (m) => m.setLevelOffsets(value));
    this.edges.setLevelOffsets(value);
    this.guard('entities', this._entities, (e) => e.setLevelOffsets(value));
    this.guard('lighting', this._lighting, (l) =>
      (
        l as ILightingSystem & {
          setLevelOffsets?(o: ReadonlyMap<string, number> | null): void;
        }
      ).setLevelOffsets?.(value),
    );
    this.guard('section', this._section, (sc) =>
      (
        sc as ISectionController & {
          setLevelOffsets?(o: ReadonlyMap<string, number> | null, settled?: boolean): void;
        }
      ).setLevelOffsets?.(value, settled),
    );

    // Measured off the geometry that just moved, so it waits until the geometry
    // has stopped: a leader line chasing its room every frame costs a full
    // traversal per frame and lands in the same place either way.
    if (settled) {
      const root = this._model?.model?.root;
      if (root) this.guard('entities', this._entities, (e) => e.setRoomAnchors(roomAnchors(root)));
    }
    this.core?.invalidate();
  }

  /**
   * Rebuild the line work from the model as it now stands, exploded or not.
   *
   * The overlay takes the storey lift back out of what it bakes, so this is
   * safe at any point; see `EdgeOverlay.build`. What still has to happen here
   * is the room anchors, which are measured off geometry the rebuild does not
   * move but whose lines have just been replaced.
   */
  private rebuildEdges(): void {
    const root = this._model?.model?.root;
    const core = this.core;
    if (!root || !core) return;

    this.edges.build(root, core.clippingPlanes);
    const levels = this._model?.model?.levels;
    if (levels) this.applyExplode(levels, this.explodeFlight === null);
  }

  /** Metres the storeys are currently pulled apart by. */
  get explode(): number {
    return this.explodeOverride ?? this.config.ui?.explode ?? 0;
  }

  /**
   * Live change, without going through a config round-trip.
   *
   * Held beside the config rather than written into it. Separating the storeys
   * is something you switch on to look at the building, and the card is handed
   * a fresh config on every unrelated edit — folding it in meant the first such
   * edit silently collapsed the view again.
   */
  setExplode(metres: number, animate = true): void {
    this.explodeOverride = Math.max(0, metres);
    this.flyExplode(animate);
  }

  /**
   * Send the storeys to wherever `explode` now says, over `ui.explodeDuration`
   * seconds. Idempotent: called with the storeys already there, it does nothing
   * but re-apply the same offsets.
   */
  private flyExplode(animate: boolean): void {
    const levels = this._model?.model?.levels;
    if (!levels) return;

    const duration =
      animate && Math.abs(this.explode - this.explodeGap) > 1e-4
        ? (this.config.ui?.explodeDuration ?? DEFAULT_UI_CONFIG.explodeDuration)
        : 0;
    // The building is a different size once it comes apart, so the view it was
    // framed for is no longer the right one. Refit — but only when something
    // actually moved, or every unrelated config push would fly the camera.
    const moved = Math.abs(this.explode - this.explodeGap) > 1e-4;

    if (duration <= 0) {
      this.explodeFlight = null;
      this.releaseExplodeLease();
      this.applyExplode(levels, true);
      // No flight, so no flight to run alongside: the frame lands with the
      // storeys rather than travelling after them.
      if (moved) this.fitToView(false);
      return;
    }

    this.explodeFlight = { from: this.explodeGap, to: this.explode, t: 0, duration, fit: moved };
    // The loop renders on demand, so the flight has to keep it awake for its own
    // duration — nothing else is going to invalidate on its behalf.
    this.explodeLease ??= this.core?.holdContinuous() ?? null;
    this.core?.invalidate();
  }

  /** Move the storeys one frame closer to where `explode` says they belong. */
  private stepExplode(dt: number): void {
    const flight = this.explodeFlight;
    const levels = this._model?.model?.levels;
    if (!flight || !levels) return;

    flight.t = Math.min(1, flight.t + dt / flight.duration);
    this.explodeGap = flight.from + (flight.to - flight.from) * easeInOutCubic(flight.t);

    const settled = flight.t >= 1;
    this.applyExplode(levels, settled);

    // Reframed every frame rather than flown to afterwards. A second animation
    // chasing the first reads as two steps; refitting the frame the storeys
    // currently occupy keeps the building the same size on screen while it comes
    // apart, which is the one motion the eye is meant to follow. No tween is
    // needed for it either — the gap is already eased, so the frame is too.
    if (flight.fit) this.fitToView(false);

    if (settled) {
      this.explodeFlight = null;
      this.releaseExplodeLease();
    }
  }

  private releaseExplodeLease(): void {
    this.explodeLease?.();
    this.explodeLease = null;
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
    this.explodeFlight = null;
    this.releaseExplodeLease();
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
/**
 * How tall each storey's geometry is above its own elevation.
 *
 * The declared storey height is a nominal figure; a top floor under a pitched
 * roof has walls of every height between eaves and ridge. Measuring gives the
 * cross-section something true to cut from.
 */
function levelTops(
  root: THREE.Object3D,
  levels: readonly LevelDefinition[],
): Map<string, number> {
  const highest = new Map<string, number>();
  const anything = new Map<string, number>();
  const ceilings = new Map<string, { top: number; bottom: number }>();
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.fp3dInternal === true) return;
    const level = mesh.userData.level;
    if (typeof level !== 'string' || !level) return;
    box.setFromObject(mesh);
    if (box.isEmpty()) return;
    anything.set(level, Math.max(anything.get(level) ?? -Infinity, box.max.y));
    // The walls, and nothing else. They are what a storey's height *means*: a
    // ceiling slab sits above them, which is the thing the cut is there to take
    // off, and a wardrobe that reaches it would otherwise raise the cut over it.
    if (mesh.userData.part === 'ceiling') {
      const under = ceilings.get(level);
      ceilings.set(level, {
        top: Math.max(under?.top ?? -Infinity, box.max.y),
        bottom: Math.min(under?.bottom ?? Infinity, box.min.y),
      });
      return;
    }
    if (mesh.userData.part !== 'walls') return;
    highest.set(level, Math.max(highest.get(level) ?? -Infinity, box.max.y));
  });

  const tops = new Map<string, number>();
  for (const level of levels) {
    let top = highest.get(level.id) ?? anything.get(level.id);
    if (top === undefined || top <= level.elevation) continue;

    // Slide under a ceiling slab that caps the walls, and only such a slab.
    // Isolating a storey is meant to let you look into the rooms, so its lid
    // has to come off — but a flat ceiling in one room of a loft must not drag
    // the cut down through the ridge of the pitched one beside it.
    const ceiling = ceilings.get(level.id);
    if (ceiling && ceiling.top > top - 0.05 && ceiling.bottom > level.elevation) {
      top = Math.min(top, ceiling.bottom);
    }
    tops.set(level.id, top - level.elevation);
  }
  return tops;
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
