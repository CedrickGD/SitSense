import type { CameraError as CameraErrorKind } from '@shared/posture'

export class CameraOpenError extends Error {
  readonly kind: Exclude<CameraErrorKind, null>

  constructor(kind: Exclude<CameraErrorKind, null>, cause?: unknown) {
    super(`camera error: ${kind}`)
    this.kind = kind
    this.cause = cause
  }
}

function mapError(err: unknown): CameraOpenError {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return new CameraOpenError('denied', err)
    }
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      return new CameraOpenError('not-found', err)
    }
    // NotReadableError / AbortError: held by another app or blocked by the
    // Windows camera privacy toggle
    return new CameraOpenError('in-use', err)
  }
  return new CameraOpenError('in-use', err)
}

/**
 * Opens the selected camera (any system camera). 640×480 is plenty for
 * upper-body landmarks and keeps the CPU-delegate fallback viable.
 */
export async function openCamera(deviceId: string | null): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      }
    })
  } catch (err) {
    // a stale saved deviceId (unplugged cam) should fall back to any camera
    if (deviceId && err instanceof DOMException && err.name === 'OverconstrainedError') {
      return openCamera(null)
    }
    throw mapError(err)
  }
}

/** Device labels are only populated after a successful getUserMedia grant. */
export async function listCameras(): Promise<{ deviceId: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}
