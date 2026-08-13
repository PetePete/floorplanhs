/**
 * Development harness. Mounts the real card against the mock `hass` and gives
 * us the switches we need to review it: light toggles, a sun cycle, dark/light
 * theme, panel mode, and a live view of the config the card writes back.
 *
 * Run with `npm run dev`. Not part of the shipped bundle.
 */

import '@/main';
import { createMockHass, type MockHass } from '@/dev/mock-hass';
import type { Floorplan3dCardConfig } from '@/types/config';

interface CardElement extends HTMLElement {
  hass?: MockHass;
  isPanel?: boolean;
  editMode?: boolean;
  /** The harness *is* a host that persists, so opt out of the editor sniffing. */
  configPersistence?: 'auto' | 'available' | 'unavailable';
  setConfig(config: unknown): void;
}

const DEMO_CONFIG: Floorplan3dCardConfig = {
  type: 'custom:floorplan-3d-card',
  title: 'House',
  model: { demo: true },
  camera: { fov: 45, transitionDuration: 1.1 },
  render: { quality: 'high', bloom: true, shadows: false, daylight: false },
  ui: {
    height: '100%',
    showToolbar: true,
    showPresetBar: true,
    showFps: true,
  },
  presets: [
    {
      id: 'overview',
      name: 'Overview',
      icon: 'mdi:home',
      position: [14, 11, 16],
      target: [0, 1.4, 0],
      inTour: true,
    },
    {
      id: 'ground',
      name: 'Ground floor',
      icon: 'mdi:home-floor-g',
      position: [10, 9, 11],
      target: [0, 1.2, 0],
      section: {
        mode: 'level',
        levelId: 'ground',
        planes: [
          { axis: 'x', position: 0, enabled: false, invert: false },
          { axis: 'y', position: 0, enabled: false, invert: false },
          { axis: 'z', position: 0, enabled: false, invert: false },
        ],
        caps: true,
        ghostAbove: true,
      },
      inTour: true,
    },
    {
      id: 'floorplan',
      name: 'Isometric',
      icon: 'mdi:floor-plan',
      // Looking along (1, 1, 1) with an orthographic projection: all three
      // axes foreshorten equally, so the storey reads as a room you can see
      // into rather than as a flat plan.
      position: [16, 16, 16],
      target: [0, 1.2, 0],
      orthographic: true,
      // The cut still matters: without it you would be looking at a roof from
      // an angle instead of from above.
      section: {
        mode: 'level',
        levelId: 'ground',
        planes: [
          { axis: 'x', position: 0, enabled: false, invert: false },
          { axis: 'y', position: 0, enabled: false, invert: false },
          { axis: 'z', position: 0, enabled: false, invert: false },
        ],
        caps: true,
        ghostAbove: false,
      },
      visibleLevels: ['ground'],
      default: true,
    },
  ],
  entities: [
    {
      entity: 'light.living_room_ceiling',
      position: [-2.4, 2.45, -1.6],
      level: 'ground',
      light: { kind: 'point', distance: 8, fixture: { show: true } },
    },
    {
      entity: 'light.living_room_floor_lamp',
      position: [-4.2, 1.5, -2.5],
      level: 'ground',
      light: { kind: 'point', distance: 6, intensity: 0.7, fixture: { show: true } },
    },
    {
      entity: 'light.kitchen_counter',
      position: [3.1, 2.3, -1.4],
      level: 'ground',
      light: { kind: 'spot', angle: 55, penumbra: 0.5, distance: 7, fixture: { show: true } },
    },
    {
      entity: 'light.hallway',
      position: [0.2, 2.45, 1.0],
      level: 'ground',
      light: { kind: 'point', distance: 6, fixture: { show: true } },
    },
    {
      entity: 'light.bedroom_bedside',
      position: [-2.8, 3.9, -1.2],
      level: 'upper',
      light: { kind: 'point', distance: 5, fixture: { show: true } },
    },
    {
      entity: 'light.office_desk',
      position: [3.4, 4.0, 1.8],
      level: 'upper',
      light: { kind: 'point', distance: 5, fixture: { show: true } },
    },
    { entity: 'sensor.living_room_temperature', position: [-3.6, 1.6, -3.2], level: 'ground' },
    { entity: 'binary_sensor.hallway_motion', position: [0.6, 2.2, 3.4], level: 'ground' },
    { entity: 'binary_sensor.front_door', position: [0, 1.1, 4.4], level: 'ground' },
    { entity: 'switch.coffee_machine', position: [3.8, 1.15, -2.6], level: 'ground' },
    { entity: 'media_player.living_room_tv', position: [-5.2, 1.4, -1.0], level: 'ground' },
    { entity: 'sensor.bedroom_humidity', position: [-3.4, 3.6, -2.4], level: 'upper' },
  ],
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function boot(): Promise<void> {
  const hass = createMockHass();
  const stage = document.getElementById('stage')!;
  const panel = document.getElementById('panel')!;
  const status = document.getElementById('status')!;

  // The card is defined by `@/main` as a side effect; wait for it so we fail
  // loudly rather than silently rendering an unupgraded element.
  await customElements.whenDefined('floorplan-3d-card').catch(() => undefined);
  if (!customElements.get('floorplan-3d-card')) {
    status.textContent = 'floorplan-3d-card was never registered — check src/main.ts';
    status.classList.add('bad');
    return;
  }

  let config: Floorplan3dCardConfig = structuredClone(DEMO_CONFIG);
  const card = document.createElement('floorplan-3d-card') as CardElement;

  const applyConfig = () => {
    try {
      card.setConfig(structuredClone(config));
      status.textContent = 'ok';
      status.classList.remove('bad');
    } catch (err) {
      status.textContent = `setConfig threw: ${(err as Error).message}`;
      status.classList.add('bad');
    }
  };

  applyConfig();
  card.configPersistence = 'available';
  card.hass = hass;
  stage.append(card);

  hass.onChange((h) => {
    card.hass = h;
  });

  // The card persists placements by firing `config-changed`; mirror Lovelace.
  card.addEventListener('config-changed', (ev) => {
    const detail = (ev as CustomEvent<{ config: Floorplan3dCardConfig }>).detail;
    if (!detail?.config) return;
    config = detail.config;
    (document.getElementById('config-out') as HTMLTextAreaElement).value = JSON.stringify(
      config,
      null,
      2,
    );
    status.textContent = `config-changed (${config.entities?.length ?? 0} entities, ${config.presets?.length ?? 0} presets)`;
  });

  card.addEventListener('hass-more-info', (ev) => {
    const detail = (ev as CustomEvent<{ entityId: string }>).detail;
    status.textContent = `more-info: ${detail.entityId}`;
  });

  /* ------------------------------------------------------------- controls */

  const addRow = (label: string, control: HTMLElement) => {
    panel.append(el('div', { className: 'row' }, [el('span', { className: 'lbl' }, [label]), control]));
  };

  const lightIds = Object.keys(hass.states).filter((id) => id.startsWith('light.'));
  const lightBox = el('div', { className: 'lights' });
  for (const id of lightIds) {
    const btn = el('button', { className: 'chip', title: id }, [id.replace('light.', '')]);
    const sync = () => btn.classList.toggle('on', hass.states[id]?.state === 'on');
    btn.addEventListener('click', () => void hass.callService('light', 'toggle', undefined, { entity_id: id }));
    hass.onChange(sync);
    sync();
    lightBox.append(btn);
  }
  panel.append(el('h3', {}, ['Lights']), lightBox);

  panel.append(el('h3', {}, ['Scene']));

  let stopChaos: (() => void) | null = null;
  const chaosBtn = el('button', { className: 'chip' }, ['Random toggles']);
  chaosBtn.addEventListener('click', () => {
    if (stopChaos) {
      stopChaos();
      stopChaos = null;
      chaosBtn.classList.remove('on');
    } else {
      stopChaos = hass.startChaos(2000);
      chaosBtn.classList.add('on');
    }
  });
  addRow('State churn', chaosBtn);

  panel.append(el('h3', {}, ['Render']));

  /** A select bound to one `render.*` key, re-applied through setConfig. */
  const renderSelect = <K extends keyof NonNullable<Floorplan3dCardConfig['render']>>(
    label: string,
    key: K,
    values: ReadonlyArray<NonNullable<Floorplan3dCardConfig['render']>[K]>,
  ) => {
    const select = el('select');
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      select.append(option);
    }
    select.value = String(config.render?.[key] ?? values[0]);
    select.addEventListener('change', () => {
      config = {
        ...config,
        render: { ...config.render, [key]: select.value },
      } as Floorplan3dCardConfig;
      applyConfig();
    });
    addRow(label, select);
  };

  renderSelect('Style', 'style', ['shaded', 'solid', 'wireframe'] as const);
  renderSelect('Palette', 'palette', ['model', 'mono-light', 'mono-dark'] as const);
  renderSelect('Quality', 'quality', ['high', 'medium', 'low'] as const);

  const bloomBtn = el('button', { className: 'chip on' }, ['Bloom']);
  bloomBtn.addEventListener('click', () => {
    const next = config.render?.bloom === false;
    config = { ...config, render: { ...config.render, bloom: next } };
    bloomBtn.classList.toggle('on', next);
    applyConfig();
  });
  addRow('Bloom', bloomBtn);

  const shadowBtn = el('button', { className: 'chip' }, ['Shadows']);
  shadowBtn.addEventListener('click', () => {
    const next = config.render?.shadows !== true;
    config = { ...config, render: { ...config.render, shadows: next } };
    shadowBtn.classList.toggle('on', next);
    applyConfig();
  });
  addRow('Shadows', shadowBtn);

  panel.append(el('h3', {}, ['Card']));

  const themeBtn = el('button', { className: 'chip on' }, ['Dark']);
  themeBtn.addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('light');
    document.documentElement.classList.toggle('light', dark);
    hass.setDarkMode(!dark);
    themeBtn.textContent = dark ? 'Light' : 'Dark';
    themeBtn.classList.toggle('on', !dark);
  });
  addRow('Theme', themeBtn);

  const editBtn = el('button', { className: 'chip' }, ['Edit mode']);
  editBtn.addEventListener('click', () => {
    card.editMode = !card.editMode;
    editBtn.classList.toggle('on', !!card.editMode);
  });
  addRow('Edit mode', editBtn);

  const panelBtn = el('button', { className: 'chip' }, ['Panel mode']);
  panelBtn.addEventListener('click', () => {
    card.isPanel = !card.isPanel;
    panelBtn.classList.toggle('on', !!card.isPanel);
    stage.classList.toggle('panel', !!card.isPanel);
  });
  addRow('Panel mode', panelBtn);

  const remountBtn = el('button', { className: 'chip' }, ['Detach / re-attach']);
  remountBtn.addEventListener('click', () => {
    // HA moves cards around the DOM. A card that dies here is broken.
    card.remove();
    setTimeout(() => stage.append(card), 400);
  });
  addRow('Lifecycle', remountBtn);

  const reloadBtn = el('button', { className: 'chip' }, ['Reset config']);
  reloadBtn.addEventListener('click', () => {
    config = structuredClone(DEMO_CONFIG);
    applyConfig();
  });
  addRow('Config', reloadBtn);

  panel.append(el('h3', {}, ['Live config']));
  const out = el('textarea', { id: 'config-out', readOnly: true, spellcheck: false });
  out.value = JSON.stringify(config, null, 2);
  panel.append(out);

  window.addEventListener('error', (ev) => {
    status.textContent = `error: ${ev.message}`;
    status.classList.add('bad');
  });
  window.addEventListener('unhandledrejection', (ev) => {
    status.textContent = `unhandled rejection: ${String(ev.reason)}`;
    status.classList.add('bad');
  });
}

void boot();
