/**
 * Resolution of `render.background` into something the renderer can clear with.
 *
 * The setting is a CSS colour, but three keywords carry most of the real use:
 * `light` and `dark` pin the backdrop regardless of the dashboard theme, and
 * `system` follows it. Pinning matters because the mono palettes flatten the
 * model to a single tone — `mono-dark` on a dark dashboard is invisible, and no
 * amount of edge-colour cleverness fixes a dark object on a dark ground.
 *
 * Shared by the render core (which paints it) and the viewer (which picks the
 * edge ink that has to contrast with it), so the two can never disagree.
 */

import * as THREE from 'three';

export interface ResolvedBackground {
  /** Colour to clear with, or `null` to leave the canvas transparent. */
  color: string | null;
  /** Whether what ends up behind the model reads as dark. Drives edge ink. */
  dark: boolean;
}

/**
 * Neutral greys rather than pure black/white: a full-white ground blows out
 * against the tone-mapped model, and full black hides the ambient falloff.
 */
const LIGHT_FILL = '#eef1f5';
const DARK_FILL = '#15181c';

/**
 * Linear-space luminance below which a colour reads as dark. 0.18 is the linear
 * value of mid-grey in sRGB, so this splits colours the way an eye does rather
 * than at the arithmetic midpoint.
 */
const DARK_LUMINANCE = 0.18;

const _probe = new THREE.Color();

export function resolveBackground(css: string | undefined, themeDark: boolean): ResolvedBackground {
  const value = (css ?? '').trim().toLowerCase();

  switch (value) {
    // Default. The Home Assistant card shows through, so the view matches the
    // user's theme in both polarities without anyone configuring a colour.
    case '':
    case 'transparent':
    case 'none':
      return { color: null, dark: themeDark };
    case 'light':
      return { color: LIGHT_FILL, dark: false };
    case 'dark':
      return { color: DARK_FILL, dark: true };
    // Opaque, but follows the dashboard. Differs from `transparent` in that the
    // ground is a known neutral instead of whatever the card is painted with.
    case 'system':
    case 'auto':
      return themeDark ? { color: DARK_FILL, dark: true } : { color: LIGHT_FILL, dark: false };
    default:
      return { color: value, dark: isDarkColor(value, themeDark) };
  }
}

const CSS_COLOR_RE = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^)]*\))$/;

/** `fallback` covers values three.js cannot parse, such as `var(--card-bg)`. */
function isDarkColor(value: string, fallback: boolean): boolean {
  // `setStyle` warns and silently keeps its previous value on anything it does
  // not understand, so the probe has to be guarded rather than inspected after.
  const known =
    CSS_COLOR_RE.test(value) || Object.prototype.hasOwnProperty.call(THREE.Color.NAMES, value);
  if (!known) return fallback;

  _probe.setStyle(value);
  // setStyle converts to the working (linear) space, which is the space the
  // Rec. 709 coefficients below are defined in.
  return _probe.r * 0.2126 + _probe.g * 0.7152 + _probe.b * 0.0722 < DARK_LUMINANCE;
}
