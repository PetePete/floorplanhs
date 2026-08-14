/**
 * Development harness. Mounts the real card against the mock `hass` and gives
 * us the switches we need to review it: light toggles, a sun cycle, dark/light
 * theme, panel mode, and a live view of the config the card writes back.
 *
 * Run with `npm run dev`. Not part of the shipped bundle.
 */

import '@/main';
import { createMockHass, type MockHass } from '@/dev/mock-hass';
import type {
  Floorplan3dCardConfig,
  LightVisualConfig,
  ModelConfig,
  PlanSpec,
  SectionState,
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
 * with, so the same placements work for the demo house and for a plan.
 */
type Storey = 'lower' | 'main' | 'top';

interface DevEntity {
  entity: string;
  position: Vec3;
  storey: Storey;
  light?: LightVisualConfig;
}

/**
 * Placements worked out against the private plan (see `resolveLayout` below).
 * `buildFromPlan` recentres on the footprint, so plan coordinates map to world
 * coordinates by subtracting half the footprint in X and Z.
 *
 * Against the demo house a few of these land in the wrong room or just outside
 * the shell. That is fine and is exactly what the drag-and-drop placement UI is
 * for; nothing here assumes a particular geometry.
 */
const DEV_ENTITIES: DevEntity[] = [
  /* Top floor — the open living level. Ceiling lights hang under the roof
     soffit, which falls from the north face toward the south. */
  {
    entity: 'light.living_room_ceiling',
    position: [0.5, 4.95, 1.2],
    storey: 'top',
    light: { kind: 'point', distance: 8, fixture: { show: true } },
  },
  {
    entity: 'light.living_room_floor_lamp',
    position: [2.9, 4.25, 2.9],
    storey: 'top',
    light: { kind: 'point', distance: 6, intensity: 0.7, fixture: { show: true } },
  },
  {
    entity: 'light.kitchen_counter',
    // Over the worktop that runs along the north wall.
    position: [-1.7, 4.9, -3.6],
    storey: 'top',
    light: { kind: 'spot', angle: 55, penumbra: 0.5, distance: 7, fixture: { show: true } },
  },
  // On that worktop: top-floor level plus 0.92 of counter.
  { entity: 'switch.coffee_machine', position: [-0.6, 3.68, -3.6], storey: 'top' },
  { entity: 'media_player.living_room_tv', position: [-4.45, 3.95, 2.0], storey: 'top' },
  { entity: 'sensor.living_room_temperature', position: [4.5, 4.2, 1.5], storey: 'top' },

  /* Main floor — bedrooms, study and the wet rooms off the corridor. */
  {
    entity: 'light.hallway',
    position: [-1.0, 2.3, -0.85],
    storey: 'main',
    light: { kind: 'point', distance: 6, fixture: { show: true } },
  },
  {
    entity: 'light.bedroom_bedside',
    position: [3.4, 1.05, 1.1],
    storey: 'main',
    light: { kind: 'point', distance: 5, fixture: { show: true } },
  },
  {
    entity: 'light.office_desk',
    position: [-3.4, 1.35, 3.0],
    storey: 'main',
    light: { kind: 'point', distance: 5, fixture: { show: true } },
  },
  { entity: 'sensor.bedroom_humidity', position: [3.2, 1.6, -2.6], storey: 'main' },
  { entity: 'binary_sensor.hallway_motion', position: [3.0, 2.25, -0.45], storey: 'main' },
  // Just inside the entrance, on the north facade under the carport.
  { entity: 'binary_sensor.front_door', position: [-2.62, 1.1, -4.35], storey: 'main' },
];

const NO_PLANES: SectionState['planes'] = [
  { axis: 'x', position: 0, enabled: false, invert: false },
  { axis: 'y', position: 0, enabled: false, invert: false },
  { axis: 'z', position: 0, enabled: false, invert: false },
];

/**
 * What the harness needs to know about the house it ended up with, so the
 * presets and the entity `level` fields always name levels that exist.
 */
interface Layout {
  model: ModelConfig;
  title: string;
  /** Level ids, bottom-up. */
  levelIds: string[];
  /** Finished floor level of the top storey, for framing the isometric view. */
  topElevation: number;
}

/** The zero-config fallback, and what every other user of the card sees first. */
const DEMO_LAYOUT: Layout = {
  model: { demo: true },
  title: 'Demo house',
  levelIds: ['basement', 'ground', 'upper'],
  topElevation: 2.9,
};

function layoutForPlan(plan: PlanSpec): Layout {
  const levels = plan.levels.slice().sort((a, b) => a.elevation - b.elevation);
  return {
    model: { plan },
    title: 'Home',
    levelIds: levels.map((level) => level.id),
    topElevation: levels[levels.length - 1].elevation,
  };
}

function buildConfig(layout: Layout): Floorplan3dCardConfig {
  const ids = layout.levelIds;
  const levelId = (storey: Storey): string => {
    if (storey === 'lower') return ids[0];
    if (storey === 'top') return ids[ids.length - 1];
    return ids[Math.min(1, ids.length - 1)];
  };
  const topId = levelId('top');
  const mainId = levelId('main');

  return {
    type: 'custom:floorplan-3d-card',
    title: layout.title,
    model: layout.model,
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
        position: [15, 12, 17],
        target: [0, 1.6, 0],
        inTour: true,
      },
      {
        id: 'main',
        name: 'Main floor',
        icon: 'mdi:home-floor-g',
        position: [11, 9, 12],
        target: [0, 1.2, 0],
        section: {
          mode: 'level',
          levelId: mainId,
          planes: structuredClone(NO_PLANES),
          caps: true,
          ghostAbove: true,
        },
        inTour: true,
      },
      {
        id: 'top',
        name: 'Living floor',
        icon: 'mdi:home-floor-1',
        // Looking along (1, 1, 1) with an orthographic projection: all three
        // axes foreshorten equally, so the storey reads as a room you can see
        // into rather than as a flat plan. The living floor is the interesting
        // one in this house, so the harness opens here.
        position: [16, 16 + layout.topElevation, 16],
        target: [0, layout.topElevation + 1.2, 0],
        orthographic: true,
        // The cut still matters: without it you would be looking at the roof
        // from an angle instead of into the storey.
        section: {
          mode: 'level',
          levelId: topId,
          planes: structuredClone(NO_PLANES),
          caps: true,
          ghostAbove: false,
        },
        visibleLevels: [topId],
        default: true,
      },
    ],
    entities: DEV_ENTITIES.map(({ storey, ...placed }) => ({
      ...placed,
      level: levelId(storey),
    })),
  };
}

/**
 * The demo house is the default, which is also what every other user of the
 * card sees. A private plan — a real building, kept out of the repository by
 * `.gitignore` — is picked up when it happens to be there.
 *
 * Deliberately a `fetch` and not an `import`: importing a file that only exists
 * on one machine would break `npm run dev` for everyone else. Vite serves the
 * project root, so the path works with no extra configuration.
 */
const PRIVATE_PLAN_URL = '/private/house-plan.json';

async function resolveLayout(): Promise<{ config: Floorplan3dCardConfig; note: string }> {
  try {
    const response = await fetch(PRIVATE_PLAN_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const plan = (await response.json()) as PlanSpec;
    if (!Array.isArray(plan?.levels) || plan.levels.length === 0) {
      throw new Error('no "levels" in the file');
    }
    return {
      config: buildConfig(layoutForPlan(plan)),
      note: `private plan (${PRIVATE_PLAN_URL})`,
    };
  } catch (err) {
    return {
      config: buildConfig(DEMO_LAYOUT),
      note: `demo house — ${PRIVATE_PLAN_URL}: ${(err as Error).message}`,
    };
  }
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

  const { config: baseConfig, note } = await resolveLayout();
  let config: Floorplan3dCardConfig = structuredClone(baseConfig);
  const card = document.createElement('floorplan-3d-card') as CardElement;

  const applyConfig = () => {
    try {
      card.setConfig(structuredClone(config));
      status.textContent = `ok — ${note}`;
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

  /*
   * Model source. All three inputs have to produce the same downstream
   * behaviour — levels, rooms, entity placement — so being able to flip
   * between them in one click is the fastest way to spot when one of them
   * drifts. The two private files are absent on any other machine; the select
   * still lists them and the card reports the 404 rather than failing silently.
   */
  panel.append(el('h3', {}, ['Model source']));
  const sources: Array<{ label: string; model: Floorplan3dCardConfig['model'] }> = [
    { label: 'Demo house', model: { demo: true } },
    { label: 'Plan (private)', model: undefined },
    { label: 'Sweet Home 3D (private)', model: { url: '/private/sample.sh3d' } },
  ];
  const sourceSelect = el('select');
  for (const s of sources) {
    const option = document.createElement('option');
    option.value = s.label;
    option.textContent = s.label;
    sourceSelect.append(option);
  }
  // Whatever `resolveLayout` settled on is what is on screen right now.
  sourceSelect.value = note.startsWith('private plan') ? 'Plan (private)' : 'Demo house';
  sourceSelect.addEventListener('change', async () => {
    const chosen = sources.find((s) => s.label === sourceSelect.value);
    if (!chosen) return;
    if (chosen.model === undefined) {
      const resolved = await resolveLayout();
      config = { ...structuredClone(resolved.config), ui: config.ui, render: config.render };
      status.textContent = resolved.note;
    } else {
      config = { ...config, model: structuredClone(chosen.model) };
      status.textContent = `model: ${chosen.label}`;
    }
    applyConfig();
  });
  addRow('Source', sourceSelect);

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
    config = structuredClone(baseConfig);
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
