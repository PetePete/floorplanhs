/**
 * Where a room *is*, as one point a leader line can be aimed at.
 *
 * This was the centre of the room's bounding box, which is only the same thing
 * for a rectangle. An L-shaped hallway's box centre sits in the room next door,
 * so the line that says "this marker belongs over there" pointed at somewhere
 * the room is not — and the more oddly a room is shaped, the further out it is.
 *
 * The area-weighted centroid is right for anything convex and close for most
 * else; where it still falls outside its own polygon, the centre of the room's
 * largest triangle is used, which cannot.
 */

import * as THREE from 'three';

import type { Vec3 } from '@/types/config';
import { pointInTriangles } from '@/util/math';

interface RoomGeometry {
  /** Flat [ax, az, bx, bz, cx, cz, …] in world space. */
  triangles: number[];
  /** Top of the floor slab: what the leader should touch. */
  top: number;
}

/** A character no room id can contain. */
const KEY_SEPARATOR = '|';

/** Level-qualified key, plus a bare one for callers that know no level. */
export function anchorKey(level: string, room: string): string {
  return `${level}${KEY_SEPARATOR}${room}`;
}

/**
 * One anchor per room, keyed both by `level + room` and — where the name is
 * unambiguous — by room alone.
 *
 * Both, because room ids are unique per storey and not across the building: a
 * house with a "Flur" on every floor has three rooms called `flur`. Keyed by
 * name alone their floors merge into one box spanning the whole house, and the
 * leader points at a spot between storeys.
 */
export function roomAnchors(root: THREE.Object3D): Map<string, Vec3> {
  const rooms = new Map<string, RoomGeometry>();
  const byName = new Map<string, Set<string>>();

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || mesh.userData.part !== 'floor') return;
    const room = typeof mesh.userData.room === 'string' ? mesh.userData.room : '';
    if (!room) return;
    const level = typeof mesh.userData.level === 'string' ? mesh.userData.level : '';

    const key = anchorKey(level, room);
    const entry = rooms.get(key) ?? { triangles: [], top: -Infinity };
    rooms.set(key, entry);
    byName.set(room, (byName.get(room) ?? new Set()).add(key));

    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count / 3 : position.count / 3;
    for (let t = 0; t < count; t += 1) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, i2).applyMatrix4(mesh.matrixWorld);
      entry.top = Math.max(entry.top, a.y, b.y, c.y);
      // A slab has sides and an underside; only its plan outline matters, and
      // the vertical faces are exactly the ones with no area in plan.
      if (Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) < 1e-6) continue;
      entry.triangles.push(a.x, a.z, b.x, b.z, c.x, c.z);
    }
  });

  const anchors = new Map<string, Vec3>();
  for (const [key, entry] of rooms) {
    const point = anchorFor(entry);
    if (point) anchors.set(key, point);
  }

  // The bare name, but only where it can mean one thing.
  for (const [room, keys] of byName) {
    if (keys.size !== 1) continue;
    const only = [...keys][0];
    const point = anchors.get(only);
    if (point) anchors.set(room, point);
  }

  return anchors;
}

function anchorFor(entry: RoomGeometry): Vec3 | null {
  const t = entry.triangles;
  if (t.length < 6 || !Number.isFinite(entry.top)) return null;

  let area = 0;
  let cx = 0;
  let cz = 0;
  let largest = 0;
  let largestX = t[0];
  let largestZ = t[1];

  for (let i = 0; i + 5 < t.length; i += 6) {
    const size = Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
    if (size <= 0) continue;
    const mx = (t[i] + t[i + 2] + t[i + 4]) / 3;
    const mz = (t[i + 1] + t[i + 3] + t[i + 5]) / 3;
    area += size;
    cx += mx * size;
    cz += mz * size;
    if (size > largest) {
      largest = size;
      largestX = mx;
      largestZ = mz;
    }
  }
  if (area <= 0) return null;

  cx /= area;
  cz /= area;
  const triangles = new Float32Array(t);
  // A U-shaped room's centroid lands in the gap between its arms. The middle of
  // its biggest triangle is inside the room by construction.
  const inside = pointInTriangles(triangles, cx, cz);
  const x = inside ? cx : largestX;
  const z = inside ? cz : largestZ;

  // Just clear of the floor, so the line lies on it rather than in it.
  return [x, entry.top + 0.02, z];
}
