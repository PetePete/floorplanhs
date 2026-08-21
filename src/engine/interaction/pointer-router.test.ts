import { describe, expect, it } from 'vitest';

import { PointerRouter } from '@/engine/interaction/pointer-router';
import type {
  ICameraController,
  IEntityLayer,
  IPlacementController,
  ViewerEvents,
} from '@/engine/contracts';
import { Emitter } from '@/util/events';

/**
 * What a drag means is decided by what the pointer went down on, and this is
 * the piece that carries that answer across.
 *
 * It is worth a test of its own because it failed silently: the router's local
 * type for `pickPart` claimed the layer only ever answers "anchor" or "label",
 * so a grab on a pile's bar was quietly read as an anchor grab and every drag
 * carried the whole pile. `detach` and `stay` became branches nothing could
 * reach, while their own unit tests went on passing.
 */

function router(): {
  router: PointerRouter;
  calls: Array<[string, string, boolean | undefined]>;
} {
  const calls: Array<[string, string, boolean | undefined]> = [];
  const placement = {
    beginMove: (entityId: string, options?: { carryStack?: boolean }) =>
      calls.push(['move', entityId, options?.carryStack]),
    beginLabelMove: (entityId: string) => calls.push(['label', entityId, undefined]),
    isActive: () => false,
  } as unknown as IPlacementController;

  const entities = { setHovered: () => {} } as unknown as IEntityLayer;
  const camera = { controls: { enabled: true }, setEnabled: () => {} } as unknown as ICameraController;

  return {
    router: new PointerRouter(entities, placement, camera, new Emitter<ViewerEvents>()),
    calls,
  };
}

/** The two fields `onDown` fills in, and the call it later makes with them. */
function grab(part: 'anchor' | 'label' | 'stack', stackId: string | null): Array<
  [string, string, boolean | undefined]
> {
  const { router: r, calls } = router();
  const inner = r as unknown as {
    grabbedPart: string | null;
    grabbedStack: string | null;
    pickUp(entityId: string): void;
  };
  inner.grabbedPart = part;
  inner.grabbedStack = stackId;
  inner.pickUp('light.a');
  return calls;
}

describe('what the grab decides', () => {
  it('moves the entity from its anchor', () => {
    expect(grab('anchor', null)).toEqual([['move', 'light.a', undefined]]);
  });

  it('moves the caption of a marker standing on its own', () => {
    expect(grab('label', null)).toEqual([['label', 'light.a', undefined]]);
  });

  /**
   * On a pile a row has no offset of its own — the pile lays it out — so
   * dragging one can only mean "take this one out".
   */
  it('takes a single row off a pile', () => {
    expect(grab('label', 'stack_1')).toEqual([['move', 'light.a', false]]);
  });

  it('takes the whole pile by its bar', () => {
    expect(grab('stack', 'stack_1')).toEqual([['move', 'light.a', undefined]]);
  });

  it('takes the whole pile by the shared anchor too', () => {
    expect(grab('anchor', 'stack_1')).toEqual([['move', 'light.a', undefined]]);
  });
});
