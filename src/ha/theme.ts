/**
 * Reads Home Assistant's theme through the CSS custom properties it sets on the
 * card's ancestors, so the 3D view can match the dashboard instead of fighting
 * it. HA themes are pure CSS — there is no JSON theme object a card can query —
 * which is why this has to go through `getComputedStyle`.
 */

import type { HomeAssistant } from '@/types/hass';
import { clamp01, parseCssColor, rgbToHex, type RGB } from '@/util/color';

export interface ThemeColors {
  primary: string;
  accent: string;
  text: string;
  secondaryText: string;
  cardBackground: string;
  divider: string;
  /** `--state-icon-active-color`, the amber HA uses for "on". */
  stateActive: string;
  error: string;
  warning: string;
  success: string;
  isDark: boolean;
}

export interface SceneColors {
  /** Clear colour behind the model. */
  background: string;
  /** Distance fog, tuned to blend into the background. */
  fog: string;
  fogNear: number;
  fogFar: number;
  /** Default marker tint for entities without a role-specific colour. */
  markerAccent: string;
  markerActive: string;
  markerInactive: string;
  markerUnavailable: string;
  /** Ground plane / grid under the house. */
  ground: string;
  /** Fill colour for section cut caps. */
  cap: string;
  /** Outline used for hover/selection highlights. */
  outline: string;
}

/**
 * Used when the card renders before it is attached, in unit tests, or on an HA
 * version that does not define one of the variables. These are the values of
 * HA's own default light theme.
 */
export const FALLBACK_THEME_LIGHT: ThemeColors = {
  primary: '#03a9f4',
  accent: '#ff9800',
  text: '#212121',
  secondaryText: '#727272',
  cardBackground: '#ffffff',
  divider: '#e0e0e0',
  stateActive: '#fdd835',
  error: '#db4437',
  warning: '#ffa600',
  success: '#43a047',
  isDark: false,
};

export const FALLBACK_THEME_DARK: ThemeColors = {
  primary: '#03a9f4',
  accent: '#ff9800',
  text: '#e1e1e1',
  secondaryText: '#9b9b9b',
  cardBackground: '#1c1c1c',
  divider: '#3f3f3f',
  stateActive: '#fdd835',
  error: '#db4437',
  warning: '#ffa600',
  success: '#43a047',
  isDark: true,
};

/** Neutral default for pure-logic callers (state mapper, tests). */
export const FALLBACK_THEME = FALLBACK_THEME_DARK;

const VARIABLES: Record<Exclude<keyof ThemeColors, 'isDark'>, string> = {
  primary: '--primary-color',
  accent: '--accent-color',
  text: '--primary-text-color',
  secondaryText: '--secondary-text-color',
  cardBackground: '--card-background-color',
  divider: '--divider-color',
  stateActive: '--state-icon-active-color',
  error: '--error-color',
  warning: '--warning-color',
  success: '--success-color',
};

/**
 * Computed values can be `rgb(3, 169, 244)`, `#03a9f4`, a named colour or an
 * unresolved `var(...)`. Normalise what we can parse and keep anything else
 * verbatim — CSS will still understand it even if we cannot.
 */
function normaliseColor(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  if (!value || value === 'initial' || value.startsWith('var(')) return fallback;
  const parsed = parseCssColor(value);
  return parsed ? rgbToHex(parsed) : value;
}

function isDarkMode(hass: HomeAssistant | undefined): boolean {
  if (!hass) return false;
  if (typeof hass.themes?.darkMode === 'boolean') return hass.themes.darkMode;
  if (typeof hass.themes?.dark === 'boolean') return hass.themes.dark;
  if (typeof hass.selectedTheme?.dark === 'boolean') return hass.selectedTheme.dark;
  return false;
}

/**
 * The palette to assume when no element is available to read CSS variables
 * from — pure-logic callers such as the state mapper and its unit tests.
 */
export function fallbackThemeFor(hass: HomeAssistant | undefined): ThemeColors {
  return isDarkMode(hass) ? FALLBACK_THEME_DARK : FALLBACK_THEME_LIGHT;
}

/**
 * Pull HA's palette off `element`. Safe to call before the element is in the
 * document: `getComputedStyle` on a detached node returns empty strings and we
 * fall back per-variable, so callers never get an empty colour.
 */
export function readTheme(element: HTMLElement | null, hass: HomeAssistant | undefined): ThemeColors {
  const dark = isDarkMode(hass);
  const fallback = dark ? FALLBACK_THEME_DARK : FALLBACK_THEME_LIGHT;

  let style: CSSStyleDeclaration | null = null;
  try {
    const target = element ?? (typeof document !== 'undefined' ? document.documentElement : null);
    if (target && typeof getComputedStyle === 'function') style = getComputedStyle(target);
  } catch {
    style = null;
  }

  const read = (key: Exclude<keyof ThemeColors, 'isDark'>): string =>
    normaliseColor(style?.getPropertyValue(VARIABLES[key]), fallback[key]);

  return {
    primary: read('primary'),
    accent: read('accent'),
    text: read('text'),
    secondaryText: read('secondaryText'),
    cardBackground: read('cardBackground'),
    divider: read('divider'),
    stateActive: read('stateActive'),
    error: read('error'),
    warning: read('warning'),
    success: read('success'),
    isDark: dark,
  };
}

/* ------------------------------------------------------------- colour math */

function toRgb(color: string, fallback: RGB): RGB {
  return parseCssColor(color) ?? fallback;
}

function mix255(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Blend towards black. `amount` 0..1. */
export function darken(color: string, amount: number): string {
  return rgbToHex(mix255(toRgb(color, [128, 128, 128]), [0, 0, 0], amount));
}

/** Blend towards white. `amount` 0..1. */
export function lighten(color: string, amount: number): string {
  return rgbToHex(mix255(toRgb(color, [128, 128, 128]), [255, 255, 255], amount));
}

export function mixColors(a: string, b: string, t: number): string {
  return rgbToHex(mix255(toRgb(a, [128, 128, 128]), toRgb(b, [128, 128, 128]), t));
}

/** Perceived brightness 0..1, used to pick readable foregrounds. */
export function relativeBrightness(color: string): number {
  const [r, g, b] = toRgb(color, [128, 128, 128]);
  return clamp01((0.299 * r + 0.587 * g + 0.114 * b) / 255);
}

/**
 * Scene colours derived from the dashboard theme. The background is a slightly
 * pushed version of the card background rather than the raw value: an exact
 * match makes the model float without any sense of depth, while a small shift
 * reads as "inside the card" without looking like a different surface.
 */
export function themeToSceneColors(theme: ThemeColors): SceneColors {
  const background = theme.isDark
    ? darken(theme.cardBackground, 0.35)
    : darken(theme.cardBackground, 0.06);

  return {
    background,
    fog: theme.isDark ? mixColors(background, theme.primary, 0.08) : lighten(background, 0.25),
    fogNear: 25,
    fogFar: 140,
    markerAccent: theme.primary,
    markerActive: theme.stateActive,
    markerInactive: theme.isDark ? lighten(theme.secondaryText, 0.1) : theme.secondaryText,
    markerUnavailable: theme.isDark ? darken(theme.secondaryText, 0.25) : lighten(theme.divider, 0.1),
    ground: theme.isDark ? darken(background, 0.25) : darken(background, 0.08),
    cap: theme.isDark ? lighten(theme.divider, 0.05) : darken(theme.divider, 0.15),
    outline: theme.accent,
  };
}
