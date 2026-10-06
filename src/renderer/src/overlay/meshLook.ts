// How strongly the body wireframe is drawn. The mesh may cover every body
// surface, but the person underneath has to stay recognizable: at the default
// intensity the lattice is sparse, its lines thin and faint, the face mesh a
// whisper and there is no bloom. Only at the top of the range does it turn
// into the full glowing wireframe. Pure, so it unit-tests without a canvas.

export const MESH_INTENSITY_MIN = 0.15
export const MESH_INTENSITY_MAX = 1
export const MESH_INTENSITY_DEFAULT = 0.4

/** settings.overlay.meshIntensity, read defensively (older settings files lack it). */
export function meshIntensityOf(overlay: unknown): number {
  const raw = overlay && typeof overlay === 'object' ? (overlay as { meshIntensity?: unknown }).meshIntensity : undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MESH_INTENSITY_DEFAULT
  return Math.min(MESH_INTENSITY_MAX, Math.max(MESH_INTENSITY_MIN, raw))
}

/**
 * Whether the mesh draws over a dimmed camera image: the backdrop is its own setting
 * (`overlay.meshBackdrop: 'camera' | 'dim'`), so switching the style can never clear it.
 * The legacy style value 'hologram' still reads as a dimmed mesh. Read defensively: older
 * settings files have no meshBackdrop.
 */
export function meshDimsBackdrop(overlay: unknown): boolean {
  if (!overlay || typeof overlay !== 'object') return false
  const o = overlay as { style?: unknown; meshBackdrop?: unknown }
  return o.style === 'hologram' || (o.style === 'mesh' && o.meshBackdrop === 'dim')
}

/** Everything the painter needs to know about line weight and effects. Widths are in CSS px. */
export interface MeshLook {
  /** lattice spacing multiplier for the mesh builder (1 = densest) */
  spacing: number
  /** face-mesh tessellation */
  faceWidth: number
  faceAlpha: number
  /** eye and lip contours */
  featureWidth: number
  featureAlpha: number
  /** body interior lattice */
  innerWidth: number
  innerAlpha: number
  /** silhouette */
  outlineWidth: number
  outlineAlpha: number
  /** vertex dots (0 = none) */
  nodeAlpha: number
  nodeRadius: number
  /** whether the face mesh's ~470 vertices get dots too */
  faceNodes: boolean
  /** dark under-stroke that keeps lines legible on bright skin and walls */
  bedAlpha: number
  /** blurred additive copy of the lines (0 = skipped entirely, which also saves the blur) */
  glowAlpha: number
  glowBlur: number
  /** problem-area highlight strength */
  hotspot: number
  /** scanner sweep strength */
  sweep: number
  /** tracked joints */
  jointAlpha: number
  jointRadius: number
}

type Keyed = { [K in keyof MeshLook]: MeshLook[K] extends number ? K : never }[keyof MeshLook]

/** Looks at the minimum, the default and the maximum intensity; in between is linear. */
const KEYS: Record<Keyed, readonly [number, number, number]> = {
  spacing: [1.65, 1.45, 1],
  faceWidth: [0.45, 0.5, 0.6],
  faceAlpha: [0.09, 0.2, 0.42],
  featureWidth: [0.7, 0.85, 1.4],
  featureAlpha: [0.25, 0.45, 1],
  innerWidth: [0.55, 0.65, 0.75],
  innerAlpha: [0.16, 0.3, 0.6],
  outlineWidth: [0.9, 1.1, 1.4],
  outlineAlpha: [0.4, 0.62, 1],
  nodeAlpha: [0.15, 0.38, 0.9],
  nodeRadius: [0.75, 0.85, 1.05],
  bedAlpha: [0.03, 0.07, 0.2],
  glowAlpha: [0, 0, 1],
  glowBlur: [2, 2.5, 3.5],
  hotspot: [0.6, 0.75, 1],
  sweep: [0.25, 0.45, 1],
  jointAlpha: [0.35, 0.55, 1],
  jointRadius: [3.5, 4, 5]
}

/** The hologram style dims the camera image, so its lines may carry a little more light. */
const HOLOGRAM_BOOST: Partial<Record<Keyed, number>> = {
  faceAlpha: 1.3,
  featureAlpha: 1.2,
  innerAlpha: 1.35,
  outlineAlpha: 1.2,
  nodeAlpha: 1.3,
  sweep: 1.3
}
/** hologram keeps a soft glow even at low intensity: it is what the style is for */
const HOLOGRAM_GLOW_FLOOR = 0.3

export function meshLook(intensity: number, hologram = false): MeshLook {
  const i = Math.min(MESH_INTENSITY_MAX, Math.max(MESH_INTENSITY_MIN, Number.isFinite(intensity) ? intensity : MESH_INTENSITY_DEFAULT))
  // position in the lower (min → default) or upper (default → max) segment
  const lower = i <= MESH_INTENSITY_DEFAULT
  const t = lower
    ? (i - MESH_INTENSITY_MIN) / (MESH_INTENSITY_DEFAULT - MESH_INTENSITY_MIN)
    : (i - MESH_INTENSITY_DEFAULT) / (MESH_INTENSITY_MAX - MESH_INTENSITY_DEFAULT)
  const look = {} as MeshLook
  for (const key of Object.keys(KEYS) as Keyed[]) {
    const [lo, mid, hi] = KEYS[key]
    let v = lower ? lo + (mid - lo) * t : mid + (hi - mid) * t
    if (hologram) v *= HOLOGRAM_BOOST[key] ?? 1
    look[key] = v
  }
  for (const key of ['faceAlpha', 'featureAlpha', 'innerAlpha', 'outlineAlpha', 'nodeAlpha', 'sweep', 'jointAlpha'] as const) {
    look[key] = Math.min(1, look[key])
  }
  if (hologram) look.glowAlpha = Math.max(look.glowAlpha, HOLOGRAM_GLOW_FLOOR)
  // the face mesh's own vertex dots read as a solid smear until the top of the range
  look.faceNodes = i >= 0.8
  return look
}
