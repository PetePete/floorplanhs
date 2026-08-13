/**
 * Thin, defensive helpers over the area/device/entity registries HA exposes on
 * the `hass` object. All three collections are optional: they only arrived in
 * 2023.x and are still absent for non-admin users on some setups, so every
 * lookup has to survive them being `undefined`.
 */

import type { LevelDefinition } from '@/types/config';
import type {
  HassArea,
  HassDevice,
  HassEntity,
  HassEntityRegistryEntry,
  HomeAssistant,
} from '@/types/hass';

export interface EntityOption {
  entity_id: string;
  name: string;
  /** Area name, not id — this is what a human recognises in a picker. */
  area: string | null;
  domain: string;
  icon: string;
}

export function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot) : '';
}

export function objectIdOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(dot + 1) : entityId;
}

/** `light.kitchen_ceiling_2` -> `Kitchen Ceiling 2`. */
export function prettifyEntityId(entityId: string): string {
  const words = objectIdOf(entityId).replace(/_/g, ' ').trim();
  if (!words) return entityId;
  return words
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function registryEntry(
  hass: HomeAssistant | undefined,
  entityId: string,
): HassEntityRegistryEntry | undefined {
  return hass?.entities?.[entityId];
}

/** The registry entry carries an `icon` on newer cores; the type predates it. */
function registryIcon(entry: HassEntityRegistryEntry | undefined): string | undefined {
  const icon = (entry as { icon?: string | null } | undefined)?.icon;
  return typeof icon === 'string' && icon ? icon : undefined;
}

export function getDeviceForEntity(
  hass: HomeAssistant | undefined,
  entityId: string,
): HassDevice | null {
  const entry = registryEntry(hass, entityId);
  if (!entry?.device_id) return null;
  return hass?.devices?.[entry.device_id] ?? null;
}

/**
 * An entity's area is either set directly on the entity or inherited from its
 * device. HA resolves it in exactly this order, and getting it wrong makes
 * entities show up in the wrong room in the picker.
 */
export function getAreaForEntity(
  hass: HomeAssistant | undefined,
  entityId: string,
): HassArea | null {
  const areas = hass?.areas;
  if (!areas) return null;
  const entry = registryEntry(hass, entityId);
  if (entry?.area_id) return areas[entry.area_id] ?? null;
  const device = getDeviceForEntity(hass, entityId);
  if (device?.area_id) return areas[device.area_id] ?? null;
  return null;
}

export function getAreaName(hass: HomeAssistant | undefined, entityId: string): string | null {
  return getAreaForEntity(hass, entityId)?.name ?? null;
}

/**
 * Display name, in HA's own precedence: registry override, then the state
 * object's friendly name, then a prettified entity id.
 */
export function getEntityName(hass: HomeAssistant | undefined, entityId: string): string {
  const override = registryEntry(hass, entityId)?.name;
  if (typeof override === 'string' && override.trim()) return override;

  const friendly = hass?.states?.[entityId]?.attributes?.friendly_name;
  if (typeof friendly === 'string' && friendly.trim()) return friendly;

  return prettifyEntityId(entityId);
}

/* --------------------------------------------------------------- indexing */

interface IndexedEntity extends EntityOption {
  idLower: string;
  nameLower: string;
  areaLower: string;
  objectIdLower: string;
}

interface EntityIndex {
  items: IndexedEntity[];
  /** Cache key: registries are replaced wholesale when they change. */
  count: number;
  areasRef: unknown;
  devicesRef: unknown;
  entitiesRef: unknown;
}

let cachedIndex: EntityIndex | null = null;

/**
 * Rebuilding a 2000-entity index on every keystroke is the difference between a
 * palette that feels instant and one that stutters. The registries are frozen
 * objects replaced on change, so reference identity plus the state count is a
 * sound and near-free cache key — `hass.states` itself is replaced on every
 * state change and must not be part of it.
 */
function buildIndex(hass: HomeAssistant | undefined): IndexedEntity[] {
  const states = hass?.states ?? {};
  const ids = Object.keys(states);

  if (
    cachedIndex &&
    cachedIndex.count === ids.length &&
    cachedIndex.areasRef === hass?.areas &&
    cachedIndex.devicesRef === hass?.devices &&
    cachedIndex.entitiesRef === hass?.entities
  ) {
    return cachedIndex.items;
  }

  const items: IndexedEntity[] = [];
  for (const entityId of ids) {
    const entry = registryEntry(hass, entityId);
    // Hidden and diagnostic entities only add noise to a floorplan picker.
    if (entry?.hidden_by) continue;

    const name = getEntityName(hass, entityId);
    const area = getAreaName(hass, entityId);
    const attrIcon = states[entityId]?.attributes?.icon;
    items.push({
      entity_id: entityId,
      name,
      area,
      domain: domainOf(entityId),
      icon: (typeof attrIcon === 'string' && attrIcon) || registryIcon(entry) || '',
      idLower: entityId.toLowerCase(),
      nameLower: name.toLowerCase(),
      areaLower: (area ?? '').toLowerCase(),
      objectIdLower: objectIdOf(entityId).toLowerCase(),
    });
  }

  cachedIndex = {
    items,
    count: ids.length,
    areasRef: hass?.areas,
    devicesRef: hass?.devices,
    entitiesRef: hass?.entities,
  };
  return items;
}

/** Test hook / cleanup for cards being torn down. */
export function clearRegistryCache(): void {
  cachedIndex = null;
}

function compareOptions(a: EntityOption, b: EntityOption): number {
  // Entities without an area sort last; they are the ones a user has not
  // organised yet and are least likely to be what they are looking for.
  const areaA = a.area ?? '￿';
  const areaB = b.area ?? '￿';
  if (areaA !== areaB) return areaA.localeCompare(areaB);
  return a.name.localeCompare(b.name);
}

function stripIndex(item: IndexedEntity): EntityOption {
  return {
    entity_id: item.entity_id,
    name: item.name,
    area: item.area,
    domain: item.domain,
    icon: item.icon,
  };
}

export function listEntitiesByDomain(
  hass: HomeAssistant | undefined,
  domains: string[],
): EntityOption[] {
  const wanted = new Set(domains.map((d) => d.toLowerCase()));
  const items = buildIndex(hass)
    .filter((item) => wanted.size === 0 || wanted.has(item.domain))
    .map(stripIndex);
  return items.sort(compareOptions);
}

/* ----------------------------------------------------------------- search */

const RANK_PREFIX = 0;
const RANK_WORD = 1;
const RANK_SUBSTRING = 2;
const RANK_AREA = 3;
const RANK_FUZZY = 4;
const RANK_NONE = 99;

/** Every query character appears in order — the classic editor-style match. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

function rankEntity(item: IndexedEntity, query: string): number {
  if (item.nameLower.startsWith(query) || item.idLower.startsWith(query)) return RANK_PREFIX;
  if (item.objectIdLower.startsWith(query)) return RANK_PREFIX;
  // Word-boundary hit: "ceiling" should rank above "receiling".
  if (item.nameLower.includes(` ${query}`) || item.objectIdLower.includes(`_${query}`)) {
    return RANK_WORD;
  }
  if (item.nameLower.includes(query) || item.idLower.includes(query)) return RANK_SUBSTRING;
  if (item.areaLower && item.areaLower.includes(query)) return RANK_AREA;
  if (isSubsequence(query, item.nameLower) || isSubsequence(query, item.idLower)) return RANK_FUZZY;
  return RANK_NONE;
}

/**
 * Ranked lookup for the entity palette. Multi-word queries must match every
 * token ("kitchen light" -> the worst rank of the two), which is how people
 * actually narrow a search.
 */
export function searchEntities(
  hass: HomeAssistant | undefined,
  query: string,
  domains?: string[],
  limit = 60,
): EntityOption[] {
  const wanted = new Set((domains ?? []).map((d) => d.toLowerCase()));
  const items = buildIndex(hass).filter((i) => wanted.size === 0 || wanted.has(i.domain));

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return items.map(stripIndex).sort(compareOptions).slice(0, limit);

  const scored: { item: IndexedEntity; rank: number }[] = [];
  for (const item of items) {
    let worst = RANK_PREFIX;
    for (const token of tokens) {
      const rank = rankEntity(item, token);
      if (rank === RANK_NONE) {
        worst = RANK_NONE;
        break;
      }
      if (rank > worst) worst = rank;
    }
    if (worst !== RANK_NONE) scored.push({ item, rank: worst });
  }

  scored.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : compareOptions(a.item, b.item)));
  return scored.slice(0, limit).map((s) => stripIndex(s.item));
}

/* -------------------------------------------------------- level suggestion */

/**
 * Synonyms per storey, English and German (including the abbreviations HA users
 * type into area names: EG, OG, UG, DG).
 */
const LEVEL_HINTS: { key: string; words: string[] }[] = [
  {
    key: 'basement',
    words: ['basement', 'cellar', 'keller', 'untergeschoss', 'souterrain', 'ug', 'kg'],
  },
  {
    key: 'ground',
    words: [
      'ground',
      'ground floor',
      'main floor',
      'downstairs',
      'erdgeschoss',
      'parterre',
      'eg',
      'level 0',
    ],
  },
  {
    key: 'upper',
    words: [
      'upstairs',
      'upper',
      'first floor',
      'second floor',
      'obergeschoss',
      'og',
      '1og',
      '1. og',
      'level 1',
    ],
  },
  { key: 'attic', words: ['attic', 'loft', 'dachgeschoss', 'dachboden', 'dg', 'spitzboden'] },
];

/** Rooms that are conventionally on one storey — only used as a last resort. */
const ROOM_HINTS: { key: string; words: string[] }[] = [
  {
    key: 'ground',
    words: ['kitchen', 'küche', 'living', 'wohnzimmer', 'dining', 'esszimmer', 'hallway', 'flur',
      'garage', 'entrance', 'eingang', 'wc', 'utility', 'laundry', 'waschküche'],
  },
  {
    key: 'upper',
    words: ['bedroom', 'schlafzimmer', 'kinderzimmer', 'nursery', 'bathroom', 'badezimmer', 'bad',
      'office', 'büro', 'arbeitszimmer'],
  },
];

function hintKeyFor(text: string, table: { key: string; words: string[] }[]): string | null {
  const t = ` ${text.toLowerCase().replace(/[._-]+/g, ' ')} `;
  let best: { key: string; length: number } | null = null;
  for (const group of table) {
    for (const word of group.words) {
      if (t.includes(` ${word} `) && (!best || word.length > best.length)) {
        best = { key: group.key, length: word.length };
      }
    }
  }
  return best?.key ?? null;
}

/**
 * Guess which storey an entity belongs to from its area name. Purely a
 * convenience for drag & drop placement — the caller always lets the user
 * override, so a wrong guess costs one click, never data.
 */
export function suggestPlacementLevel(
  hass: HomeAssistant | undefined,
  entityId: string,
  levels: LevelDefinition[],
): string | null {
  if (!levels || levels.length === 0) return null;
  if (levels.length === 1) return levels[0].id;

  const areaName = getAreaName(hass, entityId);
  const haystack = `${areaName ?? ''} ${objectIdOf(entityId)}`;
  if (!haystack.trim()) return null;

  const lowerHay = haystack.toLowerCase();

  // 1. Direct name match: an area literally called "Obergeschoss".
  for (const level of levels) {
    const name = level.name?.toLowerCase().trim();
    if (name && name.length > 2 && lowerHay.includes(name)) return level.id;
  }

  // 2. Storey keyword in the area name, matched against the level names.
  const hint = hintKeyFor(haystack, LEVEL_HINTS) ?? hintKeyFor(haystack, ROOM_HINTS);
  if (!hint) return null;

  const levelKeys = levels.map((level) => ({
    id: level.id,
    key: hintKeyFor(`${level.name ?? ''} ${level.id}`, LEVEL_HINTS),
  }));
  const direct = levelKeys.find((l) => l.key === hint);
  if (direct) return direct.id;

  // 3. Nothing named that way: fall back to ordering by elevation.
  const sorted = [...levels].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  const ground = sorted.find((l) => (l.elevation ?? 0) >= 0) ?? sorted[0];
  if (hint === 'basement') return sorted[0].id;
  if (hint === 'attic') return sorted[sorted.length - 1].id;
  if (hint === 'ground') return ground.id;
  if (hint === 'upper') {
    const idx = sorted.indexOf(ground);
    return sorted[Math.min(idx + 1, sorted.length - 1)].id;
  }
  return null;
}

/* ------------------------------------------------------------------ misc */

/** Entities that exist in `hass.states`, in config order. */
export function resolveEntities(
  hass: HomeAssistant | undefined,
  entityIds: string[],
): HassEntity[] {
  const out: HassEntity[] = [];
  for (const id of entityIds) {
    const entity = hass?.states?.[id];
    if (entity) out.push(entity);
  }
  return out;
}

export function entityExists(hass: HomeAssistant | undefined, entityId: string): boolean {
  return Boolean(hass?.states?.[entityId]);
}
