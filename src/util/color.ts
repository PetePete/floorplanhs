/**
 * Colour conversions shared by the lighting system and the marker layer.
 * All "linear" outputs are 0..1 triples ready for THREE.Color.setRGB with
 * THREE.LinearSRGBColorSpace.
 */

export type RGB = [number, number, number];

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** sRGB component (0..1) -> linear. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function rgb255ToLinear(rgb: readonly number[]): RGB {
  return [
    srgbToLinear(clamp01((rgb[0] ?? 255) / 255)),
    srgbToLinear(clamp01((rgb[1] ?? 255) / 255)),
    srgbToLinear(clamp01((rgb[2] ?? 255) / 255)),
  ];
}

/** `#rrggbb` / `#rgb` / `rgb(r,g,b)` -> 0..255 triple. Returns null on junk. */
export function parseCssColor(input: string): RGB | null {
  const s = input.trim().toLowerCase();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
    return null;
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

export function rgbToHex(rgb: readonly number[]): string {
  const to = (v: number) =>
    Math.round(clamp(v, 0, 255))
      .toString(16)
      .padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

/** HA reports hue 0..360 / saturation 0..100. */
export function hsToRgb255(hue: number, saturation: number): RGB {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp01(saturation / 100);
  const c = s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = 1 - c;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Colour temperature -> sRGB, Tanner Helland's approximation. Good enough for
 * the 2000–6500 K range warm-white bulbs actually report and much cheaper than
 * a full Planckian locus lookup.
 */
export function kelvinToRgb255(kelvin: number): RGB {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }

  if (t >= 66) {
    b = 255;
  } else if (t <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  }

  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}

/** Mireds are what HA still uses on many integrations. */
export function miredToKelvin(mired: number): number {
  return mired > 0 ? 1_000_000 / mired : 2700;
}

export function mixLinear(a: RGB, b: RGB, t: number): RGB {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Relative luminance of a linear RGB triple. */
export function luminance(rgb: RGB): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
