/**
 * Interface contracts between the engine subsystems. Each subsystem is written
 * against these types only — never against another subsystem's implementation.
 * The Viewer (engine/viewer.ts) owns instantiation and wiring.
 */

import type * as THREE from 'three';
import type {
  CameraConfig,
  CameraPreset,
  Floorplan3dCardConfig,
  LevelDefinition,
  PlacedEntity,
  SectionState,
  Vec3,
} from '@/types/config';
import type { HomeAssistant } from '@/types/hass';

/* ------------------------------------------------------------ shared bits */

/** Everything a subsystem may touch on the render core. */
export interface RenderContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  /** The camera currently used for rendering. */
  readonly activeCamera: THREE.Camera;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly clock: THREE.Clock;
  /** Root the loaded house model is parented to. */
  readonly modelRoot: THREE.Group;
  /** Root for markers, gizmos and helper geometry (never clipped). */
  readonly overlayRoot: THREE.Group;
  readonly size: { width: number; height: number; pixelRatio: number };
  /** Request a frame. Required when render.onDemand is on. */
  invalidate(): void;
  /**
   * Shadow maps are refreshed only on demand — they do not depend on the
   * camera, so re-rendering them while the user merely orbits is pure waste.
   * Anything that moves geometry, a light, a cut plane or level visibility
   * must call this, or it will render against a stale map.
   */
  markShadowsDirty(durationMs?: number): void;
  /** Keep rendering continuously until released; returns the release fn. */
  holdContinuous(): () => void;
  /** Global clipping planes array shared with the renderer. */
  readonly clippingPlanes: THREE.Plane[];
  readonly quality: QualityTier;
}

export type QualityTier = 'low' | 'medium' | 'high';

/**
 * Layer index for selective bloom. Only lit luminaires and emissive markers are
 * enabled on it, so a bright white wall never blooms. Declared here (rather
 * than in the lighting module) because the entity layer needs it too.
 */
export const BLOOM_LAYER = 1;

/**
 * Module manifest — the exact paths and class names the Viewer imports.
 * Subsystems are constructed with their config (if any) and receive the render
 * context in `init(ctx)`; they must not touch three.js before that.
 *
 *   @/engine/core/render-core.ts            class RenderCore
 *   @/engine/model/model-manager.ts         class ModelManager      (IModelManager)
 *   @/engine/section/section-controller.ts  class SectionController (ISectionController)
 *   @/engine/camera/camera-controller.ts    class CameraController  (ICameraController)
 *   @/engine/lighting/lighting-system.ts    class LightingSystem    (ILightingSystem)
 *   @/engine/lighting/post-fx.ts            class PostFx            (IPostFx)
 *   @/engine/entities/entity-layer.ts       class EntityLayer       (IEntityLayer)
 *   @/engine/interaction/placement-controller.ts
 *                                           class PlacementController (IPlacementController)
 *   @/engine/interaction/pointer-router.ts  class PointerRouter
 */

export interface Subsystem {
  /** Called once after the render context exists. */
  init(ctx: RenderContext): void;
  /** Per-frame, only when a frame is actually rendered. */
  update?(dt: number, ctx: RenderContext): void;
  /** Canvas resized. */
  resize?(width: number, height: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ model */

export interface LoadedModel {
  root: THREE.Group;
  /** World-space bounds of the whole house. */
  bounds: THREE.Box3;
  levels: LevelDefinition[];
  /** Node name -> object, for bindNode lookups. */
  nodes: Map<string, THREE.Object3D>;
  /** Meshes that should receive light and shadows. */
  receivers: THREE.Mesh[];
  /** True when the procedural demo house was used. */
  isDemo: boolean;
}

export interface ModelLoadProgress {
  phase: 'download' | 'parse' | 'prepare' | 'done' | 'error';
  loaded?: number;
  total?: number;
  message?: string;
}

export interface IModelManager extends Subsystem {
  load(
    config: Floorplan3dCardConfig['model'],
    onProgress?: (p: ModelLoadProgress) => void,
  ): Promise<LoadedModel>;
  readonly model: LoadedModel | null;
  /** Level visibility. Empty set / null means "all visible". */
  setVisibleLevels(levelIds: string[] | null): void;
  getVisibleLevels(): string[] | null;
  /** Ray target list for placement + picking against the building shell. */
  getPickTargets(): THREE.Object3D[];
  /** Which level a world position falls into. */
  levelAt(position: Vec3 | THREE.Vector3): LevelDefinition | null;
}

/* ---------------------------------------------------------------- section */

export interface ISectionController extends Subsystem {
  setState(state: SectionState, animate?: boolean): void;
  getState(): SectionState;
  /** Live drag of a single plane without rewriting the whole state. */
  setPlanePosition(axis: 'x' | 'y' | 'z', position: number): void;
  /** Isolate one storey; pass null to show everything. */
  isolateLevel(levelId: string | null, animate?: boolean): void;
  /** Section bounds follow the model; call after load. */
  setBounds(bounds: THREE.Box3): void;
  /** Show/hide the interactive drag handles for the cut planes. */
  setHandlesVisible(visible: boolean): void;
  /** Storeys available to `level` mode; call after the model loads. */
  setLevels(levels: LevelDefinition[]): void;
  /** Re-collect model materials after a reload that kept the same bounds. */
  refreshMaterials(): void;
  onChange(cb: (state: SectionState) => void): () => void;
  /** Let the camera park OrbitControls while a cut handle is being dragged. */
  onHandleDragStart(cb: () => void): () => void;
  onHandleDragEnd(cb: () => void): () => void;
  isHandleDragging(): boolean;
  /** False when the WebGL context has no stencil buffer, so caps are off. */
  readonly capsAvailable: boolean;
}

/* ----------------------------------------------------------------- camera */

export interface ICameraController extends Subsystem {
  applyPreset(preset: CameraPreset, animate?: boolean): Promise<void>;
  /** Snapshot the current viewpoint into a new preset object. */
  capture(name: string): CameraPreset;
  frameObject(object: THREE.Object3D | THREE.Box3, animate?: boolean): void;
  setOrthographic(enabled: boolean, animate?: boolean): void;
  isOrthographic(): boolean;
  setAutoRotate(enabled: boolean): void;
  /** Blocks orbit while a drag/placement gesture owns the pointer. */
  setEnabled(enabled: boolean): void;
  readonly controls: { enabled: boolean; target: THREE.Vector3 } & Record<string, unknown>;
  /** Fires whenever the user moves the camera (throttled). */
  onChange(cb: () => void): () => void;
  setConfig(config: CameraConfig): void;
  /** Clamps panning so the house cannot be lost off-screen. */
  setBounds(bounds: THREE.Box3): void;
  /** Target of the idle-return flight; null disables it. */
  setDefaultPreset(preset: CameraPreset | null): void;
  getCurrentPresetId(): string | null;
  notifyInteraction(): void;
  /** Zoom as 0..1 (1 = closest), logarithmic over the distance range. */
  getZoom01(): number;
  setZoom01(value: number): void;
}

/* --------------------------------------------------------------- lighting */

/** Normalised state of one light entity, independent of HA quirks. */
export interface LightSample {
  on: boolean;
  /** 0..1 */
  brightness: number;
  /** Linear-space RGB, 0..1 each. */
  color: [number, number, number];
  /** Kelvin, when the entity is in colour-temp mode. */
  kelvin?: number;
  /** HA reports effects/flash; used to drive subtle animation. */
  effect?: string;
  unavailable: boolean;
}

export interface ILightingSystem extends Subsystem {
  /** Ambient/sun rig, driven by sun.sun when configured. */
  setDaylight(elevation: number, azimuth: number, enabled: boolean): void;
  /** Create or update the three.js light for a placed entity. */
  syncLight(placed: PlacedEntity, sample: LightSample): void;
  removeLight(entityId: string): void;
  /** Called when a placed light is dragged. */
  moveLight(entityId: string, position: Vec3): void;
  /** All entity ids that currently have a light rig. */
  getLightIds(): string[];
  setShadowsEnabled(enabled: boolean): void;
}

export interface IPostFx extends Subsystem {
  render(dt: number): void;
  setBloom(enabled: boolean, strength: number, radius: number, threshold: number): void;
  setExposure(value: number): void;
  /** Objects on the bloom layer glow; used for lit fixtures. */
  readonly bloomLayer: number;
}

/* --------------------------------------------------------------- entities */

export interface EntityVisualState {
  entityId: string;
  state: string;
  active: boolean;
  label: string;
  secondary?: string;
  icon: string;
  color: string;
  unavailable: boolean;
}

export interface IEntityLayer extends Subsystem {
  setEntities(entities: PlacedEntity[]): void;
  updateVisual(entityId: string, visual: EntityVisualState): void;
  /** Raycast for hover/click; returns the entity id under the pointer. */
  pick(ndc: { x: number; y: number }): string | null;
  setHovered(entityId: string | null): void;
  setSelected(entityId: string | null): void;
  /** Live position update while dragging. */
  moveEntity(entityId: string, position: Vec3): void;
  /** Hide markers whose level is hidden. */
  setVisibleLevels(levelIds: string[] | null): void;
  setMarkersVisible(visible: boolean): void;
}

/* ------------------------------------------------------------ interaction */

export interface PlacementResult {
  position: Vec3;
  /** Surface normal at the hit, for orienting wall-mounted items. */
  normal: Vec3;
  levelId: string | null;
  /** Node name that was hit, useful for bindNode. */
  nodeName?: string;
}

export interface IPlacementController extends Subsystem {
  /** Enter placement mode for an entity being dragged in from the palette. */
  beginPlacement(entityId: string): void;
  /** Pointer moved during a drag; returns the would-be drop location. */
  updatePlacement(clientX: number, clientY: number): PlacementResult | null;
  /** Commit; returns null when the drop was outside the model. */
  commitPlacement(clientX: number, clientY: number): PlacementResult | null;
  cancelPlacement(): void;
  /** Move an already-placed entity. */
  beginMove(entityId: string): void;
  isActive(): boolean;
  /**
   * Commit notifications, so the viewer can turn an in-canvas marker drag into
   * an `edit-intent` the card persists. Without this a move made by dragging a
   * marker survives only until the next config round-trip.
   */
  on(
    event: 'placement-commit',
    cb: (payload: {
      entityId: string;
      mode: 'add' | 'move';
      result: PlacementResult;
    }) => void,
  ): () => void;
}

/* ------------------------------------------------------------------ store */

export type EditIntent =
  | { kind: 'add-entity'; entity: PlacedEntity }
  | { kind: 'move-entity'; entityId: string; position: Vec3; level: string | null }
  | { kind: 'update-entity'; entityId: string; patch: Partial<PlacedEntity> }
  | { kind: 'remove-entity'; entityId: string }
  | { kind: 'add-preset'; preset: CameraPreset }
  | { kind: 'update-preset'; presetId: string; patch: Partial<CameraPreset> }
  | { kind: 'remove-preset'; presetId: string }
  | { kind: 'set-section'; section: SectionState };

/** Emitted by the viewer; the card turns these into `config-changed`. */
export interface ViewerEvents {
  'entity-activate': { entityId: string; action: 'tap' | 'hold' | 'double-tap' };
  'entity-hover': { entityId: string | null };
  'edit-intent': EditIntent;
  'preset-applied': { presetId: string };
  'section-changed': SectionState;
  'levels-changed': { visible: string[] | null };
  'model-loaded': LoadedModel;
  'load-progress': ModelLoadProgress;
  error: { message: string; cause?: unknown };
  ready: void;
}

export type ViewerEventName = keyof ViewerEvents;

export interface IViewer {
  readonly ctx: RenderContext | null;
  mount(container: HTMLElement, config: Floorplan3dCardConfig): Promise<void>;
  updateConfig(config: Floorplan3dCardConfig): Promise<void>;
  /** Push new HA state. Cheap — called on every hass update. */
  updateHass(hass: HomeAssistant): void;
  setEditMode(enabled: boolean): void;
  /** Frame the visible geometry without changing the viewing direction. */
  fitToView(animate?: boolean): void;
  on<K extends ViewerEventName>(event: K, cb: (payload: ViewerEvents[K]) => void): () => void;
  resize(): void;
  dispose(): void;

  readonly model: IModelManager;
  readonly section: ISectionController;
  readonly cameraCtl: ICameraController;
  readonly lighting: ILightingSystem;
  readonly entities: IEntityLayer;
  readonly placement: IPlacementController;
}
