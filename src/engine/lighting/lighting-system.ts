/**
 * The lighting subsystem: one {@link LightRig} per placed light entity, the
 * sun/sky rig, and the shadow budget that decides which lamps are allowed to
 * cost a real-time shadow.
 *
 * `syncLight` is on the hot path — it runs for every light entity on every HA
 * state push — so it does nothing but compare numbers and stage tween targets.
 * All GPU-visible work happens in `update`, which the render loop only calls
 * when a frame is actually drawn.
 */

import * as THREE from 'three';
import type { LevelDefinition, PlacedEntity, RenderConfig, Vec3 } from '@/types/config';
import { DEFAULT_RENDER_CONFIG } from '@/types/config';
import type {
  ILightingSystem,
  LightSample,
  QualityTier,
  RenderContext,
} from '@/engine/contracts';
import { LightRig } from '@/engine/lighting/light-rig';
import { DaylightRig } from '@/engine/lighting/daylight';
import { ShadowBudget, type ShadowCandidate } from '@/engine/lighting/shadow-budget';
import { RoomFill, type RoomFillLight } from '@/engine/lighting/room-fill';

/** A sample staged before `init(ctx)` — three.js objects may not exist yet. */
interface PendingLight {
  placed: PlacedEntity;
  sample: LightSample;
}

export class LightingSystem implements ILightingSystem {
  private ctx: RenderContext | null = null;

  private readonly root = new THREE.Group();
  private readonly rigs = new Map<string, LightRig>();
  private readonly budget = new ShadowBudget();
  private readonly daylightRig: DaylightRig;
  private readonly roomFill = new RoomFill();
  /** Explicit `entities[].room` overrides, by entity id. */
  private readonly roomHints = new Map<string, string | null>();
  /** Reused per frame; `apply` only ever reads it during the call. */
  private readonly fillSamples: RoomFillLight[] = [];

  /** Calls that arrived before `init`; replayed in order once the ctx exists. */
  private readonly pending = new Map<string, PendingLight>();

  /** Config object identity per entity — the viewer clones on config change,
   *  so a reference diff is a free and complete "did the YAML change" test. */
  private readonly appliedConfigs = new Map<string, PlacedEntity['light']>();

  /** Reused every evaluation; the budget runs on every light state change. */
  private readonly candidates: ShadowCandidate[] = [];

  private renderCfg: Required<RenderConfig>;
  private tier: QualityTier = 'high';
  private shadowsEnabled: boolean;
  private visibleLevels: Set<string> | null = null;

  private releaseLease: (() => void) | null = null;
  private daylightSettled = false;
  private modelChildCount = -1;
  private disposed = false;

  constructor(render?: RenderConfig) {
    this.renderCfg = { ...DEFAULT_RENDER_CONFIG, ...(render ?? {}) };
    this.shadowsEnabled = this.renderCfg.shadows;
    this.roomFill.setEnabled(this.renderCfg.lightMode === 'room');
    this.roomFill.setStrength(this.renderCfg.roomFillStrength);
    this.root.name = 'lighting';
    this.daylightRig = new DaylightRig({
      ambientIntensity: this.renderCfg.ambientIntensity,
      environment: true,
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.tier = ctx.quality;
    ctx.scene.add(this.root);

    this.budget.setQuality(this.tier);
    this.budget.setEnabled(this.shadowsEnabled);

    this.daylightRig.setQuality(this.tier);
    this.daylightRig.setShadowsEnabled(this.shadowsEnabled);
    this.daylightRig.init(ctx);

    for (const [entityId, entry] of this.pending) {
      this.applyLight(entityId, entry.placed, entry.sample);
    }
    this.pending.clear();
    this.budget.markDirty();
    ctx.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseLease?.();
    this.releaseLease = null;

    for (const rig of this.rigs.values()) rig.dispose();
    this.rigs.clear();
    this.pending.clear();
    this.appliedConfigs.clear();
    this.candidates.length = 0;
    this.budget.reset();

    this.roomFill.dispose();
    this.roomHints.clear();
    this.fillSamples.length = 0;

    this.daylightRig.dispose();
    this.root.parent?.remove(this.root);
    this.root.clear();
    this.ctx = null;
  }

  /* --------------------------------------------------------------- inputs */

  setDaylight(elevation: number, azimuth: number, enabled: boolean): void {
    const changed = this.daylightRig.setDaylight(elevation, azimuth, enabled);
    if (!changed) return;
    // The very first daylight push lands during mount; snapping avoids a 1.5 s
    // sunrise every time the card is added to a dashboard.
    if (!this.daylightSettled) {
      this.daylightSettled = true;
      this.daylightRig.settle();
    } else {
      this.takeLease();
    }
    this.ctx?.invalidate();
  }

  syncLight(placed: PlacedEntity, sample: LightSample): void {
    const entityId = placed.entity;
    if (!this.ctx) {
      this.pending.set(entityId, { placed, sample });
      return;
    }
    this.applyLight(entityId, placed, sample);
  }

  private applyLight(entityId: string, placed: PlacedEntity, sample: LightSample): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.roomHints.set(entityId, placed.room ?? null);

    let rig = this.rigs.get(entityId);
    if (!rig) {
      rig = new LightRig({
        entityId,
        position: placed.position,
        level: placed.level ?? null,
        config: placed.light,
        quality: this.tier,
        clippingPlanes: ctx.clippingPlanes,
      });
      rig.setShadowsEnabled(this.shadowsEnabled);
      rig.setEmissiveOnly(this.roomFillActive);
      this.root.add(rig.group);
      this.rigs.set(entityId, rig);
      this.appliedConfigs.set(entityId, placed.light);
      this.budget.markDirty();
    } else if (this.appliedConfigs.get(entityId) !== placed.light) {
      this.appliedConfigs.set(entityId, placed.light);
      rig.applyConfig(placed.light);
      rig.setShadowsEnabled(this.shadowsEnabled);
      this.budget.markDirty();
    }

    const p = rig.worldPosition;
    if (p.x !== placed.position[0] || p.y !== placed.position[1] || p.z !== placed.position[2]) {
      rig.setPosition(placed.position);
      this.budget.markDirty();
    }
    rig.setLevel(placed.level ?? null);
    rig.setCulledByLevel(this.isLevelHidden(placed.level ?? null));

    if (rig.setSample(sample)) {
      this.budget.markDirty();
      this.takeLease();
    }
    ctx.invalidate();
  }

  removeLight(entityId: string): void {
    this.pending.delete(entityId);
    this.appliedConfigs.delete(entityId);
    this.roomHints.delete(entityId);
    const rig = this.rigs.get(entityId);
    if (!rig) return;
    this.rigs.delete(entityId);
    rig.dispose();
    this.budget.forget(entityId);
    this.budget.markDirty();
    this.ctx?.invalidate();
  }

  /** Live during a drag: no tween, no budget churn, just move the rig. */
  moveLight(entityId: string, position: Vec3): void {
    const rig = this.rigs.get(entityId);
    if (rig) {
      rig.setPosition(position);
      rig.setCulledByClip(this.isClippedOut(rig.worldPosition));
    } else {
      const entry = this.pending.get(entityId);
      if (entry) entry.placed = { ...entry.placed, position };
    }
    this.ctx?.invalidate();
  }

  getLightIds(): string[] {
    const ids = [...this.rigs.keys()];
    for (const id of this.pending.keys()) if (!this.rigs.has(id)) ids.push(id);
    return ids;
  }

  setShadowsEnabled(enabled: boolean): void {
    if (this.shadowsEnabled === enabled) return;
    this.shadowsEnabled = enabled;
    this.budget.setEnabled(enabled);
    this.daylightRig.setShadowsEnabled(enabled);
    for (const rig of this.rigs.values()) rig.setShadowsEnabled(enabled);
    this.budget.markDirty();
    this.ctx?.invalidate();
  }

  /* ------------------------------------------------- optional wiring (extra) */

  /** Re-apply a changed render block (exposure/ambient/shadows/daylight flag). */
  setRenderConfig(render: RenderConfig): void {
    const wasRoomFill = this.roomFillActive;
    this.renderCfg = { ...DEFAULT_RENDER_CONFIG, ...render };
    this.daylightRig.setAmbientIntensity(this.renderCfg.ambientIntensity);
    this.setShadowsEnabled(this.renderCfg.shadows);

    this.roomFill.setEnabled(this.roomFillActive);
    this.roomFill.setStrength(this.renderCfg.roomFillStrength);
    if (wasRoomFill !== this.roomFillActive) {
      for (const rig of this.rigs.values()) rig.setEmissiveOnly(this.roomFillActive);
      this.budget.markDirty();
    }
    this.ctx?.invalidate();
  }

  private get roomFillActive(): boolean {
    return this.renderCfg.lightMode === 'room';
  }

  /**
   * Hand the loaded house over so rooms can be indexed. Not part of
   * `ILightingSystem`: only the room-fill mode needs it, and a viewer that never
   * calls it simply gets no fill.
   */
  setModel(root: THREE.Object3D | null, levels: readonly LevelDefinition[]): void {
    this.roomFill.setModel(root, levels);
    for (const rig of this.rigs.values()) rig.setEmissiveOnly(this.roomFillActive);
    this.refreshRoomFill();
    this.ctx?.invalidate();
  }

  /** Rooms the model actually has, for the editor's room picker. */
  get roomCount(): number {
    return this.roomFill.roomCount;
  }

  /**
   * Hide the lamps of hidden storeys. Not part of `ILightingSystem`, so the
   * Viewer has to opt in; until it does, section clipping still culls lights.
   */
  setVisibleLevels(levelIds: string[] | null): void {
    this.visibleLevels = levelIds && levelIds.length > 0 ? new Set(levelIds) : null;
    for (const rig of this.rigs.values()) rig.setCulledByLevel(this.isLevelHidden(rig.level));
    this.budget.markDirty();
    this.ctx?.invalidate();
  }

  /** Fit the sun's shadow frustum to the house. */
  setModelBounds(bounds: THREE.Box3): void {
    this.daylightRig.setBounds(bounds);
    this.ctx?.invalidate();
  }

  /** Hard cap on simultaneously active lights; null restores the tier default. */
  setMaxLights(max: number | null): void {
    this.budget.setMaxLights(max);
    this.ctx?.invalidate();
  }

  get daylight(): DaylightRig {
    return this.daylightRig;
  }

  /* --------------------------------------------------------------- update */

  update(dt: number, ctx: RenderContext): void {
    if (this.disposed) return;

    if (ctx.quality !== this.tier) {
      this.tier = ctx.quality;
      this.budget.setQuality(this.tier);
      this.daylightRig.setQuality(this.tier);
      for (const rig of this.rigs.values()) rig.setQuality(this.tier);
      this.budget.markDirty();
    }

    this.refreshModelBounds(ctx);

    let animating = this.daylightRig.update(dt);

    const cameraPosition = ctx.activeCamera.position;
    if (this.rigs.size > 0 && this.budget.shouldEvaluate(now(), cameraPosition)) {
      this.evaluateBudget(cameraPosition);
    }

    let fillChanged = this.roomFill.needsApply;
    for (const rig of this.rigs.values()) {
      if (rig.update(dt)) {
        animating = true;
        fillChanged = true;
      }
    }
    // The fill tracks the same tweens the rigs run, so a room brightens with
    // its lamp instead of snapping when the tween ends.
    if (fillChanged) this.refreshRoomFill();

    if (animating) this.takeLease();
    else this.dropLease();
  }

  /**
   * The Viewer does not hand model bounds to the lighting system, so the sun's
   * shadow frustum is fitted from the model root the first time it has content
   * and again whenever the model is swapped.
   */
  private refreshModelBounds(ctx: RenderContext): void {
    const count = ctx.modelRoot.children.length;
    if (count === 0 || count === this.modelChildCount) return;
    this.modelChildCount = count;
    scratchBox.setFromObject(ctx.modelRoot);
    if (!scratchBox.isEmpty()) this.daylightRig.setBounds(scratchBox);
  }

  private evaluateBudget(cameraPosition: THREE.Vector3): void {
    const list = this.candidates;
    list.length = 0;
    for (const rig of this.rigs.values()) {
      rig.setCulledByClip(this.isClippedOut(rig.worldPosition));
      if (!rig.countsAgainstBudget) {
        // Emissive-only rigs cost no shader slot; they are never budgeted out.
        rig.setCulledByBudget(false);
        continue;
      }
      list.push(rig.getCandidate());
    }

    const grants = this.budget.evaluate(list, cameraPosition);
    for (const [entityId, rig] of this.rigs) {
      if (!rig.countsAgainstBudget) continue;
      rig.setCulledByBudget(!grants.active.has(entityId));
      rig.setShadowGranted(grants.shadows.has(entityId));
    }
    list.length = 0;
  }

  private isLevelHidden(levelId: string | null): boolean {
    if (!this.visibleLevels || !levelId) return false;
    return !this.visibleLevels.has(levelId);
  }

  /**
   * three.js keeps the half-space with a non-negative signed distance, so a
   * light behind any active section plane has been cut away with the room it
   * lives in and must stop lighting the rest of the house.
   */
  private isClippedOut(position: THREE.Vector3): boolean {
    const planes = this.ctx?.clippingPlanes;
    if (!planes || planes.length === 0) return false;
    for (let i = 0; i < planes.length; i += 1) {
      if (planes[i].distanceToPoint(position) < 0) return true;
    }
    return false;
  }

  /** Rebuild the per-room fill colours from every rig's current tween state. */
  private refreshRoomFill(): void {
    const samples = this.fillSamples;
    samples.length = 0;
    for (const [entityId, rig] of this.rigs) {
      const weight = rig.fillWeight;
      if (weight <= 1e-4) continue;
      samples.push({
        room: this.roomHints.get(entityId) ?? null,
        level: rig.level,
        position: rig.worldPosition,
        color: rig.fillColor,
        weight,
      });
    }
    this.roomFill.apply(samples);
  }

  /* ---------------------------------------------------------------- lease */

  private takeLease(): void {
    if (this.releaseLease || !this.ctx) return;
    this.releaseLease = this.ctx.holdContinuous();
  }

  private dropLease(): void {
    if (!this.releaseLease) return;
    this.releaseLease();
    this.releaseLease = null;
  }
}

const scratchBox = new THREE.Box3();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
