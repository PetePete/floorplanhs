/**
 * Markers that share one spot.
 *
 * A lamp, its switch and the motion sensor that drives them are one place in
 * the house, and three chips fighting over the same square metre is what that
 * looked like before. Dropped on one another they become a stack: one anchor,
 * the labels fanned up from it so you can read what is in there.
 *
 * The rules are the two gestures. Drag the **anchor** and the whole stack goes;
 * drag a **label** and that one marker comes out. Everything here is the pure
 * arithmetic behind that — no three.js, no config writing, so it can be tested
 * as the table of cases it is.
 */

import type { PlacedEntity, Vec3 } from '@/types/config';

/**
 * How close two markers must land to become a stack, in metres.
 *
 * Wide enough that dropping "on" a marker succeeds without aiming, narrow
 * enough that two lamps either side of a doorway stay two lamps.
 */
export const STACK_RADIUS_M = 0.35;



export function stackOf(entity: PlacedEntity | undefined): string | null {
  return entity?.stack ?? null;
}

/** Every entity in the same stack, in config order — the order they were added. */
export function stackMembers(entities: readonly PlacedEntity[], stackId: string): PlacedEntity[] {
  return entities.filter((entry) => entry.stack === stackId);
}

/** The stack an entity belongs to, with its members; null when it stands alone. */
export function stackFor(
  entities: readonly PlacedEntity[],
  entityId: string,
): { id: string; members: PlacedEntity[] } | null {
  const self = entities.find((entry) => entry.entity === entityId);
  const id = stackOf(self);
  if (!id) return null;
  const members = stackMembers(entities, id);
  // A stack of one is not a stack; it is a marker with a stale label on it.
  return members.length > 1 ? { id, members } : null;
}

function distanceXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

/**
 * The entity a drop landed on top of, or null.
 *
 * Same storey only: two markers a floor apart are not in the same place however
 * close their plan coordinates are, and stacking them would hide one behind a
 * ceiling.
 */
export function stackTarget(
  entities: readonly PlacedEntity[],
  moved: string,
  position: Vec3,
  level: string | null,
  radius = STACK_RADIUS_M,
): PlacedEntity | null {
  let best: PlacedEntity | null = null;
  let bestDistance = radius;
  // The pile it is already on is not a target: dragging a stack by its anchor
  // would otherwise snap straight back onto the mates it is carrying.
  const own = stackOf(entities.find((entry) => entry.entity === moved));

  for (const entry of entities) {
    if (entry.entity === moved) continue;
    if (own && entry.stack === own) continue;
    if ((entry.level ?? null) !== level) continue;
    const distance = distanceXZ(entry.position, position);
    if (distance > bestDistance) continue;
    bestDistance = distance;
    best = entry;
  }
  return best;
}

/** A readable id, unique among the stacks already in play. */
export function nextStackId(entities: readonly PlacedEntity[]): string {
  const taken = new Set(entities.map((entry) => entry.stack).filter(Boolean));
  for (let n = 1; ; n += 1) {
    const id = `stack_${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Put `moved` on the stack `target` belongs to, making one if it has none, and
 * bring it to the target's spot so the stack has a single anchor.
 *
 * Returns a new list; the caller decides whether to keep it.
 */
export function joinStack(
  entities: readonly PlacedEntity[],
  moved: string,
  target: PlacedEntity,
): PlacedEntity[] {
  const id = target.stack ?? nextStackId(entities);
  return entities.map((entry) => {
    if (entry.entity === target.entity) return withStack(entry, id);
    if (entry.entity !== moved) return entry;
    return {
      ...withStack(entry, id),
      position: [...target.position] as Vec3,
      level: target.level ?? null,
    };
  });
}

/**
 * On the pile, and without a label offset of its own.
 *
 * The rows of a stack are placed by their position in the list; a leftover
 * offset from when the marker stood alone would drag one row off sideways and
 * the list would stop being one.
 */
function withStack(entry: PlacedEntity, id: string): PlacedEntity {
  const next: PlacedEntity = entry.stack === id ? { ...entry } : { ...entry, stack: id };
  if (!next.marker?.offset) return next;
  const { offset: _offset, ...marker } = next.marker;
  next.marker = Object.keys(marker).length > 0 ? marker : undefined;
  if (next.marker === undefined) delete next.marker;
  return next;
}

/**
 * Take one marker out of its stack, and dissolve what is left if only one
 * member remains — a stack of one is just a marker again.
 */
export function leaveStack(entities: readonly PlacedEntity[], entityId: string): PlacedEntity[] {
  const self = entities.find((entry) => entry.entity === entityId);
  const id = stackOf(self);
  if (!id) return [...entities];

  const remaining = stackMembers(entities, id).filter((entry) => entry.entity !== entityId);
  const dissolve = remaining.length <= 1;

  return entities.map((entry) => {
    if (entry.entity === entityId || (dissolve && entry.stack === id)) {
      const { stack: _stack, ...rest } = entry;
      return rest;
    }
    return entry;
  });
}

/**
 * Move every member of a stack to one spot.
 *
 * `room` follows the same rule as a single marker: a name is the room the pile
 * was dragged *out of*, and it is what the leader line points back at;
 * `undefined` means the drop landed inside a room, where the position already
 * says which, so any old override is dropped rather than left to go stale.
 */
export function moveStack(
  entities: readonly PlacedEntity[],
  stackId: string,
  position: Vec3,
  level: string | null,
  room?: string,
): PlacedEntity[] {
  return entities.map((entry) => {
    if (entry.stack !== stackId) return entry;
    const moved: PlacedEntity = { ...entry, position: [...position] as Vec3, level };
    if (room) moved.room = room;
    else delete moved.room;
    return moved;
  });
}
