/**
 * The visual for one placed entity.
 *
 * Anatomy, bottom to top:
 *
 *     ( o )   <- anchor crosshair, on the surface the user dropped on
 *       |     <- leader, vertical in world space
 *   [ o Name ]<- pill: icon + name + state, billboarded
 *
 * The leader is what makes a floating billboard read as "attached to that spot"
 * rather than "somewhere in this general direction", which matters a lot once
 * the camera orbits.
 *
 * It has a second, longer form. An entity that names a `room` it is not
 * standing in — a temperature sensor parked outside the plan, say — extends the
 * leader from its anchor across to that room, the way a drawing labels a part
 * it has no space to write inside:
 *
 *   [ o Kitchen 21.4° ]
 *      |
 *      +--------------o   <- the room it is talking about
 */

import * as THREE from 'three';
import type { EntityVisualState, RenderContext } from '@/engine/contracts';
import type { EntityRole, MarkerConfig, PlacedEntity, Vec3 } from '@/types/config';
import { clamp, damp, easeOutBack } from '@/util/math';
import { resolveIcon, roleForEntityId } from '@/engine/entities/icons';
import { anchorKey } from '@/engine/model/room-anchors';
import {
  CELL_PADDING,
  type AtlasCell,
  type MarkerAtlas,
  type MarkerSpec,
  type MarkerVisualState,
} from '@/engine/entities/marker-texture';

/* ----------------------------------------------------------------- tuning */

/**
 * How far a marker has to sit from the room it names before the leader across
 * to that room is worth drawing. Inside the room the line says nothing and
 * merely crosses the plan.
 */
const ROOM_LEADER_MIN_M = 0.6;

/** Metres the pill floats above its anchor when no offset is configured. */
const DEFAULT_LIFT = 0.34;

/** Screen pixels between the labels of one stack: a chip and a hair of air. */
const STACK_ROW_PX = 34;

/** A stack's anchor is a handle, so it is drawn as one. */
const STACK_ANCHOR_SCALE = 1.5;
/** Extra lift while hovered — the marker "pops off" the surface. */
const HOVER_LIFT = 0.05;
const POP_DURATION = 0.3;
/** Damping rate for state blends; ~150 ms to settle. */
const STATE_LAMBDA = 20;
/** World metres per logical pixel for markers that scale with distance. */
const SCALED_UNIT = 0.02;
/** Opacity multiplier while a marker is behind geometry. */
const OCCLUDED_ALPHA = 0.3;
const MUTED_ALPHA = 0.75;

const RENDER_ORDER_LEADER = 3000;
const RENDER_ORDER_ANCHOR = 3001;
const RENDER_ORDER_PILL = 3003;

/** Reused across every marker; nothing here survives a call. */
const _worldBody = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _view = new THREE.Vector3();

export interface EntityMarkerOptions {
  atlas: MarkerAtlas;
  placed: PlacedEntity;
  visual?: EntityVisualState | null;
  /** Fallback accent when neither config nor HA state provides a colour. */
  accent?: string;
  /** Play the pop-in. False when rebuilding an already-visible marker. */
  animateIn?: boolean;
}

/** Screen-space extent of a marker, in CSS pixels. Filled in place. */
export interface ScreenRect {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  /** View-space depth; smaller is nearer the camera. */
  depth: number;
}

export class EntityMarker {
  readonly entityId: string;
  /** Parent this under `ctx.overlayRoot`. */
  readonly object = new THREE.Group();

  private readonly atlas: MarkerAtlas;
  private readonly body = new THREE.Group();

  private readonly pill: THREE.Sprite;
  private readonly pillMaterial: THREE.SpriteMaterial;
  private readonly pillTexture: THREE.Texture;

  private readonly anchor: THREE.Sprite;
  private readonly anchorMaterial: THREE.SpriteMaterial;
  private readonly anchorTexture: THREE.Texture;

  private readonly leader: THREE.Line;
  private readonly leaderGeometry: THREE.BufferGeometry;
  private readonly leaderMaterial: THREE.LineBasicMaterial;
  private readonly leaderPositions: Float32Array;

  private placedEntity: PlacedEntity;
  private role: EntityRole;
  private visual: EntityVisualState | null;
  private accent: string;

  private pillCell: AtlasCell;
  private anchorCell: AtlasCell;

  /* animated state, all 0..1 */
  private popT: number;
  private hoverAmt = 0;
  private selectAmt = 0;
  private activeAmt = 0;
  private occludedAmt = 0;

  private hovered = false;
  private selected = false;
  private occluded = false;
  private levelVisible = true;
  private layerVisible = true;
  private crowded = false;
  /** Place in its stack, top-down; 0 is the one sitting on the anchor. */
  private stackIndex = 0;
  /** How many markers share this anchor. 1 means it stands alone. */
  private stackCount = 1;

  private baseLift = DEFAULT_LIFT;
  /** World point of the room this entity names, if it names one. */
  private roomAnchor: THREE.Vector3 | null = null;
  /** Exploded-view lift of this entity's storey; see `engine/model/explode.ts`. */
  private levelLift = 0;
  /** Unexploded Y, as the config states it. */
  private configY = 0;
  /** Local-space copy of it, recomputed when the marker or the model moves. */
  private readonly roomLocal = new THREE.Vector3();
  private appliedState: MarkerVisualState = 'idle';
  /** Logical-pixel size of the visible art, refreshed every frame. */
  private pillPxWidth = 0;
  private pillPxHeight = 0;
  private disposed = false;

  constructor(options: EntityMarkerOptions) {
    this.atlas = options.atlas;
    this.placedEntity = options.placed;
    this.entityId = options.placed.entity;
    this.role = options.placed.role ?? roleForEntityId(options.placed.entity);
    this.visual = options.visual ?? null;
    this.accent = options.accent ?? '#03a9f4';
    this.popT = options.animateIn === false ? 1 : 0;
    this.activeAmt = this.visual?.active ? 1 : 0;

    this.object.name = `marker:${this.entityId}`;
    this.object.userData.entityId = this.entityId;
    // The section controller skips anything flagged this way, so a marker is
    // never assigned clipping planes even if it ends up under the model root.
    this.object.userData.noClip = true;
    this.object.matrixAutoUpdate = true;

    this.pillTexture = this.atlas.acquire();
    this.pillMaterial = makeSpriteMaterial(this.pillTexture);
    this.pill = new THREE.Sprite(this.pillMaterial);
    this.pill.renderOrder = RENDER_ORDER_PILL;
    this.pill.userData.entityId = this.entityId;

    this.anchorTexture = this.atlas.acquire();
    this.anchorMaterial = makeSpriteMaterial(this.anchorTexture);
    this.anchor = new THREE.Sprite(this.anchorMaterial);
    this.anchor.renderOrder = RENDER_ORDER_ANCHOR;

    // Three points: the room being labelled, this marker's anchor, and the
    // pill above it. With no room the first two coincide and the extra segment
    // is zero length, which costs nothing and keeps one buffer for both forms.
    this.leaderPositions = new Float32Array([0, 0, 0, 0, 0, 0, 0, DEFAULT_LIFT, 0]);
    this.leaderGeometry = new THREE.BufferGeometry();
    this.leaderGeometry.setAttribute('position', new THREE.BufferAttribute(this.leaderPositions, 3));
    this.leaderMaterial = new THREE.LineBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.55,
    });
    this.leader = new THREE.Line(this.leaderGeometry, this.leaderMaterial);
    this.leader.renderOrder = RENDER_ORDER_LEADER;
    this.leader.frustumCulled = false;

    this.body.add(this.pill);
    this.object.add(this.leader, this.anchor, this.body);

    this.pillCell = this.atlas.cell(this.buildSpec('idle'));
    this.anchorCell = this.atlas.cell({ variant: 'anchor', color: this.currentColor() });
    this.applyCells();

    this.setPlaced(options.placed);
  }

  /* ------------------------------------------------------------- accessors */

  get placed(): PlacedEntity {
    return this.placedEntity;
  }

  get levelId(): string | null {
    return this.placedEntity.level ?? null;
  }

  /** World-space anchor, for testing the marker against the cut planes. */
  get worldPosition(): THREE.Vector3 {
    return this.object.position;
  }

  /** The object a raycaster should hit. */
  get pickTarget(): THREE.Object3D {
    return this.pill;
  }

  isPickable(): boolean {
    return !this.disposed && this.object.visible && this.pillMaterial.opacity > 0.05;
  }

  /* ---------------------------------------------------------------- config */

  setPlaced(placed: PlacedEntity): void {
    this.placedEntity = placed;
    this.role = placed.role ?? roleForEntityId(placed.entity);

    const marker: MarkerConfig = placed.marker ?? {};
    const offset = marker.offset;
    this.baseLift = offset ? offset[1] : DEFAULT_LIFT;
    this.body.position.set(offset ? offset[0] : 0, this.baseLift, offset ? offset[2] : 0);

    this.setPosition(placed.position);
    this.rebuildArt();
  }

  /**
   * Move the label alone, in metres from the anchor.
   *
   * The anchor is the entity — where the lamp hangs, what the light comes from.
   * The label is a thing you read, and a plan is full of places it fits better
   * than directly over what it names. Dragging one used to drag the other.
   */
  setLabelOffset(offset: Vec3): void {
    this.baseLift = offset[1];
    this.body.position.set(offset[0], offset[1], offset[2]);
  }

  /** Where the label currently sits, relative to the anchor. */
  getLabelOffset(): Vec3 {
    return [this.body.position.x, this.baseLift, this.body.position.z];
  }

  /**
   * The anchor's own screen position, for telling "grab the entity" apart from
   * "grab its label". Returns false when it is not on screen.
   */
  getAnchorScreenPoint(
    camera: THREE.Camera,
    width: number,
    height: number,
    out: { x: number; y: number; depth: number },
  ): boolean {
    if (!this.isPickable()) return false;
    this.object.updateMatrixWorld();
    _proj.setFromMatrixPosition(this.object.matrixWorld);
    const depth = -_view.copy(_proj).applyMatrix4(camera.matrixWorldInverse).z;
    _proj.project(camera);
    if (!Number.isFinite(_proj.x) || _proj.z > 1) return false;
    out.x = (_proj.x * 0.5 + 0.5) * width;
    out.y = (1 - (_proj.y * 0.5 + 0.5)) * height;
    out.depth = depth;
    return true;
  }

  /** The room this marker labels, for the layer's anchor lookup. */
  get roomName(): string | undefined {
    return this.placedEntity.room;
  }

  setPosition(position: Vec3): void {
    this.configY = position[1];
    this.object.position.set(position[0], position[1] + this.levelLift, position[2]);
    this.syncRoomLeader();
  }

  /**
   * Ride the storey up in the exploded view. Only the *drawn* position moves —
   * `placedEntity.position` stays the real one, so nothing here can leak an
   * exploded height back into the config.
   */
  setLevelOffsets(offsets: ReadonlyMap<string, number> | null): void {
    const level = this.placedEntity.level;
    const lift = typeof level === 'string' ? (offsets?.get(level) ?? 0) : 0;
    if (lift === this.levelLift) return;
    this.levelLift = lift;
    this.object.position.y = this.configY + lift;
    this.syncRoomLeader();
  }

  /**
   * Where the room this entity names sits in the world, or null if it names
   * none. The layer hands the whole table down whenever the model changes.
   */
  setRoomAnchors(anchors: ReadonlyMap<string, Vec3> | null): void {
    const room = this.placedEntity.room;
    // Level first: room ids are unique per storey, not across the building, so
    // a house with a hallway on every floor has three rooms called `flur`, and
    // the bare name then answers a different question than the one asked.
    const level = this.placedEntity.level;
    const point =
      room && anchors
        ? ((level ? anchors.get(anchorKey(level, room)) : undefined) ?? anchors.get(room))
        : undefined;
    this.roomAnchor = point ? new THREE.Vector3(point[0], point[1], point[2]) : null;
    this.syncRoomLeader();
  }

  /**
   * Point the first leader segment at the room, in the marker's own frame.
   *
   * Collapsed onto the anchor when there is no room, when the marker is already
   * standing in it, or when `marker.leader` says no — a zero-length segment
   * draws nothing and keeps one geometry serving both forms.
   */
  private syncRoomLeader(): void {
    const wanted = this.placedEntity.marker?.leader;
    let local: THREE.Vector3 | null = null;

    if (this.roomAnchor && wanted !== false) {
      this.roomLocal.copy(this.roomAnchor).sub(this.object.position);
      // Horizontal distance only: a sensor on a wall is metres above the floor
      // the room's anchor sits on, and that height is not what makes a leader
      // worth drawing.
      const spread = Math.hypot(this.roomLocal.x, this.roomLocal.z);
      if (wanted === true || spread > ROOM_LEADER_MIN_M) local = this.roomLocal;
    }

    const p = this.leaderPositions;
    const x = local ? local.x : 0;
    const y = local ? local.y : 0;
    const z = local ? local.z : 0;
    if (p[0] === x && p[1] === y && p[2] === z) return;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    this.leaderGeometry.attributes.position.needsUpdate = true;
  }

  setVisual(visual: EntityVisualState): void {
    this.visual = visual;
    this.rebuildArt();
  }

  setAccent(accent: string): void {
    if (this.accent === accent) return;
    this.accent = accent;
    this.rebuildArt();
  }

  setHovered(hovered: boolean): void {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.syncArtState();
  }

  setSelected(selected: boolean): void {
    if (this.selected === selected) return;
    this.selected = selected;
    this.syncArtState();
  }

  setLevelVisible(visible: boolean): void {
    this.levelVisible = visible;
  }

  setLayerVisible(visible: boolean): void {
    this.layerVisible = visible;
  }

  setOccluded(occluded: boolean): void {
    this.occluded = occluded;
  }

  /**
   * Collapse to just the anchor dot because a more important marker occupies
   * the same patch of screen. Hovering or selecting always wins the space
   * back — you must be able to read what you are pointing at.
   */
  /**
   * Let geometry hide this marker. Off makes it an always-visible overlay,
   * which is right for a card where the roof is never cut away.
   */
  setDepthTested(enabled: boolean): void {
    for (const material of [
      this.pillMaterial,
      this.anchorMaterial,
      this.leaderMaterial,
    ]) {
      if (!material || material.depthTest === enabled) continue;
      material.depthTest = enabled;
      material.needsUpdate = true;
    }
  }

  /**
   * Which row of the pile this marker is.
   *
   * Only the bottom one keeps its leader line: three lines fanning out of one
   * dot say nothing that the list above it does not already say.
   */
  setStackIndex(index: number, count = 1): void {
    if (this.stackIndex === index && this.stackCount === count) return;
    this.stackIndex = index;
    this.stackCount = count;
    this.syncRoomLeader();
  }

  setCrowded(crowded: boolean): boolean {
    if (this.crowded === crowded) return false;
    this.crowded = crowded;
    return true;
  }

  /** Logical-pixel footprint of the label, for the layer's overlap test. */
  get labelSizePx(): { width: number; height: number } {
    return { width: this.pillPxWidth, height: this.pillPxHeight };
  }

  /** Higher wins the space when two labels collide. */
  get declutterPriority(): number {
    if (this.selected) return 3;
    if (this.hovered) return 2;
    return this.visual?.active ? 1 : 0;
  }

  /** Re-request every cell; call after the atlas repacks. */
  refreshArt(): void {
    this.rebuildArt();
  }

  /* ----------------------------------------------------------------- frame */

  /** Returns true while something is still animating. */
  update(dt: number, ctx: RenderContext): boolean {
    if (this.disposed) return false;

    const step = clamp(dt, 0, 0.1);
    const before = this.hoverAmt + this.selectAmt + this.activeAmt + this.occludedAmt;

    this.hoverAmt = damp(this.hoverAmt, this.hovered ? 1 : 0, STATE_LAMBDA, step);
    this.selectAmt = damp(this.selectAmt, this.selected ? 1 : 0, STATE_LAMBDA, step);
    this.activeAmt = damp(this.activeAmt, this.visual?.active ? 1 : 0, STATE_LAMBDA, step);
    this.occludedAmt = damp(this.occludedAmt, this.occluded ? 1 : 0, STATE_LAMBDA * 0.6, step);

    if (this.popT < 1) this.popT = Math.min(1, this.popT + step / POP_DURATION);

    const visible = this.levelVisible && this.layerVisible;
    this.object.visible = visible;
    if (!visible) return this.popT < 1;

    // A stack is read as a list, so the gap between its labels is a screen
    // distance and not a distance in the house: in metres it would open and
    // close with the zoom and lean over with the perspective, which is exactly
    // what a list must not do.
    const stackLift =
      this.stackIndex > 0 ? this.stackIndex * STACK_ROW_PX * this.pixelUnit(ctx, this.object.position) : 0;
    const lift = this.baseLift + HOVER_LIFT * this.hoverAmt + stackLift;
    this.body.position.y = lift;
    // Crowded markers give up the label that was covering a neighbour, but not
    // the leader: the line is what says something is there and, when it points
    // at a room, which room that is. Dropping both leaves a bare crosshair,
    // which on a dark ground is close to nothing at all.
    const showLabel = !this.crowded || this.hovered || this.selected;
    this.body.visible = showLabel;
    const pushed = Math.hypot(this.body.position.x, this.body.position.z) > 0.03;
    this.leader.visible =
      this.stackIndex > 0
        ? false
        : showLabel
          ? lift > 0.03 || pushed || this.roomAnchor !== null
          : this.roomAnchor !== null;

    // Hidden label, so the leader stops at the anchor rather than running up to
    // a pill that is not being drawn. Sideways too: a label dragged out of the
    // way is only readable if the line still says which anchor it belongs to.
    const tipX = showLabel ? this.body.position.x : 0;
    const tipY = showLabel ? lift : 0;
    const tipZ = showLabel ? this.body.position.z : 0;
    const p = this.leaderPositions;
    if (p[6] !== tipX || p[7] !== tipY || p[8] !== tipZ) {
      p[6] = tipX;
      p[7] = tipY;
      p[8] = tipZ;
      this.leaderGeometry.attributes.position.needsUpdate = true;
    }

    this.object.updateMatrixWorld();
    _worldBody.setFromMatrixPosition(this.body.matrixWorld);

    const unit = this.pixelUnit(ctx, _worldBody);
    const marker = this.placedEntity.marker ?? {};
    const configScale = marker.scale && marker.scale > 0 ? marker.scale : 1;
    const pop = this.popT < 1 ? Math.max(0, easeOutBack(this.popT)) : 1;
    const scale = configScale * pop * (1 + 0.07 * this.hoverAmt + 0.03 * this.selectAmt);

    this.pillPxWidth = this.pillCell.width * configScale;
    this.pillPxHeight = this.pillCell.height * configScale;
    this.pill.scale.set(this.pillCell.width * unit * scale, this.pillCell.height * unit * scale, 1);
    // One dot for the pile, and a bigger one: it is the handle that carries the
    // whole stack, and the labels above it each carry only themselves. Several
    // dots in the same spot would be one dot that happens to be drawn four
    // times, and a heavier stroke for no reason.
    this.anchor.visible = this.stackIndex === 0;
    const anchorScale = this.stackCount > 1 ? STACK_ANCHOR_SCALE : 1;
    this.anchor.scale.set(
      this.anchorCell.width * unit * anchorScale,
      this.anchorCell.height * unit * anchorScale,
      1,
    );

    const alpha = this.computeAlpha(ctx, _worldBody, pop);
    this.pillMaterial.opacity = alpha;
    this.anchorMaterial.opacity = alpha * 0.85;
    this.leaderMaterial.opacity = alpha * 0.5;

    const after = this.hoverAmt + this.selectAmt + this.activeAmt + this.occludedAmt;
    return this.popT < 1 || Math.abs(after - before) > 1e-4;
  }

  /**
   * Screen-space rectangle of the pill, in CSS pixels, or null when the marker
   * is behind the camera / not drawable. Written into `out`, never allocated.
   */
  getScreenRect(camera: THREE.Camera, width: number, height: number, out: ScreenRect): boolean {
    if (!this.isPickable()) return false;

    this.object.updateMatrixWorld();
    _proj.setFromMatrixPosition(this.body.matrixWorld);
    const depth = -_view.copy(_proj).applyMatrix4(camera.matrixWorldInverse).z;
    _proj.project(camera);
    if (!Number.isFinite(_proj.x) || _proj.z > 1) return false;

    out.x = (_proj.x * 0.5 + 0.5) * width;
    out.y = (1 - (_proj.y * 0.5 + 0.5)) * height;
    // The cell carries transparent padding; hit only the art inside it.
    out.halfWidth = Math.max(6, (this.pillPxWidth - CELL_PADDING * 2) / 2);
    out.halfHeight = Math.max(6, (this.pillPxHeight - CELL_PADDING * 2) / 2);
    out.depth = depth;
    return true;
  }

  /** World position of the pill centre; copied into `target`. */
  getBodyWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    this.object.updateMatrixWorld();
    return target.setFromMatrixPosition(this.body.matrixWorld);
  }

  /* -------------------------------------------------------------- teardown */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.object.removeFromParent();
    this.object.clear();
    this.body.clear();

    this.atlas.release(this.pillTexture);
    this.atlas.release(this.anchorTexture);

    this.pillMaterial.dispose();
    this.anchorMaterial.dispose();
    this.leaderMaterial.dispose();
    this.leaderGeometry.dispose();
  }

  /* ------------------------------------------------------------- internals */

  private currentColor(): string {
    return this.placedEntity.marker?.color ?? this.visual?.color ?? this.accent;
  }

  private artState(): MarkerVisualState {
    if (this.selected) return 'selected';
    if (this.hovered) return 'hover';
    return 'idle';
  }

  /** Swap to the hover/selected artwork without touching anything else. */
  private syncArtState(): void {
    const state = this.artState();
    if (state === this.appliedState) return;
    this.appliedState = state;
    this.pillCell = this.atlas.cell(this.buildSpec(state));
    this.atlas.applyTo(this.pillTexture, this.pillCell);
  }

  private rebuildArt(): void {
    this.appliedState = this.artState();
    const color = this.currentColor();
    this.pillCell = this.atlas.cell(this.buildSpec(this.appliedState));
    this.anchorCell = this.atlas.cell({ variant: 'anchor', color });
    this.applyCells();

    this.leaderMaterial.color.set(color);
  }

  private applyCells(): void {
    this.atlas.applyTo(this.pillTexture, this.pillCell);
    this.atlas.applyTo(this.anchorTexture, this.anchorCell);
  }

  private buildSpec(state: MarkerVisualState): MarkerSpec {
    const marker: MarkerConfig = this.placedEntity.marker ?? {};
    const shape = marker.shape ?? 'auto';
    const visual = this.visual;

    const icon = resolveIcon(this.role, null, visual?.state, marker.icon ?? visual?.icon);
    const name = this.placedEntity.name ?? visual?.label ?? this.entityId;
    const value = visual?.secondary ?? visual?.state;

    const wantsName = shape !== 'icon' && shape !== 'dot' && (marker.showName ?? true);
    const wantsValue = shape !== 'icon' && shape !== 'dot' && (marker.showState ?? true);
    const wantsIcon = shape !== 'label';

    if (shape === 'dot') {
      return {
        variant: 'dot',
        color: this.currentColor(),
        state,
        muted: visual?.unavailable === true,
        active: visual?.active === true,
      };
    }

    return {
      variant: 'pill',
      icon: wantsIcon ? icon : undefined,
      title: wantsName ? name : undefined,
      value: wantsValue ? value : undefined,
      color: this.currentColor(),
      state,
      muted: visual?.unavailable === true,
      active: visual?.active === true,
    };
  }

  /**
   * World units per logical pixel at `worldPos`. This is what keeps a
   * `fixedSize` marker exactly N pixels tall regardless of distance — and it
   * has to be correct for both projections, because the camera rig swaps
   * between them at runtime.
   */
  private pixelUnit(ctx: RenderContext, worldPos: THREE.Vector3): number {
    const marker = this.placedEntity.marker ?? {};
    if (marker.fixedSize === false) return SCALED_UNIT;
    return worldUnitsPerPixel(ctx.activeCamera, worldPos, ctx.size.height);
  }

  private computeAlpha(ctx: RenderContext, worldPos: THREE.Vector3, pop: number): number {
    let alpha = Math.min(1, this.popT * 2);
    if (pop <= 0) alpha = 0;

    const maxDistance = this.placedEntity.marker?.maxDistance ?? 0;
    if (maxDistance > 0) {
      _camPos.setFromMatrixPosition(ctx.activeCamera.matrixWorld);
      const distance = _camPos.distanceTo(worldPos);
      // Fade over the last quarter rather than popping out of existence.
      const start = maxDistance * 0.75;
      if (distance > start) {
        alpha *= 1 - clamp((distance - start) / Math.max(maxDistance - start, 1e-3), 0, 1);
      }
    }

    if (this.visual?.unavailable) alpha *= MUTED_ALPHA;
    alpha *= 1 - (1 - OCCLUDED_ALPHA) * this.occludedAmt;
    return clamp(alpha, 0, 1);
  }
}

/* -------------------------------------------------------------- utilities */

function makeSpriteMaterial(map: THREE.Texture): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map,
    transparent: true,
    // `depthTest` is flipped at runtime by `setDepthTested`. On means a wall or
    // a ceiling hides what is behind it, which is what makes a marker read as
    // being *in* a room rather than floating over the whole house. Never
    // `depthWrite`: these are transparent overlays and would punch holes in
    // one another.
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    sizeAttenuation: true,
  });
}

/**
 * World units covered by one logical (CSS) pixel at `worldPos`.
 *
 * Perspective: the frustum height at distance d is `2·d·tan(fov/2)`.
 * Orthographic: the frustum height is fixed, only `zoom` changes it.
 */
export function worldUnitsPerPixel(
  camera: THREE.Camera,
  worldPos: THREE.Vector3,
  viewportHeightPx: number,
): number {
  const height = viewportHeightPx > 0 ? viewportHeightPx : 1;

  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    const frustumHeight = (ortho.top - ortho.bottom) / (ortho.zoom || 1);
    return Math.abs(frustumHeight) / height;
  }

  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    _camPos.setFromMatrixPosition(perspective.matrixWorld);
    const distance = Math.max(_camPos.distanceTo(worldPos), 1e-3);
    return (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2) * distance) / height;
  }

  return 0.01;
}
