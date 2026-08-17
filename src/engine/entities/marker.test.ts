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
