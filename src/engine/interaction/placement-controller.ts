/**
 * Drag & drop placement.
 *
 * Two input paths reach the same core, because desktop and touch disagree about
 * what "drag an item onto a canvas" means:
 *
 *   - HTML5 drag-and-drop (`dragover`/`drop` with an entity id in
 *     `dataTransfer`) — what the card's entity palette fires on desktop;
 *   - pointer drags routed through `PointerRouter` — the only thing that works
 *     with a finger, and how an already-placed marker is moved.
 *
 * The hard part is not the raycast, it is making the drop land where the user
 * is *looking*. With a cross-section active the raycast still hits the wall
 * that was clipped away, so every hit is tested against the active clipping
 * planes before it is accepted. The render core deliberately keeps
 * `renderer.clippingPlanes` empty (so the overlay stays unclipped), which makes
 * this filter the *only* thing standing between the user and a marker buried
 * inside a wall they cannot see.
 */

import * as THREE from 'three';
import type {
  ICameraController,
  IEntityLayer,
  IModelManager,
  IPlacementController,
  PlacementResult,
  RenderContext,
} from '@/engine/contracts';
import type { EntityRole, LevelDefinition, PlacedEntity, Vec3 } from '@/types/config';
import { Emitter } from '@/util/events';
import { vRound } from '@/util/math';
import { humaniseEntityId, resolveIcon, roleForEntityId } from '@/engine/entities/icons';
import { DropIndicator, snapToGrid, type DropFeedback } from '@/engine/interaction/drop-indicator';

/** MIME type the entity palette must put on `dataTransfer`. */
export const ENTITY_DRAG_MIME = 'application/x-ha-entity';

export type PlacementMode = 'add' | 'move' | 'label';
export type PlacementCancelReason = 'escape' | 'outside' | 'user' | 'leave' | 'dispose';

export interface PlacementPreview {
  icon?: string;
  label?: string;
  color?: string;
  role?: EntityRole;
}

export interface PlacementEvents {
  'placement-begin': { entityId: string; mode: PlacementMode };
  'placement-update': {
    entityId: string;
    result: PlacementResult | null;
    valid: boolean;
    reason?: string;
  };
  'placement-commit': { entityId: string; mode: PlacementMode; result: PlacementResult };
  'placement-cancel': { entityId: string; mode: PlacementMode; reason: PlacementCancelReason };
  /** A label was dragged to a new spot beside its anchor. */
  'label-commit': { entityId: string; offset: Vec3 };
}

/**
 * Optional `EntityLayer` capabilities. `IEntityLayer` does not expose them, but
 * a cancelled move has to put the marker back where it was.
 */
interface EntityLayerExtras {
  getEntityPosition?(entityId: string): Vec3 | null;
  getPlacedEntity?(entityId: string): PlacedEntity | null;
  getPlacedEntities?(): PlacedEntity[];
  setLabelOffset?(entityId: string, offset: Vec3): void;
  getLabelOffset?(entityId: string): Vec3 | null;
}

/* ----------------------------------------------------------------- tuning */

/**
 * Drop offsets.
 *
 * The default is what you dropped, where you dropped it: the hit point, nudged
 * clear of the surface along its normal so the marker is not half-buried in a
 * slab. Nothing moves vertically. A drop that silently relocates a lamp two and
 * a half metres up to the ceiling is not a helpful guess — the user aimed at a
 * spot, watched the indicator sit there, released, and the marker appeared
 * somewhere else.
 *
 * `ui.snapPlacement: true` opts into the fixture-aware version, which is
 * genuinely useful once you are placing a whole house full of pendants and
 * switches and know it is coming:
 *
 *   surface   role      result
 *   ceiling   any       0.05 m below the ceiling (recessed downlight)
 *   wall      switch    0.10 m off the wall, raised to 1.10 m above the floor
 *   wall      light     0.10 m off the wall, raised to 1.90 m (sconce)
 *   wall      other     0.10 m off the wall, at the height that was hit
 *   floor     light     0.05 m below that storey's ceiling (pendant)
 *   floor     switch    1.20 m above the floor
 *   floor     other     on the floor
 */
const CEILING_DROP = 0.05;
const WALL_OFFSET = 0.1;
const WALL_SWITCH_HEIGHT = 1.1;
const WALL_LIGHT_HEIGHT = 1.9;
const FLOOR_SWITCH_HEIGHT = 1.2;
const FLOOR_LIFT = 0.02;
/** Fallback pendant height when the storey height is unknown. */
const FALLBACK_CEILING = 2.3;

/** A normal this far from horizontal counts as floor/ceiling rather than wall. */
const SURFACE_THRESHOLD = 0.5;
/** Tolerance for the clipping-plane test; the hit point sits *on* a surface. */
const CLIP_EPSILON = 1e-4;

const UP = new THREE.Vector3(0, 1, 0);
/** Reused by `resolveFree`; the plane moves, the object does not. */
const _freePlane = new THREE.Plane();

/** Metres a label floats above its anchor when it has no offset of its own. */
const DEFAULT_LABEL_LIFT = 0.34;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export class PlacementController implements IPlacementController {
  private readonly emitter = new Emitter<PlacementEvents>();
  private readonly indicator: DropIndicator;
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly normalMatrix = new THREE.Matrix3();

  /* scratch — reused every pointer move */
  private readonly ndc = new THREE.Vector2();
  private readonly point = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly feedback: DropFeedback = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    anchor: new THREE.Vector3(),
    valid: false,
    levelName: null,
    levelElevation: null,
  };

  private ctx: RenderContext | null = null;
  private release: (() => void) | null = null;

  private entityId: string | null = null;
  private mode: PlacementMode | null = null;
  private role: EntityRole = 'marker';
  /** `ui.snapPlacement`; see the offset table above. */
  private snapPlacement = false;
  /** Set while `render.style` is `wireframe`; see `setHiddenLine`. */
  private hiddenLine = true;
  private originalPosition: Vec3 | null = null;
  /** Where the label sat when this drag started; restored on cancel. */
  private originalOffset: Vec3 | null = null;
  /** Anchor the label is being dragged around, in world metres. */
  private labelAnchor: Vec3 | null = null;
  private labelOffset: Vec3 | null = null;
  /** Latched once a drag leaves the building. See `resolve`. */
  private freePlacement = false;
  /** Storey of the last surface this gesture touched; see `freeLevel`. */
  private lastHitLevel: LevelDefinition | null = null;
  /** Injected by the Viewer; see `setRoomResolver`. */
  private roomAt:
    | ((x: number, y: number, z: number, level?: string | null) => string | null)
    | null = null;
  private lastResult: PlacementResult | null = null;
  private domDrag = false;
  private cameraWasEnabled = true;
  private editMode = false;
  private disposed = false;

  constructor(
    private readonly model: IModelManager,
    private readonly entities: IEntityLayer,
    private readonly camera: ICameraController,
  ) {
    this.indicator = new DropIndicator();
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.indicator.init(ctx);
  }

  update(dt: number, ctx: RenderContext): void {
    if (this.mode === null) return;
    this.indicator.update(dt, ctx);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mode !== null) this.finish('dispose');
    this.detachKeyListener();
    this.indicator.dispose();
    this.emitter.clear();
    this.hits.length = 0;
    this.ctx = null;
  }

  on<K extends keyof PlacementEvents>(
    event: K,
    cb: (payload: PlacementEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }

  setEditMode(enabled: boolean): void {
    this.editMode = enabled;
    if (!enabled && this.mode !== null) this.cancelPlacement();
  }

  isActive(): boolean {
    return this.mode !== null;
  }

  getActiveEntityId(): string | null {
    return this.entityId;
  }

  getMode(): PlacementMode | null {
    return this.mode;
  }

  isEditMode(): boolean {
    return this.editMode;
  }

  /**
   * The last valid drop location seen during the drag. Lets the card commit
   * from a source that has no coordinates of its own (a keyboard confirm, or a
   * `dragend` that fires after the pointer already left the canvas).
   */
  getLastResult(): PlacementResult | null {
    return this.lastResult;
  }

  /* --------------------------------------------------------- placement API */

  /**
   * Enter placement for an entity dragged in from the palette. `entityId` may
   * be empty: the HTML5 drag API refuses to reveal `dataTransfer` contents
   * during `dragover`, so the id only becomes known on drop.
   */
  beginPlacement(entityId: string): void {
    if (this.disposed) return;
    if (this.mode !== null) this.finish('user');

    this.entityId = entityId;
    this.mode = 'add';
    this.role = entityId ? roleForEntityId(entityId) : 'marker';
    this.originalPosition = null;
    this.lastResult = null;
    // A fresh gesture starts fresh. The free-placement latch is meant to hold
    // for the length of one drag — without this it held for the life of the
    // card: one drag that strayed off the building, and every placement after
    // it ignored every surface and landed on a plane at the lowest storey. The
    // move path always reset it; the add path never did.
    this.freePlacement = false;
    this.lastHitLevel = null;
    this.indicator.setGhostVisible(true);
    this.applyPreview(this.defaultPreview(entityId));
    this.start();
  }

  /** Pick an already-placed marker up. */
  beginMove(entityId: string): void {
    if (this.disposed || !entityId) return;
    if (this.mode !== null) this.finish('user');

    const extras = this.entities as IEntityLayer & EntityLayerExtras;
    const placed = extras.getPlacedEntity?.(entityId) ?? null;

    this.entityId = entityId;
    this.mode = 'move';
    this.role = placed?.role ?? roleForEntityId(entityId);
    this.originalPosition = extras.getEntityPosition?.(entityId) ?? null;
    this.freePlacement = false;
    this.lastHitLevel = null;
    this.lastResult = null;
    // The marker itself follows the cursor from here, so a ghost chip would only
    // be a second copy of it standing alongside.
    this.indicator.setGhostVisible(false);
    this.start();
  }

  /**
   * Pick up a marker's *label*, leaving the entity where it is.
   *
   * Dragging a marker used to drag the thing it names: move the chip somewhere
   * readable and the lamp went with it, along with the light it casts. The label
   * is a caption, and a caption is allowed to sit beside what it captions.
   */
  beginLabelMove(entityId: string): void {
    if (this.disposed || !entityId) return;
    if (this.mode !== null) this.finish('user');

    const extras = this.entities as IEntityLayer & EntityLayerExtras;
    const anchor = extras.getEntityPosition?.(entityId) ?? null;
    if (!anchor) {
      // No anchor, no frame to offset from: fall back to moving the entity,
      // which is at least a gesture that does something.
      this.beginMove(entityId);
      return;
    }

    this.entityId = entityId;
    this.mode = 'label';
    this.role = extras.getPlacedEntity?.(entityId)?.role ?? roleForEntityId(entityId);
    this.labelAnchor = anchor;
    this.originalOffset = extras.getLabelOffset?.(entityId) ?? null;
    this.labelOffset = this.originalOffset;
    this.originalPosition = null;
    this.lastResult = null;
    this.indicator.hide();
    this.start();
  }

  /**
   * Cursor on the horizontal plane at height `y`, in world metres.
   *
   * A level offset is added and taken off again for the same reason the drop
   * path does it: in an exploded view a storey is drawn somewhere it is not, and
   * a number written down from where it is drawn is wrong everywhere else.
   */
  private pointOnPlane(clientX: number, clientY: number, y: number): Vec3 | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const rect = ctx.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    this.raycaster.setFromCamera(this.ndc, ctx.activeCamera);

    _freePlane.set(UP, -y);
    if (!this.raycaster.ray.intersectPlane(_freePlane, this.point)) return null;
    return [this.point.x, this.point.y, this.point.z];
  }

  /**
   * Where the label goes for this pointer position.
   *
   * On the horizontal plane through the anchor: a floorplan is read from above,
   * so sideways is the direction a label has room to move. Its height stays as
   * configured — that is the lift that keeps a chip clear of the floor.
   */
  private updateLabel(clientX: number, clientY: number): void {
    const anchor = this.labelAnchor;
    const entityId = this.entityId;
    if (!anchor || !entityId) return;

    const point = this.pointOnPlane(clientX, clientY, anchor[1]);
    if (!point) return;

    const lift = this.originalOffset ? this.originalOffset[1] : DEFAULT_LABEL_LIFT;
    const offset: Vec3 = [
      round3(point[0] - anchor[0]),
      round3(lift),
      round3(point[2] - anchor[2]),
    ];
    this.labelOffset = offset;
    (this.entities as IEntityLayer & EntityLayerExtras).setLabelOffset?.(entityId, offset);
    this.ctx?.invalidate();
  }

  /** Pointer moved: returns where the entity would land, or null if nowhere. */
  updatePlacement(clientX: number, clientY: number): PlacementResult | null {
    if (this.mode === null) return null;
    if (this.mode === 'label') {
      this.updateLabel(clientX, clientY);
      return null;
    }

    const resolved = this.resolve(clientX, clientY);
    this.indicator.set(this.feedback);

    if (!resolved) {
      this.lastResult = null;
      this.emitter.emit('placement-update', {
        entityId: this.entityId ?? '',
        result: null,
        valid: false,
        reason: this.feedback.reason,
      });
      this.ctx?.invalidate();
      return null;
    }

    this.lastResult = resolved;
    // The marker itself follows the cursor in move mode; the ghost would only
    // duplicate it.
    if (this.mode === 'move' && this.entityId) {
      this.entities.moveEntity(this.entityId, resolved.position);
    }
    this.emitter.emit('placement-update', {
      entityId: this.entityId ?? '',
      result: resolved,
      valid: true,
    });
    this.ctx?.invalidate();
    return resolved;
  }

  /** Commit. Returns null (and cancels with feedback) for an invalid drop. */
  commitPlacement(clientX: number, clientY: number): PlacementResult | null {
    if (this.mode === null) return null;

    const mode = this.mode;
    const entityId = this.entityId ?? '';

    if (mode === 'label') {
      this.updateLabel(clientX, clientY);
      const offset = this.labelOffset;
      this.finish(null);
      if (entityId && offset) this.emitter.emit('label-commit', { entityId, offset });
      return null;
    }

    const result = this.resolve(clientX, clientY);

    if (!result || !entityId) {
      // Rule: never silently place at the origin. The caller gets null and the
      // cancel event carries the reason so the card can toast it.
      this.finish('outside');
      return null;
    }

    if (mode === 'move') this.entities.moveEntity(entityId, result.position);
    this.finish(null);
    this.emitter.emit('placement-commit', { entityId, mode, result });
    return result;
  }

  cancelPlacement(): void {
    if (this.mode === null) return;
    this.finish('user');
  }

  /* --------------------------------------------------- HTML5 drag and drop */

  /**
   * Wire from the card:
   *   canvas.addEventListener('dragover', (e) => placement.handleDomDragOver(e))
   *   canvas.addEventListener('drop',     (e) => placement.handleDomDrop(e))
   *   canvas.addEventListener('dragleave',(e) => placement.handleDomDragLeave(e))
   *
   * The palette item must set both `application/x-ha-entity` and `text/plain`
   * to the entity id on `dragstart`.
   */
  handleDomDragOver(event: DragEvent): void {
    const transfer = event.dataTransfer;
    if (!transfer || !carriesEntity(transfer)) return;

    // Without preventDefault the browser refuses the drop entirely.
    event.preventDefault();
    transfer.dropEffect = 'copy';

    if (this.mode === null) {
      this.domDrag = true;
      this.beginPlacement(readEntityId(transfer) ?? '');
    }
    this.updatePlacement(event.clientX, event.clientY);
  }

  handleDomDrop(event: DragEvent): PlacementResult | null {
    const transfer = event.dataTransfer;
    if (!transfer || !carriesEntity(transfer)) return null;
    event.preventDefault();

    const dropped = readEntityId(transfer);
    if (this.mode === null) {
      if (!dropped) return null;
      this.domDrag = true;
      this.beginPlacement(dropped);
    } else if (dropped && !this.entityId) {
      // The id was unknowable during dragover; adopt it now.
      this.entityId = dropped;
      this.role = roleForEntityId(dropped);
      this.applyPreview(this.defaultPreview(dropped));
    }

    return this.commitPlacement(event.clientX, event.clientY);
  }

  handleDomDragLeave(event: DragEvent): void {
    if (!this.domDrag || this.mode === null) return;
    // `dragleave` also fires when crossing into a child node; only a leave that
    // really exits the canvas has a related target outside it.
    const related = event.relatedTarget;
    const target = event.currentTarget;
    if (
      related instanceof Node &&
      target instanceof Node &&
      (target === related || target.contains(related))
    ) {
      return;
    }
    this.finish('leave');
  }

  /** Override the ghost's artwork, e.g. with the real HA icon and colour. */
  setPreview(preview: PlacementPreview): void {
    this.applyPreview(preview);
  }

  /* ------------------------------------------------------------- resolving */

  /**
   * Raycast, filter, offset, snap. Fills `this.feedback` in every case — even a
   * miss, so the indicator can show *why* the drop is refused — and returns the
   * result only when the drop is valid.
   */
  private resolve(clientX: number, clientY: number): PlacementResult | null {
    const ctx = this.ctx;
    if (!ctx) return null;

    const rect = ctx.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );

    const targets = this.model.getPickTargets();
    this.hits.length = 0;
    if (targets.length > 0) {
      this.raycaster.near = 0;
      this.raycaster.far = Infinity;
      this.raycaster.setFromCamera(this.ndc, ctx.activeCamera);
      this.raycaster.intersectObjects(targets, true, this.hits);
    }

    // Hidden-line drawings have no visible surface to aim at, so a floor the
    // ray meets outranks whatever stands in front of it; see `firstFloorHit`.
    const hit = (this.hiddenLine ? this.firstFloorHit() : null) ?? this.firstUnclippedHit();

    // A drag that leaves the building latches into free placement for the rest
    // of the gesture. Without the latch, dragging a marker out and along the
    // outside of a wall keeps catching that wall — the ray still grazes it on
    // its way down to the ground — and the marker snaps back onto it every few
    // pixels. Only landing on a *floor* clears the latch, because that is the
    // one surface that unambiguously means "back inside a room": walls and
    // roofs are exactly what you cross on the way out.
    if (!hit) this.freePlacement = true;
    else if (hit.object.userData.part === 'floor') this.freePlacement = false;

    if (!hit || this.freePlacement) {
      this.hits.length = 0;
      return this.resolveFree();
    }

    this.point.copy(hit.point);
    this.readNormal(hit);
    // The exploded view lifts a storey's geometry, so a hit on it comes back
    // higher than the building really is. The surface knows which storey it
    // belongs to, so undo exactly that lift before anything reads the height —
    // a position written to the config must always be the real one.
    this.point.y -= this.model.levelOffset(hit.object.userData.level as string | undefined);
    // The storey is the one you are pointing at — the surface says which, and
    // it is the only thing here that knows for certain. Reading it back out of
    // the height instead was wrong in three ways at once: a floor slab's top
    // face sits exactly on the boundary between two storeys, so rounding alone
    // decided the answer; the storeys move in the exploded view; and a preset
    // that isolates one storey then rejected the drop outright as "that storey
    // is hidden" — the surface under the pointer belonged, on paper, to the one
    // below.
    const level = this.levelOfHit(hit) ?? this.model.levelAt(this.point);
    this.lastHitLevel = level;
    this.hits.length = 0;

    if (level && this.isLevelHidden(level)) {
      return this.reject(`${level.name} is hidden`, level);
    }

    this.applyRoleOffset(level);
    snapToGrid(this.anchor);
    const stackWith = this.snapToMarker();

    this.feedback.point.copy(this.point);
    this.feedback.normal.copy(this.normal);
    this.feedback.anchor.copy(this.anchor);
    this.feedback.valid = true;
    this.feedback.levelName = level?.name ?? null;
    this.feedback.levelElevation = level?.elevation ?? null;
    this.feedback.reason = undefined;

    return {
      position: vRound([this.anchor.x, this.anchor.y, this.anchor.z]),
      normal: vRound([this.normal.x, this.normal.y, this.normal.z]),
      levelId: level?.id ?? null,
      nodeName: hit.object.name || undefined,
      room: this.resolveRoom(level),
      stackWith,
    };
  }

  /**
   * Placement with no surface under the pointer: onto a horizontal plane at the
   * storey's own floor level.
   *
   * This is what makes the wall crossable at all. Beside the building the ray
   * hits nothing — there is no ground plane in the model, by design — so
   * requiring a hit meant a marker could never be dragged clear of the plan,
   * however far you pulled it.
   */
  private resolveFree(): PlacementResult | null {
    const ctx = this.ctx;
    if (!ctx) return null;

    const level = this.freeLevel();
    const y = level?.elevation ?? this.model.model?.bounds.min.y ?? 0;
    // Aim at where the storey is *drawn*, then bring the result back down to
    // where it really is, so an exploded view does not write lifted heights.
    const lift = this.model.levelOffset(level?.id);
    _freePlane.set(UP, -(y + lift));

    const ray = this.raycaster.ray;
    if (!ray.intersectPlane(_freePlane, this.point)) {
      return this.reject('Drop beside the house, not above the horizon');
    }
    this.point.y -= lift;
    if (level && this.isLevelHidden(level)) {
      return this.reject(`${level.name} is hidden`, level);
    }

    this.normal.copy(UP);
    this.anchor.copy(this.point);
    this.anchor.y += FLOOR_LIFT;
    snapToGrid(this.anchor);
    const stackWith = this.snapToMarker();

    this.feedback.point.copy(this.point);
    this.feedback.normal.copy(this.normal);
    this.feedback.anchor.copy(this.anchor);
    this.feedback.valid = true;
    this.feedback.levelName = level?.name ?? null;
    this.feedback.levelElevation = level?.elevation ?? null;
    this.feedback.reason = undefined;

    return {
      position: vRound([this.anchor.x, this.anchor.y, this.anchor.z]),
      normal: vRound([this.normal.x, this.normal.y, this.normal.z]),
      levelId: level?.id ?? null,
      room: this.resolveRoom(level),
      stackWith,
    };
  }

  /**
   * Land exactly on a marker that is almost under the pointer.
   *
   * Stacking is "drop this one on that one", and without a snap that is a
   * shooting exercise: the target is a chip a few pixels wide, seen in
   * perspective, and the drop is aimed at the floor beneath it. Within a hand's
   * width the drop gives up its own spot and takes the other marker's, so the
   * gesture succeeds by intention rather than by aim.
   */
  private snapToMarker(): string | null {
    if (this.mode === null) return null;
    const extras = this.entities as IEntityLayer & EntityLayerExtras;

    // Screen space, not world space, and deliberately: a stack is markers that
    // *look* like one pile. Whether the two points are a metre apart in the
    // model is invisible from where you are sitting, and aiming at a chip a few
    // pixels wide through a perspective projection is not a gesture anyone can
    // repeat. This is the same hit test that decides what a tap lands on, so
    // "it looks like I am on it" and "I am on it" are the same question.
    // `pick` is part of the layer contract, but a stub layer in a test need not
    // provide it, and a placement that throws is worse than one that does not
    // stack.
    const hit =
      typeof this.entities.pick === 'function'
        ? this.entities.pick({ x: this.ndc.x, y: this.ndc.y })
        : null;
    if (!hit || hit === this.entityId) return null;

    const target = extras.getPlacedEntity?.(hit) ?? null;
    if (!target) return null;

    // Its own pile: dragging a stack by the anchor would snap back onto the
    // mates it is carrying.
    const self = this.entityId ? extras.getPlacedEntity?.(this.entityId) : null;
    if (self?.stack && target.stack === self.stack) return null;

    this.anchor.set(target.position[0], target.position[1], target.position[2]);
    return hit;
  }

  /**
   * Which storey a free-placed marker belongs to. The one it already had, so
   * dragging a first-floor sensor out of the window does not quietly move it to
   * the ground floor; otherwise whichever storey is on screen alone, and
   * failing that the one the model puts at the bottom.
   */
  /** The storey a hit surface declares it belongs to, if the model named one. */
  private levelOfHit(hit: THREE.Intersection): LevelDefinition | null {
    const id = hit.object.userData.level;
    if (typeof id !== 'string' || !id) return null;
    return this.model.model?.levels.find((level) => level.id === id) ?? null;
  }

  private freeLevel(): LevelDefinition | null {
    // Where the gesture came *from*, before anything else: dragging a sensor
    // out of an upstairs room and onto the lawn beside it is still a placement
    // upstairs, and the surface it left said so.
    if (this.lastHitLevel) return this.lastHitLevel;
    const original = this.originalPosition;
    if (original) {
      const level = this.model.levelAt(original);
      if (level) return level;
    }
    const visible = this.model.getVisibleLevels();
    const levels = this.model.model?.levels ?? [];
    if (visible && visible.length === 1) {
      return levels.find((entry) => entry.id === visible[0]) ?? null;
    }
    return levels[0] ?? null;
  }

  /**
   * First hit that survives the active clipping planes.
   *
   * `getPickTargets()` already drops invisible nodes, helpers and glass, but it
   * knows nothing about the section: a clipped-away wall is still a full,
   * hittable mesh. Anything on the removed side of an enabled plane has to be
   * skipped or the marker lands on a surface the user cannot even see.
   */
  private firstUnclippedHit(): THREE.Intersection | null {
    for (const hit of this.hits) {
      if (!this.isClipped(hit.point, hit.object)) return hit;
    }
    return null;
  }

  /**
   * The first floor the ray meets, or null if it meets none.
   *
   * In a hidden-line drawing there is no such thing as the surface under the
   * pointer: every surface is invisible, and the nearest one is whatever
   * happens to stand between the camera and what you are looking at. Measured
   * on a real house from a three-quarter view, a drop aimed into a room met the
   * outer wall of the storey above 1.1 m before the floor it was aimed at, and
   * the marker went onto that wall.
   *
   * A floor is what a drop into a room means, and where it goes from there is
   * the role's business — a light rises to the ceiling of that room, a switch to
   * 1.10 m. Walls and roofs still catch a drop when the ray meets no floor at
   * all, which is what keeps a facade placeable.
   */
  private firstFloorHit(): THREE.Intersection | null {
    for (const hit of this.hits) {
      if (hit.object.userData.part !== 'floor') continue;
      if (!this.isClipped(hit.point, hit.object)) return hit;
    }
    return null;
  }

  private isClipped(point: THREE.Vector3, object: THREE.Object3D): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;

    for (const plane of ctx.clippingPlanes) {
      if (plane.distanceToPoint(point) < -CLIP_EPSILON) return true;
    }

    // Ghosted storeys above the cut get their own plane set rather than the
    // shared one, so check those too.
    const material = (object as THREE.Mesh).material;
    const list = Array.isArray(material) ? material : material ? [material] : [];
    for (const entry of list) {
      const planes = entry.clippingPlanes;
      if (!planes || planes === ctx.clippingPlanes) continue;
      for (const plane of planes) {
        if (plane.distanceToPoint(point) < -CLIP_EPSILON) return true;
      }
    }
    return false;
  }

  private readNormal(hit: THREE.Intersection): void {
    if (!hit.face) {
      this.normal.set(0, 1, 0);
      return;
    }
    this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    this.normal.copy(hit.face.normal).applyMatrix3(this.normalMatrix).normalize();
    // We hit the side facing us, so the normal must oppose the ray; imported
    // models are full of inverted winding.
    if (this.normal.dot(this.raycaster.ray.direction) > 0) this.normal.negate();
  }

  /** See the offset table above. Writes `this.anchor`. */
  private applyRoleOffset(level: LevelDefinition | null): void {
    this.anchor.copy(this.point);
    const facing = this.normal.y;

    if (!this.snapPlacement) {
      // Clear of the surface, and otherwise exactly where it was dropped.
      this.anchor.addScaledVector(this.normal, facing > SURFACE_THRESHOLD ? FLOOR_LIFT : WALL_OFFSET);
      return;
    }

    if (facing < -SURFACE_THRESHOLD) {
      this.anchor.addScaledVector(this.normal, CEILING_DROP);
      return;
    }

    if (facing > SURFACE_THRESHOLD) {
      if (this.role === 'light') {
        this.anchor.y = level
          ? level.elevation + Math.max(level.height - CEILING_DROP, 0.5)
          : this.point.y + FALLBACK_CEILING;
      } else if (this.role === 'switch') {
        this.anchor.y = (level?.elevation ?? this.point.y) + FLOOR_SWITCH_HEIGHT;
      } else {
        this.anchor.y = this.point.y + FLOOR_LIFT;
      }
      return;
    }

    this.anchor.addScaledVector(this.normal, WALL_OFFSET);
    if (!level) return;
    if (this.role === 'switch') this.anchor.y = level.elevation + WALL_SWITCH_HEIGHT;
    else if (this.role === 'light') this.anchor.y = level.elevation + WALL_LIGHT_HEIGHT;
  }

  private isLevelHidden(level: LevelDefinition): boolean {
    const visible = this.model.getVisibleLevels();
    return visible !== null && visible.length > 0 && !visible.includes(level.id);
  }

  private reject(reason: string, level?: LevelDefinition): null {
    this.feedback.point.copy(this.point);
    this.feedback.normal.copy(this.normal);
    this.feedback.anchor.copy(this.point);
    this.feedback.valid = false;
    this.feedback.levelName = level?.name ?? null;
    this.feedback.levelElevation = level?.elevation ?? null;
    this.feedback.reason = reason;
    return null;
  }

  /**
   * How to name the room a world point falls in. Without it every drop is
   * treated as landing outside a room, which is also the correct answer for a
   * model that has no rooms at all.
   */
  setRoomResolver(
    resolver:
      | ((x: number, y: number, z: number, level?: string | null) => string | null)
      | null,
  ): void {
    this.roomAt = resolver;
  }

  /**
   * Which room the *result* should record.
   *
   * Dropped inside a room: none, because the position already says which one,
   * and an override written now would go stale the moment the model changes.
   * Dropped outside: the room it came from — that is the whole gesture of
   * dragging a chip clear of the plan, and it is what makes the leader appear.
   */
  private resolveRoom(level: LevelDefinition | null): string | null {
    if (!this.roomAt) return null;
    // The storey goes with the question: two rooms stacked on top of each other
    // both claim a point near the floor between them, and only the storey says
    // which of the two the drop meant.
    const id = level?.id ?? null;
    const here = this.roomAt(this.anchor.x, this.anchor.y, this.anchor.z, id);
    if (here) return null;
    const from = this.originalPosition;
    return from ? this.roomAt(from[0], from[1], from[2], id) : null;
  }

  /** Opt into fixture-aware drop heights instead of what-you-see placement. */
  setSnapPlacement(value: boolean): void {
    this.snapPlacement = value;
  }

  /**
   * Whether the model is being drawn as a hidden-line wireframe, where no
   * surface is visible and picking the nearest one is meaningless; see
   * `firstFloorHit`.
   */
  setHiddenLine(value: boolean): void {
    this.hiddenLine = value;
  }

  /** Which ink the drop chip is drawn in; see `MarkerAtlas.setGroundDark`. */
  setGroundDark(dark: boolean): void {
    this.indicator.setGroundDark(dark);
  }

  /* ------------------------------------------------------------- internals */

  private start(): void {
    this.indicator.show();
    this.attachKeyListener();

    // The camera must not orbit under a drag: the model would slide out from
    // beneath the cursor mid-placement.
    this.cameraWasEnabled = this.camera.controls.enabled !== false;
    try {
      this.camera.setEnabled(false);
    } catch {
      /* camera failed to initialise; placement still works */
    }

    if (this.ctx && !this.release) this.release = this.ctx.holdContinuous();
    this.emitter.emit('placement-begin', {
      entityId: this.entityId ?? '',
      mode: this.mode ?? 'add',
    });
    this.ctx?.invalidate();
  }

  /** Ends the gesture. A non-null reason also emits `placement-cancel`. */
  private finish(reason: PlacementCancelReason | null): void {
    const entityId = this.entityId ?? '';
    const mode = this.mode ?? 'add';

    if (reason && mode === 'move' && entityId && this.originalPosition) {
      this.entities.moveEntity(entityId, this.originalPosition);
    }
    if (reason && mode === 'label' && entityId && this.originalOffset) {
      (this.entities as IEntityLayer & EntityLayerExtras).setLabelOffset?.(
        entityId,
        this.originalOffset,
      );
    }
    this.labelAnchor = null;
    this.labelOffset = null;
    this.originalOffset = null;

    this.mode = null;
    this.entityId = null;
    this.originalPosition = null;
    this.lastResult = null;
    this.domDrag = false;

    this.indicator.hide();
    this.detachKeyListener();
    this.release?.();
    this.release = null;

    if (this.cameraWasEnabled) {
      try {
        this.camera.setEnabled(true);
      } catch {
        /* see start() */
      }
    }

    if (reason) this.emitter.emit('placement-cancel', { entityId, mode, reason });
    this.ctx?.invalidate();
  }

  private applyPreview(preview: PlacementPreview): void {
    const role = preview.role ?? this.role;
    this.indicator.setGhost({
      icon: resolveIcon(role, null, null, preview.icon),
      label: preview.label,
      color: preview.color,
    });
  }

  private defaultPreview(entityId: string): PlacementPreview {
    return {
      role: entityId ? roleForEntityId(entityId) : 'marker',
      label: entityId ? humaniseEntityId(entityId) : 'New marker',
    };
  }

  private attachKeyListener(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  private detachKeyListener(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this.onKeyDown, true);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.mode === null) return;
    event.stopPropagation();
    this.finish('escape');
  };
}

/* -------------------------------------------------------------- utilities */

function carriesEntity(transfer: DataTransfer): boolean {
  const types = transfer.types;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === ENTITY_DRAG_MIME || types[i] === 'text/plain') return true;
  }
  return false;
}

/** Empty during `dragover` by design — the browser hides the payload there. */
function readEntityId(transfer: DataTransfer): string | null {
  let value = '';
  try {
    value = transfer.getData(ENTITY_DRAG_MIME) || transfer.getData('text/plain');
  } catch {
    return null;
  }
  const trimmed = value.trim();
  // Guard against a stray text drag from elsewhere on the page.
  return /^[a-z_]+\.[a-z0-9_]+$/i.test(trimmed) ? trimmed : null;
}
