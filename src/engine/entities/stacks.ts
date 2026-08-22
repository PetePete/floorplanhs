/**
 * Markers that share one spot.
 *
 * A lamp, its switch and the motion sensor that drives them are one place in
 * the house, and three chips fighting over the same square metre is what that
 * looked like before. Dropped on one another they become a stack: one anchor,
 * the labels fanned up from it so you can read what is in there.
 *
 * The rules are the two gestures. Drag the **anchor** (or the pile's grab bar)
 * and the whole stack goes; drag a **row** and that one marker comes out.
 * Everything here is the pure arithmetic behind that — no three.js, no config
 * writing, so it can be tested as the table of cases it is.
 *
 * What counts as "dropped on" is decided in screen space by `EntityLayer.pick`,
 * not by distance in metres: a stack is markers that *look* like one pile, and
 * whether their anchors are a metre apart is invisible from where the user is
 * sitting. So nothing here measures the plan — the caller says which marker the
 * drop landed on.
 */

import type { PlacedEntity, Vec3 } from '@/types/config';

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
    const kept = withHome(rebaseOffset(withStack(entry, id, target), entry.position, target.position), target.position);
    return { ...kept, position: [...target.position] as Vec3, level: target.level ?? null };
  });
}

/** Metres a label floats above its anchor when it has none of its own. */
const DEFAULT_LABEL_LIFT = 0.34;

/**
 * Where a marker stands when it is not on a pile — its own spot in the house.
 *
 * For a member that is the pile's anchor plus what it remembers of where it
 * came from. For anyone else it is simply where they are.
 */
function homeOf(entry: PlacedEntity): Vec3 {
  const from = entry.stackFrom;
  if (!from) return [...entry.position] as Vec3;
  return [
    round3(entry.position[0] + from[0]),
    round3(entry.position[1] + from[1]),
    round3(entry.position[2] + from[2]),
  ];
}

/**
 * Record where a marker came from, as a vector from the pile it is joining.
 *
 * A vector, not a point: a pile that is later dragged across the house should
 * hand its markers back beside its new home, not at an address nothing is at
 * any more. And a marker moving from one pile to another keeps the home it had
 * all along rather than adopting the first pile's spot as its own.
 */
function withHome(entry: PlacedEntity, pile: Vec3): PlacedEntity {
  const home = homeOf(entry);
  const from: Vec3 = [
    round3(home[0] - pile[0]),
    round3(home[1] - pile[1]),
    round3(home[2] - pile[2]),
  ];
  if (from[0] === 0 && from[1] === 0 && from[2] === 0) {
    const { stackFrom: _drop, ...rest } = entry;
    return rest;
  }
  return { ...entry, stackFrom: from };
}

/**
 * Keep the label where it is on the plan while the anchor moves under it.
 *
 * `marker.offset` is measured from the anchor, which is the right way round for
 * everything a user does by hand: drag the marker and its caption comes along.
 * It is the wrong way round for the two moves nobody asked for — joining a pile
 * and leaving one — because there the anchor is relocated *for* you, and a
 * caption that was put somewhere legible ends up an equal distance from a
 * completely different point. The line then runs off to nowhere in particular,
 * and the only way back is to drop the marker on the exact spot it started on.
 *
 * Rebasing by the anchor's own travel leaves the caption on the plan where it
 * was, so the line still points at the place it was drawn to.
 */
function rebaseOffset(entry: PlacedEntity, from: Vec3, to: Vec3): PlacedEntity {
  const offset = entry.marker?.offset;
  if (!offset) return entry;
  const dx = from[0] - to[0];
  const dz = from[2] - to[2];
  if (dx === 0 && dz === 0) return entry;
  return {
    ...entry,
    marker: {
      ...entry.marker,
      // The lift is not a place on the plan, it is how high the chip floats.
      offset: [round3(offset[0] + dx), offset[1], round3(offset[2] + dz)] as Vec3,
    },
  };
}

/** Millimetres are as fine as a floorplan gets; see `vRound`. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * On the pile.
 *
 * The rows of a stack are placed by their position in the list, so a label
 * offset from when the marker stood alone plays no part while it is a member —
 * the layer lays every row out from the shared anchor and ignores it.
 *
 * Ignored, and deliberately not deleted. It was deleted here once, to stop a
 * leftover offset dragging a row off sideways, and that made joining a pile
 * throw away the one thing the marker had been told by hand: where its label
 * sits, and therefore the leader line drawn to it. The tidying now happens
 * where the rows are laid out, which is the only place that has any business
 * overruling it — and leaving the pile hands the label straight back.
 */
function withStack(entry: PlacedEntity, id: string, from?: PlacedEntity): PlacedEntity {
  const next: PlacedEntity = entry.stack === id ? { ...entry } : { ...entry, stack: id };
  // What the pile says about itself travels with membership. `room` never does:
  // that is each entity's own statement about where it is, and a stack is a
  // grouping on the screen, not a claim about the house.
  if (from) {
    if (from.stackRoom) next.stackRoom = from.stackRoom;
    else delete next.stackRoom;
    if (from.stackColor) next.stackColor = from.stackColor;
    else delete next.stackColor;
  }
  return next;
}

/**
 * Tip a whole pile onto another marker: every member joins the target's stack.
 *
 * Two piles pushed together are one pile — the alternative, refusing because
 * both sides already have an id, would be arithmetic getting in the way of the
 * obvious. The target's id wins, so whichever stack was there first keeps its
 * name in the YAML.
 */
export function mergeStacks(
  entities: readonly PlacedEntity[],
  movedStack: string,
  target: PlacedEntity,
): PlacedEntity[] {
  const id = target.stack ?? nextStackId(entities);
  if (id === movedStack) return [...entities];
  return entities.map((entry) => {
    if (entry.entity === target.entity) return withStack(entry, id);
    if (entry.stack !== movedStack) return entry;
    const kept = withHome(rebaseOffset(withStack(entry, id, target), entry.position, target.position), target.position);
    return { ...kept, position: [...target.position] as Vec3, level: target.level ?? null };
  });
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
    if (entry.entity === entityId || (dissolve && entry.stack === id)) return freeFromPile(entry);
    return entry;
  });
}

/**
 * A marker with nothing left of the pile on it, back on its own spot.
 *
 * The one left behind when a pile of two comes apart never asked for any of it:
 * it was not dragged, it did not leave, the group simply stopped existing
 * around it. Leaving it standing on the pile's spot with its own address thrown
 * away would make the *other* marker's departure move it, which is the last
 * thing a marker that was not touched should do.
 *
 * Its label comes back with it. The offset was rebased when it joined so the
 * caption would not move; rebasing it by the same travel in reverse is exactly
 * the offset it had before, so the line is the line it used to draw.
 */
function freeFromPile(entry: PlacedEntity): PlacedEntity {
  const home = entry.stackFrom ? homeOf(entry) : null;
  const based = home ? rebaseOffset(entry, entry.position, home) : entry;
  // Off the pile, and without the things that were the pile's: its room and its
  // colour said something about the group, not about this marker.
  const {
    stack: _stack,
    stackFrom: _from,
    stackRoom: _room,
    stackColor: _color,
    ...rest
  } = based;
  return home ? { ...rest, position: home } : rest;
}

/** The room a pile currently points at, as any of its members states it. */
function roomOf(entities: readonly PlacedEntity[], stackId: string): string | undefined {
  return entities.find((entry) => entry.stack === stackId && entry.stackRoom)?.stackRoom;
}

/**
 * Move every member of a stack to one spot.
 *
 * `room` follows the same rule as a single marker — a name is the room the pile
 * was dragged *out of*, and it is what the leader line points back at;
 * `undefined` means the drop landed inside a room, where the position already
 * says which — but it is written as the *pile's* room. The members' own `room`
 * is what each of them says about itself, and dragging a group of chips across
 * the screen is not a statement about where a lamp hangs.
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
    if (room) moved.stackRoom = room;
    else delete moved.stackRoom;
    return moved;
  });
}

/**
 * A marker let go of somewhere, with everything the drop knew about it.
 *
 * `carryStack: false` says one row of a pile was in the hand rather than the
 * pile itself. The two look the same at the point of release — both land on
 * some marker, or on open floor — and they mean opposite things.
 */
export interface MoveRequest {
  entityId: string;
  position: Vec3;
  level: string | null;
  /** The room it was dragged out of; absent clears any existing override. */
  room?: string;
  /** The marker the drop landed on, if any. */
  stackWith?: string | null;
  /** Whether the whole pile travelled. Anything but `false` means it did. */
  carryStack?: boolean;
}

/**
 * Where everything ends up after a drop. The one place that decides it.
 *
 * The viewer applies a drop straight away so the marker does not spring back
 * while the dashboard takes its time, and the card applies the same drop to the
 * config it writes. Written twice, they drifted twice: a pile tipped onto
 * another marker moved without merging, and once that was fixed in both places,
 * a single row dragged off a pile onto another marker took its whole pile along
 * — the branch could not tell the two gestures apart.
 */
export function resolveMove(
  entities: readonly PlacedEntity[],
  request: MoveRequest,
): PlacedEntity[] {
  const { entityId, position, level, room } = request;
  const self = entities.find((entry) => entry.entity === entityId);
  if (!self) return [...entities];

  const target = request.stackWith
    ? (entities.find((entry) => entry.entity === request.stackWith) ?? null)
    : null;
  const pile = stackFor(entities, entityId);
  const carrying = pile && request.carryStack !== false ? pile : null;

  if (carrying) {
    // Tipped onto a marker that is not one of its own: the piles become one,
    // and the merged pile lands where the drop was.
    if (target && target.stack !== carrying.id) {
      const merged = mergeStacks(entities, carrying.id, target);
      const id = merged.find((entry) => entry.entity === entityId)?.stack;
      return id ? moveStack(merged, id, position, level, room ?? roomOf(merged, id)) : merged;
    }
    // The pile itself was dragged, so the drop does speak for its room: a name
    // is where it came from, nothing is "it is inside a room now".
    return moveStack(entities, carrying.id, position, level, room);
  }

  // One marker in the hand. If it was on a pile it leaves it first, which also
  // dissolves a pile of two down to a plain marker.
  const freed = pile ? leaveStack(entities, entityId) : [...entities];

  const onto = target ? (freed.find((entry) => entry.entity === target.entity) ?? null) : null;
  if (onto && onto.entity !== entityId) {
    const joined = joinStack(freed, entityId, onto);
    const id = joined.find((entry) => entry.entity === entityId)?.stack;
    // A newcomer does not speak for the pile's room. The drop that carried it
    // in says where *it* came from, and answering "nothing" there used to be
    // read as "this pile is inside a room now" — so adding a marker to a pile
    // rubbed out the line the pile was drawing.
    return id ? moveStack(joined, id, position, level, room ?? roomOf(joined, id)) : joined;
  }

  return freed.map((entry) => {
    if (entry.entity !== entityId) return entry;
    // Returned, not spread over `entry` again: `settle` builds from `entry` and
    // may *remove* the room, and an outer spread would hand it straight back.
    return settle(entry, position, level, room, pile !== null);
  });
}

/**
 * Where a marker lands, and what happens to the room it names.
 *
 * The room follows one rule everywhere: a name is the room it was dragged *out
 * of* and is what the leader line points back at; nothing means the drop landed
 * inside a room, where the position already says which, so a stale override is
 * dropped rather than left to go wrong.
 *
 * `leavingPile` suspends the whole of it. A marker coming off a pile has not
 * been dragged across the plan — it has been taken out of a group — and the
 * room it names is a setting it had before it ever joined and goes on wanting
 * once it is on its own again. Neither half of the rule may touch it:
 *
 *   - clearing it threw away the one thing a marker is expected to remember;
 *   - *setting* it was worse and less obvious. The room a drop names is the one
 *     the gesture started in, and for a detach that is wherever the pile was
 *     standing — so a sensor reporting on the kitchen came off a pile in the
 *     hall and started pointing at the hall.
 *
 * A marker that names no room of its own still takes the one it was dragged out
 * of: there is nothing to protect, and the leader line is the point of the
 * gesture.
 */
function settle(
  entry: PlacedEntity,
  position: Vec3,
  level: string | null,
  room: string | undefined,
  leavingPile: boolean,
): PlacedEntity {
  const moved: PlacedEntity = { ...entry, position: [...position] as Vec3, level };
  if (leavingPile) {
    if (!moved.room && room) moved.room = room;
    return moved;
  }
  if (room) moved.room = room;
  else delete moved.room;
  return moved;
}

/**
 * Take a marker off its pile, and put both halves of it back where they belong.
 *
 * What you are dragging out of a pile is a *row* — a label — so `labelAt` is
 * where the label goes: under the cursor, where you let go. The entity itself
 * goes home, to the spot it stood on before it ever joined, because joining was
 * a way of tidying the screen and never a decision about where the lamp hangs.
 * The leader line then runs from the lamp to the caption you just placed, which
 * is the line the marker had before the pile and the one you were asking for
 * back.
 *
 * Without a remembered home — a pile built by an older version — the drop point
 * is all there is, so the marker lands there and keeps its label above it.
 *
 * The card writes this and the viewer draws it, from one rule.
 */
export function unstackTo(
  entities: readonly PlacedEntity[],
  entityId: string,
  labelAt: Vec3,
  level: string | null,
  room?: string,
): PlacedEntity[] {
  const self = entities.find((entry) => entry.entity === entityId);
  if (!self) return [...entities];

  const home = self.stackFrom ? homeOf(self) : null;
  const anchor = home ?? labelAt;
  const lift = self.marker?.offset?.[1] ?? DEFAULT_LABEL_LIFT;
  const offset: Vec3 = home
    ? [round3(labelAt[0] - anchor[0]), lift, round3(labelAt[2] - anchor[2])]
    : [0, lift, 0];

  return leaveStack(entities, entityId).map((entry) => {
    if (entry.entity !== entityId) return entry;
    const settled = settle(entry, anchor, home ? (self.level ?? level) : level, room, true);
    return { ...settled, marker: withOffset(settled.marker, offset) };
  });
}

/** The label's place beside its anchor, without disturbing the rest. */
function withOffset(marker: PlacedEntity['marker'], offset: Vec3): PlacedEntity['marker'] {
  // A label sitting straight above its anchor is where a marker starts out, so
  // that is written as no offset at all rather than as a zero one.
  if (offset[0] === 0 && offset[2] === 0) {
    if (!marker?.offset) return marker;
    const { offset: _drop, ...rest } = marker;
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return { ...marker, offset };
}

/**
 * The things a pile says about itself, and the only ones it may write to its
 * members.
 *
 * `room` is deliberately not here. A stack groups chips on the screen; where a
 * lamp hangs and which room a sensor is measuring is each entity's own
 * statement, and a grouping must never overwrite it.
 */
export const STACK_FIELDS = ['stackRoom', 'stackColor'] as const;
export type StackField = (typeof STACK_FIELDS)[number];

/**
 * Apply a patch to one marker, spreading the pile's own fields to everyone on
 * it — they are held on every member so the pile keeps them whichever of them
 * is drawn first, and a patch that reached only one would leave the others
 * disagreeing with a frame and a line that speak for all of them.
 */
export function applyStackPatch(
  entities: readonly PlacedEntity[],
  entityId: string,
  patch: Partial<PlacedEntity>,
): PlacedEntity[] {
  const index = entities.findIndex((entry) => entry.entity === entityId);
  if (index < 0) return [...entities];

  const next = entities.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
  const pile = next[index].stack;
  const shared = STACK_FIELDS.filter((key) => key in patch);
  if (!pile || shared.length === 0) return next;

  return next.map((entry) => {
    if (entry.stack !== pile) return entry;
    const updated = { ...entry };
    for (const key of shared) {
      const value = patch[key];
      if (value) updated[key] = value;
      else delete updated[key];
    }
    return updated;
  });
}

/**
 * Move one member of a pile to another place in the list.
 *
 * The rows are drawn in the order the config lists them, bottom row first, so
 * this is the order you read the pile in — and the bottom row is also the one
 * that keeps the anchor dot and the leader line, which is a reason to care
 * beyond taste.
 *
 * Only the pile's own slots are touched. The members keep the positions they
 * occupy in `entities` and swap which of them sits in each, so a pile reordered
 * in a house full of markers leaves every other marker exactly where it was —
 * and a config diff shows the pile and nothing else.
 */
export function reorderStack(
  entities: readonly PlacedEntity[],
  stackId: string,
  from: number,
  to: number,
): PlacedEntity[] {
  const slots: number[] = [];
  entities.forEach((entry, index) => {
    if (entry.stack === stackId) slots.push(index);
  });
  if (slots.length < 2) return [...entities];
  if (from === to) return [...entities];
  if (from < 0 || from >= slots.length) return [...entities];
  // Clamped rather than refused: a drag that overshoots the end of a short list
  // means the end of the list.
  const target = Math.max(0, Math.min(slots.length - 1, to));
  if (from === target) return [...entities];

  const members = slots.map((index) => entities[index]);
  const [moved] = members.splice(from, 1);
  members.splice(target, 0, moved);

  const next = [...entities];
  slots.forEach((index, row) => {
    next[index] = members[row];
  });
  return next;
}
