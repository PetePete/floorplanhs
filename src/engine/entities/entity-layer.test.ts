import { describe, expect, it } from 'vitest';

import { EntityLayer, frameTop } from '@/engine/entities/entity-layer';
import type { EntityVisualState } from '@/engine/contracts';

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

/**
 * A state push can arrive before the entity list does.
 *
 * The viewer sets its subsystems up, then spends a second or two loading the
 * model, and Home Assistant does not wait — so `updateVisual` can be called for
 * an entity that has no marker yet. Dropped, it never came again: the viewer
 * had already recorded that state as delivered, so the lamp lit its room and
 * its chip sat there grey until somebody switched the lamp off and on.
 */
describe('a state that arrives before its marker', () => {
  const lit: EntityVisualState = {
    entityId: 'light.kitchen',
    state: 'on',
    active: true,
    label: 'Kitchen',
    icon: 'mdi:lightbulb',
    color: '#ffb300',
    unavailable: false,
  };

  function layerWithEarlyState(): EntityLayer {
    const layer = new EntityLayer();
    layer.updateVisual('light.kitchen', lit);
    layer.setEntities([{ entity: 'light.kitchen', position: [0, 2.4, 0] }]);
    return layer;
  }

  it('is waiting for the marker when it is built', () => {
    const layer = layerWithEarlyState();
    expect(layer.getVisual('light.kitchen')).toMatchObject({ state: 'on', active: true });
    layer.dispose();
  });

  it('colours the chip the lamp is actually wearing', () => {
    const layer = layerWithEarlyState();
    expect(layer.getVisual('light.kitchen')?.color).toBe('#ffb300');
    layer.dispose();
  });

  it('has nothing to say about an entity nobody has pushed', () => {
    const layer = new EntityLayer();
    layer.setEntities([{ entity: 'light.hall', position: [0, 2.4, 0] }]);
    expect(layer.getVisual('light.hall')).toBeNull();
    layer.dispose();
  });

  /** An entity taken off the plan must not leave its state behind. */
  it('forgets the state when the entity leaves the config', () => {
    const layer = layerWithEarlyState();
    layer.setEntities([]);
    layer.setEntities([{ entity: 'light.kitchen', position: [0, 2.4, 0] }]);
    expect(layer.getVisual('light.kitchen')).toBeNull();
    layer.dispose();
  });
});
