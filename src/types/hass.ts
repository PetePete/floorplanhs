/**
 * Minimal, dependency-free typings for the Home Assistant frontend objects a
 * custom card receives. We deliberately do not depend on `custom-card-helpers`
 * or `home-assistant-js-websocket` so the bundle stays small and stable.
 */

export interface HassEntityAttributeBase {
  friendly_name?: string;
  icon?: string;
  device_class?: string;
  unit_of_measurement?: string;
  supported_features?: number;
  supported_color_modes?: string[];
  entity_picture?: string;
  assumed_state?: boolean;
  [key: string]: unknown;
}

export interface HassEntity {
  entity_id: string;
  state: string;
  last_changed: string;
  last_updated: string;
  attributes: HassEntityAttributeBase;
  context?: { id: string; user_id: string | null; parent_id: string | null };
}

export interface HassEntities {
  [entityId: string]: HassEntity;
}

export interface HassArea {
  area_id: string;
  name: string;
  icon?: string | null;
  floor_id?: string | null;
}

export interface HassDevice {
  id: string;
  name: string | null;
  name_by_user?: string | null;
  area_id?: string | null;
}

export interface HassEntityRegistryEntry {
  entity_id: string;
  device_id?: string | null;
  area_id?: string | null;
  name?: string | null;
  platform?: string;
  hidden_by?: string | null;
  entity_category?: string | null;
}

export interface HassServiceTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
}

export interface HassConnection {
  subscribeEvents<T>(cb: (ev: T) => void, eventType: string): Promise<() => Promise<void>>;
  sendMessagePromise<T>(msg: Record<string, unknown>): Promise<T>;
}

export interface HassThemeSettings {
  theme: string;
  dark?: boolean;
  primaryColor?: string;
  accentColor?: string;
}

export interface HomeAssistant {
  states: HassEntities;
  connection: HassConnection;
  connected: boolean;
  themes: HassThemeSettings & { darkMode?: boolean };
  selectedTheme?: { dark?: boolean } | null;
  language: string;
  locale?: { language: string; number_format?: string; time_format?: string };
  user?: { id: string; name: string; is_admin: boolean };
  areas?: Record<string, HassArea>;
  devices?: Record<string, HassDevice>;
  entities?: Record<string, HassEntityRegistryEntry>;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: HassServiceTarget,
  ): Promise<unknown>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  formatEntityState?(entity: HassEntity, state?: string): string;
  localize(key: string, ...args: unknown[]): string;
}

/** Lovelace card contract (see HA docs "Custom card"). */
export interface LovelaceCard extends HTMLElement {
  hass?: HomeAssistant;
  isPanel?: boolean;
  editMode?: boolean;
  getCardSize(): number | Promise<number>;
  setConfig(config: unknown): void;
}

export interface LovelaceCardEditor extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: unknown): void;
}

/** Entry pushed to `window.customCards` so the card shows in the UI picker. */
export interface CustomCardEntry {
  type: string;
  name: string;
  description: string;
  preview?: boolean;
  documentationURL?: string;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
    loadCardHelpers?: () => Promise<Record<string, unknown>>;
  }
}
