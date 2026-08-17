import { describe, expect, it } from 'vitest';

import { createMockHass } from '@/dev/mock-hass';
import { CARD_TYPE, DEFAULT_RENDER_CONFIG } from '@/types/config';
import {
  ConfigError,
  CURRENT_CONFIG_VERSION,
  migrateConfig,
  normalizeConfig,
  stubConfig,
  validateConfig,
} from '@/ha/config-schema';

const TYPE = `custom:${CARD_TYPE}`;

function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: TYPE, ...extra };
}

/** Asserts the exact message a user will read in their dashboard. */
function expectMessage(raw: unknown, message: string): void {
  expect(() => validateConfig(raw)).toThrowError(ConfigError);
  expect(() => validateConfig(raw)).toThrowError(message);
}

/* ------------------------------------------------------------------ basics */

describe('validateConfig', () => {
  it('accepts a bare config and fills every default', () => {
    const config = validateConfig(minimal());
    expect(config.type).toBe(TYPE);
    expect(config.camera?.fov).toBe(45);
    expect(config.render).toEqual(DEFAULT_RENDER_CONFIG);
    expect(config.ui?.showToolbar).toBe(true);
    expect(config.section?.mode).toBe('none');
    expect(config.section?.planes).toHaveLength(3);
    expect(config.config_version).toBe(CURRENT_CONFIG_VERSION);
  });

  it('rejects anything that is not a mapping', () => {
    for (const raw of ['nope', 42, null, ['a']]) {
      expect(() => validateConfig(raw)).toThrowError(ConfigError);
    }
  });

  it('defaults a missing type so the editor can build configs incrementally', () => {
    expect(validateConfig({}).type).toBe(TYPE);
  });

  it('keeps Lovelace-owned keys it does not understand', () => {
    const config = validateConfig(minimal({ view_layout: { position: 'sidebar' } }));
    expect((config as unknown as Record<string, unknown>).view_layout).toEqual({
      position: 'sidebar',
    });
  });
});

/* ------------------------------------------------------------ error paths */

describe('actionable error messages', () => {
  it('names the exact entity index and field', () => {
    expectMessage(
      minimal({
        entities: [
          { entity: 'light.a', position: [0, 0, 0] },
          { entity: 'light.b', position: [1, 0, 1] },
          { entity: 'light.c', position: 'over there' },
        ],
      }),
      'entities[2]: "position" must be a [x, y, z] array of numbers',
    );
  });

  it('explains a missing position', () => {
    expectMessage(
      minimal({ entities: [{ entity: 'light.a' }] }),
      'entities[0]: "position" is required and must be a [x, y, z] array of numbers',
    );
  });

  it('explains a malformed entity id', () => {
    expectMessage(
      minimal({ entities: [{ entity: 'kitchen light', position: [0, 0, 0] }] }),
      'entities[0]: "entity" must be an entity id like "light.kitchen" (got "kitchen light")',
    );
  });

  it('lists the allowed values of an enum', () => {
    expectMessage(minimal({ section: { mode: 'diagonal' } }), 'section: "mode" must be one of');
  });

  it('rejects a non-numeric number and shows what it got', () => {
    expectMessage(minimal({ camera: { fov: 'wide' } }), 'camera: "fov" must be a number (got "wide")');
  });

  it('enforces numeric bounds', () => {
    expectMessage(minimal({ camera: { fov: 400 } }), 'camera: "fov" must be at most 150');
    expectMessage(
      minimal({ render: { bloomThreshold: 4 } }),
      'render: "bloomThreshold" must be at most 1',
    );
  });

  it('catches an inconsistent camera range', () => {
    expectMessage(
      minimal({ camera: { minDistance: 50, maxDistance: 10 } }),
      'camera: "minDistance" must be smaller than "maxDistance"',
    );
  });

  it('rejects a broken hex colour', () => {
    expectMessage(
      minimal({ entities: [{ entity: 'light.a', position: [0, 0, 0], marker: { color: '#gg' } }] }),
      'entities[0].marker: "color" must be a hex colour like "#ffcc88" (got "#gg")',
    );
  });

  it('requires a service on a call-service action', () => {
    expectMessage(
      minimal({
        entities: [{ entity: 'light.a', position: [0, 0, 0], tap_action: { action: 'call-service' } }],
      }),
      'needs a "perform_action"',
    );
  });

  it('requires a navigation path', () => {
    expectMessage(
      minimal({
        entities: [{ entity: 'light.a', position: [0, 0, 0], tap_action: { action: 'navigate' } }],
      }),
      'needs a "navigation_path"',
    );
  });

  it('catches presets and entities pointing at levels that do not exist', () => {
    const model = { levels: [{ id: 'ground', name: 'Ground', elevation: 0, height: 2.9 }] };
    expectMessage(
      minimal({
        model,
        presets: [
          { id: 'p', name: 'P', position: [1, 1, 1], target: [0, 0, 0], visibleLevels: ['attic'] },
        ],
      }),
      'unknown level "attic"',
    );
    expectMessage(
      minimal({ model, entities: [{ entity: 'light.a', position: [0, 0, 0], level: 'attic' }] }),
      'unknown level "attic"',
    );
  });

  it('catches an action pointing at a preset that does not exist', () => {
    expectMessage(
      minimal({
        presets: [{ id: 'overview', name: 'Overview', position: [1, 1, 1], target: [0, 0, 0] }],
        entities: [
          {
            entity: 'light.a',
            position: [0, 0, 0],
            tap_action: { action: 'preset', preset_id: 'kitchen' },
          },
        ],
      }),
      'unknown preset "kitchen"',
    );
  });

  it('rejects duplicate level ids', () => {
    expectMessage(
      minimal({
        model: {
          levels: [
            { id: 'ground', name: 'A', elevation: 0, height: 2.9 },
            { id: 'ground', name: 'B', elevation: 3, height: 2.9 },
          ],
        },
      }),
      'duplicate level id "ground"',
    );
  });
});

/* -------------------------------------------------------------- coercions */

describe('coercion of things that are obviously intended', () => {
  it('accepts numeric strings', () => {
    const config = validateConfig(minimal({ model: { scale: '2' }, camera: { fov: '60' } }));
    expect(config.model?.scale).toBe(2);
    expect(config.camera?.fov).toBe(60);
  });

  it('accepts snake_case spellings of camelCase options', () => {
    const config = validateConfig(
      minimal({
        ui: { show_toolbar: false, aspect_ratio: '16/9' },
        render: { bloom_strength: 0.9, on_demand: false },
        camera: { auto_rotate: true, max_distance: 40 },
      }),
    );
    expect(config.ui?.showToolbar).toBe(false);
    expect(config.ui?.aspectRatio).toBe('16/9');
    expect(config.render?.bloomStrength).toBe(0.9);
    expect(config.render?.onDemand).toBe(false);
    expect(config.camera?.autoRotate).toBe(true);
    expect(config.camera?.maxDistance).toBe(40);
  });

  it('reads a 2-tuple as a position on the floor', () => {
    const config = validateConfig(
      minimal({ entities: [{ entity: 'light.a', position: [1.5, -2] }] }),
    );
    expect(config.entities?.[0].position).toEqual([1.5, 0, -2]);
  });

  it('accepts a bare entity id and parks it at the origin', () => {
    const config = validateConfig(minimal({ entities: ['light.kitchen'] }));
    expect(config.entities?.[0]).toMatchObject({ entity: 'light.kitchen', position: [0, 0, 0] });
  });

  it('accepts yes/no and 1/0 for booleans, and a number for height', () => {
    const config = validateConfig(
      minimal({ ui: { showFps: 'yes', compact: 0, height: 640 } }),
    );
    expect(config.ui?.showFps).toBe(true);
    expect(config.ui?.compact).toBe(false);
    expect(config.ui?.height).toBe('640px');
  });

  it('accepts a bare string as a shorthand action', () => {
    const config = validateConfig(
      minimal({ entities: [{ entity: 'light.a', position: [0, 0, 0], tap_action: 'none' }] }),
    );
    expect(config.entities?.[0].tap_action).toEqual({ action: 'none' });
  });

  it('accepts both the legacy service and the 2024.8 perform_action key', () => {
    const config = validateConfig(
      minimal({
        entities: [
          {
            entity: 'light.a',
            position: [0, 0, 0],
            tap_action: { action: 'call-service', service: 'light.turn_on' },
            hold_action: { action: 'perform-action', perform_action: 'light.turn_off' },
          },
        ],
      }),
    );
    expect(config.entities?.[0].tap_action?.service).toBe('light.turn_on');
    expect(config.entities?.[0].hold_action?.perform_action).toBe('light.turn_off');
  });

  it('normalises `confirmation: true` to an object', () => {
    const config = validateConfig(
      minimal({
        entities: [
          { entity: 'light.a', position: [0, 0, 0], tap_action: { action: 'toggle', confirmation: true } },
        ],
      }),
    );
    expect(config.entities?.[0].tap_action?.confirmation).toEqual({});
  });

  it('fills the missing clip planes so all three axes exist', () => {
    const config = validateConfig(
      minimal({ section: { mode: 'plane', planes: [{ axis: 'y', position: 1.4, enabled: true }] } }),
    );
    expect(config.section?.planes.map((plane) => plane.axis)).toEqual(['x', 'y', 'z']);
    expect(config.section?.planes[1]).toMatchObject({ position: 1.4, enabled: true });
  });
});

/* ------------------------------------------------------------- normalising */

describe('normalizeConfig', () => {
  it('generates missing preset and level ids and keeps them unique', () => {
    const config = normalizeConfig({
      type: TYPE,
      model: {
        levels: [
          { id: '', name: 'Ground floor', elevation: 0, height: 2.9 },
          { id: '', name: 'Ground floor', elevation: 3, height: 2.9 },
        ],
      },
      presets: [
        { id: '', name: 'Overview', position: [1, 1, 1], target: [0, 0, 0] },
        { id: '', name: 'Overview', position: [2, 2, 2], target: [0, 0, 0] },
      ],
    });
    expect(config.model?.levels?.map((level) => level.id)).toEqual(['ground_floor', 'ground_floor_2']);
    expect(config.presets?.map((preset) => preset.id)).toEqual(['overview', 'overview_2']);
  });

  it('keeps only the first default preset', () => {
    const config = normalizeConfig({
      type: TYPE,
      presets: [
        { id: 'a', name: 'A', position: [1, 1, 1], target: [0, 0, 0], default: true },
        { id: 'b', name: 'B', position: [2, 2, 2], target: [0, 0, 0], default: true },
      ],
    });
    expect(config.presets?.[0].default).toBe(true);
    expect(config.presets?.[1].default).toBeUndefined();
  });

  it('dedupes entities by entity id, keeping the first placement', () => {
    const config = normalizeConfig({
      type: TYPE,
      entities: [
        { entity: 'light.a', position: [1, 0, 1] },
        { entity: 'light.b', position: [2, 0, 2] },
        { entity: 'light.a', position: [9, 9, 9] },
      ],
    });
    expect(config.entities).toHaveLength(2);
    expect(config.entities?.[0].position).toEqual([1, 0, 1]);
  });

  it('rounds coordinates to three decimals before they reach YAML', () => {
    const config = normalizeConfig({
      type: TYPE,
      entities: [{ entity: 'light.a', position: [1.23456789, 0, -2.98765] }],
    });
    expect(config.entities?.[0].position).toEqual([1.235, 0, -2.988]);
  });

  it('is idempotent', () => {
    const once = normalizeConfig({ type: TYPE, entities: [{ entity: 'light.a', position: [1, 2, 3] }] });
    expect(normalizeConfig(once)).toEqual(once);
  });
});

/* -------------------------------------------------------------- migrations */

describe('migrateConfig', () => {
  it('stamps the current version onto an unversioned config', () => {
    const migrated = migrateConfig({ type: TYPE });
    expect(migrated.config_version).toBe(CURRENT_CONFIG_VERSION);
  });

  it('moves v0 `lights` into `entities`', () => {
    const migrated = migrateConfig({
      type: TYPE,
      entities: [{ entity: 'sensor.a', position: [0, 0, 0] }],
      lights: [{ entity: 'light.a', position: [1, 1, 1] }],
    });
    expect(migrated.lights).toBeUndefined();
    expect(migrated.entities).toHaveLength(2);
  });

  it('renames v0 `camera_presets`, `clip` and `model_url`', () => {
    const migrated = migrateConfig({
      type: TYPE,
      camera_presets: [{ id: 'a', name: 'A', position: [1, 1, 1], target: [0, 0, 0] }],
      clip: { mode: 'level', level_id: 'ground' },
      model_url: '/local/house.glb',
    });
    expect(migrated.camera_presets).toBeUndefined();
    expect(migrated.clip).toBeUndefined();
    expect(migrated.model_url).toBeUndefined();
    expect(migrated.presets).toHaveLength(1);
    expect(migrated.section).toEqual({ mode: 'level', level_id: 'ground' });
    expect(migrated.model).toEqual({ url: '/local/house.glb' });
  });

  it('runs the whole chain through validateConfig', () => {
    const config = validateConfig({
      type: TYPE,
      lights: [{ entity: 'light.a', position: [1, 1, 1] }],
      camera_presets: [{ name: 'Overview', position: [8, 6, 8], target: [0, 1, 0] }],
      clip: { mode: 'level', level_id: 'ground' },
      model_url: '/local/house.glb',
    });
    expect(config.config_version).toBe(CURRENT_CONFIG_VERSION);
    expect(config.model?.url).toBe('/local/house.glb');
    expect(config.entities?.[0].entity).toBe('light.a');
    expect(config.presets?.[0].id).toBe('overview');
    expect(config.section?.mode).toBe('level');
    expect(config.section?.levelId).toBe('ground');
  });

  it('does not touch a config written by a newer card', () => {
    const raw = { type: TYPE, config_version: 99, something_new: true };
    const migrated = migrateConfig(raw);
    expect(migrated.config_version).toBe(99);
    expect(migrated.something_new).toBe(true);
  });

  it('never mutates the object Lovelace handed us', () => {
    const raw = { type: TYPE, lights: [{ entity: 'light.a', position: [1, 1, 1] }] };
    migrateConfig(raw);
    expect(raw.lights).toHaveLength(1);
    expect((raw as Record<string, unknown>).config_version).toBeUndefined();
  });

  it('is idempotent once migrated', () => {
    const once = migrateConfig({ type: TYPE, lights: [{ entity: 'light.a', position: [0, 0, 0] }] });
    expect(migrateConfig(once)).toEqual(once);
  });
});

/* ------------------------------------------------------------------- stub */

describe('stubConfig', () => {
  it('places real lights from the install into a starter config', () => {
    const hass = createMockHass();
    const config = stubConfig(hass);

    // No model: the card ships no house, so a new card starts empty and says so.
    expect(config.model).toBeUndefined();
    expect(config.presets).toHaveLength(2);
    expect(config.presets?.some((preset) => preset.default)).toBe(true);
    expect(config.presets?.[1].orthographic).toBe(true);

    expect(config.entities?.length).toBeGreaterThan(0);
    expect(config.entities?.length).toBeLessThanOrEqual(4);
    for (const placed of config.entities ?? []) {
      expect(placed.entity.startsWith('light.')).toBe(true);
      expect(hass.states[placed.entity].state).not.toBe('unavailable');
      expect(placed.position).toHaveLength(3);
    }
  });

  it('produces a config that survives its own validator', () => {
    const config = stubConfig(createMockHass());
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('works on an install with no lights at all', () => {
    const empty = { states: {}, entities: {}, areas: {}, devices: {} } as unknown as Parameters<
      typeof stubConfig
    >[0];
    const config = stubConfig(empty);
    expect(config.entities).toEqual([]);
    expect(() => validateConfig(config)).not.toThrow();
  });
});

