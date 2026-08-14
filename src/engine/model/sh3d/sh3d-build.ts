/**
 * A parsed Sweet Home 3D home → three.js geometry.
 *
 * Same output contract as `buildDemoHouse` and `buildFromPlan` — the same
 * `<level>/<room>/<part>` names, the same `userData.level/room/part/glass`
 * stamps, the same material library ownership — so `ModelManager` cannot tell
 * the three apart.
 *
 * ## What Sweet Home 3D gives you, and what it does not
 *
 * Walls are **arbitrary segments** with a thickness, a height at each end and
 * an optional arc. Rooms are **arbitrary polygons**. Neither is forced through
 * `PlanSpec`, whose rectangle-and-grid model would flatten exactly the geometry
 * that makes a real home look like itself.
 *
 * What the format does *not* record is which wall belongs to which room — there
 * is no association at all — so walls, glazing and door leaves land in the
 * `structure` pseudo-room of their storey, and only floors, ceilings and
 * furniture get a real room name.
 *
 * It also does not record whether a `doorOrWindow` is a door or a window; see
 * `looksLikeWindow` in the parser.
 *
 * ## Budget
 *
 * Three merged meshes per storey for the shell (walls, glazing, leaves), two
 * per room (floor, ceiling), and **one per piece of furniture** — the pieces
 * stay individually addressable so `bindNode` can reach them and a future
 * toggle can hide them via `userData.furniture`. Materials are shared: one per
 * distinct furniture colour, on top of the standard library.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LevelDefinition } from '@/types/config';
import { computeModelBounds } from '@/engine/model/level-detect';
import { createMaterialLibrary, type MaterialLibrary } from '@/engine/model/materials';
import type { DemoHouse, DemoHouseOptions } from '@/engine/model/demo-house';
import { readSh3dArchive } from '@/engine/model/sh3d/sh3d-archive';
import {
  parseHomeXml,
  type Sh3dFurniture,
  type Sh3dHome,
  type Sh3dLevel,
  type Sh3dOpening,
  type Sh3dRoom,
  type Sh3dWall,
} from '@/engine/model/sh3d/sh3d-parse';
import { slugify } from '@/util/math';

/** Same contract as the demo house, so the model manager treats them alike. */
export type Sh3dHouse = DemoHouse;
export type Sh3dHouseOptions = DemoHouseOptions;

const EPS = 1e-4;
/** Floor/tile texture repeat in metres, for UV scaling. */
const FLOOR_TILE_M = 1.2;
/** Ceiling finish thickness. */
const CEILING_T = 0.02;
/** Storey height used when a level and the home both fail to state one. */
const DEFAULT_STOREY = 2.5;
/** Longest chord used when tessellating a curved wall. */
const ARC_STEP = 0.25;

/* ------------------------------------------------------------- materials */

/**
 * Furniture colours are per piece and unknown until we read the file, so the
 * library gets extended at build time. Wrapping rather than mutating keeps
 * `getAll()` honest — the section controller walks it to attach clipping
 * planes, so a material it cannot see is a material that will not be cut.
 */
function extendLibrary(base: MaterialLibrary, extra: THREE.Material[]): MaterialLibrary {
  let disposed = false;
  return {
    ...base,
    getAll: () => [...base.getAll(), ...extra],
    dispose: () => {
      if (disposed) return;
      disposed = true;
      base.dispose();
      for (const material of extra) material.dispose();
      extra.length = 0;
    },
  };
}

/* -------------------------------------------------------------- geometry */

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const merged: THREE.BufferGeometry | null = mergeGeometries(parts, false);
  if (!merged) return parts[0];
  for (const part of parts) part.dispose();
  return merged;
}

function scaleUv(geometry: THREE.BufferGeometry, scale: number): void {
  const uv = geometry.getAttribute('uv');
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * scale, uv.getY(i) * scale);
  uv.needsUpdate = true;
}

/**
 * A quadrilateral panel in a wall's local (u, y) frame, extruded across the
 * wall's thickness. Independent corner heights are what lets one code path
 * cover a plain pier, the sill under a window, the lintel over a door and a
 * wall whose top slopes from `height` to `heightAtEnd`.
 */
function panel(
  u0: number,
  u1: number,
  bottom0: number,
  bottom1: number,
  top0: number,
  top1: number,
  thickness: number,
): THREE.BufferGeometry | null {
  if (u1 - u0 <= EPS) return null;
  if (top0 - bottom0 <= EPS && top1 - bottom1 <= EPS) return null;

  const shape = new THREE.Shape();
  shape.moveTo(u0, bottom0);
  shape.lineTo(u1, bottom1);
  shape.lineTo(u1, Math.max(top1, bottom1));
  shape.lineTo(u0, Math.max(top0, bottom0));
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geometry.translate(0, 0, -thickness / 2);
  return geometry;
}

/**
 * Maps a wall's local frame onto the world: local +X runs from `from` to `to`,
 * local +Z is the wall's thickness, local Y is height above `baseY`.
 */
function segmentMatrix(
  from: readonly [number, number],
  to: readonly [number, number],
  baseY: number,
): THREE.Matrix4 {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  return new THREE.Matrix4()
    .makeTranslation(from[0], baseY, from[1])
    .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(-dz, dx)));
}

/** Drops repeated points, which Sweet Home 3D room polygons do contain. */
function cleanPolygon(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 1e-6 && Math.abs(last[1] - point[1]) < 1e-6) continue;
    out.push([point[0], point[1]]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 2 && first && last && Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
    out.pop();
  }
  return out;
}

/**
 * A horizontal slab from an arbitrary polygon.
 *
 * The shape is built in (x, z) and then rotated about X, which maps the shape's
 * own Y onto world Z without mirroring it — the winding, and therefore the face
 * normals, survive.
 */
function slabFromPolygon(
  points: ReadonlyArray<readonly [number, number]>,
  top: number,
  thickness: number,
): THREE.BufferGeometry | null {
  if (points.length < 3 || thickness <= EPS) return null;
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();

  let geometry: THREE.ExtrudeGeometry;
  try {
    geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  } catch {
    // A self-intersecting polygon can defeat the triangulator. One bad room is
    // not a reason to fail the whole import.
    return null;
  }
  const position = geometry.getAttribute('position');
  if (!position || position.count === 0) {
    geometry.dispose();
    return null;
  }
  scaleUv(geometry, 1 / FLOOR_TILE_M);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, top, 0);
  return geometry;
}

function polygonContains(
  points: ReadonlyArray<readonly [number, number]>,
  x: number,
  z: number,
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* ------------------------------------------------------------------ walls */

interface WallSegment {
  from: [number, number];
  to: [number, number];
  length: number;
  /** Wall height at each end of this segment. */
  height0: number;
  height1: number;
  thickness: number;
  openings: PlacedOpening[];
}

interface PlacedOpening {
  /** Distance along the segment to the opening's centre. */
  at: number;
  width: number;
  /** Above the wall base. */
  sill: number;
  height: number;
  window: boolean;
}

/**
 * Straightens a wall into one or more segments.
 *
 * `arcExtent` bows the wall between its ends; it is tessellated rather than
 * modelled, which keeps every downstream step — openings, mitres, extrusion —
 * working on plain straight pieces. `wallAtStart` / `wallAtEnd` name the walls
 * joined at each end; rather than mitring properly we extend the wall half a
 * thickness into its neighbour, which closes the corner for any join angle and
 * is invisible from outside because the overshoot is buried in the other wall.
 */
function wallSegments(wall: Sh3dWall): WallSegment[] {
  const start: [number, number] = [wall.xStart, wall.zStart];
  const end: [number, number] = [wall.xEnd, wall.zEnd];
  const heightEnd = wall.heightAtEnd ?? wall.height;

  let points: Array<[number, number]> = [start, end];
  const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);

  if (Math.abs(wall.arcExtent) > 1e-3 && chord > EPS) {
    const half = wall.arcExtent / 2;
    const tan = Math.tan(half);
    if (Number.isFinite(tan) && Math.abs(tan) > 1e-6) {
      // Centre sits on the perpendicular bisector of the chord.
      const mx = (start[0] + end[0]) / 2;
      const mz = (start[1] + end[1]) / 2;
      const px = -(end[1] - start[1]) / chord;
      const pz = (end[0] - start[0]) / chord;
      const offset = chord / 2 / tan;
      const cx = mx + px * offset;
      const cz = mz + pz * offset;
      const a0 = Math.atan2(start[1] - cz, start[0] - cx);
      const steps = Math.min(48, Math.max(2, Math.ceil((Math.abs(wall.arcExtent) * chord) / 2 / ARC_STEP)));
      const radius = Math.hypot(start[0] - cx, start[1] - cz);
      const arc: Array<[number, number]> = [];
      for (let i = 0; i <= steps; i++) {
        const a = a0 - wall.arcExtent * (i / steps);
        arc.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
      }
      if (arc.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))) points = arc;
    }
  }

  // Extend the two free ends of the whole run into whatever they join.
  const extendStart = wall.wallAtStart ? wall.thickness / 2 : 0;
  const extendEnd = wall.wallAtEnd ? wall.thickness / 2 : 0;
  if (extendStart > 0 && points.length >= 2) {
    const [a, b] = [points[0], points[1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    points[0] = [a[0] - ((b[0] - a[0]) / len) * extendStart, a[1] - ((b[1] - a[1]) / len) * extendStart];
  }
  if (extendEnd > 0 && points.length >= 2) {
    const a = points[points.length - 1];
    const b = points[points.length - 2];
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    points[points.length - 1] = [
      a[0] + ((a[0] - b[0]) / len) * extendEnd,
      a[1] + ((a[1] - b[1]) / len) * extendEnd,
    ];
  }

  const total = points.slice(1).reduce(
    (sum, point, i) => sum + Math.hypot(point[0] - points[i][0], point[1] - points[i][1]),
    0,
  );

  const segments: WallSegment[] = [];
  let travelled = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length <= EPS) continue;
    const t0 = total > 0 ? travelled / total : 0;
    const t1 = total > 0 ? (travelled + length) / total : 1;
    segments.push({
      from,
      to,
      length,
      height0: wall.height + (heightEnd - wall.height) * t0,
      height1: wall.height + (heightEnd - wall.height) * t1,
      thickness: wall.thickness,
      openings: [],
    });
    travelled += length;
  }
  return segments;
}

interface WallBuild {
  solid: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  leaves: THREE.BufferGeometry[];
}

/**
 * Extrudes one wall segment, splitting it into piers, sills and lintels around
 * its openings. No CSG: the pieces stay watertight and the reveals read
 * correctly in a cross-section, which is the whole point of this card.
 *
 * Everything comes out in the segment's local frame; the caller applies
 * `segmentMatrix` to put it in the world.
 */
function buildSegment(segment: WallSegment, out: WallBuild): void {
  const { length, thickness } = segment;
  const heightAt = (u: number): number =>
    segment.height0 + ((segment.height1 - segment.height0) * u) / (length || 1);

  const push = (geometry: THREE.BufferGeometry | null): void => {
    if (geometry) out.solid.push(geometry);
  };

  const openings = segment.openings
    .filter((o) => o.at + o.width / 2 > 0 && o.at - o.width / 2 < length)
    .sort((a, b) => a.at - b.at);

  let cursor = 0;
  for (const opening of openings) {
    const a = Math.max(0, opening.at - opening.width / 2);
    const b = Math.min(length, opening.at + opening.width / 2);
    if (b - a <= EPS) continue;

    push(panel(cursor, a, 0, 0, heightAt(cursor), heightAt(a), thickness));

    const sill = Math.max(0, opening.sill);
    const head = Math.min(Math.min(heightAt(a), heightAt(b)), sill + opening.height);
    if (sill > EPS) push(panel(a, b, 0, 0, sill, sill, thickness));
    if (head < Math.max(heightAt(a), heightAt(b)) - EPS) {
      push(panel(a, b, head, head, heightAt(a), heightAt(b), thickness));
    }
    cursor = Math.max(cursor, b);

    const clear = head - sill;
    if (clear > 0.1) {
      const cy = sill + clear / 2;
      const geometry = opening.window
        ? new THREE.BoxGeometry(b - a - 0.06, clear - 0.06, 0.02)
        : new THREE.BoxGeometry(b - a - 0.04, clear - 0.03, 0.045);
      geometry.translate((a + b) / 2, cy, 0);
      (opening.window ? out.glass : out.leaves).push(geometry);
    }
  }
  push(panel(cursor, length, 0, 0, heightAt(cursor), heightAt(length), thickness));
}

/* ---------------------------------------------------------------- builder */

interface MeshOptions {
  cast?: boolean;
  receive?: boolean;
  glass?: boolean;
  furniture?: boolean;
}

class Sh3dBuilder {
  readonly root = new THREE.Group();
  readonly nodes = new Map<string, THREE.Object3D>();
  private readonly levelGroups = new Map<string, THREE.Group>();
  private readonly roomGroups = new Map<string, THREE.Group>();
  private readonly taken = new Set<string>();

  constructor(name: string) {
    this.root.name = name;
  }

  private level(id: string): THREE.Group {
    let group = this.levelGroups.get(id);
    if (!group) {
      group = new THREE.Group();
      group.name = id;
      group.userData.level = id;
      this.root.add(group);
      this.levelGroups.set(id, group);
      this.nodes.set(id, group);
    }
    return group;
  }

  private room(levelId: string, roomId: string): THREE.Group {
    const key = `${levelId}/${roomId}`;
    let group = this.roomGroups.get(key);
    if (!group) {
      group = new THREE.Group();
      group.name = key;
      group.userData.level = levelId;
      group.userData.room = roomId;
      this.level(levelId).add(group);
      this.roomGroups.set(key, group);
      this.nodes.set(key, group);
    }
    return group;
  }

  /** Makes a node name unique; furniture names repeat constantly. */
  private unique(name: string): string {
    if (!this.taken.has(name)) {
      this.taken.add(name);
      return name;
    }
    let n = 2;
    while (this.taken.has(`${name}_${n}`)) n += 1;
    const unique = `${name}_${n}`;
    this.taken.add(unique);
    return unique;
  }

  mesh(
    levelId: string,
    roomId: string,
    part: string,
    parts: THREE.BufferGeometry[],
    material: THREE.Material,
    options: MeshOptions = {},
  ): THREE.Mesh | null {
    const geometry = mergeAll(parts);
    if (!geometry) return null;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = this.unique(`${levelId}/${roomId}/${part}`);
    mesh.userData.level = levelId;
    mesh.userData.room = roomId;
    mesh.userData.part = part;
    mesh.userData.shadowsConfigured = true;
    if (options.glass) mesh.userData.glass = true;
    if (options.furniture) mesh.userData.furniture = true;
    mesh.castShadow = options.cast ?? true;
    mesh.receiveShadow = options.receive ?? true;

    this.room(levelId, roomId).add(mesh);
    this.nodes.set(mesh.name, mesh);
    return mesh;
  }
}

/* -------------------------------------------------------------- assembly */

interface ResolvedLevel {
  source: Sh3dLevel;
  /** Storey height stretched to reach the next level up. */
  height: number;
  rooms: Array<{ id: string; source: Sh3dRoom; points: Array<[number, number]> }>;
}

function resolveLevels(home: Sh3dHome): ResolvedLevel[] {
  const levels = home.levels;
  const byId = new Map<string, ResolvedLevel>();
  const resolved: ResolvedLevel[] = levels.map((source, index) => {
    // Reach up to the next level that is genuinely higher; two levels may share
    // an elevation, distinguished only by `elevationIndex`.
    let height = Math.max(source.height, DEFAULT_STOREY);
    for (let i = index + 1; i < levels.length; i++) {
      if (levels[i].elevation > source.elevation + 0.05) {
        height = levels[i].elevation - source.elevation;
        break;
      }
    }
    const entry: ResolvedLevel = { source, height, rooms: [] };
    byId.set(source.id, entry);
    return entry;
  });

  const fallback = resolved[0];
  const takenRoomIds = new Map<string, Set<string>>();
  home.rooms.forEach((room, index) => {
    const level = (room.levelId ? byId.get(room.levelId) : undefined) ?? fallback;
    const points = cleanPolygon(room.points);
    if (points.length < 3) return;
    const taken = takenRoomIds.get(level.source.id) ?? new Set<string>();
    takenRoomIds.set(level.source.id, taken);
    let id = room.name ? slugify(room.name) : `room_${index + 1}`;
    if (!id) id = `room_${index + 1}`;
    if (taken.has(id)) {
      let n = 2;
      while (taken.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    taken.add(id);
    level.rooms.push({ id, source: room, points });
  });

  return resolved;
}

/** Which room of this storey a point sits in, or `structure`. */
function roomAt(level: ResolvedLevel, x: number, z: number): string {
  for (const room of level.rooms) {
    if (polygonContains(room.points, x, z)) return room.id;
  }
  return 'structure';
}

/**
 * Attaches each opening to the wall segment it cuts.
 *
 * Sweet Home 3D stores no link between a door and its wall — the door is simply
 * a piece of furniture that happens to sit in one — so this is a geometric
 * search: nearest segment whose centreline passes under the opening, preferring
 * one whose direction agrees with the opening's own `angle`. The angle is a
 * preference rather than a filter, because a piece placed by hand can be a
 * degree or two off and dropping it would leave a wall inexplicably solid.
 */
function attachOpenings(
  openings: readonly Sh3dOpening[],
  segments: readonly WallSegment[],
): number {
  let unmatched = 0;
  for (const opening of openings) {
    let best: { segment: WallSegment; at: number; distance: number; aligned: boolean } | null = null;

    for (const segment of segments) {
      const dx = segment.to[0] - segment.from[0];
      const dz = segment.to[1] - segment.from[1];
      const length = segment.length;
      const t = ((opening.x - segment.from[0]) * dx + (opening.z - segment.from[1]) * dz) / (length * length);
      if (t < -0.02 || t > 1.02) continue;
      const px = segment.from[0] + dx * t;
      const pz = segment.from[1] + dz * t;
      const distance = Math.hypot(opening.x - px, opening.z - pz);
      if (distance > segment.thickness / 2 + 0.25) continue;

      // Wall direction in Sweet Home 3D's plan; compared modulo π because a
      // wall drawn either way round holds the same door.
      const wallAngle = Math.atan2(dz, dx);
      const aligned = Math.abs(Math.sin(wallAngle - opening.angle)) < 0.35;
      const better =
        !best ||
        (aligned && !best.aligned) ||
        (aligned === best.aligned && distance < best.distance);
      if (better) best = { segment, at: t * length, distance, aligned };
    }

    if (!best) {
      unmatched += 1;
      continue;
    }
    best.segment.openings.push({
      at: best.at,
      width: opening.width,
      sill: opening.elevation,
      height: opening.height,
      window: opening.window,
    });
  }
  return unmatched;
}

/* ----------------------------------------------------------------- entry */

export interface Sh3dBuildResult extends Sh3dHouse {
  /** Diagnostics worth surfacing; not part of the shared model contract. */
  report: {
    levels: number;
    walls: number;
    rooms: number;
    openings: number;
    unmatchedOpenings: number;
    furniture: number;
    /** Pieces whose real geometry is an OBJ inside the archive. */
    furnitureWithModels: number;
  };
}

/** Reads a `.sh3d` archive and builds it. */
export function buildFromSh3d(buffer: ArrayBuffer, options: Sh3dHouseOptions = {}): Sh3dBuildResult {
  const archive = readSh3dArchive(buffer);
  return buildSh3dHome(parseHomeXml(archive.xml), options);
}

export function buildSh3dHome(home: Sh3dHome, options: Sh3dHouseOptions = {}): Sh3dBuildResult {
  const base = createMaterialLibrary({
    anisotropy: options.anisotropy,
    textures: options.textures,
  });
  const extra: THREE.Material[] = [];
  const materials = extendLibrary(base, extra);

  const neutral = new THREE.MeshStandardMaterial({
    name: 'fp3d:sh3d-furniture',
    color: 0xb9b3a8,
    roughness: 0.8,
    metalness: 0,
  });
  extra.push(neutral);
  const byColor = new Map<number, THREE.MeshStandardMaterial>();
  const furnitureMaterial = (color: number | null): THREE.MeshStandardMaterial => {
    if (color === null) return neutral;
    let material = byColor.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        name: `fp3d:sh3d-${color.toString(16).padStart(6, '0')}`,
        color,
        roughness: 0.75,
        metalness: 0,
      });
      byColor.set(color, material);
      extra.push(material);
    }
    return material;
  };

  const builder = new Sh3dBuilder(slugify(home.name ?? 'sweet_home') || 'sweet_home');
  const levels = resolveLevels(home);
  const byId = new Map(levels.map((level) => [level.source.id, level]));
  const fallback = levels[0];
  const levelOf = (id: string | null): ResolvedLevel => (id ? byId.get(id) ?? fallback : fallback);

  let unmatchedOpenings = 0;

  /* ------------------------------------------------------------- storeys */

  for (const level of levels) {
    const id = level.source.id;
    const baseY = level.source.elevation;

    /* walls, glazing, door leaves */
    const walls = home.walls.filter((wall) => levelOf(wall.levelId) === level);
    const openings = home.openings.filter((opening) => levelOf(opening.levelId) === level);

    const segments: WallSegment[] = [];
    for (const wall of walls) segments.push(...wallSegments(wall));
    unmatchedOpenings += attachOpenings(openings, segments);

    const solid: THREE.BufferGeometry[] = [];
    const glass: THREE.BufferGeometry[] = [];
    const leaves: THREE.BufferGeometry[] = [];

    for (const segment of segments) {
      const piece: WallBuild = { solid: [], glass: [], leaves: [] };
      buildSegment(segment, piece);
      const matrix = segmentMatrix(segment.from, segment.to, baseY);
      for (const geometry of piece.solid) geometry.applyMatrix4(matrix);
      for (const geometry of piece.glass) geometry.applyMatrix4(matrix);
      for (const geometry of piece.leaves) geometry.applyMatrix4(matrix);
      solid.push(...piece.solid);
      glass.push(...piece.glass);
      leaves.push(...piece.leaves);
    }

    builder.mesh(id, 'structure', 'walls', solid, materials.wall);
    if (glass.length) {
      builder.mesh(id, 'structure', 'glazing', glass, materials.glass, {
        cast: false,
        receive: false,
        glass: true,
      });
    }
    if (leaves.length) builder.mesh(id, 'structure', 'door_leaf', leaves, materials.wood);

    /* floors and ceilings */
    const ceilingY = baseY + level.height - CEILING_T;
    for (const room of level.rooms) {
      if (room.source.floorVisible) {
        const slab = slabFromPolygon(room.points, baseY, level.source.floorThickness);
        if (slab) {
          builder.mesh(id, room.id, 'floor', [slab], materials.floorWood, {
            cast: false,
            receive: true,
          });
        }
      }
      if (room.source.ceilingVisible) {
        const slab = slabFromPolygon(room.points, ceilingY + CEILING_T, CEILING_T);
        if (slab) {
          builder.mesh(id, room.id, 'ceiling', [slab], materials.ceiling, {
            cast: false,
            receive: true,
          });
        }
      }
    }
  }

  /* ----------------------------------------------------------- furniture */

  let furnitureWithModels = 0;
  for (const piece of home.furniture) {
    if (piece.model) furnitureWithModels += 1;
    const level = levelOf(piece.levelId);
    const geometry = furnitureBox(piece, level.source.elevation);
    if (!geometry) continue;
    const room = roomAt(level, piece.x, piece.z);
    const slug = slugify(piece.name) || 'piece';
    builder.mesh(
      level.source.id,
      room,
      `furniture_${slug}`,
      [geometry],
      furnitureMaterial(piece.color),
      { furniture: true },
    );
  }

  /* -------------------------------------------------------------- finish */

  // Sweet Home 3D plans sit wherever the author drew them — the sample this was
  // written against starts 5 m west of its own origin — so recentre in XZ.
  // Y is left alone: level elevations are meaningful and the card's convention
  // pins the ground floor to y = 0, which is where Sweet Home 3D puts it too.
  builder.root.updateMatrixWorld(true);
  const raw = computeModelBounds(builder.root);
  if (!raw.isEmpty()) {
    builder.root.position.set(-(raw.min.x + raw.max.x) / 2, 0, -(raw.min.z + raw.max.z) / 2);
  }
  builder.root.updateMatrixWorld(true);

  let groundIndex = 0;
  levels.forEach((level, index) => {
    if (Math.abs(level.source.elevation) < Math.abs(levels[groundIndex].source.elevation)) {
      groundIndex = index;
    }
  });

  const definitions: LevelDefinition[] = levels.map((level, index) => ({
    id: level.source.id,
    name: level.source.name,
    elevation: level.source.elevation,
    height: level.height,
    icon: levelIcon(index - groundIndex),
  }));

  return {
    root: builder.root,
    levels: definitions,
    bounds: computeModelBounds(builder.root),
    nodes: builder.nodes,
    materials,
    report: {
      levels: levels.length,
      walls: home.walls.length,
      rooms: home.rooms.length,
      openings: home.openings.length,
      unmatchedOpenings,
      furniture: home.furniture.length,
      furnitureWithModels,
    },
  };
}

/**
 * A box with the piece's exact plan footprint, height and elevation. Sweet Home
 * 3D's `angle` turns clockwise in a plan whose y axis maps to world +Z, which
 * is a negative rotation about three.js's Y.
 */
function furnitureBox(piece: Sh3dFurniture, levelElevation: number): THREE.BufferGeometry | null {
  const w = piece.width;
  const d = piece.depth;
  const h = piece.height;
  if (!(w > EPS && d > EPS && h > EPS)) return null;
  if (![w, d, h, piece.x, piece.z, piece.elevation].every(Number.isFinite)) return null;

  const geometry = new THREE.BoxGeometry(w, h, d);
  const matrix = new THREE.Matrix4()
    .makeTranslation(piece.x, levelElevation + piece.elevation + h / 2, piece.z)
    .multiply(new THREE.Matrix4().makeRotationY(-piece.angle));
  geometry.applyMatrix4(matrix);
  return geometry;
}

function levelIcon(order: number): string {
  if (order < 0) return 'mdi:home-floor-b';
  if (order === 0) return 'mdi:home-floor-g';
  return order <= 3 ? `mdi:home-floor-${order}` : 'mdi:home-floor-a';
}
