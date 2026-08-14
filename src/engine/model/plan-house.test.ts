import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlanError, buildFromPlan } from '@/engine/model/plan-house';
import type { PlanSpec } from '@/engine/model/plan-types';

/**
 * The fixture is written out here rather than imported so every expected number
 * sits next to the assertion that checks it.
 *
 * Two storeys on a 12 x 8 m footprint, north-west corner on the origin (+X east,
 * +Z south, so north is −Z). 0.30 exterior walls and 0.12 partitions, which
 * makes the interior 11.40 x 7.40, running from 0.30 to 11.70 and 0.30 to 7.70.
 * Rooms are their clear interior, separated by exactly one partition thickness.
 * A mono-pitch roof falls from +5.60 at the north face to +4.40 at the south.
 */
const FIXTURE: PlanSpec = {
  name: 'test_house',
  units: 'm',
  exteriorWall: 0.3,
  interiorWall: 0.12,
  slab: 0.3,
  levels: [
    {
      id: 'lower',
      name: 'Lower floor',
      elevation: -2.5,
      height: 2.5,
      outline: [
        [0, 0],
        [12, 0],
        [12, 8],
        [0, 8],
      ],
      rooms: [
        { id: 'hall', rect: [0.3, 0.3, 1.5, 7.7] },
        { id: 'store', rect: [1.62, 0.3, 11.7, 7.7], floor: 'concrete' },
      ],
      openings: [
        { kind: 'window', wall: 'n', at: 6, width: 1, sill: 1.6, height: 0.5 },
        { kind: 'door', wall: { between: ['hall', 'store'] }, width: 0.9 },
      ],
      stairs: [
        { id: 'stairs', room: 'hall', from: [0.9, 6.9], to: [0.9, 1.5], width: 1.1, steps: 14 },
      ],
    },
    {
      id: 'upper',
      name: 'Upper floor',
      elevation: 0,
      height: 3,
      clearHeight: 2.6,
      ceiling: false,
      outline: [
        [0, 0],
        [12, 0],
        [12, 8],
        [0, 8],
      ],
      rooms: [
        { id: 'hall', rect: [0.3, 0.3, 1.5, 7.7] },
        { id: 'kitchen', rect: [1.62, 0.3, 6, 3.5], openTo: ['living'] },
        {
          id: 'living',
          rect: [
            [6, 0.3, 11.7, 3.5],
            [1.62, 3.5, 11.7, 7.7],
          ],
        },
      ],
      openings: [
        { kind: 'sliding', wall: 'n', at: 8, width: 2.4, height: 2.3 },
        { kind: 'window', wall: 's', at: 6, width: 2, sill: 0.9, height: 1.4 },
        { kind: 'door', wall: { between: ['hall', 'living'] }, width: 0.9 },
      ],
    },
  ],
  roof: {
    kind: 'mono',
    highSide: 'n',
    eaveHeight: 4.4,
    ridgeHeight: 5.6,
    overhang: 0.3,
    thickness: 0.24,
  },
  site: [{ id: 'terrace', kind: 'terrace', rect: [0, -4, 12, 0], level: -0.1 }],
};

/** World-space box of a node, children included. */
function box(house: ReturnType<typeof buildFromPlan>, name: string): THREE.Box3 {
  const node = house.nodes.get(name);
  expect(node, `node ${name} should exist`).toBeDefined();
  return new THREE.Box3().setFromObject(node!);
}

describe('buildFromPlan', () => {
  const house = buildFromPlan(FIXTURE, { textures: false });

  it('reports the storeys at the elevations the plan gives', () => {
    expect(house.levels.map((l) => l.id)).toEqual(['lower', 'upper']);
    expect(house.levels.map((l) => l.elevation)).toEqual([-2.5, 0]);
    expect(house.levels.map((l) => l.height)).toEqual([2.5, 3]);
  });

  it('is 12.00 x 8.00 m on plan, centred on the origin', () => {
    // Measured on a storey rather than on `bounds`: the roof overhang and the
    // site geometry would both blur the footprint.
    const lower = box(house, 'lower');
    expect(lower.max.x - lower.min.x).toBeCloseTo(12, 2);
    expect(lower.max.z - lower.min.z).toBeCloseTo(8, 2);
    expect(lower.min.x).toBeCloseTo(-6, 2);
    expect(lower.min.z).toBeCloseTo(-4, 2);
  });

  it('pitches the mono roof up toward the north', () => {
    const mesh = house.nodes.get('upper/roof/pitch') as THREE.Mesh | undefined;
    expect(mesh, 'the roof panel should exist').toBeDefined();
    mesh!.updateWorldMatrix(true, false);

    // A bounding box cannot tell a north fall from a south one — a roof built
    // with the pitch inverted occupies exactly the same box — so sample the
    // real vertices at each end of the slope.
    const position = mesh!.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh!.matrixWorld);
      minZ = Math.min(minZ, v.z);
      maxZ = Math.max(maxZ, v.z);
    }
    let north = -Infinity;
    let south = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh!.matrixWorld);
      if (v.z < minZ + 0.2) north = Math.max(north, v.y);
      if (v.z > maxZ - 0.2) south = Math.max(south, v.y);
    }

    expect(north).toBeGreaterThan(south);
    // The 0.3 m overhang carries the plane a little past both faces.
    expect(south).toBeCloseTo(4.4, 1);
    expect(north).toBeCloseTo(5.6, 1);
  });

  it('stamps every mesh with its level, room and part', () => {
    let meshes = 0;
    house.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      meshes += 1;
      expect(mesh.name.split('/')).toHaveLength(3);
      expect(typeof mesh.userData.level).toBe('string');
      expect(typeof mesh.userData.room).toBe('string');
      expect(typeof mesh.userData.part).toBe('string');
    });
    expect(meshes).toBeGreaterThan(10);
    expect((house.nodes.get('upper/exterior/glazing') as THREE.Mesh).userData.glass).toBe(true);
  });

  it('builds the partition between two rooms once, not once per room', () => {
    const partitions = house.nodes.get('lower/structure/partitions') as THREE.Mesh | undefined;
    expect(partitions).toBeDefined();
    const b = new THREE.Box3().setFromObject(partitions!);
    // One 0.12 m wall on the shared centreline, not a pair of them.
    expect(b.max.x - b.min.x).toBeCloseTo(0.12, 2);
  });

  it('builds no partition between rooms declared open to each other', () => {
    // Kitchen and living share two long edges but are one volume, so the only
    // partition upstairs is the one along the hall.
    const b = new THREE.Box3().setFromObject(house.nodes.get('upper/structure/partitions')!);
    expect(b.max.x - b.min.x).toBeCloseTo(0.12, 2);
  });

  it('keeps site geometry out of the building bounds', () => {
    expect(house.nodes.get('site/terrace/paving')?.userData.alwaysVisible).toBe(true);
    // The terrace reaches z = -8 and must not drag the bounds — and with them
    // the camera framing and the section planes — out with it. The north face
    // plus the roof overhang is as far as they may go.
    expect(house.bounds.min.z).toBeGreaterThan(-4.4);
  });

  it('disposes cleanly and idempotently', () => {
    const other = buildFromPlan(FIXTURE, { textures: false });
    expect(() => other.materials.dispose()).not.toThrow();
    expect(() => other.materials.dispose()).not.toThrow();
  });
});

describe('buildFromPlan validation', () => {
  it('names the offending path when the plan is wrong', () => {
    expect(() => buildFromPlan({ levels: [] })).toThrowError(PlanError);
    try {
      buildFromPlan({
        levels: [{ ...FIXTURE.levels[0], rooms: [{ id: 'x', rect: [0, 0, 0, 0] }] }],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as PlanError).path).toBe('levels[0].rooms[0].rect');
    }
  });

  it('refuses an opening that names a room the storey does not have', () => {
    expect(() =>
      buildFromPlan({
        levels: [
          {
            ...FIXTURE.levels[0],
            openings: [{ kind: 'door', wall: { between: ['hall', 'nope'] }, width: 0.9 }],
          },
        ],
      }),
    ).toThrowError(/unknown room "nope"/);
  });

  it('refuses an exterior opening that misses the facade', () => {
    expect(() =>
      buildFromPlan({
        levels: [
          { ...FIXTURE.levels[0], openings: [{ kind: 'window', wall: 'n', at: 40, width: 1 }] },
        ],
      }),
    ).toThrowError(/no "n" exterior wall reaches/);
  });
});
