import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildFromSh3d } from '@/engine/model/sh3d/sh3d-build';
import {
  TEST_HOME_TWO_ROOMS_SH3D,
  TWO_ROOMS,
  TWO_ROOM_CENTRES,
} from '@/engine/model/sh3d/test-home';
import { MAX_ROOMS, RoomFill, type RoomFillLight } from '@/engine/lighting/room-fill';

/**
 * The point of room fill is that a lit room stops at its walls. Everything here
 * tests that boundary, because a fill that leaks into the neighbouring room is
 * indistinguishable from a plain point light — the thing this mode exists to
 * replace.
 */

const house = buildFromSh3d(TEST_HOME_TWO_ROOMS_SH3D(), { textures: false });

function fresh(): RoomFill {
  const fill = new RoomFill();
  // A model is only indexed once; each test gets its own so stamping and the
  // material patch start from a clean state.
  fill.setModel(house.root, house.levels);
  return fill;
}

/** Centre of a named room's floor mesh, lifted to about lamp height. */
function lampIn(room: string): THREE.Vector3 {
  const mesh = [...house.nodes.values()].find(
    (node) => node.userData.room === room && node.userData.part === 'floor',
  ) as THREE.Mesh | undefined;
  expect(mesh, `a floor mesh for room "${room}"`).toBeDefined();
  const box = new THREE.Box3().setFromObject(mesh!);
  const centre = box.getCenter(new THREE.Vector3());
  centre.y = box.max.y + 2;
  return centre;
}

function light(position: THREE.Vector3, color = new THREE.Color(1, 1, 1)): RoomFillLight {
  return { room: null, level: null, position, color, weight: 1 };
}

describe('room index', () => {
  it('finds the rooms the model declares', () => {
    const fill = fresh();
    expect(fill.roomCount).toBeGreaterThan(1);
    expect(fill.roomCount).toBeLessThanOrEqual(MAX_ROOMS);
    fill.dispose();
  });

  it('places a point inside a room in that room and nowhere else', () => {
    const fill = fresh();
    const rooms = [...house.nodes.values()]
      .filter((n) => n.userData.part === 'floor' && typeof n.userData.room === 'string')
      .map((n) => n.userData.room as string);
    expect(rooms.length).toBeGreaterThan(1);

    for (const room of new Set(rooms)) {
      expect(fill.roomAt(lampIn(room)), `lamp in ${room}`).toBe(room);
    }
    fill.dispose();
  });

  it('keeps the two rooms apart across the partition', () => {
    const fill = fresh();
    expect(fill.roomAt(new THREE.Vector3(...TWO_ROOM_CENTRES.west))).toBe(TWO_ROOMS.west);
    expect(fill.roomAt(new THREE.Vector3(...TWO_ROOM_CENTRES.east))).toBe(TWO_ROOMS.east);
    // Inside the partition itself, which belongs to neither.
    expect(fill.roomAt(new THREE.Vector3(0, 2.2, 0))).toBeNull();
    fill.dispose();
  });

  it('names the room a point falls in, for drag-and-drop', () => {
    // Dropping a marker outside a room records the one it came from, which is
    // what makes the leader line appear; that needs a name, not a slot index.
    const fill = fresh();
    expect(fill.roomNameAt(...TWO_ROOM_CENTRES.west)).toBe(TWO_ROOMS.west);
    expect(fill.roomNameAt(...TWO_ROOM_CENTRES.east)).toBe(TWO_ROOMS.east);
    expect(fill.roomNameAt(40, 2.2, 40), 'outside the building').toBeNull();
    fill.dispose();
  });

  it('puts a point outside the building in no room at all', () => {
    const fill = fresh();
    expect(fill.roomAt(new THREE.Vector3(500, 1.5, 500))).toBeNull();
    fill.dispose();
  });

  it('stamps a room index onto the geometry', () => {
    const fill = fresh();
    let stamped = 0;
    let nonZero = 0;
    house.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const attribute = mesh.geometry.getAttribute('fpRoom');
      if (!attribute) return;
      stamped += 1;
      for (let i = 0; i < attribute.count; i += 1) {
        if (attribute.getX(i) > 0) {
          nonZero += 1;
          break;
        }
      }
    });
    expect(stamped).toBeGreaterThan(0);
    expect(nonZero).toBeGreaterThan(0);
    fill.dispose();
  });

  it('removes the attribute again on dispose, so a reload re-stamps cleanly', () => {
    const fill = fresh();
    fill.dispose();
    let remaining = 0;
    house.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry.getAttribute('fpRoom')) remaining += 1;
    });
    expect(remaining).toBe(0);
  });
});

describe('fill levels', () => {
  it('lights nothing while the mode is off', () => {
    const fill = fresh();
    const rooms = roomNames();
    fill.apply([light(lampIn(rooms[0]))]);
    expect(uniformOf(fill)).toBe(0);
    fill.dispose();
  });

  it('lights the room a lamp stands in, and only that one', () => {
    const fill = fresh();
    fill.setEnabled(true);
    fill.apply([light(new THREE.Vector3(...TWO_ROOM_CENTRES.west))]);

    const values = uniformArray(fill);
    // Exactly one room's r, g, b — the neighbour across the partition stays 0.
    expect(values.filter((v) => v > 0).length).toBe(3);

    const west = [...values];
    fill.apply([light(new THREE.Vector3(...TWO_ROOM_CENTRES.east))]);
    const east = uniformArray(fill);
    expect(east.filter((v) => v > 0).length).toBe(3);
    // Different slots, or the two rooms are not actually distinguished.
    expect(east.findIndex((v) => v > 0)).not.toBe(west.findIndex((v) => v > 0));
    fill.dispose();
  });

  it('does not make a second lamp in the same room twice as bright', () => {
    const fill = fresh();
    fill.setEnabled(true);
    const room = roomNames()[0];
    const one = lampIn(room);

    fill.apply([light(one)]);
    const single = uniformArray(fill).reduce((a, b) => a + b, 0);

    const other = one.clone();
    other.x += 0.2;
    fill.apply([light(one), light(other)]);
    const pair = uniformArray(fill).reduce((a, b) => a + b, 0);

    expect(pair).toBeCloseTo(single, 5);
    fill.dispose();
  });

  it('mixes the colours of two lamps rather than picking one', () => {
    const fill = fresh();
    fill.setEnabled(true);
    const room = roomNames()[0];
    const a = lampIn(room);
    const b = a.clone();
    b.x += 0.2;

    fill.apply([
      { ...light(a), color: new THREE.Color(1, 0, 0) },
      { ...light(b), color: new THREE.Color(0, 0, 1) },
    ]);

    const values = uniformArray(fill);
    const slot = values.findIndex((v) => v > 0);
    // Red and blue at equal weight give an even split, with no green.
    expect(values[slot]).toBeCloseTo(values[slot + 2], 5);
    expect(values[slot + 1]).toBe(0);
    fill.dispose();
  });

  it('scales with strength', () => {
    const fill = fresh();
    fill.setEnabled(true);
    const at = lampIn(roomNames()[0]);

    fill.apply([light(at)]);
    const base = uniformOf(fill);
    fill.setStrength(0.5);
    fill.apply([light(at)]);
    expect(uniformOf(fill)).toBeCloseTo(base * 0.5, 5);
    fill.dispose();
  });

  it('ignores a lamp that is off', () => {
    const fill = fresh();
    fill.setEnabled(true);
    fill.apply([{ ...light(lampIn(roomNames()[0])), weight: 0 }]);
    expect(uniformOf(fill)).toBe(0);
    fill.dispose();
  });

  it('honours an explicit room override over the position', () => {
    const fill = fresh();
    fill.setEnabled(true);
    const rooms = roomNames();

    fill.apply([light(lampIn(rooms[0]))]);
    const byPosition = [...uniformArray(fill)];

    // Same lamp, but told it belongs to a different room.
    fill.apply([{ ...light(lampIn(rooms[0])), room: rooms[1] }]);
    const byName = [...uniformArray(fill)];

    expect(byName).not.toEqual(byPosition);
    expect(byName.filter((v) => v > 0).length).toBe(3);
    fill.dispose();
  });
});

/**
 * The overlay is the whole feature: without it a lit room tints nothing at all,
 * and in the default hidden-line style there is no other surface it could tint.
 */
describe('fill overlay', () => {
  function overlay(fill: RoomFill): THREE.Mesh | null {
    return (fill as unknown as { wash: THREE.Mesh | null }).wash;
  }

  it('builds one mesh covering the rooms', () => {
    const fill = fresh();
    const mesh = overlay(fill);
    expect(mesh, 'the overlay mesh').not.toBeNull();
    expect(mesh!.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(mesh!.geometry.getAttribute('fpRoom')).toBeDefined();
    fill.dispose();
  });

  it('stays flat on the floor, so the tint cannot stack', () => {
    const fill = fresh();
    const mesh = overlay(fill)!;
    const position = mesh.geometry.getAttribute('position');

    // Everything sits near floor level. Walls and ceilings in here would mean
    // three or four translucent layers over the same pixel, which is exactly
    // the muddy result this shape avoids.
    let above = 0;
    for (let i = 0; i < position.count; i += 1) {
      if (position.getY(i) > 0.5) above += 1;
    }
    expect(above, 'overlay vertices above 0.5 m').toBe(0);
    fill.dispose();
  });

  it('resolves a wall face to the room it looks at', () => {
    const fill = fresh();
    // The two rooms are split by a 10 cm partition at x = 0, so its two faces
    // sit at x = -0.05 and x = +0.05. Each has to answer with its own side, or
    // a shared wall lights on the wrong one.
    const west = fill.slotAt(-0.05, 1.2, 0);
    const east = fill.slotAt(0.05, 1.2, 0);
    expect(west).toBeGreaterThanOrEqual(0);
    expect(east).toBeGreaterThanOrEqual(0);
    expect(west).not.toBe(east);

    // The building's outer face belongs to no room at all.
    expect(fill.slotAt(-3, 1.2, 0)).toBe(-1);
    fill.dispose();
  });

  it('reads the same uniform the fill is written into', () => {
    const fill = fresh();
    const material = overlay(fill)!.material as THREE.ShaderMaterial;
    const own = (fill as unknown as { uniform: { value: Float32Array } }).uniform;
    expect(material.uniforms.fpRoomFill).toBe(own);
    fill.dispose();
  });

  it('never occludes, never picks, and grows no edges', () => {
    const fill = fresh();
    const mesh = overlay(fill)!;
    const material = mesh.material as THREE.ShaderMaterial;
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    // fp3dInternal keeps it out of the ghost clone and the edge overlay;
    // noPick keeps a dropped entity from landing on it.
    expect(mesh.userData.fp3dInternal).toBe(true);
    expect(mesh.userData.noPick).toBe(true);
    fill.dispose();
  });

  it('is cut by the section, like everything else in the model', () => {
    const fill = fresh();
    const material = overlay(fill)!.material as THREE.ShaderMaterial;

    // three.js splices the clipping chunks into its own materials but leaves a
    // ShaderMaterial alone, so these have to be in the source by hand. Miss
    // them and the overlay is the one thing a cross-section does not cut —
    // silently, with a lit room bleeding through the cut face.
    expect(material.clipping, 'clipping enabled').toBe(true);
    expect(material.vertexShader).toContain('#include <clipping_planes_pars_vertex>');
    expect(material.vertexShader).toContain('#include <clipping_planes_vertex>');
    expect(material.fragmentShader).toContain('#include <clipping_planes_pars_fragment>');
    expect(material.fragmentShader).toContain('#include <clipping_planes_fragment>');
    // The chunk reads this exact name out of the surrounding scope.
    expect(material.vertexShader).toContain('vec4 mvPosition =');
    fill.dispose();
  });

  it('names chunks three.js actually ships', () => {
    for (const chunk of [
      'clipping_planes_pars_vertex',
      'clipping_planes_vertex',
      'clipping_planes_pars_fragment',
      'clipping_planes_fragment',
    ]) {
      expect(THREE.ShaderChunk[chunk as keyof typeof THREE.ShaderChunk], chunk).toBeTruthy();
    }
  });

  it('deepens the tint on a light ground, where a near-white lamp would vanish', () => {
    const fill = fresh();
    const material = overlay(fill)!.material as THREE.ShaderMaterial;

    const onDark = {
      opacity: material.uniforms.fpWashOpacity.value as number,
      tint: material.uniforms.fpWashTint.value as number,
    };
    fill.setGroundDark(false);
    const onLight = {
      opacity: material.uniforms.fpWashOpacity.value as number,
      tint: material.uniforms.fpWashTint.value as number,
    };

    // Heavier, and taken below white — otherwise it is almost exactly the
    // colour of the paper it is lying on.
    expect(onLight.opacity).toBeGreaterThan(onDark.opacity);
    expect(onLight.tint).toBeLessThan(onDark.tint);
    // The edges read the same figure, so a lit line deepens with it.
    expect(fill.litScale).toBe(onLight.tint);
    fill.dispose();
  });

  it('takes the overlay away again on dispose', () => {
    const fill = fresh();
    const mesh = overlay(fill)!;
    fill.dispose();
    expect(mesh.parent).toBeNull();
  });
});

describe('two rooms stacked on top of each other', () => {
  /** One room per storey, same footprint, floors at 0 and 2.62 m. */
  function stacked(): RoomFill {
    const root = new THREE.Group();
    const slab = (level: string, room: string, top: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 0.12, 4));
      mesh.position.set(0, top - 0.06, 0);
      mesh.userData = { level, room, part: 'floor' };
      return mesh;
    };
    root.add(slab('lower', 'cellar', 0), slab('upper', 'bedroom', 2.62));
    root.updateMatrixWorld(true);

    const fill = new RoomFill();
    fill.setModel(root, [
      { id: 'lower', name: 'Cellar', elevation: 0, height: 2.62 },
      { id: 'upper', name: 'Bedroom', elevation: 2.62, height: 2.5 },
    ]);
    return fill;
  }

  it('puts a lamp just above a floor in that floor’s room', () => {
    // Each room's height range runs a hand's width past its storey, so a lamp
    // two centimetres above an upstairs floor is inside the cellar's range too.
    // Taking the first match meant the cellar won — measured on a real house,
    // 14 of 17 placed lamps lit the storey below the one they were dropped on.
    const fill = stacked();
    expect(fill.roomAt(new THREE.Vector3(0, 2.64, 0))).toBe('bedroom');
    expect(fill.roomAt(new THREE.Vector3(0, 0.02, 0))).toBe('cellar');
    fill.dispose();
  });

  it('lets an explicit storey settle it outright', () => {
    const fill = stacked();
    expect(fill.roomNameAt(0, 2.64, 0, 'upper')).toBe('bedroom');
    // Same point, the other storey asked for: still answered, from its own room.
    expect(fill.roomNameAt(0, 2.64, 0, 'lower')).toBe('cellar');
    fill.dispose();
  });

  it('lights the room a placed lamp is actually in', () => {
    const fill = stacked();
    fill.setEnabled(true);
    fill.apply([
      {
        room: null,
        level: 'upper',
        position: new THREE.Vector3(0, 2.64, 0),
        color: new THREE.Color(1, 1, 1),
        weight: 1,
      },
    ]);
    const values = uniformArray(fill);
    const cellar = values.slice(0, 3).reduce((a, b) => a + b, 0);
    const bedroom = values.slice(3, 6).reduce((a, b) => a + b, 0);
    expect(bedroom, 'the room the lamp is in').toBeGreaterThan(0);
    expect(cellar, 'the room below it').toBe(0);
    fill.dispose();
  });
});

/* ------------------------------------------------------------------ helpers */

function roomNames(): string[] {
  const names = new Set<string>();
  house.root.traverse((object) => {
    if (object.userData.part === 'floor' && typeof object.userData.room === 'string') {
      names.add(object.userData.room);
    }
  });
  return [...names];
}

/** The private uniform is the only observable output; read it deliberately. */
function uniformArray(fill: RoomFill): number[] {
  const uniform = (fill as unknown as { uniform: { value: Float32Array } }).uniform;
  return [...uniform.value];
}

function uniformOf(fill: RoomFill): number {
  return uniformArray(fill).reduce((a, b) => a + b, 0);
}
