/**
 * Quality tiers. HA dashboards run on everything from a gaming PC to a €60
 * wall tablet, so the renderer picks its cost knobs from a device probe unless
 * the user pinned them in YAML.
 *
 * Per ARCHITECTURE.md the tiers only downgrade *rendering* cost (pixel ratio,
 * shadow map size, postfx) — never geometry — so the picture stays the same
 * shape on every device.
 */

import type { RenderConfig } from '@/types/config';
import type { QualityTier } from '@/engine/contracts';

export interface QualitySettings {
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  anisotropy: number;
  antialias: boolean;
  softShadows: boolean;
}

/**
 * Tier defaults. `pixelRatio` here is a *cap*: the effective value is
 * `min(devicePixelRatio, cap)`, so a 1x desktop screen never gets upsampled.
 */
export const QUALITY_PRESETS: Readonly<Record<QualityTier, QualitySettings>> = Object.freeze({
  low: {
    pixelRatio: 1,
    shadows: false,
    shadowMapSize: 512,
    bloom: false,
    anisotropy: 1,
    antialias: false,
    softShadows: false,
  },
  medium: {
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    anisotropy: 4,
    antialias: true,
    softShadows: false,
  },
  high: {
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    anisotropy: 8,
    antialias: true,
    softShadows: true,
  },
});

/** `deviceMemory` is Chromium-only and not in lib.dom. */
interface NavigatorProbe extends Navigator {
  deviceMemory?: number;
}

/** Renderer strings that mean "no GPU at all" — always the bottom tier. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render|microsoft basic|mesa offscreen/i;

/** Mobile/embedded GPU families. Capable, but never worth the top tier. */
const MOBILE_GPU = /adreno|mali|powervr|videocore|apple gpu|tegra|immortalis|xclipse/i;

/**
 * Reads the unmasked GPU string. Costs a WebGL context, so we release it
 * immediately via WEBGL_lose_context rather than waiting for GC — browsers cap
 * live contexts around 16 and a dashboard may hold several cards.
 */
function probeRenderer(): string {
  if (typeof document === 'undefined') return '';
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return '';
    let name = '';
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    if (debug) {
      const value: unknown = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
      if (typeof value === 'string') name = value;
    }
    if (!name) {
      const value: unknown = gl.getParameter(gl.RENDERER);
      if (typeof value === 'string') name = value;
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  } finally {
    canvas?.remove();
  }
}

/**
 * Best-effort device classification. Deliberately pessimistic: a wrongly-low
 * tier costs some visual polish, a wrongly-high tier makes a tablet unusable.
 */
export function detectQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';

  const nav = navigator as NavigatorProbe;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 4;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 4;
  const coarsePointer =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  const gpu = probeRenderer();

  if (SOFTWARE_RENDERER.test(gpu)) return 'low';
  if (cores <= 2 || memory <= 2) return 'low';

  const mobileClass = coarsePointer || MOBILE_GPU.test(gpu);
  if (mobileClass) {
    // Phones and cheap tablets: shadows and bloom are what kills them.
    return cores <= 4 || memory <= 4 ? 'low' : 'medium';
  }

  if (cores >= 8 && memory >= 8) return 'high';
  return 'medium';
}

/**
 * Resolve a tier plus its settings, letting explicit `render.*` flags override
 * the tier default.
 *
 * IMPORTANT: pass the *user's* render block, not one merged with
 * DEFAULT_RENDER_CONFIG — after merging, every field looks "explicit" and the
 * detected tier would never get to decide anything.
 */
export function resolveQuality(
  tier: QualityTier | 'auto',
  render: RenderConfig,
): { tier: QualityTier; settings: QualitySettings } {
  const resolved: QualityTier = tier === 'auto' ? detectQuality() : tier;
  const settings: QualitySettings = { ...QUALITY_PRESETS[resolved] };

  const dpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1;
  const cap =
    typeof render.maxPixelRatio === 'number' && render.maxPixelRatio > 0
      ? render.maxPixelRatio
      : settings.pixelRatio;
  settings.pixelRatio = Math.max(0.5, Math.min(dpr > 0 ? dpr : 1, cap));

  if (typeof render.shadows === 'boolean') settings.shadows = render.shadows;
  if (typeof render.bloom === 'boolean') settings.bloom = render.bloom;

  return { tier: resolved, settings };
}
