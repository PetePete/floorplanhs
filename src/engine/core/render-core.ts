/**
 * The render core: owns the WebGL renderer, the scene, both cameras and the
 * canvas lifecycle. Everything a subsystem is allowed to touch is exposed as
 * `RenderContext`, which this class implements directly.
 */

import * as THREE from 'three';
import type { CameraConfig, RenderConfig } from '@/types/config';
import { DEFAULT_CAMERA_CONFIG, DEFAULT_RENDER_CONFIG } from '@/types/config';
import type { QualityTier, RenderContext } from '@/engine/contracts';
import { resolveQuality, type QualitySettings } from '@/engine/core/quality';
import { disposeObject3D } from '@/engine/core/dispose';
import { resolveBackground } from '@/engine/core/background';

/** Thrown when the browser cannot give us a WebGL2 context at all. */
export class WebGLUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(message = 'WebGL2 is not available in this browser', cause?: unknown) {
    super(message);
    this.name = 'WebGLUnavailableError';
    this.cause = cause;
  }
}

/** What the render loop must provide so `ctx.invalidate()` reaches it. */
export interface FrameScheduler {
  invalidate(): void;
  holdContinuous(): () => void;
}

export interface RenderCoreOptions {
  container: HTMLElement;
  /**
   * The *raw* user render block. Do not merge DEFAULT_RENDER_CONFIG into it
   * first — quality resolution needs to know which fields the user actually
   * set (see resolveQuality).
   */
  render?: RenderConfig;
  camera?: CameraConfig;
  /** Dashboard polarity, for the `system` / `light` / `dark` backgrounds. */
  themeDark?: boolean;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export type ResizeListener = (width: number, height: number) => void;

const _dir = new THREE.Vector3();

export class RenderCore implements RenderContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly clock = new THREE.Clock();
  readonly modelRoot = new THREE.Group();
  readonly overlayRoot = new THREE.Group();
  readonly size = { width: 0, height: 0, pixelRatio: 1 };

  /**
   * Shared with the section controller, which assigns it to individual
   * materials. It is deliberately *not* handed to `renderer.clippingPlanes`:
   * global planes would cut the overlay root (markers, gizmos, handles) too.
   */
  readonly clippingPlanes: THREE.Plane[] = [];

  /** Replaced by the Viewer so the card can react to a lost context. */
  onContextLost: (() => void) | null;
  onContextRestored: (() => void) | null;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly resizeListeners = new Set<ResizeListener>();
  private renderConfig: Required<RenderConfig>;
  private settings: QualitySettings;
  private tier: QualityTier;
  private scheduler: FrameScheduler | null = null;
  private resizeFrame: number | null = null;
  private orthographic = false;
  private contextLost = false;
  private hasSize = false;
  /**
   * Deadline until which shadow maps keep refreshing. Starts as a grace window
   * so the first seconds — model load, daylight settling — are always covered
   * even if a caller forgets to mark.
   */
  private shadowDirtyUntil = performance.now() + 4000;
  private themeDark: boolean;
  private disposed = false;

  constructor(options: RenderCoreOptions) {
    this.container = options.container;
    this.themeDark = options.themeDark ?? true;
    this.onContextLost = options.onContextLost ?? null;
    this.onContextRestored = options.onContextRestored ?? null;

    const raw = options.render ?? {};
    const resolved = resolveQuality(raw.quality ?? 'auto', raw);
    this.tier = resolved.tier;
    this.settings = resolved.settings;
    this.renderConfig = { ...DEFAULT_RENDER_CONFIG, ...raw };

    this.canvas = document.createElement('canvas');
    // `touch-action: none` is what makes pointer-drag work on a finger
    // (rule 6) — without it the browser steals the gesture for scrolling.
    this.canvas.style.cssText =
      'display:block;width:100%;height:100%;touch-action:none;outline:none;';

    const attributes: WebGLContextAttributes = {
      // Needed for the transparent default background; the compositing cost is
      // negligible next to everything else this card draws.
      alpha: true,
      premultipliedAlpha: false,
      antialias: this.settings.antialias,
      depth: true,
      // Required by the cross-section cut caps: they mark the cut surface in
      // the stencil buffer (back faces increment, front faces decrement) and
      // fill only where the count is non-zero. Without this the clipped model
      // renders hollow and you see straight through the walls into nothing.
      stencil: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    };

    // Create the context ourselves so an unsupported browser fails here with a
    // clear error instead of somewhere inside three.js, and so we never burn a
    // second context slot on a capability probe.
    const gl = this.canvas.getContext('webgl2', attributes);
    if (!gl) {
      this.canvas.remove();
      throw new WebGLUnavailableError();
    }

    this.container.appendChild(this.canvas);

    try {
      this.renderer = new THREE.WebGLRenderer({ ...attributes, canvas: this.canvas, context: gl });
    } catch (err) {
      this.canvas.remove();
      throw new WebGLUnavailableError('Could not create a WebGL renderer', err);
    }

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.applyToneMapping();
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Shadow maps do not depend on the camera, but three re-renders every one
    // of them on every frame by default. With four shadow-casting point lights
    // that is 4 x 6 cube faces + the sun = 25 extra passes over the whole house
    // per frame, all of it wasted while the user is merely orbiting. We drive
    // the refresh explicitly instead; see `markShadowsDirty`.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setPixelRatio(this.settings.pixelRatio);

    this.scene = new THREE.Scene();
    this.scene.name = 'floorplan-scene';
    this.applyBackground(this.renderConfig.background);

    const cam = { ...DEFAULT_CAMERA_CONFIG, ...(options.camera ?? {}) };
    this.camera = new THREE.PerspectiveCamera(cam.fov, 1, cam.near, cam.far);
    this.camera.position.set(8, 6, 8);
    this.camera.name = 'perspective';
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, cam.near, cam.far);
    this.orthoCamera.position.copy(this.camera.position);
    this.orthoCamera.name = 'orthographic';

    this.modelRoot.name = 'modelRoot';
    this.overlayRoot.name = 'overlayRoot';
    // Flag for the section controller: anything under here stays unclipped.
    this.overlayRoot.userData.noClip = true;
    this.scene.add(this.modelRoot, this.overlayRoot, this.camera, this.orthoCamera);

    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
      this.resizeObserver.observe(this.container);
    }
    this.applySize();
  }

  /* ------------------------------------------------------------- context */

  get activeCamera(): THREE.Camera {
    return this.orthographic ? this.orthoCamera : this.camera;
  }

  get quality(): QualityTier {
    return this.tier;
  }

  get qualitySettings(): QualitySettings {
    return this.settings;
  }

  /** False while the container has no layout box or the context is gone. */
  get canRender(): boolean {
    return this.hasSize && !this.contextLost && !this.disposed;
  }

  invalidate(): void {
    this.scheduler?.invalidate();
  }

  /**
   * Request a shadow-map refresh. Called when geometry, level visibility, cut
   * planes or lights change — never for camera movement, which is the whole
   * point. The window (rather than a single frame) covers the light and
   * daylight tweens, which keep moving for a while after the state change that
   * started them.
   */
  markShadowsDirty(durationMs = 1800): void {
    this.shadowDirtyUntil = Math.max(this.shadowDirtyUntil, performance.now() + durationMs);
    this.invalidate();
  }

  /** Applied by the frame callback immediately before anything is drawn. */
  applyShadowUpdate(): void {
    if (!this.renderer.shadowMap.enabled) return;
    this.renderer.shadowMap.needsUpdate = performance.now() <= this.shadowDirtyUntil;
  }

  holdContinuous(): () => void {
    return this.scheduler?.holdContinuous() ?? noop;
  }

  /**
   * Wired by the Viewer right after the loop is built. Until then
   * `invalidate()` is a no-op, which is correct: nothing can be drawn yet.
   */
  attachScheduler(scheduler: FrameScheduler | null): void {
    this.scheduler = scheduler;
  }

  onResize(listener: ResizeListener): () => void {
    this.resizeListeners.add(listener);
    return () => {
      this.resizeListeners.delete(listener);
    };
  }

  /* -------------------------------------------------------------- camera */

  isOrthographic(): boolean {
    return this.orthographic;
  }

  setOrthographic(enabled: boolean): void {
    if (this.orthographic === enabled) return;
    this.orthographic = enabled;
    this.invalidate();
  }

  /**
   * Keeps the two cameras showing the same thing so `setOrthographic()` is a
   * seamless swap. The inactive camera is derived from the active one:
   * perspective distance <-> orthographic frustum height at the orbit target.
   */
  syncCameras(target: THREE.Vector3): void {
    const persp = this.camera;
    const ortho = this.orthoCamera;
    const halfFov = THREE.MathUtils.degToRad(persp.fov) / 2;
    const tanHalfFov = Math.tan(halfFov) || 1e-4;

    if (this.orthographic) {
      // Orbit controls change `zoom` in orthographic mode, not the distance,
      // so the frustum is authoritative and the perspective rig follows.
      const halfHeight = ((ortho.top - ortho.bottom) / 2 || 1) / (ortho.zoom || 1);
      const distance = halfHeight / tanHalfFov;
      _dir.copy(ortho.position).sub(target);
      if (_dir.lengthSq() < 1e-8) _dir.set(0, 0.6, 1);
      _dir.normalize();
      persp.quaternion.copy(ortho.quaternion);
      persp.position.copy(target).addScaledVector(_dir, Number.isFinite(distance) ? distance : 10);
      persp.updateMatrixWorld();
      return;
    }

    ortho.position.copy(persp.position);
    ortho.quaternion.copy(persp.quaternion);
    ortho.near = persp.near;
    ortho.far = persp.far;
    ortho.zoom = 1;
    const distance = persp.position.distanceTo(target);
    const halfHeight = tanHalfFov * (Number.isFinite(distance) && distance > 0.01 ? distance : 10);
    const halfWidth = halfHeight * (persp.aspect || 1);
    ortho.top = halfHeight;
    ortho.bottom = -halfHeight;
    ortho.left = -halfWidth;
    ortho.right = halfWidth;
    ortho.updateProjectionMatrix();
    ortho.updateMatrixWorld();
  }

  /* ---------------------------------------------------------------- size */

  /** Public entry point for a manual resize (IViewer.resize). */
  resize(): void {
    this.applySize(true);
  }

  private scheduleResize(): void {
    // Debounce to one frame: a ResizeObserver fires per layout pass and
    // reallocating the drawing buffer is expensive.
    if (this.resizeFrame !== null || this.disposed) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.applySize();
    });
  }

  private applySize(force = false): void {
    if (this.disposed) return;

    const width = Math.floor(this.container.clientWidth);
    const height = Math.floor(this.container.clientHeight);

    // A card in a hidden Lovelace tab has a 0x0 box. Bailing out keeps the
    // aspect ratio out of NaN territory; the ResizeObserver brings us back.
    if (!(width > 0) || !(height > 0)) {
      this.hasSize = false;
      return;
    }

    const pixelRatio = this.settings.pixelRatio;
    const unchanged =
      this.hasSize &&
      !force &&
      width === this.size.width &&
      height === this.size.height &&
      pixelRatio === this.size.pixelRatio;
    if (unchanged) return;

    this.hasSize = true;
    this.size.width = width;
    this.size.height = height;
    this.size.pixelRatio = pixelRatio;

    this.renderer.setPixelRatio(pixelRatio);
    // updateStyle=false: the canvas is sized by CSS (100%/100%), so letting
    // three.js write inline px would fight the container on every resize.
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applyAspectToOrtho();

    for (const listener of this.resizeListeners) {
      try {
        listener(width, height);
      } catch (err) {
        console.error('[floorplan-3d] resize listener threw', err);
      }
    }

    this.invalidate();
  }

  /** Keeps the ortho frustum's horizontal extent in step with the viewport. */
  private applyAspectToOrtho(): void {
    const halfHeight = (this.orthoCamera.top - this.orthoCamera.bottom) / 2 || 1;
    const halfWidth = halfHeight * (this.camera.aspect || 1);
    this.orthoCamera.left = -halfWidth;
    this.orthoCamera.right = halfWidth;
    this.orthoCamera.updateProjectionMatrix();
  }

  /* -------------------------------------------------------- render config */

  /**
   * In-place render-config update. Antialiasing is intentionally not applied:
   * it is a context creation attribute and would require tearing down the
   * whole renderer, which the card must do by remounting.
   */
  applyRenderConfig(raw: RenderConfig): void {
    const resolved = resolveQuality(raw.quality ?? 'auto', raw);
    this.tier = resolved.tier;
    this.settings = resolved.settings;
    this.renderConfig = { ...DEFAULT_RENDER_CONFIG, ...raw };

    this.applyToneMapping();
    this.renderer.shadowMap.enabled = this.settings.shadows;
    // Turning shadows on only flips the switch; with autoUpdate off nothing
    // would ever render a map, so shadows would simply be absent.
    this.markShadowsDirty();
    this.applyBackground(this.renderConfig.background);
    this.applySize(true);
  }

  setExposure(value: number): void {
    this.renderConfig.exposure = value;
    this.renderer.toneMappingExposure = value;
    this.invalidate();
  }

  /**
   * `render.toneMapping`. Applies to both render paths: the composer's
   * `OutputPass` reads these same two renderer fields, which is what keeps the
   * card looking identical whether or not the bloom chain is running.
   */
  private applyToneMapping(): void {
    const mode = this.renderConfig.toneMapping;
    this.renderer.toneMapping =
      mode === 'aces'
        ? THREE.ACESFilmicToneMapping
        : mode === 'none'
          ? THREE.NoToneMapping
          : THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = this.renderConfig.exposure;
  }

  setBackground(css: string): void {
    this.renderConfig.background = css;
    this.applyBackground(css);
    this.invalidate();
  }

  /** `light` / `dark` / `system` backgrounds change meaning with the theme. */
  setThemeDark(dark: boolean): void {
    if (this.themeDark === dark) return;
    this.themeDark = dark;
    this.applyBackground(this.renderConfig.background);
    this.invalidate();
  }

  private applyBackground(css: string): void {
    const { color } = resolveBackground(css, this.themeDark);

    if (color === null) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      return;
    }

    const parsed = new THREE.Color(color);
    // alpha:false means something is always composited; keep the clear colour
    // and the scene background identical so postfx passes match too.
    this.scene.background = parsed;
    this.renderer.setClearColor(parsed, 1);
  }

  /* ------------------------------------------------------- context loss */

  private readonly handleContextLost = (event: Event): void => {
    // Without preventDefault the browser never fires `webglcontextrestored`.
    event.preventDefault();
    this.contextLost = true;
    this.onContextLost?.();
  };

  private readonly handleContextRestored = (): void => {
    this.contextLost = false;
    // three.js rebuilds its GL state, but our renderer-level settings live
    // outside that and have to be re-stated.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.applyToneMapping();
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    // The GPU-side shadow maps died with the context; nothing else would ever
    // ask for them to be redrawn.
    this.markShadowsDirty();
    this.applyBackground(this.renderConfig.background);
    this.applySize(true);
    this.onContextRestored?.();
    this.invalidate();
  };

  /* ------------------------------------------------------------- teardown */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeListeners.clear();
    this.scheduler = null;
    this.onContextLost = null;
    this.onContextRestored = null;

    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);

    disposeObject3D(this.scene);
    this.scene.clear();
    this.clippingPlanes.length = 0;

    this.renderer.dispose();
    // Frees the GPU context immediately instead of at GC time — browsers cap
    // live contexts and a dashboard cycles through many cards.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

function noop(): void {
  /* no scheduler attached yet */
}
