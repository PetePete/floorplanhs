import { describe, expect, it } from 'vitest';

import { frameTop } from '@/engine/entities/entity-layer';

/**
 * The top edge of a pile's screen box.
 *
 * Two hit tests ask for it — "is the pointer still on this pile" and "which
 * pile is the pointer inside" — and they have to give the same answer, or a
 * pointer can be inside the pile for one and outside for the other. That reads
 * as a drag that promises "take it out" and then quietly puts it back.
 *
 * The rest of the box is measured on screen and cannot be checked in a headless
 * test, where there is no canvas to rasterise a chip into and every rectangle
 * would be a number I made up. This part is arithmetic, so it can be.
 */
describe('the top of a pile', () => {
  const box = { y: 300, halfHeight: 40, headerY: 249, headerHalfHeight: 11 };

  it('is the top of the grab bar while there is one', () => {
    expect(frameTop({ ...box, grabBar: true })).toBe(238);
  });

  it('is the top of the frame when the bar is not drawn', () => {
    expect(frameTop({ ...box, grabBar: false })).toBe(260);
  });

  /**
   * The bar sits above the box, so dropping it can only ever bring the edge
   * down. An edge that moved the other way would mean a pile that is easier to
   * hit when its handle is gone.
   */
  it('never reaches higher without the bar than with it', () => {
    expect(frameTop({ ...box, grabBar: false })).toBeGreaterThan(
      frameTop({ ...box, grabBar: true }),
    );
  });
});
