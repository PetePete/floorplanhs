/**
 * Camera preset storage: pure data, no three.js, no DOM. Everything here has to
 * survive a hand-edited YAML file — a user who types `position: [1, 2]` must
 * get a readable error, never a camera at NaN that renders a black card.
 */

import type { CameraPreset, SectionState, Vec3 } from '@/types/config';
import { isVec3, slugify, uid, vRound } from '@/util/math';

export class PresetValidationError extends Error {
  readonly field: string;

  constructor(message: string, field = '') {
    super(field ? `${message} (at "${field}")` : message);
    this.name = 'PresetValidationError';
    this.field = field;
  }
}

/* --------------------------------------------------------------- coercion */

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true;
    if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false;
  }
  return null;
}

/**
 * Accepts everything a human plausibly writes for a point:
 * `[1, 2, 3]`, `{ x: 1, y: 2, z: 3 }`, `"1, 2, 3"` and `"1 2 3"`.
 */
export function parseVec3(value: unknown, field: string): Vec3 {
  if (isVec3(value)) return [value[0], value[1], value[2]];

  if (Array.isArray(value)) {
    if (value.length !== 3) {
      throw new PresetValidationError(`expected 3 numbers, got ${value.length}`, field);
    }
    const nums = value.map(toNumber);
    if (nums.some((n) => n === null)) {
      throw new PresetValidationError('expected 3 finite numbers', field);
    }
    return [nums[0] as number, nums[1] as number, nums[2] as number];
  }

  if (typeof value === 'string') {
    const parts = value.split(/[\s,]+/).filter((p) => p !== '');
    return parseVec3(parts, field);
  }

  if (isDict(value)) {
    const x = toNumber(value.x);
    const y = toNumber(value.y);
    const z = toNumber(value.z);
    if (x === null || y === null || z === null) {
      throw new PresetValidationError('expected numeric x, y and z', field);
    }
    return [x, y, z];
  }

  throw new PresetValidationError('expected [x, y, z]', field);
}

/* ------------------------------------------------------------ normalising */

function normalizeVisibleLevels(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : [value];
  if (Array.isArray(value)) {
    const ids = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return ids.length > 0 ? ids : null;
  }
  return null;
}

/** Passed through untouched — the section controller owns this schema. */
function normalizeSection(value: unknown): SectionState | undefined {
  if (!isDict(value)) return undefined;
  const mode = value.mode;
  if (mode !== 'none' && mode !== 'level' && mode !== 'plane' && mode !== 'box') return undefined;
  return value as unknown as SectionState;
}

/**
 * Turn one hand-written entry into a valid preset, or throw with a message the
 * editor can show verbatim.
 */
export function normalizePreset(raw: unknown, indexHint = 0): CameraPreset {
  if (!isDict(raw)) {
    throw new PresetValidationError('preset must be a mapping', `presets[${indexHint}]`);
  }

  const nameRaw = raw.name ?? raw.title ?? raw.label;
  const name = typeof nameRaw === 'string' && nameRaw.trim() !== ''
    ? nameRaw.trim()
    : `View ${indexHint + 1}`;

  const field = `presets[${indexHint}] "${name}"`;
  const position = vRound(parseVec3(raw.position ?? raw.camera ?? raw.eye, `${field}.position`));
  const target = raw.target === undefined && raw.look_at === undefined && raw.lookAt === undefined
    ? ([0, 0, 0] as Vec3)
    : vRound(parseVec3(raw.target ?? raw.look_at ?? raw.lookAt, `${field}.target`));

  const idRaw = raw.id;
  const id = typeof idRaw === 'string' && idRaw.trim() !== ''
    ? idRaw.trim()
    : `${slugify(name)}_${uid('p').slice(-6)}`;

  const preset: CameraPreset = { id, name, position, target };

  const icon = raw.icon;
  if (typeof icon === 'string' && icon.trim() !== '') preset.icon = icon.trim();

  const fov = toNumber(raw.fov);
  if (fov !== null) {
    if (fov <= 0 || fov >= 180) {
      throw new PresetValidationError(`fov must be between 0 and 180, got ${fov}`, field);
    }
    preset.fov = fov;
  }

  const ortho = toBool(raw.orthographic ?? raw.ortho);
  if (ortho !== null) preset.orthographic = ortho;

  const orthoZoom = toNumber(raw.orthoZoom ?? raw.ortho_zoom ?? raw.zoom);
  if (orthoZoom !== null) {
    if (orthoZoom <= 0) {
      throw new PresetValidationError(`orthoZoom must be > 0, got ${orthoZoom}`, field);
    }
    preset.orthoZoom = orthoZoom;
  }

  const section = normalizeSection(raw.section);
  if (section) preset.section = section;

  const visibleLevels = normalizeVisibleLevels(raw.visibleLevels ?? raw.visible_levels ?? raw.levels);
  if (visibleLevels !== undefined) preset.visibleLevels = visibleLevels;

  const isDefault = toBool(raw.default ?? raw.is_default);
  if (isDefault) preset.default = true;

  const inTour = toBool(raw.inTour ?? raw.in_tour ?? raw.tour);
  if (inTour !== null) preset.inTour = inTour;

  return preset;
}

export interface PresetParseResult {
  presets: CameraPreset[];
  /** Human-readable reasons the dropped entries were dropped. */
  errors: string[];
}

/**
 * Tolerant parse: bad entries are dropped with an explanation instead of
 * poisoning the whole list. Duplicate ids are re-issued so lookups stay sane.
 */
export function parsePresets(raw: unknown): PresetParseResult {
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { presets: [], errors };

  const entries = Array.isArray(raw) ? raw : isDict(raw) ? Object.values(raw) : null;
  if (!entries) {
    return { presets: [], errors: ['presets must be a list'] };
  }

  const presets: CameraPreset[] = [];
  const seen = new Set<string>();
  let defaultSeen = false;

  entries.forEach((entry, index) => {
    let preset: CameraPreset;
    try {
      preset = normalizePreset(entry, index);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return;
    }
    if (seen.has(preset.id)) {
      preset.id = `${preset.id}_${uid('d').slice(-4)}`;
    }
    seen.add(preset.id);
    if (preset.default) {
      if (defaultSeen) delete preset.default;
      else defaultSeen = true;
    }
    presets.push(preset);
  });

  return { presets, errors };
}

/** Tolerant parse used when loading a dashboard config. Never throws. */
export function migratePresets(raw: unknown): CameraPreset[] {
  const { presets, errors } = parsePresets(raw);
  for (const message of errors) {
    console.warn(`[floorplan-3d] ignoring camera preset: ${message}`);
  }
  return presets;
}

/* ------------------------------------------------------------------ store */

function clone(preset: CameraPreset): CameraPreset {
  return JSON.parse(JSON.stringify(preset)) as CameraPreset;
}

/**
 * Ordered collection of camera presets. Owns nothing visual — the card reads
 * `list()` straight into YAML and the camera controller reads presets out.
 */
export class PresetStore {
  private presets: CameraPreset[] = [];

  constructor(initial?: unknown) {
    if (initial !== undefined) this.replaceAll(initial);
  }

  /** Tolerant bulk load; returns the entries that had to be dropped. */
  replaceAll(raw: unknown): string[] {
    const { presets, errors } = parsePresets(raw);
    this.presets = presets;
    this.enforceSingleDefault();
    return errors;
  }

  get size(): number {
    return this.presets.length;
  }

  list(): CameraPreset[] {
    return this.presets.map(clone);
  }

  get(id: string): CameraPreset | null {
    const found = this.presets.find((p) => p.id === id);
    return found ? clone(found) : null;
  }

  at(index: number): CameraPreset | null {
    const found = this.presets[index];
    return found ? clone(found) : null;
  }

  has(id: string): boolean {
    return this.presets.some((p) => p.id === id);
  }

  /** Validates and appends. Throws {@link PresetValidationError} on bad input. */
  add(preset: CameraPreset, index?: number): CameraPreset {
    const normalized = normalizePreset(preset, this.presets.length);
    if (this.has(normalized.id)) normalized.id = `${normalized.id}_${uid('d').slice(-4)}`;
    const at = index === undefined ? this.presets.length : Math.max(0, Math.min(index, this.presets.length));
    this.presets.splice(at, 0, normalized);
    if (normalized.default) this.setDefault(normalized.id);
    return clone(normalized);
  }

  /** Shallow patch. Vectors in the patch go through the same validation. */
  update(id: string, patch: Partial<CameraPreset>): CameraPreset | null {
    const index = this.presets.findIndex((p) => p.id === id);
    if (index < 0) return null;
    const merged = { ...this.presets[index], ...patch, id };
    const normalized = normalizePreset(merged, index);
    this.presets[index] = normalized;
    if (patch.default) this.setDefault(id);
    return clone(normalized);
  }

  remove(id: string): boolean {
    const index = this.presets.findIndex((p) => p.id === id);
    if (index < 0) return false;
    const wasDefault = this.presets[index].default === true;
    this.presets.splice(index, 1);
    if (wasDefault && this.presets.length > 0) this.presets[0].default = true;
    return true;
  }

  /** Move a preset to `toIndex`, clamped. Returns false when the id is unknown. */
  reorder(id: string, toIndex: number): boolean {
    const from = this.presets.findIndex((p) => p.id === id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(toIndex, this.presets.length - 1));
    if (to === from) return true;
    const [moved] = this.presets.splice(from, 1);
    this.presets.splice(to, 0, moved);
    return true;
  }

  /** The flagged default, or the first preset when nothing is flagged. */
  getDefault(): CameraPreset | null {
    const flagged = this.presets.find((p) => p.default === true);
    if (flagged) return clone(flagged);
    return this.presets.length > 0 ? clone(this.presets[0]) : null;
  }

  setDefault(id: string | null): boolean {
    let found = id === null;
    for (const preset of this.presets) {
      if (preset.id === id) {
        preset.default = true;
        found = true;
      } else {
        delete preset.default;
      }
    }
    return found;
  }

  /**
   * Next stop of the auto-rotate slideshow. Cycles the `inTour` presets, or all
   * of them when the user never marked any.
   */
  nextTourPreset(currentId: string | null): CameraPreset | null {
    const tour = this.presets.filter((p) => p.inTour === true);
    const pool = tour.length > 0 ? tour : this.presets;
    if (pool.length === 0) return null;
    const index = currentId === null ? -1 : pool.findIndex((p) => p.id === currentId);
    return clone(pool[(index + 1) % pool.length]);
  }

  private enforceSingleDefault(): void {
    let seen = false;
    for (const preset of this.presets) {
      if (preset.default !== true) continue;
      if (seen) delete preset.default;
      else seen = true;
    }
  }
}
