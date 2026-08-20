import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EntityMarker } from '@/engine/entities/marker';
import { MarkerAtlas } from '@/engine/entities/marker-texture';
import type { PlacedEntity, Vec3 } from '@/types/config';

/**
 * A sensor parked outside the plan is only legible if it says which room it is
 * measuring. The leader is that statement, so what matters is when it appears
 * and where it points — not how it looks.
 */

const KITCHEN: Vec3 = [4, 0.02, 0];
const anchors = new Map<string, Vec3>([['kitchen', KITCHEN]]);

function marker(placed: Partial<PlacedEntity>): EntityMarker {
  return new EntityMarker({
    atlas: new MarkerAtlas(),
    placed: {
      entity: 'sensor.kitchen_temperature',
      position: [0, 0, 0],
      ...placed,
    },
    accent: '#03a9f4',
  });
}

/** The leader's first vertex, in the marker's own frame. */
function target(m: EntityMarker): THREE.Vector3 {
  const positions = (m as unknown as { leaderPositions: Float32Array }).leaderPositions;
  return new THREE.Vector3(positions[0], positions[1], positions[2]);
}

describe('room leader', () => {
  it('points at the room the entity names', () => {
    const m = marker({ position: [-4, 0, 0], room: 'kitchen' });
    m.setRoomAnchors(anchors);
    // Local frame: the room lies 8 m east of a marker parked 4 m west of centre.
    expect(target(m).x).toBeCloseTo(8, 5);
    expect(target(m).z).toBeCloseTo(0, 5);
    m.dispose();
  });

  it('stays collapsed for an entity that names no room', () => {
    const m = marker({ position: [-4, 0, 0] });
    m.setRoomAnchors(anchors);
    expect(target(m).length()).toBe(0);
    m.dispose();
  });

  it('stays collapsed for a room the model does not have', () => {
    const m = marker({ position: [-4, 0, 0], room: 'cellar' });
    m.setRoomAnchors(anchors);
    expect(target(m).length()).toBe(0);
    m.dispose();
  });

  it('does not draw a leader across a room the marker is standing in', () => {
    // Same spot as the room anchor: a line here would cross the plan to say
    // something the position already said.
    const m = marker({ position: [4, 1.2, 0], room: 'kitchen' });
    m.setRoomAnchors(anchors);
    expect(target(m).length()).toBe(0);
    m.dispose();
  });

  it('measures that distance horizontally', () => {
    // A wall sensor is metres above the floor the anchor sits on, and that
    // height is not what makes a leader worth drawing.
    const m = marker({ position: [4, 2.4, 0], room: 'kitchen' });
    m.setRoomAnchors(anchors);
    expect(target(m).length()).toBe(0);
    m.dispose();
  });

  it('honours an explicit marker.leader either way', () => {
    const forced = marker({ position: [4, 1.2, 0], room: 'kitchen', marker: { leader: true } });
    forced.setRoomAnchors(anchors);
    expect(target(forced).x).toBeCloseTo(0, 5);
    expect(target(forced).y).toBeCloseTo(-1.18, 2);
    forced.dispose();

    const off = marker({ position: [-4, 0, 0], room: 'kitchen', marker: { leader: false } });
    off.setRoomAnchors(anchors);
    expect(target(off).length()).toBe(0);
    off.dispose();
  });

  it('follows the marker as it is dragged', () => {
    const m = marker({ position: [-4, 0, 0], room: 'kitchen' });
    m.setRoomAnchors(anchors);
    m.setPosition([-2, 0, 0]);
    expect(target(m).x).toBeCloseTo(6, 5);
    m.dispose();
  });
});

/**
 * The anchor is the entity — where a lamp hangs and what its light comes from.
 * The label is a caption, and a caption may sit beside what it captions.
 */
describe('label offset', () => {
  /** Enough of a frame for the marker to lay itself out against. */
  function frame(m: EntityMarker): void {
    const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
    camera.position.set(0, 6, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    m.update(1 / 60, {
      size: { width: 800, height: 600 },
      activeCamera: camera,
      clippingPlanes: [],
      invalidate: () => {},
    } as unknown as Parameters<EntityMarker['update']>[1]);
  }

  /** The leader's far end, where the pill hangs. */
  function tip(m: EntityMarker): THREE.Vector3 {
    const p = (m as unknown as { leaderPositions: Float32Array }).leaderPositions;
    return new THREE.Vector3(p[6], p[7], p[8]);
  }

  it('reads the configured offset back', () => {
    const m = marker({ marker: { offset: [1.5, 0.5, -2] } });
    expect(m.getLabelOffset()).toEqual([1.5, 0.5, -2]);
    m.dispose();
  });

  it('leaves the position of the entity alone', () => {
    const m = marker({ position: [3, 1, 2] });
    m.setLabelOffset([2, 0.4, 0]);
    expect(m.object.position.toArray()).toEqual([3, 1, 2]);
    m.dispose();
  });

  it('runs the leader out to where the label went', () => {
    const m = marker({ position: [0, 0, 0] });
    m.setLabelOffset([2, 0.4, -1]);
    frame(m);
    expect(tip(m).x).toBeCloseTo(2, 3);
    expect(tip(m).z).toBeCloseTo(-1, 3);
    m.dispose();
  });

  it('keeps the leader pointing straight up when nothing was pushed aside', () => {
    const m = marker({ position: [0, 0, 0] });
    frame(m);
    expect(tip(m).x).toBeCloseTo(0, 5);
    expect(tip(m).z).toBeCloseTo(0, 5);
    expect(tip(m).y).toBeGreaterThan(0);
    m.dispose();
  });
});

/**
 * A pile's rows were arranged on purpose — that is what a stack is. Hiding one
 * because its neighbour is close by is the declutter fighting the arrangement
 * it is looking at.
 */
describe('a stacked label', () => {
  function frame(m: EntityMarker): void {
    const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
    camera.position.set(0, 6, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    m.update(1 / 60, {
      size: { width: 800, height: 600 },
      activeCamera: camera,
      clippingPlanes: [],
      invalidate: () => {},
    } as unknown as Parameters<EntityMarker['update']>[1]);
  }

  /** The body group carries the label; crowding is what hides it. */
  function labelVisible(m: EntityMarker): boolean {
    return (m as unknown as { body: THREE.Group }).body.visible;
  }

  it('stays visible when a lone marker would give way', () => {
    const m = marker({ position: [0, 0, 0] });
    m.setStackIndex(1, 3);
    m.setCrowded(true);
    frame(m);
    expect(labelVisible(m)).toBe(true);
    m.dispose();
  });

  it('still gives way when it stands alone', () => {
    const m = marker({ position: [0, 0, 0] });
    m.setCrowded(true);
    frame(m);
    expect(labelVisible(m)).toBe(false);
    m.dispose();
  });
});

/**
 * Rows of a pile are spaced by the tallest chip in it, so a long name or a
 * wordy state cannot make one row sit on the one above it.
 */
describe('the pitch of a pile', () => {
  function liftOf(m: EntityMarker): number {
    const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
    camera.position.set(0, 6, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    m.update(1 / 60, {
      size: { width: 800, height: 600 },
      activeCamera: camera,
      clippingPlanes: [],
      invalidate: () => {},
    } as unknown as Parameters<EntityMarker['update']>[1]);
    return (m as unknown as { body: THREE.Group }).body.position.y;
  }

  it('lifts a row by the pitch it was given', () => {
    const one = marker({ position: [0, 0, 0] });
    one.setStackIndex(1, 2, 30);
    const tight = liftOf(one);

    const other = marker({ position: [0, 0, 0] });
    other.setStackIndex(1, 2, 60);
    const loose = liftOf(other);

    expect(loose).toBeGreaterThan(tight);
    // Twice the pitch, twice the gap above the anchor's own lift.
    expect(loose - 0.34).toBeCloseTo((tight - 0.34) * 2, 4);
    one.dispose();
    other.dispose();
  });

  it('leaves a marker that stands alone at its resting lift', () => {
    const m = marker({ position: [0, 0, 0] });
    m.setStackIndex(0, 1, 40);
    expect(liftOf(m)).toBeCloseTo(0.34, 5);
    m.dispose();
  });
});

/**
 * The rows of a pile are spaced on the *screen*, so they must be spaced up the
 * screen — not up the house. A world-Y offset is foreshortened by the cosine of
 * the camera's elevation: at the isometric view this card ships with, 36 px of
 * pitch arrived as 29 px against 30 px chips, so the rows overlapped in the one
 * view everybody sees, and collapsed entirely as the camera tilted further.
 */
describe('a pile seen from above', () => {
  /** Camera on a 12 m orbit at this elevation, looking at the origin. */
  function cameraAt(elevationDeg: number): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(50, 900 / 640, 0.1, 200);
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    camera.position.set(
      12 * Math.sin(phi) * Math.cos(Math.PI / 4),
      12 * Math.cos(phi),
      12 * Math.sin(phi) * Math.sin(Math.PI / 4),
    );
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return camera;
  }

  /** World position of the label after one frame at this camera. */
  function labelAt(m: EntityMarker, camera: THREE.PerspectiveCamera): THREE.Vector3 {
    m.update(1 / 60, {
      size: { width: 900, height: 640 },
      activeCamera: camera,
      clippingPlanes: [],
      invalidate: () => {},
    } as unknown as Parameters<EntityMarker['update']>[1]);
    m.object.updateMatrixWorld(true);
    const body = (m as unknown as { body: THREE.Group }).body;
    return new THREE.Vector3().setFromMatrixPosition(body.matrixWorld);
  }

  it('offsets a row along the screen, not along world Y', () => {
    for (const elevation of [20, 35.26, 55, 80]) {
      const camera = cameraAt(elevation);
      const row = marker({ position: [0, 0, 0] });
      row.setStackIndex(1, 2, 36);
      const base = marker({ position: [0, 0, 0] });
      base.setStackIndex(0, 2, 36);

      const delta = labelAt(row, camera).sub(labelAt(base, camera)).normalize();
      const forward = camera.getWorldDirection(new THREE.Vector3());

      // Perpendicular to the view direction is what "up the screen" means, and
      // it is what keeps the pitch the same number of pixels at any angle. A
      // world-Y offset would tip towards the camera as it rises.
      expect(Math.abs(delta.dot(forward)), `elevation ${elevation}`).toBeLessThan(0.02);
      // And upwards, not down.
      expect(delta.dot(camera.up), `elevation ${elevation}`).toBeGreaterThan(0);

      row.dispose();
      base.dispose();
    }
  });
});

/**
 * The stack offset depends on the camera, so it has to be rebuilt each frame
 * rather than added to what is already there. Added, it walks the label a
 * little further every frame — which sends it into the sky in about a second.
 */
describe('a row across many frames', () => {
  it('stands still while the camera does', () => {
    const camera = new THREE.PerspectiveCamera(50, 900 / 640, 0.1, 200);
    camera.position.set(8, 8, 8);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const ctx = {
      size: { width: 900, height: 640 },
      activeCamera: camera,
      clippingPlanes: [],
      invalidate: () => {},
    } as unknown as Parameters<EntityMarker['update']>[1];

    const row = marker({ position: [0, 0, 0] });
    row.setStackIndex(2, 3, 36);

    row.update(1 / 60, ctx);
    row.object.updateMatrixWorld(true);
    const body = (row as unknown as { body: THREE.Group }).body;
    const first = body.position.clone();

    for (let i = 0; i < 120; i += 1) row.update(1 / 60, ctx);
    expect(body.position.distanceTo(first)).toBeLessThan(1e-6);
    row.dispose();
  });
});
