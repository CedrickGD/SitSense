import { FaceLandmarker, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { buildFaceTopology, type FaceTopology } from '@renderer/overlay/bodyMesh'

// Relative URLs resolve against the document (dev server or app://renderer/),
// so the same paths work in dev and in the packaged offline build.
const WASM_BASE = 'mediapipe/wasm'
const MODEL_PATH = 'models/pose_landmarker_lite.task'
const FACE_MODEL_PATH = 'models/face_landmarker.task'

/**
 * A MediaPipe task plus the canvas its WebGL context lives on. MediaPipe's
 * close() only closes the graph; the context (and its slot in Chromium's
 * ~16-context budget) lingers until GC unless it's released explicitly.
 */
export interface VisionTask<T extends { close(): void }> {
  task: T
  delegate: 'GPU' | 'CPU'
  /** the GPU delegate was tried and failed (not merely skipped on software GL) */
  gpuFailed?: boolean
  dispose(): void
}

function wrap<T extends { close(): void }>(task: T, delegate: 'GPU' | 'CPU', canvas: OffscreenCanvas): VisionTask<T> {
  let disposed = false
  return {
    task,
    delegate,
    dispose() {
      if (disposed) return
      disposed = true
      try {
        task.close()
      } catch {
        // a broken task is exactly what gets disposed
      }
      loseContext(canvas)
    }
  }
}

function loseContext(canvas: OffscreenCanvas | HTMLCanvasElement): void {
  try {
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // no context was ever created
  }
}

async function createPose(delegate: 'GPU' | 'CPU'): Promise<VisionTask<PoseLandmarker>> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
  const canvas = new OffscreenCanvas(1, 1)
  const task = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    canvas,
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  })
  return wrap(task, delegate, canvas)
}

/**
 * Whether the GPU delegate is worth trying: WebGL2 on real hardware. On a
 * software rasterizer (SwiftShader) the "GPU" delegate is slower than the
 * CPU one, which runs on XNNPACK.
 */
function hardwareWebgl2(): boolean {
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2')
    let ok = gl !== null
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
      ok = !/swiftshader|llvmpipe|software|basic render/i.test(renderer)
    }
    loseContext(probe) // a probe must not hold on to a context
    return ok
  } catch {
    return false
  }
}

/**
 * GPU delegate with CPU fallback. Some GPU failures only surface at the first
 * inference, so the caller must also route a failed first detect through
 * recreateAsCpu().
 */
export async function createLandmarker(preference: 'auto' | 'GPU' | 'CPU'): Promise<VisionTask<PoseLandmarker>> {
  const tryGpu = preference === 'GPU' || (preference === 'auto' && hardwareWebgl2())
  if (tryGpu) {
    try {
      return await createPose('GPU')
    } catch (err) {
      console.warn('[landmarker] GPU delegate failed, falling back to CPU:', err)
      return { ...(await createPose('CPU')), gpuFailed: true }
    }
  }
  return createPose('CPU')
}

export async function recreateAsCpu(old: VisionTask<PoseLandmarker> | null): Promise<VisionTask<PoseLandmarker>> {
  old?.dispose()
  return createPose('CPU')
}

/**
 * Face mesh for the preview's wireframe only — posture never depends on it,
 * and it only exists while a mesh preview is on screen.
 */
export async function createFaceLandmarker(delegate: 'GPU' | 'CPU'): Promise<VisionTask<FaceLandmarker>> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
  const canvas = new OffscreenCanvas(1, 1)
  const task = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate },
    canvas,
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  })
  return wrap(task, delegate, canvas)
}

let topology: FaceTopology | null = null

/** The face mesh's triangulation plus the contours worth highlighting (eyes, lips). */
export function faceMeshTopology(): FaceTopology {
  topology ??= buildFaceTopology(FaceLandmarker.FACE_LANDMARKS_TESSELATION, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, [
    FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
    FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
    FaceLandmarker.FACE_LANDMARKS_LIPS
  ])
  return topology
}
