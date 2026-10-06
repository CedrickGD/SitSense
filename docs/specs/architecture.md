# SitSense — Technical Architecture Spec

Greenfield Electron desktop app, Windows-only. Repo target: `C:/Users/cedri/source/repos/CedrickGD/SitSense`. All detection is local; no frame ever leaves the machine; app must work with networking fully disabled.

> **Status (Oct 2026).** This began as the greenfield design spec. Sections marked *(current)* describe the code as it is; the rest is the original design, kept for rationale. Where they disagree, the code and the *(current)* notes win. Related specs: posture detection v2 → [`detection.md`](detection.md); connected AI models → [`ai-providers.md`](ai-providers.md); UI → [`ui.md`](ui.md).

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
   ├─ shared/                       # imported by all three processes — types + pure helpers
   │  ├─ ipc.ts                     # channel constants + payload types + SitSenseApi (§5)
   │  ├─ settings.ts                # Settings, DEFAULT_SETTINGS, mergeSettings (+ migration)
   │  ├─ posture.ts                 # PostureSnapshot, PostureAlert, CalibrationBaseline (v2)
   │  ├─ ai.ts                      # AI connection types, presets, limits (ai-providers.md)
   │  └─ update.ts                  # UpdateStatus/UpdateState, release URLs, IPC shape check (§2 "App updates")
   ├─ main/                         # (current)
   │  ├─ index.ts                   # entry: dev profile, AUMID, single-instance, boot, flush
   │  ├─ dev-profile.ts             # side-effect import: unpackaged runs use <userData>-dev
   │  ├─ app-protocol.ts            # app:// scheme (offline asset serving, §3)
   │  ├─ window.ts                  # BrowserWindow, close-to-tray, crash recovery, guards
   │  ├─ window-guards.ts           # pure helpers: trusted origin, safe external URL, backoff
   │  ├─ tray.ts                    # Tray, dynamic icon, context menu
   │  ├─ notifications.ts           # toasts (filtered by settings)
   │  ├─ notification-copy.ts       # varied toast wording
   │  ├─ pause.ts                   # pause state, timed resume, wall-clock reconcile
   │  ├─ stats.ts                   # per-minute posture log (userData/stats/YYYY-MM-DD.json)
   │  ├─ settings-store.ts          # JSON persistence in userData (§2)
   │  ├─ autostart.ts               # setLoginItemSettings wrapper (portable-aware)
   │  ├─ resources.ts               # resources/ path in dev vs packaged
   │  ├─ ipc.ts                     # ipcMain handlers behind the sender check (§5)
   │  ├─ updater.ts                 # update state machine over electron-updater (pure, injected)
   │  ├─ updater-init.ts            # Electron wiring: the ONLY importer of electron-updater
   │  └─ ai/                        # connected AI models (§2 "AI providers")
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
         ├─ detection/              # (current)
         │  ├─ camera.ts            # enumeration, getUserMedia, device-loss recovery
         │  ├─ landmarker.ts        # PoseLandmarker init, GPU→CPU fallback
         │  ├─ frame-loop.ts        # rVFC + hidden-mode timer fallback (§4)
         │  └─ controller.ts        # camera + landmarker + engine lifecycle, pause
         ├─ posture/                # detection v2 engine — see detection.md
         │  └─ features, assess, engine, calibration, episodeMachine, smoothing, stage …
         ├─ overlay/bodyMesh.ts     # preview wireframe (cosmetic only)
         ├─ state/store.ts          # zustand: settings mirror, posture, camera list
         ├─ screens/                # Dashboard, CalibrationWizard, SettingsScreen
         └─ components/             # AppShell, CameraFeed, MeshOverlay, primitives …
```

`resources/` is the electron-vite convention for main-process assets; reference as `join(__dirname, '../../resources/...')` in dev and mark `asarUnpack: resources/**` for production (tray ICOs must exist as real files on disk — `Tray` cannot read from inside asar reliably).

---

## 2. Main process modules

### Boot order (`main/index.ts`) *(current)*

```ts
import './dev-profile'                                  // FIRST import (see below)
app.setAppUserModelId('com.cedrickgd.sitsense')        // MUST equal electron-builder appId
registerAppScheme()                                     // privileged app:// — before ready (§3)
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showMainWindow)
  app.whenReady().then(() => {
    handleAppProtocol(); loadSettings(); applyAutostart(); registerIpc() /* also initAi() */
    initStats(); initPauseReconciler(); createTray(...); createMainWindow({ startHidden })
    // + window 'session-end', powerMonitor 'resume'/'shutdown' (see "Shutdown and flushing")
  })
}
```

- **Dev profile.** `dev-profile.ts` is a side-effect module: when `!app.isPackaged` it moves `userData` to `<userData>-dev`. Unpackaged, `app.name` is `sitsense`, whose folder is the same as the packaged `SitSense` on case-insensitive NTFS. Without this, dev runs would share settings, calibration, stats, AI keys **and the single-instance lock** (which lives in `userData`) with the installed app. It must be the first import in `index.ts`.
- AUMID and scheme privileges before `ready`; tray created in `ready` so the app is usable even if the window never shows; window created hidden with `--hidden` (autostart) or `general.startHidden`.

### Shutdown and flushing *(current)*

State that must survive exit: the in-progress stats minute (`stopStats()`) and a settings patch still inside its 500 ms debounce (`saveNow()`). Both are synchronous and idempotent, wrapped in `flushState()` in `index.ts`. That is a no-op until settings and stats have loaded, so a second instance that quits immediately never writes defaults over the user's files.

| Path | What flushes |
|---|---|
| Tray **Quit** / `app:quit` IPC | `app` `before-quit` marks quitting (so close-to-tray lets go) → `will-quit` flushes; `quit` destroys the tray |
| Windows shutdown, restart, logoff, Restart Manager `close-app` (e.g. an installer upgrade) | **`BrowserWindow` `session-end`** → mark quitting + flush, then `app.quit()`. Electron does *not* emit `before-quit`/`will-quit`/`quit` here, and `session-end` is a window event (WM_ENDSESSION, delivered to the hidden tray window too), never emitted on `app`. On shutdown/logoff the process is killed right after the handler returns, hence synchronous fs. A non-forced Restart Manager `close-app` only *asks* the app to exit, and the flush has stopped stats sampling for good, so the handler quits explicitly instead of lingering in the tray (the second flush from `will-quit` is a no-op). |
| Linux/macOS shutdown | `powerMonitor` `shutdown` → flush (not emitted on Windows; kept for completeness) |

A hard kill (Task Manager, crash) still loses the current stats minute and an undebounced settings patch.

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
- *(current)* The nag policy (dwell, cooldown, escalation) lives in the renderer's episode machine (`posture/episodeMachine.ts`, detection.md §8), which sends `alert:fire`. Main's `fireAlert()` only filters by pause state and the user's per-issue / per-stage notification settings, then shows the toast. (The original design put the grace timer and cooldown in main.)

### Stats history and break reminders *(current: `main/stats.ts`, `main/breaks.ts`, `main/break-tracker.ts`, `shared/stats.ts`)*

- Day files `userData/stats/YYYY-MM-DD.json` are `{ date, minutes, alerts?, breaks? }`. Files older than 90 days are pruned at start and at every day change. An unreadable day file (locked) is retried once, then tracking continues in memory without overwriting it, and the next readable save merges both; a file that won't parse is renamed to `.corrupt-<time>` first (never overwritten if that fails); a BOM is tolerated. A day change (midnight, or the clock set back) loads and continues the new date's file instead of overwriting it. A minute while detection is suspended (view changed since setup) is counted as `paused`, never good. `alerts` counts posture nudges actually shown (`fireAlert()` returns true, and `ipc.ts` then calls `statsRecordAlert()`). `breaks` counts the breaks the tracker confirms. The midnight rollover also runs when a count arrives before the next sample.
- `getStatsRange(days)` summarizes each local day (`summarizeDay`). It returns tracked, good, away and paused minutes; minutes per issue and per stage; first and last active minute; 24 hourly good/bad buckets; alerts; and breaks. Days with no file are empty entries (`hasData: false`). Today comes from memory, including the minute in progress. Summaries of past days are cached. The streak (`computeStreak`) counts consecutive days with ≥ 70 % of ≥ 30 tracked minutes aligned; an unfinished today never breaks it.
- Break reminders (`settings.breaks = { enabled, intervalMinutes 20–120, default 50 }`). Main counts the user as sitting when a posture snapshot from the last 15 s says `presence: 'active'`, monitoring is not paused **and posture setup has been saved** (no reminders before setup, ui-v3 §6). The engine starts AWAY, so an empty chair at launch never opens a stretch. Being away, paused or not detecting for ≥ 3 min (`BREAK_AWAY_MINUTES`, shared/ipc.ts — the value every screen quotes) ends the stretch. Shorter absences don't, and a gap of ≥ 3 min between ticks (sleep) does. A break counts when the stretch it ends lasted ≥ 3 min (filters a passer-by). While the user is sitting, the reminder toast fires when the interval is reached: "Time to stand up — you've been sitting for N min…", with a **Snooze 10 min** action. An ignored reminder repeats every 15 min, and a snooze replaces that repeat. No toast is shown while paused.

### Settings persistence (`main/settings-store.ts`) *(current)*

- Plain JSON at `join(app.getPath('userData'), 'settings.json')`, no dependency. Writes are debounced 500 ms and atomic: write `settings.json.tmp`, `fsync`, then `renameSync` (the fsync means a power loss can't leave a truncated file behind the rename).
- **Load failures never lose the user's file.** `ENOENT` is the only "first run" → defaults. Any other read error (e.g. `EBUSY`/`EPERM` while AV or backup software holds the file at login) is retried once after 150 ms; if it still fails, the app runs on defaults for the session and `saveNow()` refuses to write while that file exists. A file that reads but doesn't parse to a JSON object (truncated, empty, trailing comma, `[]`, `null`) is renamed to `settings.json.corrupt-<ISO timestamp>` before anything can save (copied if the rename fails; if both fail, saving is blocked as above). A leading UTF-8 BOM (Notepad's "UTF-8 with BOM", PowerShell 5.1 `Set-Content -Encoding utf8`) is stripped before parsing, so such a hand edit is not treated as corrupt. Both cases are logged and exposed through `getSettingsLoadIssue()`, and `index.ts` shows a toast once per launch (settings reset + the backup's file name, or file unreadable and left untouched). `settingsLoadedFromDisk()` is true only after a clean parse **and** while no `settings.json.corrupt-*` backup sits beside the file; the AI module prunes orphan keys only when it is true. The second condition matters because a defaults session writes a clean `settings.json` on quit: without it, the next launch would prune every key against that file even though the backup still holds the connections. Restoring or deleting the backup lets pruning resume (deleting a connection still deletes its key directly; pruning is only the safety net).
- **Merge and migration.** `mergeSettings()` (`shared/settings.ts`) deep-merges the file over `DEFAULT_SETTINGS`, clamps numbers and falls back on unknown enum values, so a stale or hand-edited file never crashes the app. `settingsVersion` is **2** (`SETTINGS_VERSION`); a file without it counts as v1. v1 → v2: `calibration` is dropped unless it is a v2 baseline (`isCurrentBaseline`, `version === 2`), because v1 frontal-camera baselines mean nothing to the v2 engine and setup must re-run; a v1 overlay style of `'mesh'` (the old default) becomes `'skeleton'`. Every saved file carries the current version.
- **Normalizer hook.** `setSettingsNormalizer()` lets the AI module recompute `ai.connections[].hasKey/keyHint` from the key store after every merge, so those fields can't be forged through `settings:set`.
- Shape: see `Settings` in `shared/settings.ts` (camera, performance preset, delegate + resolved delegate, per-issue enable / sensitivity / notify stages, notifications, general, overlay, `calibration: CalibrationBaseline | null`, `ai`, `onboarded`, `settingsVersion`).

### Autostart (`main/autostart.ts`)

```ts
app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
```

On boot: `process.argv.includes('--hidden')` → create window with `show: false` and skip `win.show()`. Guard: only offer/enable autostart when `app.isPackaged` (dev `electron.exe` path would be registered otherwise). Portable-exe caveat in §7.

### Window lifecycle (`main/window.ts`)

```ts
let isQuitting = false;
win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });
// tray Quit / before-quit:
app.on('before-quit', () => { isQuitting = true; });
```

- Size *(current)*: opens at 1200×800, shrunk to fit 92 % of the primary display's work area on small screens (`initialWindowSize` in `window-guards.ts`). The minimum is 780×580.
- First hide-to-tray: fire a one-time toast/balloon "SitSense is still watching from the tray" so users don't think it quit.
- `webPreferences` *(current)*: `contextIsolation: true`, `nodeIntegration: false`, **`sandbox: true`** (the bundled preload only uses `contextBridge` + `ipcRenderer`, which the sandboxed preload provides), **`backgroundThrottling: false`** (critical, §4), `preload: join(__dirname, '../preload/index.js')`.

### Window security guards *(current: `window.ts` `installSecurityGuards`, helpers in `window-guards.ts`)*

"Our renderer" means origin `app://renderer`, or in dev the origin of `ELECTRON_RENDERER_URL` (`isTrustedRendererUrl`).

- **Popups:** `setWindowOpenHandler` always denies. Plain `https:` URLs (only) go to `shell.openExternal`; never `file:`, `ms-*`, `search-ms:` or other protocol handlers (`isSafeExternalUrl`).
- **Navigation:** `will-navigate` / `will-redirect` are cancelled unless the target is our renderer (safe https targets open externally instead). `will-attach-webview` is always prevented.
- **Permissions:** `setPermissionRequestHandler` grants only `media` whose `mediaTypes` are all video, and only to our renderer. `setPermissionCheckHandler` applies the same policy to synchronous checks (never audio).
- **IPC sender validation** (`ipc.ts`): see §5.

### Renderer / GPU crash recovery *(current: `window.ts` `installCrashRecovery`)*

Detection runs in the renderer, so a dead renderer means monitoring silently stops. `render-process-gone` (except `clean-exit`) and a GPU `child-process-gone` (which loses every WebGL context MediaPipe uses) schedule a reload of the renderer URL with exponential backoff: 1 s, 2 s, 4 s … capped at 60 s, counted over a 5-minute window (`nextReloadDelay`). It never gives up. A window that stays `unresponsive` for 20 s has its renderer force-crashed so the same path reloads it. Nothing reloads once quitting.

### AI providers *(current: `src/main/ai/`, full spec in [`ai-providers.md`](ai-providers.md))*

Opt-in "bring your own key" posture review. Off by default; with it off the AI module makes no network requests (the only other network use is the update check, "App updates" below, which can be turned off too).

- `index.ts`: Electron wiring, called from `registerIpc()` after `ready`. Builds the key store on `safeStorage`, prunes keys of deleted connections (only when settings really loaded from disk), installs the settings normalizer, and cancels in-flight requests when AI is switched off or monitoring is paused.
- `keystore.ts`: API keys encrypted with `safeStorage` (DPAPI on Windows) in `userData/ai-keys.json` (`{ [connectionId]: base64(cipher) }`, atomic writes). Refuses to store when encryption is unavailable (or Linux `basic_text`). Plaintext never touches disk and keys never leave main; the renderer only sees `hasKey` and a `…abcd` hint.
- `service.ts` (the IPC-facing operations), `judge.ts` (prompt, priority-order fallback, response validation), `validate.ts` (payload checks, base-URL rules, `stripAiConnections` so `settings:set` can't touch connections), `http.ts`, `errors.ts` (short user-facing messages that never contain keys), `providers/` (`anthropic`, `openai`, `openai-compatible`, `openrouter`, `gemini`, `vertex`, with shared `chat` / `google` helpers).
- IPC: `ai:save-connection`, `ai:remove-connection`, `ai:move-connection`, `ai:test-connection`, `ai:list-models`, `ai:review-posture` (§5).

### App updates *(current: `main/updater.ts`, `main/updater-init.ts`, `shared/update.ts`)*

Updates come from **GitHub Releases** of `CedrickGD/SitSense` through `electron-updater` (a production dependency, packed into `app.asar/node_modules`; see packaging.md "Updates"). Besides the AI module it is the only code that reaches the network, and it sends nothing about the user: it asks for the release feed and `latest.yml` and, for the installed build, downloads the installer.

- **Modes.** `installed` (the NSIS install): `autoDownload` and `autoInstallOnAppQuit` on, so a new version downloads in the background and installs on "Restart to update" (`quitAndInstall(isSilent=true, forceRunAfter=true)`) or the next time SitSense quits. `portable` (`process.env.PORTABLE_EXECUTABLE_FILE` set): both off; a check only reports `available`, and "Download" opens the release page (`https://github.com/CedrickGD/SitSense/releases/tag/v<version>`, built in main from a validated semver, never from renderer input) via `shell.openExternal`. `dev` (unpackaged): `createUpdateService` gets `updater: null`, so nothing is ever requested.
- **State machine** (`UpdateStatus.state`): `idle | checking | up-to-date | available{version, notes, portable} | downloading{version, percent} | ready{version} | error{message}`. One check at a time; no check while downloading or ready; a later error never hides `ready`; a failed *background* check keeps a portable `available`. Errors become one friendly sentence (`friendlyUpdateError`: offline, rate limit, no release, integrity, not updatable); the raw error only goes to the console. No dialogs, ever; no toast for errors.
- **When.** 30 s after start and every 6 h, only while `settings.updates.autoCheck` is on (default on; read when the timer fires, so turning it off stops automatic requests at once). Turning it on after a skipped startup check checks right away. "Check for updates" in Settings › About works with auto-check off.
- **Ready.** One toast per version, "SitSense <ver> is ready — restart to update", with a **Restart** action (`notifications.updateReadyToast`); the tray menu gains "Restart to update"; the sidebar shows "Update ready · Restart"; About shows "Restart to update". `install()` calls `markQuitting()` first so the close-to-tray window lets go; `will-quit` flushes stats/settings as on any quit.
- **Wiring.** `updater-init.ts` is the only file that imports `electron-updater`, and passes its `autoUpdater` only as `createUpdateService({ updater: packaged ? autoUpdater : null, … })`. `scripts/verify-package.mjs` (check 3b) enforces exactly that on the bundled `out/main`, plus: no Electron (Squirrel) `autoUpdater`, no `setFeedURL`/feed override, network APIs in `node_modules` only in `electron-updater`/`builder-util-runtime`, and `resources/app-update.yml` = provider github, `CedrickGD/SitSense`.
- IPC: `update:get-state`, `update:check`, `update:download`, `update:install`; event `update:state` (§5).

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

1. If `settings.delegate === 'auto'`: probe `document.createElement('canvas').getContext('webgl2')` — if null, go straight to CPU.
2. `createFromOptions(..., delegate: 'GPU')` in try/catch; on throw **or** on a failed first `detectForVideo` (some GPU failures surface only at first inference), `close()` and recreate with `delegate: 'CPU'`.
3. Persist the winning delegate via `settings:set` so subsequent launches skip the probe. Report active delegate in `detection:status` (show in UI).
4. Timestamps: always `performance.now()`; MediaPipe throws on non-monotonic input in VIDEO mode.

### Posture analysis (superseded by detection v2)

> *(current)* The frontal-camera analyzer described below was v1 and is gone. Detection v2 (`src/renderer/src/posture/`) works from any camera angle with only the head and one shoulder visible: visibility-weighted 3D features, a gravity estimate and body frame, AI-judged "good posture" during setup (which saves a v2 `CalibrationBaseline` automatically), four issues (`sink`, `headForward`, `lean`, `tooClose`) with three stages each, wall-clock smoothing, and presence / episode machines that drive `posture:update` and `alert:fire`. It is verified against a 3D posture simulator rendered from many viewpoints. **Spec: [`detection.md`](detection.md).** The v1 notes below are history only.


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
- *(current)* **No `powerSaveBlocker`.** The original design held `'prevent-app-suspension'` while unpaused. On Windows that is a system-required power request that stops idle sleep all day (a laptop drains, the webcam films an empty room overnight) and buys nothing: Windows does not suspend Win32 desktop processes, and hidden-window throttling is already off. The machine may sleep. On `powerMonitor` `resume`, main reconciles timed pauses against their wall-clock deadline (`initPauseReconciler` also checks every 30 s) and sends `system:resumed` so the renderer re-acquires the camera.
- Explicitly do **not** use `document.visibilitychange` as the switch signal — with `backgroundThrottling: false` visibility stays `'visible'` when hidden, so the watchdog (actual rVFC starvation) is the only truthful signal.
- Escalation path if a future Electron regresses hidden rendering: move detection into a dedicated always-hidden worker `BrowserWindow` (never shown, never closed) and make the UI window a pure viewer. The IPC contract below already supports this split — detection events flow through main either way. Not needed for v1.

---

## 5. Typed IPC contract (`src/shared/ipc.ts`) *(current)*

Single source of truth: the `IPC` channel constants and the `SitSenseApi` interface. The preload (`src/preload/index.ts`) exposes exactly that surface as `window.sitsense` via `contextBridge`; the renderer never touches `ipcRenderer`.

| Direction | Channel | Payload / result |
|---|---|---|
| invoke | `settings:get` | → `Settings` |
| invoke | `settings:set` | deep-partial patch (`ai.connections` stripped) → merged `Settings`; applies autostart, broadcasts `settings:changed`, refreshes the tray |
| invoke | `app:get-status` | → `AppStatus` (version, pause, packaged, windowVisible) |
| invoke | `stats:get-today` | → `TodayStats` |
| invoke | `notify:test` | shows a test toast |
| invoke | `pause:set` | `(paused: boolean, minutes: number \| null)` → `PauseState` (validated in `pause.ts`) |
| invoke | `window:control` | `'minimize' \| 'hide'` (hide = close-to-tray) |
| invoke | `app:quit` | quits |
| invoke | `ai:save-connection`, `ai:remove-connection`, `ai:move-connection` | → `Settings` (rejects with a short message on invalid input) |
| invoke | `ai:test-connection` / `ai:list-models` / `ai:review-posture` | → `AiTestResult` / `AiModelList` / `AiPostureReview` |
| invoke | `ai:chat` | `AiChatRequest` → `AiChatReply` (coach chat, never rejects; ai-providers.md §7) |
| invoke | `ai:chat-cancel` | aborts the running coach chat (Stop / Clear chat) |
| invoke | `ai:cancel-review` | `requestId` → aborts that posture review and frees main's single review slot |
| invoke | `stats:get-range` | `days` (finite number, rounded and clamped to 1..90; anything else rejects) → `StatsRange` (`{ days: DaySummary[]; streak: StreakInfo }`, oldest first, `shared/stats.ts`) |
| invoke | `breaks:snooze` | `minutes?` (default 10, clamped to 1..120) → `SittingState` |
| invoke | `update:get-state` | → `UpdateStatus` (`currentVersion`, `mode`, `state`, `lastCheckedAt`; §2 "App updates") |
| invoke | `update:check` | manual check (allowed with auto-check off) → `UpdateStatus` |
| invoke | `update:download` | state `available`: installed → download; portable → open the release page → `UpdateStatus` |
| invoke | `update:install` | state `ready` (installed): quit, install silently, restart → `boolean` (false = nothing to install) |
| send | `posture:update` | `PostureSnapshot` → tray icon + stats |
| send | `alert:fire` | `PostureAlert` → toast (filtered by settings) |
| send | `detection:status` | `DetectionStatus` |
| main → renderer | `settings:changed`, `pause:changed`, `control:calibrate`, `control:navigate`, `system:resumed`, `window:visibility` | |
| main → renderer | `window:closed-to-tray` | the close button hid the window (not a minimize): the renderer leaves an open posture setup |
| main → renderer | `breaks:sitting` | `SittingState` (`onSittingChanged`; sent when the minute count or break/reminder state changes). Also in `AppStatus.sitting` |
| main → renderer | `update:state` | `UpdateStatus` on every change (`onUpdateState`); the renderer drops anything `isUpdateStatus()` rejects |

**Sender validation.** Every `ipcMain.handle` / `ipcMain.on` in `main/ipc.ts`, including all `ai:*` channels, is registered through the `handle()` / `on()` wrappers, which call `isTrustedIpcSender()` first. A message is accepted only if `event.sender` is the main window's `webContents`, `event.senderFrame` exists and is a top frame (`parent === null`) with the same `processId` / `routingId` as `webContents.mainFrame`, and its URL is our renderer origin (`app://renderer`, or the `ELECTRON_RENDERER_URL` origin in dev). Otherwise invokes reject with `Unauthorized IPC sender` and sends are dropped; both are logged.

**Payload checks.** A trusted sender still gets its payload checked. `settings:set` goes through `stripAiConnections()` + `mergeSettings()` (non-object patches are ignored), `pause:set` through `setPause()`'s own checks, and every `ai:*` handler validates its arguments in the AI service. The three sends are shape-checked in `ipc.ts` (`isPostureSnapshot`, `isPostureAlert`, `isDetectionStatus`) and silently dropped if malformed, so a renderer bug can't throw inside a listener or leave tray/stats state that a timer later dereferences (for example a snapshot with an empty `issues` map). `stats:get-range` and `breaks:snooze` validate their number in `stats.ts` / `break-tracker.ts`. `window:control` acts only on `'minimize'` and `'hide'` and ignores any other value. The `update:*` invokes read **no** renderer arguments at all (extra arguments are ignored): main alone decides what to check, which version to download, which page to open and what to install. The remaining invokes (`settings:get`, `app:get-status`, `stats:get-today`, `notify:test`, `app:quit`) take no payload.

Pause state's source of truth is **main** (the tray must work with the renderer crashed). Camera enumeration stays renderer-side; only the chosen `deviceId` round-trips through settings.

---

## 6. electron-builder config (`electron-builder.yml`)

```yaml
appId: com.cedrickgd.sitsense          # MUST match app.setAppUserModelId
productName: SitSense
directories: { buildResources: build, output: dist }
files:
  - out/**                             # electron-vite output (main, preload, renderer+assets)
  - resources/**
  # (current) node_modules: only the production "dependencies" closure is packed
  # (electron-updater + deps); docs/maps/typings inside it are filtered out
asarUnpack:
  - resources/**                       # tray ICOs need real file paths
win:
  target: [ nsis, portable ]
  icon: build/icon.ico
nsis:
  artifactName: ${productName}-Setup-${version}.${ext}   # (current) no spaces: = latest.yml url = GitHub asset name
  oneClick: true                       # or false for a directory-choice wizard
  perMachine: false                    # per-user: no UAC, HKCU autostart works cleanly
  createStartMenuShortcut: true        # REQUIRED for reliable toasts (AUMID shortcut)
  createDesktopShortcut: true
  runAfterFinish: true
  include: build/installer.nsh         # (current) a real uninstall removes the HKCU Run autostart value and %LOCALAPPDATA%\sitsense-updater (the cached update installer)
portable:
  artifactName: SitSense-portable-${version}.exe
npmRebuild: false                      # no native deps — keep it that way
publish:                               # (current) update feed only; builds run with --publish never
  provider: github
  owner: CedrickGD
  repo: SitSense
  releaseType: release
```

No `extraResources` needed for wasm/model — they live in `out/renderer` via Vite's `public/` copy and ride inside the asar; the `app://` protocol handler serves them from there (`net.fetch` reads inside asar transparently).

---

## 7. Pitfalls checklist

1. **Toasts silently dropped**: Focus Assist / Do-Not-Disturb swallows toasts (they land in the Action Center only); per-app notification toggle in Windows Settings can be off; Windows rate-limits bursts. Mitigate: cooldown policy (§2), a "test notification" button in settings that tells the user to check Windows notification settings if nothing appears, and tray icon as the always-visible fallback signal.
2. **Toasts in dev / portable exe**: without an installed Start-menu shortcut bearing the AUMID, toasts may not appear or show generic identity. Dev: still call `setAppUserModelId`; accept imperfect dev toasts. Portable: document degraded notifications; NSIS is the primary distribution.
3. **`file://` fetch failure for wasm/model** — the #1 "works in dev, broken in production" trap here. Solved by the `app://` privileged scheme (§3). Test the *packaged* build early, with networking disabled, to prove offline operation.
4. **MediaPipe version drift**: pin `@mediapipe/tasks-vision` exactly; re-run `scripts/fetch-assets.mjs` on every dependency bump so the copied wasm matches the JS API (historical breakages: renamed/missing wasm files across minor versions).
5. **GPU delegate failures**: driver quirks, remote-desktop sessions, and GPU blocklisting can break WebGL2 → probe + try/catch + CPU fallback + persist (§3). Also handle Electron's `child-process-gone` for GPU process crashes; *(current)* main reloads the renderer with backoff (§2, crash recovery).
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