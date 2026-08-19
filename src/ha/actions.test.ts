import { describe, expect, it } from 'vitest';

import { defaultActionFor, hasAction, isToggleable, toggleEntity } from '@/ha/actions';
import type { HomeAssistant } from '@/types/hass';

/**
 * What a tap does when the config says nothing.
 *
 * A floorplan on a wall is touched by people walking past it, so the default
 * has to be safe: operate what is meant to be operated, and leave everything
 * else alone. A motion sensor is not a control — and opening its dialog puts
 * the device's own settings one further tap away, which is how a sensor ends up
 * disabled by someone who only meant to look at the house.
 */
describe('default actions', () => {
  it('toggles the things that can be operated', () => {
    for (const id of ['light.hall', 'switch.kettle', 'cover.garage', 'fan.study']) {
      expect(defaultActionFor('tap', id), id).toEqual({ action: 'toggle' });
    }
  });

  it('does nothing on a tap for something that can only be read', () => {
    for (const id of [
      'binary_sensor.usl_motion_bewegung',
      'sensor.living_room_temperature',
      'device_tracker.phone',
      'camera.porch',
    ]) {
      expect(isToggleable(id), id).toBe(false);
      expect(defaultActionFor('tap', id), id).toEqual({ action: 'none' });
    }
  });

  it('keeps the dialog on hold, so nothing is out of reach', () => {
    expect(defaultActionFor('hold', 'binary_sensor.motion')).toEqual({ action: 'more-info' });
    expect(defaultActionFor('hold', 'light.hall')).toEqual({ action: 'more-info' });
  });

  it('leaves double-tap unassigned', () => {
    expect(defaultActionFor('double-tap', 'light.hall')).toEqual({ action: 'none' });
  });

  it('does nothing at all without an entity', () => {
    for (const kind of ['tap', 'hold', 'double-tap'] as const) {
      expect(defaultActionFor(kind, undefined)).toEqual({ action: 'none' });
    }
  });

  it('reports which of those count as an action', () => {
    expect(hasAction(defaultActionFor('tap', 'light.hall'))).toBe(true);
    expect(hasAction(defaultActionFor('tap', 'sensor.temperature'))).toBe(false);
  });
});

/**
 * A script is not a state you change, it is an errand you send. Tapping one
 * should run it — `script.toggle` would stop a running script, which is not
 * what tapping "Gute Nacht" means.
 */
describe('running a script or a scene', () => {
  function recorder(): { hass: HomeAssistant; calls: Array<[string, string, unknown]> } {
    const calls: Array<[string, string, unknown]> = [];
    const hass = {
      states: {},
      callService: async (domain: string, service: string, data: unknown) => {
        calls.push([domain, service, data]);
      },
    } as unknown as HomeAssistant;
    return { hass, calls };
  }

  it('turns a script on rather than toggling it', async () => {
    const { hass, calls } = recorder();
    await toggleEntity(hass, 'script.good_night');
    expect(calls).toEqual([['script', 'turn_on', {}]]);
  });

  it('turns a scene on', async () => {
    const { hass, calls } = recorder();
    await toggleEntity(hass, 'scene.movie');
    expect(calls).toEqual([['scene', 'turn_on', {}]]);
  });

  it('offers both to a tap, since both are things you can operate', () => {
    expect(defaultActionFor('tap', 'script.good_night')).toEqual({ action: 'toggle' });
    expect(defaultActionFor('tap', 'scene.movie')).toEqual({ action: 'toggle' });
  });
});
