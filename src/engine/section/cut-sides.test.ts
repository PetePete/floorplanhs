import { describe, expect, it } from 'vitest';

import {
  CUT_GEOMETRY,
  CUT_SIDES,
  OPPOSITE_SIDE,
  cutHeadroom,
  cutDepthAt,
  cutDirection,
  cutExtent,
  cutPlanePosition,
  cutsFromPlanes,
  sanitizeCuts,
  trimCuts,
} from '@/engine/section/cut-sides';
import type { CutSide } from '@/types/config';

/** A house 8 m wide, 6 m tall and 10 m deep, standing off the origin. */
const MIN = [-3, 0, -4];
const MAX = [5, 6, 6];

function span(side: CutSide): [number, number] {
  const index = { x: 0, y: 1, z: 2 }[CUT_GEOMETRY[side].axis];
  return [MIN[index], MAX[index]];
}

describe('which face is which', () => {
  /**
   * The model faces -Z (ARCHITECTURE.md), so the front of the house is its
   * lesser Z face and an observer looking at that front has +X on their right.
   * Get this wrong and every label in the panel is a lie.
   */
  it('puts the front at -Z and the right at +X', () => {
    expect(CUT_GEOMETRY.front).toEqual({ axis: 'z', face: 'min' });
    expect(CUT_GEOMETRY.back).toEqual({ axis: 'z', face: 'max' });
    expect(CUT_GEOMETRY.left).toEqual({ axis: 'x', face: 'min' });
    expect(CUT_GEOMETRY.right).toEqual({ axis: 'x', face: 'max' });
    expect(CUT_GEOMETRY.top).toEqual({ axis: 'y', face: 'max' });
  });

  it('offers no floor to cut away', () => {
    expect(CUT_SIDES).not.toContain('bottom');
    expect(CUT_SIDES).toHaveLength(5);
  });

  it('keeps the half of the axis the cut did not eat', () => {
    expect(cutDirection('left')).toBe(1);
    expect(cutDirection('right')).toBe(-1);
    expect(cutDirection('top')).toBe(-1);
  });
});

describe('facing sides', () => {
  it('pairs each wall with the one across from it, and the roof with nothing', () => {
    expect(OPPOSITE_SIDE.left).toBe('right');
    expect(OPPOSITE_SIDE.right).toBe('left');
    expect(OPPOSITE_SIDE.front).toBe('back');
    expect(OPPOSITE_SIDE.back).toBe('front');
    // There is no floor cut for it to run into.
    expect(OPPOSITE_SIDE.top).toBeNull();
  });

  it('gives a side the whole model when nothing faces it', () => {
    expect(cutHeadroom(0, 6, 0)).toBe(cutExtent(0, 6));
  });

  it('takes the facing cut off what is left to take', () => {
    // 8 m across, 3 m already gone from the other side.
    expect(cutHeadroom(-3, 5, 3)).toBeCloseTo(cutExtent(-3, 5) - 3, 6);
  });

  it('leaves nothing when the facing cut has taken the lot', () => {
    expect(cutHeadroom(-3, 5, 99)).toBe(0);
  });
});

describe('depth and plane', () => {
  it('starts every cut at its own face', () => {
    for (const side of CUT_SIDES) {
      const [min, max] = span(side);
      const at = cutPlanePosition(side, 0, min, max);
      expect(at).toBe(CUT_GEOMETRY[side].face === 'min' ? min : max);
    }
  });

  /** Whatever a handle is dragged to, the panel has to read the same number back. */
  it('round-trips a position through a depth', () => {
    for (const side of CUT_SIDES) {
      const [min, max] = span(side);
      const position = cutPlanePosition(side, 1.5, min, max);
      expect(cutDepthAt(side, position, min, max)).toBeCloseTo(1.5, 6);
    }
  });

  it('reads a drag past the far face as the deepest cut it allows', () => {
    const [min, max] = span('front');
    expect(cutDepthAt('front', max + 3, min, max)).toBe(cutExtent(min, max));
  });

  it('reads a drag back past the near face as no cut at all', () => {
    const [min, max] = span('front');
    expect(cutDepthAt('front', min - 3, min, max)).toBe(0);
  });

  /**
   * A cut that takes the last millimetre leaves an empty card and no handle to
   * drag back out of it.
   */
  it('always leaves a sliver of the model standing', () => {
    const [min, max] = span('top');
    expect(cutExtent(min, max)).toBeLessThan(max - min);
  });

  it('has nothing to cut when the model has no size', () => {
    expect(cutExtent(2, 2)).toBe(0);
  });
});

describe('reading and writing the record', () => {
  it('treats anything that is not a positive number as uncut', () => {
    const cuts = sanitizeCuts({
      top: 0.4,
      left: -1,
      right: Number.NaN,
      front: undefined,
    } as never);
    expect(cuts).toEqual({ top: 0.4, left: 0, right: 0, front: 0, back: 0 });
  });

  it('writes only the sides that are actually cut', () => {
    const cuts = sanitizeCuts({ top: 0.4004, back: 2 });
    expect(trimCuts(cuts)).toEqual({ top: 0.4, back: 2 });
  });
});

/**
 * The pre-0.7 form. `invert: false` kept the lesser half, which is a cut coming
 * in from the greater face.
 */
describe('carrying old planes across', () => {
  it('turns a plane keeping the lesser half into a cut from the far face', () => {
    const cuts = cutsFromPlanes([{ axis: 'z', position: 3, enabled: true, invert: false }], MIN, MAX);
    expect(cuts).toEqual({ back: 3 });
  });

  it('turns an inverted plane into a cut from the near face', () => {
    const cuts = cutsFromPlanes([{ axis: 'x', position: 1, enabled: true, invert: true }], MIN, MAX);
    expect(cuts).toEqual({ left: 4 });
  });

  it('ignores a plane that was switched off', () => {
    expect(
      cutsFromPlanes([{ axis: 'y', position: 3, enabled: false, invert: false }], MIN, MAX),
    ).toEqual({});
  });

  /** There is no floor side, so a plane that kept the top half has nowhere to go. */
  it('drops a plane that cut the floor away', () => {
    expect(
      cutsFromPlanes([{ axis: 'y', position: 3, enabled: true, invert: true }], MIN, MAX),
    ).toEqual({});
  });

  it('drops a plane that was sitting outside the model and cutting nothing', () => {
    expect(
      cutsFromPlanes([{ axis: 'x', position: 99, enabled: true, invert: false }], MIN, MAX),
    ).toEqual({});
  });
});
