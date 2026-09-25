import { FaceLandmarker, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { buildFaceTopology, type FaceTopology } from '@renderer/overlay/bodyMesh'

// Relative URLs resolve against the document (dev server or app://renderer/),
// so the same paths work in dev and in the packaged offline build.
const WASM_BASE = 'mediapipe/wasm'
const MODEL_PATH = 'models/pose_landmarker_lite.task'
const FACE_MODEL_PATH = 'models/face_landmarker.task'

async function create(delegate: 'GPU' | 'CPU'): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  })
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
 */
export async function createLandmarker(
  preference: 'auto' | 'GPU' | 'CPU'
): Promise<{ landmarker: PoseLandmarker; delegate: 'GPU' | 'CPU' }> {
  const tryGpu = preference === 'GPU' || (preference === 'auto' && webgl2Available())
  if (tryGpu) {
    try {
      return { landmarker: await create('GPU'), delegate: 'GPU' }
    } catch (err) {
      console.warn('[landmarker] GPU delegate failed, falling back to CPU:', err)
    }
  }
  return { landmarker: await create('CPU'), delegate: 'CPU' }
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
