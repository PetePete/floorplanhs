import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LightingSystem } from '@/engine/lighting/lighting-system';
import { buildFromSh3d } from '@/engine/model/sh3d/sh3d-build';
import {
  TEST_HOME_SH3D,
  TEST_HOME_ROOM,
  TEST_HOME_ROOM_CENTRE,
} from '@/engine/model/sh3d/test-home';
import type { LightSample, RenderContext } from '@/engine/contracts';
import type { PlacedEntity } from '@/types/config';

/**
 * End-to-end for room fill: a Home Assistant state push in, a lit room out.
 *
 * The unit tests around `RoomFill` prove the room maths. They cannot catch the
 * failure that actually matters — a lamp state that never reaches the fill
 * because of how the lighting system is wired — so this drives the real
 * `LightingSystem` against a real imported home instead.
 */

/** Enough of a RenderContext for the lighting system; no WebGL involved. */
function stubContext(): RenderContext {
  const scene = new THREE.Scene();
  const modelRoot = new THREE.Group();
  scene.add(modelRoot);
  return {
    scene,
    camera: new THREE.PerspectiveCamera(),
    orthoCamera: new THREE.OrthographicCamera(),
    activeCamera: new THREE.PerspectiveCamera(),
    renderer: null as unknown as THREE.WebGLRenderer,
    canvas: null as unknown as HTMLCanvasElement,
    clock: new THREE.Clock(),
    modelRoot,
    overlayRoot: new THREE.Group(),
    size: { width: 800, height: 600, pixelRatio: 1 },
    invalidate: () => {},
    holdContinuous: () => () => {},
    clippingPlanes: [],
    quality: 'high',
  };
}

function home() {
  return buildFromSh3d(TEST_HOME_SH3D(), { textures: false });
}

function sample(on: boolean, brightness = 1): LightSample {
  return { on, brightness, color: [1, 1, 1], unavailable: false };
}

const LAMP_POSITION = TEST_HOME_ROOM_CENTRE;

function lamp(overrides: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entity: 'light.living', position: LAMP_POSITION, level: 'level0', ...overrides };
}

/** Total of the room-fill uniform: zero means nothing is lit. */
function fillTotal(system: LightingSystem): number {
  const fill = (system as unknown as { roomFill: { uniform: { value: Float32Array } } }).roomFill;
  return [...fill.uniform.value].reduce((a, b) => a + b, 0);
}

describe('room fill, end to end', () => {
  it('lights a room when the lamp in it turns on', () => {
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'room' });
    system.init(ctx);
    system.setModel(built.root, built.levels);

    expect(fillTotal(system), 'dark before any state arrives').toBe(0);

    system.syncLight(lamp(), sample(true));
    // The tween has to run: the fill follows the same ramp the lamp does.
    system.update(1, ctx);

    expect(fillTotal(system), 'lit after the lamp turns on').toBeGreaterThan(0);

    system.syncLight(lamp(), sample(false));
    system.update(1, ctx);
    expect(fillTotal(system), 'dark again after the lamp turns off').toBe(0);

    system.dispose();
  });

  it('still lights the room when the state arrives before the model does', () => {
    // The card pushes `hass` before mount resolves, so this is the normal order
    // on a dashboard, not an edge case.
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'room' });
    system.syncLight(lamp(), sample(true));
    system.init(ctx);
    system.setModel(built.root, built.levels);
    system.update(1, ctx);

    expect(fillTotal(system)).toBeGreaterThan(0);
    system.dispose();
  });

  it('suppresses the real light source in room mode', () => {
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'room' });
    system.init(ctx);
    system.setModel(built.root, built.levels);
    system.syncLight(lamp(), sample(true));
    system.update(1, ctx);

    let realLights = 0;
    ctx.scene.traverse((object) => {
      if ((object as THREE.Light).isLight && (object as THREE.Light).type !== 'AmbientLight') {
        realLights += 1;
      }
    });
    // The ambient rig owns whatever is left; the lamp must not add a point
    // light on top of the fill, or the hotspot is back.
    expect(realLights).toBeLessThanOrEqual(2);
    system.dispose();
  });

  it('creates a real light and no fill in realistic mode', () => {
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'realistic' });
    system.init(ctx);
    system.setModel(built.root, built.levels);
    system.syncLight(lamp(), sample(true));
    system.update(1, ctx);

    expect(fillTotal(system)).toBe(0);

    let pointLights = 0;
    ctx.scene.traverse((object) => {
      if ((object as THREE.PointLight).isPointLight) pointLights += 1;
    });
    expect(pointLights).toBe(1);
    system.dispose();
  });

  it('switches modes live without needing a reload', () => {
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'realistic' });
    system.init(ctx);
    system.setModel(built.root, built.levels);
    system.syncLight(lamp(), sample(true));
    system.update(1, ctx);
    expect(fillTotal(system)).toBe(0);

    system.setRenderConfig({ lightMode: 'room' });
    system.update(1, ctx);
    expect(fillTotal(system)).toBeGreaterThan(0);

    system.dispose();
  });

  it('honours an explicit room name over the position', () => {
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'room' });
    system.init(ctx);
    system.setModel(built.root, built.levels);
    // Outside every room, so only the name can resolve it.
    system.syncLight(
      lamp({ position: [50, 2, 50], room: TEST_HOME_ROOM }),
      sample(true),
    );
    system.update(1, ctx);

    expect(fillTotal(system)).toBeGreaterThan(0);
    system.dispose();
  });

  it('keeps the room lit when a section plane cuts the lamp away', () => {
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'room' });
    system.init(ctx);
    system.setModel(built.root, built.levels);
    system.syncLight(lamp(), sample(true));
    system.update(1, ctx);
    expect(fillTotal(system)).toBeGreaterThan(0);

    // The isolate-level cut lands below the ceiling so you can see into the
    // storey, which puts every ceiling lamp on the discarded side. Slicing the
    // building open is a way of looking at it, not a power cut.
    ctx.clippingPlanes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), 2));
    system.update(1, ctx);
    expect(fillTotal(system), 'still lit below the cut').toBeGreaterThan(0);

    system.dispose();
  });

  it('goes dark when the lamp is on a hidden storey', () => {
    const built = home();
    const ctx = stubContext();
    ctx.modelRoot.add(built.root);

    const system = new LightingSystem({ lightMode: 'room' });
    system.init(ctx);
    system.setModel(built.root, built.levels);
    system.syncLight(lamp(), sample(true));
    system.update(1, ctx);
    expect(fillTotal(system)).toBeGreaterThan(0);

    system.setVisibleLevels(['level1']);
    system.update(1, ctx);
    expect(fillTotal(system), 'a hidden storey must not light a visible one').toBe(0);

    system.dispose();
  });
});
