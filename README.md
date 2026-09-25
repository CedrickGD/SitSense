# SitSense

A Windows desktop app that watches your posture through any webcam using a **local AI pose-estimation model** (MediaPipe PoseLandmarker) and nudges you with a toast notification the moment you start sinking into your chair.

- **100% local.** The neural network runs on your GPU/CPU. No frame, no image, no data ever leaves your machine — the packaged app works with networking fully disabled, and blocks every outbound request it would otherwise make (MediaPipe's usage telemetry included). Calibration stores a handful of numbers (angles and ratios), never pictures.
- **Works with what the camera sees.** Head + shoulders is enough; it degrades gracefully to face-only and pauses silently when you step away.
- **4 issues × 3 stages.** Sinking/slouching, head-forward, side lean, too close to screen — each with slight/clear/severe stages, every notification individually toggleable.
- **See what it sees.** The live preview wraps you in a glowing wireframe: a triangulated mesh over your whole silhouette with a detailed face mesh, in a color of your choice (or one that follows your posture). Choose Mesh, Hologram, Skeleton or Off in Settings. This work only runs while the preview is on screen.
- **Nudges that don't repeat themselves.** Every issue and stage has several phrasings, rotated so you won't see the same line twice in a row. Each toast carries a small spine icon, bent to match the issue and colored by its stage.
- **Lives in the tray.** Close the window and it keeps watching (or turn that off in Settings → General); the tray icon mirrors your posture (sage → amber → coral). Pause for 15/30/60 minutes — from the dashboard, the tray or a toast's `Pause 15 min` button — releases the camera entirely (LED off). Locking your PC does the same until you unlock it.
- **Runs without a GPU.** Uses the GPU when there is a real one and falls back to the CPU otherwise, including on VMs, remote sessions and blocklisted drivers.

## Requirements

- Windows 10 or 11 and any webcam.
- For development: Node.js 22+ (see `.nvmrc`).

## Development

```
npm install          # also fetches the MediaPipe wasm + pose/face models (build-time only, checksum-pinned)
npm run dev          # run with hot reload
npm run check        # typecheck + unit tests
npm test             # unit tests only
npm run gen-icons    # regenerate tray, toast and app icons
npm run dist         # check, then build the NSIS installer + portable exe
```

`npm run dev` keeps its settings in a separate `…-dev` profile, so it never touches an installed copy's data.

### Portable exe

The portable build works, but Windows only shows toasts reliably for apps with a Start-menu shortcut, which the installer creates and the portable exe doesn't. Use the installer if you rely on notifications.

### Packaged-build hardening

Release builds flip Electron's fuses (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`; app code only from `app.asar`) and ship a stricter Content-Security-Policy than dev. `scripts/drive-packaged.mjs` smoke-tests a packaged build over the DevTools port, since Playwright's usual Electron launcher needs `--inspect`.

## Design docs

The full specs (detection algorithm, Electron architecture, UI system) live in [docs/specs/](docs/specs/).
