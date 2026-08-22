/**
 * What a release will do, decided while the pointer is still down.
 *
 * Drag & drop on a floorplan has more than one outcome — put it here, put it on
 * that pile, take it off this pile, move the caption — and the user has to be
 * able to tell them apart *before* letting go. Guessing after the fact is how
 * markers end up somewhere nobody asked for.
 *
 * This module is the decision itself: no three.js, no config writing, no DOM,
 * so the whole table of cases can be tested as the table it is. The controller
 * gathers the situation, this says what it means, and the indicator says it out
 * loud.
 */

export type DropAction =
  /** Land here. */
  | 'place'
  /** Land on the marker under the pointer, and become a pile with it. */
  | 'join'
  /** Leave the pile this marker is on, and land here. */
  | 'detach'
  /** Still over its own pile, on the row it started on: releasing changes nothing. */
  | 'stay'
  /** Still over its own pile, on a different row: releasing reorders it. */
  | 'reorder'
  /** Moving a caption beside its anchor; the entity does not move. */
  | 'label'
  /** Nowhere to put it. */
  | 'invalid';

/** A marker the pointer is over, as far as the decision is concerned. */
export interface DropTarget {
  entityId: string;
  /** What to call it in the chip under the cursor. */
  name: string;
  /** The pile it is already on, if any. */
  stack: string | null;
  /** How many markers that pile holds; 1 for a marker standing alone. */
  size: number;
}

export interface DropSituation {
  mode: 'add' | 'move' | 'label';
  /** The pile the dragged marker belongs to, if any. */
  ownStack: string | null;
  /** True when the gesture carries the whole pile (grab bar or shared anchor). */
  carryingStack: boolean;
  /** Marker under the pointer that is not part of this drag. */
  target: DropTarget | null;
  /** Pointer still inside the pile this marker came from. */
  overOwnStack: boolean;
  /**
   * The row of its own pile the pointer is over, and the row it started on.
   *
   * A pile is a list you read, and moving a row within it is the one thing you
   * would expect to be able to do by dragging — the gesture is already in your
   * hand. Only meaningful while `overOwnStack`.
   */
  ownRow?: number | null;
  targetRow?: number | null;
  /** The raycast found somewhere to put it. */
  valid: boolean;
  /** Why not, when it did not. */
  reason?: string;
  /** Storey under the pointer; the caption of a plain placement. */
  levelName?: string | null;
}

export interface DropDecision {
  action: DropAction;
  /** Marker the release would stack with; null unless `action` is `join`. */
  target: string | null;
  /** Words for the chip under the cursor. */
  caption: string;
  /** Where the row would land; set only when `action` is `reorder`. */
  row?: number;
}

/**
 * The engine ships English and the card overrides it; see
 * `PlacementController.setStrings`. Nothing here may be written into the
 * config — these are captions on a cursor.
 */
export interface DropStrings {
  /** Onto a marker standing alone. */
  join: string;
  /** Onto a pile that already exists. */
  joinPile: string;
  detach: string;
  /** Moved to another row of the same pile; `{row}` counts from 1. */
  reorder: string;
  stay: string;
  label: string;
  invalid: string;
  /** No surface under the pointer and no plane to fall back on. */
  outside: string;
  /** The storey the drop landed on is not on screen. */
  hidden: string;
}

export const DEFAULT_DROP_STRINGS: DropStrings = {
  join: 'Stack with {name}',
  joinPile: 'Add to {name} + {count} more',
  detach: 'Take out of the stack',
  stay: 'Stays in the stack',
  reorder: 'Move to row {row}',
  label: 'Move the label',
  invalid: 'Cannot drop here',
  outside: 'Drop beside the house, not above the horizon',
  hidden: '{name} is hidden',
};

/** `{placeholder}` substitution; the same shape the card's localiser uses. */
export function fillTemplate(
  template: string,
  params: Record<string, string | number> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/**
 * The rules, in the order they settle it.
 *
 * Reading them as prose: a caption drag only ever moves a caption; a drop with
 * nowhere to land is refused; a marker under the pointer means the two become a
 * pile; a marker dragged clear of its own pile leaves it; a marker still over
 * its own pile is going nowhere; everything else lands where it was dropped.
 *
 * The one thing to hold on to is that *joining outranks leaving*. Dragging a
 * chip from one pile straight onto another is one gesture, not two, and it has
 * to mean the obvious thing.
 */
export function decideDrop(
  situation: DropSituation,
  strings: DropStrings = DEFAULT_DROP_STRINGS,
): DropDecision {
  // A caption drag that ends on another marker is the gesture everyone
  // reaches for: the chips are the parts you can see, so pulling two together
  // is how you say "these belong in one place". Anywhere else it is what it
  // looks like — moving a caption. Which of the two you are about to get is on
  // the cursor before you let go, so the one gesture is still unambiguous.
  if (situation.mode === 'label') {
    const onto = situation.target;
    // A marker standing alone has no pile, and `null !== null` is false — which
    // is how the commonest case of all, two loose chips dragged together,
    // quietly became "move the caption".
    if (onto && (onto.stack === null || onto.stack !== situation.ownStack)) {
      return joinDecision(onto, strings);
    }
    return { action: 'label', target: null, caption: strings.label };
  }

  if (!situation.valid) {
    return { action: 'invalid', target: null, caption: situation.reason ?? strings.invalid };
  }

  const target = situation.target;
  if (target && (target.stack === null || target.stack !== situation.ownStack)) {
    return joinDecision(target, strings);
  }

  // Carrying the whole pile is a placement of the pile, so none of the
  // leaving/staying rules apply — there is nothing left behind to leave.
  if (situation.ownStack && !situation.carryingStack) {
    if (!situation.overOwnStack) {
      return { action: 'detach', target: null, caption: strings.detach };
    }
    // Inside its own pile, the drag is about the list rather than the plan: the
    // rows are read in order and the bottom one carries the anchor, so which
    // row this marker is on is worth being able to say with the hand that is
    // already holding it.
    const from = situation.ownRow;
    const to = situation.targetRow;
    if (typeof from === 'number' && typeof to === 'number' && from !== to) {
      return {
        action: 'reorder',
        target: null,
        caption: fillTemplate(strings.reorder, { row: to + 1 }),
        row: to,
      };
    }
    return { action: 'stay', target: null, caption: strings.stay };
  }

  return { action: 'place', target: null, caption: situation.levelName ?? '' };
}

function joinDecision(target: DropTarget, strings: DropStrings): DropDecision {
  const caption =
    target.size > 1
      ? fillTemplate(strings.joinPile, { name: target.name, count: target.size - 1 })
      : fillTemplate(strings.join, { name: target.name });
  return { action: 'join', target: target.entityId, caption };
}

/** Whether a release with this decision writes anything at all. */
export function isCommittable(action: DropAction): boolean {
  return action !== 'invalid' && action !== 'stay';
}
