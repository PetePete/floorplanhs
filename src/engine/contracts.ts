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
  RenderConfig,
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
  /** Keep rendering continuously until released; returns the release fn. */
  holdContinuous(): () => void;
  /** Global clipping planes array shared with the renderer. */
  readonly clippingPlanes: THREE.Plane[];
  readonly quality: QualityTier;
}

export type QualityTier = 'low' | 'medium' | 'high';

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
  /**
   * Rooms the model declares, by storey. The card offers these when you point
   * a marker's leader line at a room by hand rather than by dragging it out of
   * one.
   */
  rooms?: Array<{ id: string; level: string | null }>;
  /** Node name -> object, for bindNode lookups. */
  nodes: Map<string, THREE.Object3D>;
  /** Meshes that should receive light and shadows. */
  receivers: THREE.Mesh[];
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
  /** Lift each storey for the exploded view; see `engine/model/explode.ts`. */
  setLevelOffsets(offsets: ReadonlyMap<string, number> | null): void;
  /** How far a storey is currently lifted. 0 when not exploded. */
  levelOffset(levelId: string | null | undefined): number;
  /** Show or hide every ceiling slab. */
  setCeilingsVisible(visible: boolean): void;
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
  /** `user` is a hand on a cut handle; `apply` is a view or config being restored. */
  onChange(cb: (state: SectionState, origin: SectionChangeOrigin) => void): () => void;
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
  setAutoRotate(enabled: boolean): void;
  /**
   * How far below the top edge the orientation cube sits, in CSS px. The cube
   * is painted on the canvas and cannot see the chrome, so the card has to say
   * whether there is a toolbar above it to clear.
   */
  setViewCubeTopMargin(px: number): void;
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
  /** Re-apply the `render` block: exposure, ambient level, room-fill mode. */
  setRenderConfig(render: RenderConfig): void;
    /** Create or update the three.js light for a placed entity. */
  syncLight(placed: PlacedEntity, sample: LightSample): void;
  removeLight(entityId: string): void;
  /** Called when a placed light is dragged. */
  moveLight(entityId: string, position: Vec3): void;
  /** All entity ids that currently have a light rig. */
  getLightIds(): string[];
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
  pick(ndc: { x: number; y: number }, options?: { ignore?: string }): string | null;
  setHovered(entityId: string | null): void;
  setSelected(entityId: string | null): void;
  /** Live position update while dragging. */
  moveEntity(entityId: string, position: Vec3): void;
  /** Hide markers whose level is hidden. */
  setVisibleLevels(levelIds: string[] | null): void;
  /** Lift each marker with its storey; see `engine/model/explode.ts`. */
  setLevelOffsets(offsets: ReadonlyMap<string, number> | null): void;
  setMarkersVisible(visible: boolean): void;
  /**
   * Where each room is, in world space, so a marker placed outside one can draw
   * a leader back to it. Keyed by the room name the model carries.
   */
  setRoomAnchors(anchors: ReadonlyMap<string, Vec3> | null): void;
}

/* ------------------------------------------------------------ interaction */

export interface PlacementResult {
  position: Vec3;
  /** Surface normal at the hit, for orienting wall-mounted items. */
  normal: Vec3;
  levelId: string | null;
  /** Node name that was hit, useful for bindNode. */
  nodeName?: string;
  /**
   * The room this entity should be recorded as belonging to.
   *
   * `null` when the drop landed inside a room — the position already says
   * which, so no override is written. A name when it landed *outside* one, in
   * which case it is the room the entity was dragged out of, and the marker
   * draws a leader back to it.
   */
  room?: string | null;
  /**
   * The marker this drop landed on, if any — the drop is over its chip on
   * screen, whatever the distance between them in the model. Stacking is about
   * what looks like one pile from where you are sitting.
   */
  stackWith?: string | null;
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
  /** Move an already-placed entity's *label*, leaving the entity where it is. */
  beginLabelMove(entityId: string): void;
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
      mode: 'add' | 'move' | 'label';
      result: PlacementResult;
    }) => void,
  ): () => void;
  /** A label dragged clear of its anchor; the offset is in metres. */
  on(
    event: 'label-commit',
    cb: (payload: { entityId: string; offset: Vec3; stackWith?: string }) => void,
  ): () => void;
}

/* ------------------------------------------------------------------ store */

/** Who moved the cut: see `ISectionController.onChange`. */
export type SectionChangeOrigin = 'user' | 'apply';

export type EditIntent =
  | {
      kind: 'add-entity';
      entity: PlacedEntity;
      /** Marker the drop landed on; the new one joins its stack. */
      stackWith?: string | null;
    }
  | {
      kind: 'move-entity';
      /** Marker the drop landed on; the two become a stack. */
      stackWith?: string | null;
      entityId: string;
      position: Vec3;
      level: string | null;
      /** Room to record; absent clears any existing one. See PlacementResult. */
      room?: string;
    }
  | { kind: 'update-entity'; entityId: string; patch: Partial<PlacedEntity> }
  | { kind: 'remove-entity'; entityId: string }
  | { kind: 'add-preset'; preset: CameraPreset }
  | { kind: 'update-preset'; presetId: string; patch: Partial<CameraPreset> }
  | { kind: 'remove-preset'; presetId: string }
  /** Entities that live in the panel rather than on the plan. */
  /** A label dragged clear of the pile: this marker leaves it, and lands here. */
  | { kind: 'unstack-entity'; entityId: string; position: Vec3; level: string | null }
  | { kind: 'add-shortcut'; entityId: string }
  | { kind: 'remove-shortcut'; entityId: string }
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
  /** Metres the storeys are pulled apart by; see `engine/model/explode.ts`. */
  readonly explode: number;
  setExplode(metres: number): void;
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
