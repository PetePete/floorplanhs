/**
 * Frame-driven tween engine.
 *
 * Nothing in here schedules its own `requestAnimationFrame`: the render loop
 * owns timing and hands each subsystem a `dt`. That is what keeps animation
 * honest under the on-demand loop — a tween only advances while somebody holds
 * a continuous lease, so a paused card cannot silently burn battery.
 *
 * Camera flights interpolate the orbit **spherically around the target**
 * (radius / phi / theta) instead of lerping the position vector: a straight
 * line between two orbit positions dives through the middle of the house and
 * looks broken. See `tweenOrbit`.
 */

import * as THREE from 'three';
import { clamp, easeInOutCubic, lerp } from '@/util/math';

export type Easing = (t: number) => number;

export type TweenStatus = 'running' | 'done' | 'cancelled';

/** Anything a {@link TweenRunner} can drive. */
export interface TickingTween {
  /** Advance by `dt` seconds; returns true while the tween is still running. */
  update(dt: number): boolean;
  cancel(): void;
  readonly running: boolean;
}

/** Pure interpolation. Implementations may return a reused scratch object. */
export type TweenInterpolator<T> = (from: T, to: T, t: number) => T;

export interface TweenSpec<T> {
  from: T;
  to: T;
  /** Seconds. `<= 0` completes immediately. */
  duration: number;
  easing?: Easing;
  /** Seconds to wait before the first eased sample. */
  delay?: number;
  interpolate: TweenInterpolator<T>;
  onUpdate?: (value: T, t: number) => void;
  /** `completed` is false when the tween was cancelled. */
  onComplete?: (completed: boolean) => void;
}

/**
 * A single tween. Thenable, so `await tween` resolves when the animation ends —
 * cancellation resolves too rather than rejecting, because an interrupted
 * camera flight is a normal outcome, not an error.
 */
export class Tween<T> implements TickingTween, PromiseLike<void> {
  private readonly spec: TweenSpec<T>;
  private readonly settled: Promise<void>;
  private resolveSettled: () => void = () => {};
  private status: TweenStatus = 'running';
  private elapsed = 0;

  constructor(spec: TweenSpec<T>) {
    this.spec = spec;
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    if (spec.duration <= 0 && (spec.delay ?? 0) <= 0) {
      this.emit(1);
      this.finish(true);
    }
  }

  get running(): boolean {
    return this.status === 'running';
  }

  get cancelled(): boolean {
    return this.status === 'cancelled';
  }

  /** 0..1, unaffected by easing. */
  get progress(): number {
    const { duration } = this.spec;
    if (duration <= 0) return 1;
    return clamp((this.elapsed - (this.spec.delay ?? 0)) / duration, 0, 1);
  }

  update(dt: number): boolean {
    if (this.status !== 'running') return false;
    this.elapsed += dt;
    const delay = this.spec.delay ?? 0;
    if (this.elapsed < delay) return true;
    const t = this.progress;
    this.emit(t);
    if (t >= 1) {
      this.finish(true);
      return false;
    }
    return true;
  }

  cancel(): void {
    if (this.status !== 'running') return;
    this.status = 'cancelled';
    this.spec.onComplete?.(false);
    this.resolveSettled();
  }

  /** Jump straight to the end value and settle. */
  complete(): void {
    if (this.status !== 'running') return;
    this.emit(1);
    this.finish(true);
  }

  get promise(): Promise<void> {
    return this.settled;
  }

  then<R1 = void, R2 = never>(
    onfulfilled?: ((value: void) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.settled.then(onfulfilled, onrejected);
  }

  private emit(t: number): void {
    const eased = (this.spec.easing ?? easeInOutCubic)(t);
    this.spec.onUpdate?.(this.spec.interpolate(this.spec.from, this.spec.to, eased), t);
  }

  private finish(completed: boolean): void {
    this.status = 'done';
    this.spec.onComplete?.(completed);
    this.resolveSettled();
  }
}

/**
 * Owns a set of tweens and ticks them from a subsystem's `update(dt)`.
 * `update` returns true while anything is still animating, which is exactly the
 * signal a caller needs to decide when to drop its continuous lease.
 */
export class TweenRunner {
  private readonly tweens = new Set<TickingTween>();

  add<T extends TickingTween>(tween: T): T {
    if (tween.running) this.tweens.add(tween);
    return tween;
  }

  remove(tween: TickingTween): void {
    this.tweens.delete(tween);
  }

  get active(): number {
    return this.tweens.size;
  }

  update(dt: number): boolean {
    if (this.tweens.size === 0) return false;
    // Copy: a completion callback may add or cancel tweens.
    for (const tween of [...this.tweens]) {
      if (!tween.update(dt)) this.tweens.delete(tween);
    }
    return this.tweens.size > 0;
  }

  cancelAll(): void {
    for (const tween of [...this.tweens]) tween.cancel();
    this.tweens.clear();
  }

  dispose(): void {
    this.cancelAll();
  }
}

/* --------------------------------------------------------- interpolators */

export const lerpNumber: TweenInterpolator<number> = (a, b, t) => lerp(a, b, t);

/** Vector3 interpolator with a private scratch vector — allocation-free. */
export function lerpVector3(): TweenInterpolator<THREE.Vector3> {
  const out = new THREE.Vector3();
  return (a, b, t) => out.copy(a).lerp(b, t);
}

/** Shortest-arc quaternion interpolator with a private scratch quaternion. */
export function slerpQuaternion(): TweenInterpolator<THREE.Quaternion> {
  const out = new THREE.Quaternion();
  return (a, b, t) => out.copy(a).slerp(b, t);
}

/* ---------------------------------------------------------- constructors */

export interface TweenTail<T> {
  easing?: Easing;
  delay?: number;
  onComplete?: (completed: boolean) => void;
  onUpdate?: (value: T, t: number) => void;
}

export function tweenValue(
  from: number,
  to: number,
  duration: number,
  onUpdate: (value: number) => void,
  opts: Omit<TweenTail<number>, 'onUpdate'> = {},
): Tween<number> {
  return new Tween<number>({
    from,
    to,
    duration,
    easing: opts.easing,
    delay: opts.delay,
    interpolate: lerpNumber,
    onUpdate: (value) => onUpdate(value),
    onComplete: opts.onComplete,
  });
}

export function tweenVector3(
  from: THREE.Vector3,
  to: THREE.Vector3,
  duration: number,
  onUpdate: (value: THREE.Vector3) => void,
  opts: Omit<TweenTail<THREE.Vector3>, 'onUpdate'> = {},
): Tween<THREE.Vector3> {
  return new Tween<THREE.Vector3>({
    from: from.clone(),
    to: to.clone(),
    duration,
    easing: opts.easing,
    delay: opts.delay,
    interpolate: lerpVector3(),
    onUpdate: (value) => onUpdate(value),
    onComplete: opts.onComplete,
  });
}

export function tweenQuaternion(
  from: THREE.Quaternion,
  to: THREE.Quaternion,
  duration: number,
  onUpdate: (value: THREE.Quaternion) => void,
  opts: Omit<TweenTail<THREE.Quaternion>, 'onUpdate'> = {},
): Tween<THREE.Quaternion> {
  return new Tween<THREE.Quaternion>({
    from: from.clone(),
    to: to.clone(),
    duration,
    easing: opts.easing,
    delay: opts.delay,
    interpolate: slerpQuaternion(),
    onUpdate: (value) => onUpdate(value),
    onComplete: opts.onComplete,
  });
}

/* ------------------------------------------------------------ orbit flight */

/** One sampled frame of a camera flight. The vectors are reused — copy them. */
export interface OrbitFrame {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

export interface OrbitFlightSpec {
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
  duration: number;
  easing?: Easing;
  onUpdate: (frame: OrbitFrame, t: number) => void;
  onComplete?: (completed: boolean) => void;
}

/** Wrap an angle delta into (-PI, PI] so the camera takes the short way round. */
function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Fly the camera along a spherical arc around the (also moving) orbit target.
 *
 * Radius is interpolated geometrically rather than linearly: pulling out from
 * 2 m to 40 m linearly spends most of the flight already far away, which reads
 * as a lurch. `r0 * (r1/r0)^t` keeps the apparent zoom rate constant.
 */
export function tweenOrbit(spec: OrbitFlightSpec): Tween<OrbitFrame> {
  const fromOffset = spec.fromPosition.clone().sub(spec.fromTarget);
  const toOffset = spec.toPosition.clone().sub(spec.toTarget);

  const a = new THREE.Spherical().setFromVector3(fromOffset);
  const b = new THREE.Spherical().setFromVector3(toOffset);
  a.makeSafe();
  b.makeSafe();

  const radiusA = Math.max(a.radius, 1e-4);
  const radiusB = Math.max(b.radius, 1e-4);
  const thetaDelta = shortestAngle(a.theta, b.theta);

  const fromTarget = spec.fromTarget.clone();
  const toTarget = spec.toTarget.clone();

  const sph = new THREE.Spherical();
  const frame: OrbitFrame = { position: new THREE.Vector3(), target: new THREE.Vector3() };

  const interpolate: TweenInterpolator<OrbitFrame> = (_from, _to, t) => {
    frame.target.copy(fromTarget).lerp(toTarget, t);
    sph.radius = radiusA * Math.pow(radiusB / radiusA, t);
    sph.phi = lerp(a.phi, b.phi, t);
    sph.theta = a.theta + thetaDelta * t;
    frame.position.setFromSpherical(sph).add(frame.target);
    return frame;
  };

  return new Tween<OrbitFrame>({
    from: frame,
    to: frame,
    duration: spec.duration,
    easing: spec.easing,
    interpolate,
    onUpdate: spec.onUpdate,
    onComplete: spec.onComplete,
  });
}
