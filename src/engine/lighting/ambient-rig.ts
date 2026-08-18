/**
 * The light the *drawing* needs, and nothing more.
 *
 * This replaces a sun-and-sky rig that followed `sun.sun` through the day. That
 * rig existed for a photographic reading of the model, and the card no longer
 * has one: `style: wireframe` paints no surface at all, and shadows are gone.
 * What survives is the part every mode still depends on — a flat, neutral fill
 * so `style: solid` reads as geometry rather than silhouettes, and an
 * environment map so metal and glass have something to reflect.
 *
 * Constant on purpose. A floorplan is a plan: the same room must look the same
 * at eight in the morning and at midnight, or a lamp turning on is impossible
 * to tell from the sun coming out.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { RenderContext } from '@/engine/contracts';

/** Sky and ground tones for the hemisphere fill; cool above, warm below. */
const SKY = 0xc8d4e4;
const GROUND = 0x585b62;

/** Weight of the generated environment map. */
const ENV_INTENSITY = 0.55;

export interface AmbientRigOptions {
  /** Multiplier from `render.ambientIntensity`. */
  intensity?: number;
  /** Generate a PMREM room environment for indoor reflections. */
  environment?: boolean;
}

export class AmbientRig {
  readonly group = new THREE.Group();

  private ctx: RenderContext | null = null;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly wantEnvironment: boolean;
  private intensity: number;

  /** Set only where we own `scene.environment`, so dispose cannot steal it. */
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private ownsEnvironment = false;
  private disposed = false;

  constructor(options: AmbientRigOptions = {}) {
    this.intensity = options.intensity ?? 1;
    this.wantEnvironment = options.environment ?? true;

    this.group.name = 'fp3d:ambient';
    this.group.userData.fp3dInternal = true;

    this.hemi = new THREE.HemisphereLight(SKY, GROUND, 0);
    this.ambient = new THREE.AmbientLight(0xa2a8b4, 0);
    this.group.add(this.hemi, this.ambient);
    this.applyIntensity();
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.scene.add(this.group);
    if (this.wantEnvironment) this.buildEnvironment();
  }

  setAmbientIntensity(value: number): void {
    if (this.intensity === value) return;
    this.intensity = value;
    this.applyIntensity();
    this.ctx?.invalidate();
  }

  private applyIntensity(): void {
    const scale = Math.max(0, this.intensity);
    this.hemi.intensity = 1.5 * scale;
    this.ambient.intensity = 0.55 * scale;
  }

  /**
   * Generated once and left alone. PMREM is expensive enough that regenerating
   * it per config change would be felt on a wall tablet, and nothing about it
   * varies any more.
   */
  private buildEnvironment(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    // Somebody else's environment is somebody else's business.
    if (ctx.scene.environment) return;

    try {
      const pmrem = new THREE.PMREMGenerator(ctx.renderer);
      this.envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
      pmrem.dispose();
      ctx.scene.environment = this.envTarget.texture;
      ctx.scene.environmentIntensity = ENV_INTENSITY;
      this.ownsEnvironment = true;
    } catch (err) {
      // A context without float render targets; the card still draws.
      console.warn('[floorplan-3d] environment map unavailable', err);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const scene = this.ctx?.scene;
    if (scene && this.ownsEnvironment) {
      scene.environment = null;
      scene.environmentIntensity = 1;
    }
    this.envTarget?.dispose();
    this.envTarget = null;

    this.group.removeFromParent();
    this.group.clear();
    this.hemi.dispose();
    this.ambient.dispose();
    this.ctx = null;
  }
}
