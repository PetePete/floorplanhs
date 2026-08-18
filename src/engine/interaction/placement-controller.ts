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

export type PlacementMode = 'add' | 'move';
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
}

/**
 * Optional `EntityLayer` capabilities. `IEntityLayer` does not expose them, but
 * a cancelled move has to put the marker back where it was.
 */
interface EntityLayerExtras {
  getEntityPosition?(entityId: string): Vec3 | null;
  getPlacedEntity?(entityId: string): PlacedEntity | null;
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
  private originalPosition: Vec3 | null = null;
  /** Latched once a drag leaves the building. See `resolve`. */
  private freePlacement = false;
  /** Injected by the Viewer; see `setRoomResolver`. */
  private roomAt: ((x: number, y: number, z: number) => string | null) | null = null;
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
    this.lastResult = null;
    this.applyPreview({
      icon: placed?.marker?.icon,
      label: placed?.name ?? humaniseEntityId(entityId),
      color: placed?.marker?.color,
      role: this.role,
    });
    this.start();
  }

  /** Pointer moved: returns where the entity would land, or null if nowhere. */
  updatePlacement(clientX: number, clientY: number): PlacementResult | null {
    if (this.mode === null) return null;

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

    const hit = this.firstUnclippedHit();

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
    const level = this.model.levelAt(this.point);
    this.hits.length = 0;

    if (level && this.isLevelHidden(level)) {
      return this.reject(`${level.name} is hidden`, level);
    }

    this.applyRoleOffset(level);
    snapToGrid(this.anchor);

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
      room: this.resolveRoom(),
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
      room: this.resolveRoom(),
    };
  }

  /**
   * Which storey a free-placed marker belongs to. The one it already had, so
   * dragging a first-floor sensor out of the window does not quietly move it to
   * the ground floor; otherwise whichever storey is on screen alone, and
   * failing that the one the model puts at the bottom.
   */
  private freeLevel(): LevelDefinition | null {
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
  setRoomResolver(resolver: ((x: number, y: number, z: number) => string | null) | null): void {
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
  private resolveRoom(): string | null {
    if (!this.roomAt) return null;
    const here = this.roomAt(this.anchor.x, this.anchor.y, this.anchor.z);
    if (here) return null;
    const from = this.originalPosition;
    return from ? this.roomAt(from[0], from[1], from[2]) : null;
  }

  /** Opt into fixture-aware drop heights instead of what-you-see placement. */
  setSnapPlacement(value: boolean): void {
    this.snapPlacement = value;
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
