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

import { CELL_PADDING } from '@/engine/entities/marker-texture';
import { HEADER_PX, StackFrame } from '@/engine/entities/stack-frame';
import { worldUnitsPerPixel } from '@/engine/entities/marker';

/** Matches the marker's own resting lift; see `EntityMarker`. */
const DEFAULT_LABEL_LIFT_M = 0.34;
/** Air between two rows of a pile, in screen pixels. */
const STACK_ROW_GAP_PX = 6;
/** However small the chips, the rows keep a finger's worth of pitch. */
const STACK_ROW_MIN_PX = 30;
const _framePoint = new THREE.Vector3();
const _frameProject = new THREE.Vector3();
const _frameUp = new THREE.Vector3();

/** Slack around a stack's frame, so the pile catches a near miss. */
const STACK_FRAME_PAD_PX = 6;

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

/** Which part of a marker a pointer is on; see `EntityLayer.pickPart`. */
export type MarkerPart = 'anchor' | 'label' | 'stack';

export interface PickedPart {
  entityId: string;
  part: MarkerPart;
  /** The pile that entity is on, if any. Set for every part, not just `stack`. */
  stackId: string | null;
}

export interface PickOptions {
  /** Fingers are imprecise; touch gets a ~44 px effective target. */
  pointerType?: 'mouse' | 'touch' | 'pen';
  /**
   * Entity to look past.
   *
   * A marker being dragged sits under the cursor by definition, so without this
   * it wins every hit test and hides whatever you are dragging it onto — which
   * is the one thing the test is being asked about.
   */
  ignore?: string;
  /** Explicit extra hit padding in CSS px, overriding the pointer default. */
  padding?: number;
}

/** Seconds between occlusion sweeps. */
const OCCLUSION_INTERVAL = 0.2;

const _point = { x: 0, y: 0, depth: 0 };
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

/** Seconds between label re-flows; see `declutter`. */
const DECLUTTER_INTERVAL = 0.12;

/** True when the point lies on the removed side of any active cut plane. */
function isClipped(point: THREE.Vector3, planes: readonly THREE.Plane[]): boolean {
  for (const plane of planes) {
    if (plane.distanceToPoint(point) < 0) return true;
  }
  return false;
}

/**
 * The top edge of a pile's screen box, grab bar included when there is one.
 *
 * Two hit tests want it and they must agree, or a pointer can be inside the
 * pile for one of them and outside for the other — which is a drag that reads
 * "take it out" and then puts it back.
 *
 * Outside edit mode there is no bar to include: it is not drawn, not reachable,
 * and takes up no room. The box then sits exactly around the rows, which is
 * where it sits in edit mode too — the bar rides above it and its going changes
 * nothing about the box.
 */
export function frameTop(rect: {
  y: number;
  halfHeight: number;
  headerY: number;
  headerHalfHeight: number;
  grabBar: boolean;
}): number {
  return rect.grabBar ? rect.headerY - rect.headerHalfHeight : rect.y - rect.halfHeight;
}

export class EntityLayer implements IEntityLayer {
  private readonly markers = new Map<string, EntityMarker>();
  /** Members per stack id, in list order; see `fanStacks`. */
  private readonly stacks = new Map<string, string[]>();
  private readonly frames = new Map<string, StackFrame>();
  /** Screen box of each stack's frame, refreshed per frame; see `pick`. */
  private readonly frameRects = new Map<
    string,
    {
      base: string;
      x: number;
      y: number;
      halfWidth: number;
      halfHeight: number;
      headerY: number;
      headerHalfHeight: number;
      /** Whether a grab bar is drawn at all; see `setEditMode`. */
      grabBar: boolean;
      /** Screen y of the bottom row's centre, and the spacing above it. */
      bottomY: number;
      pitch: number;
      count: number;
    }
  >();
  /** Last list `setEntities` was given; re-fanned when a drag leaves a pile. */
  private lastEntities: PlacedEntity[] = [];
  /** Drawn as if it had left its pile for the length of a drag; see `setDraggedOut`. */
  private draggedOut: string | null = null;
  /** The house's own ink; a pile with no colour of its own is drawn in it. */
  private stackInk: string | null = null;
  /** A row drawn at a place the config does not put it yet; see `setRowPreview`. */
  private previewEntity: string | null = null;
  private previewRow = 0;
  /** The pile a release would land on; see `setStackHighlight`. */
  private highlightStack: string | null = null;
  private roomAnchors: ReadonlyMap<string, Vec3> | null = null;
  private levelOffsets: ReadonlyMap<string, number> | null = null;
  /**
   * The last state pushed for each entity, marker or no marker.
   *
   * A state push can land before the entity list does — the viewer sets itself
   * up, then spends a second or two loading the model, and Home Assistant does
   * not wait. The push was being dropped on the floor, and because the viewer
   * marks that state as delivered it never came again: the lamp lit its room
   * and its chip sat there grey until somebody switched the lamp. Kept here, it
   * is handed to the marker the moment one exists.
   */
  private readonly visuals = new Map<string, EntityVisualState>();
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
    this.updateStackFrames(ctx);

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
    this.visuals.clear();

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
    this.lastEntities = entities;

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
        existing.setLevelOffsets(this.levelOffsets);
        continue;
      }

      const marker = new EntityMarker({
        atlas: this.atlas,
        placed,
        accent: this.options.accent,
        animateIn: true,
        visual: this.visuals.get(placed.entity) ?? null,
      });
      marker.setRoomAnchors(this.roomAnchors);
      marker.setLevelOffsets(this.levelOffsets);
      this.markers.set(placed.entity, marker);
      this.group.add(marker.object);
    }

    for (const [entityId, marker] of [...this.markers]) {
      if (seen.has(entityId)) continue;
      marker.dispose();
      this.markers.delete(entityId);
      this.visuals.delete(entityId);
      if (this.hovered === entityId) this.hovered = null;
      if (this.selected === entityId) this.selected = null;
    }

    this.fanStacks(entities);
    this.occlusionOrder = [...this.markers.keys()];
    this.occlusionCursor = 0;
    this.applyVisibility();
    this.ctx?.invalidate();
  }

  /**
   * Draw the dashed rectangle around each stack.
   *
   * After the markers have updated, so their rows and pixel footprints are the
   * ones on screen this frame. The frame is what tells you a stack is a stack:
   * chips near each other look like chips near each other, and the one thing
   * you want to know after dragging two together is whether it took.
   */
  private updateStackFrames(ctx: RenderContext): void {
    const alive = new Set<string>();

    for (const [id, members] of this.stacks) {
      const visible = members.filter((entityId) => this.markers.get(entityId)?.object.visible);
      if (visible.length < 2) continue;

      let width = 0;
      let rows = 0;
      let anchor: THREE.Vector3 | null = null;
      for (const entityId of visible) {
        const marker = this.markers.get(entityId);
        if (!marker) continue;
        const size = marker.labelSizePx;
        width = Math.max(width, size.width - CELL_PADDING * 2);
        rows = Math.max(rows, size.height - CELL_PADDING * 2);
        if (!anchor) anchor = marker.object.position;
      }
      if (!anchor || width <= 0) continue;

      // The pitch is the tallest chip in this pile plus a hair of air, measured
      // rather than assumed: a long name or a wordy state makes a taller chip,
      // and a fixed pitch then has the rows sitting on one another.
      const pitch = Math.max(STACK_ROW_MIN_PX, rows + STACK_ROW_GAP_PX);
      visible.forEach((entityId, index) => {
        this.markers.get(entityId)?.setStackIndex(index, visible.length, pitch);
      });

      const marker = this.markers.get(visible[0]);
      if (!marker) continue;

      // The rows run from the first label up; the box covers all of them.
      const spread = pitch * (visible.length - 1);
      const height = rows + spread;
      // The rows run up the screen from the bottom of the box; `rowUnder` turns
      // a pointer back into one of them.
      const bottomRowY = rows / 2;
      const unit = worldUnitsPerPixel(ctx.activeCamera, marker.getBodyWorldPosition(_framePoint), ctx.size.height);

      // The pile's own ink, if it was given one. Read off the members, so it
      // survives whichever of them happens to be the first row.
      // The pile's own ink, if it was given one; otherwise the house's. A frame
      // in the accent shouts over a hidden-line drawing — the box is a note on
      // the drawing, and a note is written in the same ink as the drawing.
      const ink =
        visible
          .map((entityId) => this.markers.get(entityId)?.placed.stackColor)
          .find((color): color is string => typeof color === 'string' && color.length > 0) ??
        this.stackInk ??
        this.options.accent ??
        '#03a9f4';

      let frame = this.frames.get(id);
      // A canvas is the only way to paint a dashed rectangle here, and a node
      // harness has none. No frame is better than no card.
      if (!frame && typeof document === 'undefined') continue;
      if (!frame) {
        frame = new StackFrame(ink);
        this.frames.set(id, frame);
        this.group.add(frame.sprite);
      }
      // Centre of the box: half the spread above the first row, up the screen
      // rather than up the house — the rows travel that way, so the frame must
      // too, or it stands taller than its own contents and lists to one side.
      _frameUp.setFromMatrixColumn(ctx.activeCamera.matrixWorld, 1).normalize();
      _framePoint.addScaledVector(_frameUp, (spread / 2) * unit);
      frame.update(
        _framePoint,
        { width, height },
        unit,
        ink,
        ctx.size.pixelRatio,
        _frameUp,
        id === this.highlightStack,
        this.editMode,
      );
      alive.add(id);

      // The frame is also the pile's drop area: everything inside it belongs to
      // the stack, including the air between the rows. Aiming at a row when you
      // mean "onto this pile" is aiming at the wrong thing.
      _frameProject.copy(_framePoint).project(ctx.activeCamera);
      const screenX = (_frameProject.x * 0.5 + 0.5) * ctx.size.width;
      const screenY = (1 - (_frameProject.y * 0.5 + 0.5)) * ctx.size.height;
      this.frameRects.set(id, {
        base: visible[0],
        x: screenX,
        y: screenY,
        halfWidth: width / 2 + STACK_FRAME_PAD_PX,
        halfHeight: height / 2 + STACK_FRAME_PAD_PX,
        // The grab bar, in the same screen coordinates: it sits directly above
        // the rows, which is where the frame's own top edge is.
        grabBar: this.editMode,
        // Where the bar is painted, and only meaningful when one is. Kept as a
        // number either way so the arithmetic has nothing to special-case; what
        // guards it is `grabBar`.
        headerY: screenY - height / 2 - STACK_FRAME_PAD_PX - HEADER_PX / 2,
        headerHalfHeight: HEADER_PX / 2 + 3,
        bottomY: screenY + height / 2 - bottomRowY,
        pitch,
        count: visible.length,
      });
    }

    for (const [id, frame] of [...this.frames]) {
      if (alive.has(id)) continue;
      frame.dispose();
      this.frames.delete(id);
      this.frameRects.delete(id);
    }
    for (const id of [...this.frameRects.keys()]) {
      if (!alive.has(id)) this.frameRects.delete(id);
    }
  }

  /**
   * Number the labels of a stack, so each draws itself one row higher.
   *
   * A stack is several markers in one spot, so without this they draw one on
   * top of another and the pile reads as a single marker with a suspiciously
   * bold outline. The lift is display only — the config says which markers are
   * stacked, and how they are drawn is ours to decide. A label the user has
   * dragged somewhere keeps its own offset: that was a deliberate placement and
   * outranks our tidying.
   */
  private fanStacks(entities: PlacedEntity[]): void {
    this.stacks.clear();

    // The piles first, in config order, so a row can be moved within one before
    // anything is placed by its index.
    for (const placed of entities) {
      if (!this.markers.has(placed.entity)) continue;
      if (placed.marker?.offset && !placed.stack) continue;
      const stack = this.stackOfPlaced(placed);
      if (!stack) continue;
      const members = this.stacks.get(stack) ?? [];
      members.push(placed.entity);
      this.stacks.set(stack, members);
    }
    this.applyRowPreview();

    for (const placed of entities) {
      const marker = this.markers.get(placed.entity);
      if (!marker) continue;
      // A member of a stack is placed by its row, not by an offset it may still
      // carry from when it stood on its own.
      if (placed.marker?.offset && !placed.stack) continue;
      if (this.stackOfPlaced(placed)) continue;
      marker.setLabelOffset([0, DEFAULT_LABEL_LIFT_M, 0]);
      marker.setStackIndex(0, 1);
    }

    for (const members of this.stacks.values()) {
      members.forEach((entityId, index) => {
        const marker = this.markers.get(entityId);
        if (!marker) return;
        marker.setLabelOffset([0, DEFAULT_LABEL_LIFT_M, 0]);
        marker.setStackIndex(index, members.length);
      });
    }
  }

  /**
   * Show a row where the drag says it is going, rather than where the config
   * still has it.
   *
   * A reorder you cannot see until you let go is a guess, and the pile is a
   * list you are reading — the whole point of moving a row is to see the list
   * come out in the new order.
   */
  private applyRowPreview(): void {
    const entityId = this.previewEntity;
    if (!entityId) return;
    for (const [id, members] of this.stacks) {
      const from = members.indexOf(entityId);
      if (from < 0) continue;
      const to = Math.max(0, Math.min(members.length - 1, this.previewRow));
      if (from === to) return;
      const next = [...members];
      next.splice(from, 1);
      next.splice(to, 0, entityId);
      this.stacks.set(id, next);
      return;
    }
  }

  /** The pile a marker is drawn on — none while it is being dragged out of it. */
  private stackOfPlaced(placed: PlacedEntity): string | null {
    if (!placed.stack) return null;
    return placed.entity === this.draggedOut ? null : placed.stack;
  }

  updateVisual(entityId: string, visual: EntityVisualState): void {
    // Recorded whether or not there is a marker to put it on; see `visuals`.
    this.visuals.set(entityId, visual);
    const marker = this.markers.get(entityId);
    if (!marker) return;
    marker.setVisual(visual);
    this.ctx?.invalidate();
  }

  /** What the marker is currently drawn from, for tests and for the inspector. */
  getVisual(entityId: string): EntityVisualState | null {
    return this.markers.get(entityId)?.currentVisual() ?? null;
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

  setLevelOffsets(offsets: ReadonlyMap<string, number> | null): void {
    this.levelOffsets = offsets;
    for (const marker of this.markers.values()) marker.setLevelOffsets(offsets);
    this.ctx?.invalidate();
  }

  setVisibleLevels(levelIds: string[] | null): void {
    this.visibleLevels = levelIds && levelIds.length > 0 ? new Set(levelIds) : null;
    this.applyVisibility();
    this.ctx?.invalidate();
  }

  /**
   * Which ink the marker art is drawn in. The atlas is thrown away and redrawn,
   * so this is a theme switch and nothing finer-grained.
   */
  setGroundDark(dark: boolean): void {
    this.atlas.setGroundDark(dark);
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

  /**
   * Edit mode changes what a pile offers to the hand.
   *
   * The grab bar is a handle for rearranging, so on a card nobody can rearrange
   * it is a control that does nothing — and on a floorplan hanging on a wall,
   * one more thing in front of the drawing. The dashed frame stays: that says
   * these markers are one place in the house, which is true either way.
   */
  setEditMode(enabled: boolean): void {
    if (this.editMode === enabled) return;
    this.editMode = enabled;
    // Thrown away rather than repainted. A frame holds a canvas it only redraws
    // when its own key changes, and a stale grip on a card nobody can edit is
    // exactly the thing this switch exists to prevent — so the cheap, certain
    // move is to let the next frame build them again from scratch.
    for (const [id, frame] of this.frames) {
      frame.dispose();
      this.frames.delete(id);
      this.frameRects.delete(id);
    }
    this.ctx?.invalidate();
  }

  /**
   * The ink the model's line work is drawn in.
   *
   * A stack's frame is a note on the drawing rather than a control, so unless a
   * pile has been given a colour of its own it is written in the same ink as
   * the lines it sits over — which also means it follows the palette, the
   * theme and a configured `edgeColor` without knowing about any of them.
   */
  setStackInk(color: string | null): void {
    if (this.stackInk === color) return;
    this.stackInk = color;
    this.ctx?.invalidate();
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
  /**
   * Which part of a marker is under `ndc`: the anchor, or the label.
   *
   * The anchor is the entity itself — where a lamp hangs and where its light
   * comes from. The label is the thing you read, and it may have been pushed
   * aside to somewhere legible. One gesture cannot mean both, so the answer to
   * "what did I just grab" has to come from the geometry.
   *
   * The anchor wins ties: it is the smaller target of the two and sits under the
   * label when nothing has been pushed anywhere, so the label would otherwise
   * take every hit.
   */
  pickPart(ndc: { x: number; y: number }, options?: PickOptions): PickedPart | null {
    const ctx = this.ctx;
    if (!ctx || this.markers.size === 0 || !this.markersVisible) return null;
    const { width, height } = ctx.size;
    if (width <= 0 || height <= 0) return null;

    const pointerX = (ndc.x * 0.5 + 0.5) * width;
    const pointerY = (1 - (ndc.y * 0.5 + 0.5)) * height;
    const touch = options?.pointerType === 'touch';
    // The anchor is drawn as a small dot, because a big one would clutter the
    // plan — so its target is a matter of hit testing rather than of paint.
    const reach = touch ? 26 : 18;

    const camera = ctx.activeCamera;
    camera.updateMatrixWorld();

    // The pile's grab bar first: it is drawn as a handle, so it behaves as one.
    // It is also the only part of a pile that means "all of this", which is why
    // it exists — a row means that one marker, and the shared dot is a dot.
    for (const [stackId, rect] of this.frameRects) {
      if (!rect.grabBar) continue;
      if (Math.abs(pointerX - rect.x) > rect.halfWidth) continue;
      if (Math.abs(pointerY - rect.headerY) > rect.headerHalfHeight) continue;
      return { entityId: rect.base, part: 'stack', stackId };
    }

    // The label wins a tie. From some angles the anchor sits behind its own
    // chip, and then aiming at the chip — the thing you can see — would pick up
    // the entity instead of its caption. What you point at is what you get; the
    // dot is reachable everywhere the chip is not, which is most of the plan.
    const label = this.pick(ndc, options);
    if (label) return { entityId: label, part: 'label', stackId: this.stackIdOf(label) };

    let best: string | null = null;
    let bestDepth = Infinity;
    for (const [entityId, marker] of this.markers) {
      if (entityId === options?.ignore) continue;
      if (!marker.getAnchorScreenPoint(camera, width, height, _point)) continue;
      if (Math.hypot(pointerX - _point.x, pointerY - _point.y) > reach) continue;
      if (_point.depth >= bestDepth) continue;
      bestDepth = _point.depth;
      best = entityId;
    }
    return best ? { entityId: best, part: 'anchor', stackId: this.stackIdOf(best) } : null;
  }

  /**
   * The pile whose frame the pointer is inside, or null.
   *
   * The frame is the pile's drop area — the box is drawn around the whole list
   * precisely to say "this is one thing", and the air between two rows is as
   * much part of it as the rows. Aiming at a particular chip when you mean
   * "onto this pile" is aiming at the wrong thing, and on a pile of two that is
   * a target eight pixels tall.
   *
   * Nearest first, by the frame's own depth, so two piles that overlap on
   * screen resolve the way everything else does.
   */
  stackUnder(
    ndc: { x: number; y: number },
    options?: { ignore?: string },
  ): { stackId: string; base: string } | null {
    const ctx = this.ctx;
    if (!ctx || !this.markersVisible) return null;
    const pointerX = (ndc.x * 0.5 + 0.5) * ctx.size.width;
    const pointerY = (1 - (ndc.y * 0.5 + 0.5)) * ctx.size.height;

    for (const [stackId, rect] of this.frameRects) {
      if (Math.abs(pointerX - rect.x) > rect.halfWidth) continue;
      // The grab bar counts as part of the pile: it is the part of it that
      // means "all of this".
      if (pointerY > rect.y + rect.halfHeight) continue;
      if (pointerY < frameTop(rect)) continue;
      const members = this.stacks.get(stackId) ?? [];
      const base = members.find((entityId) => entityId !== options?.ignore) ?? rect.base;
      if (base === options?.ignore) continue;
      return { stackId, base };
    }
    return null;
  }

  /**
   * Which row of a pile the pointer is over, counting from the bottom.
   *
   * Clamped rather than refused past either end: a drag that runs above the top
   * of the pile means the top of the pile, which is what the hand is saying.
   * Null only when there is no such pile on screen to count rows in.
   */
  rowUnder(ndc: { x: number; y: number }, stackId: string): number | null {
    const ctx = this.ctx;
    const rect = this.frameRects.get(stackId);
    if (!ctx || !rect || rect.pitch <= 0) return null;
    const pointerY = (1 - (ndc.y * 0.5 + 0.5)) * ctx.size.height;
    const row = Math.round((rect.bottomY - pointerY) / rect.pitch);
    return Math.max(0, Math.min(rect.count - 1, row));
  }

  /**
   * Draw a pile as if one of its rows had already moved. `null` puts it back.
   *
   * The config still says what it said; the drag decides whether that changes.
   */
  setRowPreview(entityId: string | null, row = 0): void {
    if (this.previewEntity === entityId && this.previewRow === row) return;
    this.previewEntity = entityId;
    this.previewRow = row;
    this.fanStacks(this.lastEntities);
    this.ctx?.invalidate();
  }

  /** The pile a marker is on, as the config currently states it. */
  stackIdOf(entityId: string): string | null {
    return this.markers.get(entityId)?.placed.stack ?? null;
  }

  /** Everyone on a pile, in the order the config lists them. */
  getStackMembers(stackId: string): string[] {
    return [...(this.stacks.get(stackId) ?? [])];
  }

  /**
   * Is the pointer still on the pile `stackId` — over one of its rows, or in
   * the air between them?
   *
   * This is the hysteresis that makes taking a marker out of a pile a decision
   * rather than an accident. Without it any drag past the six-pixel threshold
   * pulled a member out and moved it three centimetres, so a pile could not be
   * touched without falling apart.
   */
  overStack(ndc: { x: number; y: number }, stackId: string, options?: PickOptions): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const { width, height } = ctx.size;
    if (width <= 0 || height <= 0) return false;

    const pointerX = (ndc.x * 0.5 + 0.5) * width;
    const pointerY = (1 - (ndc.y * 0.5 + 0.5)) * height;

    const frame = this.frameRects.get(stackId);
    if (
      frame &&
      Math.abs(pointerX - frame.x) <= frame.halfWidth &&
      pointerY <= frame.y + frame.halfHeight &&
      pointerY >= frameTop(frame)
    ) {
      return true;
    }

    // A pile of two that has just given one up has no frame left to test — the
    // one remaining row is the whole of it, so its chip is the target.
    const camera = ctx.activeCamera;
    camera.updateMatrixWorld();
    const touch = options?.pointerType === 'touch';
    const slack = touch ? 22 : 12;
    for (const entityId of this.stacks.get(stackId) ?? []) {
      if (entityId === options?.ignore) continue;
      const marker = this.markers.get(entityId);
      if (!marker?.getScreenRect(camera, width, height, _rect)) continue;
      if (Math.abs(pointerX - _rect.x) > _rect.halfWidth + slack) continue;
      if (Math.abs(pointerY - _rect.y) > _rect.halfHeight + slack) continue;
      return true;
    }
    return false;
  }

  /**
   * Draw one pile as the thing a release would land on.
   *
   * The frame is already the answer to "is this a pile"; lit up it also answers
   * "is this the pile I am about to drop on", which is the question being asked
   * while the pointer is still down.
   */
  setStackHighlight(stackId: string | null): void {
    if (this.highlightStack === stackId) return;
    this.highlightStack = stackId;
    this.ctx?.invalidate();
  }

  /**
   * Draw this marker as if it had already left its pile.
   *
   * Display only, and for the length of one drag: the pile closes up behind it
   * and the marker travels as a marker on its own, so what a release will do is
   * visible rather than described. The config still says what it said; nothing
   * here is written anywhere.
   */
  setDraggedOut(entityId: string | null): void {
    if (this.draggedOut === entityId) return;
    this.draggedOut = entityId;
    this.fanStacks(this.lastEntities);
    this.ctx?.invalidate();
  }

  /** Live label drag; the placed entity is only rewritten once it is dropped. */
  setLabelOffset(entityId: string, offset: Vec3): void {
    this.markers.get(entityId)?.setLabelOffset(offset);
    this.ctx?.invalidate();
  }

  getLabelOffset(entityId: string): Vec3 | null {
    return this.markers.get(entityId)?.getLabelOffset() ?? null;
  }

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
      if (entityId === options?.ignore) continue;
      if (!marker.getScreenRect(camera, width, height, _rect)) continue;
      const halfWidth = Math.max(_rect.halfWidth, minHalf) + padding;
      const halfHeight = Math.max(_rect.halfHeight, minHalf) + padding;
      if (Math.abs(pointerX - _rect.x) > halfWidth) continue;
      if (Math.abs(pointerY - _rect.y) > halfHeight) continue;
      if (_rect.depth >= bestDepth) continue;
      bestDepth = _rect.depth;
      best = entityId;
    }
    if (best) return best;

    // Nothing under the pointer, but it may still be inside a pile's frame —
    // the air between the rows is part of the pile, and that is where anyone
    // aims when they mean "onto this stack".
    for (const [id, rect] of this.frameRects) {
      if (options?.ignore && this.stacks.get(id)?.includes(options.ignore)) continue;
      if (Math.abs(pointerX - rect.x) > rect.halfWidth) continue;
      if (Math.abs(pointerY - rect.y) > rect.halfHeight) continue;
      return rect.base;
    }

    return null;
  }

  /* ------------------------------------------------------------ inspection */

  getAtlas(): MarkerAtlas {
    return this.atlas;
  }

  /** Every placed entity as configured; the placement controller stacks with it. */
  getPlacedEntities(): PlacedEntity[] {
    return [...this.markers.values()].map((marker) => marker.placed);
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
    return this.markers.get(entityId)?.configPosition ?? null;
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
      // The label floats above its anchor, so the overlap test has to be run
      // where the label actually is. Projecting the anchor and then measuring
      // the *label* around it compares two different points, and hides labels
      // that are nowhere near each other — while letting overlapping ones
      // through whenever their anchors happen to be far apart.
      if (!marker.getScreenRect(ctx.activeCamera, width, height, _rect)) {
        changed = marker.setCrowded(false) || changed;
        continue;
      }
      entries.push({
        marker,
        x: _rect.x,
        y: _rect.y,
        halfW: Math.max(_rect.halfWidth, 30),
        halfH: Math.max(_rect.halfHeight, 11),
        priority: marker.declutterPriority,
        depth: _rect.depth,
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
