/**
 * Builds a house from a `PlanSpec`.
 *
 * The output is deliberately the same shape as `buildDemoHouse` — same node
 * naming (`<level>/<room>/<part>`), same `userData` stamps, same material
 * library ownership — so `ModelManager` cannot tell the two apart. What differs
 * is where the numbers come from: the demo house hard-codes them, this one
 * reads them off a JSON document a user wrote from a drawing.
 *
 * ## How a plan becomes geometry
 *
 * 1. **Validate.** User-authored data, so every failure names its path
 *    (`levels[1].rooms[3].rect`) and says what was expected.
 * 2. **Exterior shell.** The outline polygon is inset by half a wall thickness
 *    to get centrelines; each edge becomes a wall, extended half a thickness at
 *    both ends so the corners close.
 * 3. **Partitions.** Every room-rectangle edge that is not on an exterior wall
 *    is swept against the other rectangles. Where it faces another room a wall
 *    is placed in the gap; where it faces nothing a wall is placed just outside
 *    it; where it faces the *same* room, or a room it is declared open to,
 *    nothing is built. All the resulting bands are grouped by centreline and
 *    unioned, so a wall shared by four rooms is built exactly once.
 * 4. **Openings** are matched to walls and cut by splitting the wall into piers,
 *    sills and lintels — no CSG, the same technique as the demo house, which is
 *    what keeps the reveals readable in a cross-section.
 * 5. **Slabs, roof, site.**
 *
 * ## Budget
 *
 * Roughly `4 + 2 * rooms` meshes per storey: one merged mesh per exterior
 * facade, one for all partitions, one for all glazing, plus a floor and a
 * ceiling per room so each stays individually addressable by `bindNode`.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LevelDefinition } from '@/types/config';
import { computeModelBounds } from '@/engine/model/level-detect';
import { createMaterialLibrary, type MaterialLibrary } from '@/engine/model/materials';
import type { DemoHouse, DemoHouseOptions } from '@/engine/model/demo-house';
import type {
  PlanFloorFinish,
  PlanOpening,
  PlanOpeningKind,
  PlanOpeningShape,
  PlanPoint,
  PlanRoof,
  PlanSide,
  PlanSite,
  PlanSpec,
  PlanStairs,
  PlanWall,
  PlanWallRef,
} from '@/engine/model/plan-types';

/** Same contract as the demo house, so the model manager can treat them alike. */
export type PlanHouse = DemoHouse;
export type PlanHouseOptions = DemoHouseOptions;

/** Thrown for anything a user can fix by editing their plan. */
export class PlanError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'PlanError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new PlanError(path, message);
}

/* ------------------------------------------------------------- constants */

const DEFAULT_EXTERIOR = 0.33;
const DEFAULT_INTERIOR = 0.15;
const DEFAULT_SLAB = 0.3;
const DEFAULT_CEILING = 0.02;
const DEFAULT_ROOF_THICKNESS = 0.24;
const DEFAULT_OVERHANG = 0.3;

/** Finished floor build-up drawn on top of the structural slab. */
const FINISH = 0.02;
/** Wood plank / tile repeat length in metres, for floor UV scaling. */
const FLOOR_TILE_M = 1.2;
/** Geometry below this size is a rounding artefact, not a thing to draw. */
const EPS = 1e-4;
/** How far past a room edge the sweep still counts another room as "opposite". */
const GAP_SLACK = 0.06;

type Vec2 = readonly [number, number];

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/* -------------------------------------------------------- validated plan */

interface NRoom {
  id: string;
  name: string;
  rects: Rect[];
  floor: PlanFloorFinish;
  openTo: Set<string>;
  ceiling: boolean;
}

interface NLevel {
  id: string;
  name: string;
  icon?: string;
  elevation: number;
  height: number;
  clearHeight: number;
  outline: PlanPoint[];
  rooms: NRoom[];
  walls: PlanWall[];
  openings: PlanOpening[];
  stairs: PlanStairs[];
  ceiling: boolean;
}

interface NPlan {
  name: string;
  tExt: number;
  tInt: number;
  slab: number;
  ceilT: number;
  recentre: boolean;
  levels: NLevel[];
  roof: PlanRoof | null;
  site: PlanSite[];
}

/* ------------------------------------------------------------ validation */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, path: string, what: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    return fail(path, `${what} must be a number (got ${JSON.stringify(value)})`);
  }
  return n;
}

function optNum(value: unknown, path: string, what: string, fallback: number): number {
  return value === undefined || value === null ? fallback : num(value, path, what);
}

function positive(value: number, path: string, what: string): number {
  if (!(value > 0)) return fail(path, `${what} must be greater than 0 (got ${value})`);
  return value;
}

function readPoint(value: unknown, path: string): PlanPoint {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, 'must be a [x, z] pair of numbers');
  }
  return [num(value[0], path, 'x'), num(value[1], path, 'z')];
}

function readRect(value: unknown, path: string): Rect {
  if (!Array.isArray(value) || value.length !== 4) {
    return fail(path, 'must be [x1, z1, x2, z2] — four numbers in metres');
  }
  const a = num(value[0], path, 'x1');
  const b = num(value[1], path, 'z1');
  const c = num(value[2], path, 'x2');
  const d = num(value[3], path, 'z2');
  const rect = { x0: Math.min(a, c), x1: Math.max(a, c), z0: Math.min(b, d), z1: Math.max(b, d) };
  if (rect.x1 - rect.x0 < 0.05 || rect.z1 - rect.z0 < 0.05) {
    return fail(path, `is degenerate — ${(rect.x1 - rect.x0).toFixed(2)} x ${(rect.z1 - rect.z0).toFixed(2)} m`);
  }
  return rect;
}

const FINISHES: readonly PlanFloorFinish[] = ['wood', 'tile', 'concrete'];
const KINDS: readonly PlanOpeningKind[] = ['window', 'door', 'sliding'];
const SIDES: readonly PlanSide[] = ['n', 'e', 's', 'w'];

function readOpeningShape(raw: unknown, path: string): PlanOpeningShape {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with "kind" and "width"');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as PlanOpeningKind)) {
    return fail(path, `"kind" must be one of ${KINDS.map((k) => `"${k}"`).join(', ')}`);
  }
  const shape: PlanOpeningShape = {
    kind: kind as PlanOpeningKind,
    width: positive(num(raw.width, path, '"width"'), path, '"width"'),
  };
  if (raw.at !== undefined && raw.at !== null) shape.at = num(raw.at, path, '"at"');
  if (raw.sill !== undefined && raw.sill !== null) shape.sill = num(raw.sill, path, '"sill"');
  if (raw.height !== undefined && raw.height !== null) {
    shape.height = positive(num(raw.height, path, '"height"'), path, '"height"');
  }
  if (raw.glazed !== undefined) shape.glazed = raw.glazed === true;
  return shape;
}

function readWallRef(raw: unknown, path: string): PlanWallRef {
  if (typeof raw === 'string') {
    const side = raw.toLowerCase();
    if (!SIDES.includes(side as PlanSide)) {
      return fail(path, `"wall" must be "n", "e", "s", "w", {from,to} or {between:[roomA,roomB]}`);
    }
    return side as PlanSide;
  }
  if (isRecord(raw)) {
    if (Array.isArray(raw.between)) {
      const pair = raw.between;
      if (pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        return fail(path, '"between" must be a pair of room ids, e.g. [korridor, bad]');
      }
      return { between: [pair[0], pair[1]] };
    }
    if (raw.from !== undefined && raw.to !== undefined) {
      return { from: readPoint(raw.from, `${path}.from`), to: readPoint(raw.to, `${path}.to`) };
    }
  }
  return fail(path, '"wall" must be "n", "e", "s", "w", {from,to} or {between:[roomA,roomB]}');
}

function readOpening(raw: unknown, path: string): PlanOpening {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with "wall", "kind" and "width"');
  return { ...readOpeningShape(raw, path), wall: readWallRef(raw.wall, path) };
}

function readWall(raw: unknown, path: string, tInt: number): PlanWall {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with "from" and "to"');
  const wall: PlanWall = {
    from: readPoint(raw.from, `${path}.from`),
    to: readPoint(raw.to, `${path}.to`),
    thickness: positive(optNum(raw.thickness, path, '"thickness"', tInt), path, '"thickness"'),
  };
  if (raw.height !== undefined && raw.height !== null) {
    wall.height = positive(num(raw.height, path, '"height"'), path, '"height"');
  }
  if (raw.openings !== undefined && raw.openings !== null) {
    if (!Array.isArray(raw.openings)) return fail(`${path}.openings`, 'must be a list of openings');
    wall.openings = raw.openings.map((o, i) => readOpeningShape(o, `${path}.openings[${i}]`));
  }
  return wall;
}

function readRoom(raw: unknown, path: string): NRoom {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with "id" and "rect"');
  const id = raw.id;
  if (typeof id !== 'string' || !id) return fail(path, '"id" is required and must be a string');
  const rectRaw = raw.rect;
  const rects: Rect[] = Array.isArray(rectRaw) && Array.isArray(rectRaw[0])
    ? rectRaw.map((r, i) => readRect(r, `${path}.rect[${i}]`))
    : [readRect(rectRaw, `${path}.rect`)];

  const wet = raw.wet === true;
  let floor: PlanFloorFinish = wet ? 'tile' : 'wood';
  if (raw.floor !== undefined && raw.floor !== null) {
    if (typeof raw.floor !== 'string' || !FINISHES.includes(raw.floor as PlanFloorFinish)) {
      return fail(path, `"floor" must be one of ${FINISHES.map((f) => `"${f}"`).join(', ')}`);
    }
    floor = raw.floor as PlanFloorFinish;
  }

  const openTo = new Set<string>();
  if (raw.openTo !== undefined && raw.openTo !== null) {
    if (!Array.isArray(raw.openTo)) return fail(`${path}.openTo`, 'must be a list of room ids');
    for (const other of raw.openTo) {
      if (typeof other !== 'string') return fail(`${path}.openTo`, 'must be a list of room ids');
      openTo.add(other);
    }
  }

  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    rects,
    floor,
    openTo,
    ceiling: raw.ceiling !== false,
  };
}

function readStairs(raw: unknown, path: string): PlanStairs {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with "from", "to", "width" and "steps"');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : 'stairs';
  const steps = Math.round(positive(num(raw.steps, path, '"steps"'), path, '"steps"'));
  const stairs: PlanStairs = {
    id,
    from: readPoint(raw.from, `${path}.from`),
    to: readPoint(raw.to, `${path}.to`),
    width: positive(optNum(raw.width, path, '"width"', 1), path, '"width"'),
    steps,
  };
  if (raw.fromY !== undefined && raw.fromY !== null) stairs.fromY = num(raw.fromY, path, '"fromY"');
  if (raw.toY !== undefined && raw.toY !== null) stairs.toY = num(raw.toY, path, '"toY"');
  if (typeof raw.room === 'string' && raw.room) stairs.room = raw.room;
  if (raw.well !== undefined && raw.well !== null) {
    const r = readRect(raw.well, `${path}.well`);
    stairs.well = [r.x0, r.z0, r.x1, r.z1];
  }
  return stairs;
}

function readLevel(raw: unknown, path: string, plan: { slab: number; tInt: number }): NLevel {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with "id", "elevation" and "outline"');
  const id = raw.id;
  if (typeof id !== 'string' || !id) return fail(path, '"id" is required and must be a string');

  const outlineRaw = raw.outline;
  if (!Array.isArray(outlineRaw) || outlineRaw.length < 3) {
    return fail(`${path}.outline`, 'must be at least 3 [x, z] points forming a closed polygon');
  }
  const outline = outlineRaw.map((p, i) => readPoint(p, `${path}.outline[${i}]`));

  const roomsRaw = raw.rooms;
  if (roomsRaw !== undefined && roomsRaw !== null && !Array.isArray(roomsRaw)) {
    return fail(`${path}.rooms`, 'must be a list of rooms');
  }
  const rooms = (roomsRaw ?? []).map((r: unknown, i: number) => readRoom(r, `${path}.rooms[${i}]`));
  const seen = new Set<string>();
  for (const room of rooms) {
    if (seen.has(room.id)) return fail(`${path}.rooms`, `duplicate room id "${room.id}"`);
    seen.add(room.id);
  }
  for (const room of rooms) {
    for (const other of room.openTo) {
      if (!seen.has(other)) {
        return fail(`${path}.rooms`, `"${room.id}" is openTo unknown room "${other}"`);
      }
    }
  }

  const height = positive(num(raw.height, path, '"height"'), path, '"height"');
  const clearHeight = positive(
    optNum(raw.clearHeight, path, '"clearHeight"', Math.max(height - plan.slab, 1)),
    path,
    '"clearHeight"',
  );

  const wallsRaw = raw.walls;
  if (wallsRaw !== undefined && wallsRaw !== null && !Array.isArray(wallsRaw)) {
    return fail(`${path}.walls`, 'must be a list of walls');
  }
  const openingsRaw = raw.openings;
  if (openingsRaw !== undefined && openingsRaw !== null && !Array.isArray(openingsRaw)) {
    return fail(`${path}.openings`, 'must be a list of openings');
  }
  const stairsRaw = raw.stairs;
  if (stairsRaw !== undefined && stairsRaw !== null && !Array.isArray(stairsRaw)) {
    return fail(`${path}.stairs`, 'must be a list of stair flights');
  }

  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : undefined,
    elevation: num(raw.elevation, path, '"elevation"'),
    height,
    clearHeight,
    outline,
    rooms,
    walls: (wallsRaw ?? []).map((w: unknown, i: number) =>
      readWall(w, `${path}.walls[${i}]`, plan.tInt),
    ),
    openings: (openingsRaw ?? []).map((o: unknown, i: number) =>
      readOpening(o, `${path}.openings[${i}]`),
    ),
    stairs: (stairsRaw ?? []).map((s: unknown, i: number) => readStairs(s, `${path}.stairs[${i}]`)),
    ceiling: raw.ceiling !== false,
  };
}

const SITE_KINDS = ['terrace', 'carport', 'step', 'volume'] as const;

function readSite(raw: unknown, path: string): PlanSite {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with "kind", "rect" and "level"');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(SITE_KINDS as readonly string[]).includes(kind)) {
    return fail(path, `"kind" must be one of ${SITE_KINDS.map((k) => `"${k}"`).join(', ')}`);
  }
  const rect = readRect(raw.rect, `${path}.rect`);
  const site: PlanSite = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : kind,
    kind: kind as PlanSite['kind'],
    rect: [rect.x0, rect.z0, rect.x1, rect.z1],
    level: num(raw.level, path, '"level"'),
  };
  if (raw.height !== undefined && raw.height !== null) {
    site.height = positive(num(raw.height, path, '"height"'), path, '"height"');
  }
  if (raw.steps !== undefined && raw.steps !== null) {
    site.steps = Math.round(positive(num(raw.steps, path, '"steps"'), path, '"steps"'));
  }
  if (raw.descend !== undefined && raw.descend !== null) {
    if (typeof raw.descend !== 'string' || !SIDES.includes(raw.descend as PlanSide)) {
      fail(path, '"descend" must be "n", "e", "s" or "w"');
    }
    site.descend = raw.descend as PlanSide;
  }
  return site;
}

/**
 * Turns whatever came out of the YAML into a plan every builder below can trust.
 * Exported so a host can validate a fetched file before handing it to the
 * engine and report the failure in its own UI.
 */
export function validatePlan(raw: unknown): NPlan {
  if (!isRecord(raw)) fail('', 'a plan must be a mapping with a "levels" list');
  const spec = raw as unknown as Record<string, unknown>;

  if (spec.units !== undefined && spec.units !== null && spec.units !== 'm') {
    fail('units', 'only "m" (metres) is supported');
  }

  const tExt = positive(optNum(spec.exteriorWall, '', '"exteriorWall"', DEFAULT_EXTERIOR), 'exteriorWall', 'thickness');
  const tInt = positive(optNum(spec.interiorWall, '', '"interiorWall"', DEFAULT_INTERIOR), 'interiorWall', 'thickness');
  const slab = positive(optNum(spec.slab, '', '"slab"', DEFAULT_SLAB), 'slab', 'thickness');
  const ceilT = positive(
    optNum(spec.ceilingThickness, '', '"ceilingThickness"', DEFAULT_CEILING),
    'ceilingThickness',
    'thickness',
  );

  const levelsRaw = spec.levels;
  if (!Array.isArray(levelsRaw) || levelsRaw.length === 0) {
    fail('levels', 'is required and must list at least one storey');
  }
  const levels = levelsRaw.map((l, i) => readLevel(l, `levels[${i}]`, { slab, tInt }));
  const ids = new Set<string>();
  for (const level of levels) {
    if (ids.has(level.id)) fail('levels', `duplicate level id "${level.id}"`);
    ids.add(level.id);
  }
  levels.sort((a, b) => a.elevation - b.elevation);

  let roof: PlanRoof | null = null;
  if (spec.roof !== undefined && spec.roof !== null) {
    if (!isRecord(spec.roof)) fail('roof', 'must be a mapping with "kind" and "eaveHeight"');
    const r = spec.roof as Record<string, unknown>;
    const kind = r.kind;
    if (kind !== 'mono' && kind !== 'gable' && kind !== 'flat') {
      fail('roof', '"kind" must be "mono", "gable" or "flat"');
    }
    const eaveHeight = num(r.eaveHeight, 'roof', '"eaveHeight"');
    const highSide = r.highSide;
    if (highSide !== undefined && highSide !== null && !SIDES.includes(highSide as PlanSide)) {
      fail('roof', '"highSide" must be "n", "e", "s" or "w"');
    }
    roof = {
      kind,
      eaveHeight,
      highSide: (highSide as PlanSide | undefined) ?? 'n',
      overhang: Math.max(0, optNum(r.overhang, 'roof', '"overhang"', DEFAULT_OVERHANG)),
      parapet: Math.max(0, optNum(r.parapet, 'roof', '"parapet"', 0)),
      thickness: positive(
        optNum(r.thickness, 'roof', '"thickness"', DEFAULT_ROOF_THICKNESS),
        'roof',
        '"thickness"',
      ),
    };
    if (r.ridgeAxis === 'x' || r.ridgeAxis === 'z') roof.ridgeAxis = r.ridgeAxis;
    if (r.slopeDeg !== undefined && r.slopeDeg !== null) {
      roof.slopeDeg = num(r.slopeDeg, 'roof', '"slopeDeg"');
    }
    if (r.ridgeHeight !== undefined && r.ridgeHeight !== null) {
      roof.ridgeHeight = num(r.ridgeHeight, 'roof', '"ridgeHeight"');
    }
    if (kind !== 'flat' && roof.ridgeHeight === undefined && roof.slopeDeg === undefined) {
      fail('roof', 'a pitched roof needs either "ridgeHeight" or "slopeDeg"');
    }
  }

  const siteRaw = spec.site;
  if (siteRaw !== undefined && siteRaw !== null && !Array.isArray(siteRaw)) {
    fail('site', 'must be a list of site elements');
  }

  return {
    name: typeof spec.name === 'string' && spec.name ? spec.name : 'plan_house',
    tExt,
    tInt,
    slab,
    ceilT,
    recentre: spec.recentre !== false,
    levels,
    roof,
    site: (siteRaw ?? []).map((s: unknown, i: number) => readSite(s, `site[${i}]`)),
  };
}

/* -------------------------------------------------------- geometry basics */

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

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const merged: THREE.BufferGeometry | null = mergeGeometries(parts, false);
  if (!merged) return parts[0];
  for (const part of parts) part.dispose();
  return merged;
}

function scaleUv(geometry: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geometry.getAttribute('uv');
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
}

function applyTransform(parts: THREE.BufferGeometry[], matrix: THREE.Matrix4): void {
  for (const part of parts) part.applyMatrix4(matrix);
}

/**
 * A box whose long axis runs from one plan point to another while rising from
 * `y0` to `y1` — a sloping parapet bar, a roof verge, a handrail.
 */
function slopedBar(
  from: Vec2,
  to: Vec2,
  y0: number,
  y1: number,
  width: number,
  height: number,
): THREE.BufferGeometry {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const run = Math.hypot(dx, dz);
  const dy = y1 - y0;
  const length = Math.hypot(run, dy);
  const pitch = Math.atan2(dy, run);
  const yaw = Math.atan2(-dz, dx);

  const geometry = new THREE.BoxGeometry(length, height, width);
  const matrix = new THREE.Matrix4()
    .makeTranslation((from[0] + to[0]) / 2, (y0 + y1) / 2 + height / 2, (from[1] + to[1]) / 2)
    .multiply(new THREE.Matrix4().makeRotationY(yaw))
    .multiply(new THREE.Matrix4().makeRotationZ(pitch));
  geometry.applyMatrix4(matrix);
  return geometry;
}

/** Splits a rectangle around a set of holes, returning the surviving cells. */
function rectMinus(rect: Rect, holes: readonly Rect[]): Rect[] {
  const live = holes.filter(
    (h) => h.x1 > rect.x0 + EPS && h.x0 < rect.x1 - EPS && h.z1 > rect.z0 + EPS && h.z0 < rect.z1 - EPS,
  );
  if (live.length === 0) return [rect];

  const cut = (lo: number, hi: number, edges: number[]): number[] => {
    const set = new Set<number>([lo, hi]);
    for (const e of edges) if (e > lo + EPS && e < hi - EPS) set.add(e);
    return [...set].sort((a, b) => a - b);
  };
  const xs = cut(rect.x0, rect.x1, live.flatMap((h) => [h.x0, h.x1]));
  const zs = cut(rect.z0, rect.z1, live.flatMap((h) => [h.z0, h.z1]));

  const out: Rect[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const cell = { x0: xs[i], x1: xs[i + 1], z0: zs[j], z1: zs[j + 1] };
      const cx = (cell.x0 + cell.x1) / 2;
      const cz = (cell.z0 + cell.z1) / 2;
      const covered = live.some((h) => cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1);
      if (!covered) out.push(cell);
    }
  }
  return out;
}

/** A horizontal plate over `rect` minus `holes`, with world-scaled floor UVs. */
function plate(rect: Rect, y0: number, y1: number, holes: readonly Rect[]): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (const cell of rectMinus(rect, holes)) {
    const w = cell.x1 - cell.x0;
    const d = cell.z1 - cell.z0;
    if (w <= EPS || d <= EPS || y1 - y0 <= EPS) continue;
    const geometry = boxGeom(w, y1 - y0, d, (cell.x0 + cell.x1) / 2, (y0 + y1) / 2, (cell.z0 + cell.z1) / 2);
    scaleUv(geometry, w / FLOOR_TILE_M, d / FLOOR_TILE_M);
    parts.push(geometry);
  }
  return parts;
}

/* ------------------------------------------------------------------ walls */

interface WOpening {
  /** Distance along the wall from its start to the opening's centre. */
  at: number;
  width: number;
  /** Height of the opening's bottom above the wall's own base. */
  sill: number;
  height: number;
  glass: boolean;
  leaf: boolean;
}

interface WallBuild {
  from: Vec2;
  to: Vec2;
  baseY: number;
  height: number;
  thickness: number;
  /** Extra length past `from` / `to`, so corners and T-junctions close. */
  extendStart: number;
  extendEnd: number;
  openings: WOpening[];
}

interface WallResult {
  solid: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  leaves: THREE.BufferGeometry[];
}

/**
 * A wall with its openings composed from boxes rather than cut with CSG: piers
 * between the openings, a sill below and a lintel above each one. Watertight,
 * indexed, dependency-free, and it reads correctly in a cross-section.
 */
function buildWall(spec: WallBuild): WallResult {
  const dx = spec.to[0] - spec.from[0];
  const dz = spec.to[1] - spec.from[1];
  const length = Math.hypot(dx, dz);
  const result: WallResult = { solid: [], glass: [], leaves: [] };
  if (length < EPS) return result;

  const t = spec.thickness;
  const base = spec.baseY;
  const top = base + spec.height;
  const u0 = -spec.extendStart;
  const u1 = length + spec.extendEnd;

  const pier = (a: number, b: number, y0: number, y1: number) => {
    if (b - a <= EPS || y1 - y0 <= EPS) return;
    result.solid.push(boxGeom(b - a, y1 - y0, t, (a + b) / 2, (y0 + y1) / 2, 0));
  };

  const openings = spec.openings
    .slice()
    .sort((a, b) => a.at - b.at)
    .filter((o) => o.at + o.width / 2 > u0 && o.at - o.width / 2 < u1);

  let cursor = u0;
  for (const opening of openings) {
    const a = Math.max(u0, opening.at - opening.width / 2);
    const b = Math.min(u1, opening.at + opening.width / 2);
    if (b <= a) continue;
    const sill = Math.max(0, Math.min(opening.sill, spec.height - 0.05));
    const head = Math.min(spec.height, sill + opening.height);

    pier(cursor, a, base, top);
    if (sill > EPS) pier(a, b, base, base + sill);
    if (head < spec.height - EPS) pier(a, b, base + head, top);
    cursor = Math.max(cursor, b);

    const cy = base + (sill + head) / 2;
    const clear = head - sill;
    if (opening.glass && clear > 0.1) {
      result.glass.push(boxGeom(b - a - 0.06, clear - 0.06, 0.02, (a + b) / 2, cy, 0));
    }
    if (opening.leaf && clear > 0.1) {
      result.leaves.push(boxGeom(b - a - 0.04, clear - 0.03, 0.045, (a + b) / 2, cy, 0));
    }
  }
  pier(cursor, u1, base, top);

  // Local +X runs from `from` to `to`; Y is untouched so the absolute heights
  // computed above survive the transform.
  const matrix = new THREE.Matrix4()
    .makeTranslation(spec.from[0], 0, spec.from[1])
    .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(-dz, dx)));
  applyTransform(result.solid, matrix);
  applyTransform(result.glass, matrix);
  applyTransform(result.leaves, matrix);
  return result;
}

/* ----------------------------------------------------------------- stairs */

/** A solid stepped flight, which is what makes a cut-away view legible. */
function buildStairs(
  from: Vec2,
  to: Vec2,
  yStart: number,
  yEnd: number,
  width: number,
  steps: number,
): THREE.BufferGeometry[] {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const run = Math.hypot(dx, dz);
  if (run < EPS || steps < 1) return [];

  const going = run / steps;
  const rise = (yEnd - yStart) / steps;
  const bottom = Math.min(yStart, yEnd);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const top = yStart + rise * (i + 1);
    const height = top - bottom;
    if (height <= 1e-3) continue;
    parts.push(boxGeom(going, height, width, going * (i + 0.5), bottom + height / 2, 0));
  }
  const matrix = new THREE.Matrix4()
    .makeTranslation(from[0], 0, from[1])
    .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(-dz, dx)));
  applyTransform(parts, matrix);
  return parts;
}

/* --------------------------------------------------------------- polygons */

function polygonBounds(points: readonly PlanPoint[]): Rect {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const [x, z] of points) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return { x0, x1, z0, z1 };
}

interface OutlineEdge {
  /** Centreline endpoints, half a wall thickness inside the exterior face. */
  from: PlanPoint;
  to: PlanPoint;
  /** Unit normal pointing away from the building. */
  out: PlanPoint;
  cardinal: PlanSide;
}

/**
 * Offsets each outline edge inward by half a wall thickness and mitres the
 * corners, so the walls meet on their centrelines. Each wall is then extended
 * half a thickness at both ends by the caller, which fills the outer corner.
 */
function outlineEdges(outline: readonly PlanPoint[], thickness: number): OutlineEdge[] {
  const n = outline.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area2 > 0;

  const inward: PlanPoint[] = [];
  const offset: PlanPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const nrm: PlanPoint = ccw ? [-dz / len, dx / len] : [dz / len, -dx / len];
    inward.push(nrm);
    offset.push([a[0] + (nrm[0] * thickness) / 2, a[1] + (nrm[1] * thickness) / 2]);
  }

  // Mitred vertex i sits where the offset lines of edge i-1 and edge i cross.
  const vertex: PlanPoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const pA = offset[prev];
    const pB = outline[(prev + 1) % n];
    const dA: PlanPoint = [pB[0] - outline[prev][0], pB[1] - outline[prev][1]];
    const pC = offset[i];
    const dB: PlanPoint = [
      outline[(i + 1) % n][0] - outline[i][0],
      outline[(i + 1) % n][1] - outline[i][1],
    ];
    const cross = dA[0] * dB[1] - dA[1] * dB[0];
    if (Math.abs(cross) < 1e-6) {
      vertex.push([pC[0], pC[1]]);
      continue;
    }
    const t = ((pC[0] - pA[0]) * dB[1] - (pC[1] - pA[1]) * dB[0]) / cross;
    vertex.push([pA[0] + dA[0] * t, pA[1] + dA[1] * t]);
  }

  const edges: OutlineEdge[] = [];
  for (let i = 0; i < n; i++) {
    const out: PlanPoint = [-inward[i][0], -inward[i][1]];
    const cardinal: PlanSide =
      Math.abs(out[0]) > Math.abs(out[1]) ? (out[0] > 0 ? 'e' : 'w') : out[1] > 0 ? 's' : 'n';
    edges.push({ from: vertex[i], to: vertex[(i + 1) % n], out, cardinal });
  }
  return edges;
}

/* --------------------------------------------------------- wall segments */

interface WallPart {
  u0: number;
  u1: number;
  a: string;
  b: string | null;
}

interface WallSeg {
  kind: 'exterior' | 'interior' | 'explicit';
  cardinal?: PlanSide;
  from: PlanPoint;
  to: PlanPoint;
  dir: PlanPoint;
  length: number;
  thickness: number;
  baseY: number;
  height: number;
  extendStart: number;
  extendEnd: number;
  parts: WallPart[];
  openings: WOpening[];
}

type Axis2 = 'x' | 'z';

interface RoomEdge {
  axis: Axis2;
  /** Coordinate of the edge on `axis`. */
  c: number;
  /** +1 when the room lies on the low side, i.e. the edge faces outward in +. */
  s: 1 | -1;
  u0: number;
  u1: number;
  room: string;
}

interface Band {
  axis: Axis2;
  centre: number;
  thickness: number;
  parts: WallPart[];
}

function rectEdges(rect: Rect, room: string): RoomEdge[] {
  return [
    { axis: 'x', c: rect.x0, s: -1, u0: rect.z0, u1: rect.z1, room },
    { axis: 'x', c: rect.x1, s: 1, u0: rect.z0, u1: rect.z1, room },
    { axis: 'z', c: rect.z0, s: -1, u0: rect.x0, u1: rect.x1, room },
    { axis: 'z', c: rect.z1, s: 1, u0: rect.x0, u1: rect.x1, room },
  ];
}

/**
 * Sweeps every room edge against every other room rectangle and reduces the
 * result to a set of wall bands. Two rooms facing each other across a gap
 * produce the same band from both sides; grouping by centreline is what makes
 * "build the wall between two rooms exactly once" fall out for free.
 */
function deriveBands(level: NLevel, plan: NPlan): Band[] {
  const tInt = plan.tInt;
  const maxGap = tInt + GAP_SLACK;
  const openPairs = new Set<string>();
  for (const room of level.rooms) {
    for (const other of room.openTo) openPairs.add(pairKey(room.id, other));
  }

  interface Face {
    axis: Axis2;
    c: number;
    /** Which way the face looks: -1 = toward lower coordinates. */
    look: 1 | -1;
    u0: number;
    u1: number;
    room: string;
  }
  const faces: Face[] = [];
  const edges: RoomEdge[] = [];
  for (const room of level.rooms) {
    for (const rect of room.rects) {
      for (const edge of rectEdges(rect, room.id)) {
        edges.push(edge);
        // The same edge, seen from outside the room, is a face another room's
        // sweep can land on.
        faces.push({ axis: edge.axis, c: edge.c, look: edge.s, u0: edge.u0, u1: edge.u1, room: room.id });
      }
    }
  }

  const shell = outlineEdges(level.outline, plan.tExt);
  const bands = new Map<string, Band>();

  for (const edge of edges) {
    if (onExteriorFace(edge, shell, plan.tExt)) continue;

    // Candidate opposing faces: same axis, looking back at us, within the gap.
    const candidates = faces.filter((f) => {
      if (f.axis !== edge.axis) return false;
      if (f.look === edge.s) return false;
      if (f.room === edge.room && Math.abs(f.c - edge.c) < EPS && f.u0 === edge.u0 && f.u1 === edge.u1) {
        return false;
      }
      const d = edge.s * (f.c - edge.c);
      if (d < -EPS || d > maxGap) return false;
      return f.u1 > edge.u0 + EPS && f.u0 < edge.u1 - EPS;
    });

    const cuts = new Set<number>([edge.u0, edge.u1]);
    for (const f of candidates) {
      if (f.u0 > edge.u0 + EPS && f.u0 < edge.u1 - EPS) cuts.add(f.u0);
      if (f.u1 > edge.u0 + EPS && f.u1 < edge.u1 - EPS) cuts.add(f.u1);
    }
    const stops = [...cuts].sort((a, b) => a - b);

    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (b - a <= EPS) continue;
      const mid = (a + b) / 2;

      let best: Face | null = null;
      for (const f of candidates) {
        if (mid <= f.u0 + EPS || mid >= f.u1 - EPS) continue;
        if (!best || Math.abs(f.c - edge.c) < Math.abs(best.c - edge.c)) best = f;
      }

      if (best && (best.room === edge.room || openPairs.has(pairKey(edge.room, best.room)))) continue;

      let centre: number;
      let thickness: number;
      if (!best) {
        centre = edge.c + (edge.s * tInt) / 2;
        thickness = tInt;
      } else {
        const gap = Math.abs(best.c - edge.c);
        if (gap < 0.02) {
          centre = edge.c;
          thickness = tInt;
        } else {
          centre = (edge.c + best.c) / 2;
          thickness = Math.abs(gap - tInt) < 0.05 ? tInt : gap;
        }
      }

      const key = `${edge.axis}|${centre.toFixed(3)}|${thickness.toFixed(3)}`;
      let band = bands.get(key);
      if (!band) {
        band = { axis: edge.axis, centre, thickness, parts: [] };
        bands.set(key, band);
      }
      band.parts.push({ u0: a, u1: b, a: edge.room, b: best?.room ?? null });
    }
  }

  return [...bands.values()];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** True when a room edge sits on the inner face of an exterior wall. */
function onExteriorFace(edge: RoomEdge, shell: readonly OutlineEdge[], tExt: number): boolean {
  for (const wall of shell) {
    const axis: Axis2 = Math.abs(wall.out[0]) > Math.abs(wall.out[1]) ? 'x' : 'z';
    if (axis !== edge.axis) continue;
    const outSign = axis === 'x' ? Math.sign(wall.out[0]) : Math.sign(wall.out[1]);
    if (outSign !== edge.s) continue;
    // Wall centreline coordinate, plus half a thickness back toward the inside.
    const centre = axis === 'x' ? wall.from[0] : wall.from[1];
    const inner = centre - (outSign * tExt) / 2;
    if (Math.abs(inner - edge.c) < 0.03) return true;
  }
  return false;
}

/* --------------------------------------------------------------- openings */

interface OpeningDefaults {
  clearHeight: number;
}

function openingMetrics(shape: PlanOpeningShape, d: OpeningDefaults): {
  sill: number;
  height: number;
  glass: boolean;
  leaf: boolean;
} {
  const sill = shape.sill ?? (shape.kind === 'window' ? 0.9 : 0);
  const height =
    shape.height ??
    (shape.kind === 'window' ? 1.3 : shape.kind === 'door' ? 2.05 : Math.max(2, d.clearHeight - 0.3));
  return {
    sill,
    height,
    glass: shape.kind !== 'door' || shape.glazed === true,
    leaf: shape.kind === 'door',
  };
}

/** Distance along a segment to the point whose plan coordinate is `value`. */
function uForCoordinate(seg: WallSeg, axis: Axis2, value: number): number | null {
  const d = axis === 'x' ? seg.dir[0] : seg.dir[1];
  if (Math.abs(d) < 0.5) return null;
  const start = axis === 'x' ? seg.from[0] : seg.from[1];
  return (value - start) / d;
}

function assignOpening(
  opening: PlanOpening,
  segments: readonly WallSeg[],
  level: NLevel,
  bounds: Rect,
  path: string,
): void {
  const metrics = openingMetrics(opening, { clearHeight: level.clearHeight });
  const ref = opening.wall;

  const place = (seg: WallSeg, u: number): void => {
    // `sill` is authored above the finished floor; walls that start under the
    // slab need it lifted by the slab depth.
    const lift = level.elevation - seg.baseY;
    seg.openings.push({
      at: u,
      width: opening.width,
      sill: metrics.sill + lift,
      height: metrics.height,
      glass: metrics.glass,
      leaf: metrics.leaf,
    });
  };

  if (typeof ref === 'string') {
    const axis: Axis2 = ref === 'n' || ref === 's' ? 'x' : 'z';
    const origin = axis === 'x' ? bounds.x0 : bounds.z0;
    const at = opening.at;
    if (at === undefined) fail(path, `"at" is required for a "${ref}" wall opening`);
    const target = origin + at;
    const matches = segments.filter((s) => s.kind === 'exterior' && s.cardinal === ref);
    for (const seg of matches) {
      const u = uForCoordinate(seg, axis, target);
      if (u === null) continue;
      if (u >= -seg.extendStart - EPS && u <= seg.length + seg.extendEnd + EPS) {
        place(seg, u);
        return;
      }
    }
    fail(
      path,
      `no "${ref}" exterior wall reaches ${axis} = ${target.toFixed(2)} m on level "${level.id}"`,
    );
  }

  if ('between' in ref) {
    const [ra, rb] = ref.between;
    const known = new Set(level.rooms.map((r) => r.id));
    if (!known.has(ra)) fail(path, `"between" names unknown room "${ra}" on level "${level.id}"`);
    if (!known.has(rb)) fail(path, `"between" names unknown room "${rb}" on level "${level.id}"`);
    const key = pairKey(ra, rb);

    let bestSeg: WallSeg | null = null;
    let bestSpan: [number, number] | null = null;
    for (const seg of segments) {
      for (const part of seg.parts) {
        if (part.b === null || pairKey(part.a, part.b) !== key) continue;
        const span = part.u1 - part.u0;
        if (!bestSpan || span > bestSpan[1] - bestSpan[0]) {
          bestSeg = seg;
          bestSpan = [part.u0, part.u1];
        }
      }
    }
    if (!bestSeg || !bestSpan) {
      fail(path, `rooms "${ra}" and "${rb}" do not share a wall on level "${level.id}"`);
    }
    const u = opening.at === undefined ? (bestSpan[0] + bestSpan[1]) / 2 : bestSpan[0] + opening.at;
    place(bestSeg, u);
    return;
  }

  // Explicit line: any wall collinear with it, positioned from `from`.
  const dx = ref.to[0] - ref.from[0];
  const dz = ref.to[1] - ref.from[1];
  const len = Math.hypot(dx, dz);
  if (len < EPS) fail(path, '"wall" from and to are the same point');
  const dir: PlanPoint = [dx / len, dz / len];
  const at = opening.at ?? len / 2;
  const q: PlanPoint = [ref.from[0] + dir[0] * at, ref.from[1] + dir[1] * at];

  let best: { seg: WallSeg; u: number; dist: number } | null = null;
  for (const seg of segments) {
    if (Math.abs(seg.dir[0] * dir[1] - seg.dir[1] * dir[0]) > 0.05) continue;
    const u = (q[0] - seg.from[0]) * seg.dir[0] + (q[1] - seg.from[1]) * seg.dir[1];
    if (u < -seg.extendStart - 0.05 || u > seg.length + seg.extendEnd + 0.05) continue;
    const px = seg.from[0] + seg.dir[0] * u;
    const pz = seg.from[1] + seg.dir[1] * u;
    const dist = Math.hypot(px - q[0], pz - q[1]);
    if (dist > seg.thickness / 2 + 0.2) continue;
    if (!best || dist < best.dist) best = { seg, u, dist };
  }
  if (!best) {
    fail(
      path,
      `no wall on level "${level.id}" passes through (${q[0].toFixed(2)}, ${q[1].toFixed(2)})`,
    );
  }
  place(best.seg, best.u);
}

/* ---------------------------------------------------------------- builder */

interface MeshOptions {
  cast?: boolean;
  receive?: boolean;
  glass?: boolean;
  alwaysVisible?: boolean;
}

class PlanBuilder {
  readonly root = new THREE.Group();
  readonly nodes = new Map<string, THREE.Object3D>();
  private readonly levelGroups = new Map<string, THREE.Group>();
  private readonly roomGroups = new Map<string, THREE.Group>();

  constructor(name: string) {
    this.root.name = name;
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
    mesh.userData.shadowsConfigured = true;
    if (options.glass) mesh.userData.glass = true;
    if (options.alwaysVisible || levelId === 'site') mesh.userData.alwaysVisible = true;
    mesh.castShadow = options.cast ?? true;
    mesh.receiveShadow = options.receive ?? true;

    this.room(levelId, roomId).add(mesh);
    this.nodes.set(mesh.name, mesh);
    return mesh;
  }
}

function floorMaterial(finish: PlanFloorFinish, mat: MaterialLibrary): THREE.MeshStandardMaterial {
  if (finish === 'tile') return mat.floorTile;
  if (finish === 'concrete') return mat.wall;
  return mat.floorWood;
}

/* -------------------------------------------------------------- the build */

export function buildFromPlan(spec: PlanSpec | unknown, options: PlanHouseOptions = {}): PlanHouse {
  const plan = validatePlan(spec);
  const mat = createMaterialLibrary({ anisotropy: options.anisotropy, textures: options.textures });
  const b = new PlanBuilder(plan.name);

  const topLevel = plan.levels[plan.levels.length - 1];
  const wells = collectWells(plan);

  for (const level of plan.levels) {
    buildLevel(b, mat, plan, level, wells, level === topLevel);
  }
  if (plan.roof) buildRoof(b, mat, plan, topLevel, plan.roof);
  buildSite(b, mat, plan);

  // Recentre on the footprint so a plan written from a corner still orbits
  // around its own middle. Y is left alone: elevations are meaningful.
  if (plan.recentre) {
    const all = plan.levels.flatMap((l) => l.outline);
    const bounds = polygonBounds(all);
    b.root.position.set(-(bounds.x0 + bounds.x1) / 2, 0, -(bounds.z0 + bounds.z1) / 2);
  }
  b.root.updateMatrixWorld(true);

  let groundIndex = 0;
  plan.levels.forEach((level, index) => {
    if (Math.abs(level.elevation) < Math.abs(plan.levels[groundIndex].elevation)) groundIndex = index;
  });
  const levels: LevelDefinition[] = plan.levels.map((level, index) => ({
    id: level.id,
    name: level.name,
    elevation: level.elevation,
    height: level.height,
    icon: level.icon ?? defaultIcon(index - groundIndex),
  }));

  return {
    root: b.root,
    levels,
    bounds: computeModelBounds(b.root),
    nodes: b.nodes,
    materials: mat,
  };
}

/**
 * Storey icon derived from the position in the stack rather than the elevation:
 * on a hillside house the "ground" floor is whichever one the plan calls ±0.00,
 * and everything else counts from it.
 */
function defaultIcon(order: number): string {
  if (order < 0) return 'mdi:home-floor-b';
  if (order === 0) return 'mdi:home-floor-g';
  return order <= 3 ? `mdi:home-floor-${order}` : 'mdi:home-floor-a';
}

/** Stair wells, resolved once so the slab above and the ceiling below agree. */
interface Wells {
  /** Holes in each level's own ceiling. */
  ceiling: Map<string, Rect[]>;
  /** Holes in each level's own floor slab (from the flight arriving into it). */
  floor: Map<string, Rect[]>;
}

function collectWells(plan: NPlan): Wells {
  const ceiling = new Map<string, Rect[]>();
  const floor = new Map<string, Rect[]>();
  for (const level of plan.levels) {
    ceiling.set(level.id, []);
    floor.set(level.id, []);
  }

  plan.levels.forEach((level, index) => {
    const above = plan.levels[index + 1];
    for (const stairs of level.stairs) {
      const rect = stairs.well
        ? readRect(stairs.well, `levels.${level.id}.stairs.${stairs.id}.well`)
        : flightFootprint(stairs);
      ceiling.get(level.id)?.push(rect);
      if (above) floor.get(above.id)?.push(rect);
    }
  });
  return { ceiling, floor };
}

function flightFootprint(stairs: PlanStairs): Rect {
  const half = stairs.width / 2;
  const dx = stairs.to[0] - stairs.from[0];
  const dz = stairs.to[1] - stairs.from[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = (-dz / len) * half;
  const nz = (dx / len) * half;
  const xs = [stairs.from[0] + nx, stairs.from[0] - nx, stairs.to[0] + nx, stairs.to[0] - nx];
  const zs = [stairs.from[1] + nz, stairs.from[1] - nz, stairs.to[1] + nz, stairs.to[1] - nz];
  return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
}

function buildLevel(
  b: PlanBuilder,
  mat: MaterialLibrary,
  plan: NPlan,
  level: NLevel,
  wells: Wells,
  isTop: boolean,
): void {
  const bounds = polygonBounds(level.outline);
  const wallBase = level.elevation - plan.slab;
  const eave = plan.roof ? plan.roof.eaveHeight : null;
  const shellHeight =
    isTop && eave !== null ? Math.max(level.height, eave - wallBase) : level.height;

  /* ------------------------------------------------------------- segments */

  const segments: WallSeg[] = [];

  for (const edge of outlineEdges(level.outline, plan.tExt)) {
    const dx = edge.to[0] - edge.from[0];
    const dz = edge.to[1] - edge.from[1];
    const length = Math.hypot(dx, dz);
    if (length < EPS) continue;
    segments.push({
      kind: 'exterior',
      cardinal: edge.cardinal,
      from: edge.from,
      to: edge.to,
      dir: [dx / length, dz / length],
      length,
      thickness: plan.tExt,
      baseY: wallBase,
      height: shellHeight,
      extendStart: plan.tExt / 2,
      extendEnd: plan.tExt / 2,
      parts: [],
      openings: [],
    });
  }

  for (const band of deriveBands(level, plan)) {
    for (const run of mergeRuns(band.parts)) {
      const from: PlanPoint =
        band.axis === 'x' ? [band.centre, run.u0] : [run.u0, band.centre];
      const to: PlanPoint = band.axis === 'x' ? [band.centre, run.u1] : [run.u1, band.centre];
      const length = run.u1 - run.u0;
      segments.push({
        kind: 'interior',
        from,
        to,
        dir: band.axis === 'x' ? [0, 1] : [1, 0],
        length,
        thickness: band.thickness,
        baseY: level.elevation,
        height: level.clearHeight,
        extendStart: band.thickness / 2,
        extendEnd: band.thickness / 2,
        parts: run.parts,
        openings: [],
      });
    }
  }

  level.walls.forEach((wall, index) => {
    const dx = wall.to[0] - wall.from[0];
    const dz = wall.to[1] - wall.from[1];
    const length = Math.hypot(dx, dz);
    if (length < EPS) fail(`levels.${level.id}.walls[${index}]`, 'from and to are the same point');
    const thickness = wall.thickness ?? plan.tInt;
    const seg: WallSeg = {
      kind: 'explicit',
      from: wall.from,
      to: wall.to,
      dir: [dx / length, dz / length],
      length,
      thickness,
      baseY: level.elevation,
      height: wall.height ?? level.clearHeight,
      extendStart: thickness / 2,
      extendEnd: thickness / 2,
      parts: [],
      openings: [],
    };
    for (const shape of wall.openings ?? []) {
      const metrics = openingMetrics(shape, { clearHeight: level.clearHeight });
      seg.openings.push({
        at: shape.at ?? length / 2,
        width: shape.width,
        sill: metrics.sill,
        height: metrics.height,
        glass: metrics.glass,
        leaf: metrics.leaf,
      });
    }
    segments.push(seg);
  });

  level.openings.forEach((opening, index) => {
    assignOpening(opening, segments, level, bounds, `levels.${level.id}.openings[${index}]`);
  });

  /* ---------------------------------------------------------------- shell */

  const facades = new Map<PlanSide, THREE.BufferGeometry[]>();
  const shellGlass: THREE.BufferGeometry[] = [];
  const shellLeaves: THREE.BufferGeometry[] = [];
  const partitions: THREE.BufferGeometry[] = [];
  const innerGlass: THREE.BufferGeometry[] = [];
  const innerLeaves: THREE.BufferGeometry[] = [];

  for (const seg of segments) {
    const built = buildWall({
      from: seg.from,
      to: seg.to,
      baseY: seg.baseY,
      height: seg.height,
      thickness: seg.thickness,
      extendStart: seg.extendStart,
      extendEnd: seg.extendEnd,
      openings: seg.openings,
    });
    if (seg.kind === 'exterior' && seg.cardinal) {
      const bucket = facades.get(seg.cardinal) ?? [];
      bucket.push(...built.solid);
      facades.set(seg.cardinal, bucket);
      shellGlass.push(...built.glass);
      shellLeaves.push(...built.leaves);
    } else {
      partitions.push(...built.solid);
      innerGlass.push(...built.glass);
      innerLeaves.push(...built.leaves);
    }
  }

  const CARDINAL_NAME: Record<PlanSide, string> = { n: 'north', e: 'east', s: 'south', w: 'west' };
  for (const [side, parts] of facades) {
    b.mesh(level.id, 'exterior', `wall_${CARDINAL_NAME[side]}`, parts, mat.wall);
  }
  if (shellGlass.length) {
    b.mesh(level.id, 'exterior', 'glazing', shellGlass, mat.glass, {
      cast: false,
      receive: false,
      glass: true,
    });
  }
  if (shellLeaves.length) b.mesh(level.id, 'exterior', 'door_leaf', shellLeaves, mat.wood);
  if (partitions.length) b.mesh(level.id, 'structure', 'partitions', partitions, mat.wall);
  if (innerGlass.length) {
    b.mesh(level.id, 'structure', 'glazing', innerGlass, mat.glass, {
      cast: false,
      receive: false,
      glass: true,
    });
  }
  if (innerLeaves.length) b.mesh(level.id, 'structure', 'door_leaf', innerLeaves, mat.wood);

  /* ---------------------------------------------------------- slab, rooms */

  const floorHoles = wells.floor.get(level.id) ?? [];
  const ceilingHoles = wells.ceiling.get(level.id) ?? [];

  b.mesh(
    level.id,
    'structure',
    'slab',
    plate(bounds, level.elevation - plan.slab, level.elevation - FINISH, floorHoles),
    mat.wall,
    { cast: false, receive: true },
  );

  // Drawings quote clear heights that do not always add up to the storey height
  // (screed, services, a suspended ceiling). Trust the storey stack: park the
  // ceiling just under the slab above rather than letting it vanish inside it.
  const above = plan.levels[plan.levels.indexOf(level) + 1];
  const ceilingY = above
    ? Math.min(level.elevation + level.clearHeight, above.elevation - plan.slab - plan.ceilT)
    : level.elevation + level.clearHeight;
  for (const room of level.rooms) {
    const finish: THREE.BufferGeometry[] = [];
    const ceiling: THREE.BufferGeometry[] = [];
    for (const rect of room.rects) {
      finish.push(...plate(rect, level.elevation - FINISH, level.elevation, floorHoles));
      if (level.ceiling && room.ceiling) {
        ceiling.push(...plate(rect, ceilingY, ceilingY + plan.ceilT, ceilingHoles));
      }
    }
    b.mesh(level.id, room.id, 'floor', finish, floorMaterial(room.floor, mat), {
      cast: false,
      receive: true,
    });
    b.mesh(level.id, room.id, 'ceiling', ceiling, mat.ceiling, { cast: false, receive: true });
  }

  /* --------------------------------------------------------------- stairs */

  const nextLevel = plan.levels[plan.levels.indexOf(level) + 1];
  for (const stairs of level.stairs) {
    const yStart = stairs.fromY ?? level.elevation;
    const yEnd = stairs.toY ?? (nextLevel ? nextLevel.elevation : level.elevation + level.height);
    b.mesh(
      level.id,
      stairs.room ?? 'structure',
      stairs.id,
      buildStairs(stairs.from, stairs.to, yStart, yEnd, stairs.width, stairs.steps),
      mat.wall,
    );
  }
}

interface Run {
  u0: number;
  u1: number;
  parts: WallPart[];
}

/** Unions the touching pieces of one band into the smallest set of walls. */
function mergeRuns(parts: readonly WallPart[]): Run[] {
  const sorted = parts.slice().sort((a, b) => a.u0 - b.u0);
  const runs: Run[] = [];
  for (const part of sorted) {
    const last = runs[runs.length - 1];
    if (last && part.u0 <= last.u1 + 1e-3) {
      last.u1 = Math.max(last.u1, part.u1);
      last.parts.push(part);
    } else {
      runs.push({ u0: part.u0, u1: part.u1, parts: [part] });
    }
  }
  // Re-express each part in the run's local u, so `between` openings can be
  // positioned without knowing where the run started.
  for (const run of runs) {
    run.parts = run.parts.map((p) => ({ ...p, u0: p.u0 - run.u0, u1: p.u1 - run.u0 }));
  }
  return runs;
}

/* ------------------------------------------------------------------- roof */

function buildRoof(
  b: PlanBuilder,
  mat: MaterialLibrary,
  plan: NPlan,
  level: NLevel,
  roof: PlanRoof,
): void {
  const bounds = polygonBounds(level.outline);
  const overhang = roof.overhang ?? DEFAULT_OVERHANG;
  const thickness = roof.thickness ?? DEFAULT_ROOF_THICKNESS;
  const outer: Rect = {
    x0: bounds.x0 - overhang,
    x1: bounds.x1 + overhang,
    z0: bounds.z0 - overhang,
    z1: bounds.z1 + overhang,
  };
  const eave = roof.eaveHeight;

  if (roof.kind === 'flat') {
    const parts = plate(outer, eave - thickness, eave, []);
    b.mesh(level.id, 'roof', 'deck', parts, mat.roof);
    if ((roof.parapet ?? 0) > 0) buildFlatParapet(b, mat, level, outer, eave, roof.parapet ?? 0);
    return;
  }

  const horizontal = roof.highSide === 'e' || roof.highSide === 'w';
  const span = horizontal ? bounds.x1 - bounds.x0 : bounds.z1 - bounds.z0;

  if (roof.kind === 'mono') {
    const rise =
      roof.ridgeHeight !== undefined
        ? roof.ridgeHeight - eave
        : Math.tan(((roof.slopeDeg ?? 0) * Math.PI) / 180) * span;
    const ridge = eave + rise;
    const pitch = Math.atan2(rise, span);
    const highLow = roof.highSide === 'n' || roof.highSide === 'w';

    const runLength = (horizontal ? outer.x1 - outer.x0 : outer.z1 - outer.z0) / Math.cos(pitch);
    const width = horizontal ? outer.z1 - outer.z0 : outer.x1 - outer.x0;

    const geometry = horizontal
      ? new THREE.BoxGeometry(runLength, thickness, width)
      : new THREE.BoxGeometry(width, thickness, runLength);
    // Sign matters: it decides which end of the slab is lifted. Getting it
    // backwards produces a roof that falls the wrong way and still looks like
    // a roof in a bounding box.
    if (horizontal) geometry.rotateZ(highLow ? -pitch : pitch);
    else geometry.rotateX(highLow ? pitch : -pitch);
    geometry.translate(
      (outer.x0 + outer.x1) / 2,
      (eave + ridge) / 2 - thickness / 2,
      (outer.z0 + outer.z1) / 2,
    );
    b.mesh(level.id, 'roof', 'pitch', [geometry], mat.roof);

    buildMonoInfill(b, mat, plan, level, bounds, eave, ridge, roof.highSide ?? 'n');
    if ((roof.parapet ?? 0) > 0) {
      buildMonoParapet(
        b,
        mat,
        level,
        outer,
        bounds,
        eave,
        ridge,
        roof.highSide ?? 'n',
        roof.parapet ?? 0,
      );
    }
    return;
  }

  /* gable */
  const axis: Axis2 =
    roof.ridgeAxis ?? (bounds.x1 - bounds.x0 >= bounds.z1 - bounds.z0 ? 'x' : 'z');
  const halfSpan = (axis === 'x' ? bounds.z1 - bounds.z0 : bounds.x1 - bounds.x0) / 2;
  const rise =
    roof.ridgeHeight !== undefined
      ? roof.ridgeHeight - eave
      : Math.tan(((roof.slopeDeg ?? 0) * Math.PI) / 180) * halfSpan;
  const ridge = eave + rise;
  const pitch = Math.atan2(rise, halfSpan);
  const slope = (halfSpan + overhang) / Math.cos(pitch);
  const length = (axis === 'x' ? outer.x1 - outer.x0 : outer.z1 - outer.z0);
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cz = (bounds.z0 + bounds.z1) / 2;

  for (const side of [1, -1] as const) {
    const geometry =
      axis === 'x'
        ? new THREE.BoxGeometry(length, thickness, slope)
        : new THREE.BoxGeometry(slope, thickness, length);
    if (axis === 'x') geometry.rotateX(side * pitch);
    else geometry.rotateZ(-side * pitch);
    geometry.translate(
      axis === 'x' ? cx : cx + (side * (halfSpan + overhang)) / 2,
      (eave + ridge) / 2 - thickness / 2,
      axis === 'x' ? cz + (side * (halfSpan + overhang)) / 2 : cz,
    );
    b.mesh(level.id, 'roof', side > 0 ? 'pitch_a' : 'pitch_b', [geometry], mat.roof);
  }

  buildGableEnds(b, mat, plan, level, bounds, axis, eave, ridge);
}

/**
 * Fills the wedge between the top of the exterior walls and a mono-pitch roof:
 * a rectangular band on the high side and a triangle on each flanking side.
 * Without it the top storey is open along three edges.
 */
function buildMonoInfill(
  b: PlanBuilder,
  mat: MaterialLibrary,
  plan: NPlan,
  level: NLevel,
  bounds: Rect,
  eave: number,
  ridge: number,
  highSide: PlanSide,
): void {
  const t = plan.tExt;
  const horizontal = highSide === 'e' || highSide === 'w';
  const cl: Rect = {
    x0: bounds.x0 + t / 2,
    x1: bounds.x1 - t / 2,
    z0: bounds.z0 + t / 2,
    z1: bounds.z1 - t / 2,
  };

  if (horizontal) {
    const x = highSide === 'w' ? cl.x0 : cl.x1;
    b.mesh(
      level.id,
      'roof',
      'upstand',
      [boxGeom(t, ridge - eave, cl.z1 - cl.z0 + t, x, (eave + ridge) / 2, (cl.z0 + cl.z1) / 2)],
      mat.wall,
    );
    for (const z of [cl.z0, cl.z1]) {
      const shape = new THREE.Shape();
      const near = highSide === 'w' ? cl.x0 : cl.x1;
      shape.moveTo(cl.x0, eave);
      shape.lineTo(cl.x1, eave);
      shape.lineTo(near, ridge);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
      geometry.translate(0, 0, z - t / 2);
      b.mesh(level.id, 'roof', z === cl.z0 ? 'gable_north' : 'gable_south', [geometry], mat.wall);
    }
    return;
  }

  const z = highSide === 'n' ? cl.z0 : cl.z1;
  b.mesh(
    level.id,
    'roof',
    'upstand',
    [boxGeom(cl.x1 - cl.x0 + t, ridge - eave, t, (cl.x0 + cl.x1) / 2, (eave + ridge) / 2, z)],
    mat.wall,
  );
  for (const x of [cl.x0, cl.x1]) {
    // Shape coordinates are (z, y); rotateY(-90°) sends local +Z to -X and the
    // shape's own X to world Z, which keeps the profile unmirrored.
    const near = highSide === 'n' ? cl.z0 : cl.z1;
    const shape = new THREE.Shape();
    shape.moveTo(cl.z0, eave);
    shape.lineTo(cl.z1, eave);
    shape.lineTo(near, ridge);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    geometry.rotateY(-Math.PI / 2);
    geometry.translate(x + t / 2, 0, 0);
    b.mesh(level.id, 'roof', x === cl.x0 ? 'gable_west' : 'gable_east', [geometry], mat.wall);
  }
}

/** The triangular walls at the two ends a gable ridge runs between. */
function buildGableEnds(
  b: PlanBuilder,
  mat: MaterialLibrary,
  plan: NPlan,
  level: NLevel,
  bounds: Rect,
  axis: Axis2,
  eave: number,
  ridge: number,
): void {
  const t = plan.tExt;
  const cl: Rect = {
    x0: bounds.x0 + t / 2,
    x1: bounds.x1 - t / 2,
    z0: bounds.z0 + t / 2,
    z1: bounds.z1 - t / 2,
  };

  if (axis === 'x') {
    // Ridge runs east-west, so the gables close the west and east ends. Shape
    // coordinates are (z, y); rotateY(-90°) maps the shape's own X onto world
    // Z without mirroring the profile.
    for (const x of [cl.x0, cl.x1]) {
      const shape = new THREE.Shape();
      shape.moveTo(cl.z0, eave);
      shape.lineTo(cl.z1, eave);
      shape.lineTo((cl.z0 + cl.z1) / 2, ridge);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
      geometry.rotateY(-Math.PI / 2);
      geometry.translate(x + t / 2, 0, 0);
      b.mesh(level.id, 'roof', x === cl.x0 ? 'gable_west' : 'gable_east', [geometry], mat.wall);
    }
    return;
  }

  for (const z of [cl.z0, cl.z1]) {
    const shape = new THREE.Shape();
    shape.moveTo(cl.x0, eave);
    shape.lineTo(cl.x1, eave);
    shape.lineTo((cl.x0 + cl.x1) / 2, ridge);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
    geometry.translate(0, 0, z - t / 2);
    b.mesh(level.id, 'roof', z === cl.z0 ? 'gable_north' : 'gable_south', [geometry], mat.wall);
  }
}

function buildFlatParapet(
  b: PlanBuilder,
  mat: MaterialLibrary,
  level: NLevel,
  outer: Rect,
  top: number,
  parapet: number,
): void {
  const w = 0.12;
  const parts = [
    boxGeom(outer.x1 - outer.x0, parapet, w, (outer.x0 + outer.x1) / 2, top + parapet / 2, outer.z0),
    boxGeom(outer.x1 - outer.x0, parapet, w, (outer.x0 + outer.x1) / 2, top + parapet / 2, outer.z1),
    boxGeom(w, parapet, outer.z1 - outer.z0, outer.x0, top + parapet / 2, (outer.z0 + outer.z1) / 2),
    boxGeom(w, parapet, outer.z1 - outer.z0, outer.x1, top + parapet / 2, (outer.z0 + outer.z1) / 2),
  ];
  b.mesh(level.id, 'roof', 'parapet', parts, mat.wall);
}

function buildMonoParapet(
  b: PlanBuilder,
  mat: MaterialLibrary,
  level: NLevel,
  outer: Rect,
  bounds: Rect,
  eave: number,
  ridge: number,
  highSide: PlanSide,
  parapet: number,
): void {
  const w = 0.12;
  const horizontal = highSide === 'e' || highSide === 'w';
  const span = horizontal ? bounds.x1 - bounds.x0 : bounds.z1 - bounds.z0;
  const slope = (ridge - eave) / span;

  const heightAt = (x: number, z: number): number => {
    if (horizontal) {
      const d = highSide === 'w' ? x - bounds.x0 : bounds.x1 - x;
      return ridge - slope * d;
    }
    const d = highSide === 'n' ? z - bounds.z0 : bounds.z1 - z;
    return ridge - slope * d;
  };

  const parts: THREE.BufferGeometry[] = [];
  const corners: Array<[PlanPoint, PlanPoint]> = [
    [[outer.x0, outer.z0], [outer.x1, outer.z0]],
    [[outer.x1, outer.z0], [outer.x1, outer.z1]],
    [[outer.x1, outer.z1], [outer.x0, outer.z1]],
    [[outer.x0, outer.z1], [outer.x0, outer.z0]],
  ];
  for (const [from, to] of corners) {
    parts.push(
      slopedBar(from, to, heightAt(from[0], from[1]), heightAt(to[0], to[1]), w, parapet),
    );
  }
  b.mesh(level.id, 'roof', 'parapet', parts, mat.wall);
}

/* ------------------------------------------------------------------- site */

function buildSite(b: PlanBuilder, mat: MaterialLibrary, plan: NPlan): void {
  for (const item of plan.site) {
    const rect: Rect = {
      x0: Math.min(item.rect[0], item.rect[2]),
      x1: Math.max(item.rect[0], item.rect[2]),
      z0: Math.min(item.rect[1], item.rect[3]),
      z1: Math.max(item.rect[1], item.rect[3]),
    };
    const material =
      item.material === 'metal'
        ? mat.metal
        : item.material
          ? floorMaterial(item.material, mat)
          : mat.floorTile;

    if (item.kind === 'terrace') {
      b.mesh('site', item.id, 'paving', plate(rect, item.level - 0.14, item.level, []), material, {
        cast: false,
        receive: true,
        alwaysVisible: true,
      });
      continue;
    }

    if (item.kind === 'volume') {
      const height = item.height ?? 2.5;
      b.mesh(
        'site',
        item.id,
        'volume',
        [
          boxGeom(
            rect.x1 - rect.x0,
            height,
            rect.z1 - rect.z0,
            (rect.x0 + rect.x1) / 2,
            item.level + height / 2,
            (rect.z0 + rect.z1) / 2,
          ),
        ],
        mat.wall,
        { alwaysVisible: true },
      );
      continue;
    }

    if (item.kind === 'carport') {
      const height = item.height ?? 2.5;
      b.mesh('site', item.id, 'paving', plate(rect, item.level - 0.14, item.level, []), material, {
        cast: false,
        receive: true,
        alwaysVisible: true,
      });
      const post = 0.18;
      const posts: THREE.BufferGeometry[] = [];
      for (const x of [rect.x0 + post, rect.x1 - post]) {
        for (const z of [rect.z0 + post, rect.z1 - post]) {
          posts.push(boxGeom(post, height, post, x, item.level + height / 2, z));
        }
      }
      b.mesh('site', item.id, 'posts', posts, mat.metal, { alwaysVisible: true });
      continue;
    }

    /* step — a flight descending from `level` along the rectangle's long axis */
    const steps = item.steps ?? 3;
    const alongX = rect.x1 - rect.x0 >= rect.z1 - rect.z0;
    const run = (alongX ? rect.x1 - rect.x0 : rect.z1 - rect.z0) / steps;
    const rise = 0.17;
    const reversed = item.descend === 'w' || item.descend === 'n';
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < steps; i++) {
      const top = item.level - rise * i;
      const height = rise * (steps - i);
      const slot = reversed ? steps - 1 - i : i;
      const a = (alongX ? rect.x0 : rect.z0) + run * slot;
      const b2 = a + run;
      parts.push(
        alongX
          ? boxGeom(run, height, rect.z1 - rect.z0, (a + b2) / 2, top - height / 2, (rect.z0 + rect.z1) / 2)
          : boxGeom(rect.x1 - rect.x0, height, run, (rect.x0 + rect.x1) / 2, top - height / 2, (a + b2) / 2),
      );
    }
    b.mesh('site', item.id, 'steps', parts, material, {
      cast: true,
      receive: true,
      alwaysVisible: true,
    });
  }
}
