// Images sent with a cloud posture review (docs/specs/ai-providers.md §2, §5).
//
// - makeSketch: a pose drawing — no camera pixels. Plain dark-gray background, the
//   visible skeleton as thick light-gray lines, and a dashed line along TRUE vertical
//   (gravity projected into the image) through the shoulder point. This is the default
//   share mode ('sketch').
// - makeSnapshot: a downscaled camera frame ('snapshot' mode).
//
// Both: long side ≤ 640 px, the camera's own aspect, NOT mirrored (the model is told to
// use the person's left/right), base64 JPEG without a data: prefix, validated to start
// with "/9j/" (the JPEG magic main checks too).

import { LM } from '@renderer/posture/constants'
import type { PoseFrame, PostureFeatures } from '@renderer/posture/types'
import { isSeen, projectUp, shoulderPoint } from '@renderer/detection/pose-geometry'

export const REVIEW_IMAGE_MAX_SIDE = 640
const JPEG_QUALITY = 0.82

const SKETCH_BG = '#2b2b2b'
const SKETCH_BODY = '#c9c9c9'
const SKETCH_VERTICAL = '#f2f2f2'

/** Image size for a frame aspect (width / height), long side = REVIEW_IMAGE_MAX_SIDE. */
export function reviewImageSize(aspect: number, maxSide = REVIEW_IMAGE_MAX_SIDE): { w: number; h: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3
  return a >= 1
    ? { w: maxSide, h: Math.max(1, Math.round(maxSide / a)) }
    : { w: Math.max(1, Math.round(maxSide * a)), h: maxSide }
}

/** Skeleton edges drawn in the sketch (MediaPipe indices; person's anatomical sides). */
const EDGES: ReadonlyArray<readonly [number, number]> = [
  // head
  [LM.nose, 2], // left eye (center)
  [2, LM.leftEar],
  [LM.nose, 5], // right eye (center)
  [5, LM.rightEar],
  // neck: ear → shoulder per side (what head-forward is judged on)
  [LM.leftEar, LM.leftShoulder],
  [LM.rightEar, LM.rightShoulder],
  // shoulders and arms
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow],
  [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow],
  [LM.rightElbow, LM.rightWrist],
  // trunk and legs
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee],
  [LM.rightHip, LM.rightKnee]
]

const JOINTS: readonly number[] = [
  LM.nose,
  2,
  5,
  LM.leftEar,
  LM.rightEar,
  LM.leftShoulder,
  LM.rightShoulder,
  LM.leftElbow,
  LM.rightElbow,
  LM.leftWrist,
  LM.rightWrist,
  LM.leftHip,
  LM.rightHip,
  LM.leftKnee,
  LM.rightKnee
]

export interface SketchPlan {
  w: number
  h: number
  /** pixel line segments of the visible skeleton */
  lines: Array<[number, number, number, number]>
  /** pixel joint centers (seen landmarks only) */
  joints: Array<[number, number]>
  /** dashed true-vertical line through the shoulder point, clipped generously to the canvas */
  vertical: [number, number, number, number] | null
  lineWidth: number
}

/** Pure layout of the sketch (pixels), testable without a canvas. */
export function planSketch(frame: PoseFrame, features: Pick<PostureFeatures, 'up' | 'anchor'> | null): SketchPlan {
  const { w, h } = reviewImageSize(frame.aspect)
  const px = (i: number): [number, number] => [frame.image[i].x * w, frame.image[i].y * h]
  const lines: SketchPlan['lines'] = []
  for (const [a, b] of EDGES) {
    if (isSeen(frame.image[a]) && isSeen(frame.image[b])) lines.push([...px(a), ...px(b)])
  }
  const joints: SketchPlan['joints'] = JOINTS.filter((i) => isSeen(frame.image[i])).map(px)
  let vertical: SketchPlan['vertical'] = null
  const s = shoulderPoint(frame.image)
  if (features && s) {
    const [du, dv] = projectUp(features, frame.aspect)
    // isotropic direction → pixels: both axes scale by the image height
    const cx = s.x * w
    const cy = s.y * h
    const L = Math.hypot(w, h)
    vertical = [cx - du * L, cy - dv * L, cx + du * L, cy + dv * L]
  }
  return { w, h, lines, joints, vertical, lineWidth: Math.max(3, Math.round(Math.max(w, h) / 90)) }
}

function canvasOf(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available.')
  return { canvas, ctx }
}

function toJpegB64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  const b64 = url.slice(url.indexOf(',') + 1)
  if (!url.startsWith('data:image/jpeg') || !b64.startsWith('/9j/')) {
    throw new Error('Could not encode the review image.')
  }
  return b64
}

/** A pose drawing of `frame` with the true-vertical guide from `features.up`. Throws if it can't be drawn. */
export function makeSketch(frame: PoseFrame, features: Pick<PostureFeatures, 'up' | 'anchor'> | null): string {
  const plan = planSketch(frame, features)
  const { canvas, ctx } = canvasOf(plan.w, plan.h)
  ctx.fillStyle = SKETCH_BG
  ctx.fillRect(0, 0, plan.w, plan.h)

  if (plan.vertical) {
    ctx.save()
    ctx.strokeStyle = SKETCH_VERTICAL
    ctx.globalAlpha = 0.85
    ctx.lineWidth = Math.max(2, Math.round(plan.lineWidth / 2))
    ctx.setLineDash([plan.lineWidth * 3, plan.lineWidth * 2.2])
    ctx.beginPath()
    ctx.moveTo(plan.vertical[0], plan.vertical[1])
    ctx.lineTo(plan.vertical[2], plan.vertical[3])
    ctx.stroke()
    ctx.restore()
  }

  ctx.strokeStyle = SKETCH_BODY
  ctx.fillStyle = SKETCH_BODY
  ctx.lineWidth = plan.lineWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const [x1, y1, x2, y2] of plan.lines) {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }
  for (const [x, y] of plan.joints) {
    ctx.beginPath()
    ctx.arc(x, y, plan.lineWidth * 0.9, 0, Math.PI * 2)
    ctx.fill()
  }
  return toJpegB64(canvas)
}

/** The current camera frame, downscaled (long side ≤ 640 px), not mirrored. Throws without a frame. */
export function makeSnapshot(video: HTMLVideoElement): string {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!(vw > 0 && vh > 0) || video.readyState < 2) throw new Error('No camera frame yet.')
  const scale = Math.min(1, REVIEW_IMAGE_MAX_SIDE / Math.max(vw, vh))
  const w = Math.max(1, Math.round(vw * scale))
  const h = Math.max(1, Math.round(vh * scale))
  const { canvas, ctx } = canvasOf(w, h)
  ctx.drawImage(video, 0, 0, w, h)
  return toJpegB64(canvas)
}
