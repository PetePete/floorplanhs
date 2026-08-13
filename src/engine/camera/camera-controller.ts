/**
 * Orbit camera: OrbitControls plus preset flights, a perspective/orthographic
 * "flatten to floorplan" transition, framing and idle return.
 *
 * Two things here are subtler than they look:
 *
 * 1. **Damping under an on-demand render loop.** `enableDamping` only settles
 *    while `update()` is called, and `update()` is only called while frames are
 *    rendered. So every source of motion (user input, damping tail, auto-rotate,
 *    a flight) registers a *reason* and we hold exactly one continuous lease
 *    while any reason is live. Drop the lease too early and damping visibly
 *    stutters; never drop it and the card renders forever.
 * 2. **Flights are spherical.** See `tweenOrbit` — a linear lerp between two
 *    orbit positions flies the camera through the house.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraConfig, CameraPreset, Vec3 } from '@/types/config';
import { DEFAULT_CAMERA_CONFIG } from '@/types/config';
import type { ICameraController, RenderContext } from '@/engine/contracts';
import { clamp, degToRad, easeInOutCubic, easeOutCubic, uid, vRound } from '@/util/math';
import { throttle } from '@/util/events';
import {
  Tween,
  TweenRunner,
  tweenOrbit,
  tweenValue,
  type OrbitFrame,
} from '@/engine/camera/tween';
import {
  ViewCube,
  type ViewCubeCameraBridge,
  type ViewCubeOptions,
} from '@/engine/camera/view-cube';

/** Narrow enough that the residual perspective is invisible, wide enough to be stable. */
const FLATTEN_FOV = 12;
/** Fraction of a preset transition spent on the projection change. */
const PROJECTION_SHARE = 0.55;
const CHANGE_THROTTLE_MS = 60;
const FRAME_MARGIN = 1.12;

type ContinuousReason = 'flight' | 'damping' | 'interaction' | 'rotate' | 'projection';

type OrbitCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/**
 * How we ask the render core to swap the rendered camera. `RenderContext`
 * exposes `activeCamera` read-only on purpose; RenderCore drives it from a
 * `setOrthographic()` flag, which is the path we prefer.
 */
interface ActiveCameraSink {
  setOrthographic?: (enabled: boolean) => void;
  setActiveCamera?: (camera: THREE.Camera) => void;
  activeCamera: THREE.Camera;
}

let warnedActiveCamera = false;

/** Scratch for the zoom ray; avoids allocating on every slider frame. */
const _zoomDir = new THREE.Vector3();
const _fitSphere = new THREE.Sphere();

export class CameraController implements ICameraController {
  private ctx: RenderContext | null = null;
  private orbit: OrbitControls | null = null;
  private cfg = { ...DEFAULT_CAMERA_CONFIG };

  private readonly runner = new TweenRunner();
  private flight: Tween<OrbitFrame> | null = null;
  private fovTween: Tween<number> | null = null;
  private zoomTween: Tween<number> | null = null;

  private ortho = false;
  private bounds: THREE.Box3 | null = null;
  private defaultPreset: CameraPreset | null = null;
  private currentPresetId: string | null = null;

  private readonly reasons = new Set<ContinuousReason>();
  private release: (() => void) | null = null;

  private readonly changeCallbacks = new Set<() => void>();
  private readonly emitChange = throttle(() => {
    for (const cb of [...this.changeCallbacks]) cb();
  }, CHANGE_THROTTLE_MS);

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** Used while the projection transition needs to pull the camera far out. */
  private savedMaxDistance: number | null = null;

  private readonly fallbackControls = { enabled: true, target: new THREE.Vector3() };

  private viewCube: ViewCube | null = null;
  private readonly viewCubeOptions: ViewCubeOptions;
  private viewCubeVisible = true;

  constructor(config: CameraConfig = {}, viewCube: ViewCubeOptions = {}) {
    this.applyConfigValues(config);
    this.viewCubeOptions = viewCube;
  }

  /**
   * Everything the ViewCube needs, expressed against the live orbit rig rather
   * than a snapshot — the cube is redrawn every frame.
   */
  private readonly viewCubeBridge: ViewCubeCameraBridge = {
    getViewDirection: (out) => {
      const target = this.orbit?.target ?? this.fallbackControls.target;
      out.subVectors(this.activeCamera().position, target);
      if (out.lengthSq() < 1e-8) out.set(0, 0.5, 1);
      return out.normalize();
    },
    getUp: (out) => out.copy(this.activeCamera().up),
    snapTo: (direction, animate) => this.snapToDirection(direction, animate),
    orbitBy: (deltaTheta, deltaPhi) => this.orbitBy(deltaTheta, deltaPhi),
    holdContinuous: () => {
      this.addReason('interaction');
      return () => this.clearReason('interaction');
    },
    invalidate: () => this.ctx?.invalidate(),
  };

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;

    const controls = new OrbitControls(ctx.camera, ctx.canvas);
    controls.enableDamping = true;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    this.orbit = controls;

    // Chrome opens its autoscroll widget on middle-button press, which would
    // fight the orbit gesture. Suppressing the default here is enough; the
    // canvas already has `touch-action: none` for the touch side.
    ctx.canvas.addEventListener('pointerdown', this.onCanvasPointerDown);
    ctx.canvas.addEventListener('auxclick', this.onCanvasAuxClick);

    controls.addEventListener('start', this.onControlsStart);
    controls.addEventListener('change', this.onControlsChange);
    controls.addEventListener('end', this.onControlsEnd);

    this.applyConfigToControls();
    this.applyProjectionParams();
    controls.update();

    // Start in the configured projection even when there is no preset at all,
    // or when the default preset does not mention one.
    if (this.cfg.projection !== 'perspective') void this.setOrthographic(true, false);

    // Built here, not in the constructor: subsystems must not touch three.js
    // before they have a render context.
    this.viewCube = new ViewCube(this.viewCubeBridge, this.viewCubeOptions);
    this.viewCube.init(ctx);
    this.viewCube.setVisible(this.viewCubeVisible);
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const controls = this.orbit;
    if (!ctx || !controls) return;

    const animating = this.runner.update(dt);
    const moved = controls.update(dt);

    // Keep the idle camera in step so anything reading ctx.camera/orthoCamera
    // directly (screenshots, raycasts) sees a sane transform after a swap.
    this.syncInactiveCamera();

    if (moved) {
      ctx.invalidate();
      this.emitChange();
    } else if (!animating) {
      this.clearReason('damping');
    }

    if (!animating) this.clearReason('flight');
  }

  resize(width: number, height: number): void {
    if (!this.ctx || height <= 0) return;
    const aspect = width / height;
    this.ctx.camera.aspect = aspect;
    this.ctx.camera.updateProjectionMatrix();
    this.updateOrthoFrustum(aspect);
    this.ctx.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelFlight();
    this.runner.dispose();
    this.emitChange.cancel();
    this.clearIdleTimer();
    this.viewCube?.dispose();
    this.viewCube = null;
    if (this.ctx) {
      this.ctx.canvas.removeEventListener('pointerdown', this.onCanvasPointerDown);
      this.ctx.canvas.removeEventListener('auxclick', this.onCanvasAuxClick);
    }
    if (this.orbit) {
      this.orbit.removeEventListener('start', this.onControlsStart);
      this.orbit.removeEventListener('change', this.onControlsChange);
      this.orbit.removeEventListener('end', this.onControlsEnd);
      this.orbit.dispose();
      this.orbit = null;
    }
    this.reasons.clear();
    if (this.release) {
      this.release();
      this.release = null;
    }
    this.changeCallbacks.clear();
    this.ctx = null;
  }

  /* ----------------------------------------------------------- public API */

  get controls(): { enabled: boolean; target: THREE.Vector3 } & Record<string, unknown> {
    const controls = this.orbit ?? this.fallbackControls;
    return controls as unknown as { enabled: boolean; target: THREE.Vector3 } & Record<
      string,
      unknown
    >;
  }

  /** Re-apply a (possibly partial) camera config, e.g. after a YAML edit. */
  setConfig(config: CameraConfig): void {
    this.applyConfigValues(config);
    this.applyConfigToControls();
    this.applyProjectionParams();
    this.scheduleIdleReturn();
    this.ctx?.invalidate();
  }

  /**
   * Model bounds drive the pan clamp and the default framing. Without this the
   * user can pan the house off-screen and never find it again.
   */
  setBounds(bounds: THREE.Box3): void {
    this.bounds = bounds.clone();
    if (!this.orbit || bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    this.orbit.cursor.copy(sphere.center);
    this.orbit.maxTargetRadius = Math.max(sphere.radius * 1.25, 2);
  }

  /** Preset the camera returns to when `idleReturnAfter` elapses. */
  setDefaultPreset(preset: CameraPreset | null): void {
    this.defaultPreset = preset ? { ...preset } : null;
    this.scheduleIdleReturn();
  }

  /** Id of the last preset applied, for the tour and for UI highlighting. */
  getCurrentPresetId(): string | null {
    return this.currentPresetId;
  }

  async applyPreset(preset: CameraPreset, animate = true): Promise<void> {
    const ctx = this.ctx;
    const controls = this.orbit;
    if (!ctx || !controls) return;

    this.currentPresetId = preset.id;
    // A preset that says nothing about projection follows `camera.projection`
    // rather than silently meaning "perspective". That is what makes isometric
    // an actual default instead of something every preset has to opt into.
    const wantOrtho = preset.orthographic ?? this.cfg.projection !== 'perspective';
    const full = animate ? Math.max(this.cfg.transitionDuration, 0) : 0;

    if (wantOrtho !== this.ortho) {
      await this.setOrthographic(wantOrtho, animate);
      if (this.disposed) return;
    }

    const flightDuration = full > 0 && wantOrtho !== this.ortho ? full * (1 - PROJECTION_SHARE) : full;

    if (!wantOrtho && preset.fov !== undefined) {
      this.tweenFov(preset.fov, flightDuration);
    }
    if (wantOrtho && preset.orthoZoom !== undefined) {
      this.tweenZoom(preset.orthoZoom, flightDuration);
    } else if (wantOrtho) {
      // No zoom saved: fit the building instead of keeping whatever zoom the
      // camera happened to be at. A hard-coded number only ever suits the house
      // it was measured on — this works for any model, at any card size.
      const fitted = this.orthoZoomToFit();
      if (fitted !== null) this.tweenZoom(fitted, flightDuration);
    }

    await this.flyTo(toVector(preset.position), toVector(preset.target), flightDuration);
  }

  capture(name: string): CameraPreset {
    const camera = this.activeCamera();
    const target = this.orbit?.target ?? this.fallbackControls.target;
    const preset: CameraPreset = {
      id: uid('preset'),
      name,
      position: vRound([camera.position.x, camera.position.y, camera.position.z] as Vec3),
      target: vRound([target.x, target.y, target.z] as Vec3),
      fov: round(this.ctx?.camera.fov ?? this.cfg.fov, 2),
    };
    if (this.ortho) {
      preset.orthographic = true;
      preset.orthoZoom = round(this.ctx?.orthoCamera.zoom ?? 1, 4);
    }
    return preset;
  }

  frameObject(object: THREE.Object3D | THREE.Box3, animate = true): void {
    const ctx = this.ctx;
    const controls = this.orbit;
    if (!ctx || !controls) return;

    const box = object instanceof THREE.Box3 ? object.clone() : new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.25);
    const aspect = this.aspect();

    const direction = new THREE.Vector3().subVectors(this.activeCamera().position, controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(-0.75, 0.55, 1);
    direction.normalize();

    const vFov = degToRad(ctx.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const distance = clamp(
      Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * FRAME_MARGIN,
      this.cfg.minDistance,
      this.cfg.maxDistance,
    );

    const duration = animate ? this.cfg.transitionDuration : 0;

    if (this.ortho) {
      const height = (2 * radius * FRAME_MARGIN) / Math.min(1, aspect);
      this.tweenZoom(2 / height, duration);
      // Distance is framing-neutral in orthographic; keep the camera clear of
      // the near plane instead.
      const position = sphere.center.clone().addScaledVector(direction, Math.max(distance, radius * 3));
      void this.flyTo(position, sphere.center.clone(), duration);
      return;
    }

    const position = sphere.center.clone().addScaledVector(direction, distance);
    void this.flyTo(position, sphere.center.clone(), duration);
  }

  /**
   * Perspective <-> orthographic with identical framing across the switch.
   *
   * The visible height at the orbit target, `2 * d * tan(fov/2)`, is the
   * invariant. Animating the field of view down to a long lens while pulling the
   * camera back to hold that height *is* the flatten: by the time we swap the
   * projection matrix at 12 degrees, the two renders are indistinguishable.
   */
  async setOrthographic(enabled: boolean, animate = true): Promise<void> {
    const ctx = this.ctx;
    const controls = this.orbit;
    if (!ctx || !controls || enabled === this.ortho) return;

    const duration = animate ? Math.max(this.cfg.transitionDuration * PROJECTION_SHARE, 0) : 0;
    const height = this.visibleHeight();

    this.cancelTween(this.fovTween);
    this.fovTween = null;

    if (duration <= 0) {
      this.commitProjection(enabled, height);
      return;
    }

    this.addReason('projection');
    this.savedMaxDistance = controls.maxDistance;
    controls.maxDistance = Math.max(controls.maxDistance, this.distanceForFov(height, FLATTEN_FOV) * 1.2);

    const startFov = enabled ? ctx.camera.fov : FLATTEN_FOV;
    const endFov = enabled ? FLATTEN_FOV : (this.cfg.fov ?? DEFAULT_CAMERA_CONFIG.fov);

    if (!enabled) {
      // Come back as a very long lens first so the frame does not pop.
      this.commitProjection(false, height, FLATTEN_FOV);
    }

    const tween = tweenValue(
      startFov,
      endFov,
      duration,
      (fov) => {
        ctx.camera.fov = fov;
        ctx.camera.updateProjectionMatrix();
        this.setDistance(this.distanceForFov(height, fov));
        ctx.invalidate();
      },
      {
        easing: easeInOutCubic,
        onComplete: () => {
          this.fovTween = null;
          if (enabled) this.commitProjection(true, height);
          else {
            ctx.camera.fov = endFov;
            ctx.camera.updateProjectionMatrix();
            this.setDistance(this.distanceForFov(height, endFov));
          }
          if (this.savedMaxDistance !== null && this.orbit) {
            this.orbit.maxDistance = this.savedMaxDistance;
            this.savedMaxDistance = null;
          }
          this.clearReason('projection');
          ctx.invalidate();
        },
      },
    );
    this.fovTween = tween;
    this.runner.add(tween);
    await tween.promise;
  }

  isOrthographic(): boolean {
    return this.ortho;
  }

  setAutoRotate(enabled: boolean): void {
    if (!this.orbit) return;
    this.orbit.autoRotate = enabled;
    if (enabled) this.addReason('rotate');
    else this.clearReason('rotate');
    this.ctx?.invalidate();
  }

  setEnabled(enabled: boolean): void {
    if (!this.orbit) return;
    this.orbit.enabled = enabled;
    if (!enabled) this.clearReason('interaction');
  }

  onChange(cb: () => void): () => void {
    this.changeCallbacks.add(cb);
    return () => {
      this.changeCallbacks.delete(cb);
    };
  }

  /** Reset the idle-return countdown; call when any other UI is used. */
  notifyInteraction(): void {
    this.scheduleIdleReturn();
  }

  /* ---------------------------------------------------------------- gizmos */

  /**
   * Draw the camera's screen-space gizmos (currently the ViewCube).
   *
   * The viewer must call this once per frame **after** the main pass and after
   * `PostFx.render()`: the cube renders itself into a scissored corner rect
   * with `autoClear = false`, which is what keeps it out of bloom and tone
   * mapping. Calling it earlier would let the main render overwrite it.
   */
  renderOverlay(): void {
    this.viewCube?.render();
  }

  setViewCubeVisible(visible: boolean): void {
    this.viewCubeVisible = visible;
    this.viewCube?.setVisible(visible);
  }

  isViewCubeVisible(): boolean {
    return this.viewCubeVisible;
  }

  /** True while the user is dragging the cube; the pointer belongs to it. */
  isViewCubeActive(): boolean {
    return this.viewCube?.isDragging() === true;
  }

  /**
   * Fly to a world-space viewing direction, keeping the current target and
   * distance. Used by the ViewCube; the polar clamp is applied here so a click
   * on "Bottom" lands just above the ground plane instead of somewhere
   * OrbitControls will immediately snap away from.
   */
  private snapToDirection(direction: THREE.Vector3, animate: boolean): Promise<void> {
    const controls = this.orbit;
    if (!controls || !this.ctx) return Promise.resolve();

    const target = controls.target.clone();
    const distance = clamp(
      this.activeCamera().position.distanceTo(target),
      this.cfg.minDistance,
      this.cfg.maxDistance,
    );

    const spherical = new THREE.Spherical().setFromVector3(direction.clone().normalize());
    spherical.phi = this.clampPolar(spherical.phi);
    spherical.radius = distance;

    const position = target.clone().add(new THREE.Vector3().setFromSpherical(spherical));
    this.scheduleIdleReturn();
    return this.flyTo(position, target, animate ? this.cfg.transitionDuration : 0);
  }

  /** Direct 1:1 orbit, used by a ViewCube drag. Mirrors OrbitControls' signs. */
  private orbitBy(deltaTheta: number, deltaPhi: number): void {
    const controls = this.orbit;
    const ctx = this.ctx;
    if (!controls || !ctx) return;
    this.cancelFlight();

    const camera = this.activeCamera();
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= deltaTheta;
    spherical.phi = this.clampPolar(spherical.phi - deltaPhi);

    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    controls.update();
    this.syncInactiveCamera();
    ctx.invalidate();
    this.emitChange();
    this.scheduleIdleReturn();
  }

  private clampPolar(phi: number): number {
    const controls = this.orbit;
    const min = Math.max(controls?.minPolarAngle ?? 0, 0.02);
    const max = Math.min(controls?.maxPolarAngle ?? Math.PI, Math.PI - 0.02);
    return clamp(phi, min, Math.max(min, max));
  }

  /* ------------------------------------------------------------- internals */

  private readonly onControlsStart = (): void => {
    this.addReason('interaction');
    // A user grabbing the camera always wins over a running flight.
    this.cancelFlight();
    this.scheduleIdleReturn();
  };

  private readonly onControlsChange = (): void => {
    this.addReason('damping');
    this.ctx?.invalidate();
    this.emitChange();
  };

  private readonly onControlsEnd = (): void => {
    this.clearReason('interaction');
    this.scheduleIdleReturn();
  };

  private applyConfigValues(config: CameraConfig): void {
    const merged = { ...this.cfg };
    for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
      const value = config[key];
      if (value !== undefined && value !== null) {
        // Same key on both sides, so the value type matches by construction;
        // TypeScript cannot see that through the mapped-key loop.
        (merged[key] as unknown) = value;
      }
    }
    this.cfg = merged;
  }

  private readonly onCanvasPointerDown = (event: PointerEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  private readonly onCanvasAuxClick = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  private applyConfigToControls(): void {
    const controls = this.orbit;
    if (!controls) return;
    controls.minDistance = this.cfg.minDistance;
    controls.maxDistance = this.cfg.maxDistance;
    controls.maxPolarAngle = clamp(this.cfg.maxPolarAngle, 0.05, Math.PI / 2 - 0.01);
    controls.dampingFactor = clamp(this.cfg.damping, 0.01, 1);
    controls.autoRotateSpeed = this.cfg.autoRotateSpeed;
    this.setAutoRotate(this.cfg.autoRotate);
    this.applyNavigationMode();

    // Orthographic dollying is a zoom, not a distance; mirror the perspective
    // limits so both projections feel like the same camera.
    const tanHalf = Math.tan(degToRad(this.cfg.fov) / 2);
    const reference = this.orthoRefHeight() / 2;
    controls.minZoom = reference / (this.cfg.maxDistance * tanHalf);
    controls.maxZoom = reference / (this.cfg.minDistance * tanHalf);
  }

  /**
   * Mouse mapping. In `cad` mode the left button drives nothing at all, which
   * is the whole point: it belongs to selection and to dragging entities onto
   * the model. Navigation moves to the wheel button, the way Fusion, Inventor
   * and SolidWorks do it, so a mis-aimed click can never spin the view.
   *
   * Touch is deliberately untouched — a tablet has no middle button, and the
   * one-finger-orbit / two-finger-pan mapping is already the right one there.
   */
  private applyNavigationMode(): void {
    const controls = this.orbit;
    if (!controls) return;

    if (this.cfg.navigation === 'orbit') {
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
      controls.screenSpacePanning = false;
      return;
    }

    controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    // CAD panning follows the cursor across the screen rather than sliding
    // along the ground plane; sliding feels wrong once the camera is low.
    controls.screenSpacePanning = true;
  }

  private applyProjectionParams(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.camera.fov = this.cfg.fov;
    ctx.camera.near = this.cfg.near;
    ctx.camera.far = this.cfg.far;
    ctx.camera.updateProjectionMatrix();
    ctx.orthoCamera.near = this.cfg.near;
    ctx.orthoCamera.far = this.cfg.far;
    this.updateOrthoFrustum(this.aspect());
  }

  /**
   * Only the horizontal extent follows the viewport; the frustum height is left
   * alone and `zoom` carries the framing — which is also the knob OrbitControls
   * turns in orthographic mode, and the one the render core preserves.
   */
  private updateOrthoFrustum(aspect: number): void {
    const camera = this.ctx?.orthoCamera;
    if (!camera) return;
    const halfHeight = this.orthoRefHeight() / 2;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.updateProjectionMatrix();
  }

  /** Frustum height at zoom 1. The render core may rewrite it, so never assume. */
  /**
   * Zoom as 0..1, where 1 is closest. Logarithmic, because distance is: a
   * linear slider spends most of its travel in the far half, where nothing
   * visibly changes, and crosses the interesting near range in a few pixels.
   */
  getZoom01(): number {
    const controls = this.orbit;
    if (!controls) return 0.5;

    if (this.ortho) {
      const camera = this.ctx?.orthoCamera;
      if (!camera) return 0.5;
      const lo = Math.log(Math.max(controls.minZoom, 1e-4));
      const hi = Math.log(Math.max(controls.maxZoom, controls.minZoom * 1.0001));
      return clamp((Math.log(Math.max(camera.zoom, 1e-4)) - lo) / (hi - lo), 0, 1);
    }

    const lo = Math.log(Math.max(this.cfg.minDistance, 1e-3));
    const hi = Math.log(Math.max(this.cfg.maxDistance, this.cfg.minDistance * 1.0001));
    const t = (Math.log(Math.max(controls.getDistance(), 1e-3)) - lo) / (hi - lo);
    return clamp(1 - t, 0, 1);
  }

  setZoom01(value: number): void {
    const controls = this.orbit;
    const ctx = this.ctx;
    if (!controls || !ctx) return;
    const v = clamp(value, 0, 1);

    if (this.ortho) {
      const lo = Math.log(Math.max(controls.minZoom, 1e-4));
      const hi = Math.log(Math.max(controls.maxZoom, controls.minZoom * 1.0001));
      ctx.orthoCamera.zoom = Math.exp(lo + (hi - lo) * v);
      ctx.orthoCamera.updateProjectionMatrix();
    } else {
      const lo = Math.log(Math.max(this.cfg.minDistance, 1e-3));
      const hi = Math.log(Math.max(this.cfg.maxDistance, this.cfg.minDistance * 1.0001));
      const distance = Math.exp(lo + (hi - lo) * (1 - v));
      // Move along the current view ray so the framing only changes in depth.
      const camera = this.activeCamera();
      _zoomDir.subVectors(camera.position, controls.target);
      if (_zoomDir.lengthSq() < 1e-8) _zoomDir.set(0, 0.5, 1);
      _zoomDir.setLength(distance);
      camera.position.copy(controls.target).add(_zoomDir);
    }

    controls.update();
    this.syncInactiveCamera();
    ctx.invalidate();
    this.emitChange();
  }

  /**
   * Orthographic zoom that fits the whole model, or null when the bounds are
   * not known yet. Uses the bounding sphere so the answer does not change as
   * the camera orbits — a box would need refitting from every angle.
   */
  private orthoZoomToFit(): number | null {
    const ctx = this.ctx;
    const bounds = this.bounds;
    if (!ctx || !bounds || bounds.isEmpty()) return null;

    const diameter = bounds.getBoundingSphere(_fitSphere).radius * 2 * FRAME_MARGIN;
    if (!(diameter > 0)) return null;

    const reference = this.orthoRefHeight();
    const aspect = ctx.size.width / Math.max(ctx.size.height, 1);
    // Visible height is reference / zoom, width is that times the aspect. The
    // narrower of the two decides.
    const zoom = (reference * Math.min(1, aspect)) / diameter;
    return clamp(zoom, this.orbit?.minZoom ?? 0.01, this.orbit?.maxZoom ?? 100);
  }

  private orthoRefHeight(): number {
    const camera = this.ctx?.orthoCamera;
    if (!camera) return 2;
    const height = camera.top - camera.bottom;
    return height > 1e-6 ? height : 2;
  }

  private aspect(): number {
    const size = this.ctx?.size;
    if (!size || size.height <= 0) return 1;
    return size.width / size.height;
  }

  private activeCamera(): OrbitCamera {
    if (!this.ctx) return this.fallbackCamera;
    return this.ortho ? this.ctx.orthoCamera : this.ctx.camera;
  }

  private readonly fallbackCamera = new THREE.PerspectiveCamera();

  /** World height visible at the orbit target, in either projection. */
  private visibleHeight(): number {
    const ctx = this.ctx;
    const controls = this.orbit;
    if (!ctx || !controls) return 2;
    if (this.ortho) return this.orthoRefHeight() / Math.max(ctx.orthoCamera.zoom, 1e-4);
    const distance = ctx.camera.position.distanceTo(controls.target);
    return 2 * distance * Math.tan(degToRad(ctx.camera.fov) / 2);
  }

  private distanceForFov(height: number, fov: number): number {
    return height / (2 * Math.tan(degToRad(fov) / 2));
  }

  private setDistance(distance: number): void {
    const controls = this.orbit;
    if (!controls) return;
    const camera = this.activeCamera();
    const direction = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, 1);
    camera.position.copy(controls.target).addScaledVector(direction.normalize(), distance);
  }

  private commitProjection(enabled: boolean, height: number, fovOverride?: number): void {
    const ctx = this.ctx;
    const controls = this.orbit;
    if (!ctx || !controls) return;

    const from = this.ortho ? ctx.orthoCamera : ctx.camera;
    const to = enabled ? (ctx.orthoCamera as OrbitCamera) : (ctx.camera as OrbitCamera);

    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);

    if (enabled) {
      ctx.orthoCamera.zoom = this.orthoRefHeight() / Math.max(height, 1e-4);
      this.updateOrthoFrustum(this.aspect());
      // Framing no longer depends on distance; back off so nothing crosses the
      // near plane while orbiting.
      const radius = this.bounds && !this.bounds.isEmpty()
        ? this.bounds.getBoundingSphere(new THREE.Sphere()).radius
        : height;
      this.ortho = true;
      this.setDistance(Math.max(radius * 3, height * 2, this.cfg.minDistance));
    } else {
      ctx.camera.fov = fovOverride ?? this.cfg.fov;
      ctx.camera.updateProjectionMatrix();
      this.ortho = false;
      this.setDistance(this.distanceForFov(height, ctx.camera.fov));
    }

    controls.object = to;
    this.publishActiveCamera(to);
    controls.update();
    ctx.invalidate();
    this.emitChange();
  }

  /**
   * The render core owns `RenderContext.activeCamera`; it either offers a
   * setter or exposes a writable field. Anything else and we keep both cameras
   * in sync but cannot switch — worth one warning, not a crash.
   */
  private publishActiveCamera(camera: THREE.Camera): void {
    const sink = this.ctx as unknown as ActiveCameraSink | null;
    if (!sink) return;
    if (typeof sink.setOrthographic === 'function') {
      sink.setOrthographic(this.ortho);
      return;
    }
    if (typeof sink.setActiveCamera === 'function') {
      sink.setActiveCamera(camera);
      return;
    }
    try {
      sink.activeCamera = camera;
    } catch {
      if (!warnedActiveCamera) {
        warnedActiveCamera = true;
        console.warn(
          '[floorplan-3d] render context does not allow switching activeCamera; ' +
            'orthographic mode will not be shown.',
        );
      }
    }
  }

  private syncInactiveCamera(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const idle: OrbitCamera = this.ortho ? ctx.camera : ctx.orthoCamera;
    const active = this.activeCamera();
    idle.position.copy(active.position);
    idle.quaternion.copy(active.quaternion);
  }

  private flyTo(position: THREE.Vector3, target: THREE.Vector3, duration: number): Promise<void> {
    const ctx = this.ctx;
    const controls = this.orbit;
    if (!ctx || !controls) return Promise.resolve();

    const camera = this.activeCamera();
    const interrupted = this.flight !== null;
    this.cancelFlight();

    if (duration <= 0) {
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
      this.syncInactiveCamera();
      ctx.invalidate();
      this.emitChange();
      return Promise.resolve();
    }

    const tween = tweenOrbit({
      fromPosition: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPosition: position,
      toTarget: target,
      duration,
      // Picking up mid-flight: start fast so the new flight continues the old
      // one's motion instead of stalling at the seam.
      easing: interrupted ? easeOutCubic : easeInOutCubic,
      onUpdate: (frame) => {
        camera.position.copy(frame.position);
        controls.target.copy(frame.target);
        controls.update();
        ctx.invalidate();
      },
      onComplete: () => {
        this.flight = null;
        this.clearReason('flight');
        this.emitChange();
      },
    });

    this.flight = tween;
    this.runner.add(tween);
    this.addReason('flight');
    return tween.promise;
  }

  private cancelFlight(): void {
    if (!this.flight) return;
    const flight = this.flight;
    this.flight = null;
    this.runner.remove(flight);
    flight.cancel();
    this.clearReason('flight');
  }

  private cancelTween(tween: Tween<number> | null): void {
    if (!tween) return;
    this.runner.remove(tween);
    tween.cancel();
  }

  private tweenFov(fov: number, duration: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.cancelTween(this.fovTween);
    this.fovTween = null;
    if (duration <= 0) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
      ctx.invalidate();
      return;
    }
    const tween = tweenValue(ctx.camera.fov, fov, duration, (value) => {
      ctx.camera.fov = value;
      ctx.camera.updateProjectionMatrix();
      ctx.invalidate();
    });
    this.fovTween = tween;
    this.runner.add(tween);
  }

  private tweenZoom(zoom: number, duration: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.cancelTween(this.zoomTween);
    this.zoomTween = null;
    const controls = this.orbit;
    const clamped = controls ? clamp(zoom, controls.minZoom, controls.maxZoom) : zoom;
    if (duration <= 0) {
      ctx.orthoCamera.zoom = clamped;
      ctx.orthoCamera.updateProjectionMatrix();
      ctx.invalidate();
      return;
    }
    const tween = tweenValue(ctx.orthoCamera.zoom, clamped, duration, (value) => {
      ctx.orthoCamera.zoom = value;
      ctx.orthoCamera.updateProjectionMatrix();
      ctx.invalidate();
    });
    this.zoomTween = tween;
    this.runner.add(tween);
  }

  /* ------------------------------------------------------ continuous lease */

  private addReason(reason: ContinuousReason): void {
    if (this.reasons.has(reason)) return;
    this.reasons.add(reason);
    if (!this.release && this.ctx) this.release = this.ctx.holdContinuous();
  }

  private clearReason(reason: ContinuousReason): void {
    if (!this.reasons.delete(reason)) return;
    if (this.reasons.size === 0 && this.release) {
      this.release();
      this.release = null;
    }
  }

  /* ------------------------------------------------------------ idle return */

  private scheduleIdleReturn(): void {
    this.clearIdleTimer();
    const seconds = this.cfg.idleReturnAfter;
    if (!seconds || seconds <= 0 || !this.defaultPreset) return;
    // A wall-clock timer, not a frame counter: an idle card renders no frames.
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const preset = this.defaultPreset;
      if (!preset || this.disposed) return;
      void this.applyPreset(preset, true);
    }, seconds * 1000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function toVector(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]);
}

function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}
