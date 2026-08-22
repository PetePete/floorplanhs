import { describe, expect, it } from 'vitest';

import {
  applyStackPatch,
  unstackTo,
  joinStack,
  reorderStack,
  leaveStack,
  mergeStacks,
  resolveMove,
  moveStack,
  nextStackId,
  stackFor,
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
});

/**
 * Labels are the parts you can see and grab, so dragging two of them together
 * is how anyone says "put these in one place".
 *
 * Where a label was dragged to is a placement made by hand — it is what the
 * leader line is drawn to — and joining a pile must not spend it. The rows of a
 * stack are laid out from the shared anchor, so while a marker is a member the
 * offset simply plays no part; the layer overrules it where the rows are placed,
 * and the config keeps it for the day the marker is on its own again.
 *
 * Kept as a *place on the plan*, not as a distance from the anchor. The anchor
 * is relocated by these two moves, and a caption that keeps its distance from a
 * point that has moved is a caption that has moved — the line then ran off to
 * nowhere in particular unless the marker was dropped on the exact spot it
 * started from.
 */
describe('joining from where the labels were dragged', () => {
  /** Where the label sits on the plan: the anchor plus what it is offset by. */
  function labelAt(entry: PlacedEntity | undefined): [number, number] {
    const offset = entry?.marker?.offset ?? [0, 0, 0];
    return [(entry?.position[0] ?? 0) + offset[0], (entry?.position[2] ?? 0) + offset[2]];
  }

  it('leaves the label of the marker that joins where it was', () => {
    const house = [
      at('media_player.tv', 1, 1, { marker: { offset: [-5, 0.34, -3] } }),
      at('media_player.room', 4, 4, { marker: { offset: [-5.8, 0.34, -2.1] } }),
    ];
    const before = labelAt(house[1]);
    const next = joinStack(house, 'media_player.room', house[0]);

    expect(next[1].stack).toBe('stack_1');
    expect(next[1].position, 'the anchor goes to the pile').toEqual([1, 2.5, 1]);
    expect(labelAt(next[1]), 'the label does not').toEqual(before);
  });

  it('keeps it on the marker that was landed on as well', () => {
    const house = [
      at('media_player.tv', 1, 1, { marker: { offset: [-5, 0.34, -3] } }),
      at('media_player.room', 4, 4),
    ];
    const next = joinStack(house, 'media_player.room', house[0]);
    expect(next[0].marker?.offset).toEqual([-5, 0.34, -3]);
    expect(next[0].stack).toBe('stack_1');
  });

  it('leaves the rest of the marker config alone too', () => {
    const house = [
      at('light.a', 1, 1, { marker: { icon: 'mdi:lamp', offset: [1, 0.34, 1] } }),
      at('light.b', 4, 4),
    ];
    const next = joinStack(house, 'light.b', house[0]);
    expect(next[0].marker).toEqual({ icon: 'mdi:lamp', offset: [1, 0.34, 1] });
  });

  /**
   * Both halves go back where they belong. What you drag out of a pile is a
   * *row* — a label — so that is what lands under the cursor; the entity goes
   * home, because joining was a way of tidying the screen and never a decision
   * about where the lamp hangs.
   */
  it('sends the marker home and the label to where it was let go', () => {
    const house = [
      at('media_player.tv', 1, 1, { marker: { offset: [-5, 0.34, -3] } }),
      at('sensor.b', 4, 4, { marker: { offset: [2, 0.34, -1], icon: 'mdi:thermometer' } }),
    ];

    const joined = joinStack(house, 'sensor.b', house[0]);
    expect(joined[1].position, 'while stacked it shares the anchor').toEqual([1, 2.5, 1]);

    const out = unstackTo(joined, 'sensor.b', [7, 2.5, 7], 'ground');
    const back = out.find((entry) => entry.entity === 'sensor.b');

    expect(back?.stack).toBeUndefined();
    expect(back?.stackFrom, 'the memory is spent').toBeUndefined();
    expect(back?.position, 'the marker is back where it stood').toEqual([4, 2.5, 4]);
    expect(labelAt(back), 'the label is where it was let go').toEqual([7, 7]);
    expect(back?.marker?.icon, 'the rest of the marker config is untouched').toBe('mdi:thermometer');
  });

  it('brings a marker home even when the pile has been moved since', () => {
    const house = [at('light.a', 1, 1), at('sensor.b', 4, 4)];
    const joined = joinStack(house, 'sensor.b', house[0]);
    // The pile travels four metres east; the marker is three east of it either
    // way, so it comes back beside the pile's new home rather than at an
    // address nothing is at any more.
    const moved = moveStack(joined, 'stack_1', [5, 2.5, 1], 'ground');
    const out = unstackTo(moved, 'sensor.b', [9, 2.5, 2], 'ground');
    expect(out.find((entry) => entry.entity === 'sensor.b')?.position).toEqual([8, 2.5, 4]);
  });

  /** A pile from an older config has nothing to remember; the drop is all. */
  it('falls back to the drop point when there is no memory', () => {
    const legacy = [
      at('light.a', 1, 1, { stack: 's' }),
      at('sensor.b', 1, 1, { stack: 's' }),
    ];
    const out = unstackTo(legacy, 'sensor.b', [6, 2.5, 6], 'ground');
    const back = out.find((entry) => entry.entity === 'sensor.b');
    expect(back?.position).toEqual([6, 2.5, 6]);
    expect(back?.marker?.offset, 'and the label sits above it').toBeUndefined();
  });

  it('does the same when the pile is tipped onto another marker', () => {
    const world = [
      at('light.x', 0, 0),
      at('sensor.b', 4, 4, { stack: 's', marker: { offset: [2, 0.34, -1] } }),
      at('switch.c', 4, 4, { stack: 's' }),
    ];
    const before = labelAt(world[1]);
    const merged = mergeStacks(world, 's', world[0]);
    expect(labelAt(merged.find((entry) => entry.entity === 'sensor.b'))).toEqual(before);
  });
});

/**
 * A pile keeps its room, so the line back to it survives the move. Without
 * this a stack dragged out of a room lost the one thing that said which room
 * it belonged to — the statement a single marker makes in the same situation.
 */
/**
 * A stack groups chips on the screen. It says nothing about where a lamp hangs
 * or which room a sensor is measuring — so the room it points at is its own,
 * and the members keep theirs untouched.
 */
describe('a stack and its room', () => {
  const pile = [
    at('light.a', 1, 1, { stack: 's', room: 'kitchen' }),
    at('switch.b', 1, 1, { stack: 's', room: 'hall' }),
  ];

  it('records the room it was dragged out of, on every member', () => {
    const next = moveStack(pile, 's', [9, 2.5, 9], 'ground', 'kitchen');
    expect(next.map((entry) => entry.stackRoom)).toEqual(['kitchen', 'kitchen']);
  });

  it('never touches what a member says about itself', () => {
    const next = moveStack(pile, 's', [9, 2.5, 9], 'ground', 'kitchen');
    expect(next.map((entry) => entry.room), 'each entity keeps its own room').toEqual([
      'kitchen',
      'hall',
    ]);
  });

  it('drops the override when the pile lands inside a room again', () => {
    const next = moveStack(pile, 's', [2, 2.5, 2], 'ground', undefined);
    expect(next.every((entry) => entry.stackRoom === undefined)).toBe(true);
    expect(next.map((entry) => entry.room)).toEqual(['kitchen', 'hall']);
  });

  it('leaves markers outside the pile alone', () => {
    const mixed = [...pile, at('sensor.c', 8, 8, { room: 'hall' })];
    const next = moveStack(mixed, 's', [4, 2.5, 4], 'ground', 'kitchen');
    expect(next[2].room).toBe('hall');
    expect(next[2].position).toEqual([8, 2.5, 8]);
  });

  it('hands its room and its colour to a marker that joins', () => {
    const dressed = [
      at('light.a', 1, 1, { stack: 's', stackRoom: 'kitchen', stackColor: '#ff8800' }),
      at('switch.b', 1, 1, { stack: 's', stackRoom: 'kitchen', stackColor: '#ff8800' }),
    ];
    const next = joinStack([...dressed, at('sensor.c', 6, 6)], 'sensor.c', dressed[0]);
    const joined = next.find((entry) => entry.entity === 'sensor.c');
    expect(joined?.stackRoom).toBe('kitchen');
    expect(joined?.stackColor).toBe('#ff8800');
  });

  it('takes them back off a marker that leaves', () => {
    const dressed = [
      at('light.a', 1, 1, { stack: 's', stackRoom: 'kitchen', stackColor: '#ff8800' }),
      at('switch.b', 1, 1, { stack: 's', stackRoom: 'kitchen', stackColor: '#ff8800' }),
      at('sensor.c', 1, 1, { stack: 's', stackRoom: 'kitchen', stackColor: '#ff8800' }),
    ];
    const next = leaveStack(dressed, 'sensor.c');
    const gone = next.find((entry) => entry.entity === 'sensor.c');
    expect(gone?.stackRoom).toBeUndefined();
    expect(gone?.stackColor).toBeUndefined();
    expect(next.find((entry) => entry.entity === 'light.a')?.stackColor, 'the pile keeps its own')
      .toBe('#ff8800');
  });
});

/**
 * Two piles pushed together are one pile.
 *
 * The cursor already promised it — a pile dragged over another marker reads
 * "Add to Kitchen + 2 more" — and for a while the promise was all there was:
 * the mover looked the stack up by id, moved it to the drop point, and the two
 * ended up in the same spot belonging to nothing.
 */
describe('tipping one pile onto another', () => {
  const two = [
    at('light.a', 0, 0, { stack: 'a' }),
    at('switch.b', 0, 0, { stack: 'a' }),
    at('sensor.c', 3, 0, { stack: 'b' }),
    at('cover.d', 3, 0, { stack: 'b' }),
  ];

  it('puts everyone on the target’s id', () => {
    const merged = mergeStacks(two, 'a', two[2]);
    expect(merged.every((entry) => entry.stack === 'b')).toBe(true);
  });

  it('brings the whole pile to the spot it was tipped onto', () => {
    const merged = mergeStacks(two, 'a', two[2]);
    for (const entry of merged) expect(entry.position).toEqual([3, 2.5, 0]);
  });

  it('starts a pile when the target had none', () => {
    const loose = [at('light.a', 0, 0, { stack: 'a' }), at('switch.b', 0, 0, { stack: 'a' }), at('sensor.c', 3, 0)];
    const merged = mergeStacks(loose, 'a', loose[2]);
    const id = merged[2].stack;
    expect(id).toBeTruthy();
    expect(merged.every((entry) => entry.stack === id)).toBe(true);
  });

  it('does nothing when the target is already on this pile', () => {
    expect(mergeStacks(two, 'a', two[1])).toEqual(two);
  });

  it('leaves everyone else alone', () => {
    const bystander = at('fan.e', 9, 9);
    const merged = mergeStacks([...two, bystander], 'a', two[2]);
    expect(merged[4]).toEqual(bystander);
  });
});

/**
 * What a release actually writes.
 *
 * The gestures that arrive here are near-identical at the point of letting go —
 * something landed on something, or on open floor — and they mean opposite
 * things. A pile tipped onto a marker merges. One row of that pile dragged onto
 * the same marker takes *itself* there and leaves the pile behind. Writing
 * those rules twice, once for the config and once for what is drawn while the
 * dashboard catches up, is how they came apart.
 */
describe('resolving a drop', () => {
  function world(): PlacedEntity[] {
    return [
      at('light.a', 0, 0, { stack: 'a' }),
      at('switch.b', 0, 0, { stack: 'a' }),
      at('sensor.c', 0, 0, { stack: 'a' }),
      at('cover.d', 5, 0),
      at('fan.e', 9, 9),
    ];
  }

  const to = (x: number, z: number): Vec3 => [x, 2.5, z];

  it('carries the whole pile when the pile was in the hand', () => {
    const next = resolveMove(world(), {
      entityId: 'light.a',
      position: to(2, 2),
      level: 'ground',
    });
    for (const id of ['light.a', 'switch.b', 'sensor.c']) {
      expect(next.find((e) => e.entity === id)?.position, id).toEqual([2, 2.5, 2]);
    }
  });

  it('takes one row out and leaves the pile standing', () => {
    const next = resolveMove(world(), {
      entityId: 'light.a',
      position: to(2, 2),
      level: 'ground',
      carryStack: false,
    });
    expect(next.find((e) => e.entity === 'light.a')?.stack).toBeUndefined();
    expect(next.find((e) => e.entity === 'light.a')?.position).toEqual([2, 2.5, 2]);
    expect(next.find((e) => e.entity === 'switch.b')?.position, 'stays put').toEqual([0, 2.5, 0]);
    expect(next.find((e) => e.entity === 'switch.b')?.stack, 'still a pile of two').toBe('a');
  });

  /** The case that made this one function: a row dropped on another marker. */
  it('does not drag the pile along when one row joins something else', () => {
    const next = resolveMove(world(), {
      entityId: 'light.a',
      position: to(5, 0),
      level: 'ground',
      stackWith: 'cover.d',
      carryStack: false,
    });
    const joined = next.find((e) => e.entity === 'light.a')?.stack;
    expect(joined, 'on a new pile with the target').toBe(next.find((e) => e.entity === 'cover.d')?.stack);
    expect(next.find((e) => e.entity === 'switch.b')?.stack, 'the old pile is untouched').toBe('a');
    expect(next.find((e) => e.entity === 'switch.b')?.position).toEqual([0, 2.5, 0]);
  });

  it('merges the two when a whole pile is tipped onto a marker', () => {
    const next = resolveMove(world(), {
      entityId: 'light.a',
      position: to(5, 0),
      level: 'ground',
      stackWith: 'cover.d',
    });
    const id = next.find((e) => e.entity === 'cover.d')?.stack;
    expect(id).toBeTruthy();
    for (const entity of ['light.a', 'switch.b', 'sensor.c']) {
      expect(next.find((e) => e.entity === entity)?.stack, entity).toBe(id);
      expect(next.find((e) => e.entity === entity)?.position, entity).toEqual([5, 2.5, 0]);
    }
  });

  it('dissolves a pile of two when its last companion leaves', () => {
    const pair = [at('light.a', 0, 0, { stack: 'a' }), at('switch.b', 0, 0, { stack: 'a' })];
    const next = resolveMove(pair, {
      entityId: 'light.a',
      position: to(3, 3),
      level: 'ground',
      carryStack: false,
    });
    expect(next.every((entry) => entry.stack === undefined), 'nobody is left on a pile of one').toBe(
      true,
    );
  });

  it('starts a pile out of two lone markers', () => {
    const next = resolveMove(world(), {
      entityId: 'fan.e',
      position: to(5, 0),
      level: 'ground',
      stackWith: 'cover.d',
    });
    const id = next.find((e) => e.entity === 'fan.e')?.stack;
    expect(id).toBeTruthy();
    expect(next.find((e) => e.entity === 'cover.d')?.stack).toBe(id);
    expect(next.find((e) => e.entity === 'cover.d')?.position, 'the pile lands where they met')
      .toEqual([5, 2.5, 0]);
  });

  it('records the room a marker was dragged out of, and clears it on the way back in', () => {
    const out = resolveMove(world(), {
      entityId: 'fan.e',
      position: to(20, 20),
      level: 'ground',
      room: 'kitchen',
    });
    expect(out.find((e) => e.entity === 'fan.e')?.room).toBe('kitchen');

    const back = resolveMove(out, { entityId: 'fan.e', position: to(1, 1), level: 'ground' });
    expect(back.find((e) => e.entity === 'fan.e')?.room).toBeUndefined();
  });

  it('leaves the list alone for a marker it has never heard of', () => {
    const before = world();
    expect(resolveMove(before, { entityId: 'light.ghost', position: to(1, 1), level: 'ground' }))
      .toEqual(before);
  });
});

/**
 * Editing a pile against editing what is in it.
 *
 * The distinction is the whole point: a stack groups chips on the screen, so
 * its room and its colour are the pile's and belong on every member, while a
 * lamp's own room is the lamp's and must survive being piled up with a switch.
 */
describe('patching through a stack', () => {
  const pile = [
    at('light.a', 0, 0, { stack: 's', room: 'kitchen' }),
    at('switch.b', 0, 0, { stack: 's', room: 'hall' }),
    at('sensor.c', 5, 5, { room: 'study' }),
  ];

  it('gives the pile’s colour to every member', () => {
    const next = applyStackPatch(pile, 'light.a', { stackColor: '#ff8800' });
    expect(next.slice(0, 2).map((entry) => entry.stackColor)).toEqual(['#ff8800', '#ff8800']);
    expect(next[2].stackColor, 'and to nobody else').toBeUndefined();
  });

  it('gives the pile’s room to every member without touching theirs', () => {
    const next = applyStackPatch(pile, 'switch.b', { stackRoom: 'kitchen' });
    expect(next.slice(0, 2).map((entry) => entry.stackRoom)).toEqual(['kitchen', 'kitchen']);
    expect(next.map((entry) => entry.room), 'each entity keeps its own').toEqual([
      'kitchen',
      'hall',
      'study',
    ]);
  });

  it('clears the pile’s colour everywhere when it is reset', () => {
    const coloured = applyStackPatch(pile, 'light.a', { stackColor: '#ff8800' });
    const next = applyStackPatch(coloured, 'light.a', { stackColor: undefined });
    expect(next.every((entry) => entry.stackColor === undefined)).toBe(true);
    expect(next.every((entry) => 'stackColor' in entry), 'and leaves no empty key behind').toBe(
      false,
    );
  });

  it('keeps an entity patch to that entity, pile or no pile', () => {
    const next = applyStackPatch(pile, 'light.a', { room: 'cellar', name: 'Lamp' });
    expect(next[0].room).toBe('cellar');
    expect(next[0].name).toBe('Lamp');
    expect(next[1].room, 'the marker beside it on the pile is untouched').toBe('hall');
    expect(next[1].name).toBeUndefined();
  });

  it('leaves the list alone for a marker it has never heard of', () => {
    expect(applyStackPatch(pile, 'light.ghost', { stackColor: '#fff' })).toEqual(pile);
  });
});

/**
 * The order of the rows is the order you read the pile in, and the bottom row
 * is the one that keeps the anchor dot and the leader line — so it is worth
 * being able to say which marker that is.
 */
describe('reordering a pile', () => {
  const ids = (entities: PlacedEntity[]): string[] => entities.map((entry) => entry.entity);

  function house(): PlacedEntity[] {
    return [
      at('light.a', 0, 0, { stack: 's' }),
      at('sensor.x', 7, 7),
      at('switch.b', 0, 0, { stack: 's' }),
      at('cover.c', 0, 0, { stack: 's' }),
      at('fan.y', 9, 9),
    ];
  }

  it('moves a row up the list', () => {
    const next = reorderStack(house(), 's', 2, 0);
    expect(ids(next)).toEqual(['cover.c', 'sensor.x', 'light.a', 'switch.b', 'fan.y']);
  });

  it('moves a row down the list', () => {
    const next = reorderStack(house(), 's', 0, 2);
    expect(ids(next)).toEqual(['switch.b', 'sensor.x', 'cover.c', 'light.a', 'fan.y']);
  });

  /** The pile's slots are the pile's; nothing else shifts by one. */
  it('leaves every other marker exactly where it was', () => {
    const next = reorderStack(house(), 's', 0, 2);
    expect(next[1].entity).toBe('sensor.x');
    expect(next[4].entity).toBe('fan.y');
  });

  it('takes an overshoot as the end of the list', () => {
    const next = reorderStack(house(), 's', 0, 99);
    expect(ids(next)).toEqual(['switch.b', 'sensor.x', 'cover.c', 'light.a', 'fan.y']);
  });

  it('does nothing when the row is already there', () => {
    const before = house();
    expect(reorderStack(before, 's', 1, 1)).toEqual(before);
  });

  it('does nothing for a row that is not in the pile', () => {
    const before = house();
    expect(reorderStack(before, 's', 7, 0)).toEqual(before);
  });

  it('does nothing for a pile that is not there', () => {
    const before = house();
    expect(reorderStack(before, 'nope', 0, 1)).toEqual(before);
  });

  it('keeps what the pile says about itself on every member', () => {
    const dressed = [
      at('light.a', 0, 0, { stack: 's', stackColor: '#ff8800' }),
      at('switch.b', 0, 0, { stack: 's', stackColor: '#ff8800' }),
    ];
    const next = reorderStack(dressed, 's', 0, 1);
    expect(next.every((entry) => entry.stackColor === '#ff8800')).toBe(true);
    expect(ids(next)).toEqual(['switch.b', 'light.a']);
  });
});

/**
 * What a marker says about itself outlives the pile.
 *
 * `room` is a setting — which room a sensor is reporting on, which room a lamp
 * fills — and joining a group of chips on the screen is not a reason to forget
 * it. On a pile it simply goes unused: the pile draws one line, its own. Take
 * the marker out again and the setting is still there, which is the whole of
 * what "remembered" has to mean.
 */
describe('a marker that leaves a pile', () => {
  const pile = [
    at('light.a', 1, 1, { stack: 's', stackRoom: 'hall', stackColor: '#ff8800', room: 'kitchen' }),
    at('switch.b', 1, 1, { stack: 's', stackRoom: 'hall', stackColor: '#ff8800' }),
    at('sensor.c', 1, 1, { stack: 's', stackRoom: 'hall', stackColor: '#ff8800', room: 'study' }),
  ];

  it('keeps the room it named before it ever joined', () => {
    const next = unstackTo(pile, 'light.a', [4, 2.5, 4], 'ground');
    expect(next.find((entry) => entry.entity === 'light.a')?.room).toBe('kitchen');
  });

  it('leaves the pile’s own room and colour behind', () => {
    const next = unstackTo(pile, 'light.a', [4, 2.5, 4], 'ground');
    const gone = next.find((entry) => entry.entity === 'light.a');
    expect(gone?.stack).toBeUndefined();
    expect(gone?.stackRoom).toBeUndefined();
    expect(gone?.stackColor).toBeUndefined();
  });

  /**
   * The room a drop names is the one the *gesture* started in, which for a
   * detach is wherever the pile was standing. A marker that has said which room
   * it is talking about must not be argued with by the pile's address.
   */
  it('is not talked out of its own room by where the pile stood', () => {
    const next = unstackTo(pile, 'sensor.c', [9, 2.5, 9], 'ground', 'hall');
    expect(next.find((entry) => entry.entity === 'sensor.c')?.room).toBe('study');
  });

  /** Nothing to protect, and a line is the point of dragging it out there. */
  it('takes the room it was dragged out of when it named none itself', () => {
    const next = unstackTo(pile, 'switch.b', [9, 2.5, 9], 'ground', 'hall');
    expect(next.find((entry) => entry.entity === 'switch.b')?.room).toBe('hall');
  });

  it('lands where it was put', () => {
    const next = unstackTo(pile, 'light.a', [4, 2.5, 4], 'upper');
    const moved = next.find((entry) => entry.entity === 'light.a');
    expect(moved?.position).toEqual([4, 2.5, 4]);
    expect(moved?.level).toBe('upper');
  });

  it('leaves the rest of the pile alone', () => {
    const next = unstackTo(pile, 'light.a', [4, 2.5, 4], 'ground');
    expect(next.find((entry) => entry.entity === 'sensor.c')?.stack).toBe('s');
    expect(next.find((entry) => entry.entity === 'sensor.c')?.room, 'and its own room').toBe('study');
  });

  /** The same rule reached through a drag: a row pulled off keeps its room. */
  it('holds through a drag off the pile as well', () => {
    const next = resolveMove(pile, {
      entityId: 'light.a',
      position: [4, 2.5, 4],
      level: 'ground',
      carryStack: false,
    });
    expect(next.find((entry) => entry.entity === 'light.a')?.room).toBe('kitchen');
  });

  it('still clears a stale override for a marker that was never on a pile', () => {
    const loose = [at('fan.e', 9, 9, { room: 'cellar' })];
    const next = resolveMove(loose, { entityId: 'fan.e', position: [1, 2.5, 1], level: 'ground' });
    expect(next[0].room, 'dragged across the plan, the position speaks').toBeUndefined();
  });

  it('does nothing for a marker it has never heard of', () => {
    expect(unstackTo(pile, 'light.ghost', [0, 0, 0], 'ground')).toEqual(pile);
  });
});

/**
 * A pile's line survives what happens to the pile.
 *
 * The room a drop names answers "where did this come from", and for a marker
 * being carried *into* a pile the answer says nothing about the pile. Read as
 * "nothing, so this pile must be standing inside a room now", it rubbed out the
 * line the pile was drawing every time a marker was added to it.
 */
describe('adding to a pile that points at a room', () => {
  const pile: PlacedEntity[] = [
    at('light.a', 1, 1, { stack: 's', stackRoom: 'kitchen' }),
    at('switch.b', 1, 1, { stack: 's', stackRoom: 'kitchen' }),
    at('sensor.c', 8, 8, { room: 'study' }),
  ];

  it('keeps the line when a marker joins', () => {
    const next = resolveMove(pile, {
      entityId: 'sensor.c',
      position: [1, 2.5, 1],
      level: 'ground',
      stackWith: 'light.a',
    });
    expect(next.map((entry) => entry.stackRoom)).toEqual(['kitchen', 'kitchen', 'kitchen']);
  });

  it('leaves what the newcomer says about itself alone', () => {
    const next = resolveMove(pile, {
      entityId: 'sensor.c',
      position: [1, 2.5, 1],
      level: 'ground',
      stackWith: 'light.a',
    });
    expect(next.find((entry) => entry.entity === 'sensor.c')?.room).toBe('study');
  });

  it('gives it straight back when the marker leaves again', () => {
    const joined = resolveMove(pile, {
      entityId: 'sensor.c',
      position: [1, 2.5, 1],
      level: 'ground',
      stackWith: 'light.a',
    });
    const out = unstackTo(joined, 'sensor.c', [8, 2.5, 8], 'ground', 'kitchen');
    const back = out.find((entry) => entry.entity === 'sensor.c');
    expect(back?.room, 'its own room, not the pile’s address').toBe('study');
    expect(back?.stackRoom).toBeUndefined();
    expect(back?.stack).toBeUndefined();
  });

  it('and the pile keeps drawing its own', () => {
    const joined = resolveMove(pile, {
      entityId: 'sensor.c',
      position: [1, 2.5, 1],
      level: 'ground',
      stackWith: 'light.a',
    });
    const out = unstackTo(joined, 'sensor.c', [8, 2.5, 8], 'ground');
    expect(out.find((entry) => entry.entity === 'light.a')?.stackRoom).toBe('kitchen');
  });

  /** Dragging the pile itself is different: then the drop does speak for it. */
  it('still clears the pile’s room when the pile lands inside a room', () => {
    const next = resolveMove(pile, {
      entityId: 'light.a',
      position: [4, 2.5, 4],
      level: 'ground',
    });
    expect(next.slice(0, 2).every((entry) => entry.stackRoom === undefined)).toBe(true);
  });
});

/**
 * A pile of two coming apart.
 *
 * The marker left behind never asked for any of this: it was not dragged, it
 * did not leave, the group simply stopped existing around it. Leaving it on the
 * pile's spot with its own address thrown away would mean the *other* marker's
 * departure had moved it — the last thing a marker nobody touched should do.
 */
describe('a stack dissolving', () => {
  /** Where the label sits on the plan. */
  function labelAt(entry: PlacedEntity | undefined): [number, number] {
    const offset = entry?.marker?.offset ?? [0, 0, 0];
    return [(entry?.position[0] ?? 0) + offset[0], (entry?.position[2] ?? 0) + offset[2]];
  }

  function pair(): PlacedEntity[] {
    return [
      at('light.a', 1, 1, { marker: { offset: [-2, 0.34, 1], icon: 'mdi:lamp' } }),
      at('sensor.b', 6, 6),
    ];
  }

  it('puts the one left behind back on its own spot', () => {
    const start = pair();
    // light.a is landed on, so the pile stands where it stood; drag it onto the
    // sensor instead, and the pile is at the sensor's spot.
    const joined = joinStack(start, 'light.a', start[1]);
    expect(joined[0].position, 'while stacked it shares the anchor').toEqual([6, 2.5, 6]);

    const out = unstackTo(joined, 'sensor.b', [9, 2.5, 9], 'ground');
    expect(out.find((entry) => entry.entity === 'light.a')?.position).toEqual([1, 2.5, 1]);
  });

  it('gives it its label back with it', () => {
    const start = pair();
    const before = labelAt(start[0]);
    const joined = joinStack(start, 'light.a', start[1]);
    const out = unstackTo(joined, 'sensor.b', [9, 2.5, 9], 'ground');

    const back = out.find((entry) => entry.entity === 'light.a');
    expect(labelAt(back), 'the line it used to draw').toEqual(before);
    expect(back?.marker?.offset).toEqual([-2, 0.34, 1]);
    expect(back?.marker?.icon).toBe('mdi:lamp');
  });

  it('leaves nothing of the pile on either of them', () => {
    const start = [
      at('light.a', 1, 1, { }),
      at('sensor.b', 6, 6, { stackRoom: 'hall', stackColor: '#ff8800' }),
    ];
    const joined = joinStack(start, 'light.a', start[1]);
    const out = unstackTo(joined, 'sensor.b', [9, 2.5, 9], 'ground');
    for (const entry of out) {
      expect(entry.stack, entry.entity).toBeUndefined();
      expect(entry.stackFrom, entry.entity).toBeUndefined();
      expect(entry.stackRoom, entry.entity).toBeUndefined();
      expect(entry.stackColor, entry.entity).toBeUndefined();
    }
  });

  /** Three members: nobody is left behind, so nobody is sent anywhere. */
  it('leaves a pile of three standing when one goes', () => {
    const three = [
      at('light.a', 1, 1),
      at('switch.b', 2, 2),
      at('sensor.c', 6, 6),
    ];
    const one = joinStack(three, 'light.a', three[2]);
    const two = joinStack(one, 'switch.b', one[2]);
    const out = unstackTo(two, 'light.a', [9, 2.5, 9], 'ground');

    const staying = out.find((entry) => entry.entity === 'switch.b');
    expect(staying?.stack, 'still a pile').toBeTruthy();
    expect(staying?.position, 'and still on it').toEqual([6, 2.5, 6]);
    expect(staying?.stackFrom, 'with its own spot still remembered').toEqual([-4, 0, -4]);
  });
});
