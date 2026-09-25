# SitSense — UI/UX Specification

A Windows Electron desktop app (React + Tailwind, no component library) that watches your webcam locally and nudges you when you slouch. Everything below is implementable with Tailwind utilities + a few lines of custom CSS (conic gradients, keyframes) — no external UI packages.

---

## 1. Visual direction: "Calm Instrument"

**Concept.** SitSense sits in the corner of your day like a well-made measuring instrument — a tuner for your spine. The design language borrows from physiotherapy and biofeedback, not from fitness-gamification: warm charcoal surfaces (paper-dark, not gamer-black), one calm organic hue for "aligned", and a warmth ramp (sage → amber → ember → coral) that *is* the information architecture. The same four colors mean the same four things everywhere: dashboard, timeline, tray icon, toasts.

**Why not the obvious dark theme.** The default "near-black + one neon accent" reads surveillance/terminal — wrong for an app pointing a camera at your body all day. SitSense's dark is *warm* (umber undertone), its accent is a desaturated sage, and its text is warm off-white. It should feel like a quiet clinic instrument at dusk, trustworthy and bodily.

**Signature element — the Spine Glyph.** A vertical stack of 5 rounded capsule segments (rendered as SVG) that mirrors your live posture:

- **Good:** segments stacked straight and evenly spaced, sage, with a slow 6s "breathing" glow.
- **Sinking/Slouching:** segments compress vertically and the stack curves forward (C-curve).
- **Head-forward:** only the top 2 segments shear forward.
- **Side lean:** the whole stack tilts laterally toward the detected side.
- **Too close:** the stack scales up slightly and blurs at the edges (looming).
- Color of segments follows stage: sage → amber → ember → coral.

The glyph is the app's identity: large on the dashboard, small in the tray flyout, and its curvature+color *is* the tray icon (readable even for colorblind users, since shape encodes state independently of hue). Segment transforms animate with a 300ms ease-out.

### Palette

| Token | Hex | Use |
|---|---|---|
| `ink` | `#171512` | Window background (warm near-black) |
| `surface` | `#1E1B17` | Panels, nav rail, titlebar |
| `card` | `#252119` | Cards, inputs, menu |
| `hairline` | `#37322A` | 1px borders, dividers (or `white/8`) |
| `text` | `#EDE7DC` | Primary text (warm off-white) |
| `text-dim` | `#A39C8F` | Secondary text, labels |
| `text-faint` | `#6B655A` | Disabled, placeholders, timestamps |
| `sage` | `#93C9A2` | Good posture, brand accent, toggles-on, focus ring, primary buttons |
| `sage-deep` | `#3A5C45` | Sage fills at low emphasis (timeline good-blocks, glow) |
| `amber` | `#E5B96B` | Stage: slight |
| `ember` | `#E08A56` | Stage: clear |
| `coral` | `#E0655C` | Stage: severe, destructive actions |
| `slate-cool` | `#8FA3B8` | "Away" / paused / neutral-inactive states (the one cool note in a warm palette — reads as "asleep") |

Rule: sage is the only interactive accent. Amber/ember/coral appear **only** as posture-state information, never on buttons — so alerts never compete with UI chrome.

### Typography (all bundleable, OFL-licensed)

| Role | Face | Usage |
|---|---|---|
| Display | **Bricolage Grotesque** (SemiBold, `tracking-tight`) | Status word ("Good", "Slouching"), wizard headlines, empty-state headlines, big stat numbers. Used sparingly — it's the app's voice. |
| UI / body | **Hanken Grotesk** (Regular 400 / Medium 500) | Everything else. Warmer than Inter, renders well at 13–14px on Windows. Fallback stack: `"Hanken Grotesk", "Segoe UI Variable", "Segoe UI", sans-serif`. |
| Data | **IBM Plex Mono** (Regular, tabular) | Timers, countdowns, percentages, timeline tooltips, dwell/cooldown values. |

Scale: 12 / 13 (base UI) / 15 / 18 / 24 / 34 / 48px. Base UI text is 13px `text-dim`-labeled with 15px values — utility-app density, not web-page airiness.

### Shape, space, depth

- 8pt spacing grid. Cards `p-5`, page gutters `px-6`.
- Radius: controls `rounded-[10px]`, cards `rounded-2xl` (16px), camera preview `rounded-[20px]`, pills/chips `rounded-full`. Soft and bodily — no sharp corners anywhere.
- Depth via surface steps + 1px inner hairlines (`ring-1 ring-white/8`), not drop shadows. The only glow in the app is the Spine Glyph's breathing halo and the focus ring.
- Focus: `focus-visible:ring-2 ring-sage/70 ring-offset-2 ring-offset-ink` on every control.

### Motion (all wrapped in `motion-safe:`)

- **Status change:** Spine Glyph morphs 300ms ease-out; status word crossfades with a 200ms color sweep.
- **Good-posture idle:** 6s opacity breathing on the glyph glow (0.25 → 0.45).
- **Countdown:** conic-gradient ring sweep (CSS `@property` or SVG stroke-dashoffset).
- **Pause:** camera preview desaturates + a soft blur "eyelid" slides down 250ms — visibly *not watching*.
- **Timeline:** segments grow-in left-to-right once on mount (400ms, staggered 10ms).
- **Toast/flyout:** 200ms slide-up + fade. Nothing else moves. `prefers-reduced-motion`: all of the above become instant crossfades.

---

## 2. App shell & window model

- Frameless window (`frame: false`), custom titlebar. Default 980×660, min 780×580, resizable. Dashboard is the home screen.
- **Titlebar (36px, `surface`):** left — 16px spine mark + "SitSense" (Hanken Medium 13px); center — draggable region; right — minimize / close (close = hide to tray by default; a first-run coach-mark toast explains "SitSense keeps running in the tray").
- **Nav rail (56px, left, `surface`):** icon buttons top-aligned — Dashboard (grid of dots forming a seated figure), Calibrate (crosshair), Settings (sliders). Active state: sage icon + 3px sage left-edge bar. Bottom of rail: a small shield-camera icon; hover tooltip: *"All processing happens on this device. Nothing is uploaded — ever."* This privacy badge is permanent chrome, not a settings footnote.

```
┌──┬──────────────────────────────────────────────┐
│▪ │  ◦ SitSense                          — ✕     │  titlebar 36px
│──┼──────────────────────────────────────────────┤
│□ │                                              │
│○ │                 screen content               │
│⚙ │                                              │
│  │                                              │
│🛡 │                                              │
└──┴──────────────────────────────────────────────┘
```

---

## 3. Dashboard

```
┌────────────────────────────────┬───────────────────────┐
│  CAMERA PREVIEW  (16:9)        │   ┌─ Spine Glyph ─┐   │
│  ┌──────────────────────────┐  │   │   (SVG, 96px) │   │
│  │  live video, mirrored    │  │   └───────────────┘   │
│  │  + pose skeleton overlay │  │   Good                │
│  │  [● Monitoring] [on-dev] │  │   47 min aligned      │
│  └──────────────────────────┘  │   ───────────────     │
│                                │   Detected now        │
│                                │   ▸ (issue chips)     │
│                                │   ───────────────     │
│                                │   Monitoring   [ ⃝—]   │
│                                │   [ Pause ▾ ]         │
├────────────────────────────────┴───────────────────────┤
│  TODAY   ▉ 82% aligned   4h 06m good · 54m slouching   │
│  ▁▁▂▁▁████▁▁▂▂▁▁▁ ... posture timeline (9:00 → now)    │
└────────────────────────────────────────────────────────┘
```

**Camera preview (left, ~60% width).** Mirrored live feed in a `rounded-[20px]` frame with a 1px hairline. Overlays:
- Overlay, chosen in Settings → Camera overlay (`overlay.style`):
  - **Mesh** (default): a triangulated wireframe that fills the whole silhouette. The pose model's segmentation mask supplies the outline, and a jittered lattice rides on the shoulder line, so the mesh moves with the body instead of sliding over it. The face oval carries MediaPipe's canonical 468-point face mesh, with eyes and lips as bright contours. The silhouette outline is brighter than the interior; tracked joints get small target rings; a scanner band sweeps down the body every few seconds (off under `prefers-reduced-motion`). Drawn on a canvas at ≤30 fps, easing between detection frames so it stays fluid at 5 fps.
  - **Hologram**: the same mesh over a dimmed, desaturated feed with faint scanlines, so the wireframe glows.
  - **Skeleton**: the original minimal markers (head + shoulder line + neck). With a fixed hue, the head, neck or shoulder markers take the active issue's stage color.
  - **Off**: camera image only.
- Overlay color (`overlay.color`): **Posture** follows the stage colors (sage → amber → ember → coral). A fixed hue (ice, cyan, violet, magenta, lime, gold, white or a custom pick) stays constant, and the body region of each active issue glows in that issue's stage color (head for head-forward/too-close, neck for slouching, shoulders for leaning).
- Mesh work (segmentation output + face landmarker) runs only while a mesh preview is mounted **and** the window is visible. In the tray, the app runs pose detection only. If segmentation is unavailable, the mesh styles fall back to the skeleton.
- Top-left chip: `● Monitoring` (sage dot, pulses gently) / `⏸ Paused · 12:41 left` (slate-cool) / `● Off` (faint).
- While paused the camera is released, so the frame says `Camera is off while paused` (camera-slash icon) rather than showing a blank feed.
- The preview `<video>` is detached while the window is hidden, and the store isn't fed per frame then; detection itself keeps running.
- Top-right chip: `on-device` — tiny shield icon, `text-faint`, always present. Trust in the pixels.
- A faint vertical **plumb line** through the calibrated center — the alignment motif carried over from calibration. 1px, `white/10`.
- Preview can be collapsed via an eye-slash button (bottom-right of frame) → replaced by a static illustration of the spine glyph; monitoring continues. Label on hover: "Hide preview (monitoring continues)".

**Status column (right, ~40%).**
1. **Spine Glyph**, 96px tall, centered, with breathing glow.
2. **Status line** — Bricolage 34px: `Good`, or issue + stage: `Slouching` with a stage pill below it (`slight` amber / `clear` ember / `severe` coral, `rounded-full px-2 text-xs`). Sub-line in Plex Mono 13px `text-dim`: `47 min in good posture` (`Sitting well.` for the first minute — the clock only ticks every 15 s) or `for 2m 10s` (duration of current issue). Other states get their own word and sub-line: `Paused` + countdown, `Not calibrated`, `Camera unavailable`, `Can't start` (model failed), `Starting…`, `Away`.
3. **Detected now** — list of active issue rows (usually 0–2): stage-colored dot, issue name, live duration in Plex Mono. Empty state: `Nothing detected — sitting well.` in `text-faint`. Rows animate in/out with a 150ms fade.
4. **Controls card:** "Monitoring" label + toggle (sage when on). Below it a **Pause** split button: clicking the label pauses 15 min; the `▾` opens a menu — `15 minutes · 30 minutes · 60 minutes · Until I resume`. While paused the button becomes a sage **Resume** button with countdown: `Resume — 12:41`. The controls card sits directly under the status line, so it stays reachable at the minimum window size however many cards follow.
   - The menu renders in a portal with fixed positioning (a scrolling column can't clip it) and flips upward when there's no room below. Keyboard: Enter/↓ opens it with focus on the first item, arrows/Home/End move, Escape closes and returns focus to `▾`, Tab closes.
5. **Hint cards** (only while watching): `Different camera` when the active camera isn't the one the baseline was captured with, and `The view has changed` while the engine suggests recalibration. Both offer **Recalibrate**; neither is sticky — they disappear on their own once the condition clears.

**Today strip (bottom, full width, `card`).**
- Left: big stat — Bricolage 24px `82%` + label `aligned`; then Plex Mono pair `4h 06m good · 54m poor posture`. Before any tracked minute: `No tracked time yet`.
- Right (fills remaining width): **posture timeline** — a 24px-tall horizontal bar from first activity to now, built from per-minute segments colored `sage-deep` / `amber` / `ember` / `coral`, gaps (away/paused) in `ink` with a dotted top edge. Hover or focus (arrow keys move along the bar) any segment → Plex Mono tooltip: `14:20 – 14:26 · Head forward (clear)`, also announced via `aria-live`. The strip only polls today's stats while the window is visible. No axis clutter; just start-time and "now" labels at the ends in `text-faint` 12px.

---

## 4. Calibration wizard

Runs full-window (rail hidden, titlebar remains), first launch and via Calibrate icon. Three steps, progress shown as three small labeled dots top-center (`Position · Capture · Done`). `Esc` steps back: it stops a running capture, returns from Capture to Position, and leaves from Position. While paused, a notice with **Resume** replaces the checklist verdict — the wizard can't see anything until monitoring resumes, and `Continue`/`Capture` stay disabled while no frames arrive.

**Step 1 — Position check.** Split layout: live preview left (with plumb line + a faint dashed silhouette target of head-and-shoulders), checklist card right, updating live:

```
Camera check
✓ Face visible
✓ Shoulders visible
◐ Ears — partially visible      ← amber, with hint below
✓ Distance looks right
✓ Lighting is workable
────────────────────────────
Hint: Turn slightly toward the camera, or raise it
closer to eye level.
```

Each row: sage check / amber half-dot / coral cross + name. A verdict line beneath: `Placement: good` (sage) / `Placement: workable — tracking may be less precise` (amber) / `Placement: not usable yet` (coral, disables Continue). Camera picker dropdown sits above the checklist for quick device switching. Primary button: **Continue** (enabled at "workable" or better).

**Step 2 — Sit upright.** Preview centered and larger. Headline (Bricolage 24px): `Sit the way you'd like to sit all day.` Sub: `Upright but relaxed — shoulders level, screen at eye height. We'll use this as your baseline.` Primary button **Capture my baseline** starts a 3-2-1 countdown (Bricolage 48px numerals over the preview, conic sage ring), then a 5s hold with the ring filling and the copy `Hold it… capturing` in Plex Mono. If tracking quality drops mid-capture, the ring pauses amber with `Hold still — re-acquiring` and resumes. A `Cancel capture` button replaces the primary while counting down or capturing. On success: the skeleton overlay flashes sage and settles. Failures name the cause: not enough clear frames, not steady, head turned away (`face the camera while capturing`), or the camera stopped mid-capture — each with `Retry capture`.

**Step 3 — Done.** The Spine Glyph draws itself in segment-by-segment (staggered 60ms), sage, breathing. Headline: `Baseline captured.` Sub: `SitSense now measures every frame against this posture. Recalibrate any time you move your desk or camera.` Buttons: **Start monitoring** (primary) · `Redo capture` (ghost). Footnote in `text-faint`: `Your baseline is stored only on this device.`

---

## 5. Settings

A sticky section nav across the top (`Camera · Camera overlay · Detection · Notifications · General`, the section in view highlighted), sections as cards below. Every control commits immediately — no Save button; a transient inline `Saved` fade appears next to changed controls (`text-faint`, 1s). Every control has an accessible name; segmented controls are radio groups with arrow-key navigation.

**Camera.** Device dropdown with a 120px live thumbnail preview beside it, refreshing on change. The choice is stored with its label, so a camera whose id changed (new USB port, driver update) is found again; if the chosen camera is missing the row says which one is used meanwhile. Below: `Recalibrate baseline` (secondary button) with subtext `Recommended after moving your camera or desk.` and last-calibrated timestamp in Plex Mono — or, when the baseline came from another camera, a hint to recalibrate.

**Camera overlay.** A live preview of the feed, then `Style` (segmented: `Mesh · Hologram · Skeleton · Off`, with a one-line description of each) and `Color`: a conic "posture" swatch, seven preset swatches and a custom color picker. The subtext explains the choice: `Follows your posture…` or `Your color, always — the problem area still lights up in its warning color.`

**Detection.** One row-card per issue — `Slouching` · `Head forward` · `Leaning to one side` · `Too close to screen`. Each row: a 20px mini-glyph of that issue's spine deformation (instant recognition), issue name, an enable toggle, and a **sensitivity slider** (5 steps, endpoints labeled `Relaxed … Strict`, thumb in sage; disabled rows collapse the slider and dim to 40%). Sub-label under the slider explains the current step in plain words, e.g. `Strict — flags small departures from your baseline.` Bottom of section: `Performance` segmented control — `Efficient (5 fps) · Balanced (10 fps) · Responsive (15 fps)` with subtext `Higher settings react faster and use more CPU.`, followed by what's actually running (`Running on the GPU at 10 fps`).

**Notifications.** The 4×3 problem is solved with a *threshold* model, not 12 checkboxes:

- Per issue, one compact row: issue name + a 3-segment control labeled **Nudge me from:** `slight | clear | severe`. Selecting `clear` means clear and severe notify, slight is tracked silently (shown on dashboard/timeline only). Segments tint with their stage color when selected. This is the whole matrix for 95% of users — four rows, one decision each.
- A quiet disclosure beneath: `Fine-tune per stage ▾` → expands the full 4×3 checkbox grid (issues as rows, `slight / clear / severe` as columns, stage-colored checks) for non-contiguous setups. If a custom pattern is active, the row's segmented control shows `Custom` and tapping it offers `Reset to threshold`. With every stage unchecked the row reads `Never`, with the same reset.

Behavior card below:
- `Wait before nudging` — slider 5–30s, value in Plex Mono: `10 s of sustained poor posture`.
- `Quiet period between nudges` — slider 1–10 min: `3 min`.
- `Escalate if it gets worse` — toggle, subtext `A worsening stage notifies immediately, even during the quiet period.`
- `Sound` — toggle + a soft two-note chime preview button (`Play`).

**General.** Toggles: `Start with Windows` · `Start minimized to tray` · `Keep running when the window is closed` (on by default; off means closing the window quits). Footer row: version, `Reset all settings` (ghost, confirm dialog — keeps the baseline and camera choice, and doesn't replay onboarding), `Quit SitSense`.

---

## 6. Tray & notifications

**Icon.** 16px rounded-square badge containing a 3-segment mini-spine. Shape encodes state; color reinforces it:

| State | Glyph | Color |
|---|---|---|
| Good | straight spine | sage `#93C9A2` |
| Issue at slight/clear | gently curved spine | amber `#E5B96B` |
| Issue at severe | strongly curved spine | coral `#E0655C` |
| Paused | straight spine + two pause bars overlaid bottom-right | slate-cool `#8FA3B8` |
| Away / out of frame | hollow outline spine (no fill) | `text-faint` `#6B655A` |

**Click behavior.** Single left-click: opens a compact **status flyout** anchored above the tray (240×140 frameless always-on-top window): mini spine glyph, status word, today's `82% aligned`, and two buttons — `Pause 15 min` / `Open SitSense`. Double-click: opens/focuses the main window. Right-click: context menu:

```
Good posture · 47 min          (disabled info row, live)
─────────────────────────────
Open SitSense
Pause          ▸  15 minutes / 30 minutes / 60 minutes / Until I resume
Recalibrate
Settings
─────────────────────────────
Quit SitSense
```

While paused, `Pause ▸` is replaced by `Resume monitoring (12:41 left)`.

**Toast notifications.** Windows native toasts. Title = observation, body = one concrete fix. Tone: a friendly coach who noticed, never a scold — escalation adds urgency through specificity and duration, not blame. `{toSide}` interpolates `to the left` / `to the right` / `to one side`.

Each issue × stage has a pool of five phrasings (`src/main/notification-copy.ts`; the table below lists the first of each). They are drawn from a shuffle bag, so every phrasing appears once before any repeats, and a new round never starts with the one just shown. Escalations rotate their lead-in (`Still going —`, `It's crept further —`, …). Each toast's logo is the dashboard's spine glyph, bent the way the issue bends it and colored by stage (`resources/toast/<issue>-<stage>.png`, generated by `scripts/gen-icons.mjs`).

| Issue | Slight | Clear | Severe |
|---|---|---|---|
| **Slouching** | **Sinking a little** — A gentle lift through the chest fixes it. | **You've settled into a slouch** — Roll your shoulders back and sit tall. | **Deep slouch, {n} min now** — Worth a reset: sit back, feet flat, spine tall. |
| **Head forward** | **Head's creeping forward** — Tuck your chin back a touch. | **Head's well past your shoulders** — Bring your ears back over them. | **Neck's doing all the work** — Chin back and screen up — your neck will thank you. |
| **Side lean** | **Listing to the {side}** — Re-center over both sit bones. | **Propped up on one side** — Level your shoulders and square up to the screen. | **Strong lean, {n} min now** — Plant both feet and re-center — maybe stretch that side. |
| **Too close** | **Drifting toward the screen** — Ease back a few centimeters. | **Getting close to the screen** — Sit back — about an arm's length is right. | **Nose-to-screen territory** — Push back from the desk and reset your distance. |

- **Escalation variant** (worsening during quiet period) prefixes the body: `Still going —` e.g. *"Head's well past your shoulders — Still going — bring your ears back over them."* → implement as title from new stage + body `Still {stage-verb}. {fix}`.
- **Recovery toast** (optional, off by default, max 1/hour): **Nicely recovered** — *Back to your baseline. Carry on.*
- Every toast has one action button: `Pause 15 min`. Clicking the toast body opens the dashboard.
- Sound (if enabled): soft two-note marimba, low→high for slight/clear, a single lower tone for severe. Never plays twice within the quiet period.

---

## 7. Empty & error states

All use the same `EmptyState` pattern, centered in the preview area: a 64px line illustration in `text-faint` strokes with one sage or amber accent, Bricolage 24px headline, 13px body, one primary + optional ghost action. Errors state the fact and the fix — no apologies, no vagueness.

| State | Illustration | Headline | Body | Actions |
|---|---|---|---|---|
| No camera found | camera outline, empty lens | **No camera detected** | Connect a webcam, then scan again. SitSense needs one to see your posture. | `Scan for cameras` · `Open camera settings` |
| Camera in use | camera with a small lock badge | **Your camera is busy** | Another app is using {device name}. Close it, or pick a different camera. | `Try again` · `Choose another camera` |
| Permission denied | camera behind a barred shield | **Camera access is off** | Windows is blocking camera access for desktop apps. Allow it in Privacy settings, then come back. | `Open privacy settings` · `Check again` |
| Away / out of frame | empty chair, dotted silhouette | **Looks like you stepped away** | Monitoring resumes the moment you're back in frame. Time away isn't counted against your day. | *(none — auto-recovers; tray goes to Away state after 30s out of frame)* |
| Model failed to load | — | **Couldn't start posture detection** | The posture model failed to load on this machine. SitSense keeps retrying; reinstalling usually fixes a damaged install. | `Retry now` |
| Calibration lost (camera moved) | tilted plumb line | **The view has changed** | Your camera angle no longer matches your baseline, so nudges are on hold until you recalibrate. | `Recalibrate` (a dashboard card plus a one-time toast; clears itself once the view is back in range) |

The Windows settings buttons open fixed `ms-settings:` pages through an allowlist in main (`camera`, `camera-privacy`); the renderer can't open arbitrary URLs. In a narrow preview (minimum window size) the empty states shrink via a container query so their actions stay visible.

"Away" also renders on the timeline as neutral gaps, never as slouching.

---

## 8. Component inventory

| Component | Notes / key props |
|---|---|
| `AppShell` | titlebar + nav rail + outlet; drag regions (`-webkit-app-region`) |
| `TitleBar` | `onClose` hides to tray; window controls |
| `NavRail` | `items`, `active`; privacy badge slot |
| `CameraFeed` | `deviceId`, `mirrored`, `dimmed` (pause state); wraps `<video>` |
| `PoseOverlay` | `landmarks`, `color`; absolute SVG over feed (Skeleton style) |
| `MeshOverlay` | canvas over feed; reads `mesh` + overlay settings from the store each frame (Mesh/Hologram styles) |
| `PlumbLine` | calibrated center x; shared by dashboard + wizard |
| `SpineGlyph` | `size`, `issue`, `stage`, `animated`; the signature SVG, also renders mini variants for settings rows and tray flyout |
| `StatusCard` | status word, stage pill, duration readout |
| `IssueRow` / `IssueList` | live detected issues with durations |
| `StagePill` | `stage` → color + label |
| `MonitorToggle` | styled checkbox, sage track |
| `PauseButton` | split button + `Menu`; countdown mode |
| `Menu` / `MenuItem` | portal popover, used by pause + dropdowns |
| `TodayStats` | percent, good/slouch durations |
| `PostureTimeline` | `segments[{start,end,state}]`, hover `Tooltip` |
| `Tooltip` | Plex Mono, dark card |
| `WizardFrame` | step dots, back/cancel chrome |
| `QualityChecklist` | live rows: `ok / partial / fail` + hint |
| `CountdownRing` | conic/SVG ring, `duration`, `paused` |
| `SegmentedControl` | performance preset, notify-from threshold |
| `SensitivitySlider` | 5 detents, endpoint labels, description line |
| `Slider` | dwell/cooldown, formatted value |
| `Toggle` | all boolean settings |
| `MatrixGrid` | 4×3 fine-tune checkboxes, stage-colored |
| `SettingsSection` / `SettingRow` | card + label/control/subtext layout |
| `Select` | camera picker with thumbnail slot |
| `Button` | variants: `primary` (sage fill, ink text), `secondary` (card fill, hairline), `ghost`, `danger` (coral text) |
| `EmptyState` | `illustration`, `headline`, `body`, `actions` |
| `CoachMark` | one-time inline hint (close-to-tray) |
| Main-process: `TrayController` | icon state machine, flyout window, context menu |
| Main-process: `Notifier` | toast copy lookup, dwell/cooldown/escalation logic |

## 9. Key button & control microcopy

- Primary flows: `Capture my baseline` · `Start monitoring` · `Continue` · `Redo capture` · `Recalibrate` · `Resume — 12:41` · `Pause 15 min` · `Scan for cameras` · `Try again` · `Choose another camera` · `Open privacy settings` · `Check again`
- Settings: `Nudge me from:` · `Fine-tune per stage` · `Reset to threshold` · `Wait before nudging` · `Quiet period between nudges` · `Escalate if it gets worse` · `Start with Windows` · `Start minimized to tray` · `Keep running when the window is closed` · `Reset all settings`
- Status vocabulary (used identically everywhere): `Good` · `Slouching` · `Head forward` · `Leaning to one side` · `Too close to screen` · stages `slight / clear / severe` · `Paused` · `Away` · `aligned` (for time totals).

## 10. Tailwind implementation notes

- Define palette + fonts in `tailwind.config.js` `theme.extend` (`colors.ink/surface/card/sage/...`, `fontFamily.display/sans/mono`); stage→color maps live in one TS module (`stageColor(stage)`) so React, SVG overlay, timeline, and tray share it.
- Custom CSS is limited to: `@font-face` for the three bundled families, the breathing keyframe, the countdown conic ring, and `-webkit-app-region` rules.
- Quality floor: every interactive element keyboard-reachable with the sage focus ring; all motion behind `motion-safe:`; stage colors always paired with shape/text (pill labels, spine curvature) so color is never the sole channel.

### Critical Files for Implementation
- C:\Users\cedri\source\repos\sitsense\tailwind.config.js
- C:\Users\cedri\source\repos\sitsense\src\renderer\components\SpineGlyph.tsx
- C:\Users\cedri\source\repos\sitsense\src\renderer\screens\Dashboard.tsx
- C:\Users\cedri\source\repos\sitsense\src\shared\copy\notifications.ts
- C:\Users\cedri\source\repos\sitsense\src\main\tray.ts