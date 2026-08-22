import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DROP_STRINGS,
  decideDrop,
  fillTemplate,
  isCommittable,
  type DropSituation,
  type DropTarget,
} from '@/engine/interaction/drop-intent';

/**
 * The table of what a release means, read as the table it is.
 *
 * This is the part of drag & drop that has to be decided *before* letting go,
 * because the cursor says it out loud — so every row here is also a promise
 * shown on screen. That is why the rules live away from the raycasting.
 */

function situation(patch: Partial<DropSituation> = {}): DropSituation {
  return {
    mode: 'move',
    ownStack: null,
    carryingStack: false,
    target: null,
    overOwnStack: false,
    valid: true,
    ...patch,
  };
}

function target(patch: Partial<DropTarget> = {}): DropTarget {
  return { entityId: 'light.kitchen', name: 'Kitchen', stack: null, size: 1, ...patch };
}

describe('placing', () => {
  it('lands where it was dropped when nothing is under the pointer', () => {
    expect(decideDrop(situation({ levelName: 'Ground floor' })).action).toBe('place');
  });

  it('names the storey it would land on', () => {
    expect(decideDrop(situation({ levelName: 'Ground floor' })).caption).toBe('Ground floor');
  });

  it('refuses a drop with nowhere to land, and says why', () => {
    const decision = decideDrop(situation({ valid: false, reason: 'Upper floor is hidden' }));
    expect(decision.action).toBe('invalid');
    expect(decision.caption).toBe('Upper floor is hidden');
  });

  it('falls back to its own words when the raycast gave no reason', () => {
    expect(decideDrop(situation({ valid: false })).caption).toBe(DEFAULT_DROP_STRINGS.invalid);
  });
});

describe('joining', () => {
  it('stacks with a marker standing alone', () => {
    const decision = decideDrop(situation({ target: target() }));
    expect(decision.action).toBe('join');
    expect(decision.target).toBe('light.kitchen');
    expect(decision.caption).toBe('Stack with Kitchen');
  });

  it('counts the pile it is joining', () => {
    const decision = decideDrop(situation({ target: target({ stack: 's', size: 3 }) }));
    expect(decision.caption).toBe('Add to Kitchen + 2 more');
  });

  /** One gesture, not two: a chip dragged from one pile onto another joins. */
  it('outranks leaving the pile it came from', () => {
    const decision = decideDrop(
      situation({ ownStack: 'a', target: target({ stack: 'b', size: 2 }) }),
    );
    expect(decision.action).toBe('join');
  });

  it('ignores a target that is already in the same pile', () => {
    const decision = decideDrop(
      situation({ ownStack: 's', overOwnStack: true, target: target({ stack: 's', size: 2 }) }),
    );
    expect(decision.action).toBe('stay');
  });
});

describe('leaving', () => {
  it('takes a marker out when it is dragged clear of its pile', () => {
    const decision = decideDrop(situation({ ownStack: 's', overOwnStack: false }));
    expect(decision.action).toBe('detach');
    expect(decision.caption).toBe(DEFAULT_DROP_STRINGS.detach);
  });

  it('changes nothing while it is still over its own pile', () => {
    const decision = decideDrop(situation({ ownStack: 's', overOwnStack: true }));
    expect(decision.action).toBe('stay');
    expect(isCommittable(decision.action), 'a release here writes nothing').toBe(false);
  });

  /** Carrying the whole pile leaves nobody behind, so there is nothing to leave. */
  it('is a plain placement when the whole pile is in hand', () => {
    const decision = decideDrop(
      situation({ ownStack: 's', carryingStack: true, overOwnStack: false }),
    );
    expect(decision.action).toBe('place');
  });
});

describe('a caption', () => {
  it('moves on its own when it lands on open ground', () => {
    const decision = decideDrop(situation({ mode: 'label' }));
    expect(decision.action).toBe('label');
    expect(decision.caption).toBe(DEFAULT_DROP_STRINGS.label);
  });

  /**
   * The chips are the parts you can see, so dragging two together is how
   * anyone says "these belong in one place".
   */
  it('joins when it is dropped on another marker', () => {
    const decision = decideDrop(situation({ mode: 'label', target: target() }));
    expect(decision.action).toBe('join');
    expect(decision.target).toBe('light.kitchen');
  });

  it('does not join its own pile', () => {
    const decision = decideDrop(
      situation({ mode: 'label', ownStack: 's', target: target({ stack: 's', size: 2 }) }),
    );
    expect(decision.action).toBe('label');
  });
});

describe('what gets written', () => {
  it('writes for everything except a refusal and a marker put back', () => {
    expect(isCommittable('place')).toBe(true);
    expect(isCommittable('join')).toBe(true);
    expect(isCommittable('detach')).toBe(true);
    expect(isCommittable('label')).toBe(true);
    expect(isCommittable('stay')).toBe(false);
    expect(isCommittable('invalid')).toBe(false);
  });
});

describe('captions', () => {
  it('fills the placeholders it is given', () => {
    expect(fillTemplate('Stack with {name}', { name: 'Lamp' })).toBe('Stack with Lamp');
    expect(fillTemplate('{name} + {count}', { name: 'Pile', count: 2 })).toBe('Pile + 2');
  });

  it('leaves a placeholder it has no value for, rather than printing "undefined"', () => {
    expect(fillTemplate('Stack with {name}')).toBe('Stack with {name}');
  });

  it('takes the words the card gives it', () => {
    const decision = decideDrop(situation({ target: target() }), {
      ...DEFAULT_DROP_STRINGS,
      join: 'Stapeln mit {name}',
    });
    expect(decision.caption).toBe('Stapeln mit Kitchen');
  });
});

/**
 * A pile is a list you read, and the hand that can pull a row out of it is
 * already on the row — so moving it *within* the list has to be the same
 * gesture, told apart by where it ends.
 */
describe('reordering inside a pile', () => {
  const onPile = (patch: Partial<DropSituation> = {}): DropSituation =>
    situation({ ownStack: 's', overOwnStack: true, ownRow: 0, targetRow: 0, ...patch });

  it('moves the row when the pointer is over a different one', () => {
    const decision = decideDrop(onPile({ targetRow: 2 }));
    expect(decision.action).toBe('reorder');
    expect(decision.row).toBe(2);
  });

  it('counts the rows from one when it says so', () => {
    expect(decideDrop(onPile({ targetRow: 2 })).caption).toBe('Move to row 3');
  });

  it('changes nothing on the row it started on', () => {
    expect(decideDrop(onPile({ targetRow: 0 })).action).toBe('stay');
  });

  it('writes something on a release, unlike staying put', () => {
    expect(isCommittable('reorder')).toBe(true);
    expect(isCommittable('stay')).toBe(false);
  });

  /** Off the pile is still off the pile; the rows only matter inside it. */
  it('leaves the pile when the pointer does', () => {
    expect(decideDrop(onPile({ overOwnStack: false, targetRow: 2 })).action).toBe('detach');
  });

  it('does not reorder when the whole pile is in the hand', () => {
    expect(decideDrop(onPile({ carryingStack: true, targetRow: 2 })).action).toBe('place');
  });

  /** Without a row from the layer there is nothing to say, so say nothing. */
  it('falls back to staying put when the rows are unknown', () => {
    expect(decideDrop(onPile({ ownRow: null, targetRow: null })).action).toBe('stay');
  });

  it('a marker under the pointer still outranks the list', () => {
    const decision = decideDrop(
      onPile({ targetRow: 2, target: target({ entityId: 'light.other', stack: 'b', size: 2 }) }),
    );
    expect(decision.action).toBe('join');
  });
});
