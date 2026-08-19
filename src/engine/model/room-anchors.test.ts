import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { anchorKey, roomAnchors } from '@/engine/model/room-anchors';
import { pointInTriangles } from '@/util/math';

/**
 * The anchor is where a leader line points to say "this marker belongs over
 * there". Pointing at somewhere the room is not makes the line a lie, and the
 * more oddly a room is shaped the further out the old bounding-box centre was.
 */

/** A floor mesh from a plan polygon, at `y`, tagged like the builder tags one. */
function floor(level: string, room: string, points: Array<[number, number]>, y = 0): THREE.Mesh {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geometry = new THREE.ShapeGeometry(shape);
  // ShapeGeometry lies in XY; stand it up so its plan outline is XZ.
  geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.y = y;
  mesh.userData = { level, room, part: 'floor' };
  return mesh;
}

function triangles(points: Array<[number, number]>): Float32Array {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geometry = new THREE.ShapeGeometry(shape);
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const out: number[] = [];
  const count = index ? index.count : position.count;
  for (let i = 0; i < count; i += 1) {
    const at = index ? index.getX(i) : i;
    out.push(position.getX(at), position.getY(at));
  }
  return new Float32Array(out);
}

function root(...meshes: THREE.Mesh[]): THREE.Object3D {
  const group = new THREE.Group();
  for (const mesh of meshes) group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}

/**
 * A narrow L, 6×6 overall: a 6×2 arm along the bottom and a 2×4 arm up the
 * left. Both the box centre (3, 3) and the area centroid (2.2, 2.2) fall in the
 * notch, outside the room — the second is why the centroid alone is not enough.
 */
const L_SHAPE: Array<[number, number]> = [
  [0, 0],
  [6, 0],
  [6, 2],
  [2, 2],
  [2, 6],
  [0, 6],
];

describe('room anchors', () => {
  it('puts a square room in its middle', () => {
    const anchors = roomAnchors(
      root(floor('ground', 'kitchen', [[0, 0], [4, 0], [4, 2], [0, 2]])),
    );
    const point = anchors.get('kitchen');
    expect(point).toBeDefined();
    expect(point![0]).toBeCloseTo(2, 3);
    expect(point![2]).toBeCloseTo(1, 3);
  });

  it('lands inside an L-shaped room, where its bounding box centre does not', () => {
    const anchors = roomAnchors(root(floor('ground', 'hall', L_SHAPE)));
    const point = anchors.get('hall');
    expect(point).toBeDefined();

    const outline = triangles(L_SHAPE);
    expect(pointInTriangles(outline, point![0], point![2]), 'anchor inside the room').toBe(true);
    // Neither of the cheap answers would have done: both land in the notch.
    expect(pointInTriangles(outline, 3, 3), 'bounding-box centre').toBe(false);
    expect(pointInTriangles(outline, 2.2, 2.2), 'area centroid').toBe(false);
  });

  it('sits just above the floor it belongs to', () => {
    const anchors = roomAnchors(root(floor('upper', 'bath', [[0, 0], [2, 0], [2, 2], [0, 2]], 2.6)));
    expect(anchors.get('bath')![1]).toBeCloseTo(2.62, 3);
  });

  /**
   * Room ids are unique per storey and not across the building, so a hallway on
   * every floor gives three rooms called `flur`. Keyed by name alone their
   * floors merge into one box spanning the house.
   */
  it('keeps rooms of the same name on different storeys apart', () => {
    const anchors = roomAnchors(
      root(
        floor('ground', 'flur', [[0, 0], [2, 0], [2, 2], [0, 2]], 0),
        floor('upper', 'flur', [[10, 10], [12, 10], [12, 12], [10, 12]], 3),
      ),
    );

    expect(anchors.get(anchorKey('ground', 'flur'))![0]).toBeCloseTo(1, 3);
    expect(anchors.get(anchorKey('ground', 'flur'))![1]).toBeCloseTo(0.02, 3);
    expect(anchors.get(anchorKey('upper', 'flur'))![0]).toBeCloseTo(11, 3);
    expect(anchors.get(anchorKey('upper', 'flur'))![1]).toBeCloseTo(3.02, 3);
    // Ambiguous on its own, so the bare name is not offered at all.
    expect(anchors.get('flur')).toBeUndefined();
  });

  it('offers the bare name when it can only mean one room', () => {
    const anchors = roomAnchors(root(floor('ground', 'kitchen', [[0, 0], [2, 0], [2, 2], [0, 2]])));
    expect(anchors.get('kitchen')).toEqual(anchors.get(anchorKey('ground', 'kitchen')));
  });

  it('ignores anything that is not a floor', () => {
    const ceiling = floor('ground', 'kitchen', [[0, 0], [2, 0], [2, 2], [0, 2]], 2.5);
    ceiling.userData.part = 'ceiling';
    expect(roomAnchors(root(ceiling)).size).toBe(0);
  });
});
