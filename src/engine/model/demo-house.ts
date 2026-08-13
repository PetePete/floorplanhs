/**
 * The procedural demo house.
 *
 * This is what a user sees before they have uploaded anything, so it is built
 * to real dimensions rather than as a placeholder: a 12 x 9 m two-storey house
 * over a full basement, 2.6 m clear per storey, 24 cm exterior and 12 cm
 * interior walls, with door and window openings cut into the walls, a pitched
 * roof and stairs that actually connect the three levels.
 *
 * ## Node naming convention  ——  `<level>/<room>/<part>`
 *
 * Every mesh carries a three-segment name and `userData.level`, and this is
 * exactly the convention documented for users authoring their own glTF:
 *
 *   ground/living_room/floor
 *   ground/kitchen/wall_north
 *   upper/bedroom/ceiling
 *   upper/roof/gable_west
 *
 *   segment 1 `level`  storey id — `basement` | `ground` | `upper`, plus the
 *                      pseudo-level `site` for terrain, which is never hidden.
 *   segment 2 `room`   room id in snake_case, plus the pseudo-rooms
 *                      `exterior` (the outer shell), `structure` (stairs,
 *                      slabs shared between rooms) and `roof`.
 *   segment 3 `part`   `floor` | `ceiling` | `wall_<north|south|east|west>` |
 *                      `wall_<id>` for partitions | `glazing` | `stairs` |
 *                      `door_leaf` | a furniture id such as `sofa`.
 *
 * The level system never parses these names — `userData.level` is the source of
 * truth — but `bindNode` in the card config addresses them, and level detection
 * falls back to the prefix when a model has no `userData`.
 *
 * ## Budget
 *
 * ~90 draw calls. Static geometry is merged per named node (a whole wall with
 * all its openings is one mesh, all glazing on a level is one mesh), but
 * anything that has to be individually named, hidden or clipped stays its own
 * mesh.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LevelDefinition } from '@/types/config';
import { computeModelBounds } from '@/engine/model/level-detect';
import { createMaterialLibrary, type MaterialLibrary } from '@/engine/model/materials';

export interface DemoHouse {
  root: THREE.Group;
  levels: LevelDefinition[];
  bounds: THREE.Box3;
  nodes: Map<string, THREE.Object3D>;
  /** Owned by the caller from here on; `dispose()` it with the model. */
  materials: MaterialLibrary;
}

export interface DemoHouseOptions {
  /** Forwarded to the material library; pass the renderer's max anisotropy. */
  anisotropy?: number;
  /** Disable the procedural canvas textures (flat colours only). */
  textures?: boolean;
}

/* --------------------------------------------------------------- geometry */

const T_EXT = 0.24;
const T_INT = 0.12;
const SLAB = 0.3;
const CEIL_T = 0.02;

/** Outer faces of the exterior shell. */
const OUT_X = 6;
const OUT_Z = 4.5;
/** Exterior wall centrelines. */
const CL_X = OUT_X - T_EXT / 2;
const CL_Z = OUT_Z - T_EXT / 2;
/** Inner faces of the exterior shell. */
const IN_X = OUT_X - T_EXT;
const IN_Z = OUT_Z - T_EXT;

/** Finished floor level of each storey. */
const Y_BASEMENT = -2.7;
const Y_GROUND = 0;
const Y_UPPER = 2.9;
/** Underside of the ceiling plane in each storey. */
const CEIL_BASEMENT = -0.33;
const CEIL_GROUND = 2.57;
const CEIL_UPPER = 5.47;
/** Top of the upper exterior wall = springing line of the roof. */
const ROOF_BASE = 5.5;
const ROOF_RIDGE = 7.6;
const EAVE = 0.45;

const GRADE = -0.15;

const WIN_SILL = 0.95;
const WIN_HEIGHT = 1.35;
const DOOR_HEIGHT = 2.05;

/** Wood plank / tile repeat length in metres, for the floor UV scaling. */
const FLOOR_TILE_M = 1.2;

type Vec2 = readonly [number, number];

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

interface Opening {
  /** Distance along the wall from `from` to the centre of the opening. */
  at: number;
  width: number;
  /** Height of the opening's bottom above the wall base. */
  sill: number;
  height: number;
  /** Fill the opening with a glass pane. */
  glass?: boolean;
  /** Add a solid door leaf. */
  leaf?: boolean;
}

interface WallSpec {
  from: Vec2;
  to: Vec2;
  baseY: number;
  height: number;
  thickness: number;
  openings?: Opening[];
}

function boxGeom(
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(cx, cy, cz);
  return geometry;
}

/**
 * Merges a batch into one buffer and disposes the parts. All inputs here are
 * BoxGeometry, so the attribute layouts always agree; the null guard covers
 * three.js bailing out on a mismatch rather than throwing.
 */
function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const merged: THREE.BufferGeometry | null = mergeGeometries(parts, false);
  if (!merged) return parts[0];
  for (const part of parts) part.dispose();
  return merged;
}

/** Scales UVs so a tiling floor texture keeps a constant world-space size. */
function scaleUv(geometry: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geometry.getAttribute('uv');
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}

function applyTransform(parts: THREE.BufferGeometry[], matrix: THREE.Matrix4): void {
  for (const part of parts) part.applyMatrix4(matrix);
}

/* ------------------------------------------------------------------ walls */

interface WallResult {
  solid: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  leaves: THREE.BufferGeometry[];
}

/**
 * A wall with openings, composed from boxes rather than cut with CSG: the wall
 * becomes piers between the openings plus a sill below and a lintel above each
 * one. That keeps the geometry watertight, indexed and dependency-free, and it
 * is what makes the openings read correctly in a cross-section.
 */
function buildWall(spec: WallSpec): WallResult {
  const dx = spec.to[0] - spec.from[0];
  const dz = spec.to[1] - spec.from[1];
  const length = Math.hypot(dx, dz);
  const result: WallResult = { solid: [], glass: [], leaves: [] };
  if (length < 1e-4) return result;

  const t = spec.thickness;
  const h = spec.height;
  const base = spec.baseY;
  const eps = 1e-4;

  // Local frame: +X runs from `from` to `to`, +Z is the wall's thickness.
  const pier = (u0: number, u1: number, y0: number, y1: number) => {
    if (u1 - u0 <= eps || y1 - y0 <= eps) return;
    result.solid.push(boxGeom(u1 - u0, y1 - y0, t, (u0 + u1) / 2, (y0 + y1) / 2, 0));
  };

  const openings = (spec.openings ?? []).slice().sort((a, b) => a.at - b.at);
  let cursor = 0;

  for (const opening of openings) {
    const a = Math.max(0, opening.at - opening.width / 2);
    const b = Math.min(length, opening.at + opening.width / 2);
    if (b <= a) continue;

    pier(cursor, a, base, base + h);
    if (opening.sill > eps) pier(a, b, base, base + opening.sill);
    const top = opening.sill + opening.height;
    if (top < h - eps) pier(a, b, base + top, base + h);
    cursor = Math.max(cursor, b);

    const cy = base + opening.sill + opening.height / 2;
    if (opening.glass) {
      result.glass.push(
        boxGeom(b - a - 0.06, opening.height - 0.06, 0.02, (a + b) / 2, cy, 0),
      );
    }
    if (opening.leaf) {
      result.leaves.push(
        boxGeom(b - a - 0.04, opening.height - 0.03, 0.045, (a + b) / 2, cy, 0),
      );
    }
  }
  pier(cursor, length, base, base + h);

  // Rotation that maps local +X onto the wall direction. Y is untouched, so
  // the absolute heights above stay correct.
  const angle = Math.atan2(-dz, dx);
  const matrix = new THREE.Matrix4()
    .makeTranslation(spec.from[0], 0, spec.from[1])
    .multiply(new THREE.Matrix4().makeRotationY(angle));
  applyTransform(result.solid, matrix);
  applyTransform(result.glass, matrix);
  applyTransform(result.leaves, matrix);
  return result;
}

/* ------------------------------------------------------------------ slabs */

/**
 * A horizontal slab with an optional rectangular hole, split into up to four
 * bands. One hole per slab is all the house needs (the two stairwells) and it
 * keeps the split trivially correct.
 */
function buildSlab(rect: Rect, y0: number, y1: number, hole?: Rect | null): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const push = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 <= 1e-4 || z1 - z0 <= 1e-4) return;
    const geometry = boxGeom(x1 - x0, h, z1 - z0, (x0 + x1) / 2, cy, (z0 + z1) / 2);
    scaleUv(geometry, (x1 - x0) / FLOOR_TILE_M, (z1 - z0) / FLOOR_TILE_M);
    parts.push(geometry);
  };

  if (!hole) {
    push(rect.x0, rect.x1, rect.z0, rect.z1);
    return parts;
  }

  const hx0 = Math.max(rect.x0, hole.x0);
  const hx1 = Math.min(rect.x1, hole.x1);
  const hz0 = Math.max(rect.z0, hole.z0);
  const hz1 = Math.min(rect.z1, hole.z1);
  if (hx1 <= hx0 || hz1 <= hz0) {
    push(rect.x0, rect.x1, rect.z0, rect.z1);
    return parts;
  }

  push(rect.x0, rect.x1, rect.z0, hz0);
  push(rect.x0, rect.x1, hz1, rect.z1);
  push(rect.x0, hx0, hz0, hz1);
  push(hx1, rect.x1, hz0, hz1);
  return parts;
}

/* ----------------------------------------------------------------- stairs */

interface StairSpec {
  /** X of the first riser's leading edge; the flight runs toward `xEnd`. */
  xStart: number;
  xEnd: number;
  z0: number;
  z1: number;
  /** Y at `xStart` and at `xEnd`. */
  yStart: number;
  yEnd: number;
  steps: number;
}

/**
 * Solid stepped blocks rather than floating treads: it is the same draw call
 * either way, and a solid flight is what makes the cut-away view legible.
 */
function buildStairs(spec: StairSpec): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const going = (spec.xEnd - spec.xStart) / spec.steps;
  const rise = (spec.yEnd - spec.yStart) / spec.steps;
  const bottom = Math.min(spec.yStart, spec.yEnd);
  for (let i = 0; i < spec.steps; i++) {
    const xa = spec.xStart + going * i;
    const xb = spec.xStart + going * (i + 1);
    const top = spec.yStart + rise * (i + 1);
    const height = top - bottom;
    if (height <= 1e-3) continue;
    parts.push(
      boxGeom(
        Math.abs(xb - xa),
        height,
        spec.z1 - spec.z0,
        (xa + xb) / 2,
        bottom + height / 2,
        (spec.z0 + spec.z1) / 2,
      ),
    );
  }
  return parts;
}

/* -------------------------------------------------------------- furniture */

type BoxSpec = readonly [w: number, h: number, d: number, cx: number, cy: number, cz: number];

function boxes(specs: readonly BoxSpec[]): THREE.BufferGeometry[] {
  return specs.map((s) => boxGeom(s[0], s[1], s[2], s[3], s[4], s[5]));
}

/** Places locally-authored furniture, rotating about Y before translating. */
function place(
  parts: THREE.BufferGeometry[],
  cx: number,
  cy: number,
  cz: number,
  rotY = 0,
): THREE.BufferGeometry[] {
  const matrix = new THREE.Matrix4()
    .makeTranslation(cx, cy, cz)
    .multiply(new THREE.Matrix4().makeRotationY(rotY));
  applyTransform(parts, matrix);
  return parts;
}

/** Sofa authored facing -Z, seat height 0.42, origin at the footprint centre. */
function sofaParts(): THREE.BufferGeometry[] {
  return boxes([
    [2.2, 0.3, 0.9, 0, 0.15, 0],
    [2.2, 0.18, 0.86, 0, 0.39, 0.02],
    [2.2, 0.52, 0.2, 0, 0.56, 0.35],
    [0.2, 0.32, 0.9, -1.0, 0.46, 0],
    [0.2, 0.32, 0.9, 1.0, 0.46, 0],
  ]);
}

/** Table authored with the top at `height`, centred on its footprint. */
function tableParts(w: number, d: number, height: number): THREE.BufferGeometry[] {
  const leg = 0.08;
  const inset = 0.09;
  const legH = height - 0.05;
  return boxes([
    [w, 0.05, d, 0, height - 0.025, 0],
    [leg, legH, leg, -w / 2 + inset, legH / 2, -d / 2 + inset],
    [leg, legH, leg, w / 2 - inset, legH / 2, -d / 2 + inset],
    [leg, legH, leg, -w / 2 + inset, legH / 2, d / 2 - inset],
    [leg, legH, leg, w / 2 - inset, legH / 2, d / 2 - inset],
  ]);
}

function chairParts(): THREE.BufferGeometry[] {
  return boxes([
    [0.44, 0.05, 0.44, 0, 0.44, 0],
    [0.44, 0.5, 0.06, 0, 0.71, -0.19],
    [0.05, 0.44, 0.05, -0.18, 0.22, -0.18],
    [0.05, 0.44, 0.05, 0.18, 0.22, -0.18],
    [0.05, 0.44, 0.05, -0.18, 0.22, 0.18],
    [0.05, 0.44, 0.05, 0.18, 0.22, 0.18],
  ]);
}

/** Bed frame (wood) and mattress + pillows (fabric) are separate materials. */
function bedFrameParts(w: number, d: number): THREE.BufferGeometry[] {
  return boxes([
    [w, 0.3, d, 0, 0.15, 0],
    [w + 0.1, 0.55, 0.08, 0, 0.42, -d / 2 - 0.04],
  ]);
}

function bedSoftParts(w: number, d: number): THREE.BufferGeometry[] {
  const parts = boxes([[w - 0.08, 0.24, d - 0.08, 0, 0.42, 0]]);
  const pillowW = Math.min(0.66, (w - 0.24) / 2);
  parts.push(
    boxGeom(pillowW, 0.12, 0.36, -(pillowW / 2 + 0.03), 0.6, -d / 2 + 0.28),
    boxGeom(pillowW, 0.12, 0.36, pillowW / 2 + 0.03, 0.6, -d / 2 + 0.28),
  );
  return parts;
}

function shelfParts(w: number, h: number, d: number): THREE.BufferGeometry[] {
  const parts = boxes([
    [0.04, h, d, -w / 2, h / 2, 0],
    [0.04, h, d, w / 2, h / 2, 0],
    [w, 0.04, 0.04, 0, h - 0.02, -d / 2],
  ]);
  const shelves = Math.max(2, Math.round(h / 0.42));
  for (let i = 0; i <= shelves; i++) {
    parts.push(boxGeom(w, 0.035, d, 0, (h / shelves) * i, 0));
  }
  return parts;
}

/* ---------------------------------------------------------------- builder */

interface MeshOptions {
  cast?: boolean;
  receive?: boolean;
  glass?: boolean;
  alwaysVisible?: boolean;
}

class HouseBuilder {
  readonly root = new THREE.Group();
  readonly nodes = new Map<string, THREE.Object3D>();
  private readonly levelGroups = new Map<string, THREE.Group>();
  private readonly roomGroups = new Map<string, THREE.Group>();

  constructor(private readonly mat: MaterialLibrary) {
    this.root.name = 'demo_house';
  }

  private level(id: string): THREE.Group {
    let group = this.levelGroups.get(id);
    if (!group) {
      group = new THREE.Group();
      group.name = id;
      group.userData.level = id;
      if (id === 'site') group.userData.alwaysVisible = true;
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
      if (levelId === 'site') group.userData.alwaysVisible = true;
      this.level(levelId).add(group);
      this.roomGroups.set(key, group);
      this.nodes.set(key, group);
    }
    return group;
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
    mesh.name = `${levelId}/${roomId}/${part}`;
    mesh.userData.level = levelId;
    mesh.userData.room = roomId;
    mesh.userData.part = part;
    // Tells the model manager not to second-guess the flags set here.
    mesh.userData.shadowsConfigured = true;
    if (options.glass) mesh.userData.glass = true;
    if (options.alwaysVisible || levelId === 'site') mesh.userData.alwaysVisible = true;
    mesh.castShadow = options.cast ?? true;
    mesh.receiveShadow = options.receive ?? true;

    this.room(levelId, roomId).add(mesh);
    this.nodes.set(mesh.name, mesh);
    return mesh;
  }

  /** Convenience wrappers so the storey code below stays readable. */
  floor(levelId: string, roomId: string, rect: Rect, y: number, wet: boolean, hole?: Rect | null) {
    this.mesh(
      levelId,
      roomId,
      'floor',
      buildSlab(rect, y - SLAB, y, hole),
      wet ? this.mat.floorTile : this.mat.floorWood,
      { cast: false, receive: true },
    );
  }

  ceiling(levelId: string, roomId: string, rect: Rect, y: number, hole?: Rect | null) {
    this.mesh(levelId, roomId, 'ceiling', buildSlab(rect, y, y + CEIL_T, hole), this.mat.ceiling, {
      cast: false,
      receive: true,
    });
  }
}

/* ------------------------------------------------------------------ rooms */

const GROUND_ROOMS: ReadonlyArray<{ id: string; rect: Rect; wet: boolean }> = [
  { id: 'living_room', rect: { x0: -IN_X, x1: 0.54, z0: -IN_Z, z1: -0.46 }, wet: false },
  { id: 'kitchen', rect: { x0: 0.66, x1: IN_X, z0: -IN_Z, z1: -0.46 }, wet: true },
  { id: 'dining', rect: { x0: -IN_X, x1: -2.46, z0: -0.34, z1: IN_Z }, wet: false },
  { id: 'hall', rect: { x0: -2.34, x1: 1.14, z0: -0.34, z1: IN_Z }, wet: true },
  { id: 'study', rect: { x0: 1.26, x1: IN_X, z0: -0.34, z1: 1.94 }, wet: false },
  { id: 'bathroom', rect: { x0: 1.26, x1: IN_X, z0: 2.06, z1: IN_Z }, wet: true },
];

const UPPER_ROOMS: ReadonlyArray<{ id: string; rect: Rect; wet: boolean }> = [
  { id: 'bedroom', rect: { x0: -IN_X, x1: 0.54, z0: -IN_Z, z1: -0.46 }, wet: false },
  { id: 'childrens_room', rect: { x0: 0.66, x1: IN_X, z0: -IN_Z, z1: -0.46 }, wet: false },
  { id: 'bathroom', rect: { x0: -IN_X, x1: -2.46, z0: -0.34, z1: IN_Z }, wet: true },
  { id: 'landing', rect: { x0: -2.34, x1: 2.34, z0: -0.34, z1: IN_Z }, wet: false },
  { id: 'office', rect: { x0: 2.46, x1: IN_X, z0: -0.34, z1: IN_Z }, wet: false },
];

const BASEMENT_ROOMS: ReadonlyArray<{ id: string; rect: Rect; wet: boolean }> = [
  { id: 'utility', rect: { x0: -IN_X, x1: 1.14, z0: -IN_Z, z1: IN_Z }, wet: true },
  { id: 'storage', rect: { x0: 1.26, x1: IN_X, z0: -IN_Z, z1: IN_Z }, wet: true },
];

/** Stairwell openings, shared by the slab above and the flight below. */
const HOLE_BASEMENT: Rect = { x0: -1.7, x1: 1.05, z0: 0.5, z1: 1.9 };
const HOLE_UPPER: Rect = { x0: -1.5, x1: 1.05, z0: 2.5, z1: 3.9 };

/* ------------------------------------------------------------------- main */

export function buildDemoHouse(options: DemoHouseOptions = {}): DemoHouse {
  const mat = createMaterialLibrary({
    anisotropy: options.anisotropy,
    textures: options.textures,
  });
  const b = new HouseBuilder(mat);

  buildLevelShell(b, mat, 'basement', Y_BASEMENT, -3.0, 2.7);
  buildLevelShell(b, mat, 'ground', Y_GROUND, -0.3, 2.9);
  buildLevelShell(b, mat, 'upper', Y_UPPER, 2.6, 2.9);

  buildBasement(b, mat);
  buildGround(b, mat);
  buildUpper(b, mat);
  buildRoof(b, mat);
  buildSite(b, mat);
  buildStairwells(b, mat);

  b.root.updateMatrixWorld(true);
  const bounds = computeModelBounds(b.root);

  const levels: LevelDefinition[] = [
    {
      id: 'basement',
      name: 'Basement',
      elevation: Y_BASEMENT,
      height: 2.7,
      icon: 'mdi:home-floor-b',
    },
    { id: 'ground', name: 'Ground floor', elevation: Y_GROUND, height: 2.9, icon: 'mdi:home-floor-g' },
    { id: 'upper', name: 'Upper floor', elevation: Y_UPPER, height: 2.9, icon: 'mdi:home-floor-1' },
  ];

  return { root: b.root, levels, bounds, nodes: b.nodes, materials: mat };
}

/* ------------------------------------------------------- exterior + rooms */

interface ExteriorOpenings {
  south: Opening[];
  north: Opening[];
  east: Opening[];
  west: Opening[];
}

/**
 * `u` runs from the wall's start point:
 *   south  from (-6, -4.38) to (6, -4.38)   u = x + 6
 *   north  from ( 6,  4.38) to (-6, 4.38)   u = 6 - x
 *   east   from ( 5.88, -4.38) to (5.88, 4.38)  u = z + 4.38
 *   west   from (-5.88,  4.38) to (-5.88, -4.38)  u = 4.38 - z
 * The south/north walls run the full 12 m so they close the corners over the
 * east/west walls, which stop at the centrelines.
 */
function exteriorOpenings(levelId: string, wallBase: number, floorY: number): ExteriorOpenings {
  const sill = floorY + WIN_SILL - wallBase;
  const doorSill = floorY - wallBase;
  const win = (at: number, width: number, height = WIN_HEIGHT): Opening => ({
    at,
    width,
    sill,
    height,
    glass: true,
  });

  if (levelId === 'basement') {
    // Light wells: small, high, just under the ground slab.
    const low = (at: number): Opening => ({
      at,
      width: 0.8,
      sill: floorY + 1.7 - wallBase,
      height: 0.5,
      glass: true,
    });
    return { south: [low(3.0), low(9.0)], north: [], east: [low(6.38)], west: [low(6.38)] };
  }

  if (levelId === 'upper') {
    return {
      south: [win(1.7, 1.5), win(4.6, 1.5), win(8.2, 1.5), win(10.6, 1.2)],
      north: [win(1.9, 1.4), win(6.0, 1.4), win(10.1, 0.8)],
      east: [win(1.98, 1.3), win(6.28, 1.4)],
      west: [win(2.38, 0.8), win(6.78, 1.5)],
    };
  }

  return {
    south: [
      win(1.4, 1.7),
      // Terrace door: floor-to-head glazing onto the south terrace.
      { at: 4.4, width: 2.0, sill: doorSill, height: 2.25, glass: true },
      win(8.0, 1.6),
      win(10.6, 1.2),
    ],
    north: [
      win(2.4, 0.8),
      // Front door, on the north wall at x = 0 — where the demo config's
      // `binary_sensor.front_door` marker sits.
      { at: 6.0, width: 1.2, sill: doorSill, height: 2.15, leaf: true },
      win(7.5, 1.0),
      win(10.1, 1.5),
    ],
    east: [win(1.98, 1.5), win(5.18, 1.4), win(7.58, 0.7)],
    // The living-room window sits south of the TV wall so the two do not clash.
    west: [win(1.98, 1.5), win(7.78, 1.6)],
  };
}

function buildLevelShell(
  b: HouseBuilder,
  mat: MaterialLibrary,
  levelId: string,
  floorY: number,
  wallBase: number,
  wallHeight: number,
): void {
  const openings = exteriorOpenings(levelId, wallBase, floorY);
  const glass: THREE.BufferGeometry[] = [];
  const leaves: THREE.BufferGeometry[] = [];

  const walls: ReadonlyArray<{ part: string; from: Vec2; to: Vec2; openings: Opening[] }> = [
    { part: 'wall_south', from: [-OUT_X, -CL_Z], to: [OUT_X, -CL_Z], openings: openings.south },
    { part: 'wall_north', from: [OUT_X, CL_Z], to: [-OUT_X, CL_Z], openings: openings.north },
    { part: 'wall_east', from: [CL_X, -CL_Z], to: [CL_X, CL_Z], openings: openings.east },
    { part: 'wall_west', from: [-CL_X, CL_Z], to: [-CL_X, -CL_Z], openings: openings.west },
  ];

  for (const wall of walls) {
    const built = buildWall({
      from: wall.from,
      to: wall.to,
      baseY: wallBase,
      height: wallHeight,
      thickness: T_EXT,
      openings: wall.openings,
    });
    b.mesh(levelId, 'exterior', wall.part, built.solid, mat.wall);
    glass.push(...built.glass);
    leaves.push(...built.leaves);
  }

  if (glass.length) {
    b.mesh(levelId, 'exterior', 'glazing', glass, mat.glass, {
      cast: false,
      receive: false,
      glass: true,
    });
  }
  if (leaves.length) {
    b.mesh(levelId, 'exterior', 'door_leaf', leaves, mat.wood);
  }
}

/* -------------------------------------------------------------- basement */

function buildBasement(b: HouseBuilder, mat: MaterialLibrary): void {
  const level = 'basement';
  for (const room of BASEMENT_ROOMS) {
    const hole = room.id === 'utility' ? HOLE_BASEMENT : null;
    b.floor(level, room.id, room.rect, Y_BASEMENT, true, null);
    b.ceiling(level, room.id, room.rect, CEIL_BASEMENT, hole);
  }

  const partition = buildWall({
    from: [1.2, -CL_Z],
    to: [1.2, CL_Z],
    baseY: Y_BASEMENT,
    height: CEIL_BASEMENT - Y_BASEMENT,
    thickness: T_INT,
    openings: [{ at: 5.38, width: 0.9, sill: 0, height: DOOR_HEIGHT }],
  });
  b.mesh(level, 'utility', 'wall_partition', partition.solid, mat.wall);

  // Plant: boiler, washing machine and shelving read as a utility room even at
  // this level of abstraction.
  const boiler = new THREE.CylinderGeometry(0.34, 0.34, 1.7, 20);
  boiler.translate(-5.0, Y_BASEMENT + 0.85, -3.4);
  b.mesh(level, 'utility', 'boiler', [boiler], mat.metal);
  b.mesh(
    level,
    'utility',
    'appliances',
    boxes([
      [0.62, 0.85, 0.62, -5.3, Y_BASEMENT + 0.425, -1.9],
      [0.62, 0.85, 0.62, -4.6, Y_BASEMENT + 0.425, -1.9],
    ]),
    mat.metal,
  );
  b.mesh(
    level,
    'utility',
    'shelving',
    place(shelfParts(1.6, 1.9, 0.4), -5.3, Y_BASEMENT, 1.6, Math.PI / 2),
    mat.wood,
  );
  b.mesh(
    level,
    'storage',
    'shelving',
    [
      ...place(shelfParts(2.0, 2.0, 0.45), 5.3, Y_BASEMENT, -2.0, Math.PI / 2),
      ...place(shelfParts(2.0, 2.0, 0.45), 5.3, Y_BASEMENT, 2.0, Math.PI / 2),
    ],
    mat.wood,
  );
  b.mesh(
    level,
    'storage',
    'crates',
    boxes([
      [0.7, 0.5, 0.5, 2.2, Y_BASEMENT + 0.25, 3.4],
      [0.6, 0.45, 0.5, 3.0, Y_BASEMENT + 0.225, 3.5],
      [0.7, 0.5, 0.5, 2.3, Y_BASEMENT + 0.75, 3.4],
    ]),
    mat.wood,
  );
}

/* ---------------------------------------------------------------- ground */

function buildGround(b: HouseBuilder, mat: MaterialLibrary): void {
  const level = 'ground';
  for (const room of GROUND_ROOMS) {
    const hole = room.id === 'hall' ? HOLE_BASEMENT : null;
    b.floor(level, room.id, room.rect, Y_GROUND, room.wet, hole);
    b.ceiling(level, room.id, room.rect, CEIL_GROUND, room.id === 'hall' ? HOLE_UPPER : null);
  }

  const wallH = CEIL_GROUND - Y_GROUND;
  const door = (at: number, width = 0.95): Opening => ({
    at,
    width,
    sill: 0,
    height: DOOR_HEIGHT,
  });

  const partitions: ReadonlyArray<{
    room: string;
    part: string;
    from: Vec2;
    to: Vec2;
    openings: Opening[];
  }> = [
    {
      room: 'hall',
      part: 'wall_spine',
      from: [-CL_X, -0.4],
      to: [CL_X, -0.4],
      openings: [door(1.88), door(4.88), door(8.88, 0.9)],
    },
    {
      room: 'kitchen',
      part: 'wall_west',
      from: [0.6, -CL_Z],
      to: [0.6, -0.4],
      // Wide cased opening between living room and kitchen.
      openings: [{ at: 1.98, width: 1.6, sill: 0, height: 2.2 }],
    },
    {
      room: 'dining',
      part: 'wall_east',
      from: [-2.4, -0.4],
      to: [-2.4, CL_Z],
      openings: [door(1.0)],
    },
    {
      room: 'study',
      part: 'wall_west',
      from: [1.2, -0.4],
      to: [1.2, CL_Z],
      openings: [door(1.2, 0.9)],
    },
    {
      room: 'bathroom',
      part: 'wall_south',
      from: [1.2, 2.0],
      to: [CL_X, 2.0],
      openings: [door(1.0, 0.8)],
    },
  ];

  for (const p of partitions) {
    const built = buildWall({
      from: p.from,
      to: p.to,
      baseY: Y_GROUND,
      height: wallH,
      thickness: T_INT,
      openings: p.openings,
    });
    b.mesh(level, p.room, p.part, built.solid, mat.wall);
  }

  /* living room — sofa faces the TV wall on the west side */
  b.mesh(level, 'living_room', 'sofa', place(sofaParts(), -2.9, 0, -1.6, Math.PI / 2), mat.fabric);
  b.mesh(
    level,
    'living_room',
    'coffee_table',
    place(tableParts(1.1, 0.6, 0.42), -4.1, 0, -1.6, Math.PI / 2),
    mat.wood,
  );
  b.mesh(
    level,
    'living_room',
    'tv_unit',
    boxes([[0.45, 0.45, 1.8, -5.5, 0.225, -1.4]]),
    mat.wood,
  );
  b.mesh(
    level,
    'living_room',
    'tv',
    boxes([[0.06, 0.72, 1.28, -5.6, 1.15, -1.4]]),
    mat.metal,
  );

  /* kitchen — run along the east wall plus an island under the spot light */
  b.mesh(
    level,
    'kitchen',
    'counter',
    boxes([
      [0.6, 0.86, 3.0, 5.46, 0.43, -2.7],
      // Wall units stop short of the east window rather than covering it.
      [0.35, 0.6, 0.95, 5.58, 1.8, -3.72],
    ]),
    mat.wood,
  );
  b.mesh(
    level,
    'kitchen',
    'counter_top',
    boxes([[0.64, 0.04, 3.04, 5.46, 0.88, -2.7]]),
    mat.metal,
  );
  b.mesh(level, 'kitchen', 'island', boxes([[1.8, 0.86, 0.9, 3.4, 0.43, -2.6]]), mat.wood);
  b.mesh(
    level,
    'kitchen',
    'island_top',
    boxes([[1.9, 0.04, 1.0, 3.4, 0.88, -2.6]]),
    mat.metal,
  );

  /* dining */
  b.mesh(level, 'dining', 'table', place(tableParts(1.7, 0.95, 0.75), -4.1, 0, 1.6), mat.wood);
  b.mesh(
    level,
    'dining',
    'chairs',
    [
      ...place(chairParts(), -4.75, 0, 0.85),
      ...place(chairParts(), -3.45, 0, 0.85),
      ...place(chairParts(), -4.75, 0, 2.35, Math.PI),
      ...place(chairParts(), -3.45, 0, 2.35, Math.PI),
    ],
    mat.wood,
  );

  /* study */
  b.mesh(level, 'study', 'desk', place(tableParts(1.6, 0.7, 0.74), 3.6, 0, 1.4), mat.wood);
  b.mesh(level, 'study', 'chair', place(chairParts(), 3.6, 0, 0.6, Math.PI), mat.wood);
  b.mesh(level, 'study', 'shelving', place(shelfParts(1.4, 1.8, 0.32), 5.55, 0, 0.4, Math.PI / 2), mat.wood);

  /* bathroom — sanitary ware borrows the plaster material as white ceramic */
  b.mesh(
    level,
    'bathroom',
    'sanitary',
    boxes([
      [1.7, 0.56, 0.78, 2.25, 0.28, 3.85],
      [0.6, 0.18, 0.45, 5.4, 0.88, 2.6],
      [0.42, 0.44, 0.62, 5.4, 0.22, 3.6],
    ]),
    mat.ceiling,
  );
}

/* ----------------------------------------------------------------- upper */

function buildUpper(b: HouseBuilder, mat: MaterialLibrary): void {
  const level = 'upper';
  for (const room of UPPER_ROOMS) {
    const hole = room.id === 'landing' ? HOLE_UPPER : null;
    b.floor(level, room.id, room.rect, Y_UPPER, room.wet, hole);
    b.ceiling(level, room.id, room.rect, CEIL_UPPER, null);
  }

  const wallH = CEIL_UPPER - Y_UPPER;
  const door = (at: number, width = 0.9): Opening => ({ at, width, sill: 0, height: DOOR_HEIGHT });

  const partitions: ReadonlyArray<{
    room: string;
    part: string;
    from: Vec2;
    to: Vec2;
    openings: Opening[];
  }> = [
    {
      room: 'landing',
      part: 'wall_spine',
      from: [-CL_X, -0.4],
      to: [CL_X, -0.4],
      openings: [door(5.28), door(7.38)],
    },
    { room: 'childrens_room', part: 'wall_west', from: [0.6, -CL_Z], to: [0.6, -0.4], openings: [] },
    {
      room: 'bathroom',
      part: 'wall_east',
      from: [-2.4, -0.4],
      to: [-2.4, CL_Z],
      openings: [door(1.4, 0.8)],
    },
    {
      room: 'office',
      part: 'wall_west',
      from: [2.4, -0.4],
      to: [2.4, CL_Z],
      openings: [door(1.4, 0.85)],
    },
  ];

  for (const p of partitions) {
    const built = buildWall({
      from: p.from,
      to: p.to,
      baseY: Y_UPPER,
      height: wallH,
      thickness: T_INT,
      openings: p.openings,
    });
    b.mesh(level, p.room, p.part, built.solid, mat.wall);
  }

  /* master bedroom */
  b.mesh(level, 'bedroom', 'bed_frame', place(bedFrameParts(1.8, 2.0), -3.0, Y_UPPER, -3.1), mat.wood);
  b.mesh(
    level,
    'bedroom',
    'bed',
    place(bedSoftParts(1.8, 2.0), -3.0, Y_UPPER, -3.1),
    mat.fabric,
  );
  b.mesh(
    level,
    'bedroom',
    'nightstands',
    boxes([
      [0.45, 0.45, 0.4, -4.15, Y_UPPER + 0.225, -3.9],
      [0.45, 0.45, 0.4, -1.85, Y_UPPER + 0.225, -3.9],
    ]),
    mat.wood,
  );
  b.mesh(
    level,
    'bedroom',
    'wardrobe',
    boxes([[2.0, 2.1, 0.6, -1.2, Y_UPPER + 1.05, -0.82]]),
    mat.wood,
  );

  /* children's room */
  b.mesh(
    level,
    'childrens_room',
    'bed_frame',
    place(bedFrameParts(0.95, 2.0), 1.45, Y_UPPER, -3.1),
    mat.wood,
  );
  b.mesh(
    level,
    'childrens_room',
    'bed',
    place(bedSoftParts(0.95, 2.0), 1.45, Y_UPPER, -3.1),
    mat.fabric,
  );
  b.mesh(
    level,
    'childrens_room',
    'desk',
    place(tableParts(1.3, 0.6, 0.72), 4.6, Y_UPPER, -3.7),
    mat.wood,
  );
  b.mesh(level, 'childrens_room', 'chair', place(chairParts(), 4.6, Y_UPPER, -2.9, Math.PI), mat.wood);

  /* office — the demo config puts `light.office_desk` right above this desk */
  b.mesh(level, 'office', 'desk', place(tableParts(1.6, 0.7, 0.74), 3.9, Y_UPPER, 1.8), mat.wood);
  b.mesh(level, 'office', 'chair', place(chairParts(), 3.9, Y_UPPER, 2.6, Math.PI), mat.wood);
  b.mesh(
    level,
    'office',
    'shelving',
    place(shelfParts(1.6, 1.9, 0.34), 5.55, Y_UPPER, 3.2, Math.PI / 2),
    mat.wood,
  );

  /* bathroom */
  b.mesh(
    level,
    'bathroom',
    'sanitary',
    boxes([
      [1.0, 0.06, 1.0, -5.2, Y_UPPER + 0.03, 3.6],
      [0.9, 0.16, 0.5, -5.3, Y_UPPER + 0.88, 1.2],
      [0.42, 0.44, 0.62, -3.0, Y_UPPER + 0.22, 3.8],
    ]),
    mat.ceiling,
  );
  b.mesh(
    level,
    'bathroom',
    'shower_screen',
    boxes([[0.03, 1.9, 1.0, -4.7, Y_UPPER + 0.95, 3.6]]),
    mat.glass,
    { cast: false, receive: false, glass: true },
  );
}

/* ------------------------------------------------------------------ roof */

function buildRoof(b: HouseBuilder, mat: MaterialLibrary): void {
  const halfSpan = OUT_Z + EAVE;
  const rise = ROOF_RIDGE - ROOF_BASE;
  const slope = Math.hypot(halfSpan, rise);
  const pitch = Math.atan2(rise, halfSpan);
  const length = OUT_X * 2 + EAVE * 2;

  for (const side of [1, -1] as const) {
    const geometry = new THREE.BoxGeometry(length, 0.2, slope);
    // Sign matters: rotateX(+pitch) sends the slab's local +Z to
    // (0, -sin p, cos p), so the panel falls as it runs outward and its ends
    // land on (z = 0, ROOF_RIDGE) and (z = side*halfSpan, ROOF_BASE).
    // Negating it lifts the eaves above the ridge and builds a butterfly roof.
    geometry.rotateX(side * pitch);
    geometry.translate(0, (ROOF_BASE + ROOF_RIDGE) / 2, (side * halfSpan) / 2);
    b.mesh('upper', 'roof', side > 0 ? 'pitch_north' : 'pitch_south', [geometry], mat.roof, {
      cast: true,
      receive: true,
    });
  }

  // Gable ends. Extruded rather than boxed so the triangle is exact; they are
  // separate meshes because they are also the only part of the shell a user is
  // likely to want to bind an entity to (attic hatch, weather station).
  const shape = new THREE.Shape();
  shape.moveTo(-OUT_Z, ROOF_BASE);
  shape.lineTo(OUT_Z, ROOF_BASE);
  shape.lineTo(0, ROOF_RIDGE);
  shape.closePath();

  for (const side of [1, -1] as const) {
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: T_EXT, bevelEnabled: false });
    geometry.rotateY(Math.PI / 2);
    // The extrusion runs along +X after the rotation, so the offset has to put
    // the *near* face on the wall centreline for both ends.
    geometry.translate(side * CL_X - T_EXT / 2, 0, 0);
    b.mesh('upper', 'roof', side > 0 ? 'gable_east' : 'gable_west', [geometry], mat.wall);
  }

  b.mesh(
    'upper',
    'roof',
    'chimney',
    boxes([[0.62, 3.2, 0.62, 3.0, 6.6, -1.2]]),
    mat.wall,
  );
}

/* ------------------------------------------------------------------ site */

function buildSite(b: HouseBuilder, mat: MaterialLibrary): void {
  // No ground plane. A 60 m lawn turns the card into a picture of a garden;
  // a floorplan should read as a building, the way a CAD model sits on nothing.
  // The paving below stays because it keeps the entrance and the terrace door
  // legible without implying a landscape.
  const terrace = boxGeom(4.6, 0.12, 3.0, -1.6, GRADE + 0.01, -6.1);
  scaleUv(terrace, 4.6 / FLOOR_TILE_M, 3.0 / FLOOR_TILE_M);
  b.mesh('site', 'exterior', 'terrace', [terrace], mat.floorTile, {
    cast: false,
    receive: true,
    alwaysVisible: true,
  });

  b.mesh(
    'site',
    'exterior',
    'entry_step',
    boxes([[1.6, 0.14, 0.9, 0, GRADE + 0.02, 4.9]]),
    mat.floorTile,
    { alwaysVisible: true },
  );
}

/* -------------------------------------------------------------- stairways */

function buildStairwells(b: HouseBuilder, mat: MaterialLibrary): void {
  // Both flights run along X inside the hall so the north wall stays free for
  // the front door. Basement flight descends westward, upper flight ascends
  // eastward, which puts the arrival point next to the landing.
  b.mesh(
    'basement',
    'utility',
    'stairs',
    buildStairs({
      xStart: 1.05,
      xEnd: -2.25,
      z0: 0.6,
      z1: 1.8,
      yStart: Y_GROUND,
      yEnd: Y_BASEMENT,
      steps: 15,
    }),
    mat.wall,
  );

  b.mesh(
    'ground',
    'hall',
    'stairs',
    buildStairs({
      xStart: -2.25,
      xEnd: 1.05,
      z0: 2.6,
      z1: 3.8,
      yStart: Y_GROUND,
      yEnd: Y_UPPER,
      steps: 16,
    }),
    mat.wood,
  );
}
