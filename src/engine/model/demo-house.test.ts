import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDemoHouse } from '@/engine/model/demo-house';

/**
 * The roof panels are built by rotating a flat slab about X. Getting that sign
 * wrong produces a butterfly roof — eaves lifted above the ridge — which still
 * type-checks, still renders, and still reads as "a roof" in a bounding box.
 *
 * Bounding boxes are useless here: a V and a gable occupy the same one. Every
 * assertion below therefore samples real vertices.
 */
describe('demo house roof', () => {
  const house = buildDemoHouse({ textures: false });

  /** Highest and lowest vertex within a Z slice of a mesh, in world space. */
  function profile(name: string): { atRidge: number; atEave: number; span: number } {
    const mesh = house.nodes.get(name) as THREE.Mesh | undefined;
    expect(mesh, `node ${name} should exist`).toBeDefined();
    mesh!.updateWorldMatrix(true, false);

    const position = mesh!.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh!.matrixWorld);
      minZ = Math.min(minZ, v.z);
      maxZ = Math.max(maxZ, v.z);
    }

    // The ridge edge is the one nearest the centreline, the eave edge the one
    // furthest from it — regardless of which side of the house this panel is.
    const ridgeIsMin = Math.abs(minZ) < Math.abs(maxZ);
    const ridgeZ = ridgeIsMin ? minZ : maxZ;
    const eaveZ = ridgeIsMin ? maxZ : minZ;

    let atRidge = -Infinity;
    let atEave = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh!.matrixWorld);
      if (Math.abs(v.z - ridgeZ) < 0.3) atRidge = Math.max(atRidge, v.y);
      if (Math.abs(v.z - eaveZ) < 0.3) atEave = Math.max(atEave, v.y);
    }
    return { atRidge, atEave, span: Math.abs(eaveZ - ridgeZ) };
  }

  it.each(['upper/roof/pitch_north', 'upper/roof/pitch_south'])(
    '%s falls from the ridge to the eave',
    (name) => {
      const { atRidge, atEave, span } = profile(name);
      expect(atRidge).toBeGreaterThan(atEave);
      // A real pitch, not a near-flat slab that happens to tilt the right way.
      expect(atRidge - atEave).toBeGreaterThan(1);
      expect(span).toBeGreaterThan(4);
    },
  );

  it('meets both pitches at the same ridge height, under the gable apex', () => {
    const north = profile('upper/roof/pitch_north');
    const south = profile('upper/roof/pitch_south');
    expect(north.atRidge).toBeCloseTo(south.atRidge, 1);

    const gable = new THREE.Box3().setFromObject(house.nodes.get('upper/roof/gable_east')!);
    // The gable triangle's apex is the ridge; the panels must reach it, and the
    // eaves must stay well below it.
    expect(north.atRidge).toBeGreaterThan(gable.max.y - 0.6);
    expect(north.atEave).toBeLessThan(gable.max.y - 1);
  });
});
