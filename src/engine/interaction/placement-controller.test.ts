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
    setLevelOffsets: () => {},
    levelOffset: () => 0,
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
  setHovered: () => {},
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

describe('placing while the storeys are pulled apart', () => {
  /** As if `upper` were lifted 3 m for the exploded view. */
  function exploded(): IModelManager {
    const built = house();
    // Move the geometry the way the exploded view does, and report the lift.
    built.floor.position.y += 3;
    built.wall.position.y += 3;
    built.floor.userData.level = 'upper';
    built.wall.userData.level = 'upper';
    built.root.updateMatrixWorld(true);

    const base = stubModel(built);
    return { ...base, levelOffset: (id) => (id === 'upper' ? 3 : 0) } as IModelManager;
  }

  it('writes back the real height, not the lifted one', () => {
    // The whole point of the transform: a marker dropped on a storey that is
    // drawn 3 m up belongs in the config at the height the building really has.
    // Getting this wrong corrupts the config the moment anyone drags anything.
    const placement = new PlacementController(exploded(), noopEntities, noopCamera);
    placement.init(stubContext());
    placement.beginPlacement('sensor.a');
    const result = placement.commitPlacement(...screen(0, 0));
    expect(result).not.toBeNull();
    expect(result!.position[1]).toBeCloseTo(0, 1);
    placement.dispose();
  });

  it('does the same for a drop beside the building', () => {
    const placement = new PlacementController(exploded(), noopEntities, noopCamera);
    placement.init(stubContext());
    placement.beginPlacement('sensor.a');
    const result = placement.commitPlacement(...screen(6, 0));
    expect(result).not.toBeNull();
    // A fresh placement with every storey visible lands on the bottom one, and
    // what matters here is that it lands at *its* height rather than 3 m up.
    expect(result!.levelId).toBe('ground');
    expect(result!.position[1]).toBeCloseTo(GROUND.elevation, 1);
    placement.dispose();
  });
});

describe('placing through a hidden-line drawing', () => {
  /** The house, with a storey's wall standing between the camera and the floor. */
  function withWallInTheWay() {
    const built = house();
    const above = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 4));
    above.position.set(0, 3, 0);
    above.userData = { level: 'upper', room: 'structure', part: 'walls' };
    built.root.add(above);
    built.root.updateMatrixWorld(true);

    const base = stubModel(built);
    const targets = [built.floor, built.wall, above];
    return {
      model: { ...base, getPickTargets: () => targets } as IModelManager,
      above,
    };
  }

  it('drops onto the floor, not onto whatever stands in front of it', () => {
    // In `wireframe` no surface is visible, so the nearest one is not what the
    // user is aiming at — it is whatever happens to stand between the camera and
    // the room. On the real house that was the outer wall of the storey above,
    // 1.1 m before the floor the drop was meant for, and the marker went there.
    const { model } = withWallInTheWay();
    const placement = new PlacementController(model, noopEntities, noopCamera);
    placement.init(stubContext());

    placement.beginPlacement('sensor.a');
    const result = placement.commitPlacement(...screen(0, 0));
    expect(result).not.toBeNull();
    expect(result!.position[1], 'the floor is at y = 0, the wall in the way at 3.1').toBeCloseTo(
      0,
      1,
    );
    expect(result!.levelId).toBe('ground');
    placement.dispose();
  });

  it('takes the nearest surface again once the surfaces are visible', () => {
    // `style: solid` paints them, so the nearest one *is* the one under the
    // pointer and picking anything else would be the surprise.
    const { model } = withWallInTheWay();
    const placement = new PlacementController(model, noopEntities, noopCamera);
    placement.init(stubContext());
    placement.setHiddenLine(false);

    placement.beginPlacement('sensor.a');
    const result = placement.commitPlacement(...screen(0, 0));
    expect(result).not.toBeNull();
    expect(result!.position[1]).toBeCloseTo(3.1, 1);
    placement.dispose();
  });
});

describe('which storey a drop belongs to', () => {
  it('is the one the surface says, not the one the height implies', () => {
    // A floor slab's top face sits exactly on the boundary between two storeys,
    // so reading the storey back out of the hit height let rounding decide it.
    // In an isolated view that was fatal: the drop was refused as "that storey
    // is hidden" because the surface under the pointer belonged, on paper, to
    // the storey below the one on screen.
    const built = house();
    built.floor.userData.level = 'upper';
    const base = stubModel(built);
    const model = {
      ...base,
      // Only the upper storey is on screen, and the height at the floor's top
      // face reads as the ground floor.
      getVisibleLevels: () => ['upper'],
    } as IModelManager;

    const placement = new PlacementController(model, noopEntities, noopCamera);
    placement.init(stubContext());
    placement.beginPlacement('light.a');
    const result = placement.commitPlacement(...screen(0, 0));
    expect(result, 'a drop onto the storey being shown must not be refused').not.toBeNull();
    expect(result!.levelId).toBe('upper');
    placement.dispose();
  });

  it('lands clear of the surface rather than snapped through it', () => {
    // The plan grid is 10 cm. Applying it to the height too put a lamp dropped
    // on a floor 2 cm *inside* the slab, where the room lookup reads the storey
    // below and the wrong room lights up.
    const placement = controller();
    placement.beginPlacement('light.a');
    const result = placement.commitPlacement(...screen(0.42, -0.37));
    expect(result).not.toBeNull();
    // The slab's top face is at y = 0; plan coordinates are still on the grid.
    expect(result!.position[1]).toBeGreaterThan(0);
    expect(result!.position[0]).toBeCloseTo(0.4, 6);
    expect(result!.position[2]).toBeCloseTo(-0.4, 6);
    placement.dispose();
  });
});

describe('dragging a marker out of its room', () => {
  it('records the room it came from, so the leader has somewhere to point', () => {
    // The gesture the leader line exists for: a sensor parked beside the plan
    // where you can reach it, still saying which room it measures. The room is
    // only recorded on the way *out* — dropped inside one, the position already
    // says which, and an override would go stale the moment the model changes.
    const built = house();
    const entities = {
      moveEntity: () => {},
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: () => null,
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(built), entities, noopCamera);
    placement.init(stubContext());
    placement.setRoomResolver((x, _y, z) =>
      Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 'living' : null,
    );

    placement.beginMove('sensor.a');
    const outside = placement.commitPlacement(...screen(6, 0));
    expect(outside, 'a drop beside the house is allowed').not.toBeNull();
    expect(outside!.room).toBe('living');

    // And back inside: no override, because the position speaks for itself.
    placement.beginMove('sensor.a');
    const inside = placement.commitPlacement(...screen(0, 0));
    expect(inside!.room).toBeNull();
    placement.dispose();
  });
});

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
      setHovered: () => {},
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

/**
 * A marker is two things at once — where the entity is, and where its caption
 * sits — and dragging one must not move the other.
 */
describe('dragging the label', () => {
  function labelLayer(): { layer: IEntityLayer; offsets: Vec3[]; moved: Vec3[] } {
    const offsets: Vec3[] = [];
    const moved: Vec3[] = [];
    const layer = {
      moveEntity: (_id: string, position: Vec3) => moved.push(position),
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: () => null,
      setLabelOffset: (_id: string, offset: Vec3) => offsets.push(offset),
      getLabelOffset: (): Vec3 => [0, 0.34, 0],
    } as unknown as IEntityLayer;
    return { layer, offsets, moved };
  }

  function labelController(): ReturnType<typeof labelLayer> & { placement: PlacementController } {
    const parts = labelLayer();
    const placement = new PlacementController(stubModel(house()), parts.layer, noopCamera);
    placement.init(stubContext());
    return { ...parts, placement };
  }

  it('offsets the label without moving the entity', () => {
    const { placement, offsets, moved } = labelController();
    placement.beginLabelMove('sensor.a');
    placement.updatePlacement(...screen(2, 1));

    expect(moved, 'the entity must not have been touched').toHaveLength(0);
    // One decimal: the screen helper works back from a 100 px viewport, so a
    // metre is worth about 23 px and the round trip costs a few millimetres.
    const last = offsets[offsets.length - 1];
    expect(last?.[0]).toBeCloseTo(2, 1);
    expect(last?.[2]).toBeCloseTo(1, 1);
    placement.dispose();
  });

  it('keeps the lift the label already had', () => {
    const { placement, offsets } = labelController();
    placement.beginLabelMove('sensor.a');
    placement.updatePlacement(...screen(1, 0));
    expect(offsets[offsets.length - 1][1]).toBeCloseTo(0.34, 3);
    placement.dispose();
  });

  it('announces the drop as a label commit, not a placement', () => {
    const { placement } = labelController();
    const labels: Array<{ entityId: string; offset: Vec3 }> = [];
    const placements: string[] = [];
    placement.on('label-commit', (payload) => labels.push(payload));
    placement.on('placement-commit', ({ entityId }) => placements.push(entityId));

    placement.beginLabelMove('sensor.a');
    expect(placement.commitPlacement(...screen(2, 0))).toBeNull();

    expect(placements, 'a caption is not a placement').toHaveLength(0);
    expect(labels).toHaveLength(1);
    expect(labels[0].offset[0]).toBeCloseTo(2, 1);
    placement.dispose();
  });

  it('puts the label back where it was when the drag is cancelled', () => {
    const { placement, offsets } = labelController();
    placement.beginLabelMove('sensor.a');
    placement.updatePlacement(...screen(3, 3));
    placement.cancelPlacement();
    expect(offsets[offsets.length - 1]).toEqual([0, 0.34, 0]);
    placement.dispose();
  });

  it('falls back to moving the entity when there is no anchor to offset from', () => {
    const layer = {
      moveEntity: () => {},
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: () => null,
      getPlacedEntity: () => null,
    } as unknown as IEntityLayer;
    const placement = new PlacementController(stubModel(house()), layer, noopCamera);
    placement.init(stubContext());

    placement.beginLabelMove('sensor.a');
    expect(placement.commitPlacement(...screen(0, 0)), 'a plain move still lands').not.toBeNull();
    placement.dispose();
  });
});

/**
 * The free-placement latch belongs to one gesture.
 *
 * It exists so that dragging a marker out of a window does not keep snapping
 * back onto the wall it is passing. Held across gestures it does something
 * else entirely: one drag that strays off the building, and every placement
 * after it ignores every surface and lands on a plane at the lowest storey.
 * Measured on a real house, that was 594 of 600 screen points.
 */
describe('starting a fresh placement', () => {
  it('forgets that the last gesture wandered off the house', () => {
    const built = house();
    // `nodeName` is the tell: it is only set when a real surface was hit.
    built.floor.name = 'ground/living/floor';
    const placement = new PlacementController(stubModel(built), noopEntities, noopCamera);
    placement.init(stubContext());

    // A drag that leaves the building latches free placement...
    placement.beginPlacement('sensor.a');
    placement.updatePlacement(...screen(40, 40));
    placement.commitPlacement(...screen(40, 40));

    // ...and the next one must still see the floor under the pointer.
    placement.beginPlacement('light.b');
    const result = placement.commitPlacement(...screen(0, 0));
    expect(result?.nodeName, 'a surface, not the fallback plane').toBeTruthy();
    placement.dispose();
  });

  it('does the same for a move', () => {
    const built = house();
    built.floor.name = 'ground/living/floor';
    const entities = {
      moveEntity: () => {},
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: () => null,
    } as unknown as IEntityLayer;
    const placement = new PlacementController(stubModel(built), entities, noopCamera);
    placement.init(stubContext());

    placement.beginPlacement('sensor.a');
    placement.commitPlacement(...screen(40, 40));

    placement.beginMove('sensor.a');
    expect(placement.commitPlacement(...screen(0, 0))?.nodeName).toBeTruthy();
    placement.dispose();
  });
});

/**
 * A stack moves as one thing. Waiting for the drop means dragging a frame away
 * from its own contents and hoping they catch up.
 */
describe('carrying a stack', () => {
  function pile(): {
    placement: PlacementController;
    moves: Array<[string, Vec3]>;
  } {
    const moves: Array<[string, Vec3]> = [];
    const members = [
      { entity: 'light.a', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
      { entity: 'switch.b', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
      { entity: 'sensor.c', position: [3, 0.02, 3] as Vec3, level: 'ground' },
    ];
    const entities = {
      moveEntity: (entityId: string, position: Vec3) => moves.push([entityId, position]),
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: (id: string) => members.find((m) => m.entity === id) ?? null,
      getPlacedEntities: () => members,
      pick: () => null,
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(house()), entities, noopCamera);
    placement.init(stubContext());
    return { placement, moves };
  }

  it('moves every member while the drag is still going', () => {
    const { placement, moves } = pile();
    placement.beginMove('light.a');
    placement.updatePlacement(...screen(1, 1));

    expect(moves.map(([id]) => id)).toContain('light.a');
    expect(moves.map(([id]) => id), 'the other row follows too').toContain('switch.b');
    expect(moves.map(([id]) => id), 'a marker outside the pile stays put').not.toContain('sensor.c');
    placement.dispose();
  });

  it('puts the whole pile back when the drag is cancelled', () => {
    const { placement, moves } = pile();
    placement.beginMove('light.a');
    placement.updatePlacement(...screen(1.5, 1.5));
    moves.length = 0;
    placement.cancelPlacement();

    const restored = new Map(moves);
    expect(restored.get('switch.b')).toEqual([0, 0.02, 0]);
    placement.dispose();
  });

  it('leaves a lone marker to move alone', () => {
    const { placement, moves } = pile();
    placement.beginMove('sensor.c');
    placement.updatePlacement(...screen(1, 1));
    expect(new Set(moves.map(([id]) => id))).toEqual(new Set(['sensor.c']));
    placement.dispose();
  });
});

/**
 * Dragging one chip onto another is the gesture people reach for — the chips
 * are the parts you can see. The controller has to ask the rules what the
 * pointer is over; when it assumed the answer instead, stacking by dragging
 * labels together stopped working and every test still passed.
 */
describe('a caption dropped on another marker', () => {
  function withTarget(targetId: string | null): {
    placement: PlacementController;
    labels: Array<{ entityId: string; offset: Vec3; stackWith?: string }>;
  } {
    const labels: Array<{ entityId: string; offset: Vec3; stackWith?: string }> = [];
    const members = [
      { entity: 'sensor.a', position: [0, 0.02, 0] as Vec3, level: 'ground' },
      { entity: 'light.b', position: [2, 0.02, 2] as Vec3, level: 'ground', name: 'Kitchen' },
    ];
    const entities = {
      moveEntity: () => {},
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: (id: string) => members.find((m) => m.entity === id) ?? null,
      getPlacedEntities: () => members,
      setLabelOffset: () => {},
      getLabelOffset: (): Vec3 => [0, 0.34, 0],
      pick: () => targetId,
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(house()), entities, noopCamera);
    placement.init(stubContext());
    placement.on('label-commit', (payload) => labels.push(payload));
    return { placement, labels };
  }

  it('says so on the way, and joins on release', () => {
    const { placement, labels } = withTarget('light.b');
    placement.beginLabelMove('sensor.a');
    placement.updatePlacement(...screen(2, 2));

    const caption = (placement as unknown as { decision: { action: string; caption: string } })
      .decision;
    expect(caption.action, 'the cursor promises a join').toBe('join');
    expect(caption.caption).toContain('Kitchen');

    placement.commitPlacement(...screen(2, 2));
    expect(labels).toHaveLength(1);
    expect(labels[0].stackWith).toBe('light.b');
    placement.dispose();
  });

  it('moves the caption alone when there is nothing under it', () => {
    const { placement, labels } = withTarget(null);
    placement.beginLabelMove('sensor.a');
    placement.updatePlacement(...screen(2, 2));
    placement.commitPlacement(...screen(2, 2));

    expect(labels).toHaveLength(1);
    expect(labels[0].stackWith).toBeUndefined();
    expect(labels[0].offset[0]).toBeCloseTo(2, 1);
    placement.dispose();
  });
});

/**
 * Taking one marker off a pile.
 *
 * This is the gesture the rules were written for, and for a while nothing could
 * reach it: the router threw the grabbed part away and every drag carried the
 * whole pile, so `detach` and `stay` were unreachable branches that the tests
 * for `drop-intent` were happily exercising on their own.
 */
describe('pulling a row off a pile', () => {
  function pile(over: boolean): {
    placement: PlacementController;
    moves: Array<[string, Vec3]>;
    intents: string[];
  } {
    const moves: Array<[string, Vec3]> = [];
    const intents: string[] = [];
    const members = [
      { entity: 'light.a', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
      { entity: 'switch.b', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
    ];
    const entities = {
      moveEntity: (entityId: string, position: Vec3) => moves.push([entityId, position]),
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: (id: string) => members.find((m) => m.entity === id) ?? null,
      getPlacedEntities: () => members,
      pick: () => null,
      overStack: () => over,
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(house()), entities, noopCamera);
    placement.init(stubContext());
    placement.on('placement-commit', ({ intent }) => intents.push(intent.action));
    return { placement, moves, intents };
  }

  function decision(placement: PlacementController): { action: string } {
    return (placement as unknown as { decision: { action: string } }).decision;
  }

  it('leaves the rest of the pile where it is', () => {
    const { placement, moves } = pile(false);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(1.5, 1.5));
    expect(new Set(moves.map(([id]) => id))).toEqual(new Set(['light.a']));
    placement.dispose();
  });

  it('promises to take it out, and commits that', () => {
    const { placement, intents } = pile(false);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(1.5, 1.5));
    expect(decision(placement).action).toBe('detach');

    placement.commitPlacement(...screen(1.5, 1.5));
    expect(intents, 'what the cursor said is what was written').toEqual(['detach']);
    placement.dispose();
  });

  /** Inside its own frame the pile has not been touched, so nothing moves. */
  it('holds still while the pointer is still on the pile', () => {
    const { placement, moves, intents } = pile(true);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(0.2, 0.2));
    expect(decision(placement).action).toBe('stay');
    expect(
      moves.map(([, position]) => position),
      'the anchor stays where the pile put it',
    ).toEqual([[0, 0.02, 0]]);

    placement.commitPlacement(...screen(0.2, 0.2));
    expect(intents, 'a release here writes nothing').toEqual([]);
    placement.dispose();
  });
});

/**
 * Moving a row within its own pile.
 *
 * The hand is already on the row — it is the same grab that pulls one out — so
 * the list has to be reorderable with it. What tells the two apart is where the
 * drag ends: inside the frame it is about the list, outside it is about the
 * plan.
 */
describe('dragging a row up its own pile', () => {
  function pile(row: () => number | null): {
    placement: PlacementController;
    moves: Array<[string, Vec3]>;
    preview: Array<[string | null, number | undefined]>;
    commits: Array<{ action: string; row?: number }>;
  } {
    const moves: Array<[string, Vec3]> = [];
    const preview: Array<[string | null, number | undefined]> = [];
    const commits: Array<{ action: string; row?: number }> = [];
    const members = [
      { entity: 'light.a', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
      { entity: 'switch.b', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
      { entity: 'sensor.c', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
    ];
    const entities = {
      moveEntity: (entityId: string, position: Vec3) => moves.push([entityId, position]),
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: (id: string) => members.find((m) => m.entity === id) ?? null,
      getPlacedEntities: () => members,
      getStackMembers: () => members.map((m) => m.entity),
      pick: () => null,
      overStack: () => true,
      rowUnder: () => row(),
      setRowPreview: (entityId: string | null, index?: number) => preview.push([entityId, index]),
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(house()), entities, noopCamera);
    placement.init(stubContext());
    placement.on('placement-commit', ({ intent }) =>
      commits.push({ action: intent.action, row: intent.row }),
    );
    return { placement, moves, preview, commits };
  }

  function decision(placement: PlacementController): { action: string; row?: number } {
    return (placement as unknown as { decision: { action: string; row?: number } }).decision;
  }

  it('reads the drag as a move up the list', () => {
    const { placement } = pile(() => 2);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(0.1, 0.1));
    expect(decision(placement).action).toBe('reorder');
    expect(decision(placement).row).toBe(2);
    placement.dispose();
  });

  it('shows the list in the new order while the row is still in hand', () => {
    const { placement, preview } = pile(() => 2);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(0.1, 0.1));
    expect(preview[preview.length - 1]).toEqual(['light.a', 2]);
    placement.dispose();
  });

  it('does not move the marker in the house', () => {
    const { placement, moves } = pile(() => 2);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(0.1, 0.1));
    expect(
      moves.map(([, position]) => position),
      'the anchor stays where the pile put it',
    ).toEqual([[0, 0.02, 0]]);
    placement.dispose();
  });

  it('commits the row it promised', () => {
    const { placement, commits } = pile(() => 2);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(0.1, 0.1));
    placement.commitPlacement(...screen(0.1, 0.1));
    expect(commits).toEqual([{ action: 'reorder', row: 2 }]);
    placement.dispose();
  });

  /**
   * The row it started on is read once. Asking the layer mid-drag asks about
   * the *preview*, and the answer chases itself: moved to row 2, therefore
   * already on row 2, therefore nothing to move.
   */
  it('does not lose the move to its own preview', () => {
    const { placement } = pile(() => 2);
    placement.beginMove('light.a', { carryStack: false });
    for (let i = 0; i < 5; i += 1) placement.updatePlacement(...screen(0.1, 0.1));
    expect(decision(placement).action).toBe('reorder');
    placement.dispose();
  });

  it('takes the row back off the pile when the drag ends', () => {
    const { placement, preview } = pile(() => 2);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(0.1, 0.1));
    placement.cancelPlacement();
    expect(preview[preview.length - 1]).toEqual([null, undefined]);
    placement.dispose();
  });

  it('changes nothing on the row it started on', () => {
    const { placement, commits } = pile(() => 0);
    placement.beginMove('light.a', { carryStack: false });
    placement.updatePlacement(...screen(0.1, 0.1));
    expect(decision(placement).action).toBe('stay');
    placement.commitPlacement(...screen(0.1, 0.1));
    expect(commits).toEqual([]);
    placement.dispose();
  });
});

/**
 * The frame is the pile's drop area.
 *
 * The box is drawn around the whole list to say it is one thing, so the air
 * between two rows belongs to it as much as the rows do. Requiring a chip meant
 * dropping an entity "into" a stack had to hit a target a few pixels tall, and
 * missing it made a second marker at the same spot instead.
 */
describe('dropping onto a pile rather than onto a chip', () => {
  function world(inFrame: boolean): {
    placement: PlacementController;
    decision: () => { action: string; target: string | null };
  } {
    const members = [
      { entity: 'light.a', position: [2, 0.02, 2] as Vec3, level: 'ground', stack: 's', name: 'Lamp' },
      { entity: 'switch.b', position: [2, 0.02, 2] as Vec3, level: 'ground', stack: 's' },
    ];
    const entities = {
      moveEntity: () => {},
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: (id: string) => members.find((m) => m.entity === id) ?? null,
      getPlacedEntities: () => members,
      getStackMembers: () => members.map((m) => m.entity),
      // Every chip missed: the pointer is in the air between two rows.
      pick: () => null,
      stackUnder: () => (inFrame ? { stackId: 's', base: 'light.a' } : null),
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(house()), entities, noopCamera);
    placement.init(stubContext());
    return {
      placement,
      decision: () =>
        (placement as unknown as { decision: { action: string; target: string | null } }).decision,
    };
  }

  it('joins the pile the pointer is inside', () => {
    const { placement, decision } = world(true);
    placement.beginPlacement('sensor.new');
    placement.updatePlacement(...screen(1, 1));
    expect(decision().action).toBe('join');
    expect(decision().target).toBe('light.a');
    placement.dispose();
  });

  it('says which pile, and how much is in it', () => {
    const { placement } = world(true);
    placement.beginPlacement('sensor.new');
    placement.updatePlacement(...screen(1, 1));
    const caption = (placement as unknown as { decision: { caption: string } }).decision.caption;
    expect(caption).toContain('Lamp');
    expect(caption).toContain('1 more');
    placement.dispose();
  });

  it('is an ordinary placement everywhere else', () => {
    const { placement, decision } = world(false);
    placement.beginPlacement('sensor.new');
    placement.updatePlacement(...screen(1, 1));
    expect(decision().action).toBe('place');
    placement.dispose();
  });
});

/**
 * What the release will do, shown while the pointer is still down.
 *
 * Pulling a row out of a pile puts the entity back on its own spot and leaves
 * the label where you let go. Dragging the whole marker around and only then
 * putting it home is the same drop with a jump at the end of it, and a jump at
 * the end is how a gesture stops being trusted.
 */
describe('pulling a row out, as it happens', () => {
  function pile(): {
    placement: PlacementController;
    moves: Array<[string, Vec3]>;
    offsets: Array<[string, Vec3]>;
  } {
    const moves: Array<[string, Vec3]> = [];
    const offsets: Array<[string, Vec3]> = [];
    const members = [
      { entity: 'light.a', position: [0, 0.02, 0] as Vec3, level: 'ground', stack: 's' },
      {
        entity: 'sensor.b',
        position: [0, 0.02, 0] as Vec3,
        level: 'ground',
        stack: 's',
        // It stood two metres east and one north before it joined.
        stackFrom: [2, 0, -1] as Vec3,
      },
    ];
    const entities = {
      moveEntity: (entityId: string, position: Vec3) => moves.push([entityId, position]),
      setEntities: () => {},
      setHovered: () => {},
      getEntityPosition: (): Vec3 => [0, 0.02, 0],
      getPlacedEntity: (id: string) => members.find((m) => m.entity === id) ?? null,
      getPlacedEntities: () => members,
      getStackMembers: () => members.map((m) => m.entity),
      getLabelOffset: (): Vec3 => [0, 0.34, 0],
      setLabelOffset: (entityId: string, offset: Vec3) => offsets.push([entityId, offset]),
      pick: () => null,
      overStack: () => false,
      rowUnder: () => null,
    } as unknown as IEntityLayer;

    const placement = new PlacementController(stubModel(house()), entities, noopCamera);
    placement.init(stubContext());
    return { placement, moves, offsets };
  }

  it('puts the entity back on its own spot straight away', () => {
    const { placement, moves } = pile();
    placement.beginMove('sensor.b', { carryStack: false });
    placement.updatePlacement(...screen(1.5, 1.5));
    expect(moves[moves.length - 1]).toEqual(['sensor.b', [2, 0.02, -1]]);
    placement.dispose();
  });

  it('hangs the label off it, where the pointer is', () => {
    const { placement, offsets } = pile();
    placement.beginMove('sensor.b', { carryStack: false });
    placement.updatePlacement(...screen(1.5, 1.5));

    const [entityId, offset] = offsets[offsets.length - 1];
    expect(entityId).toBe('sensor.b');
    // Anchor at x=2, pointer at x=1.5: the label hangs half a metre west of it.
    expect(offset[0]).toBeCloseTo(-0.5, 1);
    expect(offset[1], 'and keeps the lift it had').toBeCloseTo(0.34, 5);
    placement.dispose();
  });

  it('puts the label back where it was if the drag is cancelled', () => {
    const { placement, offsets } = pile();
    placement.beginMove('sensor.b', { carryStack: false });
    placement.updatePlacement(...screen(1.5, 1.5));
    placement.cancelPlacement();
    expect(offsets[offsets.length - 1]).toEqual(['sensor.b', [0, 0.34, 0]]);
    placement.dispose();
  });
});
