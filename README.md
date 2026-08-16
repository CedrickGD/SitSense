# SitSense

A Windows desktop app that watches your posture through any webcam using a **local AI pose-estimation model** (MediaPipe PoseLandmarker) and nudges you with a toast notification the moment you start sinking into your chair.

- **100% local.** The neural network runs on your GPU/CPU. No frame, no image, no data ever leaves your machine — the packaged app works with networking fully disabled. Calibration stores a handful of numbers (angles and ratios), never pictures.
- **Works with what the camera sees.** Head + shoulders is enough; it degrades gracefully to face-only and pauses silently when you step away.
- **4 issues × 3 stages.** Sinking/slouching, head-forward, side lean, too close to screen — each with slight/clear/severe stages, every notification individually toggleable.
- **Lives in the tray.** Close the window and it keeps watching; the tray icon mirrors your posture (sage → amber → coral). Pause for 15/30/60 minutes releases the camera entirely (LED off).

## Development

```
npm install          # also fetches the MediaPipe wasm + pose model (build-time only)
npm run dev          # run with hot reload
npm test             # unit tests for the detection core
npm run dist         # build the NSIS installer + portable exe
```

## Design docs

The full specs (detection algorithm, Electron architecture, UI system) live in [docs/specs/](docs/specs/).
