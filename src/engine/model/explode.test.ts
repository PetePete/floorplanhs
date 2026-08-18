import { describe, expect, it } from 'vitest';
import { explodeOffsets, offsetOf } from '@/engine/model/explode';
import type { LevelDefinition } from '@/types/config';

const LEVELS: LevelDefinition[] = [
  { id: 'upper', name: 'Upper', elevation: 2.6, height: 2.5 },
  { id: 'ground', name: 'Ground', elevation: 0, height: 2.6 },
  { id: 'basement', name: 'Basement', elevation: -2.7, height: 2.7 },
];

describe('exploded view offsets', () => {
  it('lifts each storey by a whole step, bottom one staying put', () => {
    const offsets = explodeOffsets(LEVELS, 1.5);
    // Ordered by real elevation, not by the order they were declared in.
    expect(offsets.get('basement')).toBeUndefined();
    expect(offsets.get('ground')).toBe(1.5);
    expect(offsets.get('upper')).toBe(3);
  });

  it('spaces storeys evenly however unevenly the building is built', () => {
    // The basement is 2.7 m below ground and the upper floor 2.6 m above it.
    // An exploded drawing is about separation, so both gaps come out equal.
    const offsets = explodeOffsets(LEVELS, 2);
    expect(offsets.get('upper')! - offsets.get('ground')!).toBe(2);
    expect(offsets.get('ground')! - 0).toBe(2);
  });

  it('does nothing at all for a gap of zero', () => {
    expect(explodeOffsets(LEVELS, 0).size).toBe(0);
    expect(explodeOffsets(LEVELS, -1).size).toBe(0);
  });

  it('does nothing for a single-storey building, which has nothing to separate', () => {
    expect(explodeOffsets([LEVELS[1]], 1.5).size).toBe(0);
  });

  it('reads back zero for the bottom storey and for anything it does not know', () => {
    const offsets = explodeOffsets(LEVELS, 1.5);
    expect(offsetOf(offsets, 'basement')).toBe(0);
    expect(offsetOf(offsets, 'attic')).toBe(0);
    expect(offsetOf(offsets, null)).toBe(0);
    expect(offsetOf(null, 'upper')).toBe(0);
  });
});
