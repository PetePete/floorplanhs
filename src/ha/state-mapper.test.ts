import { describe, expect, it } from 'vitest';

import { createMockHass } from '@/dev/mock-hass';
import type { PlacedEntity } from '@/types/config';
import type { HassEntity } from '@/types/hass';
import {
  diffStates,
  isActiveState,
  lightSampleToHex,
  roleFor,
  toEntityVisual,
  toLightSample,
  xyToRgb255,
} from '@/ha/state-mapper';
import { FALLBACK_THEME_DARK } from '@/ha/theme';

/* --------------------------------------------------------------- fixtures */

function entity(
  entity_id: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HassEntity {
  return {
    entity_id,
    state,
    attributes,
    last_changed: '2026-01-01T00:00:00Z',
    last_updated: '2026-01-01T00:00:00Z',
  };
}

function placed(entity_id: string, extra: Partial<PlacedEntity> = {}): PlacedEntity {
  return { entity: entity_id, position: [0, 0, 0], ...extra };
}

function expectFinite(color: readonly number[]): void {
  for (const channel of color) {
    expect(Number.isFinite(channel)).toBe(true);
    expect(channel).toBeGreaterThanOrEqual(0);
    expect(channel).toBeLessThanOrEqual(1);
  }
}

/* ------------------------------------------------------------- brightness */

describe('toLightSample brightness', () => {
  it('returns 0 for an off light even when a stale brightness lingers', () => {
    // Some integrations keep the attribute around after turning off.
    const sample = toLightSample(
      entity('light.a', 'off', { brightness: 200, color_mode: 'hs', hs_color: [0, 100] }),
      placed('light.a'),
    );
    expect(sample.on).toBe(false);
    expect(sample.brightness).toBe(0);
  });

  it('treats an on light with no brightness attribute as full brightness', () => {
    const sample = toLightSample(entity('light.a', 'on', {}), placed('light.a'));
    expect(sample.on).toBe(true);
    expect(sample.brightness).toBe(1);
  });

  it('scales 0..255 to 0..1', () => {
    const sample = toLightSample(entity('light.a', 'on', { brightness: 128 }), placed('light.a'));
    expect(sample.brightness).toBeCloseTo(128 / 255, 5);
  });

  it('survives a non-numeric brightness', () => {
    const sample = toLightSample(
      entity('light.a', 'on', { brightness: 'quite bright' }),
      placed('light.a'),
    );
    expect(sample.brightness).toBe(1);
  });

  it('accepts a numeric string, as some integrations send', () => {
    const sample = toLightSample(entity('light.a', 'on', { brightness: '255' }), placed('light.a'));
    expect(sample.brightness).toBe(1);
  });

  it('reports unavailable and unknown without crashing', () => {
    for (const state of ['unavailable', 'unknown']) {
      const sample = toLightSample(entity('light.a', state), placed('light.a'));
      expect(sample.unavailable).toBe(true);
      expect(sample.on).toBe(false);
      expect(sample.brightness).toBe(0);
      expectFinite(sample.color);
    }
  });

  it('handles a missing entity', () => {
    const sample = toLightSample(undefined, placed('light.gone'));
    expect(sample.unavailable).toBe(true);
    expect(sample.on).toBe(false);
    expectFinite(sample.color);
  });
});

/* ------------------------------------------------- colour mode precedence */

describe('toLightSample colour modes', () => {
  it('uses rgbww_color first when no color_mode is declared', () => {
    const sample = toLightSample(
      entity('light.a', 'on', {
        rgbww_color: [255, 0, 0, 0, 0],
        rgb_color: [0, 0, 255],
        hs_color: [240, 100],
      }),
      placed('light.a'),
    );
    expect(sample.color[0]).toBeCloseTo(1, 3);
    expect(sample.color[2]).toBeCloseTo(0, 3);
  });

  it('blends the warm white channel of rgbww towards the bulb minimum kelvin', () => {
    const warmOnly = toLightSample(
      entity('light.a', 'on', {
        color_mode: 'rgbww',
        rgbww_color: [0, 0, 0, 0, 255],
        min_color_temp_kelvin: 2000,
        max_color_temp_kelvin: 6500,
      }),
      placed('light.a'),
    );
    const coldOnly = toLightSample(
      entity('light.b', 'on', {
        color_mode: 'rgbww',
        rgbww_color: [0, 0, 0, 255, 0],
        min_color_temp_kelvin: 2000,
        max_color_temp_kelvin: 6500,
      }),
      placed('light.b'),
    );
    expectFinite(warmOnly.color);
    expectFinite(coldOnly.color);
    // Warm white is red-dominant; cold white is close to neutral.
    expect(warmOnly.color[2]).toBeLessThan(0.1);
    expect(coldOnly.color[2]).toBeGreaterThan(warmOnly.color[2]);
  });

  it('falls back from rgbww to rgbw when the 5-tuple is malformed', () => {
    const sample = toLightSample(
      entity('light.a', 'on', { rgbww_color: [255, 0], rgbw_color: [0, 255, 0, 0] }),
      placed('light.a'),
    );
    expect(sample.color[1]).toBeCloseTo(1, 3);
    expect(sample.color[0]).toBeCloseTo(0, 3);
  });

  it('mixes the single white channel of rgbw in', () => {
    const pure = toLightSample(
      entity('light.a', 'on', { color_mode: 'rgbw', rgbw_color: [255, 0, 0, 0] }),
      placed('light.a'),
    );
    const washed = toLightSample(
      entity('light.b', 'on', { color_mode: 'rgbw', rgbw_color: [255, 0, 0, 255] }),
      placed('light.b'),
    );
    expect(pure.color[2]).toBeCloseTo(0, 3);
    expect(washed.color[2]).toBeGreaterThan(pure.color[2]);
  });

  it('honours color_mode over a stale attribute from a previous mode', () => {
    // The bulb is in hs mode but still advertises the rgb it had before.
    const sample = toLightSample(
      entity('light.a', 'on', {
        color_mode: 'hs',
        hs_color: [0, 100],
        rgb_color: [0, 0, 255],
      }),
      placed('light.a'),
    );
    expect(sample.color[0]).toBeCloseTo(1, 3);
    expect(sample.color[2]).toBeCloseTo(0, 3);
  });

  it('reads rgb_color', () => {
    const sample = toLightSample(
      entity('light.a', 'on', { color_mode: 'rgb', rgb_color: [0, 0, 255] }),
      placed('light.a'),
    );
    expect(sample.color[2]).toBeCloseTo(1, 3);
    expect(sample.color[0]).toBeCloseTo(0, 3);
    expect(sample.kelvin).toBeUndefined();
  });

  it('converts xy_color through the Hue Wide-RGB transform', () => {
    // Hue's red primary.
    const sample = toLightSample(
      entity('light.a', 'on', { color_mode: 'xy', xy_color: [0.675, 0.322] }),
      placed('light.a'),
    );
    expect(sample.color[0]).toBeCloseTo(1, 3);
    expect(sample.color[1]).toBeLessThan(0.15);
    expect(sample.color[2]).toBeCloseTo(0, 3);
  });

  it('exposes the xy transform and rejects a degenerate y', () => {
    expect(xyToRgb255(0.3, 0)).toBeNull();
    expect(xyToRgb255(Number.NaN, 0.3)).toBeNull();
    const rgb = xyToRgb255(0.3127, 0.329);
    expect(rgb).not.toBeNull();
    // D65 white point comes out roughly neutral.
    expect(Math.abs((rgb as number[])[0] - (rgb as number[])[2])).toBeLessThan(30);
  });

  it('prefers color_temp_kelvin over legacy mireds', () => {
    const sample = toLightSample(
      entity('light.a', 'on', {
        color_mode: 'color_temp',
        color_temp_kelvin: 6500,
        color_temp: 500,
      }),
      placed('light.a'),
    );
    expect(sample.kelvin).toBe(6500);
    // 6500 K is cool: blue is nearly as strong as red.
    expect(sample.color[2]).toBeGreaterThan(0.8);
  });

  it('falls back to legacy mireds', () => {
    const sample = toLightSample(
      entity('light.a', 'on', { color_mode: 'color_temp', color_temp: 370 }),
      placed('light.a'),
    );
    expect(sample.kelvin).toBeCloseTo(1_000_000 / 370, 0);
    expect(sample.color[0]).toBeGreaterThan(sample.color[2]);
  });

  it('treats white mode as the midpoint of the bulb range', () => {
    const sample = toLightSample(
      entity('light.a', 'on', {
        color_mode: 'white',
        white: 200,
        min_color_temp_kelvin: 2000,
        max_color_temp_kelvin: 6500,
      }),
      placed('light.a'),
    );
    expect(sample.kelvin).toBeGreaterThan(2800);
    expect(sample.kelvin).toBeLessThan(3300);
  });

  it('falls back to warm 2700 K for a colourless light', () => {
    const sample = toLightSample(
      entity('light.a', 'on', { color_mode: 'onoff' }),
      placed('light.a'),
    );
    expect(sample.kelvin).toBe(2700);
    expect(sample.color[0]).toBeGreaterThan(sample.color[2]);
  });

  it('degrades malformed attributes to warm white instead of NaN', () => {
    const sample = toLightSample(
      entity('light.a', 'on', {
        color_mode: 'xy',
        xy_color: 'not a tuple',
        hs_color: ['a', 'b'],
        rgb_color: [0, 0, 0],
        rgbww_color: [1, 2],
        color_temp_kelvin: -5,
        color_temp: 0,
      }),
      placed('light.a'),
    );
    expectFinite(sample.color);
    expect(sample.kelvin).toBe(2700);
  });

  it('normalises so brightness is never applied twice', () => {
    const dim = toLightSample(
      entity('light.a', 'on', { brightness: 20, color_mode: 'rgb', rgb_color: [80, 0, 0] }),
      placed('light.a'),
    );
    expect(Math.max(...dim.color)).toBeCloseTo(1, 5);
    expect(dim.brightness).toBeCloseTo(20 / 255, 5);
  });

  it('reports effects but not the "None" placeholder', () => {
    expect(
      toLightSample(entity('light.a', 'on', { effect: 'Colorloop' }), placed('light.a')).effect,
    ).toBe('Colorloop');
    expect(
      toLightSample(entity('light.a', 'on', { effect: 'None' }), placed('light.a')).effect,
    ).toBeUndefined();
  });

  it('lets a configured colour win when useEntityColor is false', () => {
    const sample = toLightSample(
      entity('light.a', 'on', { color_mode: 'rgb', rgb_color: [255, 0, 0] }),
      placed('light.a', { light: { color: '#00ff00', useEntityColor: false } }),
    );
    expect(sample.color[1]).toBeCloseTo(1, 3);
    expect(sample.color[0]).toBeCloseTo(0, 3);
  });

  it('uses a configured colour when the entity reports none', () => {
    const sample = toLightSample(
      entity('light.a', 'off'),
      placed('light.a', { light: { color: '#0000ff' } }),
    );
    expect(sample.color[2]).toBeCloseTo(1, 3);
  });

  it('converts a sample back to a CSS hex', () => {
    const sample = toLightSample(
      entity('light.a', 'on', { color_mode: 'rgb', rgb_color: [255, 0, 0] }),
      placed('light.a'),
    );
    expect(lightSampleToHex(sample)).toBe('#ff0000');
  });
});

/* ---------------------------------------------------- roles and activeness */

describe('role and active derivation', () => {
  it('derives the role from the domain', () => {
    expect(roleFor(placed('light.a'))).toBe('light');
    expect(roleFor(placed('binary_sensor.a'))).toBe('binary_sensor');
    expect(roleFor(placed('media_player.a'))).toBe('media_player');
    expect(roleFor(placed('vacuum.a'))).toBe('marker');
  });

  it('lets the config override the derived role', () => {
    expect(roleFor(placed('sensor.a', { role: 'marker' }))).toBe('marker');
  });

  it('is domain aware about truthiness', () => {
    expect(isActiveState('light.a', 'on', {})).toBe(true);
    expect(isActiveState('light.a', 'off', {})).toBe(false);
    expect(isActiveState('cover.a', 'open', {})).toBe(true);
    expect(isActiveState('cover.a', 'closed', {})).toBe(false);
    expect(isActiveState('person.a', 'home', {})).toBe(true);
    expect(isActiveState('person.a', 'not_home', {})).toBe(false);
    expect(isActiveState('media_player.a', 'playing', {})).toBe(true);
    expect(isActiveState('media_player.a', 'idle', {})).toBe(false);
    expect(isActiveState('media_player.a', 'standby', {})).toBe(false);
    expect(isActiveState('climate.a', 'heat', {})).toBe(true);
    expect(isActiveState('climate.a', 'cool', {})).toBe(true);
    expect(isActiveState('climate.a', 'off', {})).toBe(false);
    expect(isActiveState('lock.a', 'unlocked', {})).toBe(true);
    expect(isActiveState('lock.a', 'locked', {})).toBe(false);
    expect(isActiveState('binary_sensor.a', 'on', {})).toBe(true);
  });

  it('never marks a numeric sensor active', () => {
    expect(isActiveState('sensor.a', '21.4', { unit_of_measurement: '°C' })).toBe(false);
    expect(isActiveState('sensor.a', '0', {})).toBe(false);
    expect(isActiveState('sensor.a', '1', {})).toBe(false);
  });

  it('treats unavailable as inactive', () => {
    expect(isActiveState('light.a', 'unavailable', {})).toBe(false);
    expect(isActiveState('light.a', 'unknown', {})).toBe(false);
  });
});

/* --------------------------------------------------------- entity visuals */

describe('toEntityVisual', () => {
  const hass = createMockHass();

  it('maps a lit light to its real colour', () => {
    const config = placed('light.office_desk');
    const visual = toEntityVisual(hass.states['light.office_desk'], config, hass);
    expect(visual.active).toBe(true);
    expect(visual.label).toBe('Desk lamp');
    expect(visual.icon).toBe('mdi:lightbulb');
    expect(visual.color).toMatch(/^#[0-9a-f]{6}$/);
    // rgb_color [120, 200, 255] is clearly blue-dominant.
    const [, , blue] = [visual.color.slice(1, 3), visual.color.slice(3, 5), visual.color.slice(5, 7)];
    expect(parseInt(blue, 16)).toBeGreaterThan(200);
  });

  it('shows the brightness percentage on the secondary line', () => {
    const visual = toEntityVisual(
      hass.states['light.living_room_ceiling'],
      placed('light.living_room_ceiling'),
      hass,
    );
    expect(visual.secondary).toContain('%');
  });

  it('formats a numeric sensor with its unit and never marks it active', () => {
    const visual = toEntityVisual(
      hass.states['sensor.living_room_temperature'],
      placed('sensor.living_room_temperature'),
      hass,
    );
    expect(visual.active).toBe(false);
    expect(visual.secondary).toBe('21.4 °C');
    expect(visual.icon).toBe('mdi:thermometer');
  });

  it('picks device-class icons for binary sensors and covers', () => {
    expect(
      toEntityVisual(hass.states['binary_sensor.front_door'], placed('binary_sensor.front_door'), hass)
        .icon,
    ).toBe('mdi:door');
    expect(
      toEntityVisual(
        hass.states['cover.living_room_blinds'],
        placed('cover.living_room_blinds'),
        hass,
      ).icon,
    ).toBe('mdi:blinds');
  });

  it('respects the label and icon precedence', () => {
    const visual = toEntityVisual(
      hass.states['light.office_desk'],
      placed('light.office_desk', { name: 'Study lamp', marker: { icon: 'mdi:desk-lamp' } }),
      hass,
    );
    expect(visual.label).toBe('Study lamp');
    expect(visual.icon).toBe('mdi:desk-lamp');
  });

  it('prettifies the entity id when nothing else is known', () => {
    const visual = toEntityVisual(undefined, placed('light.spare_room_2'), hass);
    expect(visual.unavailable).toBe(true);
    expect(visual.active).toBe(false);
    expect(visual.label).toBe('Spare Room 2');
    expect(visual.secondary).toBeUndefined();
  });

  it('marks an unavailable entity and dims it', () => {
    const active = toEntityVisual(
      hass.states['switch.tv_power'],
      placed('switch.tv_power'),
      hass,
    );
    const dead = toEntityVisual(
      hass.states['light.basement_strip'],
      placed('light.basement_strip'),
      hass,
    );
    expect(dead.unavailable).toBe(true);
    expect(dead.color).not.toBe(active.color);
  });

  it('lets a configured marker colour win', () => {
    const visual = toEntityVisual(
      hass.states['switch.tv_power'],
      placed('switch.tv_power', { marker: { color: '#123456' } }),
      hass,
    );
    expect(visual.color).toBe('#123456');
  });
});

/* ------------------------------------------------------------------ diffs */

describe('diffStates', () => {
  it('returns nothing when the states object is unchanged', () => {
    const hass = createMockHass();
    expect(diffStates(hass.states, hass.states, ['light.hallway'])).toEqual([]);
  });

  it('reports only the watched entities whose object identity changed', async () => {
    const hass = createMockHass();
    const before = hass.states;
    await hass.callService('light', 'turn_off', undefined, {
      entity_id: 'light.living_room_ceiling',
    });
    const after = hass.states;

    expect(
      diffStates(before, after, ['light.living_room_ceiling', 'light.office_desk']),
    ).toEqual(['light.living_room_ceiling']);
  });

  it('ignores entities that are not watched', async () => {
    const hass = createMockHass();
    const before = hass.states;
    await hass.callService('light', 'turn_off', undefined, { entity_id: 'light.office_desk' });
    expect(diffStates(before, hass.states, ['light.hallway'])).toEqual([]);
  });

  it('detects appearing and disappearing entities', () => {
    const a = { 'light.a': entity('light.a', 'on') };
    expect(diffStates(undefined, a, ['light.a'])).toEqual(['light.a']);
    expect(diffStates(a, {}, ['light.a'])).toEqual(['light.a']);
  });

  it('sees the brightness drop after HA strips the attribute on turn-off', async () => {
    const hass = createMockHass();
    const config = placed('light.living_room_ceiling');
    expect(toLightSample(hass.states['light.living_room_ceiling'], config).brightness).toBeCloseTo(
      220 / 255,
      5,
    );

    await hass.callService('light', 'turn_off', undefined, {
      entity_id: 'light.living_room_ceiling',
    });

    const off = toLightSample(hass.states['light.living_room_ceiling'], config);
    expect(off.on).toBe(false);
    expect(off.brightness).toBe(0);
    expectFinite(off.color);
  });
});

/**
 * Amber means "a lamp is lit". A switch that is on is a switch that is on —
 * borrowing the lamp colour made a plan of a house look like every socket in
 * it was glowing.
 */
describe('what "on" looks like per role', () => {
  const hass = createMockHass();

  it('gives an active switch a colour of its own', () => {
    const on = entity('switch.kettle', 'on');
    const visual = toEntityVisual(on, placed('switch.kettle'), hass, FALLBACK_THEME_DARK);
    expect(visual.active).toBe(true);
    expect(visual.color).toBe(FALLBACK_THEME_DARK.success);
    expect(visual.color).not.toBe(FALLBACK_THEME_DARK.stateActive);
  });

  it('keeps a lit lamp warm, whatever the switch does', () => {
    const on = entity('light.hall', 'on');
    const visual = toEntityVisual(on, placed('light.hall'), hass, FALLBACK_THEME_DARK);
    // An on/off light reports no colour of its own, so it gets the warm white a
    // bulb actually is — warm meaning more red in it than blue.
    const red = parseInt(visual.color.slice(1, 3), 16);
    const blue = parseInt(visual.color.slice(5, 7), 16);
    expect(red).toBeGreaterThan(blue);
    expect(visual.color).not.toBe(FALLBACK_THEME_DARK.success);
  });

  it('leaves an off switch in the inactive grey', () => {
    const off = entity('switch.kettle', 'off');
    const visual = toEntityVisual(off, placed('switch.kettle'), hass, FALLBACK_THEME_DARK);
    expect(visual.active).toBe(false);
    expect(visual.color).not.toBe(FALLBACK_THEME_DARK.success);
  });
});
