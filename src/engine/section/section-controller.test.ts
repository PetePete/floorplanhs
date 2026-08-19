import { describe, expect, it } from 'vitest';

import { SectionController } from '@/engine/section/section-controller';
import type { SectionChangeOrigin } from '@/engine/contracts';
import { DEFAULT_SECTION_STATE } from '@/types/config';
import type { SectionState } from '@/types/config';

/**
 * Who moved the cut decides whether it is written down.
 *
 * A hand on a handle is an edit. The card putting a saved view back in place is
 * not — and persisting that meant every click on a storey rewrote the card's
 * stored `section:`, which is the state the card opens with. The card then
 * started on whichever storey was looked at last, for good.
 */
describe('section change origin', () => {
  function record(): {
    controller: SectionController;
    seen: Array<{ state: SectionState; origin: SectionChangeOrigin }>;
  } {
    const controller = new SectionController();
    const seen: Array<{ state: SectionState; origin: SectionChangeOrigin }> = [];
    controller.onChange((state, origin) => seen.push({ state, origin }));
    return { controller, seen };
  }

  it('reports an applied view as `apply`', () => {
    const { controller, seen } = record();
    controller.setState({ ...DEFAULT_SECTION_STATE, mode: 'level', levelId: 'ground' }, false);

    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe('apply');
    expect(seen[0].state.mode).toBe('level');
  });

  it('still tells listeners what the state became', () => {
    const { controller, seen } = record();
    controller.setState({ ...DEFAULT_SECTION_STATE, mode: 'level', levelId: 'upper' }, false);
    expect(seen[0].state.levelId).toBe('upper');
    expect(controller.getState().levelId).toBe('upper');
  });

  it('says nothing at all when nobody is listening', () => {
    const controller = new SectionController();
    expect(() =>
      controller.setState({ ...DEFAULT_SECTION_STATE, mode: 'none' }, false),
    ).not.toThrow();
  });
});
