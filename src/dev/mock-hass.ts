/**
 * A believable fake `hass` object so the card can be developed and reviewed
 * without a running Home Assistant. It models the parts we actually depend on:
 * a state machine that mutates on service calls, the area/device/entity
 * registries, theme flags and `formatEntityState`.
 *
 * Not shipped: nothing in `src/dev` is reachable from `src/main.ts`, so the
 * library build tree-shakes it away entirely.
 */

import type {
  HassArea,
  HassDevice,
  HassEntities,
  HassEntity,
  HassEntityRegistryEntry,
  HomeAssistant,
} from '@/types/hass';

type Listener = (hass: MockHass) => void;

interface EntitySeed {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  area?: string;
}

const AREAS: HassArea[] = [
  { area_id: 'living_room', name: 'Living room', icon: 'mdi:sofa', floor_id: 'ground' },
  { area_id: 'kitchen', name: 'Kitchen', icon: 'mdi:countertop', floor_id: 'ground' },
  { area_id: 'hallway', name: 'Hallway', icon: 'mdi:door', floor_id: 'ground' },
  { area_id: 'bedroom', name: 'Bedroom', icon: 'mdi:bed', floor_id: 'upper' },
  { area_id: 'bathroom', name: 'Bathroom', icon: 'mdi:shower', floor_id: 'upper' },
  { area_id: 'office', name: 'Office', icon: 'mdi:desk', floor_id: 'upper' },
  { area_id: 'basement', name: 'Basement', icon: 'mdi:home-floor-b', floor_id: 'basement' },
];

const SEEDS: EntitySeed[] = [
  // Lights — deliberately spanning every colour mode we claim to support, so
  // the state mapper gets exercised for real during review.
  {
    entity_id: 'light.living_room_ceiling',
    state: 'on',
    area: 'living_room',
    attributes: {
      friendly_name: 'Living room ceiling',
      brightness: 220,
      color_mode: 'color_temp',
      color_temp_kelvin: 2900,
      min_color_temp_kelvin: 2000,
      max_color_temp_kelvin: 6500,
      supported_color_modes: ['color_temp', 'hs'],
    },
  },
  {
    entity_id: 'light.living_room_floor_lamp',
    state: 'on',
    area: 'living_room',
    attributes: {
      friendly_name: 'Floor lamp',
      brightness: 140,
      color_mode: 'hs',
      hs_color: [28, 72],
      rgb_color: [255, 168, 71],
      supported_color_modes: ['hs'],
    },
  },
  {
    entity_id: 'light.kitchen_counter',
    state: 'on',
    area: 'kitchen',
    attributes: {
      friendly_name: 'Kitchen counter',
      brightness: 255,
      color_mode: 'xy',
      xy_color: [0.38, 0.36],
      supported_color_modes: ['xy'],
    },
  },
  {
    entity_id: 'light.hallway',
    state: 'off',
    area: 'hallway',
    attributes: { friendly_name: 'Hallway', supported_color_modes: ['onoff'] },
  },
  {
    entity_id: 'light.bedroom_bedside',
    state: 'on',
    area: 'bedroom',
    attributes: {
      friendly_name: 'Bedside lamp',
      brightness: 60,
      color_mode: 'rgbww',
      rgbww_color: [255, 120, 40, 90, 20],
      min_color_temp_kelvin: 2200,
      max_color_temp_kelvin: 6500,
      supported_color_modes: ['rgbww'],
    },
  },
  {
    entity_id: 'light.bathroom_mirror',
    state: 'off',
    area: 'bathroom',
    attributes: { friendly_name: 'Mirror light', supported_color_modes: ['brightness'] },
  },
  {
    entity_id: 'light.office_desk',
    state: 'on',
    area: 'office',
    attributes: {
      friendly_name: 'Desk lamp',
      brightness: 200,
      color_mode: 'rgb',
      rgb_color: [120, 200, 255],
      supported_color_modes: ['rgb'],
    },
  },
  {
    entity_id: 'light.basement_strip',
    state: 'unavailable',
    area: 'basement',
    attributes: { friendly_name: 'Basement strip' },
  },

  // Switches
  {
    entity_id: 'switch.coffee_machine',
    state: 'off',
    area: 'kitchen',
    attributes: { friendly_name: 'Coffee machine', device_class: 'outlet' },
  },
  {
    entity_id: 'switch.tv_power',
    state: 'on',
    area: 'living_room',
    attributes: { friendly_name: 'TV power' },
  },

  // Sensors
  {
    entity_id: 'sensor.living_room_temperature',
    state: '21.4',
    area: 'living_room',
    attributes: {
      friendly_name: 'Living room temperature',
      device_class: 'temperature',
      unit_of_measurement: '°C',
      state_class: 'measurement',
    },
  },
  {
    entity_id: 'sensor.bedroom_humidity',
    state: '47',
    area: 'bedroom',
    attributes: {
      friendly_name: 'Bedroom humidity',
      device_class: 'humidity',
      unit_of_measurement: '%',
    },
  },
  {
    entity_id: 'sensor.power_consumption',
    state: '1342',
    attributes: {
      friendly_name: 'Power consumption',
      device_class: 'power',
      unit_of_measurement: 'W',
    },
  },

  // Binary sensors
  {
    entity_id: 'binary_sensor.hallway_motion',
    state: 'off',
    area: 'hallway',
    attributes: { friendly_name: 'Hallway motion', device_class: 'motion' },
  },
  {
    entity_id: 'binary_sensor.front_door',
    state: 'off',
    area: 'hallway',
    attributes: { friendly_name: 'Front door', device_class: 'door' },
  },
  {
    entity_id: 'binary_sensor.kitchen_window',
    state: 'on',
    area: 'kitchen',
    attributes: { friendly_name: 'Kitchen window', device_class: 'window' },
  },

  // Covers, climate, media
  {
    entity_id: 'cover.living_room_blinds',
    state: 'open',
    area: 'living_room',
    attributes: {
      friendly_name: 'Living room blinds',
      device_class: 'blind',
      current_position: 100,
      supported_features: 15,
    },
  },
  {
    entity_id: 'climate.ground_floor',
    state: 'heat',
    area: 'living_room',
    attributes: {
      friendly_name: 'Ground floor heating',
      current_temperature: 21.4,
      temperature: 22,
      hvac_action: 'heating',
    },
  },
  {
    entity_id: 'media_player.living_room_tv',
    state: 'playing',
    area: 'living_room',
    attributes: { friendly_name: 'Living room TV', media_title: 'Some documentary' },
  },
  {
    entity_id: 'lock.front_door',
    state: 'locked',
    area: 'hallway',
    attributes: { friendly_name: 'Front door lock' },
  },

  // The sun drives the daylight rig.
  {
    entity_id: 'sun.sun',
    state: 'above_horizon',
    attributes: {
      friendly_name: 'Sun',
      elevation: 34.2,
      azimuth: 196.5,
      rising: false,
    },
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

function makeEntity(seed: EntitySeed): HassEntity {
  return {
    entity_id: seed.entity_id,
    state: seed.state,
    attributes: { ...(seed.attributes ?? {}) },
    last_changed: nowIso(),
    last_updated: nowIso(),
  };
}

export class MockHass implements HomeAssistant {
  states: HassEntities = {};
  connected = true;
  language = 'en';
  locale = { language: 'en', number_format: 'language', time_format: 'language' };
  themes = { theme: 'default', darkMode: true, dark: true };
  user = { id: 'dev', name: 'Developer', is_admin: true };
  areas: Record<string, HassArea> = {};
  devices: Record<string, HassDevice> = {};
  entities: Record<string, HassEntityRegistryEntry> = {};

  connection = {
    subscribeEvents: async () => async () => undefined,
    sendMessagePromise: async <T>() => ({}) as T,
  };

  private listeners = new Set<Listener>();
  private sunTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    for (const area of AREAS) this.areas[area.area_id] = area;

    for (const seed of SEEDS) {
      this.states[seed.entity_id] = makeEntity(seed);
      const deviceId = `dev_${seed.entity_id.replace('.', '_')}`;
      this.devices[deviceId] = {
        id: deviceId,
        name: (seed.attributes?.friendly_name as string) ?? seed.entity_id,
        area_id: seed.area ?? null,
      };
      this.entities[seed.entity_id] = {
        entity_id: seed.entity_id,
        device_id: deviceId,
        area_id: seed.area ?? null,
        name: null,
        platform: 'demo',
      };
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * HA replaces the whole `states` object and the changed entity object on
   * every update. Reproducing that exactly matters: the card relies on object
   * identity as its dirty check.
   */
  private commit(entityId: string, patch: Partial<HassEntity>): void {
    const prev = this.states[entityId];
    if (!prev) return;
    const next: HassEntity = {
      ...prev,
      ...patch,
      attributes: { ...prev.attributes, ...(patch.attributes ?? {}) },
      last_updated: nowIso(),
      last_changed: patch.state && patch.state !== prev.state ? nowIso() : prev.last_changed,
    };
    this.states = { ...this.states, [entityId]: next };
    for (const cb of [...this.listeners]) cb(this);
  }

  setState(entityId: string, state: string, attributes?: Record<string, unknown>): void {
    this.commit(entityId, { state, attributes: attributes ?? {} });
  }

  async callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: { entity_id?: string | string[] },
  ): Promise<unknown> {
    const raw = target?.entity_id ?? (data?.entity_id as string | string[] | undefined);
    const ids = Array.isArray(raw) ? raw : raw ? [raw] : [];

    for (const id of ids) {
      const entity = this.states[id];
      if (!entity) continue;
      const entityDomain = id.split('.')[0];

      if (service === 'toggle') {
        const on = entity.state === 'on' || entity.state === 'open' || entity.state === 'unlocked';
        await this.callService(domain, on ? 'turn_off' : 'turn_on', data, { entity_id: id });
        continue;
      }

      if (service === 'turn_on') {
        const attrs: Record<string, unknown> = { ...data };
        delete attrs.entity_id;
        if (entityDomain === 'light' && attrs.brightness === undefined && !entity.attributes.brightness) {
          attrs.brightness = 255;
        }
        this.commit(id, { state: 'on', attributes: attrs });
        continue;
      }

      if (service === 'turn_off') {
        // HA drops brightness/colour attributes when a light goes off. The
        // state mapper must not read stale values, so mirror that here.
        const kept: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(this.states[id].attributes)) {
          if (
            k === 'brightness' ||
            k.startsWith('rgb') ||
            k.startsWith('hs_') ||
            k.startsWith('xy_') ||
            k.startsWith('color_temp') ||
            k === 'color_mode'
          ) {
            continue;
          }
          kept[k] = v;
        }
        this.states = {
          ...this.states,
          [id]: {
            ...this.states[id],
            state: 'off',
            attributes: kept,
            last_updated: nowIso(),
            last_changed: nowIso(),
          },
        };
        for (const cb of [...this.listeners]) cb(this);
        continue;
      }

      if (service === 'open_cover') this.commit(id, { state: 'open', attributes: { current_position: 100 } });
      if (service === 'close_cover') this.commit(id, { state: 'closed', attributes: { current_position: 0 } });
      if (service === 'lock') this.commit(id, { state: 'locked' });
      if (service === 'unlock') this.commit(id, { state: 'unlocked' });
      if (service === 'media_play_pause') {
        this.commit(id, { state: entity.state === 'playing' ? 'paused' : 'playing' });
      }
    }

    return undefined;
  }

  async callWS<T>(): Promise<T> {
    return {} as T;
  }

  formatEntityState(entity: HassEntity, state?: string): string {
    const value = state ?? entity.state;
    const unit = entity.attributes.unit_of_measurement;
    if (unit) return `${value} ${unit}`;
    return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  localize(key: string): string {
    // Return the last path segment so missing translations stay readable.
    return key.split('.').pop() ?? key;
  }

  /** Advance the sun so the daylight rig can be reviewed across a whole day. */
  startSunCycle(secondsPerDay = 60): void {
    this.stopSunCycle();
    let t = 0.35;
    this.sunTimer = setInterval(() => {
      t = (t + 1 / (secondsPerDay * 10)) % 1;
      const elevation = Math.sin(t * Math.PI * 2 - Math.PI / 2) * 62;
      const azimuth = (t * 360 + 180) % 360;
      this.commit('sun.sun', {
        state: elevation > 0 ? 'above_horizon' : 'below_horizon',
        attributes: { elevation, azimuth },
      });
    }, 100);
  }

  stopSunCycle(): void {
    if (this.sunTimer) clearInterval(this.sunTimer);
    this.sunTimer = null;
  }

  /** Randomly flip a few lights, to eyeball the on/off transitions. */
  startChaos(intervalMs = 2500): () => void {
    const ids = Object.keys(this.states).filter((id) => id.startsWith('light.'));
    const timer = setInterval(() => {
      const id = ids[Math.floor(Math.random() * ids.length)];
      const entity = this.states[id];
      if (!entity || entity.state === 'unavailable') return;
      void this.callService('light', 'toggle', undefined, { entity_id: id });
    }, intervalMs);
    return () => clearInterval(timer);
  }

  setDarkMode(dark: boolean): void {
    this.themes = { ...this.themes, darkMode: dark, dark };
    for (const cb of [...this.listeners]) cb(this);
  }
}

export function createMockHass(): MockHass {
  return new MockHass();
}
