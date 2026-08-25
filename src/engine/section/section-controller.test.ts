import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { SectionController } from '@/engine/section/section-controller';
import { DEFAULT_SECTION_STATE } from '@/types/config';
import type { SectionState } from '@/types/config';

/** Whoever moved the cut, the card has to be able to see what it became. */
describe('telling the card what changed', () => {
  function record(): { controller: SectionController; seen: SectionState[] } {
    const controller = new SectionController();
    const seen: SectionState[] = [];
    controller.onChange((state) => seen.push(state));
    return { controller, seen };
  }

  it('reports the state an applied view left behind', () => {
    const { controller, seen } = record();
    controller.setState({ ...DEFAULT_SECTION_STATE, mode: 'level', levelId: 'upper' }, false);

    expect(seen).toHaveLength(1);
    expect(seen[0].mode).toBe('level');
    expect(seen[0].levelId).toBe('upper');
    expect(controller.getState().levelId).toBe('upper');
  });

  it('says nothing at all when nobody is listening', () => {
    const controller = new SectionController();
    expect(() =>
      controller.setState({ ...DEFAULT_SECTION_STATE, mode: 'none' }, false),
    ).not.toThrow();
  });
});

/** An 8 × 6 × 10 m house standing off the origin. */
function house(): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(-3, 0, -4), new THREE.Vector3(5, 6, 6));
}

describe('cuts', () => {
  it('opens with nothing cut', () => {
    expect(new SectionController().getState().cuts).toEqual({});
  });

  /**
   * The two used to be exclusive modes, so seeing into the rooms of one storey
   * meant choosing between isolating it and taking a wall off.
   */
  it('cuts a side away while a storey is isolated', () => {
    const controller = new SectionController();
    controller.setState(
      { ...DEFAULT_SECTION_STATE, mode: 'level', levelId: 'upper', cuts: { front: 1.5 } },
      false,
    );
    const state = controller.getState();
    expect(state.mode).toBe('level');
    expect(state.levelId).toBe('upper');
    expect(state.cuts).toEqual({ front: 1.5 });
  });

  it('writes only the sides that are cut', () => {
    const controller = new SectionController();
    controller.setState({ ...DEFAULT_SECTION_STATE, cuts: { top: 0.4, left: 0 } }, false);
    expect(controller.getState().cuts).toEqual({ top: 0.4 });
  });

  it('takes a depth back to zero', () => {
    const controller = new SectionController();
    controller.setState({ ...DEFAULT_SECTION_STATE, cuts: { top: 0.4 } }, false);
    controller.setCutDepth('top', 0);
    expect(controller.cutDepth('top')).toBe(0);
    expect(controller.getState().cuts).toEqual({});
  });

  it('reads a dragged handle as a depth from that face', () => {
    const controller = new SectionController();
    controller.setBounds(house());
    // The roof is at y = 6, so a handle pulled down to 4.5 has taken 1.5 m off.
    controller.setCutPosition('top', 4.5);
    expect(controller.cutDepth('top')).toBeCloseTo(1.5, 6);
  });

  it('keeps the storey it was told to isolate when a cut is added', () => {
    const controller = new SectionController();
    controller.isolateLevel('ground', false);
    controller.setCutDepth('back', 2);
    const state = controller.getState();
    expect(state.mode).toBe('level');
    expect(state.levelId).toBe('ground');
    expect(state.cuts).toEqual({ back: 2 });
  });
});

/**
 * Two cuts that pass through each other keep nothing between them: the near
 * wall is gone, the far wall is gone, and from outside there is no telling
 * which of the two sliders to pull back.
 */
describe('facing cuts never overlap', () => {
  it('stops a cut where the one facing it starts', () => {
    const controller = new SectionController();
    controller.setBounds(house()); // 8 m across x
    controller.setCutDepth('left', 5);
    controller.setCutDepth('right', 5);
    const cuts = controller.getState().cuts ?? {};
    expect((cuts.left ?? 0) + (cuts.right ?? 0)).toBeLessThan(8);
    expect(cuts.right).toBeGreaterThan(0);
  });

  it('leaves the far side alone while there is room', () => {
    const controller = new SectionController();
    controller.setBounds(house());
    controller.setCutDepth('front', 3);
    controller.setCutDepth('back', 4);
    expect(controller.cutDepth('front')).toBe(3);
    expect(controller.cutDepth('back')).toBe(4);
  });

  /** The roof has no floor cut to run into, only the model's own height. */
  it('lets the top cut go as deep as the house is tall', () => {
    const controller = new SectionController();
    controller.setBounds(house()); // 6 m tall
    controller.setCutDepth('top', 5.5);
    expect(controller.cutDepth('top')).toBeCloseTo(5.5, 6);
  });

  it('pulls back an overlapping pair that arrived from a config', () => {
    const controller = new SectionController();
    controller.setBounds(house());
    controller.setState({ ...DEFAULT_SECTION_STATE, cuts: { left: 3, right: 7 } }, false);
    const cuts = controller.getState().cuts ?? {};
    // The shallower one is the likelier to have been meant, so it stands.
    expect(cuts.left).toBe(3);
    expect((cuts.left ?? 0) + (cuts.right ?? 0)).toBeLessThan(8);
  });

  it('does not touch a pair that fits', () => {
    const controller = new SectionController();
    controller.setBounds(house());
    controller.setState({ ...DEFAULT_SECTION_STATE, cuts: { left: 2, right: 3 } }, false);
    expect(controller.getState().cuts).toEqual({ left: 2, right: 3 });
  });

  it('never lets a cut exceed the model even with nothing facing it', () => {
    const controller = new SectionController();
    controller.setBounds(house());
    controller.setState({ ...DEFAULT_SECTION_STATE, cuts: { top: 99 } }, false);
    expect(controller.cutDepth('top')).toBeLessThan(6);
    expect(controller.cutDepth('top')).toBeGreaterThan(5);
  });
});

/**
 * Pre-0.7 configs stated their cuts as world coordinates, which only mean
 * something once the model has said where it is. The schema carries them over
 * untouched; the conversion happens here, on the first real bounds.
 */
describe('pre-0.7 cut planes', () => {
  const legacy: SectionState = {
    ...DEFAULT_SECTION_STATE,
    planes: [{ axis: 'z', position: 3, enabled: true, invert: false }],
  };

  it('waits for the model before deciding what the old plane meant', () => {
    const controller = new SectionController(legacy);
    expect(controller.getState().cuts).toEqual({});
  });

  it('turns it into a depth once the bounds are known', () => {
    const controller = new SectionController(legacy);
    controller.setBounds(house());
    expect(controller.getState().cuts).toEqual({ back: 3 });
  });

  it('tells the card, so the old form can be written out in the new one', () => {
    const controller = new SectionController(legacy);
    const seen: SectionState[] = [];
    controller.onChange((state) => seen.push(state));
    controller.setBounds(house());
    expect(seen[seen.length - 1]?.cuts).toEqual({ back: 3 });
  });

  it('never overrules a cut the config states outright', () => {
    const controller = new SectionController({ ...legacy, cuts: { back: 1 } });
    controller.setBounds(house());
    expect(controller.getState().cuts).toEqual({ back: 1 });
  });

  it('converts once and then leaves the cut alone', () => {
    const controller = new SectionController(legacy);
    controller.setBounds(house());
    controller.setCutDepth('back', 0);
    controller.setBounds(house());
    expect(controller.getState().cuts).toEqual({});
  });

  /**
   * Nothing strips the old block from the config — a cut is no longer written
   * back, so the old form has to keep working on every load — and it therefore
   * arrives again with every state the panel commits. Read twice, it puts a cut
   * the user has just cleared straight back on the house.
   */
  it('does not put a cleared cut back when the old block arrives again', () => {
    const controller = new SectionController(legacy);
    controller.setBounds(house());
    expect(controller.getState().cuts).toEqual({ back: 3 });

    // What the panel commits after the user clears that side: the cut is gone,
    // but the deprecated block is still riding along.
    controller.setState({ ...legacy, cuts: {} }, false);
    expect(controller.getState().cuts).toEqual({});
  });

  it('does not revive it on a later state that says nothing about that side', () => {
    const controller = new SectionController(legacy);
    controller.setBounds(house());
    controller.setCutDepth('back', 0);
    controller.setState({ ...legacy, cuts: { top: 0.5 } }, false);
    expect(controller.getState().cuts).toEqual({ top: 0.5 });
  });
});
