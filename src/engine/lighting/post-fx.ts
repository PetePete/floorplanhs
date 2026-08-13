/**
 * Selective bloom.
 *
 * A naive UnrealBloomPass blooms *everything* bright — a white wall in
 * sunlight, the marker labels, the section caps — and the card immediately
 * looks like a soap advert. What sells "that lamp is on" is a glow that comes
 * only from the luminaires, so we use the layer technique from the three.js
 * `webgl_postprocessing_unreal_bloom_selective` example:
 *
 *   1. Swap every material that is *not* on {@link BLOOM_LAYER} for flat black,
 *      null the background and the environment map, and render the scene into
 *      the bloom composer. What is left is the emitters on black.
 *   2. Bloom that buffer.
 *   3. Restore every material, render the scene normally, and add the bloom
 *      buffer on top.
 *
 * Step 3's restore is the dangerous part: if the material cache is not put back
 * exactly, the scene stays black forever. The swapped objects are therefore
 * recorded in two parallel arrays (not re-derived by a second traversal) and
 * restored inside a `finally`.
 *
 * Colour management: the composer's render targets are linear HalfFloat and
 * three.js skips tone mapping when drawing into a render target, so the whole
 * chain works in linear HDR and `OutputPass` does tone mapping + sRGB encode
 * once, at the very end.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BLOOM_LAYER, type IPostFx, type RenderContext } from '@/engine/contracts';
import { DEFAULT_RENDER_CONFIG, type RenderConfig } from '@/types/config';

/** Anything the renderer draws with a material we can temporarily swap. */
type MaterialHolder = THREE.Object3D & { material: THREE.Material | THREE.Material[] };

function isMaterialHolder(object: THREE.Object3D): object is MaterialHolder {
  const candidate = object as Partial<MaterialHolder>;
  return candidate.material !== undefined;
}

/**
 * Straight additive composite. Both inputs are linear HDR; the bloom buffer
 * already contains the emitters themselves plus their blur, which is what makes
 * a lit bulb read as *hot* rather than merely bright.
 */
/**
 * Bloom renders at half the main resolution. It is a wide blur, so the loss is
 * invisible, while the five mip levels of separable blur underneath it cost a
 * quarter of the pixels — the largest single saving available in this pipeline.
 */
const BLOOM_SCALE = 0.5;

const MIX_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const MIX_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D baseTexture;
uniform sampler2D bloomTexture;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D( baseTexture, vUv ) + vec4( 1.0 ) * texture2D( bloomTexture, vUv );
}
`;

export class PostFx implements IPostFx {
  readonly bloomLayer = BLOOM_LAYER;

  private ctx: RenderContext | null = null;

  private bloomComposer: EffectComposer | null = null;
  private finalComposer: EffectComposer | null = null;
  private bloomRenderPass: RenderPass | null = null;
  private finalRenderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private mixPass: ShaderPass | null = null;
  private mixMaterial: THREE.ShaderMaterial | null = null;
  private outputPass: OutputPass | null = null;

  private readonly darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
  /** Layers mask used to test "is this object a bloom emitter". */
  private readonly bloomLayers = new THREE.Layers();

  /** Parallel arrays of what we darkened, so restore never has to search. */
  private readonly swappedObjects: MaterialHolder[] = [];
  private readonly swappedMaterials: Array<THREE.Material | THREE.Material[]> = [];

  private enabled: boolean;
  private strength: number;
  private radius: number;
  private threshold: number;
  private exposure: number;

  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(render?: RenderConfig) {
    const cfg = { ...DEFAULT_RENDER_CONFIG, ...(render ?? {}) };
    this.enabled = cfg.bloom;
    this.strength = cfg.bloomStrength;
    this.radius = cfg.bloomRadius;
    this.threshold = cfg.bloomThreshold;
    this.exposure = cfg.exposure;
    this.bloomLayers.set(BLOOM_LAYER);
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.width = Math.max(1, ctx.size.width);
    this.height = Math.max(1, ctx.size.height);
    ctx.renderer.toneMappingExposure = this.exposure;
    if (this.shouldCompose()) this.build();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.darkMaterial.dispose();
    this.swappedObjects.length = 0;
    this.swappedMaterials.length = 0;
    this.ctx = null;
  }

  /* --------------------------------------------------------------- config */

  setBloom(enabled: boolean, strength: number, radius: number, threshold: number): void {
    this.enabled = enabled;
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;

    if (this.bloomPass) {
      this.bloomPass.strength = strength;
      this.bloomPass.radius = radius;
      this.bloomPass.threshold = threshold;
    }

    if (this.shouldCompose()) {
      if (!this.bloomComposer) this.build();
    } else if (this.bloomComposer) {
      // Free the render targets rather than keeping four full-screen HalfFloat
      // buffers alive for a feature the user switched off.
      this.teardown();
    }
    this.ctx?.invalidate();
  }

  setExposure(value: number): void {
    this.exposure = value;
    if (this.ctx) this.ctx.renderer.toneMappingExposure = value;
    this.ctx?.invalidate();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const pixelRatio = this.ctx?.renderer.getPixelRatio() ?? 1;

    // Pixel ratio first: setSize multiplies by whatever the composer has.
    if (this.finalComposer) {
      this.finalComposer.setPixelRatio(pixelRatio);
      this.finalComposer.setSize(this.width, this.height);
    }
    if (this.bloomComposer) {
      this.bloomComposer.setPixelRatio(pixelRatio * BLOOM_SCALE);
      this.bloomComposer.setSize(this.width, this.height);
    }
    this.bloomPass?.resolution.set(
      Math.max(1, this.width * pixelRatio * BLOOM_SCALE),
      Math.max(1, this.height * pixelRatio * BLOOM_SCALE),
    );
  }

  /* --------------------------------------------------------------- render */

  render(dt: number): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;

    const camera = ctx.activeCamera;
    const bloomComposer = this.bloomComposer;
    const finalComposer = this.finalComposer;

    // Plain path: no composer allocated, no extra full-screen passes, and the
    // renderer's own tone mapping applies as usual.
    if (!this.shouldCompose() || !bloomComposer || !finalComposer) {
      ctx.renderer.render(ctx.scene, camera);
      return;
    }

    // `activeCamera` flips between the perspective and orthographic rig at
    // runtime, so the passes are re-pointed every frame rather than captured.
    if (this.bloomRenderPass) this.bloomRenderPass.camera = camera;
    if (this.finalRenderPass) this.finalRenderPass.camera = camera;

    const scene = ctx.scene;
    const previousBackground = scene.background;
    const previousEnvironment = scene.environment;
    // Both would light or tint the "emitters on black" pass and leak bloom onto
    // ordinary geometry.
    scene.background = null;
    scene.environment = null;

    try {
      this.darkenScene(scene);
      bloomComposer.render(dt);
    } finally {
      this.restoreScene();
      scene.background = previousBackground;
      scene.environment = previousEnvironment;
    }

    finalComposer.render(dt);
  }

  /* ----------------------------------------------------------- internals */

  private shouldCompose(): boolean {
    // 'low' means a device that cannot afford four extra full-screen passes.
    return this.enabled && this.ctx !== null && this.ctx.quality !== 'low';
  }

  private darkenScene(scene: THREE.Scene): void {
    scene.traverse(this.collectDarkened);
  }

  /** Stable reference: a fresh closure here would allocate on every frame. */
  private readonly collectDarkened = (object: THREE.Object3D): void => {
    if (!object.visible) return;
    if (!isMaterialHolder(object)) return;
    if (this.bloomLayers.test(object.layers)) return;
    this.swappedObjects.push(object);
    this.swappedMaterials.push(object.material);
    object.material = this.darkMaterial;
  };

  private restoreScene(): void {
    const objects = this.swappedObjects;
    const materials = this.swappedMaterials;
    for (let i = 0; i < objects.length; i += 1) {
      objects[i].material = materials[i];
    }
    // Truncating drops our references to both the objects and their materials.
    objects.length = 0;
    materials.length = 0;
  }

  private build(): void {
    const ctx = this.ctx;
    if (!ctx || this.bloomComposer) return;

    const renderer = ctx.renderer;
    const pixelRatio = renderer.getPixelRatio();
    const width = this.width;
    const height = this.height;

    // HalfFloat: the emitters are deliberately above 1.0 and an 8-bit target
    // would clip them to white before the high-pass filter ever sees them.
    const bloomTarget = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(width * pixelRatio * BLOOM_SCALE)),
      Math.max(1, Math.round(height * pixelRatio * BLOOM_SCALE)),
      { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false },
    );
    bloomTarget.texture.name = 'PostFx.bloom';

    this.bloomComposer = new EffectComposer(renderer, bloomTarget);
    this.bloomComposer.renderToScreen = false;
    // Bloom is a wide blur; running it at full device resolution is pure waste.
    // Half res quarters the pixels through five mip levels of separable blur —
    // the single biggest cost in this pipeline — and is invisible in the
    // result, because the output is blurry by definition.
    this.bloomComposer.setPixelRatio(pixelRatio * BLOOM_SCALE);

    // Explicit black clear: the renderer's clear colour is the card background,
    // which would flood the high-pass filter.
    this.bloomRenderPass = new RenderPass(ctx.scene, ctx.activeCamera, null, BLACK, 1);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width * pixelRatio, height * pixelRatio),
      this.strength,
      this.radius,
      this.threshold,
    );
    this.bloomComposer.addPass(this.bloomRenderPass);
    this.bloomComposer.addPass(this.bloomPass);

    // The canvas' own `antialias: true` does nothing once we render through a
    // composer, because the scene never touches the default framebuffer. Every
    // edge in the model is a straight architectural line, so the aliasing is
    // glaring. WebGL2 multisampled render targets are the fix.
    const finalTarget = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(width * pixelRatio)),
      Math.max(1, Math.round(height * pixelRatio)),
      {
        type: THREE.HalfFloatType,
        samples: ctx.quality === 'low' ? 0 : 4,
        stencilBuffer: true,
      },
    );
    finalTarget.texture.name = 'PostFx.final';

    this.finalComposer = new EffectComposer(renderer, finalTarget);
    this.finalRenderPass = new RenderPass(ctx.scene, ctx.activeCamera);

    this.mixMaterial = new THREE.ShaderMaterial({
      name: 'PostFx.bloomMix',
      uniforms: {
        baseTexture: { value: null },
        // UnrealBloomPass has needsSwap = false and blends into the composer's
        // *read* buffer, which is renderTarget2 — that is where the result is.
        bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
      },
      vertexShader: MIX_VERTEX_SHADER,
      fragmentShader: MIX_FRAGMENT_SHADER,
      defines: {},
    });
    this.mixPass = new ShaderPass(this.mixMaterial, 'baseTexture');
    this.mixPass.needsSwap = true;

    this.outputPass = new OutputPass();

    this.finalComposer.addPass(this.finalRenderPass);
    this.finalComposer.addPass(this.mixPass);
    this.finalComposer.addPass(this.outputPass);

    this.resize(width, height);
  }

  private teardown(): void {
    // Any half-finished frame must not leave black materials behind.
    this.restoreScene();

    this.bloomComposer?.dispose();
    this.finalComposer?.dispose();
    // EffectComposer.dispose() only frees its own two targets — every pass owns
    // render targets and materials of its own and has to be told separately.
    this.bloomPass?.dispose();
    this.mixPass?.dispose();
    this.outputPass?.dispose();
    this.bloomRenderPass?.dispose();
    this.finalRenderPass?.dispose();
    this.mixMaterial?.dispose();

    this.bloomComposer = null;
    this.finalComposer = null;
    this.bloomPass = null;
    this.mixPass = null;
    this.mixMaterial = null;
    this.outputPass = null;
    this.bloomRenderPass = null;
    this.finalRenderPass = null;
  }
}

const BLACK = new THREE.Color(0, 0, 0);
