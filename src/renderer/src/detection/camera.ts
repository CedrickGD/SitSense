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

export interface OpenedCamera {
  stream: MediaStream
  /** the device actually opened (track.getSettings().deviceId), null if the browser doesn't say */
  deviceId: string | null
  label: string
  /**
   * The preferred camera could not be opened (unplugged, stale id) and another one was
   * opened instead. The caller must surface this and re-acquire the preferred camera
   * once it is back (docs: audit "silent camera fallback").
   */
  fellBack: boolean
}

async function getStream(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 }
    }
  })
}

/**
 * Opens the selected camera (any system camera). 640×480 is plenty for
 * upper-body landmarks and keeps the CPU-delegate fallback viable. A missing
 * preferred camera falls back to the default one — reported via `fellBack`,
 * never silently.
 */
export async function openCamera(preferred: string | null): Promise<OpenedCamera> {
  let stream: MediaStream
  let fellBack = false
  try {
    stream = await getStream(preferred)
  } catch (err) {
    const missing =
      preferred && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')
    if (!missing) throw mapError(err)
    try {
      stream = await getStream(null)
      fellBack = true
    } catch (err2) {
      throw mapError(err2)
    }
  }
  const track = stream.getVideoTracks()[0]
  const deviceId = track?.getSettings().deviceId || null
  if (preferred && deviceId && deviceId !== preferred) fellBack = true
  return { stream, deviceId, label: track?.label ?? '', fellBack }
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
