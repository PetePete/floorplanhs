import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EdgeOverlay } from '@/engine/model/edge-overlay';

/** A mesh the overlay will accept: big enough, with a level and a part. */
function slab(part: string, level = 'level0'): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 0.12, 3));
  mesh.userData.level = level;
  mesh.userData.part = part;
  mesh.userData.room = 'living';
  return mesh;
}

function lineCount(overlay: EdgeOverlay): number {
  let segments = 0;
  overlay.object.traverse((object) => {
    const lines = object as THREE.LineSegments;
    if (lines.isLineSegments) segments += lines.geometry.getAttribute('position').count / 2;
  });
  return segments;
}

/** Highest point of the line work, in world space. */
function drawnTop(overlay: EdgeOverlay): number {
  overlay.object.updateMatrixWorld(true);
  const box = new THREE.Box3();
  box.setFromObject(overlay.object);
  return box.max.y;
}

describe('edge overlay', () => {
  it('rebuilds correctly while the storeys are apart', () => {
    // The overlay bakes world matrices, and the exploded view lifts the very
    // meshes it bakes. Rebuilding mid-explosion — hiding the ceilings does
    // exactly that — used to bake the lift *and* keep it on the group: the
    // lines ended up a storey above their walls, so the walls read as
    // see-through, and every line was attributed to the rooms of the storey
    // above, which put the lit room in the wrong place.
    const root = new THREE.Group();
    const wall = slab('walls');
    root.add(wall);

    const overlay = new EdgeOverlay();
    overlay.setStyle('wireframe');
    overlay.build(root, []);
    const atRest = drawnTop(overlay);

    // Explode: the model lifts its meshes, the overlay lifts its groups.
    wall.position.y = 3;
    root.updateMatrixWorld(true);
    overlay.setLevelOffsets(new Map([['level0', 3]]));
    expect(drawnTop(overlay)).toBeCloseTo(atRest + 3, 6);

    // Now rebuild in that state. The lines must not move.
    overlay.build(root, []);
    expect(drawnTop(overlay)).toBeCloseTo(atRest + 3, 6);

    // And putting the storeys back must land them where they started.
    wall.position.y = 0;
    root.updateMatrixWorld(true);
    overlay.setLevelOffsets(null);
    expect(drawnTop(overlay)).toBeCloseTo(atRest, 6);
    overlay.dispose();
  });

  it('draws no lines for a floor slab', () => {
    // A storey's floor is one slab per room, and the rooms neither meet each
    // other nor cover the storey: on a real house, two thirds of the outline
    // was buried under a wall and the rest drew room rectangles across the open
    // floor, which reads as the plan of the storey printed on the ground.
    const root = new THREE.Group();
    root.add(slab('floor'));

    const overlay = new EdgeOverlay();
    overlay.setStyle('wireframe');
    overlay.build(root, []);
    expect(lineCount(overlay)).toBe(0);
    overlay.dispose();
  });

  it('still draws walls and ceilings', () => {
    const root = new THREE.Group();
    root.add(slab('walls'));
    const overlay = new EdgeOverlay();
    overlay.setStyle('wireframe');
    overlay.build(root, []);
    expect(lineCount(overlay)).toBe(12);
    overlay.dispose();
  });

  it('keeps a hidden floor slab as a depth mask', () => {
    // Dropped from the line work, not from the scene: in a hidden-line drawing
    // the slab is what stops the storey below showing through.
    const root = new THREE.Group();
    const floor = slab('floor');
    root.add(floor);

    const overlay = new EdgeOverlay();
    overlay.setStyle('wireframe');
    overlay.build(root, []);

    const material = floor.material as THREE.Material;
    expect(floor.visible).toBe(true);
    expect(material.colorWrite).toBe(false);
    expect(material.depthWrite).toBe(true);
    overlay.dispose();
  });
});
