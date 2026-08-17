/**
 * Active-light budgeting.
 *
 * WebGL builds one shader per light count, and every additional live light
 * costs a uniform slot and a per-fragment loop iteration. A house with twenty
 * lamps switched on would recompile its way to a standstill, so only the ones
 * that matter are kept live: brightest first, weighted by distance from the
 * camera, with a bonus for whoever already had the slot so a lamp does not
 * flicker in and out as the view drifts.
 *
 * Pure bookkeeping — it takes candidate records and hands back an id set.
 * `LightingSystem` owns the rigs and applies the verdict.
 */

import type * as THREE from 'three';
import type { QualityTier } from '@/engine/contracts';

/** What the budget needs to know about one light to rank it. */
export interface LightCandidate {
  readonly id: string;
  /** Target state, not the tweened one — a light fading in already counts. */
  readonly on: boolean;
  /** Hidden level, outside the section clip, or explicitly disabled. */
  readonly culled: boolean;
  /** Target candela; used as the "visual importance" weight. */
  readonly intensity: number;
  readonly worldPosition: THREE.Vector3;
}

export interface BudgetGrants {
  /** Ids allowed to contribute light at all (maxLights cap applied). */
  readonly active: ReadonlySet<string>;
}

/**
 * Cap on lights contributing to the shading at all. three.js recompiles every
 * material when the light count changes and cost is linear per fragment, so
 * these are generous but finite. A house with more lit lamps than this simply
 * renders the most important ones.
 */
const LIGHT_CAPS: Readonly<Record<QualityTier, number>> = {
  low: 6,
  medium: 16,
  high: 32,
};

/**
 * Distance at which a light's importance has halved. 12 m ≈ "the next room
 * over": beyond that a lamp is usually behind a wall and contributes nothing
 * you can see, so it should lose its slot to something closer.
 */
const IMPORTANCE_FALLOFF_M = 12;
const IMPORTANCE_FALLOFF_SQ = IMPORTANCE_FALLOFF_M * IMPORTANCE_FALLOFF_M;

/**
 * Incumbents get a 30 % score bonus. Without hysteresis two lights of similar
 * score swap slots every time the camera drifts, and each swap is a visible
 * pop plus a shader recompile.
 */
const INCUMBENT_BONUS = 1.3;

/** Camera-driven re-evaluation throttle. */
const CAMERA_THROTTLE_MS = 500;
/** Ignore camera jitter below half a metre. */
const CAMERA_MOVE_EPS_SQ = 0.5 * 0.5;

interface ScoredCandidate {
  id: string;
  score: number;
}

export class LightBudget {
  private tier: QualityTier = 'high';
  private enabled = true;
  private maxLightsOverride: number | null = null;

  private grantedActive: Set<string> = new Set();

  private dirty = true;
  private lastEvalMs = 0;
  private lastCameraX = Number.NaN;
  private lastCameraY = Number.NaN;
  private lastCameraZ = Number.NaN;

  /** Reused across evaluations — this runs on every HA light update. */
  private readonly scratch: ScoredCandidate[] = [];

  setQuality(tier: QualityTier): void {
    if (this.tier === tier) return;
    this.tier = tier;
    this.dirty = true;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.dirty = true;
  }

  /** Explicit slot count; pass null to go back to the per-tier default. */
  /** Explicit active-light cap; pass null for the per-tier default. */
  setMaxLights(max: number | null): void {
    this.maxLightsOverride = max === null ? null : Math.max(1, Math.floor(max));
    this.dirty = true;
  }

  get maxLights(): number {
    return this.maxLightsOverride ?? LIGHT_CAPS[this.tier];
  }

  /** A light changed state, was added or removed: re-rank at the next frame. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Cheap per-frame gate. Returns true when the caller should build the
   * candidate list and call {@link evaluate}.
   */
  shouldEvaluate(nowMs: number, cameraPosition: THREE.Vector3): boolean {
    if (this.dirty) return true;
    const dx = cameraPosition.x - this.lastCameraX;
    const dy = cameraPosition.y - this.lastCameraY;
    const dz = cameraPosition.z - this.lastCameraZ;
    const moved = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(moved)) return true;
    if (moved < CAMERA_MOVE_EPS_SQ) return false;
    return nowMs - this.lastEvalMs >= CAMERA_THROTTLE_MS;
  }

  /**
   * Rank the candidates and hand out slots. The returned sets are owned by the
   * budget and are replaced (not mutated) on the next call, so callers may hold
   * them for the duration of a frame but must not store them.
   */
  evaluate(candidates: readonly LightCandidate[], cameraPosition: THREE.Vector3): BudgetGrants {
    this.dirty = false;
    this.lastEvalMs = nowMillis();
    this.lastCameraX = cameraPosition.x;
    this.lastCameraY = cameraPosition.y;
    this.lastCameraZ = cameraPosition.z;

    const scored = this.scratch;
    scored.length = 0;

    for (const c of candidates) {
      if (c.culled || !c.on || c.intensity <= 1e-3) continue;
      const dx = c.worldPosition.x - cameraPosition.x;
      const dy = c.worldPosition.y - cameraPosition.y;
      const dz = c.worldPosition.z - cameraPosition.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      let score = c.intensity / (1 + distSq / IMPORTANCE_FALLOFF_SQ);
      if (this.grantedActive.has(c.id)) score *= INCUMBENT_BONUS;
      scored.push({ id: c.id, score });
    }

    scored.sort(byScoreDesc);

    const active = new Set<string>();
    const maxLights = this.maxLights;
    for (let i = 0; i < scored.length && active.size < maxLights; i += 1) {
      active.add(scored[i].id);
    }

    this.grantedActive = active;
    scored.length = 0;
    return { active };
  }

  /** Last verdict, for callers that need it outside an evaluation. */
  get grants(): BudgetGrants {
    return { active: this.grantedActive };
  }

  /** Drop an id from the incumbent sets when its rig goes away. */
  forget(id: string): void {
    if (this.grantedActive.delete(id)) this.dirty = true;
  }

  reset(): void {
    this.grantedActive = new Set();
    this.dirty = true;
    this.lastEvalMs = 0;
    this.lastCameraX = Number.NaN;
    this.lastCameraY = Number.NaN;
    this.lastCameraZ = Number.NaN;
    this.scratch.length = 0;
  }
}

function byScoreDesc(a: ScoredCandidate, b: ScoredCandidate): number {
  return b.score - a.score;
}

function nowMillis(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
