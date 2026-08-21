import { describe, expect, it, vi } from 'vitest';

import { PointerRouter } from '@/engine/interaction/pointer-router';
import type {
  ICameraController,
  IEntityLayer,
  IPlacementController,
  RenderContext,
  ViewerEvents,
} from '@/engine/contracts';
import { Emitter } from '@/util/events';

/**
 * One gesture after another.
 *
 * Every gesture leaves the router holding something — a claimant, a suspended
 * camera, a captured pointer, a pending timer — and the next gesture is only
 * recognised if all of it was handed back. That is invisible to a test that
 * drives one gesture at a time, so this drives them in sequence.
 */

/** Just enough DOM for the router: listeners, a rect, and pointer capture. */
class FakeElement {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  parentElement: FakeElement | null = null;
  captured: number | null = null;

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = (this.listeners.get(type) ?? []).filter((entry) => entry !== fn);
    this.listeners.set(type, list);
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 400, height: 400 };
  }

  setPointerCapture(id: number): void {
    this.captured = id;
  }

  hasPointerCapture(id: number): boolean {
    return this.captured === id;
  }

  /** The browser fires this as a task, so the router sees it after the up. */
  releasePointerCapture(id: number): void {
    if (this.captured !== id) return;
    this.captured = null;
    queueMicrotask(() => this.fire('lostpointercapture', { pointerId: id }));
  }

  fire(type: string, event: Record<string, unknown>): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

interface Harness {
  router: PointerRouter;
  host: FakeElement;
  canvas: FakeElement;
  /** Which entity the layer reports under the pointer; null for empty canvas. */
  under: { id: string | null };
  enabled: { value: boolean };
  activations: string[];
  placementCalls: string[];
  time: { now: number };
}

function harness(editMode = true): Harness {
  const under: { id: string | null } = { id: null };
  const enabled = { value: true };
  const activations: string[] = [];
  const placementCalls: string[] = [];
  const time = { now: 0 };
  let placementActive = false;

  const entities = {
    setHovered: () => {},
    setSelected: () => {},
    pick: () => under.id,
    pickPart: () =>
      under.id ? { entityId: under.id, part: 'anchor' as const, stackId: null } : null,
  } as unknown as IEntityLayer;

  const placement = {
    isActive: () => placementActive,
    beginMove: () => {
      placementActive = true;
      placementCalls.push('beginMove');
    },
    beginLabelMove: () => {
      placementActive = true;
      placementCalls.push('beginLabelMove');
    },
    updatePlacement: () => {
      placementCalls.push('update');
      return null;
    },
    commitPlacement: () => {
      placementActive = false;
      placementCalls.push('commit');
      return null;
    },
    cancelPlacement: () => {
      placementActive = false;
      placementCalls.push('cancel');
    },
  } as unknown as IPlacementController;

  const camera = {
    controls: {
      get enabled() {
        return enabled.value;
      },
    },
    setEnabled: (value: boolean) => {
      enabled.value = value;
    },
  } as unknown as ICameraController;

  const emitter = new Emitter<ViewerEvents>();
  emitter.on('entity-activate', ({ entityId, action }) => activations.push(`${action}:${entityId}`));

  const router = new PointerRouter(entities, placement, camera, emitter);
  const canvas = new FakeElement();
  const host = new FakeElement();
  canvas.parentElement = host;

  router.init({
    canvas: canvas as unknown as HTMLCanvasElement,
    size: { width: 400, height: 400, pixelRatio: 1 },
    invalidate: () => {},
  } as unknown as RenderContext);
  router.setEditMode(editMode);

  return { router, host, canvas, under, enabled, activations, placementCalls, time };
}

/**
 * One event, down the real path: the router listens on the node above the
 * canvas in the capture phase, so it sees the event first and can stop it
 * before the canvas — where the camera controller listens — ever does.
 */
function pointer(h: Harness, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  let stopped = false;
  const event = {
    type,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    buttons: type === 'pointerup' ? 0 : 1,
    timeStamp: h.time.now,
    cancelable: true,
    preventDefault: () => {},
    stopPropagation: () => {
      stopped = true;
    },
    ...extra,
  };
  h.host.fire(type, event);
  if (!stopped) h.canvas.fire(type, event);
}

/** Down and straight back up on the same spot. */
function tap(h: Harness, x: number, y: number): void {
  pointer(h, 'pointerdown', x, y);
  h.time.now += 60;
  pointer(h, 'pointerup', x, y);
}

/** Down, past the drag threshold, and up. */
function drag(h: Harness, from: [number, number], to: [number, number]): void {
  pointer(h, 'pointerdown', ...from);
  h.time.now += 20;
  pointer(h, 'pointermove', ...to);
  h.time.now += 20;
  pointer(h, 'pointerup', ...to);
}

describe('one gesture after another', () => {
  it('recognises a drag on the canvas after a marker was tapped', async () => {
    const h = harness();

    h.under.id = 'light.a';
    tap(h, 100, 100);
    expect(h.activations, 'the tap itself lands').toEqual(['tap:light.a']);
    await vi.waitFor(() => expect(h.host.captured).toBeNull());

    // The canvas is the camera's; the router must not still be holding on.
    h.under.id = null;
    drag(h, [200, 200], [260, 240]);
    expect(h.router.isGestureActive(), 'the gesture was closed out').toBe(false);
    expect(h.router.isClaimed(), 'nothing is still claiming the pointer').toBe(false);
    expect(h.enabled.value, 'the camera can orbit again').toBe(true);
  });

  it('picks a marker up on a drag that follows a tap', async () => {
    const h = harness();

    h.under.id = 'light.a';
    tap(h, 100, 100);
    await vi.waitFor(() => expect(h.host.captured).toBeNull());

    drag(h, [100, 100], [160, 140]);
    expect(h.placementCalls).toContain('beginMove');
    expect(h.placementCalls, 'and the drop is committed').toContain('commit');
    expect(h.router.isClaimed()).toBe(false);
  });

  it('leaves the camera enabled after a tap that activates nothing', () => {
    const h = harness();
    h.under.id = null;
    tap(h, 100, 100);
    expect(h.enabled.value).toBe(true);
    expect(h.router.isClaimed()).toBe(false);
  });

  it('hands the camera back after a marker drag', async () => {
    const h = harness();
    h.under.id = 'light.a';
    drag(h, [100, 100], [180, 150]);
    await vi.waitFor(() => expect(h.host.captured).toBeNull());
    expect(h.enabled.value, 'orbiting works again once the marker is dropped').toBe(true);
  });

  /** Two taps in a row: the second must be recognised as one. */
  it('recognises a second tap', () => {
    const h = harness();
    h.under.id = 'light.a';
    tap(h, 100, 100);
    h.time.now += 800;
    tap(h, 100, 100);
    expect(h.activations).toEqual(['tap:light.a', 'tap:light.a']);
  });
});


/**
 * The camera controller is a second listener on the same pointers, and it has a
 * gesture of its own to close.
 *
 * OrbitControls binds `pointermove` and `pointerup` on the canvas when a press
 * starts, and only its own `pointerup` puts it back to rest. The router listens
 * one node up in the capture phase, so a release it swallowed never arrived —
 * OrbitControls stayed in `STATE.ROTATE` with a live move listener, and as soon
 * as the camera was enabled again the house spun with every mouse move, no
 * button pressed. Tapping a marker was enough, because a tap is claimed on the
 * way up.
 */
describe('the camera controller and its own gesture', () => {
  /** The part of OrbitControls that matters here, and nothing else. */
  function orbit(h: Harness): { rotating: () => boolean } {
    let rotating = false;
    const onUp = (): void => {
      rotating = false;
      h.canvas.removeEventListener('pointerup', onUp);
    };
    h.canvas.addEventListener('pointerdown', () => {
      rotating = true;
      h.canvas.addEventListener('pointerup', onUp);
    });
    return { rotating: () => rotating };
  }

  it('is left at rest by a tap on a marker', () => {
    const h = harness();
    const controls = orbit(h);

    h.under.id = 'light.a';
    pointer(h, 'pointerdown', 100, 100);
    expect(controls.rotating(), 'a press starts one').toBe(true);
    h.time.now += 60;
    pointer(h, 'pointerup', 100, 100);

    expect(h.activations, 'the tap still lands').toEqual(['tap:light.a']);
    expect(controls.rotating(), 'and the camera is not left mid-rotate').toBe(false);
  });

  it('is left at rest by a marker drag', () => {
    const h = harness();
    const controls = orbit(h);

    h.under.id = 'light.a';
    pointer(h, 'pointerdown', 100, 100);
    h.time.now += 20;
    pointer(h, 'pointermove', 170, 150);
    h.time.now += 20;
    pointer(h, 'pointerup', 170, 150);

    expect(h.placementCalls).toContain('commit');
    expect(controls.rotating()).toBe(false);
  });

  it('still swallows the moves of a gesture we claimed', () => {
    const h = harness();
    const seen: string[] = [];
    h.canvas.addEventListener('pointermove', () => seen.push('move'));

    h.under.id = 'light.a';
    pointer(h, 'pointerdown', 100, 100);
    pointer(h, 'pointermove', 170, 150);
    pointer(h, 'pointermove', 180, 160);
    expect(seen, 'the camera must not orbit under a drag').toEqual([]);
  });

  /** The capture has to sit where the other listener put its own. */
  it('takes the pointer on the canvas, not on the node above it', () => {
    const h = harness();
    h.under.id = 'light.a';
    pointer(h, 'pointerdown', 100, 100);
    h.time.now += 20;
    pointer(h, 'pointermove', 170, 150);
    expect(h.canvas.captured, 'the canvas holds it').toBe(1);
    expect(h.host.captured, 'the node above does not').toBeNull();
  });
});
