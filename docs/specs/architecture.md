# SitSense — Technical Architecture Spec

Greenfield Electron desktop app, Windows-only. Repo target: `C:/Users/cedri/source/repos/CedrickGD/SitSense`. All detection is local; no frame ever leaves the machine; app must work with networking fully disabled.

**Verified baselines (Aug 2026):** Electron current stable is in the 40+ range; anything ≥ 27 includes the compositor-level `backgroundThrottling` fix (PR #38924) that this design depends on. `@mediapipe/tasks-vision` is at **1.0.1**; its `wasm/` folder now ships 6 files (`vision_wasm_internal.js/.wasm`, `vision_wasm_module_internal.js/.wasm`, `vision_wasm_nosimd_internal.js/.wasm`, ~11 MB per binary). Pin the exact version — the JS API and wasm fileset must match versions (mismatches have broken loading in past releases).

---

## 1. Project structure (electron-vite scaffold)

```
SitSense/
├─ package.json
├─ electron.vite.config.ts          # 3 build targets: main, preload, renderer
├─ electron-builder.yml
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ tailwind.config.ts, postcss.config.js
├─ scripts/
│  └─ fetch-assets.mjs              # postinstall: copies wasm from node_modules,
│                                   # downloads the pose + face .task models if absent
├─ build/                           # electron-builder inputs
│  └─ icon.ico                      # installer/app icon (256px multi-size)
├─ resources/                       # main-process runtime assets (asarUnpack'd)
│  ├─ tray/
│  │  ├─ tray-good.ico              # each ICO: 16/20/24/32/48 px frames
│  │  ├─ tray-warn.ico
│  │  ├─ tray-bad.ico
│  │  └─ tray-paused.ico
│  └─ toast/                        # 96px toast logos: <issue>-<stage>.png + good.png
└─ src/
   ├─ shared/                       # imported by all three processes — types only
   │  ├─ ipc.ts                     # channel constants + payload types (§5)
   │  ├─ settings.ts                # Settings interface + DEFAULT_SETTINGS
   │  └─ posture.ts                 # PostureState, PostureMetrics, CalibrationData
   ├─ main/
   │  ├─ index.ts                   # entry: AUMID, single-instance, protocol, boot order
   │  ├─ app-protocol.ts            # app:// scheme (offline asset serving, §3)
   │  ├─ window.ts                  # BrowserWindow factory + close-to-tray lifecycle
   │  ├─ tray.ts                    # Tray, dynamic icon, context menu
   │  ├─ notifications.ts           # toast logic, cooldowns, escalation
   │  ├─ settings-store.ts          # JSON persistence in userData
   │  ├─ autostart.ts               # setLoginItemSettings wrapper
   │  └─ ipc.ts                     # ipcMain handlers, wires modules together
   ├─ preload/
   │  ├─ index.ts                   # contextBridge.exposeInMainWorld('sitsense', api)
   │  └─ index.d.ts                 # global Window typing
   └─ renderer/
      ├─ index.html
      ├─ public/                    # copied verbatim into out/renderer by Vite
      │  ├─ mediapipe/wasm/         # the 6 files from @mediapipe/tasks-vision/wasm
      │  └─ models/pose_landmarker_lite.task   (~5.5 MB)
      │     models/face_landmarker.task        (~3.7 MB, preview mesh only)
      └─ src/
         ├─ main.tsx, App.tsx
         ├─ ipc.ts                  # typed wrapper over window.sitsense
         ├─ detection/
         │  ├─ camera.ts            # enumeration, getUserMedia, device-loss recovery
         │  ├─ landmarker.ts        # PoseLandmarker init, GPU→CPU fallback
         │  ├─ frame-loop.ts        # rVFC + hidden-mode timer fallback (§4)
         │  ├─ posture-analyzer.ts  # landmarks → metrics → state w/ hysteresis
         │  └─ calibration.ts      # capture baseline over N seconds
         ├─ state/store.ts          # zustand: settings mirror, posture, camera list
         └─ components/             # Dashboard, CameraPreview, SettingsPanel,
                                    # CalibrationWizard, StatusBadge
```

`resources/` is the electron-vite convention for main-process assets; reference as `join(__dirname, '../../resources/...')` in dev and mark `asarUnpack: resources/**` for production (tray ICOs must exist as real files on disk — `Tray` cannot read from inside asar reliably).

---

## 2. Main process modules

### Boot order (`main/index.ts`)

```ts
app.setAppUserModelId('com.cedrickgd.sitsense');      // MUST equal electron-builder appId
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
protocol.registerSchemesAsPrivileged([...]);           // before app.ready (§3)
app.whenReady().then(boot);
```

Order matters: AUMID and scheme privileges before `ready`; tray created in `ready` so the app is usable even if the window never shows; window created hidden if launched with `--hidden` (autostart).

As built, a few more things happen before `ready`: an unpackaged run moves `userData` to `<userData>-dev` (before the single-instance lock, so `npm run dev` never collides with an installed tray copy), and `enable-unsafe-swiftshader` is appended (§3, landmarker). The first thing in `ready` is `lockDownNetwork()` (§2, Privacy & hardening).

### Tray with dynamic posture icon (`main/tray.ts`)

- **Do not generate icons at runtime.** The main process has no canvas, and pulling in `sharp`/`jimp` for a 16px dot is bloat. Ship 4 pre-built multi-size `.ico` files (16/20/24/32/48 px frames — Windows picks the right frame per DPI automatically, so no `@2x` suffix logic needed; that convention is macOS-oriented).
- Load once at startup into a `Record<TrayState, NativeImage>` via `nativeImage.createFromPath(...)`; switch with `tray.setImage(icons[state])`. Cheap, instant, no flicker.
- State machine in main: `good | warn | bad | paused`. Driven by `posture:update` IPC events (renderer) and pause toggles (tray/UI). Also update `tray.setToolTip('SitSense — posture: good')`.
- Context menu: **Open SitSense**, **Pause / Resume** (checkbox), **Recalibrate**, **Start with Windows** (checkbox, reads `getLoginItemSettings()`), separator, **Quit**. Rebuild menu on state change (`Menu` instances are immutable). `tray.on('click')` → show/focus window (Windows convention: single left-click opens).
- If no posture update arrives for >10 s while unpaused (renderer crashed/stalled), fall back to a distinct "stale" tint or the paused icon and log — the tray must never lie.

### Toast notifications (`main/notifications.ts`)

- Use Electron's built-in `Notification` (main process). Requirements on Windows, verified:
  - `app.setAppUserModelId()` must match the electron-builder `appId` — Windows uses the AUMID to attribute the toast.
  - A Start-menu shortcut carrying that AUMID must exist for reliable delivery — the NSIS installer creates it (`createStartMenuShortcut: true`). This is why the **portable exe has degraded toast behavior** (§7).
- `Notification.isSupported()` guard; `notification.on('click')` → show window.
- As built: a fixed `app.setToastActivatorCLSID(...)` next to the AUMID, and `Notification.handleActivation` for clicks and the `Pause 15 min` button. With Electron's default random-per-run CLSID, a toast left in the Action Center can't reach the app after a restart. (Needs verifying on real Windows.)
- Nag policy lives in main, not renderer: on transition to `bad` start a grace timer (`badPostureSeconds`, default 30 s); fire toast only after sustained bad posture; then a cooldown (`notifyCooldownSeconds`, default 300 s) before re-nagging; reset on recovery to `good`. Keeps renderer purely observational.

### Settings persistence (`main/settings-store.ts`)

- Plain JSON at `join(app.getPath('userData'), 'settings.json')` — no dependency needed. (If you want `electron-store`: v8 is CJS, v10+ is ESM-only; with electron-vite either works, but hand-rolled is ~40 lines.) Debounce writes 500 ms. Validate/merge with `DEFAULT_SETTINGS` on load so schema evolution never crashes.
- Crash safety (`main/json-file.ts`, shared with stats): write `*.tmp` with `fsync`, copy the previous file to `*.bak`, then rename. On load, a file that fails to parse is set aside as `*.corrupt-<ts>` and the `.bak` is used; only when neither is usable do defaults apply. A power cut mid-write must never cost the user their calibration.
- The settings shape below is the original sketch; the real one lives in `shared/settings.ts` (per-issue sensitivities and notify stages, overlay style/color, `cameraLabel` to re-find a camera whose id changed, `gpuFailedAt`, `general.closeToTray`).
- Settings shape (in `shared/settings.ts`):

```ts
interface Settings {
  cameraDeviceId: string | null;
  detectionFps: number;            // default 5 — posture needs no more
  delegate: 'GPU' | 'CPU' | 'auto';// 'auto' = try GPU, persist what worked
  badPostureSeconds: number;       // sustained-bad before toast
  notifyCooldownSeconds: number;
  notificationsEnabled: boolean;
  launchOnStartup: boolean;
  startHidden: boolean;
  calibration: CalibrationData | null;  // baseline metrics + thresholds
  sensitivity: number;             // 0..1 scales thresholds off baseline
}
```

### Autostart (`main/autostart.ts`)

```ts
app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
```

On boot: `process.argv.includes('--hidden')` → create window with `show: false` and skip `win.show()`. Guard: only offer/enable autostart when `app.isPackaged` (dev `electron.exe` path would be registered otherwise). Portable-exe caveat in §7.

As built: the portable exe registers `PORTABLE_EXECUTABLE_FILE` (the exe the user launched), not `process.execPath` (its temp extraction dir, gone after exit). On boot, `reconcileAutostart` follows Task Manager → Startup apps both ways via `executableWillLaunchAtLogin`: an entry switched off there turns the setting off (the entry stays, so it can be switched on again there), and one switched back on turns the setting on. The toggle never lies, and the app never deletes an entry the user can still see. The NSIS uninstaller deletes the `Run` / `StartupApproved\Run` values (named after the AUMID) unless it runs as part of an update (`build/installer.nsh`).

### Window lifecycle (`main/window.ts`)

```ts
let isQuitting = false;
win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });
// tray Quit / before-quit:
app.on('before-quit', () => { isQuitting = true; });
```

- First hide-to-tray: fire a one-time toast/balloon "SitSense is still watching from the tray" so users don't think it quit.
- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (the preload only `require`s `electron`, which the sandbox allows), `spellcheck: false`, **`backgroundThrottling: false`** (critical, §4), `preload: join(__dirname, '../preload/index.js')`.
- `session.setPermissionRequestHandler` grants only `'media'` with video-only `mediaTypes`, and only to the app's own origin (`app://renderer` or the dev server); `setPermissionCheckHandler` mirrors it so `enumerateDevices()` keeps its labels. Everything else is denied — explicit allowlist rather than Electron's permissive default.
- `will-navigate` is refused for anything but the app's own URL; `setWindowOpenHandler` denies all.
- A crashed renderer (`render-process-gone`) is reloaded, at most 3 times per 10 minutes.
- Closing hides to the tray only while `general.closeToTray` is on; otherwise it quits.

### Privacy & hardening (`main/privacy.ts`, `main/validate.ts`)

- **Egress block.** `session.webRequest.onBeforeRequest` cancels every `http(s)`/`ws(s)` request except to the dev server in an unpackaged run, and logs what it blocked. MediaPipe's own usage telemetry and Chromium's spellcheck-dictionary download are the known callers. The CSP's `connect-src 'self'` stops page-level fetches first; this catches the rest.
- **CSP.** `index.html` carries the dev policy (inline scripts and `ws:` for Vite's refresh preamble and HMR). The `sitsense:production-csp` plugin in `electron.vite.config.ts` removes both from the built page and fails the build if it can't find the policy. `object-src`, `base-uri` and `form-action` are `'none'` everywhere.
- **Fuses** (`electronFuses` in `electron-builder.yml`): no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, app code only from `app.asar`, no extra `file://` privileges, encrypted cookies. Playwright's `_electron` needs `--inspect`, so `scripts/drive-packaged.mjs` drives the packaged app over `--remote-debugging-port` instead.
- **IPC validation.** Every renderer → main payload (snapshot, alert, detection status, pause request, settings patch) is shape-checked before it reaches timers, the tray, stats or toasts; a bad payload is dropped, never thrown on.

### Pause and the lock screen (`main/pause.ts`)

- Two reasons: `user` (tray, dashboard, toast action) and `lock`. Locking the session pauses and releases the camera; unlocking resumes, unless the user had paused anyway. A timed pause that runs out while the session is locked hands over to the lock pause, so the camera only comes back on unlock.
- The toast's `Pause 15 min` never shortens a pause that's already running (an old nudge clicked from the Action Center during "Until I resume" does nothing).
- A user pause survives a restart (`userData/pause.json`, capped at 24 h) and is re-checked every 30 s, so a timed pause that expired while the machine slept ends on wake.
- No `powerSaveBlocker`: an idle machine should be allowed to sleep, and `powerMonitor` `suspend` tells the renderer to drop its stream so it reacquires cleanly on resume.

---

## 3. Renderer detection pipeline

### Offline bundling of WASM + model — the critical part

Verified current API (`@mediapipe/tasks-vision`):

```ts
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm'); // basePath, no rename allowed
const landmarker = await PoseLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'GPU' },
  runningMode: 'VIDEO',
  numPoses: 1,
});
const result = landmarker.detectForVideo(videoEl, performance.now()); // ts must be monotonic
```

**Asset provisioning** (`scripts/fetch-assets.mjs`, run on `postinstall`):
1. Copy `node_modules/@mediapipe/tasks-vision/wasm/*` → `src/renderer/public/mediapipe/wasm/` (all 6 files, **unrenamed** — `FilesetResolver` resolves them by fixed name; SIMD variant is picked automatically and Electron's V8 supports WASM SIMD).
2. Download `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` → `src/renderer/public/models/` if missing (build-time only; commit it or gitignore+refetch — runtime never touches the network).

Vite copies `public/` into `out/renderer/`, so dev (`http://localhost:5173`) and prod resolve the same relative URLs.

**The `file://` trap — must be handled:** electron-vite's default production load is `win.loadFile(...)` → `file://` origin. MediaPipe loads the wasm binary and the `.task` model via `fetch()`, and Chromium's fetch rejects `file:` URLs. **Serve the renderer over a custom privileged scheme instead:**

```ts
// main/app-protocol.ts — before app.ready:
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
}]);
// after ready:
protocol.handle('app', (req) => {
  const url = new URL(req.url);                       // app://renderer/<path>
  const file = join(__dirname, '../renderer', normalizeAndContain(url.pathname)); // reject ../ escapes
  return net.fetch(pathToFileURL(file).toString());
});
// prod: win.loadURL('app://renderer/index.html')  |  dev: win.loadURL(process.env.ELECTRON_RENDERER_URL)
```

Everything (`index.html`, JS, wasm, model) is served from `app://`, fetch works, fully offline. Fallback if you refuse the custom scheme: keep `loadFile` and pass the model as `modelAssetBuffer` (a `Uint8Array` read via IPC from main) — but the wasm binary fetch remains fragile under `file://`, so the `app://` scheme is the prescribed design.

### Camera handling (`detection/camera.ts`)

- `getUserMedia` once (any camera) **before** `enumerateDevices()` — device labels are empty until a grant has occurred. Then enumerate `videoinput` devices → `{deviceId, label}` list into the UI store; persist selection to settings.
- Constraints: `{ video: { deviceId: { exact: id }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } }`. 640×480 is plenty for upper-body landmarks and keeps CPU-delegate fallback viable.
- Attach to a `<video muted playsInline autoplay>` (may be visually hidden with CSS, but keep it in the DOM).
- Resilience: `track.onended` → device lost; `navigator.mediaDevices.ondevicechange` → re-enumerate, reacquire preferred device with exponential backoff (2 s → 30 s cap). Map errors: `NotReadableError` = camera in use elsewhere or Windows privacy toggle off; `NotFoundError` = unplugged; `NotAllowedError` = permission. Surface each as a distinct `detection:status` state.
- **Pause = release**: on pause, stop all tracks (kills the webcam LED — a trust signal for a webcam-watching app), destroy nothing else; resume reacquires.

### Landmarker init with GPU→CPU fallback (`detection/landmarker.ts`)

1. If `settings.delegate === 'auto'`: probe `document.createElement('canvas').getContext('webgl2')` — if null, **or if the unmasked renderer is a software rasterizer** (SwiftShader, llvmpipe, Microsoft Basic Render Driver), go straight to CPU; XNNPACK beats "GPU" on software GL.
   - MediaPipe needs WebGL even on the CPU delegate (video frames are uploaded as textures). Chromium no longer falls back to SwiftShader by itself, so on a blocklisted driver, a VM or a GPU-less session every inference would throw. Main therefore appends `enable-unsafe-swiftshader`. It only kicks in when no GPU works, and this renderer runs nothing but the app's own bundled code behind the egress block.
   - A GPU failure is remembered with a timestamp (`gpuFailedAt`) and retried after 7 days. Skipping the GPU on software GL is not a failure and records nothing.
   - Each task gets its own `OffscreenCanvas`; `dispose()` closes the task **and** loses its WebGL context (`WEBGL_lose_context`), since Chromium caps live contexts at ~16.
   - A model that loads but throws on every frame is rebuilt after 10 consecutive failures, with the same 2 s → 30 s backoff as camera retries. The backoff resets only after a successful inference, so a broken model can't make the camera reopen every few seconds.
2. `createFromOptions(..., delegate: 'GPU')` in try/catch; on throw **or** on a failed first `detectForVideo` (some GPU failures surface only at first inference), `close()` and recreate with `delegate: 'CPU'`.
3. Persist the winning delegate via `settings:set` so subsequent launches skip the probe. Report active delegate in `detection:status` (show in UI).
4. Timestamps: always `performance.now()`; MediaPipe throws on non-monotonic input in VIDEO mode.

### Posture analysis (`detection/posture-analyzer.ts`)

- Inputs per frame: normalized landmarks (nose 0, ears 7/8, shoulders 11/12). Metrics: forward-head proxy (ear-shoulder horizontal offset / vertical drop of nose relative to shoulder line vs. baseline), shoulder-line tilt angle, "slouch" proxy (nose-to-shoulder-midpoint distance shrink vs. baseline as user sinks/leans in).
- Calibration: user sits upright, capture rolling median over ~5 s → `CalibrationData` baseline; thresholds = baseline ± sensitivity-scaled deltas.
- Smoothing + hysteresis: EMA over metrics; state transitions require N consecutive seconds beyond threshold (enter-bad slower than exit-bad) so the tray doesn't flicker. Visibility gate: if key landmark `visibility < 0.5` → state `no-user` (renderer keeps running; main treats it as neutral, no nagging).
- Emit `posture:update` to main at most 1/s or on state change (don't spam IPC at frame rate).

---

## 4. Keep-alive while hidden

Verified state of the world:

- `backgroundThrottling: false` disables Blink scheduler throttling, and **since Electron 27 (PR #38924) also compositor-level (`viz::DisplayScheduler`) throttling**, so with a hidden (`win.hide()`) window, rAF and frame production continue and `document.visibilityState` stays `'visible'`. On any modern Electron this is the primary mechanism. (Pre-27, hidden windows stopped rAF on Windows even with the flag — issue #31016.)
- `getUserMedia` streams are not tied to visibility; frames keep flowing into the `<video>` element while hidden.
- `requestVideoFrameCallback` fires "when a frame is presented for composition" — with compositor throttling disabled it should keep firing hidden, but this is the least-guaranteed link in the chain (and issue #42378 documents hidden-window rendering oddities with the flag). **Do not bet the product on it.**

**Prescribed frame loop (`detection/frame-loop.ts`) — rVFC primary, timer fallback, watchdog-switched:**

```ts
// Primary: rVFC with FPS throttle
const minIntervalMs = 1000 / settings.detectionFps;   // default 5 fps → 200 ms
function onFrame(now, meta) {
  lastRvfcTick = performance.now();
  if (lastRvfcTick - lastProcessed >= minIntervalMs) { lastProcessed = lastRvfcTick; runDetection(); }
  video.requestVideoFrameCallback(onFrame);
}
// Watchdog: every 2s, if rVFC hasn't ticked in > 3×minInterval while stream is live
// (track.readyState === 'live'), switch to timer mode:
timer = setInterval(() => { if (video.readyState >= 2) runDetection(); }, minIntervalMs);
// If rVFC resumes ticking (window shown again), switch back.
```

- Timers are exempt from throttling under `backgroundThrottling: false`, so the `setInterval` path works hidden regardless of compositor behavior. At 5 fps, timer-driven sampling loses nothing vs. rVFC (rVFC's per-frame precision is irrelevant for posture).
- `runDetection()` guards re-entrancy (skip if previous `detectForVideo` still executing — matters on CPU delegate).
- ~~Extra belt: `powerSaveBlocker.start('prevent-app-suspension')`~~ — dropped: it kept laptops awake for no posture benefit (§2, Pause and the lock screen).
- Explicitly do **not** use `document.visibilitychange` as the switch signal — with `backgroundThrottling: false` visibility stays `'visible'` when hidden, so the watchdog (actual rVFC starvation) is the only truthful signal.
- Escalation path if a future Electron regresses hidden rendering: move detection into a dedicated always-hidden worker `BrowserWindow` (never shown, never closed) and make the UI window a pure viewer. The IPC contract below already supports this split — detection events flow through main either way. Not needed for v1.

---

## 5. Typed IPC contract (`src/shared/ipc.ts`)

Single source of truth; preload and main both import it. Preload exposes exactly this surface via `contextBridge` — no raw `ipcRenderer` in the renderer.

```ts
// ---------- payloads ----------
export type PostureState = 'good' | 'warn' | 'bad' | 'no-user';
export interface PostureUpdate { state: PostureState; score: number;          // 0..1
  metrics: { headForward: number; shoulderTilt: number; slouch: number }; ts: number; }
export interface DetectionStatus { running: boolean; delegate: 'GPU' | 'CPU' | null;
  fps: number; cameraError: 'in-use' | 'not-found' | 'denied' | null; }
export interface CalibrationData { capturedAt: number;
  baseline: { headForward: number; shoulderTilt: number; slouch: number }; }

// ---------- renderer → main: invoke (request/response) ----------
'settings:get'        : () => Settings
'settings:set'        : (patch: Partial<Settings>) => Settings   // merged result; main persists,
                                                                 // applies side effects (autostart, pause)
'app:get-status'      : () => { paused: boolean; version: string }
'app:show-window'     : () => void
'notify:test'         : () => void                               // settings UI "test notification"

// ---------- renderer → main: send (fire-and-forget) ----------
'posture:update'      : PostureUpdate        // drives tray icon + notification policy
'detection:status'    : DetectionStatus      // drives tray tooltip/stale detection, UI mirrors
'calibration:done'    : CalibrationData      // main persists into settings.calibration

// ---------- main → renderer: send ----------
'control:set-paused'  : { paused: boolean }  // tray/UI toggled; renderer starts/stops camera
'control:calibrate'   : void                 // tray "Recalibrate" → renderer opens wizard
'settings:changed'    : Settings             // any change (incl. from tray) → renderer store syncs
```

Notes: pause state's source of truth is **main** (tray must work with renderer crashed); camera enumeration stays renderer-side (`enumerateDevices` is a web API) with only the chosen `deviceId` round-tripping through settings. Implement as a `channels` const object + mapped types so `invoke`/`handle` signatures are compile-checked on both ends.

---

## 6. electron-builder config (`electron-builder.yml`)

```yaml
appId: com.cedrickgd.sitsense          # MUST match app.setAppUserModelId
productName: SitSense
directories: { buildResources: build, output: dist }
files:
  - out/**                             # electron-vite output (main, preload, renderer+assets)
  - resources/**
asarUnpack:
  - resources/**                       # tray ICOs need real file paths
win:
  target: [ nsis, portable ]
  icon: build/icon.ico
nsis:
  oneClick: true                       # or false for a directory-choice wizard
  perMachine: false                    # per-user: no UAC, HKCU autostart works cleanly
  createStartMenuShortcut: true        # REQUIRED for reliable toasts (AUMID shortcut)
  createDesktopShortcut: true
  runAfterFinish: true
portable:
  artifactName: SitSense-portable-${version}.exe
npmRebuild: false                      # no native deps — keep it that way
```

No `extraResources` needed for wasm/model — they live in `out/renderer` via Vite's `public/` copy and ride inside the asar; the `app://` protocol handler serves them from there (`net.fetch` reads inside asar transparently).

---

## 7. Pitfalls checklist

1. **Toasts silently dropped**: Focus Assist / Do-Not-Disturb swallows toasts (they land in the Action Center only); per-app notification toggle in Windows Settings can be off; Windows rate-limits bursts. Mitigate: cooldown policy (§2), a "test notification" button in settings that tells the user to check Windows notification settings if nothing appears, and tray icon as the always-visible fallback signal.
2. **Toasts in dev / portable exe**: without an installed Start-menu shortcut bearing the AUMID, toasts may not appear or show generic identity. Dev: still call `setAppUserModelId`; accept imperfect dev toasts. Portable: document degraded notifications; NSIS is the primary distribution.
3. **`file://` fetch failure for wasm/model** — the #1 "works in dev, broken in production" trap here. Solved by the `app://` privileged scheme (§3). Test the *packaged* build early, with networking disabled, to prove offline operation.
4. **MediaPipe version drift**: pin `@mediapipe/tasks-vision` exactly; re-run `scripts/fetch-assets.mjs` on every dependency bump so the copied wasm matches the JS API (historical breakages: renamed/missing wasm files across minor versions).
5. **GPU delegate failures**: driver quirks, remote-desktop sessions, and GPU blocklisting can break WebGL2 → probe + try/catch + CPU fallback + persist (§3). Also handle Electron's `child-process-gone` for GPU process crashes (recreate landmarker). With no working GPU at all, WebGL only exists thanks to the SwiftShader switch (§3) — without it, even the CPU delegate fails.
6. **Camera in use / privacy toggle**: `NotReadableError` when another app holds the camera or "Let desktop apps access your camera" is off — show a specific, actionable error state and retry with backoff; never busy-loop `getUserMedia` (it can flash the LED and log errors forever).
7. **Tray icon vanishes after `explorer.exe` restart**: Chromium re-adds on `TaskbarCreated` in current Electron, but regressions recur. Cheap insurance: keep the `Tray` instance referenced globally (GC'd trays vanish — classic bug), and re-`setImage`/recreate the tray if a health-check detects `tray.isDestroyed()`.
8. **Hidden-window regressions**: `backgroundThrottling: false` behavior has regressed across Electron majors repeatedly (issues #31016, #42378). The rVFC watchdog + timer fallback (§4) makes detection immune; add a soak test: hide window 30 min, assert posture updates keep arriving in main.
9. **Autostart wrong path**: only register when `app.isPackaged`; after NSIS updates the exe path stays stable (per-user install dir), but re-assert `setLoginItemSettings` on every boot when the setting is on.
10. **Sleep/resume**: after system resume the camera stream often dies without a clean `ended` event — listen for `powerMonitor.on('resume')` in main, tell renderer to tear down and reacquire the stream.
11. **Multiple monitors / DPI changes**: tray ICO multi-frame handles per-DPI selection; don't cache scaled bitmaps yourself.
12. **Privacy posture**: never write frames to disk, no telemetry; state this in the README and make the webcam LED honest by fully releasing the camera on pause (§3).

### Suggested build order

1. Scaffold electron-vite (React+TS) + Tailwind; commit clean baseline.
2. Main-process skeleton: AUMID, single-instance, window + close-to-tray, static tray, settings store, typed IPC plumbing.
3. `app://` protocol + asset script; prove `PoseLandmarker` init offline in a packaged build (this is the highest-risk item — de-risk first).
4. Camera module + frame loop + posture analyzer + calibration wizard.
5. Notification policy + dynamic tray + pause/autostart.
6. electron-builder NSIS/portable; offline soak + hidden-window soak tests.

### Critical Files for Implementation
- C:/Users/cedri/source/repos/CedrickGD/SitSense/src/main/index.ts
- C:/Users/cedri/source/repos/CedrickGD/SitSense/src/main/app-protocol.ts
- C:/Users/cedri/source/repos/CedrickGD/SitSense/src/shared/ipc.ts
- C:/Users/cedri/source/repos/CedrickGD/SitSense/src/renderer/src/detection/frame-loop.ts
- C:/Users/cedri/source/repos/CedrickGD/SitSense/src/renderer/src/detection/landmarker.ts

Sources:
- [FilesetResolver class — Google AI Edge](https://developers.google.com/edge/api/mediapipe/js/tasks-vision.filesetresolver)
- [Pose landmark detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- [@mediapipe/tasks-vision wasm folder (jsDelivr)](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm/)
- [mediapipe#5961 — stable method of bundling the WASM vision binary](https://github.com/google-ai-edge/mediapipe/issues/5961)
- [mediapipe#4819 — wasmBinaryPath fails to load](https://github.com/google/mediapipe/issues/4819)
- [electron#31016 — backgroundThrottling:false with hide() on Windows](https://github.com/electron/electron/issues/31016)
- [electron PR #38924 — disable throttling in viz::DisplayScheduler](https://github.com/electron/electron/pull/38924)
- [electron#42378 — hidden window blank with backgroundThrottling:false](https://github.com/electron/electron/issues/42378)
- [Electron Notifications tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [electron#41164 — Windows notification tutorial notes](https://github.com/electron/electron/issues/41164)
- [Electron release timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)