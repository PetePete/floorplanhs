/**
 * Room fill: a lamp that is on tints its whole room evenly — floor, walls,
 * ceiling and furniture — instead of casting a physically correct pool of
 * light around itself.
 *
 * ## Why this is not done with three.js lights
 *
 * A real light has no idea what a room is. Making one stop at a wall needs a
 * shadow map, and a shadow-casting point light costs six cube-face passes per
 * refresh — the single most expensive thing this card can do, and the reason
 * shadows are off by default. Turning them on for every lamp just to get a
 * crisp room boundary would be backwards.
 *
 * ## How it works instead
 *
 * The room boundary is resolved once, at load, and baked into the geometry:
 * every vertex gets a room index. A single merged overlay mesh then re-draws
 * every surface that belongs to a room, translucent, with the room's fill
 * colour looked up per fragment from one uniform array.
 *
 * An overlay rather than a change to the surface materials, because the default
 * style is a hidden-line drawing: there, the real surfaces write depth but no
 * colour, so anything shaded onto them is invisible by construction. The
 * overlay works in both styles, is one draw call, and is a shader this file
 * owns end to end — no splicing into three.js's own chunks, which fails
 * silently whenever they are renamed.
 *
 * ## Walls
 *
 * Floors, ceilings and furniture carry `userData.room` from the model builders.
 * Walls do not: they are merged into one mesh per storey, and Sweet Home 3D
 * records no wall-to-room association at all — a wall's two faces belong to two
 * different rooms, so there is no answer at mesh level.
 *
 * They are handled by `slotAt`, which the edge overlay calls per line vertex.
 * The test is boundary-inclusive on purpose: a wall's inner face lies exactly
 * on the room polygon it faces, while its outer face is a wall thickness
 * beyond, so each side of a shared wall resolves to the room it looks at
 * without any offsetting or guesswork. That is also why this does not try to
 * step along vertex normals — a wall's *corner* vertices sit at the building
 * corner, outside the room in the perpendicular axis, and no offset along the
 * face normal brings them back in.
 */

import * as THREE from 'three';
import type { LevelDefinition } from '@/types/config';

/**
 * Rooms per model. Sized to cover a large house; the uniform array costs
 * MAX_ROOMS * 3 floats whether or not they are used, and beyond this the
 * remaining rooms simply never light rather than the shader failing to compile.
 */
export const MAX_ROOMS = 24;

/** Vertex attribute holding the 1-based room index; 0 means "no room". */
const ROOM_ATTRIBUTE = 'fpRoom';

/** Rooms are open at the top of their storey; slabs sit slightly outside it. */
const LEVEL_SLACK_M = 0.12;

/** Meshes of this pseudo-room carry no room of their own. See the module note. */
const STRUCTURE_ROOM = 'structure';

/** Per-room accumulator layout: r, g, b, summed weight, peak weight. */
const ACC_STRIDE = 5;

/** Room names are user text and may contain anything but a NUL. */
const KEY_SEPARATOR = '\u0000';

function roomKey(level: string, room: string): string {
  return `${level}${KEY_SEPARATOR}${room}`;
}

interface RoomShape {
  level: string;
  room: string;
  /** Floor polygon as world-space XZ triangles, flat: [ax,az,bx,bz,cx,cz, …]. */
  triangles: Float32Array;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

/**
 * What the edge overlay needs to draw a lit room's lines in its light colour.
 * Deliberately narrow: the overlay must not be able to reach into the room
 * index and mutate it.
 */
export interface RoomFillSource {
  /** Room slot for a mesh that declares one, or -1. */
  slotForMesh(mesh: THREE.Object3D): number;
  /**
   * Room slot for a world point, or -1. Boundary-inclusive, which is what makes
   * it usable on wall geometry: a wall's inner face lies exactly on the room
   * polygon it faces, and its outer face a wall thickness beyond it.
   */
  slotAt(x: number, y: number, z: number): number;
  /** Name of the room a world point falls in, or null when it is outside. */
  roomNameAt(x: number, y: number, z: number): string | null;
  /** Current fill of a slot into `out`; returns its 0..1 level, 0 when dark. */
  levelInto(slot: number, out: THREE.Color): number;
}

/** One lamp's contribution, in linear RGB already scaled by its weight. */
export interface RoomFillLight {
  room: string | null;
  level: string | null;
  position: THREE.Vector3;
  color: THREE.Color;
  weight: number;
}

/**
 * How opaque a fully lit room's floor tint is. Deliberately faint: it says
 * *where* the light is, the coloured edges say *that* it is on. A stronger
 * value turns the plan into a colour-block diagram and buries the drawing.
 */
const WASH_OPACITY = 0.16;

/**
 * Faces pointing away from the camera are drawn at a fraction of that. A room
 * is a box seen from outside: without this you look through the near wall's
 * back face *and* the far wall's front face and every room reads as double
 * strength, with the corners darkest of all.
 */
const WASH_BACKFACE = 0.45;

/**
 * The clipping chunks are included by hand. three.js splices them into its own
 * materials but leaves a `ShaderMaterial` alone — it only supplies the uniform
 * and `NUM_CLIPPING_PLANES` — so without these the overlay is the one thing in
 * the scene a cross-section does not cut, and a lit room bleeds straight
 * through the cut face.
 *
 * `clipping_planes_vertex` reads a variable literally named `mvPosition`, hence
 * the name below.
 */
const WASH_VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute float fpRoom;
flat varying float vFpRoom;
varying vec3 vFpNormal;
varying vec3 vFpView;
void main() {
  vFpRoom = fpRoom;
  vFpNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vFpView = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const WASH_FRAGMENT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
flat varying float vFpRoom;
varying vec3 vFpNormal;
varying vec3 vFpView;
uniform vec3 fpRoomFill[${MAX_ROOMS}];
uniform float fpWashOpacity;
void main() {
  #include <clipping_planes_fragment>
  int index = int(vFpRoom + 0.5) - 1;
  if (index < 0) discard;
  vec3 fill = fpRoomFill[index];
  float level = max(fill.r, max(fill.g, fill.b));
  if (level <= 0.001) discard;

  float facing = dot(normalize(vFpNormal), normalize(vFpView)) > 0.0 ? 1.0 : ${WASH_BACKFACE};
  // Normalise the hue out of the level so a dim lamp tints rather than greys.
  gl_FragColor = vec4(fill / level, clamp(level, 0.0, 1.0) * fpWashOpacity * facing);
}
`;

export class RoomFill {
  /** Shared by every patched material, so one write updates them all. */
  private readonly uniform = { value: new Float32Array(MAX_ROOMS * 3) };
  private readonly washOpacity = { value: WASH_OPACITY };
  private wash: THREE.Mesh | null = null;
  private washMaterial: THREE.ShaderMaterial | null = null;
  private readonly shapes: RoomShape[] = [];
  private readonly slotOf = new Map<string, number>();
  private enabled = false;
  private strength = 1;
  private visibleLevels: Set<string> | null = null;
  /** Set when the uniform no longer matches the lights; cleared by `flush`. */
  private dirty = false;

  /* ----------------------------------------------------------------- model */

  /**
   * Index the rooms of a freshly loaded model and prepare its geometry. Safe to
   * call with the same model twice; stamping is idempotent per geometry.
   */
  setModel(
    root: THREE.Object3D | null,
    levels: readonly LevelDefinition[],
    clippingPlanes: THREE.Plane[] | null = null,
  ): void {
    this.clearModel();
    if (!root) return;

    root.updateMatrixWorld(true);
    const byRoom = collectRoomMeshes(root);
    const levelById = new Map(levels.map((l) => [l.id, l]));

    for (const [key, entry] of byRoom) {
      if (this.shapes.length >= MAX_ROOMS) break;
      const shape = buildShape(entry, levelById.get(entry.level));
      if (!shape) continue;
      this.slotOf.set(key, this.shapes.length);
      this.shapes.push(shape);
    }

    if (this.shapes.length === 0) return;

    this.buildWash(root, clippingPlanes);
  }

  /**
   * One merged overlay of the lit rooms' **floor areas**, in a single draw call.
   *
   * Floors only, and that is the whole point. A room is a box: tint its walls
   * and ceiling too and every pixel is covered three or four times over — near
   * wall's back face, far wall's front face, floor, ceiling — so the tint
   * stacks into a muddy fog that is darkest exactly in the corners. One flat
   * layer cannot do that. The walls carry the room's light as *line colour*
   * instead (see `EdgeOverlay`), which is what a line drawing has to offer.
   *
   * Positions are copied into world space rather than the floor meshes being
   * re-rendered with a second material, so this stays one draw call however
   * many rooms there are.
   */
  private buildWash(root: THREE.Object3D, clippingPlanes: THREE.Plane[] | null): void {
    const positions: number[] = [];
    const normals: number[] = [];
    const rooms: number[] = [];

    const vertex = new THREE.Vector3();
    const normal = new THREE.Vector3();

    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (mesh.userData.fp3dInternal === true) return;
      if (mesh.userData.part !== 'floor') return;

      const slot = this.slotForMesh(mesh);
      if (slot < 0) return;

      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      if (!position) return;
      const source = geometry.getAttribute('normal');
      const index = geometry.getIndex();
      const count = index ? index.count : position.count;

      for (let i = 0; i < count; i += 1) {
        const at = index ? index.getX(i) : i;
        rooms.push(slot + 1);
        vertex.fromBufferAttribute(position, at).applyMatrix4(mesh.matrixWorld);
        positions.push(vertex.x, vertex.y, vertex.z);
        if (source) {
          normal.fromBufferAttribute(source, at).transformDirection(mesh.matrixWorld);
          normals.push(normal.x, normal.y, normal.z);
        } else {
          normals.push(0, 1, 0);
        }
      }
    });

    if (positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute(ROOM_ATTRIBUTE, new THREE.Float32BufferAttribute(rooms, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: { fpRoomFill: this.uniform, fpWashOpacity: this.washOpacity },
      vertexShader: WASH_VERTEX,
      fragmentShader: WASH_FRAGMENT,
      transparent: true,
      // Never occlude, and never hide behind itself: this is a tint over
      // surfaces that already wrote the depth it is being tested against.
      depthWrite: false,
      side: THREE.DoubleSide,
      // Unconditional: the planes array is shared and starts empty, so deciding
      // this from its length at build time means the overlay is compiled
      // without clipping and never picks it up when a cut is made later.
      clipping: true,
    });
    if (clippingPlanes) material.clippingPlanes = clippingPlanes;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'roomFillWash';
    // Excluded from the section controller's ghost clone, the edge overlay and
    // picking: it mirrors geometry all three have already handled.
    mesh.userData.fp3dInternal = true;
    mesh.userData.noPick = true;
    mesh.renderOrder = 1;
    mesh.raycast = () => {};
    root.add(mesh);

    this.wash = mesh;
    this.washMaterial = material;
  }

  /* ---------------------------------------------------------------- lights */

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.dirty = true;
  }

  setStrength(strength: number): void {
    if (this.strength === strength) return;
    this.strength = strength;
    this.dirty = true;
  }

  /**
   * Recompute every room's fill from the current lamps. Cheap enough to run on
   * every frame that has any tweening light; there are only ever a handful.
   *
   * Two lamps in one room do not add up to twice the brightness — the room is
   * lit or it is not. The strongest one sets the level and the colours mix by
   * weight, which is what "the room is on" looks like.
   */
  apply(lights: Iterable<RoomFillLight>): void {
    if (this.shapes.length === 0) return;

    const acc = this.scratch();
    if (this.enabled) {
      for (const light of lights) {
        if (light.weight <= 1e-4) continue;
        const slot = this.slotFor(light);
        if (slot < 0) continue;
        const at = slot * ACC_STRIDE;
        acc[at] += light.color.r * light.weight;
        acc[at + 1] += light.color.g * light.weight;
        acc[at + 2] += light.color.b * light.weight;
        acc[at + 3] += light.weight;
        acc[at + 4] = Math.max(acc[at + 4], light.weight);
      }
    }

    const out = this.uniform.value;
    let changed = false;
    for (let i = 0; i < this.shapes.length; i += 1) {
      const shape = this.shapes[i];
      if (this.visibleLevels && shape.level && !this.visibleLevels.has(shape.level)) {
        if (out[i * 3] !== 0 || out[i * 3 + 1] !== 0 || out[i * 3 + 2] !== 0) changed = true;
        out[i * 3] = 0;
        out[i * 3 + 1] = 0;
        out[i * 3 + 2] = 0;
        continue;
      }
      const at = i * ACC_STRIDE;
      const total = acc[at + 3];
      // Colour is the weighted mean; level is the strongest lamp alone. Summing
      // would make a room with four lamps four times as bright as the same room
      // with one, which is not what "the room is on" looks like.
      const scale = total > 0 ? (acc[at + 4] * this.strength) / total : 0;
      const r = acc[at] * scale;
      const g = acc[at + 1] * scale;
      const b = acc[at + 2] * scale;
      if (out[i * 3] !== r || out[i * 3 + 1] !== g || out[i * 3 + 2] !== b) changed = true;
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    this.dirty = false;
    // Rewriting the edge colours walks every line vertex, so it happens on a
    // real change rather than on every frame the fill is recomputed.
    if (changed) this.onChange?.();
  }

  /** Hide the wash of a storey that is not on screen. */
  setVisibleLevels(levelIds: string[] | null): void {
    this.visibleLevels = levelIds && levelIds.length > 0 ? new Set(levelIds) : null;
    this.dirty = true;
  }

  /**
   * Room slot for a mesh, from the room its builder stamped on it. Structure
   * meshes return -1: a wall belongs to the rooms on *both* sides, so there is
   * no honest answer and its lines stay neutral.
   */
  slotForMesh(mesh: THREE.Object3D): number {
    const room = typeof mesh.userData.room === 'string' ? mesh.userData.room : '';
    if (!room || room === STRUCTURE_ROOM) return -1;
    const level = typeof mesh.userData.level === 'string' ? mesh.userData.level : '';
    return this.slotOf.get(roomKey(level, room)) ?? -1;
  }

  slotAt(x: number, y: number, z: number): number {
    return this.locate(x, y, z);
  }

  roomNameAt(x: number, y: number, z: number): string | null {
    const slot = this.locate(x, y, z);
    return slot < 0 ? null : this.shapes[slot].room;
  }

  /** Reads back what `apply` wrote. Returns the 0..1 level, 0 when unlit. */
  levelInto(slot: number, out: THREE.Color): number {
    if (slot < 0 || slot >= this.shapes.length) return 0;
    const at = slot * 3;
    const v = this.uniform.value;
    const level = Math.max(v[at], v[at + 1], v[at + 2]);
    if (level <= 0.001) return 0;
    // Hue without the level, so the caller decides how to spend the brightness.
    out.setRGB(v[at] / level, v[at + 1] / level, v[at + 2] / level, THREE.LinearSRGBColorSpace);
    return Math.min(level, 1);
  }

  /** Called after every `apply` that changed something. */
  onChange: (() => void) | null = null;

  /** True while the uniform is known to be stale (mode or strength changed). */
  get needsApply(): boolean {
    return this.dirty;
  }

  get roomCount(): number {
    return this.shapes.length;
  }

  /** Which room a world point falls in, or null. Exposed for placement UI. */
  roomAt(point: THREE.Vector3): string | null {
    const slot = this.locate(point.x, point.y, point.z);
    return slot < 0 ? null : this.shapes[slot].room;
  }

  dispose(): void {
    this.clearModel();
  }

  /* --------------------------------------------------------------- private */

  private slotFor(light: RoomFillLight): number {
    if (light.room) {
      const explicit = this.slotOf.get(roomKey(light.level ?? '', light.room));
      if (explicit !== undefined) return explicit;
      // A room name with no level qualifier still has to resolve.
      for (const [key, slot] of this.slotOf) {
        if (key.endsWith(`${KEY_SEPARATOR}${light.room}`)) return slot;
      }
    }
    return this.locate(light.position.x, light.position.y, light.position.z);
  }

  private locate(x: number, y: number, z: number): number {
    for (let i = 0; i < this.shapes.length; i += 1) {
      const s = this.shapes[i];
      // Same tolerance as the triangle test, or the cheap reject throws away
      // exactly the boundary hits that test exists to accept.
      if (x < s.minX - EDGE_TOLERANCE_M || x > s.maxX + EDGE_TOLERANCE_M) continue;
      if (z < s.minZ - EDGE_TOLERANCE_M || z > s.maxZ + EDGE_TOLERANCE_M) continue;
      if (y < s.minY || y > s.maxY) continue;
      if (pointInTriangles(s.triangles, x, z)) return i;
    }
    return -1;
  }

  private clearModel(): void {
    if (this.wash) {
      this.wash.removeFromParent();
      this.wash.geometry.dispose();
      this.wash = null;
    }
    this.washMaterial?.dispose();
    this.washMaterial = null;
    this.shapes.length = 0;
    this.slotOf.clear();
    this.uniform.value.fill(0);
  }

  private readonly accumulator = new Float32Array(MAX_ROOMS * ACC_STRIDE);
  private scratch(): Float32Array {
    this.accumulator.fill(0);
    return this.accumulator;
  }
}

/* ------------------------------------------------------------------ index */

interface RoomMeshes {
  level: string;
  room: string;
  floors: THREE.Mesh[];
  all: THREE.Mesh[];
}

function collectRoomMeshes(root: THREE.Object3D): Map<string, RoomMeshes> {
  const byRoom = new Map<string, RoomMeshes>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const room = typeof mesh.userData.room === 'string' ? mesh.userData.room : '';
    if (!room || room === STRUCTURE_ROOM) return;
    const level = typeof mesh.userData.level === 'string' ? mesh.userData.level : '';
    const key = roomKey(level, room);
    let entry = byRoom.get(key);
    if (!entry) {
      entry = { level, room, floors: [], all: [] };
      byRoom.set(key, entry);
    }
    entry.all.push(mesh);
    if (mesh.userData.part === 'floor') entry.floors.push(mesh);
  });
  return byRoom;
}

/**
 * The floor meshes *are* the room polygon — triangulated, in world space and
 * exact for any shape Sweet Home 3D can draw. Reconstructing an outline from
 * them would only lose information.
 */
function buildShape(
  entry: RoomMeshes,
  level: LevelDefinition | undefined,
): RoomShape | null {
  const sources = entry.floors.length > 0 ? entry.floors : entry.all;
  const triangles: number[] = [];
  const bounds = new THREE.Box3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (const mesh of sources) {
    const position = mesh.geometry.getAttribute('position');
    if (!position) continue;
    const index = mesh.geometry.getIndex();
    const triCount = index ? index.count / 3 : position.count / 3;
    for (let t = 0; t < triCount; t += 1) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, i2).applyMatrix4(mesh.matrixWorld);
      // A floor slab has sides and an underside; only its plan outline matters,
      // and degenerate-in-XZ triangles are exactly those vertical faces.
      if (Math.abs(triangleArea2D(a, b, c)) < 1e-6) continue;
      triangles.push(a.x, a.z, b.x, b.z, c.x, c.z);
    }
    bounds.expandByObject(mesh);
  }

  if (triangles.length === 0 || bounds.isEmpty()) return null;

  const minY = level ? level.elevation - LEVEL_SLACK_M : bounds.min.y - LEVEL_SLACK_M;
  const maxY = level ? level.elevation + level.height + LEVEL_SLACK_M : bounds.max.y + 3;

  return {
    level: entry.level,
    room: entry.room,
    triangles: new Float32Array(triangles),
    minX: bounds.min.x,
    maxX: bounds.max.x,
    minZ: bounds.min.z,
    maxZ: bounds.max.z,
    minY,
    maxY,
  };
}

function triangleArea2D(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  return (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
}

/**
 * How far outside a room polygon still counts as inside, in metres.
 *
 * A wall's inner face is meant to land exactly on the polygon it faces, but the
 * two numbers come from different places in the file — a wall thickness and a
 * traced outline — and float arithmetic finishes the job: 2.95 - 3.00 is not
 * -0.05. Without a tolerance a wall face resolves to no room roughly half the
 * time, at random.
 *
 * Comfortably under the thinnest interior wall, so the far face of a partition
 * is never pulled into the near room.
 */
const EDGE_TOLERANCE_M = 0.03;

/**
 * Point-in-polygon against a flat [ax,az,bx,bz,cx,cz, …] triangle list, with a
 * real distance tolerance.
 *
 * The cross products below are twice the triangle area, so dividing by the edge
 * length turns each into a signed distance from that edge — which is what lets
 * the tolerance be expressed in metres rather than in area units that would
 * mean something different for every triangle.
 */
function pointInTriangles(tri: Float32Array, x: number, z: number): boolean {
  for (let i = 0; i < tri.length; i += 6) {
    const ax = tri[i];
    const az = tri[i + 1];
    const bx = tri[i + 2];
    const bz = tri[i + 3];
    const cx = tri[i + 4];
    const cz = tri[i + 5];

    const d1 = edgeDistance(x, z, bx, bz, ax, az);
    const d2 = edgeDistance(x, z, cx, cz, bx, bz);
    const d3 = edgeDistance(x, z, ax, az, cx, cz);
    const hasNeg = d1 < -EDGE_TOLERANCE_M || d2 < -EDGE_TOLERANCE_M || d3 < -EDGE_TOLERANCE_M;
    const hasPos = d1 > EDGE_TOLERANCE_M || d2 > EDGE_TOLERANCE_M || d3 > EDGE_TOLERANCE_M;
    if (!(hasNeg && hasPos)) return true;
  }
  return false;
}

/** Signed distance from (x, z) to the line through (px, pz) and (qx, qz). */
function edgeDistance(
  x: number,
  z: number,
  px: number,
  pz: number,
  qx: number,
  qz: number,
): number {
  const ex = qx - px;
  const ez = qz - pz;
  const length = Math.hypot(ex, ez);
  if (length < 1e-9) return 0;
  return ((x - px) * ez - ex * (z - pz)) / length;
}
