/**
 * Cross-sections: axis planes, level isolation and an arbitrary keep-box, all
 * expressed as `THREE.Plane`s assigned to the model's materials.
 *
 * Clipping is deliberately *local* (per material), never global. The render
 * core keeps `renderer.clippingPlanes` empty so that the overlay root — markers,
 * gizmos, these handles — is never cut. We own the contents of
 * `ctx.clippingPlanes`; the array identity belongs to the core and is handed to
 * every model material, so moving a plane needs no material bookkeeping at all.
 *
 * Plane convention: `invert: false` keeps the *lesser* side of the axis (the
 * plane cuts away everything in front of it), `invert: true` keeps the greater
 * side. A clip's `dir` is the direction its normal points, which is also the
 * side that survives.
 */

import * as THREE from 'three';
import type { Axis, ClipPlaneState, LevelDefinition, SectionState } from '@/types/config';
import { DEFAULT_SECTION_STATE } from '@/types/config';
import type { ISectionController, RenderContext } from '@/engine/contracts';
import { easeInOutCubic } from '@/util/math';
import { Tween, TweenRunner, tweenValue } from '@/engine/camera/tween';
import { CapRenderer } from '@/engine/section/cap-renderer';
import { SectionHandles, type SectionHandleSpec } from '@/engine/section/section-handles';

/** Seconds. Long enough to read as a move, short enough not to feel slow. */
const TRANSITION = 0.45;
/** Lets the floor slab itself survive the level cut. */
const LEVEL_EPS = 0.02;
/** Seconds between safety re-scans for materials created after the last load. */
const RESCAN_INTERVAL = 1;

const AXIS_ORDER: Axis[] = ['x', 'y', 'z'];
const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

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

let warnedMissingLevel = false;

export class SectionController implements ISectionController {
  private ctx: RenderContext | null = null;
  private state: SectionState = sanitize(DEFAULT_SECTION_STATE);
  private levels: LevelDefinition[] = [];
  private readonly bounds = new THREE.Box3(
    new THREE.Vector3(-5, 0, -5),
    new THREE.Vector3(5, 3, 5),
  );

  private readonly clips = new Map<string, Clip>();
  private readonly runner = new TweenRunner();
  private release: (() => void) | null = null;

  private readonly caps = new CapRenderer();
  private readonly handles: SectionHandles;
  private detachDragEnd: (() => void) | null = null;

  private meshes: THREE.Mesh[] = [];
  private readonly touched = new Set<THREE.Material>();
  private scanTimer = 0;

  private levelOffsets: ReadonlyMap<string, number> | null = null;
  /** Measured height of each storey's geometry above its own floor. */
  private levelTops: ReadonlyMap<string, number> | null = null;

  private readonly changeCallbacks = new Set<(state: SectionState) => void>();

  constructor(initial?: SectionState) {
    this.state = sanitize(initial ?? DEFAULT_SECTION_STATE);
    this.handles = new SectionHandles({
      onDrag: (axis, position) => this.setPlanePosition(axis, position),
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.renderer.localClippingEnabled = true;

    this.caps.init(ctx);
    this.caps.setBounds(this.bounds);
    this.caps.setColor(this.state.capColor);
    this.caps.setEnabled(this.state.caps !== false);

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
    this.caps.setColor(this.state.capColor);
    this.caps.setEnabled(this.state.caps !== false);
    this.rebuild(animate);
    this.emitChange();
  }

  getState(): SectionState {
    return {
      mode: this.state.mode,
      planes: this.state.planes.map((p) => ({ ...p })),
      levelId: this.state.levelId ?? null,
      caps: this.state.caps,
      capColor: this.state.capColor,
    };
  }

  /** Live drag: immediate, no tween, no change event. */
  setPlanePosition(axis: Axis, position: number): void {
    if (!Number.isFinite(position)) return;
    const entry = this.state.planes.find((p) => p.axis === axis);
    if (entry) entry.position = position;

    const clip = this.clips.get(`plane:${axis}`);
    if (!clip) return;
    clip.tween?.cancel();
    clip.tween = null;
    clip.position = position;
    this.applyClip(clip);
    this.markMoved();
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
    this.caps.setBounds(this.bounds);
    this.refreshMaterials();
    // Cut planes are in absolute world coordinates, so new bounds move only the
    // handles, never the cut.
    this.syncHandles();
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

  private desiredClips(): DesiredClip[] {
    switch (this.state.mode) {
      case 'none':
        return [];

      case 'plane':
        return this.state.planes
          .filter((plane) => plane.enabled)
          .map((plane) => ({
            key: `plane:${plane.axis}`,
            axis: plane.axis,
            dir: (plane.invert ? 1 : -1) as 1 | -1,
            target: plane.position,
          }));

      case 'level': {
        const level = this.levels.find((candidate) => candidate.id === this.state.levelId);
        if (!level) {
          if (!warnedMissingLevel) {
            warnedMissingLevel = true;
            console.warn(
              `[floorplan-3d] section: unknown level "${String(this.state.levelId)}"; ` +
                'showing the whole model.',
            );
          }
          return [];
        }
        // The height of the storey's *walls* where we have measured them, not
        // the storey height the file states. A top floor under a pitched roof
        // has walls of every height between the eaves and the ridge, and the
        // nominal figure slices through the tall half of the room.
        const measured = this.levelTops?.get(level.id);
        const height = measured && measured > 0 ? measured : level.height > 0 ? level.height : 3;
        // Measured, the walls' own top is already where the cut belongs: the
        // ceiling slab is the first thing above it. Trimming a further fixed
        // amount off that is what beheaded a pitched roof — it is only there for
        // the declared height, which says nothing about where the ceiling is.
        const trim = measured && measured > 0 ? 0 : null;
        // The exploded view lifts the storey's geometry, so the cut has to rise
        // with it or it slices whatever now happens to be at that height.
        const base = level.elevation + (this.levelOffsets?.get(level.id) ?? 0);
        const ceilingCut = Math.max(0, this.state.ceilingCut ?? DEFAULT_SECTION_STATE.ceilingCut ?? 0);
        return [
          // Both bounds need the epsilon, and for the same reason: a storey's
          // floor slab sits exactly at `elevation` and its ceiling exactly at
          // `elevation + height`. A clip plane coplanar with a face is decided
          // by floating-point rounding, so it flips in and out per frame and
          // the surface flickers. Nudging the planes outwards keeps whole
          // slabs unambiguously inside the slice.
          { key: 'level:min', axis: 'y', dir: 1, target: base - LEVEL_EPS },
          {
            key: 'level:max',
            axis: 'y',
            dir: -1,
            // Cut below the ceiling slab, not above it: isolating a storey is
            // meant to let you see into the rooms, and a cut that keeps the
            // ceiling just shows you its underside from every angle above.
            // Never take more than 40% of the storey, so a low ceiling or a
            // mis-detected level cannot collapse the view to nothing.
            target: base + Math.max(height - (trim ?? ceilingCut), height * 0.6) + LEVEL_EPS,
          },
        ];
      }

      default:
        return [];
    }
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
    if (this.state.mode === 'plane') {
      for (const clip of this.clips.values()) {
        if (clip.retiring || !clip.key.startsWith('plane:')) continue;
        specs.push({ axis: clip.axis, position: clip.position, dir: clip.dir });
      }
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

function sanitizePlanes(planes: ClipPlaneState[] | undefined): ClipPlaneState[] {
  const source = Array.isArray(planes) ? planes : [];
  return AXIS_ORDER.map((axis) => {
    const found = source.find((plane) => plane && plane.axis === axis);
    const position = found && Number.isFinite(found.position) ? found.position : 0;
    return {
      axis,
      position,
      enabled: found?.enabled === true,
      invert: found?.invert === true,
    };
  });
}

/**
 * Config comes from hand-edited YAML: a missing plane list or a string where a
 * number belongs must not put a NaN into a clipping plane, which silently makes
 * the whole model vanish.
 */
function sanitize(state: SectionState | undefined): SectionState {
  const mode = state?.mode;
  const result: SectionState = {
    mode: mode === 'level' || mode === 'plane' ? mode : 'none',
    planes: sanitizePlanes(state?.planes),
    levelId: state?.levelId ?? null,
    caps: state?.caps !== false,
    capColor: state?.capColor ?? DEFAULT_SECTION_STATE.capColor,
  };
  return result;
}
