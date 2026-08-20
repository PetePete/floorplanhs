/**
 * Raw Home Assistant state -> the normalised structures the engine consumes.
 *
 * This is the only place that knows how messy HA's light model is. Everything
 * downstream sees a `LightSample` with a linear RGB triple and a 0..1
 * brightness, no matter whether the bulb speaks HS, XY, mireds or nothing at
 * all. Every function here is pure and must never throw or produce NaN: it runs
 * inside the render loop, where a thrown error means a black card.
 */

import type { EntityVisualState, LightSample } from '@/engine/contracts';
import type { EntityRole, PlacedEntity } from '@/types/config';
import type { HassEntities, HassEntity, HassEntityAttributeBase, HomeAssistant } from '@/types/hass';
import {
  clamp,
  clamp01,
  hsToRgb255,
  kelvinToRgb255,
  linearToSrgb,
  miredToKelvin,
  parseCssColor,
  rgb255ToLinear,
  rgbToHex,
  srgbToLinear,
  type RGB,
} from '@/util/color';
import { domainOf, getEntityName, prettifyEntityId } from '@/ha/registry';
import { darken, fallbackThemeFor, mixColors, type ThemeColors } from '@/ha/theme';

/* --------------------------------------------------------------- constants */

/** What an unknown or colourless bulb looks like. Warm, never clinical. */
export const DEFAULT_LIGHT_KELVIN = 2700;

/** HA's own defaults when a light does not advertise its colour-temp range. */
const DEFAULT_MIN_KELVIN = 2000;
const DEFAULT_MAX_KELVIN = 6535;

const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);

/* ------------------------------------------------------------ attr helpers */

/** Attributes arrive over the websocket as JSON; numbers sometimes as strings. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numberAttr(attrs: HassEntityAttributeBase, key: string): number | null {
  return toNumber(attrs[key]);
}

/** Reads a fixed-length numeric tuple, rejecting anything malformed. */
function tupleAttr(attrs: HassEntityAttributeBase, key: string, length: number): number[] | null {
  const raw = attrs[key];
  if (!Array.isArray(raw) || raw.length < length) return null;
  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const n = toNumber(raw[i]);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

function stringAttr(attrs: HassEntityAttributeBase, key: string): string | undefined {
  const raw = attrs[key];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/* --------------------------------------------------------------- colour ops */

interface ColorResult {
  /** Linear RGB, normalised so the brightest channel is 1. */
  color: RGB;
  kelvin?: number;
}

/**
 * Brightness travels in `LightSample.brightness`, so the colour carries hue and
 * saturation only. Normalising by the brightest channel keeps the ratios (and
 * therefore the hue) while stopping a dim `rgb_color` from darkening the light
 * twice.
 */
function normalise(rgb: RGB): RGB | null {
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  if (!Number.isFinite(max) || max <= 0) return null;
  const out: RGB = [rgb[0] / max, rgb[1] / max, rgb[2] / max];
  if (!out.every((c) => Number.isFinite(c))) return null;
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])];
}

function fromKelvin(kelvin: number): ColorResult {
  const k = clamp(kelvin, 1000, 12000);
  const linear = rgb255ToLinear(kelvinToRgb255(k));
  return { color: normalise(linear) ?? [1, 0.72, 0.44], kelvin: k };
}

/** Fresh object every call: the engine is free to keep or mutate what it gets. */
function warmFallback(): ColorResult {
  return fromKelvin(DEFAULT_LIGHT_KELVIN);
}

function minKelvin(attrs: HassEntityAttributeBase): number {
  const k = numberAttr(attrs, 'min_color_temp_kelvin');
  if (k !== null && k > 0) return k;
  const mired = numberAttr(attrs, 'max_mireds');
  if (mired !== null && mired > 0) return miredToKelvin(mired);
  return DEFAULT_MIN_KELVIN;
}

function maxKelvin(attrs: HassEntityAttributeBase): number {
  const k = numberAttr(attrs, 'max_color_temp_kelvin');
  if (k !== null && k > 0) return k;
  const mired = numberAttr(attrs, 'min_mireds');
  if (mired !== null && mired > 0) return miredToKelvin(mired);
  return DEFAULT_MAX_KELVIN;
}

/**
 * Neutral point of a single white channel: the midpoint of the bulb's range in
 * mired space, which is perceptually linear (kelvin is not).
 */
function neutralWhiteKelvin(attrs: HassEntityAttributeBase): number {
  const warm = minKelvin(attrs);
  const cool = maxKelvin(attrs);
  const mid = (1_000_000 / warm + 1_000_000 / cool) / 2;
  return mid > 0 ? 1_000_000 / mid : DEFAULT_LIGHT_KELVIN;
}

/**
 * CIE xyY -> sRGB using the "Wide RGB D65" matrix Philips Hue documents. The
 * gamma step at the end matters: without it colours come out visibly washed
 * out, because the matrix produces linear values while HA's xy pairs describe
 * what the lamp should look like.
 */
export function xyToRgb255(x: number, y: number): RGB | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return null;

  const z = 1 - x - y;
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;

  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01253;

  // Wide-gamut primaries overshoot for saturated in-gamut points; scale rather
  // than clip so the hue survives.
  const peak = Math.max(r, g, b);
  if (peak > 1) {
    r /= peak;
    g /= peak;
    b /= peak;
  }

  const encode = (c: number) => clamp01(linearToSrgb(Math.max(c, 0))) * 255;
  const out: RGB = [encode(r), encode(g), encode(b)];
  return out.every((c) => Number.isFinite(c)) ? out : null;
}

/* ------------------------------------------------------ colour-mode ladder */

function resolveRgbww(attrs: HassEntityAttributeBase): ColorResult | null {
  const v = tupleAttr(attrs, 'rgbww_color', 5);
  if (!v) return null;
  // HA order is (r, g, b, cold white, warm white).
  const base = rgb255ToLinear([v[0], v[1], v[2]]);
  const cold = rgb255ToLinear(kelvinToRgb255(maxKelvin(attrs)));
  const warm = rgb255ToLinear(kelvinToRgb255(minKelvin(attrs)));
  const cw = srgbToLinear(clamp01(v[3] / 255));
  const ww = srgbToLinear(clamp01(v[4] / 255));
  const sum: RGB = [
    base[0] + cold[0] * cw + warm[0] * ww,
    base[1] + cold[1] * cw + warm[1] * ww,
    base[2] + cold[2] * cw + warm[2] * ww,
  ];
  const color = normalise(sum);
  return color ? { color } : null;
}

function resolveRgbw(attrs: HassEntityAttributeBase): ColorResult | null {
  const v = tupleAttr(attrs, 'rgbw_color', 4);
  if (!v) return null;
  const base = rgb255ToLinear([v[0], v[1], v[2]]);
  const white = rgb255ToLinear(kelvinToRgb255(neutralWhiteKelvin(attrs)));
  const w = srgbToLinear(clamp01(v[3] / 255));
  const sum: RGB = [base[0] + white[0] * w, base[1] + white[1] * w, base[2] + white[2] * w];
  const color = normalise(sum);
  return color ? { color } : null;
}

function resolveRgb(attrs: HassEntityAttributeBase): ColorResult | null {
  const v = tupleAttr(attrs, 'rgb_color', 3);
  if (!v) return null;
  const color = normalise(rgb255ToLinear(v));
  return color ? { color } : null;
}

function resolveHs(attrs: HassEntityAttributeBase): ColorResult | null {
  const v = tupleAttr(attrs, 'hs_color', 2);
  if (!v) return null;
  // `hs_color` is hue/saturation only — value comes from `brightness`, which
  // the sample carries separately, so the triple stays at full value here.
  const color = normalise(rgb255ToLinear(hsToRgb255(v[0], v[1])));
  return color ? { color } : null;
}

function resolveXy(attrs: HassEntityAttributeBase): ColorResult | null {
  const v = tupleAttr(attrs, 'xy_color', 2);
  if (!v) return null;
  const rgb = xyToRgb255(v[0], v[1]);
  if (!rgb) return null;
  const color = normalise(rgb255ToLinear(rgb));
  return color ? { color } : null;
}

function resolveKelvin(attrs: HassEntityAttributeBase): ColorResult | null {
  const k = numberAttr(attrs, 'color_temp_kelvin');
  return k !== null && k > 0 ? fromKelvin(k) : null;
}

/** Legacy mireds; still what several integrations report. */
function resolveMired(attrs: HassEntityAttributeBase): ColorResult | null {
  const m = numberAttr(attrs, 'color_temp');
  return m !== null && m > 0 ? fromKelvin(miredToKelvin(m)) : null;
}

/** `white` mode: the dedicated white channel, no colour information at all. */
function resolveWhite(attrs: HassEntityAttributeBase): ColorResult | null {
  if (attrs.white === undefined && attrs.color_mode !== 'white') return null;
  return fromKelvin(neutralWhiteKelvin(attrs));
}

const COLOR_LADDER: { modes: string[]; resolve: (a: HassEntityAttributeBase) => ColorResult | null }[] =
  [
    { modes: ['rgbww'], resolve: resolveRgbww },
    { modes: ['rgbw'], resolve: resolveRgbw },
    { modes: ['rgb'], resolve: resolveRgb },
    { modes: ['hs'], resolve: resolveHs },
    { modes: ['xy'], resolve: resolveXy },
    { modes: ['color_temp'], resolve: resolveKelvin },
    { modes: ['color_temp'], resolve: resolveMired },
    { modes: ['white'], resolve: resolveWhite },
  ];

/**
 * The entity's `color_mode` tells us which attribute is authoritative — stale
 * attributes from a previous mode are routinely left in place, so trusting the
 * mode first is what stops a bulb that switched to warm white from staying
 * pink. When the declared mode yields nothing usable we walk the ladder.
 */
function resolveColor(attrs: HassEntityAttributeBase): ColorResult | null {
  const mode = stringAttr(attrs, 'color_mode');
  if (mode) {
    for (const step of COLOR_LADDER) {
      if (!step.modes.includes(mode)) continue;
      const result = step.resolve(attrs);
      if (result) return result;
    }
  }
  for (const step of COLOR_LADDER) {
    const result = step.resolve(attrs);
    if (result) return result;
  }
  return null;
}

function staticColor(placed: PlacedEntity): ColorResult | null {
  const raw = placed.light?.color ?? placed.marker?.color;
  if (!raw) return null;
  const parsed = parseCssColor(raw);
  if (!parsed) return null;
  const color = normalise(rgb255ToLinear(parsed));
  return color ? { color } : null;
}

/* ------------------------------------------------------------ light sample */

/**
 * `brightness` is absent whenever a light is off, so reading it without
 * checking the state hands the renderer the value from before it was switched
 * off. Lights that are on but report nothing (switch-backed, `onoff` mode) are
 * full brightness — that is what they physically are.
 */
function readBrightness(attrs: HassEntityAttributeBase, on: boolean): number {
  if (!on) return 0;
  const raw = numberAttr(attrs, 'brightness');
  if (raw === null) return 1;
  return clamp01(raw / 255);
}

export function toLightSample(entity: HassEntity | undefined, placed: PlacedEntity): LightSample {
  const state = entity?.state ?? 'unavailable';
  const unavailable = !entity || UNAVAILABLE_STATES.has(state);
  const on = state === 'on';
  const attrs = entity?.attributes ?? {};

  const forceStatic = placed.light?.useEntityColor === false;
  const resolved =
    (forceStatic ? staticColor(placed) : null) ??
    (on ? resolveColor(attrs) : null) ??
    staticColor(placed) ??
    warmFallback();

  const effect = stringAttr(attrs, 'effect');

  return {
    on,
    brightness: readBrightness(attrs, on),
    color: resolved.color,
    kelvin: resolved.kelvin,
    effect: effect && effect.toLowerCase() !== 'none' ? effect : undefined,
    unavailable,
  };
}

/** Linear sample colour -> the `#rrggbb` the marker layer and CSS want. */
export function lightSampleToHex(sample: LightSample): string {
  return rgbToHex([
    clamp01(linearToSrgb(sample.color[0])) * 255,
    clamp01(linearToSrgb(sample.color[1])) * 255,
    clamp01(linearToSrgb(sample.color[2])) * 255,
  ]);
}

/* -------------------------------------------------------------------- role */

const ROLE_BY_DOMAIN: Record<string, EntityRole> = {
  light: 'light',
  switch: 'switch',
  sensor: 'sensor',
  binary_sensor: 'binary_sensor',
  cover: 'cover',
  climate: 'climate',
  media_player: 'media_player',
  camera: 'camera',
  person: 'person',
  // Domains that behave identically to one of the above for display purposes.
  input_boolean: 'switch',
  fan: 'switch',
  siren: 'switch',
  humidifier: 'switch',
  automation: 'switch',
  water_heater: 'climate',
  device_tracker: 'person',
  number: 'sensor',
  input_number: 'sensor',
};

export function roleFor(placed: PlacedEntity): EntityRole {
  return placed.role ?? ROLE_BY_DOMAIN[domainOf(placed.entity)] ?? 'marker';
}

/* ------------------------------------------------------------------ active */

const ACTIVE_STATES = new Set([
  'on',
  'open',
  'opening',
  'home',
  'playing',
  'heat',
  'cool',
  'heat_cool',
  'auto',
  'dry',
  'fan_only',
  'unlocked',
  'detected',
  'cleaning',
  'recording',
  'streaming',
  'active',
  'above_horizon',
]);

const INACTIVE_STATES = new Set([
  'off',
  'closed',
  'closing',
  'not_home',
  'idle',
  'standby',
  'locked',
  'docked',
  'paused',
  'clear',
  'below_horizon',
]);

function looksNumeric(state: string, attrs: HassEntityAttributeBase): boolean {
  return Boolean(attrs.unit_of_measurement) || toNumber(state) !== null;
}

/**
 * "Active" drives the marker's accent and glow. It is domain-aware because HA
 * has no single truthy state: a cover is `open`, a person is `home`, a media
 * player is `playing`.
 */
export function isActiveState(
  entityId: string,
  state: string,
  attrs: HassEntityAttributeBase,
): boolean {
  if (UNAVAILABLE_STATES.has(state)) return false;
  const domain = domainOf(entityId);

  // A measurement is never "on" — highlighting every thermometer would make the
  // floorplan a wall of colour.
  if ((domain === 'sensor' || domain === 'number' || domain === 'input_number') &&
    looksNumeric(state, attrs)) {
    return false;
  }

  if (domain === 'person' || domain === 'device_tracker') return state === 'home';
  if (domain === 'cover') return state !== 'closed' && state !== 'closing';
  if (domain === 'climate' || domain === 'water_heater') return state !== 'off';

  if (INACTIVE_STATES.has(state)) return false;
  if (ACTIVE_STATES.has(state)) return true;
  return false;
}

/* ------------------------------------------------------------------- icons */

const DOMAIN_ICONS: Record<string, string> = {
  light: 'mdi:lightbulb',
  switch: 'mdi:toggle-switch-variant',
  input_boolean: 'mdi:toggle-switch-variant',
  fan: 'mdi:fan',
  sensor: 'mdi:eye',
  number: 'mdi:ray-vertex',
  input_number: 'mdi:ray-vertex',
  binary_sensor: 'mdi:checkbox-marked-circle',
  cover: 'mdi:window-shutter',
  climate: 'mdi:thermostat',
  water_heater: 'mdi:water-boiler',
  media_player: 'mdi:speaker',
  camera: 'mdi:video',
  person: 'mdi:account',
  device_tracker: 'mdi:account',
  lock: 'mdi:lock',
  vacuum: 'mdi:robot-vacuum',
  scene: 'mdi:palette',
  script: 'mdi:script-text',
  automation: 'mdi:robot',
  siren: 'mdi:bullhorn',
  humidifier: 'mdi:air-humidifier',
  button: 'mdi:gesture-tap-button',
  input_button: 'mdi:gesture-tap-button',
};

const DEVICE_CLASS_ICONS: Record<string, Record<string, string>> = {
  sensor: {
    temperature: 'mdi:thermometer',
    humidity: 'mdi:water-percent',
    pressure: 'mdi:gauge',
    atmospheric_pressure: 'mdi:gauge',
    illuminance: 'mdi:brightness-5',
    power: 'mdi:flash',
    energy: 'mdi:lightning-bolt',
    current: 'mdi:current-ac',
    voltage: 'mdi:sine-wave',
    battery: 'mdi:battery',
    carbon_dioxide: 'mdi:molecule-co2',
    carbon_monoxide: 'mdi:molecule-co',
    volatile_organic_compounds: 'mdi:air-filter',
    pm25: 'mdi:air-filter',
    pm10: 'mdi:air-filter',
    gas: 'mdi:meter-gas',
    water: 'mdi:water',
    signal_strength: 'mdi:wifi',
    timestamp: 'mdi:clock',
  },
  binary_sensor: {
    motion: 'mdi:motion-sensor',
    occupancy: 'mdi:home-account',
    presence: 'mdi:home',
    door: 'mdi:door',
    garage_door: 'mdi:garage',
    window: 'mdi:window-closed-variant',
    opening: 'mdi:square-outline',
    smoke: 'mdi:smoke-detector',
    gas: 'mdi:gas-cylinder',
    moisture: 'mdi:water-alert',
    problem: 'mdi:alert-circle',
    safety: 'mdi:shield-alert',
    lock: 'mdi:lock',
    sound: 'mdi:music-note',
    vibration: 'mdi:vibrate',
    battery: 'mdi:battery-alert',
  },
  cover: {
    door: 'mdi:door',
    garage: 'mdi:garage',
    gate: 'mdi:gate',
    shutter: 'mdi:window-shutter',
    blind: 'mdi:blinds',
    curtain: 'mdi:curtains',
    awning: 'mdi:awning-outline',
    window: 'mdi:window-open',
    shade: 'mdi:roller-shade',
  },
  switch: {
    outlet: 'mdi:power-socket-eu',
    switch: 'mdi:toggle-switch-variant',
  },
  media_player: {
    tv: 'mdi:television',
    speaker: 'mdi:speaker',
    receiver: 'mdi:audio-video',
  },
};

/**
 * What each role looks like, off and on.
 *
 * Roles are named after the domains they stand for, so these are the domain
 * icons — spelled out rather than derived, because a role is a decision and a
 * domain is a fact, and the two are free to drift.
 *
 * Two icons, not one: a bulb that stays lit while the lamp is off says the
 * wrong thing, and picking the role by hand must not cost you the difference.
 */
const ROLE_ICONS: Record<EntityRole, readonly [off: string, on: string]> = {
  light: ['mdi:lightbulb-off', 'mdi:lightbulb'],
  switch: ['mdi:toggle-switch-off', 'mdi:toggle-switch'],
  sensor: ['mdi:eye', 'mdi:eye'],
  binary_sensor: ['mdi:checkbox-blank-circle-outline', 'mdi:checkbox-marked-circle'],
  cover: ['mdi:blinds-closed', 'mdi:blinds-open'],
  climate: ['mdi:thermostat', 'mdi:thermostat'],
  media_player: ['mdi:speaker', 'mdi:speaker'],
  camera: ['mdi:video', 'mdi:video'],
  person: ['mdi:account', 'mdi:account'],
  marker: ['mdi:map-marker', 'mdi:map-marker'],
};

export function iconFor(
  entityId: string,
  attrs: HassEntityAttributeBase,
  placed?: PlacedEntity,
  registryIcon?: string,
  state?: string,
): string {
  if (placed?.marker?.icon) return placed.marker.icon;
  // A role set by hand outranks the entity's own icon. Overriding the role is
  // how you tell the card what a thing *is* — a switch that drives a lamp, a
  // sensor you want read as a marker — and a marker that kept the old symbol
  // gave no sign the override had taken. An explicit `marker.icon` above still
  // wins, because that is the more specific statement of the two.
  // Only a role that *overrides* the domain, and that is the whole point: it is
  // how you say "this switch drives a lamp". Where the role merely repeats the
  // domain it must not shout down what follows — a `media_player` with a device
  // class of `tv` is a television, and the role would have made it a speaker.
  if (placed?.role && placed.role !== (ROLE_BY_DOMAIN[domainOf(entityId)] ?? 'marker')) {
    const pair = ROLE_ICONS[placed.role];
    if (pair) return isActiveState(entityId, state ?? '', attrs) ? pair[1] : pair[0];
  }
  const own = stringAttr(attrs, 'icon');
  if (own) return own;
  if (registryIcon) return registryIcon;

  const domain = domainOf(entityId);
  const deviceClass = stringAttr(attrs, 'device_class');
  if (deviceClass) {
    const byClass = DEVICE_CLASS_ICONS[domain]?.[deviceClass];
    if (byClass) return byClass;
  }
  return DOMAIN_ICONS[domain] ?? 'mdi:map-marker';
}

/* -------------------------------------------------------------- formatting */

/** Sensible decimal counts; HA rounds by device class rather than by value. */
const PRECISION_BY_DEVICE_CLASS: Record<string, number> = {
  temperature: 1,
  humidity: 0,
  battery: 0,
  illuminance: 0,
  power: 0,
  energy: 2,
  current: 2,
  voltage: 1,
  pressure: 1,
  atmospheric_pressure: 1,
  signal_strength: 0,
  carbon_dioxide: 0,
  pm25: 0,
  pm10: 0,
};

function formatNumber(value: number, decimals: number, language: string): string {
  try {
    return value.toLocaleString(language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
  } catch {
    return String(Number(value.toFixed(decimals)));
  }
}

function localizeState(
  hass: HomeAssistant | undefined,
  domain: string,
  deviceClass: string | undefined,
  state: string,
): string | null {
  if (typeof hass?.localize !== 'function') return null;
  const keys = [
    `component.${domain}.entity_component.${deviceClass ?? '_'}.state.${state}`,
    `component.${domain}.entity_component._.state.${state}`,
    `state.default.${state}`,
  ];
  for (const key of keys) {
    try {
      const translated = hass.localize(key);
      if (typeof translated === 'string' && translated) return translated;
    } catch {
      // A localize implementation that throws is still better ignored than fatal.
    }
  }
  return null;
}

/**
 * Formatted state for the marker's secondary line.
 *
 * `hass.formatEntityState` is the right answer whenever it exists (2023.9+): it
 * knows units, per-entity display precision, timestamps and the user's locale.
 * The fallback below only has to be good enough for older cores.
 */
export function formatEntityState(hass: HomeAssistant | undefined, entity: HassEntity): string {
  if (typeof hass?.formatEntityState === 'function') {
    try {
      const formatted = hass.formatEntityState(entity);
      if (typeof formatted === 'string' && formatted) return formatted;
    } catch {
      // Fall through to the local formatter.
    }
  }

  const attrs = entity.attributes ?? {};
  const state = entity.state;
  if (UNAVAILABLE_STATES.has(state)) {
    return localizeState(hass, domainOf(entity.entity_id), undefined, state) ?? prettifyState(state);
  }

  const unit = stringAttr(attrs, 'unit_of_measurement');
  const numeric = toNumber(state);
  if (numeric !== null && (unit || domainOf(entity.entity_id) === 'sensor')) {
    const deviceClass = stringAttr(attrs, 'device_class');
    const decimals =
      (deviceClass ? PRECISION_BY_DEVICE_CLASS[deviceClass] : undefined) ??
      (Math.abs(numeric) >= 100 ? 0 : Math.abs(numeric) >= 10 ? 1 : 2);
    const language = hass?.locale?.language ?? hass?.language ?? 'en';
    const text = formatNumber(numeric, decimals, language);
    if (!unit) return text;
    return unit === '%' ? `${text}${unit}` : `${text} ${unit}`;
  }

  const localised = localizeState(
    hass,
    domainOf(entity.entity_id),
    stringAttr(attrs, 'device_class'),
    state,
  );
  if (localised) return localised;
  return unit ? `${state} ${unit}` : prettifyState(state);
}

function prettifyState(state: string): string {
  if (!state) return '';
  return state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, ' ');
}

/* ------------------------------------------------------------------ colour */

/** Device classes where "on" means something is wrong, not something is nice. */
const ALARM_CLASSES = new Set([
  'smoke',
  'gas',
  'carbon_monoxide',
  'moisture',
  'problem',
  'safety',
  'tamper',
]);

/**
 * `theme.accent` is deliberately absent below. In Home Assistant's own palette
 * `--accent-color` is amber, which is the colour of a lit lamp — a motion
 * sensor wearing it says "light" to anyone glancing at the plan. Amber belongs
 * to `stateActive`, and `stateActive` belongs to lights.
 */
function accentFor(
  role: EntityRole,
  state: string,
  attrs: HassEntityAttributeBase,
  theme: ThemeColors,
): string {
  switch (role) {
    // The amber HA uses for "on" belongs to light alone. A switch that is on is
    // a switch that is on — reading it as a lamp made a plan of a house look
    // like every socket was glowing.
    case 'light':
      return theme.stateActive;
    case 'switch':
      return theme.success;
    case 'binary_sensor': {
      const deviceClass = stringAttr(attrs, 'device_class');
      return deviceClass && ALARM_CLASSES.has(deviceClass) ? theme.error : theme.primary;
    }
    case 'climate':
      if (state === 'heat' || state === 'heat_cool') return theme.warning;
      return theme.primary;
    case 'person':
      return theme.success;
    case 'cover':
    case 'media_player':
    case 'camera':
    case 'sensor':
    case 'marker':
    default:
      return theme.primary;
  }
}

/* ---------------------------------------------------------- entity visuals */

/**
 * Everything the marker layer needs to draw one entity. Optional `theme` keeps
 * the function pure and testable without a DOM; the card passes the real theme
 * it read off its own element.
 */
export function toEntityVisual(
  entity: HassEntity | undefined,
  placed: PlacedEntity,
  hass: HomeAssistant,
  theme?: ThemeColors,
): EntityVisualState {
  const palette = theme ?? fallbackThemeFor(hass);
  const entityId = placed.entity;
  const state = entity?.state ?? 'unavailable';
  const attrs = entity?.attributes ?? {};
  const unavailable = !entity || UNAVAILABLE_STATES.has(state);
  const role = roleFor(placed);
  const active = unavailable ? false : isActiveState(entityId, state, attrs);

  const label =
    placed.name?.trim() ||
    (entity || hass?.entities?.[entityId] ? getEntityName(hass, entityId) : prettifyEntityId(entityId));

  const registryIcon = (hass?.entities?.[entityId] as { icon?: string | null } | undefined)?.icon;
  const icon = iconFor(entityId, attrs, placed, registryIcon ?? undefined, state);

  let secondary: string | undefined;
  if (entity) {
    secondary = formatEntityState(hass, entity);
    if (role === 'light' && state === 'on') {
      const brightness = numberAttr(attrs, 'brightness');
      if (brightness !== null) {
        secondary = `${secondary} · ${Math.round(clamp01(brightness / 255) * 100)}%`;
      }
    }
  }

  let color: string;
  if (unavailable) {
    color = mixColors(palette.secondaryText, palette.cardBackground, 0.55);
  } else if (placed.marker?.color) {
    color = placed.marker.color;
  } else if (role === 'light' && state === 'on') {
    // A lit lamp should read as the colour it actually is, not as a generic
    // "on" accent — that is the whole point of a 3D floorplan.
    color = lightSampleToHex(toLightSample(entity, placed));
  } else if (active) {
    color = accentFor(role, state, attrs, palette);
  } else {
    color = palette.isDark ? darken(palette.secondaryText, 0.15) : palette.secondaryText;
  }

  return { entityId, state, active, label, secondary, icon, color, unavailable };
}

/* ------------------------------------------------------------------- diffs */

/**
 * HA hands the card a fresh `hass` object on every state change and replaces
 * the `HassEntity` object for anything that actually changed, keeping the same
 * reference for everything else. Identity comparison is therefore both correct
 * and the cheapest dirty check available — no deep compare, no JSON.
 */
export function diffStates(
  prev: HassEntities | undefined,
  next: HassEntities | undefined,
  watched: string[],
): string[] {
  if (prev === next) return [];
  const changed: string[] = [];
  for (const entityId of watched) {
    if (prev?.[entityId] !== next?.[entityId]) changed.push(entityId);
  }
  return changed;
}
