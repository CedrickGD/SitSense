# SitSense

A Windows desktop app that watches your posture through any webcam using a **local AI pose-estimation model** (MediaPipe PoseLandmarker) and nudges you with a toast notification the moment you start sinking into your chair.

- **100% local.** The neural network runs on your GPU/CPU. No frame, no image, no posture data ever leaves your machine — the packaged app works with networking fully disabled. Calibration stores a handful of numbers (angles and ratios), never pictures.
- **Works with what the camera sees.** Head + shoulders is enough; it degrades gracefully to face-only and pauses silently when you step away.
- **4 issues × 3 stages.** Sinking/slouching, head-forward, side lean, too close to screen — each with slight/clear/severe stages, every notification individually toggleable.
- **See what it sees.** The live preview wraps you in a glowing wireframe: a triangulated mesh over your whole silhouette with a detailed face mesh, in a color of your choice (or one that follows your posture). Choose Mesh, Hologram, Skeleton or Off in Settings. This work only runs while the preview is on screen.
- **Nudges that don't repeat themselves.** Every issue and stage has several phrasings, rotated so you won't see the same line twice in a row. Each toast carries a small spine icon, bent to match the issue and colored by its stage.
- **Lives in the tray.** Close the window and it keeps watching; the tray icon mirrors your posture (sage → amber → coral). Pause for 15/30/60 minutes releases the camera entirely (LED off).
- **Keeps itself up to date.** The installed app checks GitHub Releases for a new version (shortly after start, then every 6 hours), downloads it in the background and installs it when you click **Restart to update** — or the next time it quits. The portable exe tells you when a new version is out and links to the download. The version you run is shown in the sidebar and in Settings › About, where you can also check by hand or turn automatic checks off. The check only asks GitHub for the latest version; no posture data is sent.

## Development

```
npm install          # also fetches the MediaPipe wasm + pose/face models (build-time only)
npm run dev          # run with hot reload
npm test             # unit tests for the detection core
npm run dist         # build the NSIS installer + portable exe (+ latest.yml update feed)
```

Releasing a new version (installed copies update themselves from it): see [docs/specs/packaging.md › Releasing an update](docs/specs/packaging.md#releasing-an-update).

## Design docs

The full specs (detection algorithm, Electron architecture, UI system) live in [docs/specs/](docs/specs/).
