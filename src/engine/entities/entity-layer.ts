/**
 * Owns one `EntityMarker` per placed entity, parented under `ctx.overlayRoot`
 * so nothing here is ever touched by the cross-section clipping planes.
 *
 * `setEntities` is a diff, not a rebuild: a marker that survives a config edit
 * keeps its hover/selection state and does not replay its pop-in. That matters
 * because the card rewrites the whole `entities` array every time the user
 * nudges a single marker.
 */

import * as THREE from 'three';
import type {
  EntityVisualState,
  IEntityLayer,
  RenderContext,
} from '@/engine/contracts';
import type { PlacedEntity, Vec3 } from '@/types/config';
import { EntityMarker, type ScreenRect } from '@/engine/entities/marker';
import { MarkerAtlas } from '@/engine/entities/marker-texture';

export interface EntityLayerOptions {
  /** Fallback accent when neither the config nor HA supplies a colour. */
  accent?: string;
  /**
   * Dim markers that are behind geometry. Off by default: with an exterior
   * camera every interior marker is occluded, which reads as "everything is
   * greyed out" rather than as depth. Turn it on for interior viewpoints.
   */
  occlusion?: boolean;
  /** Occlusion is skipped entirely above this marker count. */
  maxOcclusionMarkers?: number;
}

export interface PickOptions {
  /** Fingers are imprecise; touch gets a ~44 px effective target. */
  pointerType?: 'mouse' | 'touch' | 'pen';
  /** Explicit extra hit padding in CSS px, overriding the pointer default. */
  padding?: number;
}

/** Seconds between occlusion sweeps. */
const OCCLUSION_INTERVAL = 0.2;
/** Markers tested per sweep; the rest wait their turn. */
const OCCLUSION_BUDGET = 8;
/** Ignore hits this close to the marker — the surface it sits on is not an
 *  occluder, otherwise every wall-mounted marker dims itself. */
const OCCLUSION_EPSILON = 0.12;

const _rect: ScreenRect = { x: 0, y: 0, halfWidth: 0, halfHeight: 0, depth: 0 };
const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _direction = new THREE.Vector3();

interface DeclutterEntry {
  marker: EntityMarker;
  x: number;
  y: number;
  halfW: number;
  halfH: number;
  priority: number;
  depth: number;
}

const _declutterVec = new THREE.Vector3();
/** Seconds between label re-flows; see `declutter`. */
const DECLUTTER_INTERVAL = 0.12;

/** True when the point lies on the removed side of any active cut plane. */
function isClipped(point: THREE.Vector3, planes: readonly THREE.Plane[]): boolean {
  for (const plane of planes) {
    if (plane.distanceToPoint(point) < 0) return true;
  }
  return false;
}

export class EntityLayer implements IEntityLayer {
  private readonly markers = new Map<string, EntityMarker>();
  private roomAnchors: ReadonlyMap<string, Vec3> | null = null;
  private readonly group = new THREE.Group();
  private readonly atlas: MarkerAtlas;
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly occluders: THREE.Object3D[] = [];
  private readonly options: Required<EntityLayerOptions>;

  private ctx: RenderContext | null = null;
  private unsubscribeAtlas: (() => void) | null = null;
  private releaseContinuous: (() => void) | null = null;

  private visibleLevels: Set<string> | null = null;
  private markersVisible = true;
  private hovered: string | null = null;
  private selected: string | null = null;
  private editMode = false;

  private occlusionEnabled: boolean;
  private occlusionClock = 0;
  private occlusionCursor = 0;
  private occlusionOrder: string[] = [];

  private disposed = false;

  constructor(options: EntityLayerOptions = {}) {
    this.options = {
      accent: options.accent ?? '#03a9f4',
      occlusion: options.occlusion ?? false,
      maxOcclusionMarkers: options.maxOcclusionMarkers ?? 30,
    };
    this.occlusionEnabled = this.options.occlusion;

    this.group.name = 'entity-layer';
    this.group.userData.noClip = true;
    this.atlas = new MarkerAtlas();
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.overlayRoot.add(this.group);
    this.atlas.setPixelRatio(ctx.size.pixelRatio);
    // A repack invalidates every UV rect that was handed out.
    this.unsubscribeAtlas = this.atlas.onChange(() => {
      for (const marker of this.markers.values()) marker.refreshArt();
      this.ctx?.invalidate();
    });
  }

  resize(_width: number, _height: number): void {
    if (!this.ctx) return;
    // A window dragged onto a retina display changes the effective DPR; the
    // atlas has to be re-rasterised or every label goes soft.
    this.atlas.setPixelRatio(this.ctx.size.pixelRatio);
  }

  update(dt: number, ctx: RenderContext): void {
    if (this.disposed) return;

    const signature = this.clipSignature(ctx.clippingPlanes);
    if (signature !== this.lastClipSignature) {
      this.lastClipSignature = signature;
      this.applyVisibility();
    }

    let animating = false;
    for (const marker of this.markers.values()) {
      if (marker.update(dt, ctx)) animating = true;
    }

    // After the markers have updated, so their pixel footprints are current.
    this.declutterAcc += dt;
    if (this.declutterAcc >= DECLUTTER_INTERVAL) {
      this.declutterAcc = 0;
      this.declutter(ctx);
    }

    this.tickOcclusion(dt, ctx);

    // Rule 4: hold a continuous lease only while something actually moves.
    if (animating && !this.releaseContinuous) {
      this.releaseContinuous = ctx.holdContinuous();
    } else if (!animating && this.releaseContinuous) {
      this.releaseContinuous();
      this.releaseContinuous = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.releaseContinuous?.();
    this.releaseContinuous = null;
    this.unsubscribeAtlas?.();
    this.unsubscribeAtlas = null;

    for (const marker of this.markers.values()) marker.dispose();
    this.markers.clear();

    this.group.removeFromParent();
    this.group.clear();
    this.atlas.dispose();

    this.hits.length = 0;
    this.occluders.length = 0;
    this.occlusionOrder = [];
    this.ctx = null;
  }

  /* --------------------------------------------------------------- content */

  setEntities(entities: PlacedEntity[]): void {
    const seen = new Set<string>();

    for (const placed of entities) {
      if (!placed?.entity) continue;
      // `shape: 'none'` means the user wants the light/binding but no marker.
      if (placed.marker?.shape === 'none') continue;
      seen.add(placed.entity);

      const existing = this.markers.get(placed.entity);
      if (existing) {
        existing.setPlaced(placed);
        // `room` may have changed with the config, so the leader is re-resolved.
        existing.setRoomAnchors(this.roomAnchors);
        continue;
      }

      const marker = new EntityMarker({
        atlas: this.atlas,
        placed,
        accent: this.options.accent,
        animateIn: true,
      });
      marker.setRoomAnchors(this.roomAnchors);
      this.markers.set(placed.entity, marker);
      this.group.add(marker.object);
    }

    for (const [entityId, marker] of [...this.markers]) {
      if (seen.has(entityId)) continue;
      marker.dispose();
      this.markers.delete(entityId);
      if (this.hovered === entityId) this.hovered = null;
      if (this.selected === entityId) this.selected = null;
    }

    this.occlusionOrder = [...this.markers.keys()];
    this.occlusionCursor = 0;
    this.applyVisibility();
    this.ctx?.invalidate();
  }

  updateVisual(entityId: string, visual: EntityVisualState): void {
    const marker = this.markers.get(entityId);
    if (!marker) return;
    marker.setVisual(visual);
    this.ctx?.invalidate();
  }

  moveEntity(entityId: string, position: Vec3): void {
    const marker = this.markers.get(entityId);
    if (!marker) return;
    marker.setPosition(position);
    this.ctx?.invalidate();
  }

  /* ---------------------------------------------------------------- states */

  setHovered(entityId: string | null): void {
    if (this.hovered === entityId) return;
    if (this.hovered) this.markers.get(this.hovered)?.setHovered(false);
    this.hovered = entityId;
    if (entityId) this.markers.get(entityId)?.setHovered(true);
    this.ctx?.invalidate();
  }

  setSelected(entityId: string | null): void {
    if (this.selected === entityId) return;
    if (this.selected) this.markers.get(this.selected)?.setSelected(false);
    this.selected = entityId;
    if (entityId) this.markers.get(entityId)?.setSelected(true);
    this.ctx?.invalidate();
  }

  /**
   * Room positions for the leader lines. Held so a marker created later — a
   * drag-and-drop placement, a config edit — gets them without the viewer
   * having to push again.
   */
  setRoomAnchors(anchors: ReadonlyMap<string, Vec3> | null): void {
    this.roomAnchors = anchors;
    for (const marker of this.markers.values()) marker.setRoomAnchors(anchors);
    this.ctx?.invalidate();
  }

  setVisibleLevels(levelIds: string[] | null): void {
    this.visibleLevels = levelIds && levelIds.length > 0 ? new Set(levelIds) : null;
    this.applyVisibility();
    this.ctx?.invalidate();
  }

  /** Let walls and ceilings hide markers behind them. */
  setDepthTested(enabled: boolean): void {
    if (this.depthTested === enabled) return;
    this.depthTested = enabled;
    for (const marker of this.markers.values()) marker.setDepthTested(enabled);
    this.ctx?.invalidate();
  }

  setMarkersVisible(visible: boolean): void {
    if (this.markersVisible === visible) return;
    this.markersVisible = visible;
    this.applyVisibility();
    this.ctx?.invalidate();
  }

  /** Edit mode currently only affects hit tolerance; kept for the Viewer hook. */
  setEditMode(enabled: boolean): void {
    this.editMode = enabled;
  }

  setAccent(accent: string): void {
    if (this.options.accent === accent) return;
    this.options.accent = accent;
    for (const marker of this.markers.values()) marker.setAccent(accent);
    this.ctx?.invalidate();
  }

  setOcclusionEnabled(enabled: boolean): void {
    if (this.occlusionEnabled === enabled) return;
    this.occlusionEnabled = enabled;
    if (!enabled) for (const marker of this.markers.values()) marker.setOccluded(false);
    this.ctx?.invalidate();
  }

  /* --------------------------------------------------------------- picking */

  /**
   * Frontmost marker under `ndc`, or null.
   *
   * Deliberately screen-space rather than `Raycaster.intersectObjects`: markers
   * are billboards, so their projection is an axis-aligned rectangle and this
   * is exactly as accurate — but it also lets the hit rectangle be *inflated*
   * to a 44 px finger target, which a ray through the sprite quad cannot do.
   */
  pick(ndc: { x: number; y: number }, options?: PickOptions): string | null {
    const ctx = this.ctx;
    if (!ctx || this.markers.size === 0 || !this.markersVisible) return null;

    const { width, height } = ctx.size;
    if (width <= 0 || height <= 0) return null;

    const pointerX = (ndc.x * 0.5 + 0.5) * width;
    const pointerY = (1 - (ndc.y * 0.5 + 0.5)) * height;

    const touch = options?.pointerType === 'touch';
    const minHalf = touch ? 22 : options?.pointerType === 'pen' ? 12 : 8;
    const padding = options?.padding ?? (touch ? 4 : this.editMode ? 3 : 2);

    const camera = ctx.activeCamera;
    camera.updateMatrixWorld();

    let best: string | null = null;
    let bestDepth = Infinity;

    for (const [entityId, marker] of this.markers) {
      if (!marker.getScreenRect(camera, width, height, _rect)) continue;
      const halfWidth = Math.max(_rect.halfWidth, minHalf) + padding;
      const halfHeight = Math.max(_rect.halfHeight, minHalf) + padding;
      if (Math.abs(pointerX - _rect.x) > halfWidth) continue;
      if (Math.abs(pointerY - _rect.y) > halfHeight) continue;
      if (_rect.depth >= bestDepth) continue;
      bestDepth = _rect.depth;
      best = entityId;
    }

    return best;
  }

  /* ------------------------------------------------------------ inspection */

  getAtlas(): MarkerAtlas {
    return this.atlas;
  }

  getEntityIds(): string[] {
    return [...this.markers.keys()];
  }

  hasEntity(entityId: string): boolean {
    return this.markers.has(entityId);
  }

  getHovered(): string | null {
    return this.hovered;
  }

  getSelected(): string | null {
    return this.selected;
  }

  /** Anchor position of a placed marker; used to restore a cancelled move. */
  getEntityPosition(entityId: string): Vec3 | null {
    const marker = this.markers.get(entityId);
    if (!marker) return null;
    const p = marker.object.position;
    return [p.x, p.y, p.z];
  }

  getPlacedEntity(entityId: string): PlacedEntity | null {
    return this.markers.get(entityId)?.placed ?? null;
  }

  /* ------------------------------------------------------------- internals */

  private depthTested = true;
  private lastClipSignature = '';
  private declutterAcc = 0;
  private readonly declutterEntries: DeclutterEntry[] = [];

  /**
   * Hide the labels of markers that would be drawn on top of a more important
   * one. Without this a handful of entities in the same room turn into an
   * unreadable stack — the review found "Living room TV" completely buried
   * under two others at the default viewpoint.
   *
   * Screen-space, greedy, highest priority first: whoever gets there first
   * keeps the space, everyone overlapping them collapses to a dot. Run at
   * ~8 Hz rather than per frame; labels do not need to re-flow at 60 fps, and
   * a slower cadence also stops two markers flickering as they cross.
   */
  private declutter(ctx: RenderContext): void {
    const { width, height } = ctx.size;
    if (width < 2 || height < 2) return;

    const entries = this.declutterEntries;
    entries.length = 0;

    // A collapsed label only appears once a frame is drawn, and with on-demand
    // rendering nothing else may ask for one.
    let changed = false;

    for (const marker of this.markers.values()) {
      if (!marker.isPickable()) {
        changed = marker.setCrowded(false) || changed;
        continue;
      }
      _declutterVec.copy(marker.worldPosition).project(ctx.activeCamera);
      // Behind the camera: project() mirrors the point, so trust nothing.
      if (_declutterVec.z > 1) {
        changed = marker.setCrowded(false) || changed;
        continue;
      }
      const size = marker.labelSizePx;
      entries.push({
        marker,
        x: (_declutterVec.x * 0.5 + 0.5) * width,
        y: (-_declutterVec.y * 0.5 + 0.5) * height,
        halfW: Math.max(size.width, 60) / 2,
        halfH: Math.max(size.height, 22) / 2,
        priority: marker.declutterPriority,
        depth: _declutterVec.z,
      });
    }

    // Priority first, then nearest — a near marker is the one you are looking
    // at, and letting a distant one win would read as random.
    entries.sort((a, b) => b.priority - a.priority || a.depth - b.depth);

    const kept: DeclutterEntry[] = [];
    for (const entry of entries) {
      let blocked = false;
      for (const other of kept) {
        if (
          Math.abs(entry.x - other.x) < entry.halfW + other.halfW &&
          Math.abs(entry.y - other.y) < entry.halfH + other.halfH
        ) {
          blocked = true;
          break;
        }
      }
      changed = entry.marker.setCrowded(blocked) || changed;
      if (!blocked) kept.push(entry);
    }

    if (changed) ctx.invalidate();
  }

  private applyVisibility(): void {
    const planes = this.ctx?.clippingPlanes ?? [];
    for (const marker of this.markers.values()) {
      const level = marker.levelId;
      const levelVisible = !this.visibleLevels || !level || this.visibleLevels.has(level);
      // Markers live under `overlayRoot` and are deliberately never clipped by
      // the renderer, otherwise a pill would be sliced in half. But an entity
      // whose room has been cut away must not keep floating in the void, so we
      // test its anchor against the active cut planes by hand.
      marker.setLevelVisible(levelVisible && !isClipped(marker.worldPosition, planes));
      marker.setLayerVisible(this.markersVisible);
    }
  }

  /**
   * Cut planes are mutated in place by the section controller, so there is no
   * change event to subscribe to; a cheap per-frame signature is both simpler
   * and more robust than trying to wire one up.
   */
  private clipSignature(planes: readonly THREE.Plane[]): string {
    let out = '';
    for (const plane of planes) {
      out += `${plane.normal.x},${plane.normal.y},${plane.normal.z},${plane.constant};`;
    }
    return out;
  }

  /**
   * Throttled, budgeted occlusion test. One ray per marker from the camera; a
   * hit closer than the marker means a wall is in the way. Capped hard because
   * this is the only part of the layer whose cost scales with scene complexity.
   */
  private tickOcclusion(dt: number, ctx: RenderContext): void {
    if (!this.occlusionEnabled) return;
    if (this.markers.size === 0 || this.markers.size > this.options.maxOcclusionMarkers) return;

    this.occlusionClock += dt;
    if (this.occlusionClock < OCCLUSION_INTERVAL) return;
    this.occlusionClock = 0;

    this.occluders.length = 0;
    collectVisibleMeshes(ctx.modelRoot, this.occluders);
    if (this.occluders.length === 0) return;

    const camera = ctx.activeCamera;
    camera.updateMatrixWorld();
    _origin.setFromMatrixPosition(camera.matrixWorld);

    const count = Math.min(OCCLUSION_BUDGET, this.occlusionOrder.length);
    for (let i = 0; i < count; i += 1) {
      if (this.occlusionOrder.length === 0) break;
      this.occlusionCursor = (this.occlusionCursor + 1) % this.occlusionOrder.length;
      const marker = this.markers.get(this.occlusionOrder[this.occlusionCursor]);
      if (!marker || !marker.isPickable()) continue;

      marker.getBodyWorldPosition(_target);
      _direction.copy(_target).sub(_origin);
      const distance = _direction.length();
      if (distance < 1e-3) continue;
      _direction.divideScalar(distance);

      this.raycaster.set(_origin, _direction);
      this.raycaster.near = 0;
      this.raycaster.far = distance - OCCLUSION_EPSILON;
      this.hits.length = 0;
      this.raycaster.intersectObjects(this.occluders, false, this.hits);
      marker.setOccluded(this.hits.length > 0);
    }
    this.hits.length = 0;
  }
}

/**
 * three r170's `Raycaster` no longer skips invisible objects, so a hidden
 * storey would still register as an occluder. Filter here instead.
 */
function collectVisibleMeshes(root: THREE.Object3D, out: THREE.Object3D[]): void {
  if (!root.visible) return;
  const mesh = root as THREE.Mesh;
  if (mesh.isMesh && root.userData.fp3dInternal !== true) out.push(root);
  for (const child of root.children) collectVisibleMeshes(child, out);
}
