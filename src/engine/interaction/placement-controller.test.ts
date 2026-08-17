import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlacementController } from '@/engine/interaction/placement-controller';
import type {
  ICameraController,
  IEntityLayer,
  IModelManager,
  LoadedModel,
  RenderContext,
} from '@/engine/contracts';
import type { LevelDefinition, Vec3 } from '@/types/config';

/**
 * Placement outside the building.
 *
 * The building has no ground around it — no lawn, by design — so beside it a
 * ray hits nothing at all. Requiring a hit meant a marker could not be dragged
 * clear of the plan however far you pulled it, and dragging one *along* the
 * outside of a wall kept catching that wall on the way down.
 */

const GROUND: LevelDefinition = { id: 'ground', name: 'Ground', elevation: 0, height: 2.5 };
const UPPER: LevelDefinition = { id: 'upper', name: 'Upper', elevation: 2.5, height: 2.5 };

/** One 4 x 4 m floor slab at the origin, and a wall standing on its north edge. */
function house(): { root: THREE.Group; floor: THREE.Mesh; wall: THREE.Mesh } {
  const root = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 4));
  floor.position.set(0, -0.05, 0);
  floor.userData = { level: 'ground', room: 'living', part: 'floor' };

  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 0.2));
  wall.position.set(0, 1.25, -2);
  wall.userData = { level: 'ground', room: 'structure', part: 'walls' };

  root.add(floor, wall);
  root.updateMatrixWorld(true);
  return { root, floor, wall };
}

function stubModel(built: ReturnType<typeof house>, levels = [GROUND, UPPER]): IModelManager {
  const bounds = new THREE.Box3().setFromObject(built.root);
  const loaded = { root: built.root, bounds, levels } as unknown as LoadedModel;
  return {
    init: () => {},
    dispose: () => {},
    get model() {
      return loaded;
    },
    load: async () => loaded,
    getPickTargets: () => [built.floor, built.wall],
    setVisibleLevels: () => {},
    getVisibleLevels: () => null,
    levelAt: (position: Vec3 | THREE.Vector3) => {
      const y = Array.isArray(position) ? position[1] : position.y;
      return y >= UPPER.elevation ? UPPER : GROUND;
    },
  } as unknown as IModelManager;
}

/** A camera looking straight down, so screen x/y map to world x/z directly. */
function stubContext(): RenderContext {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(0, 40, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  return {
    scene: new THREE.Scene(),
    camera,
    orthoCamera: new THREE.OrthographicCamera(),
    activeCamera: camera,
    renderer: null as unknown as THREE.WebGLRenderer,
    canvas: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    } as unknown as HTMLCanvasElement,
    clock: new THREE.Clock(),
    modelRoot: new THREE.Group(),
    overlayRoot: new THREE.Group(),
    size: { width: 100, height: 100, pixelRatio: 1 },
    invalidate: () => {},
    holdContinuous: () => () => {},
    clippingPlanes: [],
    quality: 'high',
  };
}

const noopEntities = {
  moveEntity: () => {},
  setEntities: () => {},
  getEntityPosition: (): Vec3 | null => null,
} as unknown as IEntityLayer;

/** The controller disables orbiting for the duration of a drag. */
const noopCamera = {
  controls: { enabled: true },
  setEnabled: () => {},
} as unknown as ICameraController;

function controller(built = house()): PlacementController {
  const placement = new PlacementController(stubModel(built), noopEntities, noopCamera);
  placement.init(stubContext());
  return placement;
}

/** Screen point for a world XZ, under the straight-down camera above. */
function screen(x: number, z: number): [number, number] {
  const halfExtent = 40 * Math.tan(THREE.MathUtils.degToRad(30));
  return [50 + (x / halfExtent) * 50, 50 + (z / halfExtent) * 50];
}

describe('placing outside the building', () => {
  it('drops onto the floor when there is one under the pointer', () => {
    const placement = controller();
    placement.beginPlacement('sensor.a');
    const result = placement.commitPlacement(...screen(0, 0));
    expect(result).not.toBeNull();
    expect(result!.position[0]).toBeCloseTo(0, 1);
    expect(result!.position[2]).toBeCloseTo(0, 1);
    // The slab's top face is at y = 0; the small lift clear of it is inside the
    // placement grid, so what matters is that it stayed at floor level.
    expect(result!.position[1]).toBeCloseTo(0, 1);
    placement.dispose();
  });

  it('drops beside the house where nothing is under the pointer', () => {
    const placement = controller();
    placement.beginPlacement('sensor.a');
    const result = placement.commitPlacement(...screen(6, 0));
    expect(result, 'a drop clear of the building must be accepted').not.toBeNull();
    expect(result!.position[0]).toBeCloseTo(6, 0);
    expect(result!.position[1]).toBeCloseTo(0, 1);
    placement.dispose();
  });

  it('stops snapping to the wall once the drag has left the building', () => {
    const placement = controller();
    placement.beginPlacement('sensor.a');

    // Out past the north wall first: that is the gesture the latch watches for.
    placement.updatePlacement(...screen(0, -6));
    // Now back over the wall itself. Without the latch this lands on top of the
    // wall at y = 2.5, which is what makes dragging along a facade fight back
    // every few pixels.
    const onWall = placement.updatePlacement(...screen(0, -2));
    expect(onWall).not.toBeNull();
    expect(onWall!.position[1]).toBeCloseTo(0, 1);

    placement.dispose();
  });

  it('snaps to the wall on the way out, before the building has been left', () => {
    // The latch must not fire early: a marker dropped straight onto a facade is
    // still a wall mounting, and that is the common case.
    const placement = controller();
    placement.beginPlacement('sensor.a');
    const onWall = placement.updatePlacement(...screen(0, -2));
    expect(onWall).not.toBeNull();
    expect(onWall!.position[1]).toBeGreaterThan(1);
    placement.dispose();
  });

  it('lets a floor take the drag back, so a marker can be brought inside again', () => {
    const placement = controller();
    placement.beginPlacement('sensor.a');
    placement.updatePlacement(...screen(0, -6));
    // A floor is the one surface that unambiguously means "inside a room";
    // walls and roofs are what you cross on the way out.
    const back = placement.updatePlacement(...screen(0, 0));
    expect(back).not.toBeNull();
    expect(back!.position[1]).toBeCloseTo(0, 1);

    // ...and the wall bites again afterwards, because the latch was cleared.
    const onWall = placement.updatePlacement(...screen(0, -2));
    expect(onWall!.position[1]).toBeGreaterThan(1);
    placement.dispose();
  });

  it('keeps a free-placed marker on the storey it started on', () => {
    // Dragging an upper-floor sensor out of a window must not quietly move it
    // downstairs just because the ground is what the ray would have found.
    const upstairs = {
      moveEntity: () => {},
      setEntities: () => {},
      getEntityPosition: (): Vec3 => [0, 3.2, 0],
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(house()), upstairs, noopCamera);
    placement.init(stubContext());
    placement.beginMove('sensor.a');
    const result = placement.commitPlacement(...screen(6, 0));
    expect(result).not.toBeNull();
    expect(result!.levelId).toBe('upper');
    expect(result!.position[1]).toBeCloseTo(UPPER.elevation, 1);
    placement.dispose();
  });
});
