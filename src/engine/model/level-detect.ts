/**
 * Storey detection and node→storey assignment.
 *
 * Three sources of truth, in decreasing order of confidence:
 *
 *   1. `model.levels` in the card config — the user said so, we obey.
 *   2. Naming conventions that real exports actually use. Revit, Archicad and
 *      the German CAD world all stamp the storey into the node name
 *      (`level_1`, `Floor_02`, `EG`, `OG1`, `UG`, `L0`). When that is present it
 *      beats geometry, because a node's name knows which storey it belongs to
 *      even when its bounding box straddles two.
 *   3. Geometry. Floor slabs are the giveaway: horizontal, large in XZ, thin in
 *      Y. Histogram their world-space minY weighted by footprint area, cluster,
 *      and the clusters are the storeys.
 *
 * Level *names* are user-facing English strings; the card's localisation map
 * translates them at display time (see CLAUDE.md).
 */

import * as THREE from 'three';
import type { LevelDefinition } from '@/types/config';

/** Two slabs within this distance are the same storey. */
const CLUSTER_TOLERANCE = 0.4;
/** No real storey is shorter than this; closer clusters get merged. */
const MIN_STOREY_HEIGHT = 1.9;
/** Clusters carrying less than this share of the heaviest one are noise. */
const NOISE_RATIO = 0.12;
const DEFAULT_STOREY_HEIGHT = 2.9;

/* ----------------------------------------------------------- name parsing */

interface LevelHint {
  /** Storey index relative to ground: -1 = basement, 0 = ground, 1 = first. */
  order: number;
}

/**
 * `(?![0-9a-z])` rather than `\b` on purpose: `level_1_walls` must match with
 * order 1, and `_` counts as a word character so `\b` would fail there.
 */
const LEVEL_PATTERNS: ReadonlyArray<{
  re: RegExp;
  order: (m: RegExpMatchArray) => number;
}> = [
  {
    re: /^(?:level|floor|storey|story|etage|geschoss|stock)[ _\-.]?(-?\d+)(?![0-9a-z])/,
    order: (m) => Number(m[1]),
  },
  { re: /^l(-?\d+)(?![0-9a-z])/, order: (m) => Number(m[1]) },
  { re: /^(?:ug|kg)(\d*)(?![0-9a-z])/, order: (m) => -Number(m[1] || '1') },
  {
    re: /^(?:keller|basement|untergeschoss|cellar)(\d*)(?![0-9a-z])/,
    order: (m) => -Number(m[1] || '1'),
  },
  { re: /^(?:eg|gf|erdgeschoss|ground)(?![0-9a-z])/, order: () => 0 },
  { re: /^(?:og|obergeschoss|upper)(\d*)(?![0-9a-z])/, order: (m) => Number(m[1] || '1') },
  { re: /^(?:dg|dachgeschoss|attic|dach|roof)(?![0-9a-z])/, order: () => 90 },
  { re: /^(\d+)(?:st|nd|rd|th)[ _\-.]?floor(?![0-9a-z])/, order: (m) => Number(m[1]) },
];

/** Reads a storey index out of a node name, or null when there is none. */
export function parseLevelHint(name: string): LevelHint | null {
  if (!name) return null;
  const segments = name.toLowerCase().split(/[/|]/);
  for (const segment of segments) {
    const token = segment.trim();
    if (!token) continue;
    for (const pattern of LEVEL_PATTERNS) {
      const match = token.match(pattern.re);
      if (match) return { order: pattern.order(match) };
    }
  }
  return null;
}

/* ------------------------------------------------------------- utilities */

function asMesh(object: THREE.Object3D): THREE.Mesh | null {
  return (object as Partial<THREE.Mesh>).isMesh === true ? (object as THREE.Mesh) : null;
}

/** World-space AABB of a single mesh's own geometry (children excluded). */
function meshBounds(mesh: THREE.Mesh): THREE.Box3 | null {
  const geometry = mesh.geometry;
  if (!geometry) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return null;
  return box.clone().applyMatrix4(mesh.matrixWorld);
}

/**
 * Bounds of the *building*, ignoring `alwaysVisible` site geometry.
 *
 * This matters more than it looks: the terrain plane is 60 m across, and these
 * bounds drive the section planes' travel and the camera's framing. Including
 * the ground would put the cut planes 30 m from the house and frame the model
 * as a speck. Falls back to the full bounds if the model is nothing but site.
 */
export function computeModelBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const walk = (object: THREE.Object3D): void => {
    if (object.userData?.alwaysVisible === true) return;
    const mesh = asMesh(object);
    if (mesh) {
      const meshBox = meshBounds(mesh);
      if (meshBox) box.union(meshBox);
    }
    for (const child of object.children) walk(child);
  };
  walk(root);
  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function levelIdentity(order: number): { id: string; name: string; icon: string } {
  if (order === 90) return { id: 'attic', name: 'Attic', icon: 'mdi:home-roof' };
  if (order === 0) return { id: 'ground', name: 'Ground floor', icon: 'mdi:home-floor-g' };
  if (order < 0) {
    const depth = -order;
    return {
      id: depth === 1 ? 'basement' : `basement_${depth}`,
      name: depth === 1 ? 'Basement' : `Basement ${depth}`,
      icon: 'mdi:home-floor-b',
    };
  }
  return {
    id: `level_${order}`,
    name: `${ordinal(order)} floor`,
    icon: order <= 3 ? `mdi:home-floor-${order}` : 'mdi:home-floor-a',
  };
}

/** Half-open `[elevation, elevation + height)`, clamped outside the building. */
export function levelAtY(levels: readonly LevelDefinition[], y: number): LevelDefinition | null {
  if (levels.length === 0) return null;
  for (const level of levels) {
    if (y >= level.elevation && y < level.elevation + level.height) return level;
  }
  return y < levels[0].elevation ? levels[0] : levels[levels.length - 1];
}

/**
 * Turns a `nodes` entry from the config into a predicate. Supports an exact
 * name, a path/underscore prefix (`ground` matches `ground/kitchen/floor`) and
 * `*`/`?` globs.
 */
function compileNodeMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => false;
  if (p.includes('*') || p.includes('?')) {
    const source = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const re = new RegExp(`^${source}$`, 'i');
    return (name) => re.test(name);
  }
  const lower = p.toLowerCase();
  return (name) => {
    const n = name.toLowerCase();
    return n === lower || n.startsWith(`${lower}/`) || n.startsWith(`${lower}_`);
  };
}

/* ----------------------------------------------------------- detectLevels */

/**
 * Normalises what the user wrote: sorted bottom-up, every height positive, no
 * duplicate ids. Deliberately non-destructive — unknown extra fields survive.
 */
function normaliseExplicit(explicit: readonly LevelDefinition[]): LevelDefinition[] {
  const seen = new Set<string>();
  const levels = explicit
    .filter((level) => typeof level?.id === 'string' && level.id.length > 0)
    .map((level) => ({ ...level }))
    .filter((level) => {
      if (seen.has(level.id)) return false;
      seen.add(level.id);
      return true;
    })
    .sort((a, b) => a.elevation - b.elevation);

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (!(level.height > 0)) {
      const next = levels[i + 1];
      level.height = next ? Math.max(next.elevation - level.elevation, 0.1) : DEFAULT_STOREY_HEIGHT;
    }
    if (!level.name) level.name = level.id;
  }
  return levels;
}

interface Cluster {
  y: number;
  weight: number;
}

function collectSlabSamples(root: THREE.Object3D): Cluster[] {
  const samples: Cluster[] = [];
  root.traverse((object) => {
    if (object.userData?.alwaysVisible === true) return;
    const mesh = asMesh(object);
    if (!mesh) return;
    const box = meshBounds(mesh);
    if (!box) return;
    const dx = box.max.x - box.min.x;
    const dy = box.max.y - box.min.y;
    const dz = box.max.z - box.min.z;
    const area = dx * dz;
    if (area < 0.5) return;
    // Slab-like = wide and thin. Everything else still votes, but weakly, so a
    // model made entirely of walls still produces storeys.
    const slabLike = dy < 0.6 || dy < 0.15 * Math.max(dx, dz);
    samples.push({ y: box.min.y, weight: area * (slabLike ? 1 : 0.12) });
  });
  return samples;
}

function clusterSamples(samples: Cluster[]): Cluster[] {
  if (samples.length === 0) return [];
  const sorted = samples.slice().sort((a, b) => a.y - b.y);

  const clusters: Cluster[] = [];
  let startY = sorted[0].y;
  let weight = 0;
  let weightedY = 0;

  const flush = () => {
    if (weight > 0) clusters.push({ y: weightedY / weight, weight });
  };

  for (const sample of sorted) {
    if (sample.y - startY > CLUSTER_TOLERANCE) {
      flush();
      startY = sample.y;
      weight = 0;
      weightedY = 0;
    }
    weight += sample.weight;
    weightedY += sample.y * sample.weight;
  }
  flush();

  // Collapse clusters that are too close to be separate storeys — a slab and
  // the screed on top of it, or a split-level threshold.
  const merged: Cluster[] = [];
  for (const cluster of clusters) {
    const previous = merged[merged.length - 1];
    if (previous && cluster.y - previous.y < MIN_STOREY_HEIGHT) {
      if (cluster.weight > previous.weight) previous.y = cluster.y;
      previous.weight += cluster.weight;
      continue;
    }
    merged.push({ ...cluster });
  }

  const heaviest = merged.reduce((max, c) => Math.max(max, c.weight), 0);
  return merged.filter((cluster) => cluster.weight >= heaviest * NOISE_RATIO);
}

function levelsFromElevations(elevations: number[], topY: number): LevelDefinition[] {
  // The storey closest to y = 0 is "ground"; everything else counts from it.
  let groundIndex = 0;
  let best = Infinity;
  elevations.forEach((y, i) => {
    const distance = Math.abs(y);
    if (distance < best) {
      best = distance;
      groundIndex = i;
    }
  });

  return elevations.map((elevation, i) => {
    const next = elevations[i + 1];
    const height = next
      ? next - elevation
      : Math.max(topY - elevation, DEFAULT_STOREY_HEIGHT);
    const identity = levelIdentity(i - groundIndex);
    return { ...identity, elevation, height };
  });
}

/**
 * Groups nodes by the storey index in their names. Only trusted when at least
 * two distinct storeys turn up — a single `roof` node is not a naming scheme.
 */
function levelsFromNames(root: THREE.Object3D, topY: number): LevelDefinition[] | null {
  const byOrder = new Map<number, THREE.Box3>();

  const walk = (object: THREE.Object3D): void => {
    if (object.userData?.alwaysVisible === true) return;
    const hint = parseLevelHint(object.name);
    if (hint) {
      const box = new THREE.Box3().setFromObject(object);
      if (!box.isEmpty()) {
        const existing = byOrder.get(hint.order);
        if (existing) existing.union(box);
        else byOrder.set(hint.order, box);
      }
      return;
    }
    for (const child of object.children) walk(child);
  };
  walk(root);

  if (byOrder.size < 2) return null;

  const orders = [...byOrder.keys()].sort((a, b) => a - b);
  const elevations = orders.map((order) => {
    const box = byOrder.get(order);
    return box ? box.min.y : 0;
  });

  return orders.map((order, i) => {
    const next = elevations[i + 1];
    const height = next
      ? next - elevations[i]
      : Math.max(topY - elevations[i], DEFAULT_STOREY_HEIGHT);
    const identity = levelIdentity(order);
    return { ...identity, elevation: elevations[i], height: Math.max(height, 0.5) };
  });
}

export function detectLevels(
  root: THREE.Object3D,
  explicit?: LevelDefinition[],
): LevelDefinition[] {
  if (explicit && explicit.length > 0) {
    const normalised = normaliseExplicit(explicit);
    if (normalised.length > 0) return normalised;
  }

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  if (bounds.isEmpty()) {
    return [{ ...levelIdentity(0), elevation: 0, height: DEFAULT_STOREY_HEIGHT }];
  }

  const byName = levelsFromNames(root, bounds.max.y);
  if (byName && byName.length > 0) return byName;

  const clusters = clusterSamples(collectSlabSamples(root));
  if (clusters.length > 0) {
    return levelsFromElevations(
      clusters.map((cluster) => cluster.y),
      bounds.max.y,
    );
  }

  // Nothing convincing: one storey covering the whole model. Better a single
  // usable level than a level selector full of nonsense.
  return [
    {
      ...levelIdentity(0),
      elevation: bounds.min.y,
      height: Math.max(bounds.max.y - bounds.min.y, DEFAULT_STOREY_HEIGHT),
    },
  ];
}

/* ---------------------------------------------------- assignNodesToLevels */

/**
 * Buckets the scene graph by storey and stamps `userData.level` on everything,
 * so the rest of the engine never has to parse a name again.
 *
 * Assignment is made as high up the tree as possible: whenever a node can be
 * resolved, its whole subtree goes with it and recursion stops. That keeps
 * `setVisibleLevels` down to a handful of `.visible` writes instead of a
 * per-mesh traversal.
 *
 * Subtrees flagged `userData.alwaysVisible` (terrain, site furniture) are
 * skipped entirely — they belong to no storey and must survive level isolation.
 */
export function assignNodesToLevels(
  root: THREE.Object3D,
  levels: LevelDefinition[],
): Map<string, THREE.Object3D[]> {
  const result = new Map<string, THREE.Object3D[]>();
  for (const level of levels) result.set(level.id, []);
  if (levels.length === 0) return result;

  root.updateMatrixWorld(true);

  const ids = new Set(levels.map((level) => level.id));
  const matchers = levels
    .filter((level) => level.nodes && level.nodes.length > 0)
    .map((level) => ({
      id: level.id,
      test: (level.nodes ?? []).map(compileNodeMatcher),
    }));

  // Storey index -> level, so a name hint can be resolved to a real level.
  let groundIndex = 0;
  let best = Infinity;
  levels.forEach((level, i) => {
    const distance = Math.abs(level.elevation);
    if (distance < best) {
      best = distance;
      groundIndex = i;
    }
  });
  const byOrder = new Map<number, string>();
  levels.forEach((level, i) => byOrder.set(i - groundIndex, level.id));

  const assign = (object: THREE.Object3D, levelId: string): void => {
    result.get(levelId)?.push(object);
    object.traverse((child) => {
      child.userData.level = levelId;
    });
  };

  const directId = (object: THREE.Object3D): string | null => {
    for (const matcher of matchers) {
      if (matcher.test.some((test) => test(object.name))) return matcher.id;
    }
    const stamped = object.userData?.level;
    if (typeof stamped === 'string' && ids.has(stamped)) return stamped;
    const hint = parseLevelHint(object.name);
    if (hint) {
      const byHint = byOrder.get(hint.order);
      if (byHint) return byHint;
      // Out-of-range hints (an attic marked 90 in a two-storey model) land on
      // the nearest real storey rather than being dropped.
      return hint.order > 0 ? levels[levels.length - 1].id : levels[0].id;
    }
    return null;
  };

  const walk = (object: THREE.Object3D): void => {
    if (object.userData?.alwaysVisible === true) return;

    const id = directId(object);
    if (id) {
      assign(object, id);
      return;
    }
    if (object.children.length > 0) {
      for (const child of [...object.children]) walk(child);
      return;
    }

    const mesh = asMesh(object);
    const box = mesh ? meshBounds(mesh) : null;
    if (!box) return;
    // The top of an object is what places it: a floor slab's underside sits in
    // the storey below, but its finished surface is what you stand on.
    const level = levelAtY(levels, box.max.y - 1e-4);
    if (level) assign(object, level.id);
  };

  for (const child of [...root.children]) walk(child);
  return result;
}
