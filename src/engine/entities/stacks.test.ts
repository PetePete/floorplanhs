import { describe, expect, it } from 'vitest';

import {
  fanLift,
  joinStack,
  leaveStack,
  moveStack,
  nextStackId,
  stackFor,
  stackTarget,
} from '@/engine/entities/stacks';
import type { PlacedEntity, Vec3 } from '@/types/config';

/**
 * A lamp, its switch and the sensor that drives them are one place in the
 * house. What follows is the arithmetic of putting them in one pile and taking
 * them out again — the two gestures on top of it are drag-the-anchor and
 * drag-the-label.
 */

function at(entity: string, x: number, z: number, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entity, position: [x, 2.5, z] as Vec3, level: 'ground', ...extra };
}

describe('finding what a drop landed on', () => {
  const house = [at('light.a', 0, 0), at('switch.b', 3, 0), at('sensor.c', 0, 3)];

  it('takes the marker under the drop', () => {
    expect(stackTarget(house, 'sensor.c', [0.1, 2.5, 0.1], 'ground')?.entity).toBe('light.a');
  });

  it('takes the nearest when two are within reach', () => {
    const crowd = [at('light.a', 0, 0), at('switch.b', 0.3, 0)];
    expect(stackTarget(crowd, 'sensor.c', [0.25, 2.5, 0], 'ground')?.entity).toBe('switch.b');
  });

  it('ignores a drop that landed on open floor', () => {
    expect(stackTarget(house, 'sensor.c', [1.5, 2.5, 1.5], 'ground')).toBeNull();
  });

  it('never stacks across storeys, however close in plan', () => {
    const stairs = [at('light.a', 0, 0, { level: 'upper' })];
    expect(stackTarget(stairs, 'switch.b', [0, 2.5, 0], 'ground')).toBeNull();
  });

  it('does not stack a marker on itself', () => {
    expect(stackTarget(house, 'light.a', [0, 2.5, 0], 'ground')).toBeNull();
  });
});

describe('joining a stack', () => {
  it('starts one, and brings the newcomer to the target spot', () => {
    const house = [at('light.a', 1, 1), at('switch.b', 5, 5)];
    const next = joinStack(house, 'switch.b', house[0]);

    expect(next[0].stack).toBe('stack_1');
    expect(next[1].stack).toBe('stack_1');
    expect(next[1].position).toEqual([1, 2.5, 1]);
  });

  it('joins the existing stack rather than starting a second', () => {
    const house = [
      at('light.a', 1, 1, { stack: 'stack_1' }),
      at('switch.b', 1, 1, { stack: 'stack_1' }),
      at('sensor.c', 4, 4),
    ];
    const next = joinStack(house, 'sensor.c', house[0]);
    expect(next.map((entry) => entry.stack)).toEqual(['stack_1', 'stack_1', 'stack_1']);
  });

  it('picks an id nobody is using', () => {
    const house = [at('light.a', 0, 0, { stack: 'stack_1' }), at('switch.b', 0, 0, { stack: 'stack_2' })];
    expect(nextStackId(house)).toBe('stack_3');
  });
});

describe('leaving a stack', () => {
  const three = [
    at('light.a', 1, 1, { stack: 's' }),
    at('switch.b', 1, 1, { stack: 's' }),
    at('sensor.c', 1, 1, { stack: 's' }),
  ];

  it('takes one out and leaves the rest stacked', () => {
    const next = leaveStack(three, 'sensor.c');
    expect(next.find((e) => e.entity === 'sensor.c')?.stack).toBeUndefined();
    expect(next.filter((e) => e.stack === 's')).toHaveLength(2);
  });

  /** Two markers in one pile, take one out, and what is left is not a pile. */
  it('dissolves what would be a stack of one', () => {
    const pair = three.slice(0, 2);
    const next = leaveStack(pair, 'switch.b');
    expect(next.every((entry) => entry.stack === undefined)).toBe(true);
  });

  it('leaves an unstacked marker alone', () => {
    const loose = [at('light.a', 0, 0)];
    expect(leaveStack(loose, 'light.a')).toEqual(loose);
  });
});

describe('the stack as a whole', () => {
  const stacked = [
    at('light.a', 1, 1, { stack: 's' }),
    at('switch.b', 1, 1, { stack: 's' }),
    at('sensor.c', 8, 8),
  ];

  it('reports its members in the order they were added', () => {
    expect(stackFor(stacked, 'switch.b')?.members.map((m) => m.entity)).toEqual([
      'light.a',
      'switch.b',
    ]);
  });

  it('is not a stack when only one member is left', () => {
    const single = [at('light.a', 0, 0, { stack: 's' })];
    expect(stackFor(single, 'light.a')).toBeNull();
  });

  it('moves every member and nobody else', () => {
    const next = moveStack(stacked, 's', [4, 2.5, 4], 'upper');
    expect(next[0].position).toEqual([4, 2.5, 4]);
    expect(next[1].position).toEqual([4, 2.5, 4]);
    expect(next[0].level).toBe('upper');
    expect(next[2].position).toEqual([8, 2.5, 8]);
  });

  it('fans the labels apart so the pile can be read', () => {
    expect(fanLift(0, 0.34)).toBeCloseTo(0.34, 5);
    expect(fanLift(1, 0.34)).toBeCloseTo(0.76, 5);
    expect(fanLift(2, 0.34)).toBeCloseTo(1.18, 5);
  });
});

describe('a stack being carried', () => {
  /** Dragging a pile by its anchor must not snap back onto its own members. */
  it('does not offer its own stack as a target', () => {
    const pile = [
      at('light.a', 1, 1, { stack: 's' }),
      at('switch.b', 1, 1, { stack: 's' }),
      at('sensor.c', 6, 6),
    ];
    expect(stackTarget(pile, 'light.a', [1.05, 2.5, 1], 'ground')).toBeNull();
  });

  it('still offers a different pile to join', () => {
    const two = [
      at('light.a', 1, 1, { stack: 's' }),
      at('switch.b', 1, 1, { stack: 's' }),
      at('sensor.c', 6, 6, { stack: 't' }),
      at('cover.d', 6, 6, { stack: 't' }),
    ];
    expect(stackTarget(two, 'light.a', [6, 2.5, 6], 'ground')?.stack).toBe('t');
  });
});
