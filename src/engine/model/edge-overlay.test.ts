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

describe('edge overlay', () => {
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
