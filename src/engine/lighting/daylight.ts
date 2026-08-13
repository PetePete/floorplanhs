/**
 * Sun, sky and the "never pitch black" ambient floor.
 *
 * Driven by Home Assistant's `sun.sun` (`elevation` −90..90°, `azimuth`
 * 0..360° clockwise from north). Everything is graded off elevation through a
 * small gradient LUT: deep blue below the horizon, orange at sunrise/sunset,
 * neutral white overhead. Transitions tween over 1.5 s so a state push at dusk
 * does not snap the whole house.
 *
 * Intensities are on the same exposure anchor as `light-rig.ts`: a Lambertian
 * surface renders as L = albedo/π · E and ACES maps L ≈ 0.7 to a bright wall, so
 * full midday sun sits at ≈ 5.2 (albedo 0.6 → L ≈ 1.0, i.e. a sunlit white wall
 * just short of clipping).
 */

import * as THREE from 'three';
import { PMREMGenerator } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { QualityTier, RenderContext } from '@/engine/contracts';
import { clamp, degToRad, easeInOutCubic } from '@/util/math';

/* ------------------------------------------------------------- constants */

/** Daylight state transition. Slow enough to read as a change of light. */
const DAYLIGHT_TWEEN_S = 1.5;

/** Sun shadow map edge per tier. The sun is one ortho pass — far cheaper than a
 *  point light cube map — so it gets a bigger map than the lamps do. */
const SUN_SHADOW_SIZE: Readonly<Record<QualityTier, number>> = {
  low: 0,
  medium: 1024,
  high: 2048,
};

/**
 * At 2048² over a 20 m radius one texel is ≈ 2 cm, so a 4 cm normalBias offsets
 * the sample by ~2 texels: enough for acne-free large flat floors, small enough
 * that door reveals do not detach from their shadows.
 */
const SUN_SHADOW_BIAS = -0.0005;
const SUN_SHADOW_NORMAL_BIAS = 0.04;

/** Fallback scene radius before the model reports its bounds. */
const DEFAULT_SCENE_RADIUS_M = 15;

interface SkyStop {
  /** Solar elevation in degrees this stop describes. */
  elevation: number;
  sun: number;
  sunIntensity: number;
  sky: number;
  ground: number;
  hemiIntensity: number;
  ambient: number;
  /** Multiplier on the user's configured ambientIntensity. */
  ambientScale: number;
  /** Scene environment (PMREM) weight. */
  envIntensity: number;
}

/**
 * The gradient LUT. Values are sRGB hex (converted to the linear working space
 * by THREE.Color) and are interpolated linearly between neighbouring stops.
 */
const SKY_LUT: readonly SkyStop[] = [
  // Deep night: no sun, a cold blue wash, and just enough ambient to read shapes.
  {
    elevation: -90,
    sun: 0x6f86c9,
    sunIntensity: 0.06,
    sky: 0x0d1526,
    ground: 0x05070c,
    hemiIntensity: 0.12,
    ambient: 0x33406b,
    ambientScale: 0.85,
    envIntensity: 0.18,
  },
  // Civil twilight.
  {
    elevation: -6,
    sun: 0xb07a6a,
    sunIntensity: 0.28,
    sky: 0x2b3550,
    ground: 0x14161c,
    hemiIntensity: 0.4,
    ambient: 0x4b5878,
    ambientScale: 0.95,
    envIntensity: 0.35,
  },
  // Sun on the horizon: golden hour.
  {
    elevation: 0,
    sun: 0xff8a3d,
    sunIntensity: 1.6,
    sky: 0x7d8ab5,
    ground: 0x35302c,
    hemiIntensity: 0.8,
    ambient: 0x6d6a72,
    ambientScale: 1.0,
    envIntensity: 0.6,
  },
  // Low sun, still warm.
  {
    elevation: 8,
    sun: 0xffc07a,
    sunIntensity: 2.9,
    sky: 0x9fb4de,
    ground: 0x4a463f,
    hemiIntensity: 1.2,
    ambient: 0x8f9099,
    ambientScale: 1.05,
    envIntensity: 0.85,
  },
  // Mid morning / afternoon.
  {
    elevation: 25,
    sun: 0xfff0dc,
    sunIntensity: 4.2,
    sky: 0xb9d0f2,
    ground: 0x55524a,
    hemiIntensity: 1.6,
    ambient: 0xa8aeb8,
    ambientScale: 1.1,
    envIntensity: 1.0,
  },
  // Overhead: neutral white.
  {
    elevation: 90,
    sun: 0xffffff,
    sunIntensity: 5.2,
    sky: 0xcfe0ff,
    ground: 0x5c5a52,
    hemiIntensity: 1.9,
    ambient: 0xb4bac4,
    ambientScale: 1.15,
    envIntensity: 1.15,
  },
];

/** Used when daylight is switched off entirely: interior-only, neutral. */
const DAYLIGHT_OFF: Omit<SkyStop, 'elevation'> = {
  sun: 0xffffff,
  sunIntensity: 0,
  sky: 0x3a4250,
  ground: 0x1a1c20,
  hemiIntensity: 0.25,
  ambient: 0x9aa0ac,
  ambientScale: 1.0,
  envIntensity: 0.35,
};

/* ------------------------------------------------------------ interpolant */

interface SkyState {
  sunColor: THREE.Color;
  sunIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  hemiIntensity: number;
  ambientColor: THREE.Color;
  ambientScale: number;
  envIntensity: number;
  sunDir: THREE.Vector3;
}

function makeState(): SkyState {
  return {
    sunColor: new THREE.Color(0xffffff),
    sunIntensity: 0,
    skyColor: new THREE.Color(0x3a4250),
    groundColor: new THREE.Color(0x1a1c20),
    hemiIntensity: 0.25,
    ambientColor: new THREE.Color(0x9aa0ac),
    ambientScale: 1,
    envIntensity: 0.35,
    sunDir: new THREE.Vector3(0, 1, 0),
  };
}

function lerpState(out: SkyState, a: SkyState, b: SkyState, t: number): void {
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, t);
  out.skyColor.copy(a.skyColor).lerp(b.skyColor, t);
  out.groundColor.copy(a.groundColor).lerp(b.groundColor, t);
  out.ambientColor.copy(a.ambientColor).lerp(b.ambientColor, t);
  out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;
  out.hemiIntensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * t;
  out.ambientScale = a.ambientScale + (b.ambientScale - a.ambientScale) * t;
  out.envIntensity = a.envIntensity + (b.envIntensity - a.envIntensity) * t;
  out.sunDir.copy(a.sunDir).lerp(b.sunDir, t);
  if (out.sunDir.lengthSq() > 1e-8) out.sunDir.normalize();
}

/**
 * HA azimuth is degrees clockwise from north. The engine convention is Y up
 * with the model facing −Z, so north is −Z and east is +X.
 */
export function sunDirection(elevationDeg: number, azimuthDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const el = degToRad(clamp(elevationDeg, -90, 90));
  const az = degToRad(azimuthDeg);
  const horizontal = Math.cos(el);
  return out.set(Math.sin(az) * horizontal, Math.sin(el), -Math.cos(az) * horizontal).normalize();
}

function sampleLut(elevation: number, out: SkyState): void {
  const e = clamp(elevation, -90, 90);
  let lo = SKY_LUT[0];
  let hi = SKY_LUT[SKY_LUT.length - 1];
  for (let i = 0; i < SKY_LUT.length - 1; i += 1) {
    if (e >= SKY_LUT[i].elevation && e <= SKY_LUT[i + 1].elevation) {
      lo = SKY_LUT[i];
      hi = SKY_LUT[i + 1];
      break;
    }
  }
  const span = hi.elevation - lo.elevation;
  const t = span > 0 ? clamp((e - lo.elevation) / span, 0, 1) : 0;

  out.sunColor.setHex(lo.sun, THREE.SRGBColorSpace).lerp(
    scratchColor.setHex(hi.sun, THREE.SRGBColorSpace),
    t,
  );
  out.skyColor.setHex(lo.sky, THREE.SRGBColorSpace).lerp(
    scratchColor.setHex(hi.sky, THREE.SRGBColorSpace),
    t,
  );
  out.groundColor.setHex(lo.ground, THREE.SRGBColorSpace).lerp(
    scratchColor.setHex(hi.ground, THREE.SRGBColorSpace),
    t,
  );
  out.ambientColor.setHex(lo.ambient, THREE.SRGBColorSpace).lerp(
    scratchColor.setHex(hi.ambient, THREE.SRGBColorSpace),
    t,
  );
  out.sunIntensity = lo.sunIntensity + (hi.sunIntensity - lo.sunIntensity) * t;
  out.hemiIntensity = lo.hemiIntensity + (hi.hemiIntensity - lo.hemiIntensity) * t;
  out.ambientScale = lo.ambientScale + (hi.ambientScale - lo.ambientScale) * t;
  out.envIntensity = lo.envIntensity + (hi.envIntensity - lo.envIntensity) * t;
}

const scratchColor = new THREE.Color();

/* ------------------------------------------------------------------- rig */

export interface DaylightOptions {
  /** `RenderConfig.ambientIntensity`; the floor so an all-off house is moody. */
  ambientIntensity?: number;
  quality?: QualityTier;
  /** Generate a PMREM room environment for indoor reflections. */
  environment?: boolean;
}

export class DaylightRig {
  readonly group: THREE.Group;

  private ctx: RenderContext | null = null;

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;

  private readonly from = makeState();
  private readonly to = makeState();
  private readonly current = makeState();

  private tweenElapsed = 0;
  private tweenDuration = 0;

  private ambientIntensity: number;
  private tier: QualityTier;
  private wantEnvironment: boolean;
  private shadowsEnabled = true;

  private elevation = 45;
  private azimuth = 180;
  private enabled = true;

  private center = new THREE.Vector3(0, 1.4, 0);
  private radius = DEFAULT_SCENE_RADIUS_M;

  private pmrem: PMREMGenerator | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  /** Set only if we own scene.environment, so dispose does not steal someone
   *  else's map. */
  private ownsEnvironment = false;

  private disposed = false;

  constructor(options: DaylightOptions = {}) {
    this.ambientIntensity = options.ambientIntensity ?? 0.28;
    this.tier = options.quality ?? 'high';
    this.wantEnvironment = options.environment ?? true;

    this.group = new THREE.Group();
    this.group.name = 'daylight';

    this.sun = new THREE.DirectionalLight(0xffffff, 0);
    this.sun.name = 'sun';
    this.sun.castShadow = false;
    this.sun.shadow.bias = SUN_SHADOW_BIAS;
    this.sun.shadow.normalBias = SUN_SHADOW_NORMAL_BIAS;
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xcfe0ff, 0x5c5a52, 0);
    this.hemi.name = 'sky';
    this.group.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0x9aa0ac, this.ambientIntensity);
    this.ambient.name = 'ambient-floor';
    this.group.add(this.ambient);

    // Start settled on whatever the initial daylight is, so the first frame is
    // not a 1.5 s fade-in from black.
    this.resolveTarget(this.to);
    copyState(this.current, this.to);
    copyState(this.from, this.to);
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.scene.add(this.group);
    this.applyShadowQuality();
    this.applyState();
    if (this.wantEnvironment) this.buildEnvironment();
  }

  /* ------------------------------------------------------------- inputs */

  /** `elevation` −90..90°, `azimuth` 0..360° clockwise from north. */
  setDaylight(elevation: number, azimuth: number, enabled: boolean): boolean {
    const changed =
      Math.abs(elevation - this.elevation) > 0.05 ||
      Math.abs(azimuth - this.azimuth) > 0.05 ||
      enabled !== this.enabled;
    this.elevation = elevation;
    this.azimuth = azimuth;
    this.enabled = enabled;
    if (!changed) return false;

    copyState(this.from, this.current);
    this.resolveTarget(this.to);
    this.tweenElapsed = 0;
    this.tweenDuration = DAYLIGHT_TWEEN_S;
    return true;
  }

  /** Jump straight to the pending target. Used for the first push at mount, so
   *  adding the card does not play a 1.5 s sunrise. */
  settle(): void {
    copyState(this.current, this.to);
    this.tweenDuration = 0;
    this.tweenElapsed = 0;
    this.applyState();
  }

  setAmbientIntensity(value: number): void {
    if (Math.abs(value - this.ambientIntensity) < 1e-4) return;
    this.ambientIntensity = value;
    this.applyState();
  }

  setShadowsEnabled(enabled: boolean): void {
    if (this.shadowsEnabled === enabled) return;
    this.shadowsEnabled = enabled;
    this.applyShadowQuality();
  }

  setQuality(tier: QualityTier): void {
    if (this.tier === tier) return;
    this.tier = tier;
    this.applyShadowQuality();
  }

  /** Fit the sun's shadow frustum to the house. Call after the model loads. */
  setBounds(bounds: THREE.Box3): void {
    if (bounds.isEmpty()) return;
    bounds.getCenter(this.center);
    const sphere = bounds.getBoundingSphere(scratchSphere);
    this.radius = Math.max(2, sphere.radius);
    this.applyShadowFrustum();
    this.applyState();
  }

  /* -------------------------------------------------------------- update */

  /** Returns true while the daylight transition still needs frames. */
  update(dt: number): boolean {
    if (this.disposed || this.tweenDuration <= 0) return false;
    this.tweenElapsed += dt;
    const raw = clamp(this.tweenElapsed / this.tweenDuration, 0, 1);
    lerpState(this.current, this.from, this.to, easeInOutCubic(raw));
    if (raw >= 1) {
      this.tweenDuration = 0;
      copyState(this.current, this.to);
    }
    this.applyState();
    return this.tweenDuration > 0;
  }

  /* -------------------------------------------------------------- guts */

  private resolveTarget(out: SkyState): void {
    if (!this.enabled) {
      out.sunColor.setHex(DAYLIGHT_OFF.sun, THREE.SRGBColorSpace);
      out.skyColor.setHex(DAYLIGHT_OFF.sky, THREE.SRGBColorSpace);
      out.groundColor.setHex(DAYLIGHT_OFF.ground, THREE.SRGBColorSpace);
      out.ambientColor.setHex(DAYLIGHT_OFF.ambient, THREE.SRGBColorSpace);
      out.sunIntensity = DAYLIGHT_OFF.sunIntensity;
      out.hemiIntensity = DAYLIGHT_OFF.hemiIntensity;
      out.ambientScale = DAYLIGHT_OFF.ambientScale;
      out.envIntensity = DAYLIGHT_OFF.envIntensity;
      // Keep a plausible key direction so shadows do not swing when re-enabled.
      sunDirection(45, this.azimuth, out.sunDir);
      return;
    }
    sampleLut(this.elevation, out);
    sunDirection(this.elevation, this.azimuth, out.sunDir);
  }

  private applyState(): void {
    const s = this.current;
    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.sun.visible = s.sunIntensity > 1e-3;

    // Park the sun on a sphere around the model so its ortho frustum covers it.
    const dist = this.radius * 2.5;
    this.sun.position.copy(this.center).addScaledVector(s.sunDir, dist);
    this.sun.target.position.copy(this.center);
    this.sun.target.updateMatrixWorld();

    this.hemi.color.copy(s.skyColor);
    this.hemi.groundColor.copy(s.groundColor);
    this.hemi.intensity = s.hemiIntensity;

    this.ambient.color.copy(s.ambientColor);
    this.ambient.intensity = this.ambientIntensity * s.ambientScale;

    const scene = this.ctx?.scene;
    if (scene && this.ownsEnvironment) scene.environmentIntensity = s.envIntensity;

    // Below the horizon there is nothing worth shadowing and the frustum is
    // degenerate, so drop the sun's shadow entirely at night.
    const wantShadow = this.shadowsEnabled && SUN_SHADOW_SIZE[this.tier] > 0 && s.sunIntensity > 0.3;
    if (this.sun.castShadow !== wantShadow) {
      this.sun.castShadow = wantShadow;
      this.sun.shadow.needsUpdate = true;
    }
  }

  private applyShadowQuality(): void {
    const size = SUN_SHADOW_SIZE[this.tier];
    const shadow = this.sun.shadow;
    if (size > 0 && shadow.mapSize.width !== size) {
      shadow.mapSize.set(size, size);
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
      shadow.needsUpdate = true;
    }
    if (size === 0 || !this.shadowsEnabled) {
      this.sun.castShadow = false;
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
    }
    this.applyShadowFrustum();
    this.applyState();
  }

  private applyShadowFrustum(): void {
    const cam = this.sun.shadow.camera;
    const r = this.radius * 1.15;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = this.radius * 2.5 + this.radius * 1.5;
    cam.updateProjectionMatrix();
  }

  /**
   * A PMREM of the stock RoomEnvironment. It costs one prefilter pass at start
   * and gives MeshStandardMaterial believable indoor reflections — without it
   * an unlit interior reads as flat plastic. It is *not* daylight-dependent, so
   * it is generated once and only its weight (scene.environmentIntensity) is
   * graded by the sky.
   */
  private buildEnvironment(): void {
    const ctx = this.ctx;
    if (!ctx || this.envTarget) return;
    // Respect a map another subsystem already installed.
    if (ctx.scene.environment) return;
    let room: RoomEnvironment | null = null;
    try {
      this.pmrem = new PMREMGenerator(ctx.renderer);
      this.pmrem.compileEquirectangularShader();
      room = new RoomEnvironment();
      this.envTarget = this.pmrem.fromScene(room, 0.04);
      ctx.scene.environment = this.envTarget.texture;
      ctx.scene.environmentIntensity = this.current.envIntensity;
      this.ownsEnvironment = true;
    } catch (err) {
      console.warn('[floorplan-3d] environment map unavailable', err);
      this.disposeEnvironment();
    } finally {
      room?.dispose();
      // The generator's own targets are only needed during prefiltering.
      this.pmrem?.dispose();
      this.pmrem = null;
    }
  }

  private disposeEnvironment(): void {
    const scene = this.ctx?.scene;
    if (scene && this.ownsEnvironment) {
      scene.environment = null;
      scene.environmentIntensity = 1;
    }
    this.ownsEnvironment = false;
    this.envTarget?.dispose();
    this.envTarget = null;
    this.pmrem?.dispose();
    this.pmrem = null;
  }

  /* ------------------------------------------------------------- reads */

  get sunLight(): THREE.DirectionalLight {
    return this.sun;
  }

  get isNight(): boolean {
    return this.enabled && this.elevation < 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeEnvironment();
    this.sun.castShadow = false;
    this.sun.shadow.dispose();
    this.sun.dispose();
    this.hemi.dispose();
    this.ambient.dispose();
    this.group.parent?.remove(this.group);
    this.ctx = null;
  }
}

const scratchSphere = new THREE.Sphere();

function copyState(dst: SkyState, src: SkyState): void {
  dst.sunColor.copy(src.sunColor);
  dst.skyColor.copy(src.skyColor);
  dst.groundColor.copy(src.groundColor);
  dst.ambientColor.copy(src.ambientColor);
  dst.sunIntensity = src.sunIntensity;
  dst.hemiIntensity = src.hemiIntensity;
  dst.ambientScale = src.ambientScale;
  dst.envIntensity = src.envIntensity;
  dst.sunDir.copy(src.sunDir);
}
