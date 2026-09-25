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
  /** the device actually opened (may differ from the one asked for) */
  deviceId: string | null
  label: string | null
}

function request(deviceId: string | null): Promise<MediaStream> {
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

function describe(stream: MediaStream): OpenedCamera {
  const track = stream.getVideoTracks()[0]
  return { stream, deviceId: track?.getSettings().deviceId ?? null, label: track?.label || null }
}

/**
 * Opens the selected camera (any system camera). 640×480 is plenty for
 * upper-body landmarks and keeps the CPU-delegate fallback viable.
 *
 * A saved deviceId goes stale when a USB camera moves ports or Chromium's
 * device-id salt resets. Before falling back to the default camera — which
 * may be a different lens than the baseline was captured with — look for
 * the same camera by its label.
 */
export async function openCamera(deviceId: string | null, label: string | null = null): Promise<OpenedCamera> {
  try {
    return describe(await request(deviceId))
  } catch (err) {
    if (!deviceId || !(err instanceof DOMException) || err.name !== 'OverconstrainedError') throw mapError(err)
  }
  if (label) {
    try {
      const same = (await navigator.mediaDevices.enumerateDevices()).find(
        (d) => d.kind === 'videoinput' && d.label === label && d.deviceId !== deviceId
      )
      if (same) return describe(await request(same.deviceId))
    } catch {
      // fall through to the default camera
    }
  }
  try {
    return describe(await request(null))
  } catch (err) {
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
