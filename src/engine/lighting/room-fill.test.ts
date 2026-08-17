import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoHouse } from '@/engine/model/demo-house';
import { MAX_ROOMS, RoomFill, type RoomFillLight } from '@/engine/lighting/room-fill';

/**
 * The point of room fill is that a lit room stops at its walls. Everything here
 * tests that boundary, because a fill that leaks into the neighbouring room is
 * indistinguishable from a plain point light — the thing this mode exists to
 * replace.
 */

const house = buildDemoHouse({ textures: false });

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
    const rooms = roomNames();
    fill.apply([light(lampIn(rooms[0]))]);

    const values = uniformArray(fill);
    const lit = values.filter((v) => v > 0);
    expect(lit.length).toBe(3); // exactly one room's r, g, b
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
 * The shader patch is string replacement against three.js's own chunks. If an
 * anchor ever stops existing — a three upgrade renaming a chunk — `.replace()`
 * fails silently and the feature is dead with nothing to see: no error, no
 * warning, just rooms that never light. These assertions are the alarm.
 */
describe('shader anchors', () => {
  const physical = THREE.ShaderLib.physical;

  it('has every chunk the patch splices into', () => {
    expect(physical.vertexShader).toContain('#include <common>');
    expect(physical.vertexShader).toContain('#include <begin_vertex>');
    expect(physical.fragmentShader).toContain('#include <common>');
    expect(physical.fragmentShader).toContain('#include <lights_fragment_end>');
  });

  it('splices into a real material, not into nothing', () => {
    const fill = fresh();
    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    (fill as unknown as { patch(m: THREE.Mesh): void }).patch(mesh);

    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: physical.vertexShader,
      fragmentShader: physical.fragmentShader,
    };
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    );

    expect(shader.uniforms.fpRoomFill).toBeDefined();
    expect(shader.vertexShader).toContain('attribute float fpRoom;');
    expect(shader.vertexShader).toContain('vFpRoom = fpRoom;');
    // `flat` matters: without it the index is interpolated across the triangle
    // and every wall gets a gradient of wrong rooms.
    expect(shader.fragmentShader).toContain('flat varying float vFpRoom;');
    expect(shader.fragmentShader).toContain('reflectedLight.indirectDiffuse += fpRoomFill[');
    fill.dispose();
    material.dispose();
  });

  it('shares one uniform object across materials, so one write lights them all', () => {
    const fill = fresh();
    const shaders = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()].map(
      (material) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
        (fill as unknown as { patch(m: THREE.Mesh): void }).patch(mesh);
        const shader = {
          uniforms: {} as Record<string, unknown>,
          vertexShader: physical.vertexShader,
          fragmentShader: physical.fragmentShader,
        };
        material.onBeforeCompile(
          shader as unknown as THREE.WebGLProgramParametersWithUniforms,
          null as unknown as THREE.WebGLRenderer,
        );
        return shader;
      },
    );

    expect(shaders[0].uniforms.fpRoomFill).toBe(shaders[1].uniforms.fpRoomFill);
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
