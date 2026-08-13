/**
 * Tap / hold / double-tap handling, mirroring what the built-in Lovelace cards
 * do so the card behaves the way users already expect.
 *
 * Nothing in here is allowed to throw: these run from pointer handlers that sit
 * next to the render loop, and an unhandled rejection there takes the card down
 * with it. Everything funnels through `runAction`, which reports failures as an
 * HA toast instead.
 */

import type { ActionConfig } from '@/types/config';
import type { HassServiceTarget, HomeAssistant } from '@/types/hass';
import { fireEvent, showToast } from '@/util/events';
import { domainOf } from '@/ha/registry';

export type ActionKind = 'tap' | 'hold' | 'double-tap';

export interface ActionableConfig {
  entity?: string;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
}

/** DOM event the card listens for to fly the camera to a preset. */
export const PRESET_EVENT = 'floorplan-3d-preset';

/** Domains where a plain tap sensibly means "flip it". */
const TOGGLEABLE_DOMAINS = new Set([
  'light',
  'switch',
  'fan',
  'input_boolean',
  'automation',
  'siren',
  'humidifier',
  'remote',
  'lock',
  'cover',
  'media_player',
  'climate',
  'water_heater',
  'vacuum',
  'script',
  'scene',
  'button',
  'input_button',
  'valve',
  'group',
]);

export function isToggleable(entityId: string | undefined): boolean {
  return entityId ? TOGGLEABLE_DOMAINS.has(domainOf(entityId)) : false;
}

export function hasAction(config?: ActionConfig): boolean {
  return Boolean(config) && config?.action !== 'none';
}

/**
 * What happens when nothing is configured. Matches HA's own cards: things you
 * can operate toggle, things you can only read open their dialog.
 */
export function defaultActionFor(kind: ActionKind, entityId: string | undefined): ActionConfig {
  if (!entityId) return { action: kind === 'tap' ? 'none' : 'none' };
  if (kind === 'hold') return { action: 'more-info' };
  if (kind === 'double-tap') return { action: 'none' };
  return isToggleable(entityId) ? { action: 'toggle' } : { action: 'more-info' };
}

function selectAction(config: ActionableConfig, kind: ActionKind): ActionConfig {
  const configured =
    kind === 'tap'
      ? config.tap_action
      : kind === 'hold'
        ? config.hold_action
        : config.double_tap_action;
  return configured ?? defaultActionFor(kind, config.entity);
}

/* ------------------------------------------------------------------ toggle */

function splitService(value: string): [string, string] | null {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  return [value.slice(0, dot), value.slice(dot + 1)];
}

/**
 * `homeassistant.toggle` covers most domains, but several need the domain's own
 * service to do the obvious thing — a lock has no "toggle", a cover's toggle
 * depends on where it currently is, and a button can only be pressed.
 */
export async function toggleEntity(hass: HomeAssistant, entityId: string): Promise<void> {
  const domain = domainOf(entityId);
  const state = hass.states?.[entityId]?.state ?? 'unknown';
  const target: HassServiceTarget = { entity_id: entityId };

  switch (domain) {
    case 'lock':
      return void (await hass.callService(
        'lock',
        state === 'locked' ? 'unlock' : 'lock',
        {},
        target,
      ));
    case 'cover':
      return void (await hass.callService(
        'cover',
        state === 'closed' || state === 'closing' ? 'open_cover' : 'close_cover',
        {},
        target,
      ));
    case 'valve':
      return void (await hass.callService(
        'valve',
        state === 'closed' || state === 'closing' ? 'open_valve' : 'close_valve',
        {},
        target,
      ));
    case 'media_player':
      return void (await hass.callService('media_player', 'media_play_pause', {}, target));
    case 'climate':
    case 'water_heater':
      return void (await hass.callService(
        domain,
        state === 'off' ? 'turn_on' : 'turn_off',
        {},
        target,
      ));
    case 'vacuum':
      return void (await hass.callService(
        'vacuum',
        state === 'cleaning' || state === 'on' ? 'return_to_base' : 'start',
        {},
        target,
      ));
    case 'button':
    case 'input_button':
      return void (await hass.callService(domain, 'press', {}, target));
    case 'scene':
      return void (await hass.callService('scene', 'turn_on', {}, target));
    case 'script':
      return void (await hass.callService('script', 'turn_on', {}, target));
    default:
      return void (await hass.callService('homeassistant', 'toggle', {}, target));
  }
}

export interface ToggleLightOptions {
  /** Force a direction instead of flipping. */
  force?: 'on' | 'off';
  /** 0..1, applied when turning on. */
  brightness?: number;
  /** Seconds. */
  transition?: number;
}

/** Inline light control: the card's own quick actions, not a Lovelace action. */
export async function toggleLight(
  hass: HomeAssistant,
  entityId: string,
  opts: ToggleLightOptions = {},
): Promise<void> {
  const isOn = hass.states?.[entityId]?.state === 'on';
  const turnOn = opts.force ? opts.force === 'on' : !isOn;
  const data: Record<string, unknown> = {};
  if (opts.transition !== undefined && Number.isFinite(opts.transition)) {
    data.transition = Math.max(0, opts.transition);
  }
  if (turnOn && opts.brightness !== undefined && Number.isFinite(opts.brightness)) {
    data.brightness_pct = Math.round(Math.min(1, Math.max(0, opts.brightness)) * 100);
  }
  await hass.callService('light', turnOn ? 'turn_on' : 'turn_off', data, { entity_id: entityId });
}

/**
 * `brightness01` is 0..1 because that is what a slider produces; HA wants a
 * percentage. Zero turns the light off rather than setting an invalid
 * brightness of 0, which several integrations reject.
 */
export async function setLightBrightness(
  hass: HomeAssistant,
  entityId: string,
  brightness01: number,
): Promise<void> {
  const value = Number.isFinite(brightness01) ? Math.min(1, Math.max(0, brightness01)) : 0;
  if (value <= 0) {
    await hass.callService('light', 'turn_off', {}, { entity_id: entityId });
    return;
  }
  await hass.callService(
    'light',
    'turn_on',
    { brightness_pct: Math.round(value * 100) },
    { entity_id: entityId },
  );
}

/* ------------------------------------------------------------- side effects */

/**
 * HA's companion apps listen for this on the window and vibrate the device. It
 * costs nothing on desktop and makes touch targets on a wall tablet feel real.
 */
function haptic(kind: 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'failure'): void {
  if (typeof window === 'undefined') return;
  fireEvent(window, 'haptic', kind);
}

/**
 * A native `confirm()` is a blunt instrument — it is modal, unstyled and cannot
 * be themed — but a custom card cannot reach HA's own confirmation dialog
 * without importing frontend internals that are not part of any stable API.
 */
function confirmed(text: string | undefined, entityId: string | undefined): boolean {
  const message = text ?? `Are you sure you want to run this action${entityId ? ` on ${entityId}` : ''}?`;
  if (typeof confirm !== 'function') return true;
  return confirm(message);
}

function navigate(path: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState(null, '', path);
  fireEvent(window, 'location-changed', { replace: false });
}

/* ------------------------------------------------------------------ runner */

async function runAction(
  node: HTMLElement,
  hass: HomeAssistant,
  action: ActionConfig,
  fallbackEntity: string | undefined,
): Promise<void> {
  const entityId = action.entity ?? fallbackEntity;

  switch (action.action) {
    case 'none':
      return;

    case 'more-info': {
      if (!entityId) throw new Error('more-info needs an entity');
      fireEvent(node, 'hass-more-info', { entityId });
      return;
    }

    case 'toggle': {
      if (!entityId) throw new Error('toggle needs an entity');
      await toggleEntity(hass, entityId);
      return;
    }

    // 2024.8 renamed `call-service`/`service` to `perform-action`/`perform_action`.
    // Both spellings stay in the wild for years, so accept either and let the
    // newer key win when a config somehow carries both.
    case 'call-service':
    case 'perform-action': {
      const raw = action.perform_action ?? action.service;
      if (!raw) throw new Error('call-service needs a `perform_action` (or legacy `service`)');
      const parts = splitService(raw);
      if (!parts) throw new Error(`"${raw}" is not a valid domain.service`);
      await hass.callService(
        parts[0],
        parts[1],
        action.data ?? {},
        action.target as HassServiceTarget | undefined,
      );
      return;
    }

    case 'navigate': {
      if (!action.navigation_path) throw new Error('navigate needs a `navigation_path`');
      navigate(action.navigation_path);
      return;
    }

    case 'url': {
      if (!action.url_path) throw new Error('url needs a `url_path`');
      if (typeof window !== 'undefined') {
        window.open(action.url_path, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    case 'preset': {
      if (!action.preset_id) throw new Error('preset needs a `preset_id`');
      fireEvent(node, PRESET_EVENT, { presetId: action.preset_id });
      return;
    }

    default: {
      throw new Error(`Unknown action "${String((action as ActionConfig).action)}"`);
    }
  }
}

/**
 * Entry point used by the marker layer and the card chrome. Always resolves;
 * failures surface as an HA toast so the user sees why nothing happened.
 */
export async function handleAction(
  node: HTMLElement,
  hass: HomeAssistant,
  config: ActionableConfig,
  action: ActionKind,
): Promise<void> {
  const actionConfig = selectAction(config, action);
  if (!actionConfig || actionConfig.action === 'none') return;

  try {
    if (actionConfig.confirmation) {
      if (!confirmed(actionConfig.confirmation.text, actionConfig.entity ?? config.entity)) {
        return;
      }
    }
    haptic(action === 'hold' ? 'medium' : 'light');
    await runAction(node, hass, actionConfig, config.entity);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[floorplan-3d] action failed', actionConfig, err);
    haptic('failure');
    showToast(node, `Action failed: ${message}`);
  }
}
