// Tiny 3D vector helpers for the detection core (pure, allocation-light).
// Vectors are plain [x, y, z] tuples so they serialize into the baseline as-is.

import type { Vec3 } from '@shared/posture'

export type { Vec3 }

export const DEG = 180 / Math.PI
export const RAD = Math.PI / 180

export const vec = (x: number, y: number, z: number): Vec3 => [x, y, z]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])

/** Unit vector, or null when the input is (numerically) zero or not finite. */
export function unit(a: Vec3, eps = 1e-9): Vec3 | null {
  const n = norm(a)
  if (!(n > eps) || !Number.isFinite(n)) return null
  return [a[0] / n, a[1] / n, a[2] / n]
}

/** `v` with its component along the unit axis `u` removed. */
export const reject = (v: Vec3, u: Vec3): Vec3 => sub(v, scale(u, dot(v, u)))

/** Unsigned angle between two vectors, degrees in [0, 180]. */
export function angleDeg(a: Vec3, b: Vec3): number {
  const na = norm(a)
  const nb = norm(b)
  if (na === 0 || nb === 0) return NaN
  return Math.acos(clamp(dot(a, b) / (na * nb), -1, 1)) * DEG
}

/**
 * Angle of `v` away from axis `a` toward axis `b`, degrees: atan2(v·b, v·a)
 * (docs/specs/detection.md §3.4). `a` and `b` should be orthonormal.
 */
export const tiltDeg = (v: Vec3, a: Vec3, b: Vec3): number => Math.atan2(dot(v, b), dot(v, a)) * DEG

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const isFiniteVec = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

/** Wrap an angle in degrees to (−180, 180]. */
export function wrapDeg(a: number): number {
  let r = a % 360
  if (r <= -180) r += 360
  if (r > 180) r -= 360
  return r
}

/** Rotate `v` about the unit axis `k` by `deg` (right-hand rule, Rodrigues). */
export function rotate(v: Vec3, k: Vec3, deg: number): Vec3 {
  const t = deg * RAD
  const c = Math.cos(t)
  const s = Math.sin(t)
  const kv = cross(k, v)
  const kd = dot(k, v) * (1 - c)
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd]
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Mean of the central values after dropping `trim` of each tail (default 20%).
 * Nearly as robust to outliers as the median, and ~25% more precise for Gaussian noise.
 */
export function trimmedMean(values: readonly number[], trim = 0.2): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  const k = Math.floor(s.length * trim)
  const mid = s.slice(k, s.length - k)
  return mid.reduce((a, b) => a + b, 0) / mid.length
}
