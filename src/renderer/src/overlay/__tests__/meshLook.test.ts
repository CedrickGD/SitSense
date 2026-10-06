import { describe, expect, it } from 'vitest'
import { MESH_INTENSITY_DEFAULT, meshDimsBackdrop, meshIntensityOf, meshLook } from '../meshLook'

describe('meshDimsBackdrop', () => {
  it('follows the backdrop setting, not the last style written (Lines → Mesh keeps the dim look)', () => {
    expect(meshDimsBackdrop({ style: 'mesh', meshBackdrop: 'dim' })).toBe(true)
    expect(meshDimsBackdrop({ style: 'mesh', meshBackdrop: 'camera' })).toBe(false)
    expect(meshDimsBackdrop({ style: 'mesh' })).toBe(false)
    // the backdrop only applies to the mesh
    expect(meshDimsBackdrop({ style: 'skeleton', meshBackdrop: 'dim' })).toBe(false)
    expect(meshDimsBackdrop({ style: 'off', meshBackdrop: 'dim' })).toBe(false)
  })
  it('reads the legacy hologram style as a dimmed mesh', () => {
    expect(meshDimsBackdrop({ style: 'hologram' })).toBe(true)
    expect(meshDimsBackdrop(null)).toBe(false)
  })
})

describe('meshIntensityOf', () => {
  it('defaults when the field is missing or garbage', () => {
    expect(meshIntensityOf({ style: 'mesh' })).toBe(MESH_INTENSITY_DEFAULT)
    expect(meshIntensityOf({ meshIntensity: 'loud' })).toBe(MESH_INTENSITY_DEFAULT)
    expect(meshIntensityOf({ meshIntensity: Number.NaN })).toBe(MESH_INTENSITY_DEFAULT)
    expect(meshIntensityOf(null)).toBe(MESH_INTENSITY_DEFAULT)
    expect(meshIntensityOf(undefined)).toBe(MESH_INTENSITY_DEFAULT)
  })

  it('clamps to 0.15–1', () => {
    expect(meshIntensityOf({ meshIntensity: 0.6 })).toBe(0.6)
    expect(meshIntensityOf({ meshIntensity: 0 })).toBe(0.15)
    expect(meshIntensityOf({ meshIntensity: 3 })).toBe(1)
  })
})

describe('meshLook', () => {
  it('at full intensity draws the classic glowing wireframe', () => {
    const l = meshLook(1)
    expect(l.spacing).toBe(1)
    expect(l.innerAlpha).toBeCloseTo(0.6)
    expect(l.outlineAlpha).toBeCloseTo(1)
    expect(l.faceAlpha).toBeCloseTo(0.42)
    expect(l.glowAlpha).toBeCloseTo(1)
    expect(l.bedAlpha).toBeCloseTo(0.2)
    expect(l.faceNodes).toBe(true)
  })

  it('by default keeps the person visible: faint thin lines, sparser lattice, no bloom, a whisper of face mesh', () => {
    const l = meshLook(MESH_INTENSITY_DEFAULT)
    const max = meshLook(1)
    expect(l.glowAlpha).toBe(0)
    expect(l.spacing).toBeGreaterThan(1.3)
    expect(l.innerAlpha).toBeLessThanOrEqual(0.35)
    expect(l.innerWidth).toBeLessThan(max.innerWidth)
    expect(l.outlineAlpha).toBeLessThan(0.7)
    expect(l.outlineWidth).toBeLessThan(max.outlineWidth)
    expect(l.faceAlpha).toBeLessThanOrEqual(0.2)
    expect(l.faceAlpha).toBeLessThan(l.innerAlpha)
    expect(l.faceNodes).toBe(false)
    expect(l.bedAlpha).toBeLessThan(0.1)
  })

  it('grows monotonically with intensity', () => {
    const keys = ['innerAlpha', 'outlineAlpha', 'faceAlpha', 'featureAlpha', 'nodeAlpha', 'glowAlpha', 'innerWidth', 'outlineWidth', 'sweep'] as const
    let prev = meshLook(0.15)
    for (let i = 0.2; i <= 1.0001; i += 0.05) {
      const l = meshLook(i)
      for (const k of keys) expect(l[k]).toBeGreaterThanOrEqual(prev[k] - 1e-9)
      expect(l.spacing).toBeLessThanOrEqual(prev.spacing + 1e-9)
      prev = l
    }
  })

  it('clamps out-of-range and non-finite intensities', () => {
    expect(meshLook(-4)).toEqual(meshLook(0.15))
    expect(meshLook(9)).toEqual(meshLook(1))
    expect(meshLook(Number.NaN)).toEqual(meshLook(MESH_INTENSITY_DEFAULT))
  })

  it('hologram keeps a soft glow and slightly brighter lines, never above full alpha', () => {
    const plain = meshLook(MESH_INTENSITY_DEFAULT)
    const holo = meshLook(MESH_INTENSITY_DEFAULT, true)
    expect(holo.glowAlpha).toBeGreaterThan(0)
    expect(holo.innerAlpha).toBeGreaterThan(plain.innerAlpha)
    expect(holo.spacing).toBe(plain.spacing)
    const top = meshLook(1, true)
    for (const k of ['innerAlpha', 'outlineAlpha', 'faceAlpha', 'featureAlpha', 'nodeAlpha', 'sweep'] as const) {
      expect(top[k]).toBeLessThanOrEqual(1)
    }
  })
})
