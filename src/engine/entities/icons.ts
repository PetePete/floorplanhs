/**
 * The card's local icon set.
 *
 * Home Assistant ships Material Design Icons as a webfont/`<ha-icon>` element,
 * neither of which is reachable from a canvas 2D context. The marker atlas
 * rasterises icons itself, so it needs raw path data. We therefore inline the
 * ~30 glyphs this card actually uses instead of pulling in `@mdi/js` (2 MB of
 * path data for 7000 icons we would tree-shake badly through a Vite lib build).
 *
 * Every path is authored on a 24x24 viewBox and is filled with the *nonzero*
 * winding rule, matching MDI's own convention: inner contours (holes) run in
 * the opposite direction to their outer contour.
 */

import type { EntityRole } from '@/types/config';

/** Raw SVG `d` strings on a 24x24 viewBox. */
export const ICON_PATHS: Record<string, string> = {
  /* ------------------------------------------------------------- lighting */
  lightbulb:
    'M12,2A7,7 0 0,0 5,9C5,11.38 6.19,13.47 8,14.74V17A1,1 0 0,0 9,18H15A1,1 0 0,0 16,17V14.74C17.81,13.47 19,11.38 19,9A7,7 0 0,0 12,2M9,21A1,1 0 0,0 10,22H14A1,1 0 0,0 15,21V20H9V21Z',
  'lightbulb-off':
    'M12,2A7,7 0 0,1 19,9C19,11.38 17.81,13.47 16,14.74V17A1,1 0 0,1 15,18H9A1,1 0 0,1 8,17V14.74C6.19,13.47 5,11.38 5,9A7,7 0 0,1 12,2M9,21V20H15V21A1,1 0 0,1 14,22H10A1,1 0 0,1 9,21M12,4A5,5 0 0,0 7,9C7,11.05 8.23,12.81 10,13.58V16H14V13.58C15.77,12.81 17,11.05 17,9A5,5 0 0,0 12,4Z',
  'ceiling-light':
    'M12,2A2,2 0 0,1 14,4V5.5H10V4A2,2 0 0,1 12,2M9.2,7H14.8L19,16H5L9.2,7M8,18H16A4,4 0 0,1 12,22A4,4 0 0,1 8,18Z',

  /* -------------------------------------------------------------- switches */
  'power-plug':
    'M16,7V3H14V7H10V3H8V7H8C7,7 6,8 6,9V14.5L9.5,18V21H14.5V18L18,14.5V9C18,8 17,7 16,7Z',
  'power-plug-off':
    'M16,7V3H14V7H10V3H8V7C7,7 6,8 6,9V14.5L9.5,18V21H14.5V18L18,14.5V9C18,8 17,7 16,7M2.5,4L4,2.5L21.5,20L20,21.5L2.5,4Z',
  'toggle-switch':
    'M17,7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7M17,15A3,3 0 0,1 14,12A3,3 0 0,1 17,9A3,3 0 0,1 20,12A3,3 0 0,1 17,15Z',
  'toggle-switch-off':
    'M7,7H17A5,5 0 0,1 22,12A5,5 0 0,1 17,17H7A5,5 0 0,1 2,12A5,5 0 0,1 7,7M7,9A3,3 0 0,0 4,12A3,3 0 0,0 7,15A3,3 0 0,0 10,12A3,3 0 0,0 7,9Z',

  /* --------------------------------------------------------------- sensors */
  'motion-sensor':
    'M16.5,5.5A2,2 0 0,0 18.5,3.5A2,2 0 0,0 16.5,1.5A2,2 0 0,0 14.5,3.5A2,2 0 0,0 16.5,5.5M12.9,19.4L13.9,15L16,17V23H18V15.5L15.9,13.5L16.5,10.5C17.89,12.09 19.89,13 22,13V11C20.24,11 18.6,10.09 17.6,8.6L16.4,7C16,6.4 15.4,6 14.7,6C14.4,6 14.2,6.1 13.9,6.1L9,8.3V13H11V9.6L12.8,8.9L11.2,17L6.3,16L5.9,18L12.9,19.4Z',
  thermometer:
    'M15,13V5A3,3 0 0,0 9,5V13A5,5 0 1,0 15,13M12,4A1,1 0 0,1 13,5V8H11V5A1,1 0 0,1 12,4Z',
  'water-percent':
    'M12,20A6,6 0 0,1 6,14C6,10 12,3.25 12,3.25C12,3.25 18,10 18,14A6,6 0 0,1 12,20M14.79,10.17L13.73,9.11L9.11,13.73L10.17,14.79L14.79,10.17M9.88,9.81A1.25,1.25 0 0,0 8.63,11.06A1.25,1.25 0 0,0 9.88,12.31A1.25,1.25 0 0,0 11.13,11.06A1.25,1.25 0 0,0 9.88,9.81M14.13,13.31A1.25,1.25 0 0,0 12.88,14.56A1.25,1.25 0 0,0 14.13,15.81A1.25,1.25 0 0,0 15.38,14.56A1.25,1.25 0 0,0 14.13,13.31Z',
  gauge:
    'M12,16A3,3 0 0,1 9,13C9,11.88 9.61,10.9 10.5,10.39L20.21,4.77L14.68,14.35C14.18,15.33 13.17,16 12,16M12,3C13.81,3 15.5,3.5 16.97,4.32L14.87,5.53C14,5.19 13,5 12,5A8,8 0 0,0 4,13C4,15.21 4.89,17.21 6.34,18.65H6.35C6.74,19.04 6.74,19.67 6.35,20.06C5.96,20.45 5.32,20.45 4.93,20.07V20.07C3.12,18.26 2,15.76 2,13A10,10 0 0,1 12,3M22,13C22,15.76 20.88,18.26 19.07,20.07V20.07C18.68,20.45 18.05,20.45 17.66,20.06C17.27,19.67 17.27,19.04 17.66,18.65V18.65C19.11,17.2 20,15.21 20,13C20,11.5 19.59,10.09 18.88,8.89L20.05,6.87C21.29,8.61 22,10.72 22,13Z',
  'smoke-detector':
    'M3,12 A9,9 0 1,1 21,12 A9,9 0 1,1 3,12 Z M5,12 A7,7 0 1,0 19,12 A7,7 0 1,0 5,12 Z M9,12 A3,3 0 1,1 15,12 A3,3 0 1,1 9,12 Z',
  fire: 'M17.66,11.2C17.43,10.9 17.15,10.64 16.89,10.38C16.22,9.78 15.46,9.35 14.82,8.72C13.33,7.26 13,4.85 13.95,3C13,3.23 12.17,3.75 11.46,4.32C8.87,6.4 7.85,10.07 9.07,13.22C9.11,13.32 9.15,13.42 9.15,13.55C9.15,13.77 9,13.97 8.8,14.05C8.57,14.15 8.33,14.09 8.14,13.93C8.08,13.88 8.04,13.83 8,13.76C6.87,12.33 6.69,10.28 7.45,8.64C5.78,10 4.87,12.3 5,14.47C5.06,14.97 5.12,15.47 5.29,15.97C5.43,16.57 5.7,17.17 6,17.7C7.08,19.43 8.95,20.67 10.96,20.92C13.1,21.19 15.39,20.8 17.03,19.32C18.86,17.66 19.5,15 18.56,12.72L18.43,12.46C18.22,12 17.66,11.2 17.66,11.2M14.5,17.5C14.22,17.74 13.76,18 13.4,18.1C12.28,18.5 11.16,17.94 10.5,17.28C11.69,17 12.4,16.12 12.61,15.23C12.78,14.43 12.46,13.77 12.33,13C12.21,12.26 12.23,11.63 12.5,10.94C12.69,11.32 12.89,11.7 13.13,12C13.9,13 15.11,13.44 15.37,14.8C15.41,14.94 15.43,15.08 15.43,15.23C15.46,16.05 15.1,16.95 14.5,17.5Z',
  'water-alert':
    'M10,18A5,5 0 0,1 5,13C5,9.5 10,3.5 10,3.5C10,3.5 15,9.5 15,13A5,5 0 0,1 10,18Z M18,10 H20 V17 H18 Z M18,19 H20 V21.5 H18 Z',
  'battery-outline':
    'M16,20H8V6H16M16.67,4H15V2H9V4H7.33A1.33,1.33 0 0,0 6,5.33V20.67C6,21.4 6.6,22 7.33,22H16.67C17.4,22 18,21.4 18,20.67V5.33C18,4.6 17.4,4 16.67,4Z',
  wifi: 'M12,21L15.6,16.2C14.6,15.45 13.35,15 12,15C10.65,15 9.4,15.45 8.4,16.2L12,21M12,3C7.95,3 4.21,4.34 1.2,6.6L3,9C5.5,7.12 8.62,6 12,6C15.38,6 18.5,7.12 21,9L22.8,6.6C19.79,4.34 16.05,3 12,3M12,9C9.3,9 6.81,9.89 4.8,11.4L6.6,13.8C8.1,12.67 9.97,12 12,12C14.03,12 15.9,12.67 17.4,13.8L19.2,11.4C17.19,9.89 14.7,9 12,9Z',
  alert: 'M13,14H11V9H13M13,18H11V16H13M1,21H23L12,2L1,21Z',

  /* -------------------------------------------------------- openings/covers */
  'door-closed': 'M5,2 H19 V22 H5 Z M7,4 V20 H17 V4 Z M15,12 A1,1 0 1,1 15,14 A1,1 0 1,1 15,12 Z',
  'door-open': 'M4,2 H20 V22 H18 V4 H6 V22 H4 Z M8,5 L16,3 L16,21 L8,19 Z',
  window: 'M3,4 H21 V20 H3 Z M5,6 V18 H19 V6 Z M11.2,6 H12.8 V18 H11.2 Z M5,11.2 H19 V12.8 H5 Z',
  'window-open': 'M3,4 H21 V20 H3 Z M5,6 V18 H19 V6 Z M5,13 H19 V15 H5 Z',
  'blinds-open': 'M3,3 H21 V5.4 H3 Z M4,7 H20 V9 H4 Z M4,10.6 H20 V12.6 H4 Z M3,19 H21 V21 H3 Z',
  'blinds-closed':
    'M3,3 H21 V5.4 H3 Z M4,7 H20 V9 H4 Z M4,10.6 H20 V12.6 H4 Z M4,14.2 H20 V16.2 H4 Z M4,17.8 H20 V19.8 H4 Z M3,20.6 H21 V22 H3 Z',
  lock: 'M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z',
  'lock-open':
    'M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H15V6A3,3 0 0,0 12,3A3,3 0 0,0 9,6H7A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,17A2,2 0 0,0 14,15A2,2 0 0,0 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17Z',
  valve:
    'M2,10 H7 V14 H2 Z M17,10 H22 V14 H17 Z M9,9 H15 V15 H9 Z M11.2,2.6 H12.8 V8.4 H11.2 Z M8,2 H16 V4.2 H8 Z',

  /* -------------------------------------------------------------- climate */
  fan: 'M12,11A1,1 0 0,0 11,12A1,1 0 0,0 12,13A1,1 0 0,0 13,12A1,1 0 0,0 12,11M12.5,2C17,2 17.11,5.57 14.75,6.75C13.76,7.24 13.32,8.29 13.13,9.22C13.61,9.42 14.03,9.73 14.35,10.13C18.05,8.13 22.03,8.92 22.03,12.5C22.03,17 18.46,17.1 17.28,14.75C16.78,13.75 15.71,13.31 14.78,13.12C14.58,13.61 14.27,14.04 13.87,14.36C15.87,18.06 15.08,22.04 11.5,22.04C7,22.04 6.91,18.47 9.26,17.29C10.25,16.79 10.69,15.72 10.88,14.79C10.4,14.59 9.98,14.28 9.66,13.88C5.96,15.88 1.98,15.09 1.98,11.51C1.98,7 5.55,6.91 6.73,9.26C7.23,10.25 8.28,10.69 9.21,10.88C9.41,10.4 9.72,9.98 10.12,9.66C8.12,5.96 8.91,1.98 12.5,2Z',
  radiator:
    'M3,4 H21 V6.2 H3 Z M3,17.8 H21 V20 H3 Z M4.2,7.4 H6.8 V16.6 H4.2 Z M8.2,7.4 H10.8 V16.6 H8.2 Z M12.2,7.4 H14.8 V16.6 H12.2 Z M16.2,7.4 H18.8 V16.6 H16.2 Z',

  /* ----------------------------------------------------------------- media */
  speaker:
    'M12,12A3,3 0 0,0 9,15A3,3 0 0,0 12,18A3,3 0 0,0 15,15A3,3 0 0,0 12,12M12,20A5,5 0 0,1 7,15A5,5 0 0,1 12,10A5,5 0 0,1 17,15A5,5 0 0,1 12,20M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4M17,2H7C5.89,2 5,2.89 5,4V20A2,2 0 0,0 7,22H17A2,2 0 0,0 19,20V4C19,2.89 18.1,2 17,2Z',
  television:
    'M21,17H3V5H21M21,3H3A2,2 0 0,0 1,5V17A2,2 0 0,0 3,19H8V21H16V19H21A2,2 0 0,0 23,17V5A2,2 0 0,0 21,3Z',
  camera:
    'M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z',

  /* ---------------------------------------------------------------- people */
  account:
    'M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z',
  home: 'M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z',

  /* -------------------------------------------------------------- generic */
  'map-marker':
    'M12,2A7,7 0 0,0 5,9C5,14.25 12,22 12,22C12,22 19,14.25 19,9A7,7 0 0,0 12,2M12,11.5A2.5,2.5 0 0,1 9.5,9A2.5,2.5 0 0,1 12,6.5A2.5,2.5 0 0,1 14.5,9A2.5,2.5 0 0,1 12,11.5Z',
  circle: 'M7,12 A5,5 0 1,1 17,12 A5,5 0 1,1 7,12 Z',
  power:
    'M16.56,5.44L15.11,6.89C16.84,7.94 18,9.83 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12C6,9.83 7.16,7.94 8.88,6.88L7.44,5.44C5.36,6.88 4,9.28 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,9.28 18.64,6.88 16.56,5.44M13,3H11V13H13',
};

export type IconName = keyof typeof ICON_PATHS;

/** The icon used whenever nothing better can be determined. */
export const FALLBACK_ICON = 'circle';

/**
 * `mdi:*` names HA commonly hands us, mapped onto the local set. Anything not
 * listed falls through to a substring match and then to the role default, so
 * this table only needs the aliases whose names differ structurally.
 */
const MDI_ALIASES: Record<string, string> = {
  bulb: 'lightbulb',
  'lightbulb-group': 'lightbulb',
  'lightbulb-variant': 'lightbulb',
  'lightbulb-on': 'lightbulb',
  'lightbulb-outline': 'lightbulb-off',
  'lightbulb-on-outline': 'lightbulb',
  'led-strip': 'lightbulb',
  'led-strip-variant': 'lightbulb',
  'light-switch': 'toggle-switch',
  'ceiling-fan-light': 'ceiling-light',
  'ceiling-fan': 'fan',
  'fan-off': 'fan',
  'air-conditioner': 'fan',
  'air-purifier': 'fan',
  'hvac': 'fan',
  thermostat: 'thermometer',
  'home-thermometer': 'thermometer',
  'thermometer-lines': 'thermometer',
  'temperature-celsius': 'thermometer',
  'temperature-fahrenheit': 'thermometer',
  'water-thermometer': 'thermometer',
  'water-boiler': 'radiator',
  'radiator-disabled': 'radiator',
  'radiator-off': 'radiator',
  'heating-coil': 'radiator',
  'water-pump': 'valve',
  'pipe-valve': 'valve',
  'valve-open': 'valve',
  'valve-closed': 'valve',
  'gauge-low': 'gauge',
  'gauge-full': 'gauge',
  speedometer: 'gauge',
  'chart-line': 'gauge',
  counter: 'gauge',
  flash: 'power-plug',
  'lightning-bolt': 'power-plug',
  'power-socket': 'power-plug',
  'power-socket-eu': 'power-plug',
  'power-socket-us': 'power-plug',
  outlet: 'power-plug',
  'motion-sensor-off': 'motion-sensor',
  walk: 'motion-sensor',
  run: 'motion-sensor',
  'run-fast': 'motion-sensor',
  'account-multiple': 'account',
  'human-greeting': 'account',
  'account-check': 'account',
  'home-account': 'account',
  'home-assistant': 'home',
  'home-outline': 'home',
  'door-open': 'door-open',
  'door-closed-lock': 'door-closed',
  door: 'door-closed',
  garage: 'blinds-closed',
  'garage-open': 'blinds-open',
  'window-shutter': 'blinds-closed',
  'window-shutter-open': 'blinds-open',
  'window-closed': 'window',
  'window-closed-variant': 'window',
  'window-open-variant': 'window-open',
  curtains: 'blinds-open',
  'curtains-closed': 'blinds-closed',
  'roller-shade': 'blinds-open',
  'roller-shade-closed': 'blinds-closed',
  'blinds': 'blinds-closed',
  'blinds-horizontal': 'blinds-closed',
  'lock-open-variant': 'lock-open',
  'lock-outline': 'lock',
  'shield-lock': 'lock',
  'shield-home': 'lock',
  'smoke-detector-variant': 'smoke-detector',
  'smoke-detector-alert': 'smoke-detector',
  smoke: 'smoke-detector',
  'fire-alert': 'fire',
  'water-off': 'water-percent',
  water: 'water-percent',
  'water-alert': 'water-alert',
  'water-boiler-alert': 'water-alert',
  leak: 'water-alert',
  'pipe-leak': 'water-alert',
  'cctv': 'camera',
  'video': 'camera',
  'video-off': 'camera',
  webcam: 'camera',
  'cast-connected': 'television',
  'television-classic': 'television',
  'monitor': 'television',
  'speaker-multiple': 'speaker',
  'volume-high': 'speaker',
  'music': 'speaker',
  'cast': 'television',
  'battery-charging': 'battery-outline',
  battery: 'battery-outline',
  'battery-50': 'battery-outline',
  'signal': 'wifi',
  'wifi-strength-4': 'wifi',
  'access-point': 'wifi',
  'router-wireless': 'wifi',
  'alert-circle': 'alert',
  'alert-outline': 'alert',
  'exclamation-thick': 'alert',
  'toggle-switch-outline': 'toggle-switch',
  'toggle-switch-off-outline': 'toggle-switch-off',
  'flash-off': 'power-plug-off',
};

/** Default glyph per role when the entity has no explicit icon. */
const ROLE_DEFAULTS: Record<EntityRole, string> = {
  light: 'lightbulb',
  switch: 'toggle-switch',
  sensor: 'gauge',
  binary_sensor: 'motion-sensor',
  cover: 'blinds-closed',
  climate: 'thermometer',
  media_player: 'speaker',
  camera: 'camera',
  person: 'account',
  marker: 'map-marker',
};

/**
 * Device-class driven glyphs. HA's device_class is far more reliable than the
 * icon string for picking something meaningful, so it wins over the role.
 * `[offGlyph, onGlyph]` — the second entry is used when the entity is active.
 */
const DEVICE_CLASS_ICONS: Record<string, [string, string]> = {
  /* binary_sensor */
  motion: ['motion-sensor', 'motion-sensor'],
  occupancy: ['motion-sensor', 'motion-sensor'],
  presence: ['home', 'account'],
  door: ['door-closed', 'door-open'],
  garage_door: ['blinds-closed', 'blinds-open'],
  opening: ['door-closed', 'door-open'],
  window: ['window', 'window-open'],
  smoke: ['smoke-detector', 'smoke-detector'],
  gas: ['smoke-detector', 'alert'],
  heat: ['thermometer', 'fire'],
  moisture: ['water-percent', 'water-alert'],
  problem: ['circle', 'alert'],
  safety: ['circle', 'alert'],
  lock: ['lock-open', 'lock'],
  tamper: ['circle', 'alert'],
  connectivity: ['wifi', 'wifi'],
  battery: ['battery-outline', 'alert'],
  /* sensor */
  temperature: ['thermometer', 'thermometer'],
  humidity: ['water-percent', 'water-percent'],
  pressure: ['gauge', 'gauge'],
  atmospheric_pressure: ['gauge', 'gauge'],
  illuminance: ['lightbulb-off', 'lightbulb'],
  power: ['power-plug', 'power-plug'],
  energy: ['power-plug', 'power-plug'],
  current: ['power-plug', 'power-plug'],
  voltage: ['power-plug', 'power-plug'],
  signal_strength: ['wifi', 'wifi'],
  /* cover */
  shutter: ['blinds-closed', 'blinds-open'],
  blind: ['blinds-closed', 'blinds-open'],
  curtain: ['blinds-closed', 'blinds-open'],
  shade: ['blinds-closed', 'blinds-open'],
  awning: ['blinds-closed', 'blinds-open'],
  /* switch / valve */
  outlet: ['power-plug-off', 'power-plug'],
  valve: ['valve', 'valve'],
  water: ['valve', 'water-percent'],
};

/** HA states that mean "this thing is doing something". */
const ACTIVE_STATES = new Set(['on', 'open', 'opening', 'closing', 'home', 'playing', 'heat',
  'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'unlocked', 'detected', 'active']);

export function isActiveState(state: string | null | undefined): boolean {
  return !!state && ACTIVE_STATES.has(state.toLowerCase());
}

/** Normalises `mdi:foo`, `hass:foo`, `foo` and `mdi-foo` to a bare glyph name. */
function normaliseIconName(raw: string): string {
  const name = raw.trim().toLowerCase();
  const colon = name.indexOf(':');
  return (colon >= 0 ? name.slice(colon + 1) : name).replace(/_/g, '-');
}

/**
 * Best-effort mapping of an arbitrary MDI name onto the local set: exact hit,
 * then alias table, then longest substring match (`lightbulb-multiple-outline`
 * -> `lightbulb`). Returns null when nothing plausible exists.
 */
function lookupGlyph(raw: string): string | null {
  const name = normaliseIconName(raw);
  if (!name) return null;
  if (ICON_PATHS[name]) return name;
  const alias = MDI_ALIASES[name];
  if (alias && ICON_PATHS[alias]) return alias;

  let best: string | null = null;
  for (const key of Object.keys(ICON_PATHS)) {
    if (name.includes(key) && (!best || key.length > best.length)) best = key;
  }
  if (best) return best;

  for (const [aliasKey, target] of Object.entries(MDI_ALIASES)) {
    if (name.includes(aliasKey) && ICON_PATHS[target]) return target;
  }
  return null;
}

/** True when the local set contains this glyph. */
export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICON_PATHS, name);
}

export function getIconPath(name: string): string {
  return ICON_PATHS[name] ?? ICON_PATHS[FALLBACK_ICON];
}

/**
 * Pick the glyph for an entity.
 *
 * Precedence: explicit config icon > device class (state-aware) > role default,
 * with a couple of role-specific on/off swaps layered on top so a lit lamp and
 * a dark one do not look identical.
 */
export function resolveIcon(
  role?: EntityRole | null,
  deviceClass?: string | null,
  state?: string | null,
  explicitIcon?: string | null,
): string {
  if (explicitIcon) {
    const hit = lookupGlyph(explicitIcon);
    if (hit) return hit;
  }

  const active = isActiveState(state);

  if (deviceClass) {
    const pair = DEVICE_CLASS_ICONS[deviceClass.toLowerCase()];
    if (pair) return active ? pair[1] : pair[0];
  }

  switch (role) {
    case 'light':
      return active ? 'lightbulb' : 'lightbulb-off';
    case 'switch':
      return active ? 'toggle-switch' : 'toggle-switch-off';
    case 'cover':
      return active ? 'blinds-open' : 'blinds-closed';
    default:
      break;
  }

  return role ? ROLE_DEFAULTS[role] ?? FALLBACK_ICON : FALLBACK_ICON;
}

/** HA domain -> visual role. Used when the palette drags in a bare entity id. */
export function roleForDomain(domain: string): EntityRole {
  switch (domain) {
    case 'light':
      return 'light';
    case 'switch':
    case 'input_boolean':
    case 'automation':
    case 'script':
    case 'scene':
    case 'fan':
    case 'valve':
    case 'siren':
    case 'humidifier':
    case 'water_heater':
      return 'switch';
    case 'sensor':
    case 'number':
    case 'input_number':
      return 'sensor';
    case 'binary_sensor':
    case 'lock':
    case 'alarm_control_panel':
      return 'binary_sensor';
    case 'cover':
      return 'cover';
    case 'climate':
      return 'climate';
    case 'media_player':
      return 'media_player';
    case 'camera':
      return 'camera';
    case 'person':
    case 'device_tracker':
      return 'person';
    default:
      return 'marker';
  }
}

export function roleForEntityId(entityId: string): EntityRole {
  const dot = entityId.indexOf('.');
  return roleForDomain(dot > 0 ? entityId.slice(0, dot) : '');
}

/** `light.kitchen_ceiling` -> `Kitchen Ceiling`. Only used as a last resort. */
export function humaniseEntityId(entityId: string): string {
  const dot = entityId.indexOf('.');
  const objectId = dot >= 0 ? entityId.slice(dot + 1) : entityId;
  return (
    objectId
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || entityId
  );
}
