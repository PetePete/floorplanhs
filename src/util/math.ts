/** Small math helpers shared across engine subsystems. */

import type { Vec3 } from '@/types/config';

export const EPS = 1e-6;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/* --------------------------------------------------------------- easings */

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Slightly overshooting ease, used for marker pop-in. */
export function easeOutBack(t: number, overshoot = 1.4): number {
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + overshoot * Math.pow(t - 1, 2);
}

/* ------------------------------------------------------------------ vec3 */

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vLength(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function vDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function vLerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Round for YAML output — three decimals is well under a millimetre. */
export function vRound(a: Vec3, digits = 3): Vec3 {
  const f = Math.pow(10, digits);
  return [Math.round(a[0] * f) / f, Math.round(a[1] * f) / f, Math.round(a[2] * f) / f];
}

export function isVec3(value: unknown): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/* ------------------------------------------------------------------- ids */

let idCounter = 0;

/** Deterministic-enough unique id; no crypto dependency needed. */
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'item'
  );
}

/**
 * Is (x, z) inside a flat `[ax, az, bx, bz, cx, cz, …]` triangle list?
 *
 * `tolerance` is a real distance in metres, not an epsilon: a wall's inner face
 * is meant to land exactly on the room polygon it faces, but the two numbers
 * come from different places — a wall thickness and a traced outline — and
 * float arithmetic finishes the job. Pass 0 to ask the strict question.
 */
export function pointInTriangles(tri: Float32Array, x: number, z: number, tolerance = 0): boolean {
  for (let i = 0; i + 5 < tri.length; i += 6) {
    const ax = tri[i];
    const az = tri[i + 1];
    const bx = tri[i + 2];
    const bz = tri[i + 3];
    const cx = tri[i + 4];
    const cz = tri[i + 5];

    const d1 = edgeDistance(x, z, bx, bz, ax, az);
    const d2 = edgeDistance(x, z, cx, cz, bx, bz);
    const d3 = edgeDistance(x, z, ax, az, cx, cz);
    const hasNeg = d1 < -tolerance || d2 < -tolerance || d3 < -tolerance;
    const hasPos = d1 > tolerance || d2 > tolerance || d3 > tolerance;
    if (!(hasNeg && hasPos)) return true;
  }
  return false;
}

/** Signed distance from (x, z) to the line through (px, pz) and (qx, qz). */
function edgeDistance(
  x: number,
  z: number,
  px: number,
  pz: number,
  qx: number,
  qz: number,
): number {
  const dx = qx - px;
  const dz = qz - pz;
  const length = Math.hypot(dx, dz);
  const cross = (x - px) * dz - (z - pz) * dx;
  return length > EPS ? cross / length : cross;
}

