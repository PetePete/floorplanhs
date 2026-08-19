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
