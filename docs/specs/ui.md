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
  - **Lines** (`skeleton`, the **default** since v2): what the AI measures, from any angle. The near-side ear → shoulder → hip chain (whichever side faces the camera) is drawn as a thick, rounded polyline with joint dots, alongside a dashed **true-vertical** line through the shoulder. That line is the gravity direction projected into the image, so "ears over this line" is visible at a glance. The shoulder line and head line are drawn thin when visible. With a fixed hue, the segment an active issue lives on takes that issue's stage color.
  - **Off**: camera image only.
- Overlay color (`overlay.color`): **Posture** follows the stage colors (sage → amber → ember → coral). A fixed hue (ice, cyan, violet, magenta, lime, gold, white or a custom pick) stays constant, and the body region of each active issue glows in that issue's stage color (head for head-forward/too-close, neck for slouching, shoulders for leaning).
- Mesh work (segmentation output + face landmarker) runs only while a mesh preview is mounted **and** the window is visible. In the tray, the app runs pose detection only. If segmentation is unavailable, the mesh styles fall back to the skeleton.
- Top-left chip: `● Monitoring` (sage dot, pulses gently) / `⏸ Paused · 12:41 left` (slate-cool) / `● Off` (faint).
- Top-right chip: `on-device` — tiny shield icon, `text-faint`, always present. Trust in the pixels. While a cloud AI model is enabled it reads `on-device · AI: <label>`, and its tooltip says exactly when data leaves the device and what (a pose sketch or a snapshot).
- (v1's centered plumb line is removed. The user can sit anywhere in frame; the Lines overlay's true-vertical line replaces it.)
- Preview can be collapsed via an eye-slash button (bottom-right of frame) → replaced by a static illustration of the spine glyph; monitoring continues. Label on hover: "Hide preview (monitoring continues)".

**Status column (right, ~40%).**
1. **Spine Glyph**, 96px tall, centered, with breathing glow.
2. **Status line** — Bricolage 34px: `Good`, or issue + stage: `Slouching` with a stage pill below it (`slight` amber / `clear` ember / `severe` coral, `rounded-full px-2 text-xs`). Sub-line in Plex Mono 13px `text-dim`: `47 min in good posture` or `for 2m 10s` (duration of current issue).
3. **Detected now** — list of active issue rows (usually 0–2): stage-colored dot, issue name, live duration in Plex Mono. Empty state: `Nothing detected — sitting well.` in `text-faint`. Rows animate in/out with a 150ms fade.
4. **What SitSense sees** (calibrated only): a compact readout from `snapshot.readout`, showing the view chip and up to three live values versus the baseline in Plex Mono, e.g. `Neck +4°`, `Trunk +2°`, `Closer 3 cm`. Values color by stage.
5. **Ask AI** (only when a connected model is enabled): a secondary button. While pending, *Asking Gemini…*. The result card shows the score as `82/100`, the one-sentence summary, up to three tips, and the model name, with a dismiss ×. Errors are short, e.g. *Couldn't reach Gemini: bad key — check Settings → AI models.*
6. **Controls card:** "Monitoring" label + toggle (sage when on). Below it a **Pause** split button: clicking the label pauses 15 min; the `▾` opens a menu — `15 minutes · 30 minutes · 60 minutes · Until I resume`. While paused the button becomes a sage **Resume** button with countdown: `Resume — 12:41`.

**Today strip (bottom, full width, `card`).**
- Left: big stat — Bricolage 24px `82%` + label `aligned today`; then Plex Mono pair `4h 06m good · 54m slouching`.
- Right (fills remaining width): **posture timeline** — a 24px-tall horizontal bar from first activity to now, built from per-minute segments colored `sage-deep` / `amber` / `ember` / `coral`, gaps (away/paused) in `ink` with a dotted top edge. Hover any segment → Plex Mono tooltip: `14:20 – 14:26 · Head forward (clear)`. No axis clutter; just start-time and "now" labels at the ends in `text-faint` 12px.

---

## 4. Posture setup (AI-coached calibration)

v1 asked the user to "sit the way you'd like to sit all day", demanded a centered, frontal
camera with both shoulders and ears visible, and captured on a button press. v2 inverts
that. **SitSense judges the posture itself, coaches the user into a good one, and saves the
baseline automatically.** It works from any camera angle.

Runs full-window. The rail stays, so the user can leave at any time; leaving cancels setup
with nothing saved. The first launch, the Calibrate nav item and the tray's Recalibrate open
it. Layout: the live preview on the left (Lines overlay, §3), a coach card on the right.

**Coach card**, top to bottom:

1. **View chip**: `Front view` / `Angled view` / `Side view · works great`, from
   `features.view.kind`. Every view gets the same reassuring tone; none is "wrong".
2. **Primary instruction** in Bricolage 22px: the assessment's `primary` instruction, e.g.
   *Bring your head back until your ears sit over your shoulders.* When everything is good:
   *That's it — hold still.* While searching: *Sit where you normally work. Your head and one
   shoulder need to be in the picture.*
3. **Checklist**: one row per check from `assessPosture`. Each row has a sage ✓ (good), an
   amber ◐ with a short hint (adjust), or a faint "—" with *can't see from this angle*
   (unknown, never blocking). Rows animate status changes over 150 ms.
4. **Progress**:
   * **holding**: a sage ring fills over 1.5 s, labeled `Hold it…`.
   * **capturing**: a ring over 3 s, labeled `Capturing your baseline…`.
   * **reviewing** (a cloud AI is connected and `useInSetup` is on): an indeterminate shimmer
     with `Asking <connection label> to double-check…`.
   * If the posture breaks, the ring drains amber and coaching resumes. There is no countdown
     and no button.
5. After 20 s of coaching, a ghost button appears: **Save this posture anyway**, with the sub
   *SitSense couldn't confirm it — you can redo setup any time.*

**Failure states** use the same card: `unstable` (*Hold still for a moment*), `lost` (*Lost
sight of you — sit back in view*), and a cloud reviewer's rejection (its instruction is shown
as the primary, labeled with the model name). They return to coaching automatically. The user
never presses Retry.

**Done.** The Spine Glyph draws in, sage. Headline: **This is your good posture.** Sub: a
readout of what was measured, e.g. *Neck 9° · Trunk upright · Shoulders level — seen from
the side*. When a cloud model reviewed it, its one-sentence summary follows in quotes with
the model's name. Buttons: **Start monitoring** (primary) and `Redo setup` (ghost).
Footnote: *Only these numbers are stored, on this device.*

## 5. Settings

Two-pane: sticky section list left (160px: Camera · Detection · Notifications · General), scrollable content right, sections as cards. Every control commits immediately — no Save button; a transient inline `Saved` fade appears next to changed controls (`text-faint`, 1s).

**Camera.** Device dropdown with a 120px live thumbnail preview beside it, refreshing on change. Below: `Recalibrate baseline` (secondary button) with subtext `Recommended after moving your camera or desk.` and last-calibrated timestamp in Plex Mono.

**Camera overlay.** A live preview of the feed, then `Style` (segmented: `Mesh · Hologram · Skeleton · Off`, with a one-line description of each) and `Color`: a conic "posture" swatch, seven preset swatches and a custom color picker. The subtext explains the choice: `Follows your posture…` or `Your color, always — the problem area still lights up in its warning color.`

**Detection.** One row-card per issue — `Slouching` · `Head forward` · `Leaning to one side` · `Too close to screen`. Each row: a 20px mini-glyph of that issue's spine deformation (instant recognition), issue name, an enable toggle, and a **sensitivity slider** (5 steps, endpoints labeled `Relaxed … Strict`, thumb in sage; disabled rows collapse the slider and dim to 40%). Sub-label under the slider explains the current step in plain words, e.g. `Strict — flags small departures from your baseline.` Bottom of section: `Performance` segmented control — `Efficient (5 fps) · Balanced (10 fps) · Responsive (15 fps)` with subtext `Higher settings react faster and use more CPU.`

**Notifications.** The 4×3 problem is solved with a *threshold* model, not 12 checkboxes:

- Per issue, one compact row: issue name + a 3-segment control labeled **Nudge me from:** `slight | clear | severe`. Selecting `clear` means clear and severe notify, slight is tracked silently (shown on dashboard/timeline only). Segments tint with their stage color when selected. This is the whole matrix for 95% of users — four rows, one decision each.
- A quiet disclosure beneath: `Fine-tune per stage ▾` → expands the full 4×3 checkbox grid (issues as rows, `slight / clear / severe` as columns, stage-colored checks) for non-contiguous setups. If a custom pattern is active, the row's segmented control shows `Custom` and tapping it offers `Reset to threshold`.

Behavior card below:
- `Wait before nudging` — slider 5–30s, value in Plex Mono: `10 s of sustained poor posture`.
- `Quiet period between nudges` — slider 1–10 min: `3 min`.
- `Escalate if it gets worse` — toggle, subtext `If it gets worse and stays worse for a few seconds, you get a new nudge — even during the quiet period (at most every 30 s).`
- `Sound` — toggle + a soft two-note chime preview button (`Play`).

**AI models.** Connect your own AI model (spec: `docs/specs/ai-providers.md` §6). It has the master toggle, the *What's sent* choice with its disclosure, *Use during setup*, and the connections list: status dot, label, model, enabled toggle, ↑/↓ priority, Test, Edit, Remove, and a `Primary` badge. The **Add connection** form is driven by presets: provider, label, masked API key (*Saved key …x2Ig*, Replace/Remove; never displayed), base URL (always for Custom/Ollama/LM Studio, under *Advanced* otherwise), and model with *Load models*. Test results show inline next to the row.

**General.** Toggles: `Start with Windows` · `Start minimized to tray` · `Keep running when the window is closed` (on by default). Footer row: version, `Reset all settings` (ghost, coral text, confirm dialog).

**Deliberate deviations (v2 build).** Settings is one centered column of section cards (`max-w-2xl`) rather than the two-pane layout with a sticky section list. The `Saved` fade is implemented (visual only, it shows for 1 s without motion). Closing the window always keeps SitSense running in the tray, and `Quit SitSense` sits in the footer, so there is no `Keep running when the window is closed` toggle and no `Reset all settings`. The `Sound` toggle uses the Windows notification sound rather than a custom chime; `Send test` plays it, so there is no separate `Play` preview.

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
| No camera found | camera outline, empty lens | **No camera detected** | Connect a webcam, then scan again. SitSense needs one to see your posture. | `Scan for cameras` · `Open Windows camera settings` |
| Camera in use | camera with a small lock badge | **Your camera is busy** | Another app is using {device name}. Close it, or pick a different camera. | `Try again` · `Choose another camera` |
| Permission denied | camera behind a barred shield | **Camera access is off** | Windows is blocking camera access for desktop apps. Allow it in Privacy settings, then come back. | `Open privacy settings` · `Check again` |
| Away / out of frame | empty chair, dotted silhouette | **Looks like you stepped away** | Monitoring resumes the moment you're back in frame. Time away isn't counted against your day. | *(none — auto-recovers; tray goes to Away state after 30s out of frame)* |
| Calibration lost (camera moved) | tilted plumb line | **The view has changed** | Your camera angle no longer matches your baseline, so readings may be off. | `Recalibrate` · `Ignore for today` |

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