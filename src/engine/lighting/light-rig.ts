/**
 * One rig per placed light entity: the three.js light, an optional visible
 * luminaire, and the tweening that makes a Home Assistant state change look
 * like a lamp turning on rather than a boolean flipping.
 *
 * ── Units and the exposure anchor ──────────────────────────────────────────
 * three.js r155+ is physically based: `PointLight.intensity` is candela and
 * illuminance falls off as I / d² (decay = 2). The renderer then shades a
 * Lambertian surface as L = albedo / π · E, and ACES filmic tone mapping maps
 * L ≈ 0.7 to roughly 84 % sRGB — a convincingly lit, not blown-out, wall.
 *
 * Working backwards for a ceiling lamp 2.5 m above the floor of a 4 × 4 m room
 * with a typical albedo of 0.6:
 *
 *     L = 0.7  →  E = L·π/albedo ≈ 3.7  →  I = E·d² ≈ 3.7 · 6.25 ≈ 23 cd
 *
 * 23 cd is the *floor* of believable. We want the pool under the lamp to read
 * as properly lit while the corners (3.8 m away, grazing incidence) fall off,
 * so the base sits a little above that — and conveniently lands on a real bulb:
 * a 500 lm warm-white LED (the 40 W-equivalent nearly everyone has) radiating
 * isotropically is 500 / 4π ≈ 40 cd. That is {@link POINT_BASE_CANDELA}, and it
 * is the anchor every other number here is expressed against.
 *
 * The same 500 lm squeezed into a 90° downlight beam would physically be
 * 500 / (2π(1 − cos45°)) ≈ 272 cd, which blows straight through the top of the
 * tone curve at room distances. Spots are therefore tempered to 110 cd: bright
 * enough to read as a directional downlight, inside the exposure anchor above.
 */

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { BLOOM_LAYER } from '@/engine/contracts';
import type { LightSample, QualityTier } from '@/engine/contracts';
import type { LightKind, LightVisualConfig, Vec3 } from '@/types/config';
import { clamp01, parseCssColor, rgb255ToLinear } from '@/util/color';
import { clamp, degToRad, easeInOutCubic, easeOutCubic } from '@/util/math';
import type { ShadowCandidate } from '@/engine/lighting/shadow-budget';

/* ------------------------------------------------------------- constants */

/** 500 lm omnidirectional bulb: 500 / 4π ≈ 40 cd. See the file header. */
export const POINT_BASE_CANDELA = 40;
/** Physically ≈ 272 cd for the same flux in a 90° cone; tempered for exposure. */
export const SPOT_BASE_CANDELA = 110;
/**
 * RectAreaLight intensity is luminance in nits (cd/m²) and a Lambertian
 * emitter's axial intensity is L · A, so we derive nits from the same 40 cd
 * budget divided by the panel area. A 0.5 × 0.5 m panel becomes 160 nits, which
 * delivers exactly the same 6.4 lux at 2.5 m as the point light does.
 */
export const RECT_BASE_CANDELA = 40;

/**
 * Perceptual dimming. Human brightness perception is roughly a power law, and
 * real mains/LED dimmers follow the same curve, so HA's linear 0..255 slider is
 * mapped with an exponent of 2.2: half slider ≈ 22 % of the light output, which
 * is what "half brightness" actually looks like.
 */
const BRIGHTNESS_EXPONENT = 2.2;
/**
 * …but never all the way to nothing. A bulb at 1 % still visibly glows, and
 * 0.01^2.2 ≈ 4e-5 would be pure black, so the curve is remapped into
 * [DIM_FLOOR, 1].
 */
const DIM_FLOOR = 0.02;

/**
 * The luminaire's own emissive level. The eye adapts to a small bright emitter,
 * so a dimmed bulb's *surface* barely darkens even though its flux collapses —
 * hence a much flatter curve than the light itself, and a floor that stays above
 * the default bloom threshold (0.72) so an on lamp always glows.
 */
const FIXTURE_EMISSIVE_MIN = 0.9;
const FIXTURE_EMISSIVE_MAX = 3.4;
const FIXTURE_EMISSIVE_EXPONENT = 0.85;

/** Default falloff radius. 0 (infinite) leaks a bedside lamp through the whole
 *  house; 8 m keeps a light inside its room and the neighbouring hallway. */
const DEFAULT_DISTANCE_M = 8;
const DEFAULT_DECAY = 2;

/**
 * Room fill at brightness 0. A lamp dimmed to 1 % still reads as on in the
 * plan, which is the whole job of this mode.
 */
const FILL_MIN = 0.18;
const DEFAULT_SPOT_ANGLE_DEG = 45;
const DEFAULT_SPOT_PENUMBRA = 0.4;
const DEFAULT_FIXTURE_RADIUS_M = 0.06;

/** Turning on eases out over a quarter second; turning off is snappier. */
const FADE_IN_S = 0.26;
const FADE_OUT_S = 0.18;
/** Shadow hand-off fade when a light loses its budget slot. */
const SHADOW_FADE_S = 0.35;

/**
 * Shadow map edge per quality tier. A point light spends this six times over
 * (cube map), which is why `low` has no real-time shadows at all.
 */
const SHADOW_MAP_SIZE: Readonly<Record<QualityTier, number>> = {
  low: 0,
  medium: 512,
  high: 1024,
};

/**
 * Depth bias. At 1024² covering a 90° face at 4 m, one texel is ≈ 8 mm, so a
 * 2 cm normalBias pushes the sample two to three texels off the surface — enough
 * to kill acne on the large flat walls that dominate a floorplan without the
 * peter-panning a large constant `bias` would cause. `bias` itself stays tiny
 * and negative purely to clean up grazing-angle shimmer on the floor.
 */
const SHADOW_BIAS = -0.0004;
const SHADOW_NORMAL_BIAS = 0.02;
/** Clears the luminaire shell (6 cm) without wasting depth precision. */
const SHADOW_NEAR_M = 0.15;

/* ------------------------------------------------------------- utilities */

type ShadowedLight = THREE.PointLight | THREE.SpotLight;
type RigLight = THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight;

let rectUniformsReady = false;

function ensureRectUniforms(): void {
  if (rectUniformsReady) return;
  RectAreaLightUniformsLib.init();
  rectUniformsReady = true;
}

/** HA brightness 0..1 → output fraction 0..1, perceptually mapped. */
export function brightnessToOutput(brightness: number): number {
  const b = clamp01(brightness);
  return DIM_FLOOR + (1 - DIM_FLOOR) * Math.pow(b, BRIGHTNESS_EXPONENT);
}

/** Mutable twin of {@link ShadowCandidate}; reused, never allocated per frame. */
interface MutableCandidate {
  id: string;
  on: boolean;
  culled: boolean;
  wantsShadow: boolean;
  intensity: number;
  worldPosition: THREE.Vector3;
}

export interface LightRigOptions {
  entityId: string;
  position: Vec3;
  level?: string | null;
  config?: LightVisualConfig;
  quality?: QualityTier;
  /** Section planes; the luminaire clips with the model it lives in. */
  clippingPlanes?: THREE.Plane[];
}

/* ------------------------------------------------------------------ rig */

export class LightRig {
  readonly entityId: string;
  /** Parent for the light, its target and the luminaire. Add this to a scene. */
  readonly group: THREE.Group;

  private kind: LightKind = 'point';
  private config: LightVisualConfig;
  private levelId: string | null;
  private tier: QualityTier;
  private clippingPlanes: THREE.Plane[] | null;

  private light: RigLight | null = null;
  private shadowLight: ShadowedLight | null = null;
  private target: THREE.Object3D | null = null;

  private fixture: THREE.Mesh | null = null;
  private fixtureGeometry: THREE.BufferGeometry | null = null;
  private fixtureMaterial: THREE.MeshStandardMaterial | null = null;

  /* state ---------------------------------------------------------------- */

  private on = false;
  private brightness = 0;
  private unavailable = false;
  private effect: string | undefined;

  private targetIntensityValue = 0;
  private currentIntensity = 0;
  private fromIntensity = 0;
  private targetEmissive = 0;
  private currentEmissive = 0;
  private fromEmissive = 0;
  /** 0..1 room-fill weight, tweened alongside the rest. */
  private targetFill = 0;
  private currentFill = 0;
  private fromFill = 0;
  /** Set by the lighting system in room-fill mode. See `build`. */
  private emissiveOnly = false;

  private readonly targetColor = new THREE.Color(1, 1, 1);
  private readonly currentColor = new THREE.Color(1, 1, 1);
  private readonly fromColor = new THREE.Color(1, 1, 1);
  /** Last linear RGB reported by the state mapper. */
  private readonly sampleColor: [number, number, number] = [1, 1, 1];

  private tweenElapsed = 0;
  private tweenDuration = 0;
  private tweenEaseOut = true;

  private effectPhase = 0;
  private effectMode: 'none' | 'flicker' | 'pulse' = 'none';

  private shadowsEnabled = true;
  private shadowGranted = false;
  private shadowFade = 0;
  private shadowFadeTarget = 0;

  private culledByLevel = false;
  private culledByClip = false;
  private culledByBudget = false;

  private disposed = false;

  private readonly candidate: MutableCandidate;

  constructor(options: LightRigOptions) {
    this.entityId = options.entityId;
    this.config = options.config ?? {};
    this.levelId = options.level ?? null;
    this.tier = options.quality ?? 'high';
    this.clippingPlanes = options.clippingPlanes ?? null;

    this.group = new THREE.Group();
    this.group.name = `light:${options.entityId}`;
    this.group.position.set(options.position[0], options.position[1], options.position[2]);

    this.candidate = {
      id: this.entityId,
      on: false,
      culled: false,
      wantsShadow: false,
      intensity: 0,
      worldPosition: this.group.position,
    };

    this.build();
  }

  /* ------------------------------------------------------------ geometry */

  private build(): void {
    // Room fill lights the whole room from the shader, so a real light here
    // would only add back the hotspot the mode exists to remove. The luminaire
    // still glows: that is what shows *which* lamp is on.
    this.kind = this.emissiveOnly ? 'emissive' : (this.config.kind ?? 'point');
    const distance = this.resolveDistance();
    const decay = this.config.decay ?? DEFAULT_DECAY;

    if (this.kind === 'spot') {
      const spot = new THREE.SpotLight(0xffffff, 0, distance, 0, 0, decay);
      spot.angle = degToRad(clamp(this.config.angle ?? DEFAULT_SPOT_ANGLE_DEG, 1, 89));
      spot.penumbra = clamp01(this.config.penumbra ?? DEFAULT_SPOT_PENUMBRA);
      this.light = spot;
      this.shadowLight = spot;
    } else if (this.kind === 'rect') {
      ensureRectUniforms();
      const [w, h] = this.resolveRectSize();
      const rect = new THREE.RectAreaLight(0xffffff, 0, w, h);
      this.light = rect;
      this.shadowLight = null; // RectAreaLight cannot cast shadows in three.js.
    } else if (this.kind === 'point') {
      const point = new THREE.PointLight(0xffffff, 0, distance, decay);
      this.light = point;
      this.shadowLight = point;
    } else {
      // 'emissive': a glowing luminaire with no light source at all. Free, and
      // the right choice for decorative strips that should not cost a shader
      // slot.
      this.light = null;
      this.shadowLight = null;
    }

    if (this.light) {
      this.light.intensity = 0;
      this.light.visible = false;
      this.group.add(this.light);
    }

    // Spot and rect need something to aim at. A SpotLight whose target is not
    // in the scene graph keeps its identity matrix and points at world origin.
    if (this.kind === 'spot' || this.kind === 'rect') {
      const target = new THREE.Object3D();
      target.name = `light-target:${this.entityId}`;
      const off = this.config.targetOffset ?? [0, -1, 0];
      target.position.set(off[0], off[1], off[2]);
      this.target = target;
      this.group.add(target);
      if (this.light instanceof THREE.SpotLight) this.light.target = target;
    }

    this.buildFixture();
    this.configureShadow();
    this.aim();
  }

  private buildFixture(): void {
    // Room fill already says which room is on, and the marker chip says which
    // entity. A glowing blob with a bloom halo on top of both is a third answer
    // to a question nobody asked twice.
    const show = this.emissiveOnly ? this.config.fixture?.show === true : this.config.fixture?.show ?? true;
    if (!show) return;

    const radius = Math.max(0.005, this.config.fixture?.radius ?? DEFAULT_FIXTURE_RADIUS_M);

    let geometry: THREE.BufferGeometry;
    if (this.kind === 'rect') {
      const [w, h] = this.resolveRectSize();
      geometry = new THREE.PlaneGeometry(w, h);
    } else if (this.kind === 'spot') {
      geometry = new THREE.CircleGeometry(radius * 1.6, 24);
    } else {
      geometry = new THREE.SphereGeometry(radius, 16, 12);
    }

    const material = new THREE.MeshStandardMaterial({
      // Mid grey so an off lamp still reads as a fixture; the emissive term does
      // all the work once it is on.
      color: 0x555555,
      roughness: 0.35,
      metalness: 0,
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 0,
      side: this.kind === 'rect' || this.kind === 'spot' ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (this.clippingPlanes) material.clippingPlanes = this.clippingPlanes;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `luminaire:${this.entityId}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = true;
    // Never a raycast target — the entity layer owns picking.
    mesh.raycast = () => undefined;

    this.fixture = mesh;
    this.fixtureGeometry = geometry;
    this.fixtureMaterial = material;
    this.group.add(mesh);
  }

  /** Points the spot/rect light and the disc luminaire down the target vector. */
  private aim(): void {
    if (!this.target) return;
    const t = this.target.position;
    if (this.light instanceof THREE.RectAreaLight) {
      this.light.lookAt(
        this.group.position.x + t.x,
        this.group.position.y + t.y,
        this.group.position.z + t.z,
      );
    }
    if (this.fixture && (this.kind === 'rect' || this.kind === 'spot')) {
      this.fixture.lookAt(
        this.group.position.x + t.x,
        this.group.position.y + t.y,
        this.group.position.z + t.z,
      );
    }
  }

  private configureShadow(): void {
    const light = this.shadowLight;
    if (!light) return;
    const size = SHADOW_MAP_SIZE[this.tier];
    const shadow = light.shadow;
    if (size > 0 && shadow.mapSize.width !== size) {
      shadow.mapSize.set(size, size);
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
      shadow.needsUpdate = true;
    }
    shadow.bias = SHADOW_BIAS;
    shadow.normalBias = SHADOW_NORMAL_BIAS;
    shadow.camera.near = SHADOW_NEAR_M;
    // Fit the far plane to the actual reach of the light so the depth range is
    // not wasted on empty space behind the walls.
    shadow.camera.far = Math.max(1, this.resolveDistance() || DEFAULT_DISTANCE_M);
    shadow.camera.updateProjectionMatrix();
  }

  private resolveDistance(): number {
    const d = this.config.distance;
    if (d === undefined) return DEFAULT_DISTANCE_M;
    // An explicit 0 means "infinite" per the config schema; honour it.
    return d <= 0 ? 0 : d;
  }

  private resolveRectSize(): [number, number] {
    const size = this.config.size;
    const w = size && size[0] > 0 ? size[0] : 0.5;
    const h = size && size[1] > 0 ? size[1] : 0.5;
    return [w, h];
  }

  /* -------------------------------------------------------------- config */

  /** Swap in a new visual config; rebuilds only when the light kind changed. */
  applyConfig(config: LightVisualConfig | undefined): void {
    const next = config ?? {};
    const kindChanged = (next.kind ?? 'point') !== (this.config.kind ?? 'point');
    const sizeChanged =
      this.kind === 'rect' &&
      (next.size?.[0] !== this.config.size?.[0] || next.size?.[1] !== this.config.size?.[1]);
    const fixtureChanged =
      (next.fixture?.show ?? true) !== (this.config.fixture?.show ?? true) ||
      next.fixture?.radius !== this.config.fixture?.radius;

    this.config = next;

    if (kindChanged || sizeChanged || fixtureChanged) {
      this.rebuild();
      return;
    }

    if (this.light instanceof THREE.SpotLight) {
      this.light.angle = degToRad(clamp(next.angle ?? DEFAULT_SPOT_ANGLE_DEG, 1, 89));
      this.light.penumbra = clamp01(next.penumbra ?? DEFAULT_SPOT_PENUMBRA);
    }
    if (this.light instanceof THREE.PointLight || this.light instanceof THREE.SpotLight) {
      this.light.distance = this.resolveDistance();
      this.light.decay = next.decay ?? DEFAULT_DECAY;
    }
    if (this.target) {
      const off = next.targetOffset ?? [0, -1, 0];
      this.target.position.set(off[0], off[1], off[2]);
      this.aim();
    }
    this.configureShadow();
    this.recomputeTargets(false);
  }

  /** Rebuilt objects start dark, so the state mapping is re-run without a tween. */
  private rebuild(): void {
    this.teardownObjects();
    this.build();
    this.recomputeTargets(true);
  }

  setLevel(levelId: string | null): void {
    this.levelId = levelId;
  }

  setQuality(tier: QualityTier): void {
    if (this.tier === tier) return;
    this.tier = tier;
    this.configureShadow();
  }

  setPosition(position: Vec3): void {
    this.group.position.set(position[0], position[1], position[2]);
    this.aim();
  }

  /* --------------------------------------------------------------- state */

  /**
   * Push a normalised HA sample. Cheap enough to call for every entity on every
   * `hass` update: it only touches numbers, the GPU work happens in `update`.
   * Returns true when something actually changed.
   */
  setSample(sample: LightSample): boolean {
    const on = sample.on && !sample.unavailable;
    const brightness = clamp01(sample.brightness);
    const effect = sample.effect;
    const changed =
      on !== this.on ||
      Math.abs(brightness - this.brightness) > 1e-3 ||
      effect !== this.effect ||
      sample.unavailable !== this.unavailable ||
      !this.sampleColorMatches(sample.color);

    this.on = on;
    this.brightness = brightness;
    this.unavailable = sample.unavailable;
    this.effect = effect;
    this.effectMode = classifyEffect(on ? effect : undefined);
    this.sampleColor[0] = sample.color[0];
    this.sampleColor[1] = sample.color[1];
    this.sampleColor[2] = sample.color[2];

    if (changed) this.recomputeTargets(false);
    return changed;
  }

  private sampleColorMatches(color: readonly number[]): boolean {
    return (
      Math.abs(this.sampleColor[0] - (color[0] ?? 1)) < 1e-3 &&
      Math.abs(this.sampleColor[1] - (color[1] ?? 1)) < 1e-3 &&
      Math.abs(this.sampleColor[2] - (color[2] ?? 1)) < 1e-3
    );
  }

  /** Recompute tween targets from the current sample + config. */
  private recomputeTargets(immediate: boolean): void {
    const output = this.on ? brightnessToOutput(this.brightness) : 0;
    const multiplier = this.config.intensity ?? 1;

    let base: number;
    if (this.kind === 'spot') base = SPOT_BASE_CANDELA;
    else if (this.kind === 'rect') {
      const [w, h] = this.resolveRectSize();
      // nits = cd / m² — keeps a panel's illuminance equal to the point anchor.
      base = RECT_BASE_CANDELA / Math.max(0.01, w * h);
    } else base = POINT_BASE_CANDELA;

    this.targetIntensityValue = this.light ? base * output * multiplier : 0;
    // Deliberately not `output`: that curve is tuned for candela falloff, where
    // a dimmed lamp still has to reach the far wall. A filled room is a flat
    // tint, so it tracks the dimmer directly, off a floor that keeps a lamp at
    // 1 % readable as on.
    this.targetFill = this.on ? FILL_MIN + (1 - FILL_MIN) * clamp01(this.brightness) : 0;

    const bloomWeight = this.config.bloom ?? 1;
    const fixtureScale = this.config.fixture?.emissive ?? 1;
    this.targetEmissive = this.on
      ? (FIXTURE_EMISSIVE_MIN +
          (FIXTURE_EMISSIVE_MAX - FIXTURE_EMISSIVE_MIN) *
            Math.pow(clamp01(this.brightness), FIXTURE_EMISSIVE_EXPONENT)) *
        fixtureScale *
        bloomWeight
      : 0;

    this.resolveColorInto(this.targetColor);

    if (immediate) {
      this.currentIntensity = this.targetIntensityValue;
      this.currentEmissive = this.targetEmissive;
      this.currentFill = this.targetFill;
      this.currentColor.copy(this.targetColor);
      this.tweenElapsed = 0;
      this.tweenDuration = 0;
      this.applyToObjects();
    } else {
      this.fromIntensity = this.currentIntensity;
      this.fromEmissive = this.currentEmissive;
      this.fromFill = this.currentFill;
      this.fromColor.copy(this.currentColor);
      this.tweenElapsed = 0;
      // Coming up eases out (fast attack, soft landing); going down is quicker
      // and symmetric, which is what a real dimmer ramp looks like.
      this.tweenEaseOut = this.on;
      this.tweenDuration = this.on ? FADE_IN_S : FADE_OUT_S;
    }

    this.candidate.on = this.on;
    this.candidate.intensity = this.targetIntensityValue;
    this.candidate.wantsShadow = this.canCastShadow();
  }

  /**
   * Entity colour wins unless `useEntityColor` is explicitly false, in which
   * case the static config colour is authoritative. The config colour also acts
   * as the fallback while the entity is unavailable.
   */
  private resolveColorInto(out: THREE.Color): void {
    const override = this.config.color ? parseCssColor(this.config.color) : null;
    const useEntity = this.config.useEntityColor !== false;
    if (override && (!useEntity || this.unavailable)) {
      const lin = rgb255ToLinear(override);
      out.setRGB(lin[0], lin[1], lin[2], THREE.LinearSRGBColorSpace);
      return;
    }
    // LightSample.color is already linear; the mapper has resolved kelvin/hs.
    out.setRGB(
      clamp01(this.sampleColor[0]),
      clamp01(this.sampleColor[1]),
      clamp01(this.sampleColor[2]),
      THREE.LinearSRGBColorSpace,
    );
  }

  /* ------------------------------------------------------------- culling */

  setCulledByLevel(culled: boolean): void {
    this.culledByLevel = culled;
    this.candidate.culled = this.isCulled();
  }

  setCulledByClip(culled: boolean): void {
    this.culledByClip = culled;
    this.candidate.culled = this.isCulled();
  }

  setCulledByBudget(culled: boolean): void {
    this.culledByBudget = culled;
  }

  /** Level/clip culling only — the budget cull is applied separately. */
  private isCulled(): boolean {
    return this.culledByLevel || this.culledByClip;
  }

  /* ------------------------------------------------------------- shadows */

  setShadowsEnabled(enabled: boolean): void {
    this.shadowsEnabled = enabled;
    this.candidate.wantsShadow = this.canCastShadow();
    if (!enabled) this.shadowFadeTarget = 0;
  }

  /** The budget grants or revokes this rig's shadow slot. */
  setShadowGranted(granted: boolean): void {
    const want = granted && this.canCastShadow();
    if (want === this.shadowGranted) return;
    this.shadowGranted = want;
    this.shadowFadeTarget = want ? 1 : 0;
    if (want && this.shadowLight) {
      this.shadowLight.castShadow = true;
      this.shadowLight.shadow.needsUpdate = true;
    }
  }

  private canCastShadow(): boolean {
    if (!this.shadowsEnabled) return false;
    if (!this.shadowLight) return false;
    if (SHADOW_MAP_SIZE[this.tier] === 0) return false;
    return this.config.castShadow !== false;
  }

  /* -------------------------------------------------------------- update */

  /** Advance tweens. Returns true while the rig still needs frames. */
  update(dt: number): boolean {
    if (this.disposed) return false;
    let animating = false;

    if (this.tweenDuration > 0) {
      this.tweenElapsed += dt;
      const raw = clamp01(this.tweenElapsed / this.tweenDuration);
      const t = this.tweenEaseOut ? easeOutCubic(raw) : easeInOutCubic(raw);
      this.currentIntensity = this.fromIntensity + (this.targetIntensityValue - this.fromIntensity) * t;
      this.currentEmissive = this.fromEmissive + (this.targetEmissive - this.fromEmissive) * t;
      this.currentFill = this.fromFill + (this.targetFill - this.fromFill) * t;
      this.currentColor.copy(this.fromColor).lerp(this.targetColor, t);
      if (raw >= 1) {
        this.tweenDuration = 0;
        this.currentIntensity = this.targetIntensityValue;
        this.currentEmissive = this.targetEmissive;
        this.currentFill = this.targetFill;
        this.currentColor.copy(this.targetColor);
      } else {
        animating = true;
      }
    }

    if (this.effectMode !== 'none' && this.on) {
      this.effectPhase += dt;
      animating = true;
    }

    if (this.shadowFade !== this.shadowFadeTarget) {
      const step = dt / SHADOW_FADE_S;
      this.shadowFade =
        this.shadowFadeTarget > this.shadowFade
          ? Math.min(this.shadowFadeTarget, this.shadowFade + step)
          : Math.max(this.shadowFadeTarget, this.shadowFade - step);
      animating = true;
    }

    this.applyToObjects();
    return animating;
  }

  /** Multiplier for `effect` driven animation; 1 when the entity has none. */
  private effectMultiplier(): number {
    if (this.effectMode === 'none' || !this.on) return 1;
    if (this.effectMode === 'pulse') {
      // 0.55 s cycle, ±25 %: a slow breathe, not a strobe.
      return 1 + 0.25 * Math.sin(this.effectPhase * 2.0);
    }
    // Candle flicker: two incommensurate sines read as irregular without a PRNG
    // and without allocating.
    const f =
      0.72 +
      0.18 * Math.sin(this.effectPhase * 11.3) +
      0.1 * Math.sin(this.effectPhase * 27.1 + 1.7);
    return clamp(f, 0.45, 1.15);
  }

  private applyToObjects(): void {
    const mul = this.effectMultiplier();
    const budgetOff = this.culledByBudget;
    const culled = this.isCulled();

    if (this.light) {
      const intensity = this.currentIntensity * mul;
      const visible = !culled && !budgetOff && intensity > 1e-4;
      this.light.visible = visible;
      if (visible) {
        this.light.intensity = intensity;
        this.light.color.copy(this.currentColor);
      }
      if (this.shadowLight) {
        // Stay a caster until the fade has actually reached zero: revoking the
        // slot only moves the target, so a lost slot dissolves instead of
        // popping. shadow.intensity is r165+.
        const shadowOn = visible && this.shadowFade > 0.001;
        this.shadowLight.shadow.intensity = this.shadowFade;
        if (this.shadowLight.castShadow !== shadowOn) {
          this.shadowLight.castShadow = shadowOn;
          this.shadowLight.shadow.needsUpdate = true;
        }
      }
    }

    const fixture = this.fixture;
    const material = this.fixtureMaterial;
    if (fixture && material) {
      fixture.visible = !culled;
      const emissive = this.currentEmissive * mul;
      material.emissiveIntensity = emissive;
      if (emissive > 0.001) {
        material.emissive.copy(this.currentColor);
        if (!fixture.layers.isEnabled(BLOOM_LAYER)) fixture.layers.enable(BLOOM_LAYER);
      } else {
        material.emissive.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
        if (fixture.layers.isEnabled(BLOOM_LAYER)) fixture.layers.disable(BLOOM_LAYER);
      }
    }
  }

  /* --------------------------------------------------------------- reads */

  getCandidate(): ShadowCandidate {
    this.candidate.on = this.on;
    this.candidate.culled = this.isCulled();
    this.candidate.intensity = this.targetIntensityValue;
    this.candidate.wantsShadow = this.canCastShadow();
    return this.candidate;
  }

  /** Emissive-only rigs cost no shader slot, so they skip the maxLights cap. */
  get countsAgainstBudget(): boolean {
    return this.light !== null;
  }

  get level(): string | null {
    return this.levelId;
  }

  get worldPosition(): THREE.Vector3 {
    return this.group.position;
  }

  get isOn(): boolean {
    return this.on;
  }

  get lightKind(): LightKind {
    return this.kind;
  }

  get intensity(): number {
    return this.currentIntensity;
  }

  /**
   * How strongly this lamp fills its room, 0..1. Culling is included: a lamp on
   * a hidden storey, or one cut away by a section plane, must not keep lighting
   * a room that is still on screen.
   */
  get fillWeight(): number {
    if (this.culledByLevel || this.culledByClip) return 0;
    return this.currentFill * this.effectMultiplier();
  }

  /** Tweened light colour, linear RGB. Shared reference — do not mutate. */
  get fillColor(): THREE.Color {
    return this.currentColor;
  }

  /** Suppress the real light source and keep only the glowing luminaire. */
  setEmissiveOnly(value: boolean): void {
    if (this.emissiveOnly === value) return;
    this.emissiveOnly = value;
    this.rebuild();
  }

  /* ------------------------------------------------------------- dispose */

  private teardownObjects(): void {
    if (this.shadowLight) {
      this.shadowLight.castShadow = false;
      this.shadowLight.shadow.dispose();
    }
    if (this.light) {
      this.light.parent?.remove(this.light);
      this.light.dispose();
      this.light = null;
    }
    this.shadowLight = null;
    if (this.target) {
      this.target.parent?.remove(this.target);
      this.target = null;
    }
    if (this.fixture) {
      this.fixture.parent?.remove(this.fixture);
      this.fixture = null;
    }
    this.fixtureGeometry?.dispose();
    this.fixtureGeometry = null;
    this.fixtureMaterial?.dispose();
    this.fixtureMaterial = null;
    this.shadowGranted = false;
    this.shadowFade = 0;
    this.shadowFadeTarget = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownObjects();
    this.group.parent?.remove(this.group);
  }
}

function classifyEffect(effect: string | undefined): 'none' | 'flicker' | 'pulse' {
  if (!effect) return 'none';
  const e = effect.toLowerCase();
  if (e.includes('flicker') || e.includes('candle') || e.includes('fire')) return 'flicker';
  if (e.includes('pulse') || e.includes('breath')) return 'pulse';
  return 'none';
}
