import { FaceLandmarker, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { buildFaceTopology, type FaceTopology } from '@renderer/overlay/bodyMesh'

// Relative URLs resolve against the document (dev server or app://renderer/),
// so the same paths work in dev and in the packaged offline build.
const WASM_BASE = 'mediapipe/wasm'
const MODEL_PATH = 'models/pose_landmarker_lite.task'
const FACE_MODEL_PATH = 'models/face_landmarker.task'
/**
 * Room for the user plus one more pose. With room for one, the model tracks the first pose it
 * finds and stops looking: a figure on the desk mat picked up while the chair was empty hid
 * the user who sat down. The controller picks the user (posture/select.ts).
 */
const MAX_POSES = 2

async function create(delegate: 'GPU' | 'CPU'): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    numPoses: MAX_POSES,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  })
}

/**
 * Any WebGL at all (WebGL2 or 1, incl. Windows' WARP software renderer). MediaPipe needs a
 * WebGL context to read video frames even on its CPU path; without one every inference
 * fails ("activeTexture of undefined") and rebuilding the model can never help.
 */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return (c.getContext('webgl2') ?? c.getContext('webgl')) !== null
  } catch {
    return false
  }
}

function webgl2Available(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null
  } catch {
    return false
  }
}

/**
 * GPU delegate with CPU fallback. Some GPU failures only surface at the first
 * inference, so the caller must also route a failed first detect through
 * recreateAsCpu().
 *
 * `gpuFailed` is true only when the GPU graph was actually attempted and threw —
 * the only case in which an 'auto' preference may be pinned to CPU. A machine
 * where WebGL2 merely wasn't available yet (e.g. a launch-on-login boot) is not
 * pinned and gets the GPU probe again next start.
 */
export async function createLandmarker(
  preference: 'auto' | 'GPU' | 'CPU'
): Promise<{ landmarker: PoseLandmarker; delegate: 'GPU' | 'CPU'; gpuFailed: boolean }> {
  const tryGpu = preference === 'GPU' || (preference === 'auto' && webgl2Available())
  let gpuFailed = false
  if (tryGpu) {
    try {
      return { landmarker: await create('GPU'), delegate: 'GPU', gpuFailed: false }
    } catch (err) {
      gpuFailed = true
      console.warn('[landmarker] GPU delegate failed, falling back to CPU:', err)
    }
  }
  return { landmarker: await create('CPU'), delegate: 'CPU', gpuFailed }
}

export async function recreateAsCpu(old: PoseLandmarker | null): Promise<PoseLandmarker> {
  try {
    old?.close()
  } catch {
    // already broken — that's why we're here
  }
  return create('CPU')
}

/**
 * Face mesh for the preview's wireframe only — posture never depends on it,
 * and it only exists while a mesh preview is on screen.
 */
export async function createFaceLandmarker(delegate: 'GPU' | 'CPU'): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  })
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
