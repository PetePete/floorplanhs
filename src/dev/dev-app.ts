/**
 * Development harness. Mounts the real card against the mock `hass` and gives
 * us the switches we need to review it: light toggles, a sun cycle, dark/light
 * theme, panel mode, and a live view of the config the card writes back.
 *
 * Run with `npm run dev`. Not part of the shipped bundle.
 */

import '@/main';
import { createMockHass, type MockHass } from '@/dev/mock-hass';
import { ensureChakraPetch } from '@/ui/fonts/chakra-petch';
import type {
  Floorplan3dCardConfig,
  LightVisualConfig,
  ModelConfig,
  Vec3,
} from '@/types/config';

interface CardElement extends HTMLElement {
  hass?: MockHass;
  isPanel?: boolean;
  editMode?: boolean;
  /** The harness *is* a host that persists, so opt out of the editor sniffing. */
  configPersistence?: 'auto' | 'available' | 'unavailable';
  setConfig(config: unknown): void;
}

/**
 * Which storey an entity belongs on, independent of what the loaded house calls
 * its levels. The harness resolves this against whichever house it ended up
 * with, so the same placements survive swapping the model source.
 */
type Storey = 'lower' | 'main' | 'top';

interface DevEntity {
  entity: string;
  position: Vec3;
  storey: Storey;
  light?: LightVisualConfig;
  room?: string;
}

/**
 * A couple of lamps and a sensor, dropped roughly in the middle of the ground
 * floor. The harness reviews whatever `.sh3d` is in `private/`, so it cannot
 * know that home's rooms or level ids — drag them where they belong, which is
 * the gesture the card is meant to support anyway.
 */
const DEV_ENTITIES: DevEntity[] = [
  {
    entity: 'light.living_room_ceiling',
    position: [-2.5, 4.9, -1.5],
    storey: 'main',
    light: { kind: 'point', distance: 8 },
  },
  {
    entity: 'light.kitchen_counter',
    position: [2.5, 4.9, 1.5],
    storey: 'main',
    light: { kind: 'point', distance: 8 },
  },
  {
    entity: 'sensor.living_room_temperature',
    position: [0, 3.0, 0],
    storey: 'main',
  },
];

/**
 * What the harness needs to know about the house it ended up with, so the
 * presets and the entity `level` fields always name levels that exist.
 */
interface Layout {
  model: ModelConfig;
  /** Level ids, bottom-up. */
  levelIds: string[];
  /** Finished floor level of the top storey, for framing the isometric view. */
  topElevation: number;
}

/**
 * The card ships no house of its own, and this harness reviews exactly one: the
 * `.sh3d` in `private/`, which is gitignored and absent on every other machine.
 * Without it the card loads nothing and says so, which is worth seeing too.
 */
const PRIVATE_SH3D = '/private/sample.sh3d';

const DEMO_LAYOUT: Layout = {
  model: { url: PRIVATE_SH3D },
  levelIds: [],
  topElevation: 0,
};

function buildConfig(layout: Layout): Floorplan3dCardConfig {
  const ids = layout.levelIds;
  // Null when the harness has no level list, which is the honest answer for a
  // home it did not author: the card assigns a level when the entity is dropped.
  const levelId = (storey: Storey): string | null => {
    if (ids.length === 0) return null;
    if (storey === 'lower') return ids[0];
    if (storey === 'top') return ids[ids.length - 1];
    return ids[Math.min(1, ids.length - 1)];
  };

  return {
    type: 'custom:floorplan-3d-card',
    model: layout.model,
    camera: { fov: 45, transitionDuration: 1.1 },
    // Opaque, and deliberately so: the drawing reads best on a ground darker
    // than any dashboard card.
    render: { quality: 'high', background: 'dark' },
    ui: {
      height: '100%',
      showToolbar: true,
    },
    // Plain viewpoints only. Pinning a section to a level id the harness
    // invented is how a cut ends up referring to a storey that does not exist;
    // the card generates a view per *detected* storey by itself.
    presets: [
      {
        id: 'overview',
        name: 'Overview',
        icon: 'mdi:home',
        position: [15, 12, 17],
        target: [0, 1.6, 0],
        default: true,
        inTour: true,
      },
    ],
    entities: DEV_ENTITIES.map(({ storey, ...placed }) => ({
      ...placed,
      level: levelId(storey),
    })),
  };
}

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
  // index.html names the face; nothing registers it until a card connects, and
  // the panel is painted before that happens.
  ensureChakraPetch();
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

  let config: Floorplan3dCardConfig = buildConfig(DEMO_LAYOUT);
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
    // `background` defaults to '' rather than being absent, and '' matches no
    // option, so the select would come up blank instead of on its default.
    select.value = String(config.render?.[key] || values[0]);
    select.addEventListener('change', () => {
      config = {
        ...config,
        render: { ...config.render, [key]: select.value },
      } as Floorplan3dCardConfig;
      applyConfig();
    });
    addRow(label, select);
  };

  renderSelect('Style', 'style', ['wireframe', 'solid'] as const);
  renderSelect('Palette', 'palette', ['model', 'mono-light', 'mono-dark'] as const);
  renderSelect('Background', 'background', ['transparent', 'system', 'light', 'dark'] as const);
  renderSelect('Lighting', 'lightMode', ['room', 'realistic'] as const);

  const ceilingBtn = el('button', { className: 'chip on' }, ['Ceilings']);
  ceilingBtn.addEventListener('click', () => {
    const next = config.ui?.showCeilings === false;
    config = { ...config, ui: { ...config.ui, showCeilings: next } };
    ceilingBtn.classList.toggle('on', next);
    applyConfig();
  });
  addRow('Ceilings', ceilingBtn);

  // Tri-state on purpose: the config option is a master switch that can also
  // stand aside, and the harness has to be able to reach all three.
  const ghostStates: Array<{ label: string; value: boolean | null }> = [
    { label: 'per preset', value: null },
    { label: 'always', value: true },
    { label: 'never', value: false },
  ];
  const ghostSelect = el('select');
  for (const state of ghostStates) {
    const option = document.createElement('option');
    option.value = state.label;
    option.textContent = state.label;
    ghostSelect.append(option);
  }
  ghostSelect.addEventListener('change', () => {
    const chosen = ghostStates.find((s) => s.label === ghostSelect.value);
    config = { ...config, ui: { ...config.ui, ghostAbove: chosen?.value ?? null } };
    applyConfig();
  });
  addRow('Ghost storeys', ghostSelect);
  renderSelect('Quality', 'quality', ['high', 'medium', 'low'] as const);


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
    config = buildConfig(DEMO_LAYOUT);
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
