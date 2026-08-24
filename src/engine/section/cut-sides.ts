/**
 * Which face each cut eats into, and the arithmetic between a depth in metres
 * and a clipping plane in world space.
 *
 * Pure on purpose: the panel needs the slider range, the controller needs the
 * plane position, the handles need to turn a drag back into a depth, and all
 * three have to agree. They agreed by coincidence once, and a cut that read
 * 0.4 m in one place and 0.4 of the model in another is the sort of thing
 * nobody can see until the house is the wrong shape.
 */

import { CUT_SIDES, type Axis, type CutSide, type SectionCuts } from '@/types/config';
import type { ClipPlaneState } from '@/types/config';

export { CUT_SIDES };

/** Millimetres are as fine as a floorplan gets. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface CutGeometry {
  axis: Axis;
  /** The face the cut starts at and eats inwards from. */
  face: 'min' | 'max';
}

/**
 * The model faces -Z (see ARCHITECTURE.md), so the front of the house is its
 * lesser Z face, and an observer looking at that front has +X on their right.
 * Every other name follows from those two.
 */
export const CUT_GEOMETRY: Record<CutSide, CutGeometry> = {
  top: { axis: 'y', face: 'max' },
  left: { axis: 'x', face: 'min' },
  right: { axis: 'x', face: 'max' },
  front: { axis: 'z', face: 'min' },
  back: { axis: 'z', face: 'max' },
};

export const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/**
 * The face across the house from each one. `top` has none, because there is no
 * floor cut to run into.
 */
export const OPPOSITE_SIDE: Record<CutSide, CutSide | null> = {
  top: null,
  left: 'right',
  right: 'left',
  front: 'back',
  back: 'front',
};

/**
 * The most this side may take, given what the side facing it already has.
 *
 * Two cuts that pass through each other keep nothing between them, and the
 * house stops being a house: the near wall is gone, the far wall is gone, and
 * what is left is a slab of nothing with the room fill floating over it. Worse,
 * it is unrecoverable by eye — you cannot see which of the two sliders to pull
 * back, because from outside both look the same.
 */
export function cutHeadroom(min: number, max: number, oppositeDepth: number): number {
  return Math.max(0, round3(cutExtent(min, max) - Math.max(0, oppositeDepth)));
}

/**
 * Which half of the axis survives the cut, in the plane convention the section
 * controller uses: `1` keeps the greater side, `-1` the lesser.
 */
export function cutDirection(side: CutSide): 1 | -1 {
  return CUT_GEOMETRY[side].face === 'min' ? 1 : -1;
}

/** Where the plane sits, given how deep the cut goes and where the model ends. */
export function cutPlanePosition(side: CutSide, depth: number, min: number, max: number): number {
  return CUT_GEOMETRY[side].face === 'min' ? min + depth : max - depth;
}

/** The inverse: a handle dragged to `position` has cut this far in. */
export function cutDepthAt(side: CutSide, position: number, min: number, max: number): number {
  const raw = CUT_GEOMETRY[side].face === 'min' ? position - min : max - position;
  return round3(clampDepth(raw, max - min));
}

function clampDepth(depth: number, extent: number): number {
  if (!Number.isFinite(depth) || depth <= 0) return 0;
  // Never all the way: a cut that removes the last millimetre leaves an empty
  // card and no handle to drag back out of it.
  const limit = extent > 0 ? extent * 0.98 : depth;
  return Math.min(depth, limit);
}

/**
 * How far a side *can* be cut: the model's own reach along that axis, less the
 * sliver `clampDepth` keeps so there is always something left to look at.
 */
export function cutExtent(min: number, max: number): number {
  const extent = max - min;
  return extent > 0 ? round3(extent * 0.98) : 0;
}

/**
 * A complete record with a number on every side, from whatever the config or a
 * saved view happened to contain.
 */
export function sanitizeCuts(raw: SectionCuts | undefined): Record<CutSide, number> {
  const cuts = {} as Record<CutSide, number>;
  for (const side of CUT_SIDES) {
    const value = raw?.[side];
    cuts[side] = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }
  return cuts;
}

/**
 * The same record with the untouched sides left out, for writing back to YAML.
 * `cuts: {top: 0.4}` says what is going on; five keys of which four are zero
 * does not.
 */
export function trimCuts(cuts: Record<CutSide, number>): SectionCuts {
  const out: SectionCuts = {};
  for (const side of CUT_SIDES) {
    if (cuts[side] > 0) out[side] = round3(cuts[side]);
  }
  return out;
}

export function anyCut(cuts: Record<CutSide, number>): boolean {
  return CUT_SIDES.some((side) => cuts[side] > 0);
}

/**
 * Carry a pre-0.7 `planes:` block over to the five sides.
 *
 * The old planes were world coordinates, so this needs the model's bounds and
 * therefore cannot happen in the config schema — the controller does it once
 * the model has loaded. `invert: false` kept the lesser half, which is a cut
 * coming in from the greater face, and vice versa.
 */
export function cutsFromPlanes(
  planes: readonly ClipPlaneState[],
  min: readonly number[],
  max: readonly number[],
): SectionCuts {
  const cuts: SectionCuts = {};
  for (const plane of planes) {
    if (!plane?.enabled || !Number.isFinite(plane.position)) continue;
    const face: 'min' | 'max' = plane.invert ? 'min' : 'max';
    const side = CUT_SIDES.find(
      (candidate) =>
        CUT_GEOMETRY[candidate].axis === plane.axis && CUT_GEOMETRY[candidate].face === face,
    );
    // The floor is not one of the five, so an old plane keeping the top half of
    // the Y axis has nowhere to go. Dropping it is the honest outcome.
    if (!side) continue;
    const index = AXIS_INDEX[plane.axis];
    const depth = cutDepthAt(side, plane.position, min[index] ?? 0, max[index] ?? 0);
    if (depth > 0) cuts[side] = depth;
  }
  return cuts;
}
