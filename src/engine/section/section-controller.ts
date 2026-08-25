/**
 * Cross-sections: five side cuts and level isolation, expressed as
 * `THREE.Plane`s assigned to the model's materials.
 *
 * The two are independent. Isolating a storey answers "what is on this floor";
 * cutting a side away answers "let me see in from here", and wanting both at
 * once is the ordinary case — an upper floor with its front wall taken off.
 * They used to be exclusive modes, which meant choosing between the two
 * questions.
 *
 * A cut is held as a depth in metres from one face of the model rather than as
 * a world coordinate; see `cut-sides.ts` for why, and for the arithmetic.
 *
 * Clipping is deliberately *local* (per material), never global. The render
 * core keeps `renderer.clippingPlanes` empty so that the overlay root — markers,
 * gizmos, these handles — is never cut. We own the contents of
 * `ctx.clippingPlanes`; the array identity belongs to the core and is handed to
 * every model material, so moving a plane needs no material bookkeeping at all.
 *
 * Plane convention: `dir: -1` keeps the *lesser* side of the axis (the plane
 * cuts away everything beyond it), `dir: 1` keeps the greater side.
 */

import * as THREE from 'three';
import type {
  Axis,
  ClipPlaneState,
  CutSide,
  LevelDefinition,
  SectionState,
} from '@/types/config';
import { CUT_SIDES, DEFAULT_SECTION_STATE } from '@/types/config';
import type { ISectionController, RenderContext } from '@/engine/contracts';
import { easeInOutCubic } from '@/util/math';
import { Tween, TweenRunner, tweenValue } from '@/engine/camera/tween';
import { CapRenderer } from '@/engine/section/cap-renderer';
import { SectionHandles, type SectionHandleSpec } from '@/engine/section/section-handles';
import {
  AXIS_INDEX,
  CUT_GEOMETRY,
  OPPOSITE_SIDE,
  cutDepthAt,
  cutDirection,
  cutHeadroom,
  cutPlanePosition,
  cutExtent,
  cutsFromPlanes,
  sanitizeCuts,
  trimCuts,
} from '@/engine/section/cut-sides';

/** Seconds. Long enough to read as a move, short enough not to feel slow. */
const TRANSITION = 0.45;
/** Lets the floor slab itself survive the level cut. */
const LEVEL_EPS = 0.02;
/** Seconds between safety re-scans for materials created after the last load. */
const RESCAN_INTERVAL = 1;

interface Clip {
  key: string;
  axis: Axis;
  dir: 1 | -1;
  plane: THREE.Plane;
  position: number;
  /** True while the clip animates back out of the model before being dropped. */
  retiring: boolean;
  tween: Tween<number> | null;
}

interface DesiredClip {
  key: string;
  axis: Axis;
  dir: 1 | -1;
  target: number;
}

/** The controller's own copy: a number on every side, zero for "not cut". */
interface State {
  mode: 'none' | 'level';
  cuts: Record<CutSide, number>;
  levelId: string | null;
  capColor: string;
  ceilingCut: number;
}

let warnedMissingLevel = false;

export class SectionController implements ISectionController {
  private ctx: RenderContext | null = null;
  private state: State = sanitize(DEFAULT_SECTION_STATE);
  private levels: LevelDefinition[] = [];
  private readonly bounds = new THREE.Box3(
    new THREE.Vector3(-5, 0, -5),
    new THREE.Vector3(5, 3, 5),
  );
  /** Until the model has loaded, the box above is a guess and cuts cannot land. */
  private boundsKnown = false;
  /** Pre-0.7 `planes:`, waiting for bounds to become depths; see `absorbLegacy`. */
  private legacy: ClipPlaneState[] = [];
  /** Set once the old block has had its say, so it never gets a second one. */
  private legacyAbsorbed = false;

  private readonly clips = new Map<string, Clip>();
  private readonly runner = new TweenRunner();
  private release: (() => void) | null = null;

  private readonly caps = new CapRenderer();
  private readonly handles: SectionHandles;
  private detachDragEnd: (() => void) | null = null;
  /** The side the pointer is over in the panel, shown as an outline only. */
  private preview: CutSide | null = null;

  private meshes: THREE.Mesh[] = [];
  private readonly touched = new Set<THREE.Material>();
  private scanTimer = 0;

  private levelOffsets: ReadonlyMap<string, number> | null = null;
  /** Measured height of each storey's geometry above its own floor. */
  private levelTops: ReadonlyMap<string, number> | null = null;

  private readonly changeCallbacks = new Set<(state: SectionState) => void>();

  constructor(initial?: SectionState) {
    this.state = sanitize(initial ?? DEFAULT_SECTION_STATE);
    this.legacy = legacyPlanes(initial);
    this.handles = new SectionHandles({
      onDrag: (side, position) => this.setCutPosition(side, position),
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.renderer.localClippingEnabled = true;

    this.caps.init(ctx);
    this.caps.setBounds(this.bounds);
    this.caps.setColor(this.state.capColor);
    // Always. A cut wall showing its hollow inside is an artefact of how the
    // model is built, never something a user set out to see.
    this.caps.setEnabled(true);

    this.handles.init(ctx);
    // The live drag path stays silent; one change event when the user lets go
    // is what the card should persist.
    this.detachDragEnd = this.handles.onDragEnd(() => this.emitChange());

    this.scan();
    this.caps.setSources(this.meshes);
    this.rebuild(false);
  }

  update(dt: number): void {
    const animating = this.runner.update(dt);
    if (!animating) this.releaseLease();

    this.scanTimer += dt;
    if (this.scanTimer >= RESCAN_INTERVAL) {
      this.scanTimer = 0;
      // Materials can appear after load (glass swaps, entity node tinting).
      // A once-a-second walk of the model is cheap insurance against a mesh
      // that ignores the section entirely.
      if (this.clips.size > 0 && this.scan()) this.caps.setSources(this.meshes);
    }
  }

  dispose(): void {
    this.detachDragEnd?.();
    this.detachDragEnd = null;
    this.runner.dispose();
    this.releaseLease();

    for (const clip of this.clips.values()) clip.tween?.cancel();
    this.clips.clear();
    if (this.ctx) this.ctx.clippingPlanes.length = 0;

    this.handles.dispose();
    this.caps.dispose();

    for (const material of this.touched) {
      material.clippingPlanes = null;
      material.clipShadows = false;
    }
    this.touched.clear();
    this.meshes = [];
    this.changeCallbacks.clear();
    this.ctx = null;
  }

  /* ----------------------------------------------------------- public API */

  /**
   * How tall each storey's geometry actually is, above its own elevation. The
   * isolate-level cut works from this rather than from the declared storey
   * height; see `desiredClips`.
   */
  setLevelTops(tops: ReadonlyMap<string, number> | null): void {
    this.levelTops = tops;
    this.rebuild(false);
  }

  /** Lift the level cut with its storey; see `engine/model/explode.ts`. */
  setLevelOffsets(offsets: ReadonlyMap<string, number> | null, settled = true): void {
    if (sameOffsets(this.levelOffsets, offsets)) return;
    this.levelOffsets = offsets;
    if (settled) this.rebuild(false);
    else this.moveClips();
  }

  /**
   * Slide the existing cut planes to their new positions and nothing else —
   * cheap enough to run on every frame while the storeys are travelling.
   */
  private moveClips(): void {
    for (const spec of this.desiredClips()) {
      const clip = this.clips.get(spec.key);
      if (!clip) continue;
      clip.tween?.cancel();
      clip.tween = null;
      clip.position = spec.target;
      this.applyClip(clip);
    }
    this.ctx?.invalidate();
  }

  setState(state: SectionState, animate = true): void {
    this.state = sanitize(state);
    // Only until it has been converted. Nothing strips the deprecated block
    // from the config — a cut is no longer written back, so the old form has to
    // keep working on every load — and it therefore arrives again with every
    // state the panel commits. Re-reading it would put a cut the user has just
    // cleared straight back on the house.
    if (!this.legacyAbsorbed) this.legacy = legacyPlanes(state);
    this.absorbLegacy();
    this.settleCuts();
    this.caps.setColor(this.state.capColor);
    this.rebuild(animate);
    this.emitChange();
  }

  getState(): SectionState {
    return {
      mode: this.state.mode,
      cuts: trimCuts(this.state.cuts),
      levelId: this.state.levelId,
      capColor: this.state.capColor,
      ceilingCut: this.state.ceilingCut,
    };
  }

  /**
   * Live drag or slider: immediate, no tween, no change event. The commit comes
   * from whoever owns the gesture — the handles on release, the panel on
   * `change`.
   */
  setCutDepth(side: CutSide, depth: number): void {
    if (!Number.isFinite(depth)) return;
    const next = Math.min(Math.max(0, depth), this.headroom(side));
    if (this.state.cuts[side] === next) {
      // A drag that has run into the far side keeps sending new positions the
      // cut cannot follow. Put the knob back on the plane rather than letting
      // it wander off across a house it is no longer cutting.
      this.syncHandles();
      return;
    }
    this.state.cuts[side] = next;

    const clip = this.clips.get(`cut:${side}`);
    // Appearing or disappearing needs the full pass — there is no plane yet to
    // move, or one that has to be taken out of the array.
    if (!clip || next === 0) {
      this.rebuild(false);
      this.markMoved();
      return;
    }
    clip.tween?.cancel();
    clip.tween = null;
    clip.position = this.planeFor(side, next);
    this.applyClip(clip);
    this.markMoved();
  }

  /** A handle dropped at this world position; the depth follows from the face. */
  setCutPosition(side: CutSide, position: number): void {
    const [min, max] = this.axisSpan(CUT_GEOMETRY[side].axis);
    this.setCutDepth(side, cutDepthAt(side, position, min, max));
  }

  cutDepth(side: CutSide): number {
    return this.state.cuts[side];
  }

  /**
   * Put up the outline for one side without cutting anything.
   *
   * Five sliders labelled left, right, front and back are five guesses until
   * you see which face each one belongs to. Pointing at a row draws that face.
   */
  setPreviewSide(side: CutSide | null): void {
    if (this.preview === side) return;
    this.preview = side;
    this.syncHandles();
    this.ctx?.invalidate();
  }

  isolateLevel(levelId: string | null, animate = true): void {
    const next = this.getState();
    next.levelId = levelId;
    next.mode = levelId === null ? 'none' : 'level';
    this.setState(next, animate);
  }

  setBounds(bounds: THREE.Box3): void {
    if (bounds.isEmpty()) return;
    this.bounds.copy(bounds);
    this.boundsKnown = true;
    this.caps.setBounds(this.bounds);
    this.refreshMaterials();
    // Cuts are depths measured from these faces, so a new model means new
    // positions for the same numbers.
    const absorbed = this.absorbLegacy();
    // A different model is a different size, so cuts that fitted may not.
    const settled = this.settleCuts();
    if (absorbed || settled) this.emitChange();
    this.rebuild(false);
  }

  setHandlesVisible(visible: boolean): void {
    this.handles.setVisible(visible);
  }

  /**
   * Storeys, needed by `level` mode. Call after the model manager has derived
   * them; without it `isolateLevel` has nothing to isolate.
   */
  setLevels(levels: LevelDefinition[]): void {
    this.levels = levels.map((level) => ({ ...level }));
    if (this.state.mode === 'level') this.rebuild(false);
  }

  /** Re-apply the clip planes to every material in the model. */
  refreshMaterials(): void {
    if (!this.ctx) return;
    this.scan();
    this.caps.setSources(this.meshes);
    this.ctx.invalidate();
  }

  /**
   * The cut changed — from a handle, a slider, a saved view or a config.
   *
   * No `origin`, because nobody needs one: a cut is never written down by
   * itself. It is part of a view, and the card commits it when a view is
   * saved. Telling the two apart used to matter because every change was
   * persisted, and applying a view then rewrote the state the card opens with.
   */
  onChange(cb: (state: SectionState) => void): () => void {
    this.changeCallbacks.add(cb);
    return () => {
      this.changeCallbacks.delete(cb);
    };
  }

  /** Wire to `camera.setEnabled(false)` — orbit must not fight a handle drag. */
  onHandleDragStart(cb: () => void): () => void {
    return this.handles.onDragStart(cb);
  }

  onHandleDragEnd(cb: () => void): () => void {
    return this.handles.onDragEnd(cb);
  }

  isHandleDragging(): boolean {
    return this.handles.isDragging();
  }

  /** True when caps are impossible because the GL context has no stencil bits. */
  get capsAvailable(): boolean {
    return this.caps.available;
  }

  /* -------------------------------------------------------------- planning */

  private axisSpan(axis: Axis): [number, number] {
    const index = AXIS_INDEX[axis];
    return [this.bounds.min.getComponent(index), this.bounds.max.getComponent(index)];
  }

  private planeFor(side: CutSide, depth: number): number {
    const [min, max] = this.axisSpan(CUT_GEOMETRY[side].axis);
    return cutPlanePosition(side, Math.min(depth, cutExtent(min, max)), min, max);
  }

  /** How deep this side may go before it meets the cut coming the other way. */
  private headroom(side: CutSide): number {
    const [min, max] = this.axisSpan(CUT_GEOMETRY[side].axis);
    const facing = OPPOSITE_SIDE[side];
    return cutHeadroom(min, max, facing ? this.state.cuts[facing] : 0);
  }

  /**
   * Pull back whatever a config, a saved view or a new model has left
   * overlapping.
   *
   * The deeper of the two gives way. The shallower one is the likelier to have
   * been meant — a 4 m cut on an 8 m house and a 6 m one facing it is far more
   * likely a slip in the second than a house that was supposed to disappear —
   * and trimming the shallow one instead would undo a setting nobody touched.
   */
  private settleCuts(): boolean {
    if (!this.boundsKnown) return false;
    let changed = false;
    const settled = new Set<CutSide>();

    for (const side of CUT_SIDES) {
      if (settled.has(side)) continue;
      const facing = OPPOSITE_SIDE[side];
      const [min, max] = this.axisSpan(CUT_GEOMETRY[side].axis);
      settled.add(side);

      if (!facing) {
        // No cut runs into it, but it still cannot take more than there is.
        const room = cutHeadroom(min, max, 0);
        if (this.state.cuts[side] <= room) continue;
        this.state.cuts[side] = room;
        changed = true;
        continue;
      }

      settled.add(facing);
      const here = this.state.cuts[side];
      const there = this.state.cuts[facing];
      const deeper = here > there ? side : facing;
      const room = cutHeadroom(min, max, this.state.cuts[deeper === side ? facing : side]);
      if (this.state.cuts[deeper] <= room) continue;
      this.state.cuts[deeper] = room;
      changed = true;
    }
    return changed;
  }

  /**
   * Turn a pre-0.7 `planes:` block into depths, now that the faces they were
   * measured against are known. Returns true when anything changed.
   */
  private absorbLegacy(): boolean {
    if (this.legacy.length === 0 || !this.boundsKnown) return false;
    this.legacyAbsorbed = true;
    const converted = cutsFromPlanes(
      this.legacy,
      [this.bounds.min.x, this.bounds.min.y, this.bounds.min.z],
      [this.bounds.max.x, this.bounds.max.y, this.bounds.max.z],
    );
    this.legacy = [];
    // Only where the config says nothing: a cut written in the new form is the
    // author's current intent and outranks whatever the old block asked for.
    let changed = false;
    for (const side of CUT_SIDES) {
      const depth = converted[side];
      if (depth && depth > 0 && this.state.cuts[side] === 0) {
        this.state.cuts[side] = depth;
        changed = true;
      }
    }
    return changed;
  }

  private desiredClips(): DesiredClip[] {
    const clips: DesiredClip[] = [];

    for (const side of CUT_SIDES) {
      const depth = this.state.cuts[side];
      if (depth <= 0) continue;
      clips.push({
        key: `cut:${side}`,
        axis: CUT_GEOMETRY[side].axis,
        dir: cutDirection(side),
        target: this.planeFor(side, depth),
      });
    }

    if (this.state.mode !== 'level') return clips;

    const level = this.levels.find((candidate) => candidate.id === this.state.levelId);
    if (!level) {
      if (!warnedMissingLevel) {
        warnedMissingLevel = true;
        console.warn(
          `[floorplan-3d] section: unknown level "${String(this.state.levelId)}"; ` +
            'showing the whole model.',
        );
      }
      return clips;
    }
    // The height of the storey's *walls* where we have measured them, not the
    // storey height the file states. A top floor under a pitched roof has walls
    // of every height between the eaves and the ridge, and the nominal figure
    // slices through the tall half of the room.
    const measured = this.levelTops?.get(level.id);
    const height = measured && measured > 0 ? measured : level.height > 0 ? level.height : 3;
    // Measured, the walls' own top is already where the cut belongs: the ceiling
    // slab is the first thing above it. Trimming a further fixed amount off that
    // is what beheaded a pitched roof — it is only there for the declared
    // height, which says nothing about where the ceiling is.
    const trim = measured && measured > 0 ? 0 : null;
    // The exploded view lifts the storey's geometry, so the cut has to rise with
    // it or it slices whatever now happens to be at that height.
    const base = level.elevation + (this.levelOffsets?.get(level.id) ?? 0);
    const ceilingCut = Math.max(0, this.state.ceilingCut);
    // Both bounds need the epsilon, and for the same reason: a storey's floor
    // slab sits exactly at `elevation` and its ceiling exactly at
    // `elevation + height`. A clip plane coplanar with a face is decided by
    // floating-point rounding, so it flips in and out per frame and the surface
    // flickers. Nudging the planes outwards keeps whole slabs unambiguously
    // inside the slice.
    clips.push({ key: 'level:min', axis: 'y', dir: 1, target: base - LEVEL_EPS });
    clips.push({
      key: 'level:max',
      axis: 'y',
      dir: -1,
      // Cut below the ceiling slab, not above it: isolating a storey is meant to
      // let you see into the rooms, and a cut that keeps the ceiling just shows
      // you its underside from every angle above. Never take more than 40% of
      // the storey, so a low ceiling or a mis-detected level cannot collapse the
      // view to nothing.
      target: base + Math.max(height - (trim ?? ceilingCut), height * 0.6) + LEVEL_EPS,
    });
    return clips;
  }

  private rebuild(animate: boolean): void {
    if (!this.ctx) return;
    const desired = this.desiredClips();
    const stale = new Set(this.clips.keys());

    for (const spec of desired) {
      stale.delete(spec.key);
      let clip = this.clips.get(spec.key);
      if (clip && clip.dir !== spec.dir) {
        // An inverted plane is a different half-space; rebuild rather than
        // animate the normal, which would flip through a degenerate state.
        this.dropClip(clip);
        clip = undefined;
      }
      if (!clip) clip = this.createClip(spec, animate);
      clip.retiring = false;
      this.retarget(clip, spec.target, animate);
    }

    for (const key of stale) {
      const clip = this.clips.get(key);
      if (clip) this.retire(clip, animate);
    }

    this.syncPlanes();
  }

  private createClip(spec: DesiredClip, animate: boolean): Clip {
    const normal = new THREE.Vector3();
    normal.setComponent(AXIS_INDEX[spec.axis], spec.dir);
    const clip: Clip = {
      key: spec.key,
      axis: spec.axis,
      dir: spec.dir,
      plane: new THREE.Plane(normal, 0),
      // A new cut sweeps in from outside the model instead of appearing
      // mid-wall: the eye follows the motion and understands what was removed.
      position: animate ? this.openPosition(spec.axis, spec.dir) : spec.target,
      retiring: false,
      tween: null,
    };
    this.applyClip(clip);
    this.clips.set(clip.key, clip);
    return clip;
  }

  /** The position at which a clip cuts nothing at all. */
  private openPosition(axis: Axis, dir: 1 | -1): number {
    const index = AXIS_INDEX[axis];
    const margin = this.bounds.getSize(new THREE.Vector3()).length() * 0.05 + 0.5;
    return dir === 1
      ? this.bounds.min.getComponent(index) - margin
      : this.bounds.max.getComponent(index) + margin;
  }

  private applyClip(clip: Clip): void {
    clip.plane.constant = -clip.dir * clip.position;
  }

  private retarget(clip: Clip, target: number, animate: boolean, onDone?: () => void): void {
    clip.tween?.cancel();
    clip.tween = null;

    if (!animate || Math.abs(clip.position - target) < 1e-4) {
      clip.position = target;
      this.applyClip(clip);
      onDone?.();
      return;
    }

    const tween = tweenValue(
      clip.position,
      target,
      TRANSITION,
      (value) => {
        clip.position = value;
        this.applyClip(clip);
        this.markMoved();
      },
      {
        easing: easeInOutCubic,
        onComplete: (completed) => {
          clip.tween = null;
          if (completed) onDone?.();
        },
      },
    );
    clip.tween = tween;
    this.runner.add(tween);
    this.holdLease();
  }

  private retire(clip: Clip, animate: boolean): void {
    if (!animate) {
      this.dropClip(clip);
      this.syncPlanes();
      return;
    }
    clip.retiring = true;
    this.retarget(clip, this.openPosition(clip.axis, clip.dir), true, () => {
      this.dropClip(clip);
      this.syncPlanes();
    });
  }

  private dropClip(clip: Clip): void {
    clip.tween?.cancel();
    clip.tween = null;
    this.clips.delete(clip.key);
  }

  /** Rewrite the shared plane array; the array identity never changes. */
  private syncPlanes(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const planes = ctx.clippingPlanes;
    planes.length = 0;
    for (const clip of this.clips.values()) planes.push(clip.plane);
    this.caps.sync(planes);
    this.syncHandles();
    ctx.invalidate();
  }

  /** Cheap per-frame follow-up while positions animate or a handle is dragged. */
  private markMoved(): void {
    this.caps.refresh();
    this.syncHandles();
    this.ctx?.invalidate();
  }

  private syncHandles(): void {
    const specs: SectionHandleSpec[] = [];
    for (const side of CUT_SIDES) {
      const clip = this.clips.get(`cut:${side}`);
      if (!clip || clip.retiring) continue;
      specs.push({ side, axis: clip.axis, position: clip.position, dir: clip.dir });
    }
    const preview = this.preview;
    if (preview && !specs.some((spec) => spec.side === preview)) {
      // At the face itself, which is where a cut of nothing sits.
      specs.push({
        side: preview,
        axis: CUT_GEOMETRY[preview].axis,
        position: this.planeFor(preview, 0),
        dir: cutDirection(preview),
        ghost: true,
      });
    }
    this.handles.sync(specs, this.bounds);
  }

  /* ------------------------------------------------------------- materials */

  /** Returns true when the mesh set changed (caps have to be rebuilt). */
  private scan(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;

    const meshes: THREE.Mesh[] = [];
    const materials = new Set<THREE.Material>();

    const walk = (object: THREE.Object3D): void => {
      if (object.userData.noClip === true || object.userData.fp3dInternal === true) return;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        meshes.push(mesh);
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const entry of material) materials.add(entry);
        } else if (material) {
          materials.add(material);
        }
      }
      for (const child of object.children) walk(child);
    };
    for (const child of ctx.modelRoot.children) walk(child);

    for (const material of materials) {
      if (material.clippingPlanes !== ctx.clippingPlanes) {
        material.clippingPlanes = ctx.clippingPlanes;
      }
      // Cut the shadows too, otherwise a removed wall keeps casting one.
      material.clipShadows = true;
      this.touched.add(material);
    }

    const changed =
      meshes.length !== this.meshes.length || meshes.some((mesh, i) => mesh !== this.meshes[i]);
    this.meshes = meshes;
    return changed;
  }

  /* ------------------------------------------------------------- plumbing */

  private holdLease(): void {
    if (this.release || !this.ctx) return;
    this.release = this.ctx.holdContinuous();
  }

  private releaseLease(): void {
    if (!this.release) return;
    this.release();
    this.release = null;
  }

  private emitChange(): void {
    if (this.changeCallbacks.size === 0) return;
    const state = this.getState();
    for (const cb of [...this.changeCallbacks]) cb(state);
  }
}

/**
 * By value, not by identity: the exploded view hands out a freshly built map on
 * every frame of its flight, and an identity check would call every one of them
 * a change — including the last one, which is usually the same as the one before.
 */
function sameOffsets(
  a: ReadonlyMap<string, number> | null,
  b: ReadonlyMap<string, number> | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (Math.abs((b.get(key) ?? Number.NaN) - value) > 1e-6) return false;
  }
  return true;
}

/* ------------------------------------------------------------- validation */

/** Enabled pre-0.7 planes only; a disabled one never cut anything. */
function legacyPlanes(state: SectionState | undefined): ClipPlaneState[] {
  const planes = state?.planes;
  if (!Array.isArray(planes)) return [];
  return planes.filter((plane) => plane && plane.enabled === true);
}

/**
 * Config comes from hand-edited YAML: a missing field or a string where a
 * number belongs must not put a NaN into a clipping plane, which silently makes
 * the whole model vanish.
 */
function sanitize(state: SectionState | undefined): State {
  return {
    mode: state?.mode === 'level' ? 'level' : 'none',
    cuts: sanitizeCuts(state?.cuts),
    levelId: state?.levelId ?? null,
    capColor: state?.capColor ?? DEFAULT_SECTION_STATE.capColor ?? '#8a8f98',
    ceilingCut:
      typeof state?.ceilingCut === 'number' && Number.isFinite(state.ceilingCut)
        ? Math.max(0, state.ceilingCut)
        : (DEFAULT_SECTION_STATE.ceilingCut ?? 0),
  };
}
