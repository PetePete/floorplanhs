/**
 * Validation, defaults and migrations for the YAML a user writes by hand.
 *
 * Two rules shape everything here:
 *
 * 1. Error messages are shown *verbatim* in the dashboard where the card would
 *    have been. They name the exact path and say what the value should be, so
 *    the user can fix their YAML without reading any documentation.
 * 2. Coerce anything unambiguous. `scale: "2"`, `show_toolbar` instead of
 *    `showToolbar`, a bare entity id instead of an object — all of these are
 *    obviously intended and rejecting them helps nobody.
 */

import {
  CARD_TYPE,
  DEFAULT_CAMERA_CONFIG,
  DEFAULT_RENDER_CONFIG,
  DEFAULT_SECTION_STATE,
  DEFAULT_UI_CONFIG,
  type ActionConfig,
  type Axis,
  type CameraConfig,
  type CameraPreset,
  type ClipPlaneState,
  type EntityRole,
  type Floorplan3dCardConfig,
  type LevelDefinition,
  type LightKind,
  type LightVisualConfig,
  type MarkerConfig,
  type MarkerShape,
  type ModelConfig,
  type PlacedEntity,
  type RenderConfig,
  type SectionMode,
  type SectionState,
  type TourConfig,
  type UiConfig,
  type Vec3,
} from '@/types/config';
import type { HomeAssistant } from '@/types/hass';
import { parseCssColor } from '@/util/color';
import { slugify, vRound } from '@/util/math';
import { listEntitiesByDomain } from '@/ha/registry';

/** Bumped whenever the persisted shape changes; see `MIGRATIONS`. */
export const CURRENT_CONFIG_VERSION = 1;

/** Thrown for anything a user can fix by editing their YAML. */
export class ConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ConfigError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new ConfigError(path, message);
}

/* ------------------------------------------------------------ tiny helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function child(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function item(path: string, index: number): string {
  return `${path}[${index}]`;
}

/** Config is JSON by contract, so this is a complete and cheap deep copy. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * YAML users reach for snake_case; the TypeScript interfaces use camelCase.
 * Accept both rather than making people guess which fields are which.
 */
function withAliases(
  source: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [from, to] of Object.entries(aliases)) {
    if (source[from] !== undefined && source[to] === undefined) {
      out = out ?? { ...source };
      out[to] = source[from];
      delete out[from];
    }
  }
  return out ?? source;
}

/* -------------------------------------------------------------- primitives */

function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fail(path, `"${key}" must be a string`);
}

interface NumberBounds {
  min?: number;
  max?: number;
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  bounds: NumberBounds = {},
): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    return fail(path, `"${key}" must be a number (got ${JSON.stringify(value)})`);
  }
  if (bounds.min !== undefined && n < bounds.min) {
    return fail(path, `"${key}" must be at least ${bounds.min} (got ${n})`);
  }
  if (bounds.max !== undefined && n > bounds.max) {
    return fail(path, `"${key}" must be at most ${bounds.max} (got ${n})`);
  }
  return n;
}

function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'yes' || value === 'on' || value === 1) return true;
  if (value === 'false' || value === 'no' || value === 'off' || value === 0) return false;
  return fail(path, `"${key}" must be true or false (got ${JSON.stringify(value)})`);
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  const raw = readString(obj, key, path);
  if (raw === undefined) return undefined;
  const match = allowed.find((option) => option === raw.toLowerCase());
  if (!match) {
    return fail(
      path,
      `"${key}" must be one of ${allowed.map((a) => `"${a}"`).join(', ')} (got "${raw}")`,
    );
  }
  return match;
}

function readStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return fail(path, `"${key}" must be a list of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      return fail(path, `"${key}[${index}]" must be a string`);
    }
    return entry;
  });
}

function readRecord(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return fail(path, `"${key}" must be a mapping of options`);
  return value;
}

function readObjectList(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): unknown[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return fail(path, `"${key}" must be a list`);
  return value;
}

function coerceNumbers(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const entry of value) {
    const n = typeof entry === 'number' ? entry : typeof entry === 'string' ? Number(entry) : NaN;
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

function readVec3(obj: Record<string, unknown>, key: string, path: string): Vec3 | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  const nums = coerceNumbers(value);
  if (nums?.length === 3) return [nums[0], nums[1], nums[2]];
  // A floorplan is a plan view, so writing just [x, z] is a natural mistake
  // with an unambiguous meaning: on the floor.
  if (nums?.length === 2) return [nums[0], 0, nums[1]];
  return fail(path, `"${key}" must be a [x, y, z] array of numbers`);
}

function requireVec3(obj: Record<string, unknown>, key: string, path: string): Vec3 {
  const value = readVec3(obj, key, path);
  if (!value) return fail(path, `"${key}" is required and must be a [x, y, z] array of numbers`);
  return value;
}

function readVec2(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): [number, number] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  const nums = coerceNumbers(value);
  if (nums?.length === 2) return [nums[0], nums[1]];
  // A square area light written as a single number is unambiguous.
  const single = typeof value === 'number' ? value : null;
  if (single !== null && Number.isFinite(single)) return [single, single];
  return fail(path, `"${key}" must be a [width, height] array of two numbers`);
}

function readColor(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const raw = readString(obj, key, path);
  if (raw === undefined || raw === '') return undefined;
  // Only reject things that clearly *try* to be a colour: named CSS colours and
  // `var(--x)` are legitimate and not worth a parser.
  if (raw.startsWith('#') && !parseCssColor(raw)) {
    return fail(path, `"${key}" must be a hex colour like "#ffcc88" (got "${raw}")`);
  }
  return raw;
}

const ENTITY_ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/i;

/* ----------------------------------------------------------------- actions */

const ACTIONS = [
  'more-info',
  'toggle',
  'call-service',
  'perform-action',
  'navigate',
  'url',
  'preset',
  'none',
] as const;

function readAction(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): ActionConfig | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  // `tap_action: none` is a common shorthand.
  if (typeof value === 'string') {
    return readAction({ [key]: { action: value } }, key, path);
  }
  if (!isRecord(value)) return fail(path, `"${key}" must be a mapping with an "action" option`);

  const here = child(path, key);
  const action = readEnum(value, 'action', here, ACTIONS);
  if (!action) {
    return fail(here, `"action" is required and must be one of ${ACTIONS.map((a) => `"${a}"`).join(', ')}`);
  }

  const entity = readString(value, 'entity', here);
  if (entity && !ENTITY_ID_RE.test(entity)) {
    return fail(here, `"entity" must be an entity id like "light.kitchen" (got "${entity}")`);
  }

  const service = readString(value, 'service', here);
  const performAction = readString(value, 'perform_action', here);
  const out: ActionConfig = { action };
  if (entity) out.entity = entity;
  if (service) out.service = service;
  if (performAction) out.perform_action = performAction;

  const data = readRecord(value, 'data', here) ?? readRecord(value, 'service_data', here);
  if (data) out.data = data;
  const target = readRecord(value, 'target', here);
  if (target) out.target = target;

  const navigationPath = readString(value, 'navigation_path', here);
  if (navigationPath) out.navigation_path = navigationPath;
  const urlPath = readString(value, 'url_path', here);
  if (urlPath) out.url_path = urlPath;
  const presetId = readString(value, 'preset_id', here);
  if (presetId) out.preset_id = presetId;

  const confirmation = value.confirmation;
  if (confirmation === true) out.confirmation = {};
  else if (isRecord(confirmation)) {
    const text = readString(confirmation, 'text', child(here, 'confirmation'));
    out.confirmation = text ? { text } : {};
  } else if (typeof confirmation === 'string') {
    out.confirmation = { text: confirmation };
  } else if (confirmation !== undefined && confirmation !== false && confirmation !== null) {
    return fail(here, '"confirmation" must be true or a mapping with a "text" option');
  }

  if ((action === 'call-service' || action === 'perform-action') && !service && !performAction) {
    return fail(here, `"${action}" needs a "perform_action" (or legacy "service") like "light.turn_on"`);
  }
  if ((service || performAction) && !(service ?? performAction ?? '').includes('.')) {
    return fail(here, `"perform_action" must be "domain.service", e.g. "light.turn_on"`);
  }
  if (action === 'navigate' && !navigationPath) {
    return fail(here, '"navigate" needs a "navigation_path" like "/lovelace/0"');
  }
  if (action === 'url' && !urlPath) {
    return fail(here, '"url" needs a "url_path"');
  }
  if (action === 'preset' && !presetId) {
    return fail(here, '"preset" needs a "preset_id" naming one of your presets');
  }

  return out;
}

/* ------------------------------------------------------------------- model */

const MODEL_ALIASES: Record<string, string> = {
  glass_nodes: 'glassNodes',
  draco_path: 'dracoPath',
  glass: 'glassNodes',
};

function readLevels(raw: unknown[], path: string): LevelDefinition[] {
  return raw.map((entry, index) => {
    const here = item(path, index);
    if (!isRecord(entry)) {
      return fail(here, 'a level must be a mapping with "id", "name", "elevation" and "height"');
    }
    const name = readString(entry, 'name', here);
    const id = readString(entry, 'id', here) ?? (name ? slugify(name) : `level_${index}`);
    const level: LevelDefinition = {
      id,
      name: name ?? id,
      elevation: readNumber(entry, 'elevation', here) ?? 0,
      height: readNumber(entry, 'height', here, { min: 0.1 }) ?? 2.8,
    };
    const nodes = readStringArray(entry, 'nodes', here);
    if (nodes) level.nodes = nodes;
    const icon = readString(entry, 'icon', here);
    if (icon) level.icon = icon;
    return level;
  });
}

function readModel(raw: unknown, path: string): ModelConfig {
  if (!isRecord(raw)) return fail(path, 'must be a mapping (use "url:" to point at a glTF file)');
  const obj = withAliases(raw, MODEL_ALIASES);
  const model: ModelConfig = {};

  const url = readString(obj, 'url', path);
  if (url) model.url = url;
  const scale = readNumber(obj, 'scale', path, { min: 0.0001 });
  if (scale !== undefined) model.scale = scale;
  const rotation = readVec3(obj, 'rotation', path);
  if (rotation) model.rotation = rotation;
  const offset = readVec3(obj, 'offset', path);
  if (offset) model.offset = offset;
  const glassNodes = readStringArray(obj, 'glassNodes', path);
  if (glassNodes) model.glassNodes = glassNodes;
  const dracoPath = readString(obj, 'dracoPath', path);
  if (dracoPath) model.dracoPath = dracoPath;

  const levels = readObjectList(obj, 'levels', path);
  if (levels) {
    model.levels = readLevels(levels, child(path, 'levels'));
    const seen = new Set<string>();
    for (const level of model.levels) {
      if (seen.has(level.id)) {
        return fail(child(path, 'levels'), `duplicate level id "${level.id}"`);
      }
      seen.add(level.id);
    }
  }

  return model;
}

/* ----------------------------------------------------------------- section */

const SECTION_MODES: readonly SectionMode[] = ['none', 'level', 'plane'];
const AXES: readonly Axis[] = ['x', 'y', 'z'];

const SECTION_ALIASES: Record<string, string> = {
  level_id: 'levelId',
  cap_color: 'capColor',
  ghost_above: 'ghostAbove',
  snap_placement: 'snapPlacement',
  ceiling_cut: 'ceilingCut',
};

function readSection(raw: unknown, path: string): SectionState {
  if (!isRecord(raw)) return fail(path, 'must be a mapping with a "mode" option');
  const obj = withAliases(raw, SECTION_ALIASES);

  const section: SectionState = {
    mode: readEnum(obj, 'mode', path, SECTION_MODES) ?? 'none',
    planes: clone(DEFAULT_SECTION_STATE.planes),
  };

  const planes = readObjectList(obj, 'planes', path);
  if (planes) {
    const parsed: ClipPlaneState[] = planes.map((entry, index) => {
      const here = item(child(path, 'planes'), index);
      if (!isRecord(entry)) return fail(here, 'a clip plane must be a mapping with an "axis"');
      const axis = readEnum(entry, 'axis', here, AXES);
      if (!axis) return fail(here, '"axis" is required and must be "x", "y" or "z"');
      return {
        axis,
        position: readNumber(entry, 'position', here) ?? 0,
        enabled: readBoolean(entry, 'enabled', here) ?? false,
        invert: readBoolean(entry, 'invert', here) ?? false,
      };
    });
    section.planes = fillPlanes(parsed);
  }

  if ('levelId' in obj) {
    const levelId = readString(obj, 'levelId', path);
    section.levelId = levelId ?? null;
  }

  const caps = readBoolean(obj, 'caps', path);
  if (caps !== undefined) section.caps = caps;
  const capColor = readColor(obj, 'capColor', path);
  if (capColor) section.capColor = capColor;
  const ghostAbove = readBoolean(obj, 'ghostAbove', path);
  if (ghostAbove !== undefined) section.ghostAbove = ghostAbove;
  const ceilingCut = readNumber(obj, 'ceilingCut', path, { min: 0, max: 10 });
  if (ceilingCut !== undefined) section.ceilingCut = ceilingCut;

  if (section.mode === 'level' && section.levelId === undefined) section.levelId = null;
  return section;
}

/** The controller indexes planes by axis, so all three must always be present. */
function fillPlanes(planes: ClipPlaneState[]): ClipPlaneState[] {
  return AXES.map(
    (axis) =>
      planes.find((plane) => plane.axis === axis) ?? {
        axis,
        position: 0,
        enabled: false,
        invert: false,
      },
  );
}

/* ----------------------------------------------------------------- presets */

const PRESET_ALIASES: Record<string, string> = {
  ortho_zoom: 'orthoZoom',
  visible_levels: 'visibleLevels',
  in_tour: 'inTour',
  is_default: 'default',
};

function readPresets(raw: unknown[], path: string): CameraPreset[] {
  return raw.map((entry, index) => {
    const here = item(path, index);
    if (!isRecord(entry)) {
      return fail(here, 'a preset must be a mapping with "name", "position" and "target"');
    }
    const obj = withAliases(entry, PRESET_ALIASES);

    const name = readString(obj, 'name', here) ?? `View ${index + 1}`;
    const preset: CameraPreset = {
      id: readString(obj, 'id', here) ?? slugify(name),
      name,
      position: requireVec3(obj, 'position', here),
      target: requireVec3(obj, 'target', here),
    };

    const icon = readString(obj, 'icon', here);
    if (icon) preset.icon = icon;
    const fov = readNumber(obj, 'fov', here, { min: 5, max: 150 });
    if (fov !== undefined) preset.fov = fov;
    const orthographic = readBoolean(obj, 'orthographic', here);
    if (orthographic !== undefined) preset.orthographic = orthographic;
    const orthoZoom = readNumber(obj, 'orthoZoom', here, { min: 0.01 });
    if (orthoZoom !== undefined) preset.orthoZoom = orthoZoom;
    if (obj.section !== undefined && obj.section !== null) {
      preset.section = readSection(obj.section, child(here, 'section'));
    }
    if ('visibleLevels' in obj) {
      preset.visibleLevels = obj.visibleLevels === null
        ? null
        : (readStringArray(obj, 'visibleLevels', here) ?? null);
    }
    const isDefault = readBoolean(obj, 'default', here);
    if (isDefault !== undefined) preset.default = isDefault;
    const inTour = readBoolean(obj, 'inTour', here);
    if (inTour !== undefined) preset.inTour = inTour;

    return preset;
  });
}

/* ---------------------------------------------------------------- entities */

const ROLES: readonly EntityRole[] = [
  'light',
  'switch',
  'sensor',
  'binary_sensor',
  'cover',
  'climate',
  'media_player',
  'camera',
  'person',
  'marker',
];

const LIGHT_KINDS: readonly LightKind[] = ['point', 'spot', 'rect', 'emissive'];
const MARKER_SHAPES: readonly MarkerShape[] = ['auto', 'pill', 'dot', 'icon', 'label', 'none'];

const LIGHT_ALIASES: Record<string, string> = {
  target_offset: 'targetOffset',
  use_entity_color: 'useEntityColor',
};

const MARKER_ALIASES: Record<string, string> = {
  show_state: 'showState',
  show_name: 'showName',
  fixed_size: 'fixedSize',
  max_distance: 'maxDistance',
};

const ENTITY_ALIASES: Record<string, string> = {
  bind_node: 'bindNode',
  pos: 'position',
};

function readLightVisual(raw: unknown, path: string): LightVisualConfig {
  if (!isRecord(raw)) return fail(path, 'must be a mapping of light options');
  const obj = withAliases(raw, LIGHT_ALIASES);
  const light: LightVisualConfig = {};

  const kind = readEnum(obj, 'kind', path, LIGHT_KINDS);
  if (kind) light.kind = kind;
  const intensity = readNumber(obj, 'intensity', path, { min: 0 });
  if (intensity !== undefined) light.intensity = intensity;
  const distance = readNumber(obj, 'distance', path, { min: 0 });
  if (distance !== undefined) light.distance = distance;
  const decay = readNumber(obj, 'decay', path, { min: 0 });
  if (decay !== undefined) light.decay = decay;
  const angle = readNumber(obj, 'angle', path, { min: 1, max: 90 });
  if (angle !== undefined) light.angle = angle;
  const penumbra = readNumber(obj, 'penumbra', path, { min: 0, max: 1 });
  if (penumbra !== undefined) light.penumbra = penumbra;
  const targetOffset = readVec3(obj, 'targetOffset', path);
  if (targetOffset) light.targetOffset = targetOffset;
  const color = readColor(obj, 'color', path);
  if (color) light.color = color;
  const useEntityColor = readBoolean(obj, 'useEntityColor', path);
  if (useEntityColor !== undefined) light.useEntityColor = useEntityColor;
  const size = readVec2(obj, 'size', path);
  if (size) light.size = size;

  const fixture = readRecord(obj, 'fixture', path);
  if (fixture) {
    const here = child(path, 'fixture');
    light.fixture = {};
    const show = readBoolean(fixture, 'show', here);
    if (show !== undefined) light.fixture.show = show;
    const radius = readNumber(fixture, 'radius', here, { min: 0 });
    if (radius !== undefined) light.fixture.radius = radius;
    const emissive = readNumber(fixture, 'emissive', here, { min: 0 });
    if (emissive !== undefined) light.fixture.emissive = emissive;
  }

  if (light.kind === 'rect' && !light.size) light.size = [0.6, 0.6];
  return light;
}

function readMarker(raw: unknown, path: string): MarkerConfig {
  if (!isRecord(raw)) return fail(path, 'must be a mapping of marker options');
  const obj = withAliases(raw, MARKER_ALIASES);
  const marker: MarkerConfig = {};

  const leader = readBoolean(obj, 'leader', path);
  if (leader !== undefined) marker.leader = leader;
  const shape = readEnum(obj, 'shape', path, MARKER_SHAPES);
  if (shape) marker.shape = shape;
  const showState = readBoolean(obj, 'showState', path);
  if (showState !== undefined) marker.showState = showState;
  const showName = readBoolean(obj, 'showName', path);
  if (showName !== undefined) marker.showName = showName;
  const icon = readString(obj, 'icon', path);
  if (icon) marker.icon = icon;
  const fixedSize = readBoolean(obj, 'fixedSize', path);
  if (fixedSize !== undefined) marker.fixedSize = fixedSize;
  const scale = readNumber(obj, 'scale', path, { min: 0.01, max: 20 });
  if (scale !== undefined) marker.scale = scale;
  const maxDistance = readNumber(obj, 'maxDistance', path, { min: 0 });
  if (maxDistance !== undefined) marker.maxDistance = maxDistance;
  const color = readColor(obj, 'color', path);
  if (color) marker.color = color;
  const offset = readVec3(obj, 'offset', path);
  if (offset) marker.offset = offset;

  return marker;
}

function readEntities(raw: unknown[], path: string): PlacedEntity[] {
  return raw.map((entry, index) => {
    const here = item(path, index);

    // `entities: [light.kitchen]` — placed at the origin so the user can drag
    // it where it belongs instead of hand-writing coordinates.
    if (typeof entry === 'string') {
      if (!ENTITY_ID_RE.test(entry)) {
        return fail(here, `"${entry}" is not an entity id like "light.kitchen"`);
      }
      return { entity: entry, position: [0, 0, 0] as Vec3 };
    }

    if (!isRecord(entry)) {
      return fail(here, 'must be an entity id or a mapping with "entity" and "position"');
    }
    const obj = withAliases(entry, ENTITY_ALIASES);

    const entity = readString(obj, 'entity', here);
    if (!entity) return fail(here, '"entity" is required, e.g. `entity: light.kitchen`');
    if (!ENTITY_ID_RE.test(entity)) {
      return fail(here, `"entity" must be an entity id like "light.kitchen" (got "${entity}")`);
    }

    const placed: PlacedEntity = { entity, position: requireVec3(obj, 'position', here) };

    const rotation = readVec3(obj, 'rotation', here);
    if (rotation) placed.rotation = rotation;
    if ('level' in obj) {
      const level = readString(obj, 'level', here);
      placed.level = level ?? null;
    }
    const name = readString(obj, 'name', here);
    if (name) placed.name = name;
    const role = readEnum(obj, 'role', here, ROLES);
    if (role) placed.role = role;
    const room = readString(obj, 'room', here);
    if (room) placed.room = room;
    if (obj.light !== undefined && obj.light !== null) {
      placed.light = readLightVisual(obj.light, child(here, 'light'));
    }
    if (obj.marker !== undefined && obj.marker !== null) {
      placed.marker = readMarker(obj.marker, child(here, 'marker'));
    }
    const tap = readAction(obj, 'tap_action', here);
    if (tap) placed.tap_action = tap;
    const hold = readAction(obj, 'hold_action', here);
    if (hold) placed.hold_action = hold;
    const doubleTap = readAction(obj, 'double_tap_action', here);
    if (doubleTap) placed.double_tap_action = doubleTap;
    const bindNode = readString(obj, 'bindNode', here);
    if (bindNode) placed.bindNode = bindNode;

    return placed;
  });
}

/* ------------------------------------------------------------ camera/render/ui */

const CAMERA_ALIASES: Record<string, string> = {
  min_distance: 'minDistance',
  max_distance: 'maxDistance',
  max_polar_angle: 'maxPolarAngle',
  transition_duration: 'transitionDuration',
  auto_rotate: 'autoRotate',
  auto_rotate_speed: 'autoRotateSpeed',
  idle_return_after: 'idleReturnAfter',
};

function readCamera(raw: unknown, path: string): CameraConfig {
  if (!isRecord(raw)) return fail(path, 'must be a mapping of camera options');
  const obj = withAliases(raw, CAMERA_ALIASES);
  const camera: CameraConfig = {};

  const assign = <K extends keyof CameraConfig>(key: K, value: CameraConfig[K] | undefined) => {
    if (value !== undefined) camera[key] = value;
  };

  assign('fov', readNumber(obj, 'fov', path, { min: 5, max: 150 }));
  assign('near', readNumber(obj, 'near', path, { min: 0.001 }));
  assign('far', readNumber(obj, 'far', path, { min: 1 }));
  assign('minDistance', readNumber(obj, 'minDistance', path, { min: 0 }));
  assign('maxDistance', readNumber(obj, 'maxDistance', path, { min: 0.1 }));
  assign('maxPolarAngle', readNumber(obj, 'maxPolarAngle', path, { min: 0, max: Math.PI }));
  assign('damping', readNumber(obj, 'damping', path, { min: 0, max: 1 }));
  assign('transitionDuration', readNumber(obj, 'transitionDuration', path, { min: 0, max: 30 }));
  assign('navigation', readEnum(obj, 'navigation', path, ['cad', 'orbit'] as const));
  assign(
    'projection',
    readEnum(obj, 'projection', path, ['isometric', 'perspective'] as const),
  );
  assign('autoRotate', readBoolean(obj, 'autoRotate', path));
  assign('autoRotateSpeed', readNumber(obj, 'autoRotateSpeed', path));
  assign('idleReturnAfter', readNumber(obj, 'idleReturnAfter', path, { min: 0 }));

  if (
    camera.minDistance !== undefined &&
    camera.maxDistance !== undefined &&
    camera.minDistance > camera.maxDistance
  ) {
    return fail(path, '"minDistance" must be smaller than "maxDistance"');
  }
  return camera;
}

const TOUR_ALIASES: Record<string, string> = {
  auto_play: 'autoplay',
  show_controls: 'showControls',
  pause_on_interaction: 'pauseOnInteraction',
  resume_after: 'resumeAfter',
};

function readTour(raw: unknown, path: string): TourConfig {
  if (!isRecord(raw)) return fail(path, 'must be a mapping of tour options');
  const obj = withAliases(raw, TOUR_ALIASES);
  const tour: TourConfig = {};

  const assign = <K extends keyof TourConfig>(key: K, value: TourConfig[K] | undefined) => {
    if (value !== undefined) tour[key] = value;
  };

  assign('autoplay', readBoolean(obj, 'autoplay', path));
  // Below a few seconds the card spends its whole life mid-flight.
  assign('interval', readNumber(obj, 'interval', path, { min: 3, max: 3600 }));
  assign('include', readEnum(obj, 'include', path, ['tagged', 'all'] as const));
  assign('showControls', readBoolean(obj, 'showControls', path));
  assign('pauseOnInteraction', readBoolean(obj, 'pauseOnInteraction', path));
  assign('resumeAfter', readNumber(obj, 'resumeAfter', path, { min: 0, max: 3600 }));

  return tour;
}

const RENDER_ALIASES: Record<string, string> = {
  edge_color: 'edgeColor',
  light_mode: 'lightMode',
  tone_mapping: 'toneMapping',
  room_fill_strength: 'roomFillStrength',
  ambient_intensity: 'ambientIntensity',
  daylight_entity: 'daylightEntity',
  max_pixel_ratio: 'maxPixelRatio',
  on_demand: 'onDemand',
  fps_limit: 'fpsLimit',
};

function readRender(raw: unknown, path: string): RenderConfig {
  if (!isRecord(raw)) return fail(path, 'must be a mapping of render options');
  const obj = withAliases(raw, RENDER_ALIASES);
  const render: RenderConfig = {};

  const assign = <K extends keyof RenderConfig>(key: K, value: RenderConfig[K] | undefined) => {
    if (value !== undefined) render[key] = value;
  };

  assign('style', readEnum(obj, 'style', path, ['solid', 'wireframe'] as const));
  assign(
    'palette',
    readEnum(obj, 'palette', path, ['model', 'mono-light', 'mono-dark'] as const),
  );
  assign('lightMode', readEnum(obj, 'lightMode', path, ['room', 'realistic'] as const));
  assign('toneMapping', readEnum(obj, 'toneMapping', path, ['linear', 'aces', 'none'] as const));
  assign('roomFillStrength', readNumber(obj, 'roomFillStrength', path, { min: 0, max: 2 }));
  assign('edgeColor', readString(obj, 'edgeColor', path));
  assign('quality', readEnum(obj, 'quality', path, ['low', 'medium', 'high', 'auto'] as const));
  assign('exposure', readNumber(obj, 'exposure', path, { min: 0.05, max: 10 }));
  assign('ambientIntensity', readNumber(obj, 'ambientIntensity', path, { min: 0, max: 10 }));
  assign('daylight', readBoolean(obj, 'daylight', path));
  assign('maxPixelRatio', readNumber(obj, 'maxPixelRatio', path, { min: 0.5, max: 4 }));
  assign('onDemand', readBoolean(obj, 'onDemand', path));
  assign('fpsLimit', readNumber(obj, 'fpsLimit', path, { min: 1, max: 240 }));

  const daylightEntity = readString(obj, 'daylightEntity', path);
  if (daylightEntity) {
    if (!ENTITY_ID_RE.test(daylightEntity)) {
      return fail(path, `"daylightEntity" must be an entity id like "sun.sun" (got "${daylightEntity}")`);
    }
    render.daylightEntity = daylightEntity;
  }
  const background = readColor(obj, 'background', path);
  if (background) render.background = background;

  return render;
}

const UI_ALIASES: Record<string, string> = {
  show_toolbar: 'showToolbar',
  show_preset_bar: 'showPresetBar',
  show_level_selector: 'showLevelSelector',
  show_section_controls: 'showSectionControls',
  show_legend: 'showLegend',
  show_fps: 'showFps',
  show_view_cube: 'showViewCube',
  show_ceilings: 'showCeilings',
  explode_duration: 'explodeDuration',
  show_zoom_slider: 'showZoomSlider',
  level_presets: 'levelPresets',
  ghost_above: 'ghostAbove',
  markers_through_walls: 'markersThroughWalls',
  author_tools: 'authorTools',
  aspect_ratio: 'aspectRatio',
};

function readUi(raw: unknown, path: string): UiConfig {
  if (!isRecord(raw)) return fail(path, 'must be a mapping of ui options');
  const obj = withAliases(raw, UI_ALIASES);
  const ui: UiConfig = {};

  const assign = <K extends keyof UiConfig>(key: K, value: UiConfig[K] | undefined) => {
    if (value !== undefined) ui[key] = value;
  };

  assign('showCeilings', readBoolean(obj, 'showCeilings', path));
  assign('explode', readNumber(obj, 'explode', path, { min: 0, max: 20 }));
  assign('explodeDuration', readNumber(obj, 'explodeDuration', path, { min: 0, max: 10 }));
  assign('ghostAbove', readBoolean(obj, 'ghostAbove', path));
  assign('snapPlacement', readBoolean(obj, 'snapPlacement', path));
  assign('showToolbar', readBoolean(obj, 'showToolbar', path));
  assign('showPresetBar', readBoolean(obj, 'showPresetBar', path));
  assign('showLevelSelector', readBoolean(obj, 'showLevelSelector', path));
  assign('showSectionControls', readBoolean(obj, 'showSectionControls', path));
  assign('showLegend', readBoolean(obj, 'showLegend', path));
  assign('showFps', readBoolean(obj, 'showFps', path));
  assign('showViewCube', readBoolean(obj, 'showViewCube', path));
  assign('showZoomSlider', readBoolean(obj, 'showZoomSlider', path));
  assign('levelPresets', readBoolean(obj, 'levelPresets', path));
  assign('markersThroughWalls', readBoolean(obj, 'markersThroughWalls', path));
  assign('authorTools', readEnum(obj, 'authorTools', path, ['auto', 'never', 'always'] as const));
  assign('compact', readBoolean(obj, 'compact', path));
  assign('theme', readEnum(obj, 'theme', path, ['auto', 'light', 'dark'] as const));

  // A bare number is metres to nobody and pixels to everybody.
  const height = obj.height;
  if (typeof height === 'number') ui.height = `${height}px`;
  else {
    const text = readString(obj, 'height', path);
    if (text) ui.height = text;
  }
  const aspectRatio = readString(obj, 'aspectRatio', path);
  if (aspectRatio) ui.aspectRatio = aspectRatio;

  return ui;
}

/* -------------------------------------------------------------- migrations */

type Migration = (config: Record<string, unknown>) => Record<string, unknown>;

/**
 * v0 is "anything written before the schema was versioned". It only renames a
 * few keys, but the chain exists so future changes can be additive: bump
 * `CURRENT_CONFIG_VERSION`, add the entry, and old dashboards keep working.
 */
const migrateV0ToV1: Migration = (config) => {
  const next = { ...config };

  if (Array.isArray(next.lights)) {
    const existing = Array.isArray(next.entities) ? next.entities : [];
    next.entities = [...existing, ...next.lights];
    delete next.lights;
  }
  if (next.camera_presets !== undefined && next.presets === undefined) {
    next.presets = next.camera_presets;
    delete next.camera_presets;
  }
  if (next.clip !== undefined && next.section === undefined) {
    next.section = next.clip;
    delete next.clip;
  }
  if (typeof next.model_url === 'string') {
    const model = isRecord(next.model) ? { ...next.model } : {};
    if (model.url === undefined) model.url = next.model_url;
    next.model = model;
    delete next.model_url;
  }

  return next;
};

const MIGRATIONS: Record<number, Migration> = {
  0: migrateV0ToV1,
};

/**
 * Brings any historical config up to `CURRENT_CONFIG_VERSION`. Pure: the input
 * object is never mutated, which matters because Lovelace hands us the same
 * object it keeps in its own store.
 */
export function migrateConfig(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    return fail('', 'the card configuration must be a mapping, e.g. `type: custom:floorplan-3d-card`');
  }

  let config: Record<string, unknown> = { ...raw };
  const declared = config.config_version;
  let version = typeof declared === 'number' && Number.isFinite(declared) ? declared : 0;

  if (version > CURRENT_CONFIG_VERSION) {
    // Written by a newer version of the card. Leave it alone rather than
    // silently discarding options we do not understand yet.
    console.warn(
      `[floorplan-3d] config_version ${version} is newer than this card understands (${CURRENT_CONFIG_VERSION})`,
    );
    return config;
  }

  while (version < CURRENT_CONFIG_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) break;
    config = migration(config);
    version += 1;
    config.config_version = version;
  }
  config.config_version = Math.max(version, CURRENT_CONFIG_VERSION);
  return config;
}

/* ------------------------------------------------------------- normalising */

/** Keys we own. Everything else on the config belongs to Lovelace. */
const KNOWN_KEYS = new Set([
  'type',
  'title',
  'model',
  'camera',
  'presets',
  'entities',
  'section',
  'render',
  'ui',
  'config_version',
]);

function uniqueId(base: string, taken: Set<string>): string {
  const seed = base || 'item';
  if (!taken.has(seed)) {
    taken.add(seed);
    return seed;
  }
  let n = 2;
  while (taken.has(`${seed}_${n}`)) n += 1;
  const id = `${seed}_${n}`;
  taken.add(id);
  return id;
}

/**
 * Fills in defaults and repairs anything structurally incomplete. Safe to call
 * repeatedly — the editor runs it after every change — and it never throws, so
 * it can also be used on configs the card itself just produced.
 */
export function normalizeConfig(config: Floorplan3dCardConfig): Floorplan3dCardConfig {
  const out: Floorplan3dCardConfig = {
    ...config,
    type: config.type || `custom:${CARD_TYPE}`,
    camera: { ...DEFAULT_CAMERA_CONFIG, ...(config.camera ?? {}) },
    render: { ...DEFAULT_RENDER_CONFIG, ...(config.render ?? {}) },
    ui: { ...DEFAULT_UI_CONFIG, ...(config.ui ?? {}) },
    section: {
      ...clone(DEFAULT_SECTION_STATE),
      ...(config.section ?? {}),
      planes: fillPlanes(config.section?.planes ?? clone(DEFAULT_SECTION_STATE.planes)),
    },
    config_version: CURRENT_CONFIG_VERSION,
  };

  if (config.model) {
    const model: ModelConfig = { ...config.model };
    if (model.levels) {
      const taken = new Set<string>();
      model.levels = model.levels.map((level, index) => ({
        ...level,
        id: uniqueId(level.id || slugify(level.name || `level_${index}`), taken),
        name: level.name || level.id || `Level ${index + 1}`,
      }));
    }
    out.model = model;
  }

  if (config.presets) {
    const taken = new Set<string>();
    let defaultSeen = false;
    out.presets = config.presets.map((preset, index) => {
      const name = preset.name || `View ${index + 1}`;
      const next: CameraPreset = {
        ...preset,
        id: uniqueId(preset.id || slugify(name), taken),
        name,
        position: vRound(preset.position ?? [10, 8, 10]),
        target: vRound(preset.target ?? [0, 1, 0]),
      };
      // Two defaults means the second one never wins; drop it so what the user
      // sees matches what they wrote.
      if (next.default) {
        if (defaultSeen) delete next.default;
        else defaultSeen = true;
      }
      return next;
    });
  }

  if (config.entities) {
    const seen = new Set<string>();
    const entities: PlacedEntity[] = [];
    for (const placed of config.entities) {
      if (!placed?.entity || seen.has(placed.entity)) continue;
      seen.add(placed.entity);
      entities.push({
        ...placed,
        // Rule 3 in ARCHITECTURE.md: coordinates are written back to YAML.
        position: vRound(placed.position ?? [0, 0, 0]),
        ...(placed.rotation ? { rotation: vRound(placed.rotation) } : {}),
      });
    }
    out.entities = entities;
  }

  return out;
}

/* -------------------------------------------------------------- validation */

/**
 * The single entry point `setConfig` calls. Migrates, validates and normalises;
 * throws `ConfigError` with a message meant for the person editing the YAML.
 */
export function validateConfig(raw: unknown): Floorplan3dCardConfig {
  const source = migrateConfig(raw);

  const type = readString(source, 'type', '') ?? `custom:${CARD_TYPE}`;
  const validated: Floorplan3dCardConfig = { type };

  const title = readString(source, 'title', '');
  if (title) validated.title = title;

  if (source.model !== undefined && source.model !== null) {
    validated.model = readModel(source.model, 'model');
  }
  if (source.camera !== undefined && source.camera !== null) {
    validated.camera = readCamera(source.camera, 'camera');
  }
  const presets = readObjectList(source, 'presets', '');
  if (presets) validated.presets = readPresets(presets, 'presets');

  const entities = readObjectList(source, 'entities', '');
  if (entities) validated.entities = readEntities(entities, 'entities');

  if (source.section !== undefined && source.section !== null) {
    validated.section = readSection(source.section, 'section');
  }
  if (source.render !== undefined && source.render !== null) {
    validated.render = readRender(source.render, 'render');
  }
  if (source.tour !== undefined && source.tour !== null) {
    validated.tour = readTour(source.tour, 'tour');
  }
  if (source.ui !== undefined && source.ui !== null) {
    validated.ui = readUi(source.ui, 'ui');
  }

  // Cross-references: a preset pointing at a level that does not exist would
  // silently do nothing, which is exactly the kind of bug YAML hides.
  const levelIds = new Set((validated.model?.levels ?? []).map((level) => level.id));
  if (levelIds.size > 0) {
    validated.presets?.forEach((preset, index) => {
      for (const levelId of preset.visibleLevels ?? []) {
        if (!levelIds.has(levelId)) {
          fail(
            item('presets', index),
            `"visibleLevels" references unknown level "${levelId}" (known: ${[...levelIds].join(', ')})`,
          );
        }
      }
    });
    validated.entities?.forEach((placed, index) => {
      if (placed.level && !levelIds.has(placed.level)) {
        fail(
          item('entities', index),
          `"level" references unknown level "${placed.level}" (known: ${[...levelIds].join(', ')})`,
        );
      }
    });
  }

  const presetIds = new Set((validated.presets ?? []).map((preset) => preset.id));
  validated.entities?.forEach((placed, index) => {
    for (const action of [placed.tap_action, placed.hold_action, placed.double_tap_action]) {
      if (action?.action === 'preset' && action.preset_id && !presetIds.has(action.preset_id)) {
        fail(
          item('entities', index),
          `action references unknown preset "${action.preset_id}"`,
        );
      }
    }
  });

  const normalised = normalizeConfig(validated);

  // Lovelace stores its own keys (view_layout, grid_options, visibility) on the
  // card config. Dropping them would break the user's layout.
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) {
      (normalised as unknown as Record<string, unknown>)[key] = source[key];
    }
  }

  return normalised;
}

/* ------------------------------------------------------------------- stub */

/** Room centres of the built-in demo house, ceiling height on the ground floor. */
const STUB_POSITIONS: Vec3[] = [
  [-2.6, 2.35, -2.36],
  [3.2, 2.35, -2.36],
  [-4.1, 2.35, 1.96],
  [-0.6, 2.35, 1.96],
];

/**
 * What the HA card picker previews. Real lights from the user's own install,
 * already placed in the demo house — the difference between "interesting" and
 * "an empty grey box" on first click.
 */
export function stubConfig(hass: HomeAssistant): Floorplan3dCardConfig {
  const lights = listEntitiesByDomain(hass, ['light'])
    .filter((option) => hass?.states?.[option.entity_id]?.state !== 'unavailable')
    .slice(0, STUB_POSITIONS.length);

  const entities: PlacedEntity[] = lights.map((option, index) => ({
    entity: option.entity_id,
    position: STUB_POSITIONS[index],
    level: 'ground',
  }));

  return {
    type: `custom:${CARD_TYPE}`,
    config_version: CURRENT_CONFIG_VERSION,
    presets: [
      // The card opens on the plan, not on a 3/4 exterior render: this is a
      // floorplan first and a 3D model second. The outside of the house tells
      // you nothing about your home; the rooms and their lights do.
      // Isometric: the camera looks along (1, 1, 1) with an orthographic
      // projection, so all three axes foreshorten equally. Unlike a straight
      // plan it shows the height of a storey as well as its layout, which is
      // what makes a lit lamp read as being *in* a room.
      {
        id: 'ground_floor',
        name: 'Ground floor',
        icon: 'mdi:home-floor-g',
        position: [16, 16, 16],
        target: [0, 1.2, 0],
        orthographic: true,
        visibleLevels: ['ground'],
        section: { ...clone(DEFAULT_SECTION_STATE), mode: 'level', levelId: 'ground' },
        default: true,
        inTour: true,
      },
      {
        id: 'upper_floor',
        name: 'Upper floor',
        icon: 'mdi:home-floor-1',
        position: [16, 18.9, 16],
        target: [0, 4.1, 0],
        orthographic: true,
        visibleLevels: ['upper'],
        section: { ...clone(DEFAULT_SECTION_STATE), mode: 'level', levelId: 'upper' },
        inTour: true,
      },
    ],
    entities,
    ui: { height: '520px' },
  };
}
