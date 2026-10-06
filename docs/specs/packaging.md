# Packaging: self-contained, offline Windows build

SitSense ships as one Windows build that carries everything it needs. A user
downloads one exe and runs it. There is no Visual C++ redistributable, no .NET,
no WebView2, no Node, no Python, no GPU driver requirement and no first-run
download. The only optional network uses are the user's own AI connections and
the update check against GitHub Releases ("Updates" below), and the app works
fully offline without either.

Build: `npm run dist` (or `npm run dist:dir` for `dist/win-unpacked` only).
Verify: `npm run verify:package` (details below).

## What a build contains

| Artifact | What it is |
|---|---|
| `dist/SitSense-Setup-<v>.exe` | NSIS one-click installer (no spaces in the name: it must equal the asset name on GitHub and the `url` in `latest.yml`). **Per-user**: installs to `%LOCALAPPDATA%\Programs\SitSense`. Its manifest is `asInvoker`, so there is no UAC prompt and no admin needed. It creates the Start-menu shortcut (with the app's AUMID) that toasts need. |
| `dist/SitSense-portable-<v>.exe` | A single-file NSIS self-extractor (also `asInvoker`). Each run unpacks into `%TEMP%`, runs, and cleans up afterwards. No install, no admin. |
| `dist/SitSense-Setup-<v>.exe.blockmap` | Block map of the installer: lets installed copies download only the changed blocks of the next version. |
| `dist/latest.yml` | The update feed for installed copies: version, installer file name, size, sha512 ("Updates" below). |
| `dist/win-unpacked/` | The app folder that both exes wrap. `npm run verify:package` checks this folder. |

Inside the app folder:

- **Electron runtime** (`SitSense.exe`, ffmpeg, ANGLE `libEGL`/`libGLESv2`,
  `d3dcompiler_47`, `dxcompiler`/`dxil`, SwiftShader `vk_swiftshader` +
  `vulkan-1`, ICU data, V8 snapshots, locales). The CRT is linked
  statically, and the import scan checks this.
- **`resources/app.asar`**:
  - `out/main`, `out/preload`: bundled by electron-vite. They `require` only
    Node built-ins, `electron` and the production dependencies in
    `package.json` `dependencies` — today only `electron-updater`.
  - `node_modules`: exactly the production dependency closure (`electron-updater`,
    `builder-util-runtime`, `fs-extra`, `js-yaml`, `semver`, … ~1 MB), without
    docs, typings or source maps. Everything else in `package.json` is a
    devDependency (bundled by Vite, or build-time only) and is never packed, so a
    new runtime dependency that is neither bundled nor a production dependency
    fails verification, and so does any extra package in the asar.
  - `out/renderer`: `index.html`, the JS/CSS bundle, and all fonts as local
    `woff`/`woff2` files (@fontsource: Bricolage Grotesque, Hanken Grotesk, IBM
    Plex Mono). No Google Fonts or other CDN.
  - `out/renderer/mediapipe/wasm`: `vision_wasm_internal.{js,wasm}` (SIMD)
    and `vision_wasm_nosimd_internal.{js,wasm}` (the fallback for CPUs without
    WASM SIMD). `scripts/fetch-assets.mjs` copies exactly these four files.
    The ES-module variant is never loaded and is not shipped.
  - `out/renderer/models`: `pose_landmarker_lite.task` (posture) and
    `face_landmarker.task` (preview face mesh only).
- **`resources/app.asar.unpacked/resources`**: the tray ICOs and toast PNGs.
  They are real files on disk because Windows reads them by path.

The renderer is served from the privileged `app://renderer/` scheme
(`src/main/app-protocol.ts`), so MediaPipe can `fetch()` its wasm and models
offline (see architecture.md §3).

### Renderer CSP

`src/renderer/index.html` carries the **production** CSP:
`connect-src 'self' blob: data:` and `script-src 'self' 'wasm-unsafe-eval'`.
That means no `ws:`, no `http(s):`, no host and no inline script. The Vite dev
server needs two sources that must never ship:

- `connect-src ws:` for the HMR socket
- `script-src 'unsafe-inline'` for the React Refresh preamble

`cspPlugin()` in `electron.vite.config.ts` adds both, at serve time only
(`apply: 'serve'`). At build time (`apply: 'build'`) it throws if the emitted
`index.html` CSP has no `default-src`, if **any** source-list directive (not a
fixed subset — an explicit `frame-src`, `child-src`, `object-src`,
`manifest-src`, `base-uri`, `form-action`, … counts too) lists a source outside
an allow-list (`'self'`, `'none'`, other quoted keywords, hashes/nonces, `blob:`,
`data:`, `mediastream:`, `filesystem:`, `app:`), or if `script-src` /
`script-src-elem` allows inline script. So `ws:`, `https:`, `*`, a host, or any
other scheme FAILs the build. Check 3 applies the same allow-list to the
packaged copy. The strict CSP
was smoke-tested end to end: the full verifier passed against a copy of the
packaged app with only its CSP replaced.

## Guarantees and how they are proven

`node scripts/verify-package.mjs` runs against an existing build. It does not
build anything. It prints PASS / WARN / FAIL per check and exits with 1 on any
FAIL.

| # | Check | Proves |
|---|---|---|
| 1 | **PE import scan** (`pe-imports`) | It parses the import and delay-import tables of every `.exe/.dll/.node` in the app folder in plain Node. Every imported DLL is either shipped in the folder, an OS API set (`api-ms-win-*`; `api-ms-win-crt-*` is the in-box Win10 UCRT), or on a list of in-box Windows 10/11 DLLs. VC++ runtimes (`vcruntime*`, `msvcp*`, `msvcr*`), .NET (`mscoree`) and DirectX SDK redists (`d3dx9_*`, `xinput1_3`, …) always FAIL. A **static** import of a Media Foundation DLL (`mf.dll`, `mfplat.dll`, `mfreadwrite.dll`, `evr.dll`) FAILs too, because the exe would then not start at all on Windows N/KN; a delay-load is fine. `SitSense.exe` imports no CRT at all, which proves the CRT is linked statically. An import scan cannot see DLLs loaded with `LoadLibrary` at run time (see Windows N below). |
| 2 | **Bundle contents** (`bundle`) | It reads the asar header directly. It checks that `package.json` main and the preload exist, that every file `index.html` references exists, that every CSS `url()` (fonts) exists, and that the wasm base and `.task` paths the renderer bundle references exist. Wasm files must have the wasm magic number. Each `.task` model must be a complete zip: the local-file header `PK\3\4` at the start **and** the end-of-central-directory record `PK\5\6` in the last 65,557 bytes, ending exactly at end of file, so a truncated model FAILs (`scripts/fetch-assets.mjs` applies the same rule before it saves a download). Every file in the repo's `resources/` must be present in `app.asar.unpacked`. Every `require()` in main/preload must be a built-in, `electron`, or a production dependency that is packed in `app.asar/node_modules`. `node_modules` must hold **exactly** the production dependency closure (resolved like Node does, nested `node_modules` first), at versions that satisfy each declared range; any other package FAILs. Native `.node` addons must be unpacked. |
| 3 | **No runtime downloads** (`no-downloads`) | It scans all packaged JS/HTML/CSS/JSON for URL hosts. Asset CDNs (jsdelivr, unpkg, `storage.googleapis.com`, Google Fonts, …) FAIL. The only hosts allowed are the user-configured AI provider endpoints (main process, used only after the user adds a key), MediaPipe's usage logger `odml.pa.googleapis.com`, and GitHub Releases for the updater (`github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`). URLs inside packed packages that contain no network API at all (license headers, doc comments) are inert, and so are the other update providers' endpoints in electron-updater's code (Bitbucket, GitLab, S3 …): `resources/app-update.yml` must say `provider: github`, `owner: CedrickGD`, `repo: SitSense` (no generic `url`, no custom host), otherwise FAIL; a `--dir` build has no `app-update.yml` and gets a WARN. The packaged renderer CSP must block every remote origin: it must have a `default-src`, and **every** source-list directive present must list only allow-listed local sources (`'self'`/keywords/hashes, `blob:`, `data:`, `mediastream:`, `filesystem:`, `app:`), so `http(s):`, `ws(s):`, `*` or a host in any directive FAILs, including `frame-src`/`child-src`/`object-src`/`manifest-src`. `script-src` (and `script-src-elem`) must not contain `'unsafe-inline'`. `ws:` and `'unsafe-inline'` are dev-server-only (see "Renderer CSP" above). |
| 3b | **Main/preload network APIs** (`main-network`) | A static scan of the packaged `out/main`, `out/preload` and `node_modules` code. It is needed because Chromium's network switches do not affect Node's own networking in main, and because a Chromium-side request main makes at boot (before the smoke test's counters exist, and outside the renderer's request recorder) would be blocked by the switches but never reported. No `http`/`https`/`http2`/`net`/`tls`/`dgram`/`undici`/`ws` module may be loaded, and there may be no `WebSocket`/`EventSource`/`XMLHttpRequest`. `electron.net.fetch` is allowed only with a `pathToFileURL(…)` argument (the `app://` handler), and no other `.fetch(`/`net.request(` call is allowed. `loadURL(…)` is allowed only when its argument is provably the `app://` renderer: an `app://` literal, `APP_ORIGIN` (itself an `app://` constant) or `` `${APP_ORIGIN}/…` ``, optionally behind `dev ??` where `dev` comes from `ELECTRON_RENDERER_URL` (set only by `electron-vite dev`). Any `downloadURL`/`resolveHost`/`preconnect`/`createInterruptedDownload` call FAILs. The global `fetch` may appear **only as the value of the `fetch:` property of the object passed to `createAiService(…)`**: a plain forwarding arrow `(url, init) => fetch(url, init)`, `fetch`, `globalThis.fetch`, or the shorthand `{ fetch }`. A `fetch` anywhere else, including elsewhere in `initAi` (for example a warm-up call), FAILs. **The updater** (`scripts/lib/update-scan.mjs`, unit-tested): `electron-updater` must be loaded exactly once into one binding, and that binding may appear **only** as the `updater:` value (`<binding>.autoUpdater` or `<cond> ? <binding>.autoUpdater : null`) of the object passed to `createUpdateService(…)`; any other use, a second load, a dynamic `import()`, Electron's own Squirrel `autoUpdater`, or a feed override (`setFeedURL`, `forceDevUpdateConfig`, `updateConfigPath`) FAILs. In `node_modules`, network APIs (`http(s)`/`net`/`tls`/… modules, `net.request`/`net.fetch`, `fetch(`, `WebSocket`/`XMLHttpRequest`/`EventSource`) may appear only in `electron-updater` and `builder-util-runtime`; anywhere else FAILs. |
| 4 | **Offline smoke test** (`smoke-offline`) | It launches `win-unpacked/SitSense.exe` via Playwright with a **temp `--user-data-dir`**, a fake camera (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`) and Chromium's network stack blocked (`--host-resolver-rules="MAP * ~NOTFOUND" --proxy-server=127.0.0.1:9 --proxy-bypass-list=<-loopback>`). The test proves the block works: main's `electron.net.fetch('https://example.com/')` must fail with a `net::ERR_*` error (it gives `ERR_PROXY_CONNECTION_FAILED`). The switches block the **Chromium stack only** (renderer and `electron.net`). Main's Node `fetch`/`http(s).request` are not blocked; they are **counted** by wrappers installed right after launch, alongside `electron.net.fetch/request` to non-`file:` URLs, and any call FAILs — except the updater's `electron.net.request` to a GitHub Releases host, which the switches block (it is reported, not failed). `smoke-offline` also presses **Check for updates** (`window.sitsense.updateCheck()`): the status must settle on the friendly offline error ("Couldn’t reach GitHub…") within 30 s, the app must still answer afterwards, and main must have shown **no** message/error box (`dialog.*` is wrapped for the whole run). Boot-time code that runs before the wrappers is covered by check 3b. On the renderer side, `_electron.launch()` returns only after the window has already loaded `index.html` and its entry chunk, so the recorders (requests, console/page errors, WebSockets) are attached first and then the page is **reloaded**: the whole page load, from the document request on, happens under observation, and the check FAILs if the reload's `index.html` and entry JS requests were not recorded. Non-`app://` requests and console lines from before the reload are kept and judged too; the `app://` status checks use only the observed load, since the reload aborts some of the first page's loads (a load with no response whose URL was also served with 200 is reported as that race, not as a FAIL). Every Playwright call is time-bounded, so a request that never completes cannot hang the run. From then on it records every request whose URL is not `app:`/`data:`/`blob:`/`devtools:`, plus every WebSocket. Each one FAILs whether it succeeded or not, unless the page's own CSP refused it before the network (`ERR_BLOCKED_BY_CSP`). In the last run, CSP-refused fetches such as the MediaPipe logger did not even surface as requests. It also asserts that the window is `app://renderer`, that `window.sitsense` exists, that wasm and model loads from `app://` return 200 (and the pose model was requested), that the fake camera delivers frames, and that `detection:status` reports `running:true` with no error. MediaPipe's "Graph successfully started running" log only ends the wait for startup and is reported as WARN if it never appears; it is not a pass condition. It saves a screenshot. |
| 5 | **No-GPU fallbacks** (`smoke-nogpu`, `smoke-cpu`, `smoke-nowebgl`) | `--disable-gpu`: WebGL runs on Windows' in-box WARP rasterizer and detection works. `--disable-gpu` with settings `delegate: CPU`: the XNNPACK/WASM CPU delegate runs inference. `--disable-gpu --disable-software-rasterizer` leaves no WebGL at all, which is a **known limitation** and is reported as WARN (see below). |
| 6 | **Distributables** (`distributables`) | Both exes are NSIS self-extractors whose manifest says `requestedExecutionLevel=asInvoker`. `electron-builder.yml` is oneClick + `perMachine: false`. `SitSense.exe` has PE subsystem version 10.0, so the Windows loader itself refuses anything older than Windows 10. `latest.yml` must exist, be for the `package.json` version, and name only files that exist in `dist/` with no spaces in their names (GitHub renames such assets, and the update download would 404); a missing `.blockmap` is a WARN. Both exes are picked by the `package.json` version from the `electron-builder.yml` `artifactName`s (`scripts/lib/distributables.mjs`): a missing exe for this version, or a `latest.yml` naming a different installer, FAILs; exes from other versions only WARN. The check prints the exact asset list the GitHub release needs (the portable exe only when it exists). |

Options: `--app <dir>` (default `dist/win-unpacked`), `--dist <dir>`,
`--shots <dir>` (screenshots; default `%TEMP%\sitsense-verify-shots`),
`--skip-smoke` (static checks only, no app launch), and `--json`.

**Safety of the smoke tests.** The app never touches the real profile. Every
run uses a fresh `--user-data-dir` in `%TEMP%`, and the script aborts if
`app.getPath('userData')` is not that dir. It deletes the dir afterwards. It
force-closes the instances it started. A different user-data dir also means a
different single-instance lock, so it can run beside an installed SitSense.
The app's boot-time autostart reconcile calls `setLoginItemSettings`, which
could touch the shared HKCU Run value. The script snapshots that value and
restores it.

Run it after every `npm run dist`, before handing out an exe.

## Updates

The app updates itself from **GitHub Releases** of `CedrickGD/SitSense`
(`src/main/updater.ts`, architecture.md §2 "App updates").

| Build | What happens |
|---|---|
| Installer (`SitSense-Setup-<v>.exe`) | Checks 30 s after start and every 6 h (Settings › About › "Check automatically", default on) or on "Check for updates". A newer version downloads in the background (differentially, via the `.blockmap`, when possible) and is verified against the sha512 in `latest.yml`. Then one toast "SitSense <v> is ready — restart to update" with a **Restart** button, "Restart to update" in the tray menu, "Update ready · Restart" in the sidebar. Restart runs the installer silently and starts the new version; otherwise it installs when SitSense quits. |
| Portable (`SitSense-portable-<v>.exe`) | Only checks. Settings › About shows "Version X is available"; **Download** opens the GitHub release page in the browser. The portable exe is never replaced or installed over. |
| Unpackaged (`npm run dev` / `npm start`) | No updater; nothing is requested. |

How it works: electron-builder writes the feed config into
`resources/app-update.yml` (`publish` in `electron-builder.yml`: provider
github, owner CedrickGD, repo SitSense). electron-updater reads
`https://github.com/CedrickGD/SitSense/releases.atom` and
`https://github.com/CedrickGD/SitSense/releases/latest` to find the newest
published release tag (`v<version>`; drafts and pre-releases are skipped),
downloads that release's `latest.yml`, compares versions (semver: only a newer
version counts), and for the installed build downloads
the installer named in `latest.yml` into
`%LOCALAPPDATA%\sitsense-updater\pending`. Builds never publish anything
(`--publish never` in `npm run dist`).

### Releasing an update

1. Bump `version` in `package.json`, then `npm run dist` and
   `npm run verify:package`. The `distributables` check prints the exact asset list.
2. Create the GitHub release with the tag **`v<version>`** (e.g. `v0.2.0`) as a
   normal, published release (not a draft or pre-release), and upload exactly
   these files from `dist/`, names unchanged:
   - `latest.yml`
   - `SitSense-Setup-<version>.exe`
   - `SitSense-Setup-<version>.exe.blockmap`
   - `SitSense-portable-<version>.exe`

   e.g. `gh release create v0.2.0 dist/latest.yml dist/SitSense-Setup-0.2.0.exe dist/SitSense-Setup-0.2.0.exe.blockmap dist/SitSense-portable-0.2.0.exe --title "SitSense 0.2.0" --notes-file NOTES.md`.
   The release notes appear (as plain text, shortened) in Settings › About.
3. Installed copies pick it up within 6 h (or on the next start). Never re-upload a
   different exe under an existing version: `latest.yml`'s sha512 would no longer
   match and every download would fail its integrity check.

## Minimum requirements (documentation, not dependencies)

- **Windows 10 or 11, x64.** Electron 43 is Chromium ≥ 110, which dropped
  Windows 7/8/8.1, and the exe's PE subsystem version is 10.0. Windows 11 on ARM
  runs the x64 build under emulation. There is no 32-bit build.
- **A webcam, and camera access for desktop apps.** This is on by default. If a
  user turned it off: Settings → Privacy & security → Camera → "Camera access"
  and "Let desktop apps access your camera". SitSense cannot change this. When
  it is off, the app shows a camera error.
- **Windows N / KN editions.** These lack Media Foundation unless the Media
  Feature Pack is installed. Chromium only delay-loads it (`mf.dll`,
  `mfplat.dll`, `mfreadwrite.dll`; check 1 FAILs a static import), so the app
  still starts, and Chromium falls back to DirectShow capture.
  - **Most USB webcams work through DirectShow.**
  - **Some built-in laptop cameras need the Media Feature Pack.** Cameras on
    Intel IPU6 / MIPI sensors, for example, are reachable only through Media
    Foundation. Without the pack the app may find no camera at all. The fix is
    to install the Media Feature Pack (Settings → Optional features).
  - The import scan does not cover this. Chromium also loads
    `MFCaptureEngine.dll` and `mfsensorgroup.dll` with `LoadLibrary` at run
    time, and no import scan can see such DLLs.
- **GPU.** Not required. A real GPU makes inference faster. Without one,
  Chromium runs WebGL on Windows' built-in WARP software rasterizer (or the
  bundled SwiftShader), and MediaPipe falls back to the CPU delegate if the GPU
  graph fails.
- **Toasts with the portable exe.** Reliable toasts need the Start-menu shortcut
  that carries the AUMID, and only the installer creates it. The portable exe
  works, but notifications may be missing or generic (architecture.md §7).
- **Disk.** About 330 MB installed. The portable exe unpacks about the same into
  `%TEMP%` on each launch, so the first window takes a few seconds longer.
- **Network.** Never required. Two optional things go online:
  - the cloud AI features (docs/specs/ai-providers.md), only after the user
    configures a provider;
  - the **update check** (main process, `electron-updater`): `github.com`
    (`/CedrickGD/SitSense/releases.atom`, `/releases/latest` and
    `/releases/download/v<v>/latest.yml`),
    and for an installed copy the installer download, which GitHub redirects to
    `objects.githubusercontent.com` / `release-assets.githubusercontent.com`.
    `api.github.com` is only used by electron-updater for private repos or GitHub
    Enterprise, not for this public repo. It runs 30 s after start and every 6 h
    while Settings › About › "Check automatically" is on (default), or when the user
    presses "Check for updates". It sends no posture data, settings or identifiers
    (only what any HTTPS request carries: IP address, user agent). Offline it fails
    quietly. Turning "Check automatically" off leaves no automatic request at all.

## Known limitations / open items

- **No WebGL at all → no detection.** MediaPipe tasks-vision uploads every
  frame through a WebGL context, even with the CPU delegate. If Chromium has
  neither a GPU nor a software rasterizer (`--disable-software-rasterizer`, or a
  policy that blocks it), inference throws `glActiveTexture of undefined`. The
  app then loops on "Detection stopped — restarting…". Stock Windows 10/11
  always provides WARP, so this is a corner case. Still, the renderer should
  detect "no WebGL at all" and show a clear, final error instead of retrying
  forever (`src/renderer/src/detection`).
- **Main's Node networking is counted, not blocked, at run time.** The
  wrappers are installed only after Playwright attaches. Code that runs earlier
  in boot is covered by the static `main-network` check instead. That check is
  pattern-based, so a new network path written in an unusual way (for example a
  computed property name) could slip past it. The only sanctioned paths are the
  fetch injected into the AI service and electron-updater's autoUpdater injected
  into the update service.
- **Requests from windows other than the first.** The reload re-observes the
  main window's page load. A second (for example hidden) window that main
  creates at boot is not reloaded; its navigation is covered statically by the
  `loadURL` rule in check 3b, and its later requests by the context-wide
  recorder.
- **Clean-machine proof.** All smoke runs so far were on a development machine,
  which may already have VC++ runtimes and the Media Feature Pack. A DLL loaded
  at run time from outside the app folder would not show up as missing there.
  The definitive check is to run `SitSense-portable-<v>.exe` once in Windows
  Sandbox (built into Windows 10/11 Pro).
- **Autostart reconcile (shared Run value).** The Run value name
  `com.cedrickgd.sitsense` is shared by every copy of the app. At boot a copy only
  re-points it when it is missing or dangling (its exe no longer exists); a value
  that points at another copy's existing exe is left alone (`registeredAutostartExe()`
  reads it with `reg query`). A copy takes the entry only when the user turns the
  setting on in that copy, and removes it only when the setting goes from on to off
  in that copy. A boot whose `settings.json` was unreadable or corrupt (defaults
  loaded, `trusted: false`) never removes the entry.
- `resources/elevate.exe` (x86) is an electron-builder default, unused by a
  per-user build, and harmless. (`app-update.yml` / `latest.yml` are now the
  update feed, see "Updates".)
- **0.1.0 has no updater.** Copies of 0.1.0 never check; their users install
  0.2.0 by hand once (the installer upgrades in place, settings and history stay).
  Every version from 0.2.0 on updates itself.
- **Unsigned builds.** Updates are verified by the sha512 in `latest.yml` (served
  by GitHub over HTTPS), not by a code signature — the exes are not signed. If a
  code-signing certificate is added later, set `win.signtoolOptions.publisherName`
  so electron-updater also checks the signature of each downloaded installer.
