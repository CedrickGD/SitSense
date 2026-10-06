# SitSense — UI v3 specification

Status: **authoritative** for the v3 UI. `ui.md` stays as history (v1/v2). Where the two
disagree, this file wins. `ai-providers.md` still owns provider plumbing; `detection.md` owns
the posture maths. §11 lists the few things this UI needs from them.

Why v3 exists, in the user's words (translated): the rail's first two icons "feel 1:1 the
same"; Settings "looks like a simple scroll list — you have space, use it"; the mesh "covers
the body so you can't see anything except the net"; setup says "fine" while the user is
"practically lying in the chair"; the AI should be "a small chat window, not just *Ask AI*";
overall it "looks like a 15-year-old made it".

v3 answers each point:

| Complaint | v3 answer |
|---|---|
| Two nav items look identical | Labeled sidebar with four places that each have one job: **Live**, **Coach**, **History**, **Settings**. Posture setup is no longer a place; it is a focused full-window flow with its own look (§7). |
| Settings is a scroll list | Two-pane settings: category list on the left, one category on the right, laid out as a grid of cards with live previews (§6). |
| Mesh hides the body | Mesh becomes a light wireframe over a clearly visible person, with an intensity slider. The camera image always reads first (§3.3). |
| Setup accepts a slump | Setup never passes something it cannot check. Unverifiable essentials block auto-save, and the copy is strict (§7, §11). |
| AI is one button | **Coach**: a chat with context chips, suggested prompts, and a "Check my posture now" action. A compact Coach card sits on Live (§4, §3.6). |
| Looks amateur | A defined spacing, type, elevation, state and icon system (§8), and wireframes for every screen (§3–§7). |

Hard requirements carried over unchanged:

* Detection works from **any camera angle**, with the user about half visible. Never tune the UI or the copy to one setup. Every view (front, angled, side) gets the same reassuring tone.
* **The AI judges good posture.** The user never defines it. Setup coaches the user into a good posture and saves it automatically. The UI never says "sit how you like".
* **Privacy.** Everything runs on the device by default. A cloud AI is opt-in and uses the user's own key. With AI off, the app makes zero network requests.

---

## 1. Design language: "Calm Instrument", grown up

The brand stays the same: warm charcoal, a sage accent, the stage ramp amber → ember → coral,
Bricolage Grotesque for display, Hanken Grotesk for UI and IBM Plex Mono for data. The Spine
Glyph remains the signature element. v3 adds the craft the brand was missing: real hierarchy,
consistent rhythm, depth, and states.

### 1.1 Tokens (`assets/main.css` `@theme`)

The existing tokens stay. Add:

| Token | Value | Use |
|---|---|---|
| `--color-card-2` | `#2C2720` | Raised surfaces: hover rows, inputs, popovers, the selected settings category, chat bubbles (user) |
| `--color-hairline-strong` | `#4A4339` | Borders that must be visible (inputs on hover, dashed "unavailable" tracks) |
| `--color-sage-soft` | `rgb(147 201 162 / 0.12)` | Selected/active backgrounds (nav item, segmented selection, chips) |
| `--color-scrim` | `rgb(23 21 18 / 0.72)` | Glass chips over the camera (+ `backdrop-blur-md`) |
| `--color-setup-bg` | `#14130F` | Setup flow background (with the sage glow, §7) |

Rules (unchanged): **sage is the only interactive accent.** Amber, ember and coral only carry
posture state, never chrome. The one exception is the destructive button text (coral), as
before. `slate-cool` means paused or away.

### 1.2 Spacing scale

Use a 4 px base. Only these values: **4, 8, 12, 16, 20, 24, 32, 40, 48, 64**. In Tailwind
these are `1 2 3 4 5 6 8 10 12 16`.

| Where | Value |
|---|---|
| Page padding (content area) | 24 (`p-6`); 16 at compact width (<1000 px) |
| Gap between cards | 16 (`gap-4`) |
| Card padding | 20 (`p-5`); 16 for dense cards (gauges, KPI tiles) |
| Card header → body | 12 |
| Rows inside a card | 12 between rows; 16 between groups, separated by a hairline |
| Label → control | 6 |
| Icon → text | 8 (inline), 12 (nav items) |

### 1.3 Type scale

The fonts are already bundled. Never use any size outside this table.

| Token | Size / line | Face, weight | Use |
|---|---|---|---|
| `micro` | 11 / 14, `uppercase tracking-[0.08em]` | Hanken 600 | Card eyebrow labels ("TODAY", "POSTURE"), table heads |
| `caption` | 12 / 16 | Hanken 400 | Secondary lines, hints, timestamps (`text-dim` / `text-faint`) |
| `body` | 13 / 18 | Hanken 400/500 | Default UI text |
| `body-lg` | 14 / 21 | Hanken 400 | Chat messages, setup checklist, settings descriptions |
| `value` | 13 or 15 / 20 | Plex Mono 400, `tabular-nums` | Every number with a unit, timers, percentages |
| `title` | 15 / 20 | Hanken 600 | Card titles, nav labels (14 / 500 for nav) |
| `h3` | 18 / 24 | Bricolage 600, `tracking-tight` | Settings category title, empty-state headline (small) |
| `h2` | 26 / 32 | Bricolage 600, `tracking-tight` | Status word on Live, page heroes, KPI numbers |
| `h1` | 32 / 38 | Bricolage 600, `tracking-tight` | Setup's main instruction |
| `score` | 44 / 44 | Bricolage 700, `tabular-nums` | The score ring number |

Text colors: primary `text`; secondary `text-dim`; tertiary and disabled `text-faint`. Never
place `text-faint` on `card-2` for anything the user must read (contrast is too low). Use
`text-dim` there.

### 1.4 Shape and elevation

| Level | Recipe | Used for |
|---|---|---|
| e0 page | `bg-ink` | content background |
| e1 card | `bg-card rounded-2xl ring-1 ring-white/[0.06] shadow-[inset_0_1px_0_rgb(255_255_255/0.035)]` | every card |
| e2 raised | `bg-card-2 rounded-xl ring-1 ring-white/10 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.6)]` | selected category, hover lift, chat composer, toast mock |
| e3 popover | `bg-card-2 rounded-xl ring-1 ring-white/12 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.7)]` | menus, tooltips, dropdowns |
| hero | `rounded-[20px] ring-1 ring-white/[0.06] overflow-hidden bg-black` | camera preview |

Radius: controls 10 px, cards 16 px, camera 20 px, chips and pills fully round.

**Card anatomy** (every card, no exceptions): a header row (an optional 16 px icon in
`text-faint`, a `micro` eyebrow or a `title`, and an optional right-aligned action as a ghost
`sm` button or a link), then the body. A card never holds a single orphan line of faint text.
If there is nothing to show, it shows a proper empty state (§8.6).

### 1.5 Controls (heights are fixed)

| Control | Height | Notes |
|---|---|---|
| Button `sm` / `md` / `lg` | 28 / 32 / 40 | `lg` only in setup and empty states. Variants: `primary` (sage fill, ink text), `secondary` (card-2 fill, hairline ring), `ghost` (no fill, `text-dim` → `text` on hover), `danger` (ghost with coral text) |
| Icon button | 32×32 (28×28 on the camera) | always with `aria-label` and a tooltip |
| Input / select | 32 (36 in the chat composer, which grows to 5 lines) | `bg-card-2`, ring white/8 → `hairline-strong` on hover → sage focus ring |
| Segmented control | 32 (28 on the camera) | selected segment: `bg-sage-soft text-sage` |
| Toggle | 20×36 | unchanged |
| Slider | 20 hit area, 4 px track | sage fill to the thumb; notches for stepped sliders |

---

## 2. Information architecture and app shell

### 2.1 Places

| Place | Route | One job | Icon (§8.7) |
|---|---|---|---|
| **Live** | `live` | "How am I sitting right now?": the camera, the score, the gauges, today at a glance | `live` |
| **Coach** | `coach` | "Ask about my posture": an AI chat that can see the live numbers | `coach` |
| **History** | `history` | "How did I do?": days and weeks | `history` |
| **Settings** | `settings` | "Change how SitSense works", by category | `settings` |
| *Posture setup* (flow, not a place) | overlay state | "Teach SitSense my good posture" | `setup` |

`AppRoute` becomes `'live' | 'coach' | 'history' | 'settings'`. For compatibility, an
incoming `'dashboard'` maps to `'live'`, and `'calibrate'` opens the setup flow. The store gains:

```ts
setupFlow: { open: boolean; returnTo: AppRoute; step: 1 | 2 | 3 } // step is UI-only
settingsCategory: SettingsCategoryId   // 'general' | 'camera' | 'detection' | 'notifications' | 'ai' | 'privacy' | 'about'
openSetup(returnTo?: AppRoute): void   // starts detectionController.startSetup()
closeSetup(): void                     // cancels a running session, returns to returnTo
openSettings(category: SettingsCategoryId): void
```

Entry points into setup: the first run (no baseline), the Live "Redo posture setup" action
and its not-set-up state, Settings › Posture detection and Settings › General, and the tray
item **Redo posture setup** (renamed from *Recalibrate*). The main → renderer
`requestCalibration` message calls `openSetup()`.

### 2.2 Window

* Default **1200×800**. Minimum **780×580** (unchanged). Frameless (unchanged).
* Breakpoints use the **window width**:
  * **wide**: ≥ 1280
  * **standard**: 1000–1279
  * **compact**: < 1000. The sidebar collapses to a 64 px icon rail with tooltips.

### 2.3 Shell layout

The sidebar runs the full window height. The top bar only spans the content column.

```
1200 × 800
┌─────────────────────────┬───────────────────────────────────────────────────────────────────────┐
│ [spine] SitSense        │ Live                                                     —    ✕       │ 44 top bar (drag)
│                         ├───────────────────────────────────────────────────────────────────────┤
│  ▌[live]    Live        │                                                                       │
│   [coach]   Coach   AI  │                                                                       │
│   [history] History     │                         screen content                                │
│   [gear]    Settings    │                     (scrolls; padding 24)                             │
│                         │                                                                       │
│                         │                                                                       │
│                         │                                                                       │
│                         │                                                                       │
│ ┌─────────────────────┐ │                                                                       │
│ │ ● Monitoring    [⏸] │ │                                                                       │
│ └─────────────────────┘ │                                                                       │
│  [shield] On-device     │                                                                       │
└─────────────────────────┴───────────────────────────────────────────────────────────────────────┘
   220 px sidebar (surface)                     content (ink)
```

**Sidebar (220 px, `bg-surface`, right hairline `border-r border-white/[0.05]`)**

* **Brand row** (52 px, draggable): the 18 px Spine Glyph in live state colors, then "SitSense" in Bricolage 600 16 px. The window title moves here. There is no separate full-width titlebar any more.
* **Nav items** (40 px tall, 8 px side inset, radius 10, 12 px icon gap, label `title` 14/500):
  * rest: icon `text-faint`, label `text-dim`
  * hover: `bg-white/[0.04]`, label `text`
  * active: `bg-sage-soft`, icon and label `text-sage`, plus a 3 px sage bar on the left edge (inset 10 px top and bottom)
  * focus: the standard ring
  * Keyboard: `Ctrl+1…4` jump to the places. Arrow keys move within the list (roving tabindex).
* **Nav badges** (right-aligned, `micro`, round, 18 px):
  * Coach: `AI` in `text-faint` on `white/5` when no model is usable. A sage dot while a reply is in progress and the user is on another screen.
  * Live: an 8 px stage-colored dot while an issue at stage ≥ 2 is active and the user is on another screen.
* **Footer** (pinned to the bottom, 12 px padding):
  1. **Monitoring pill** (e1 card, 44 px, full width): a status dot plus a label, and a 28 px icon button on the right.
     * Monitoring: sage dot with a 2 s soft pulse, "Monitoring", button `pause` (opens the pause menu: *15 minutes · 30 minutes · 60 minutes · Until I resume*).
     * Paused: slate dot, "Paused · 12:41" (Plex Mono countdown) or "Paused" (until resumed), button `play` "Resume".
     * Camera problem (or the pose model failed to load): coral dot, "Camera unavailable", button `chevron-right` → Live.
     * Not set up: amber dot, "Not set up", button `chevron-right` → `openSetup()`.
     * Set up for another camera (the baseline is not applied, nothing is judged): amber dot, "Nudges off · new camera", button `chevron-right` → Live (its banner offers redo / keep).
     * Priority: paused > camera > not set up > new camera > monitoring.
  2. **Privacy badge** (32 px row, `caption text-dim`): `shield` icon + "On-device". With a cloud AI enabled it reads "On-device · AI: Gemini" (the connection label, truncated to 14 chars). The tooltip text comes from the existing `aiDisclosure()` / `ON_DEVICE_TIP`. Clicking it opens Settings › Privacy & data.

**Compact rail (64 px).** The brand shows only the glyph. Nav items become 44×44 icons with
the same active treatment; the label moves into a right-side tooltip (e3, 120 ms delay).
Badges become 6 px dots at the icon's top-right. The monitoring pill becomes a 40×40 icon
button: the dot is drawn over the `pause`/`play` icon, and the tooltip carries the full label.
The privacy badge is icon-only.

**Top bar (44 px, content column, `bg-ink`, draggable).** On the left, the page title (`title`
15/600) plus an optional sub (`caption text-faint`, e.g. History's date). On the right,
page actions (no-drag), then the minimize and close-to-tray buttons (44×44, as today). Close
keeps its tooltip "Closes to the tray — monitoring continues".

**Content.** `overflow-y-auto`, padding 24 (16 compact), a max content width of **1280**,
left-aligned. On very wide windows the extra space stays at the right; screens are never
centered narrow columns. Screen transition: 180 ms fade plus a 4 px rise
(`motion-safe`), and none under reduced motion.

---

## 3. Live

Purpose: the instant read. The camera is the hero, and the score explains it.

### 3.1 Layout at 1200×800 (content 980×756, inner 932 wide)

A 12-column grid with a 16 px gap.

```
┌ Live ───────────────────────────────────────────────── [Redo posture setup]  — ✕ ┐
│                                                                                   │
│ ┌──────────────────────────────────────────────────┐ ┌──────────────────────────┐ │
│ │● Monitoring  · Seeing head, shoulders & hips   [on-device]│ POSTURE             │ │
│ │                                                  │ │      ╭──────╮            │ │
│ │                                                  │ │     │  86  │  Good      │ │
│ │              camera (16:9, cover)                │ │      ╰──────╯  aligned   │ │
│ │              + overlay (Lines/Mesh)              │ │               47 min    │ │
│ │                                                  │ │ ────────────────────────│ │
│ │                                                  │ │ Head position   +4° fwd │ │
│ │                                                  │ │ ▕──●──┊────┊─────┊────▏ │ │
│ │                                                  │ │ Back angle        level │ │
│ │                                                  │ │ ▕───●─┊────┊─────┊────▏ │ │
│ │ [Lines|Mesh|Off]                       [eye-off] │ │ Side lean      1° left  │ │
│ └──────────────────────────────────────────────────┘ │ Screen distance  same   │ │
│   cols 1–8 (≈ 612×344)                               └──────────────────────────┘ │
│                                                        cols 9–12 (≈ 304)          │
│ ┌ TODAY ─────────────────────── [History →]┐┌ SITTING ────────┐┌ COACH ──[Open →]┐│
│ │ 82%  aligned    4h 06m good · 54m off    ││ 38 min          ││ "Your neck sits ││
│ │ ▁▁▂████▁▂▂▁▁████▁▁▂ (timeline)           ││ ▓▓▓▓▓▓▓░░░ 50   ││  4° ahead…"     ││
│ │ 9:02                              now    ││ Next break in   ││ [Ask your coach…│]│
│ │ Best stretch 47 min · 3 nudges           ││ 12 min · 2 taken││ Check my posture││
│ └──────────────────────────────────────────┘└─────────────────┘└─────────────────┘│
│   cols 1–6                                    cols 7–9           cols 10–12        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

* **Row 1**: camera (cols 1–8) and Posture card (cols 9–12), equal height. The camera is 16:9 and sets the row height; the Posture card stretches to match.
* **Row 2**: Today (1–6), Sitting (7–9), Coach (10–12), equal heights (min 176).
* At 1200×800 everything fits without scrolling (24 + 344 + 16 + 176 + 24 ≈ 584 of 756).
* **wide (≥ 1280)**: the same grid, the camera grows, and row 2 keeps its proportions.
* **compact (< 1000, content ≈ 668 inner at 780)**: row 1 stays two columns, with the camera at cols 1–7 and Posture at cols 8–12. The ring shrinks to 88 px and the gauges show their label and value without the track. Row 2 becomes Today (1–12), then Sitting (1–6) and Coach (7–12). The page scrolls vertically, and nothing scrolls horizontally.
* **Short windows (height < 700)**: the gauges collapse to two lines (label · value) and the timeline height drops to 16.

**Top bar actions:** `Redo posture setup` (ghost `sm`, `setup` icon). When no baseline exists,
this becomes a primary `Set up posture`.

### 3.2 Camera hero

`rounded-[20px]`. A mirrored video with `object-cover`. Glass chips use `bg-scrim
backdrop-blur-md ring-1 ring-white/10`, `caption` text, height 26, 10 px from the edges.

| Position | Content |
|---|---|
| Top-left | **Status chip**: `● Monitoring` / `Paused · 12:41` (slate) / `● Off`. Then a hairline divider and the **tracking chip** text (§3.2.1). |
| Top-right | **Privacy chip**: as today (`on-device` / `on-device · AI: <label>`) with its existing tooltip. |
| Bottom-left | **Overlay switcher**: segmented, 28 px, `[lines] Lines · [mesh] Mesh · [eye-off] Off`, icon + text. Writes `overlay.style` (`'skeleton' / 'mesh' / 'off'`). Tooltip on Mesh: "Wireframe over your body — adjust strength in Settings › Camera & preview". |
| Bottom-right | Icon button `eye-off` "Hide preview (monitoring continues)". When hidden, the hero becomes a `card` panel the same size, holding a large breathing Spine Glyph, the line "Preview hidden — SitSense is still watching." and a ghost `Show preview` button. |

Overlay states inside the frame (existing `FrameState` / `EmptyState` content, restyled to
§8.6): camera errors, model errors, starting ("Starting the camera…" with a 1.2 s
shimmer over the frame), away ("Looks like you stepped away"), and paused (desaturate plus
a 250 ms "eyelid" blur, as before). The away text is centered with a scrim card behind it, so
it stays readable over any image.

#### 3.2.1 Tracking chip

This shows *what can be measured from this angle right now*, which addresses "tracking should
work properly" honestly instead of pretending. It is derived from `snapshot.readout` (or from
the setup checks during setup):

| Condition | Text | Tooltip |
|---|---|---|
| away / no snapshot | `Looking for you…` | "Sit in view of the camera — your head and one shoulder are enough to start." |
| `readout.trunkFwd !== null` | `Seeing head, shoulders & hips` | "Full tracking: neck, back angle, side lean and distance are all measured." |
| `trunkFwd === null && neckFwd !== null` | `Seeing head & shoulders` | "Your hips aren't in view, so your back angle is estimated from how far you sink. Tilt the camera down a little or sit back for full tracking." |
| `recalibrationSuggested` | `View changed` (amber dot) | "Your camera or seat moved a lot since setup. Readings may be off — redo posture setup." |

### 3.3 Overlays (Lines and Mesh)

**Lines**: unchanged from v2 (ear → shoulder → hip chain plus the true-vertical dashed line;
segments take their issue's stage color). It is the default.

**Mesh** (rework, owned by `MeshOverlay.tsx` / `bodyMesh.ts`). Goal: *every body surface is
covered, yet the person stays clearly visible.* The camera image must read first and the
mesh second.

* New setting `overlay.meshIntensity: number`, range 0.15–1.0, default **0.45**, step 0.05.
* New setting `overlay.meshBackdrop: 'camera' | 'dim'`, default `'camera'`. `'dim'` is the old Hologram look (the feed at 45 % brightness, 60 % desaturated, with scanlines). Migration: a stored `style: 'hologram'` becomes `style: 'mesh', meshBackdrop: 'dim'`. `OverlayStyle` keeps `'hologram'` only as a legacy input value. The UI never offers it as a style.
* Rendering rules, with `I` = intensity:
  * **No triangle fills** anywhere, except active-issue hotspots: stage color, alpha `0.10·I`, with a soft 1.6 s pulse (motion-safe).
  * Interior lattice edges: 0.75 css px, alpha `0.08 + 0.32·I` (≈ 0.22 at the default), in the overlay color.
  * Lattice density: the average edge length is **≥ 3.5 % of the preview width** (≈ 21 px at 612 px wide). In effect, at least 75 % of the body's pixels are not touched by any line at the default intensity.
  * Silhouette outline: 1.5 css px, alpha `0.35 + 0.45·I`.
  * Face: only the contours (face oval, brows, eyes, lips) at 1 px with alpha `0.25 + 0.5·I`. The full 468-point tessellation is drawn only when `I ≥ 0.8`, and then at alpha `0.15·I`. Eyes are never filled.
  * Joint markers: 2.5 px rings (not filled), alpha `0.5`, drawn only at the shoulders, hips and ears.
  * Scanner sweep: one pass every 6 s, band alpha ≤ `0.12·I`. Off under reduced motion.
  * A 1 px dark halo (`rgb(23 21 18 / 0.35)`) under the outline only, so it stays readable on bright clothing. No halo on interior edges.
* Acceptance: at the default intensity, a screenshot of a person shows their face, hair and clothing pattern clearly, and the mesh reads as a fine net on top. At 1.0 it may look dense, but the face is still recognizable.

**Off**: the camera image only.

### 3.4 Posture card (cols 9–12)

The header is the eyebrow `POSTURE`, with an info icon tooltip on the right: "Score 0–100
from how far you are from your saved good posture right now." The body is in three zones.

**Zone A: score and status** (horizontal: ring on the left, text on the right; stacked under 300 px card width):

* **Score ring**: 112 px (88 compact). A 10 px stroke track `white/6`, and a value arc in the band color (§3.4.1) with round caps. It animates 400 ms ease-out on change. The center holds the number (`score`) with `/100` below it in `caption text-faint`. When `score === null`, the center shows `—` and the arc is empty.
* **Status word** (`h2`): `Good`, the worst issue's label (`Slouching`, `Head forward`, `Leaning to one side`, `Too close to screen`), `Paused`, `Away`, `View changed`, `Not set up`, or `Camera off`. It crossfades over 200 ms. `View changed` (`snapshot.suspended`: the view is far off the setup distance, every detector paused — detection.md §5) comes right after Away and before any issue; its sub-line is "Posture isn't judged until you redo setup." and the ring stays empty (never a sage 100).
* Under it: a stage pill (`slight` / `clear` / `severe`) when an issue is active, then the sub-line in `value 13 text-dim`: `47 min aligned` (the current good streak) or `for 2m 10s` (the current issue's duration).
* If the baseline is unverified (`calibration.verified === false`): an amber-outlined chip `Unverified baseline` under the status. Its tooltip reads "SitSense couldn't confirm your saved posture from this angle. Redo setup for an accurate score." and clicking it opens setup.

**Zone B: metric gauges.** There are four rows, always in this order. Each row is a label
(`body text-dim`) and a value (`value 13`, colored by its issue stage, `text` when stage 0),
then a gauge track 6 px tall.

| Row label | Readout field | Issue (color) | Display range (lo … hi) | Ticks at (× 1/σ) | Value text |
|---|---|---|---|---|---|
| Head position | `neckFwd` (°) | headForward | −10 … 32 | 10, 18, 28 | `+4° forward` · `level with baseline` (|v| < 1) · `3° back` |
| Back angle | `trunkFwd` (°); if null, `drop` (cm) and the label becomes **Sitting height** | sink | −10 … 32 (°) · −5 … 18 (cm) | 10, 18, 28 · 5, 10, 16 | `6° forward` / `4° reclined` / `level` · `3 cm lower` / `same` |
| Side lean | `lateral` (°) | lean | −20 … 20 (centered); −25 … 25 when `readout.lateralFrom === 'neck'` | ±6, ±11, ±18 (trunk) · ±8, ±14, ±22 (neck tilt) | `2° to your left` / `centered` |
| Screen distance | `forward` (cm) | tooClose | −15 … 22 | 7, 13, 19 | `5 cm closer` / `4 cm farther` / `same` |

Gauge rendering:

* The track is `white/6`, rounded.
* The zone segments from tick 1 → 2 → 3 → hi are tinted amber, ember and coral at 18 % alpha. The good zone below tick 1 is tinted sage-deep at 40 %.
* A 2 px `text-faint` baseline tick sits at 0, captioned `your setup` on hover.
* The value marker is a 10 px circle in the stage color with a 2 px ink ring. Its position is clamped to the range, with an arrow cap when outside it. It animates 250 ms.
* Side lean is two-sided, and its zones mirror around 0.
* **Unavailable** (`null`): a dashed `hairline-strong` track and no marker. The value text reads `can't see from here` (`text-faint`), with a tooltip naming the reason (e.g. "Your hips aren't in view").
* Disabled issue (Settings): the row shows `off` in `text-faint`, with a muted track and a ghost link "Turn on" → Settings › Posture detection.

The gauges show only while monitoring is live (`!paused && running && !cameraError &&
calibrated && presence === 'active'`). Otherwise Zone B shows a single-line reason in the
same space: `Paused — gauges resume with monitoring.` / `Waiting for you to sit in view.` /
`Your view changed a lot since setup — redo setup to measure again.` (suspended, with a
`Redo posture setup` button) / `Set up your posture to see live measurements.` (with a
primary `Set up posture` button). While suspended the overlays' posture color is neutral
slate, never sage.

**Zone C** (only when space allows, card height > 420): the view chip (`Front view` /
`Angled view` / `Side view`) and `Setup 2 days ago`.

#### 3.4.1 Posture score: formula

This is a pure function in `lib/score.ts`, unit-tested.

Inputs: `snapshot: PostureSnapshot`, `settings.issues[i].enabled`.

1. **Gate.** `score = null` if `!snapshot.calibrated`, `presence === 'away'`, `snapshot.suspended`, paused, camera error, or no snapshot.
2. **Continuous severity per enabled issue** `s_i ∈ [0, 3.5]`:
   * If the engine provides `IssueSnapshot.level` (new optional field, §11), use `s_i = clamp(level, 0, 3.5)`.
   * Otherwise use `s_i = stage_i`, an integer.

   `level` is defined as the maximum over the issue's available sub-metrics of a piecewise-linear map of the sensitivity-scaled value `v` against its thresholds `T1 < T2 < T3`: `0` at `v ≤ 0`, `v/T1` up to `T1`, then `1 + (v−T1)/(T2−T1)`, `2 + (v−T2)/(T3−T2)`, and `3 + min(0.5, (v−T3)/(T3−T2))`.
3. **Penalty per issue** `p_i = w_i · (14·s_i + 4·s_i²)`, with weights `w = { sink: 1.0, headForward: 1.0, lean: 0.7, tooClose: 0.6 }`. Reference values with w = 1: s = 0.5 → 8, s = 1 → 18, s = 2 → 44, s = 3 → 78.
4. **Combine** with the worst issue counting fully and the others counting half: `P = max_i p_i + 0.5 · (Σ_i p_i − max_i p_i)`.
5. `raw = clamp(100 − P, 0, 100)`.
6. **Display smoothing**: an EMA with time constant τ = 2 s (`display += (raw − display)·(1 − e^(−Δt/τ))`). It reseeds to `raw` when it changes from null. Show `Math.round(display)`.

Examples:

| Situation | Score |
|---|---|
| No issues | 100 |
| Slight slouch (s = 1) | 82 |
| Clear head-forward (s = 2) | 56 |
| Clear slouch and slight lean (44 + 0.5·12.6) | 50 |
| Severe slouch (s = 3) | 22 |

**Bands** (ring color and the Live nav dot):

| Score | Band | Color |
|---|---|---|
| ≥ 85 | aligned | sage |
| 65–84 | drifting | amber |
| 40–64 | strained | ember |
| < 40 | poor | coral |

The band word is not shown separately: the status word does that job. The band is visible
only as color, always paired with the number.

### 3.5 Today card and Sitting card

**Today** (cols 1–6). Header: `TODAY`, with `History →` (ghost link) on the right.

* Row 1: `h2` `82%` + `caption` `aligned`, then `value 13 text-dim` `4h 06m good · 54m off`.
* Row 2: the **timeline**, 20 px tall, rounded 6. It reuses `mergeRuns` and the run colors (sage-deep / amber / ember / coral; away and paused show as ink with a dotted top edge). There are start and `now` labels in `caption text-faint`, and hour ticks (1 px `white/8`) every full hour when the span is ≥ 3 h. Hovering shows an e3 tooltip: `14:20–14:26 · Head forward (clear)`.
* Row 3: `caption text-dim`: `Best stretch 47 min · 3 nudges` (nudges = today's logged alerts, §5.4).
* Empty state (nothing tracked yet): a 40 px dotted timeline placeholder, and "Your day fills in here once SitSense has watched you sit for a minute."

**Sitting** (cols 7–9). Header: `SITTING`, with the `coffee` icon.

* `h2` `38 min` (the current sitting stretch, §5.3) + `caption` `in your chair`.
* A progress bar (8 px, rounded) toward `breaks.everyMinutes`: sage up to 80 %, amber from 80 %, and a full amber bar with a soft pulse at ≥ 100 %.
* `caption`: `Next break in 12 min` / `Break due now — stand up for 3 minutes` / `On a break · 4 min` (while away ≥ 1 min) / `Breaks are off` (with a link `Turn on` → Settings › Notifications & breaks).
* Footer `caption text-faint`: `2 breaks today`.

### 3.6 Coach card (cols 10–12)

The header is `COACH` with the `spark` icon, and `Open →` on the right (navigates to Coach).

**With a usable AI connection:**

* A preview of the last assistant message (2-line clamp, `body-lg text-dim`), or if there is none, "Ask anything about your posture, your desk or a stretch." Clicking the preview opens Coach.
* A one-line input (32 px) with placeholder `Ask your coach…` and a 28 px `send` icon button inside it on the right. Enter sends: it navigates to Coach, appends the message there and sends it (§4). Empty input disables send.
* A ghost `sm` button: `[camera] Check my posture now`. It navigates to Coach and runs the check (§4.4).

**Without one** (none, or AI off): the `spark` icon in a 32 px sage-soft circle, the text
"Your coach can answer questions about your posture once you connect an AI model.", and a
secondary `sm` button `Connect a model` → Settings › AI models. When the AI is merely turned
off, the text is "Your AI model is turned off." and the button is `Turn on` → Settings › AI
models.

The old "Ask AI" block on the dashboard is removed. Its function lives in Coach.

### 3.7 Banners on Live (above row 1, full width, e1 with a 3 px left accent)

At most one shows at a time, in this priority order:

1. Camera mismatch (amber): "This posture was set up with a different camera." with the actions `Redo posture setup` and `Keep it for this camera`.
2. Recalibration suggested (amber): "Your view changed a lot since setup — readings may be off." with the actions `Redo posture setup` and `Dismiss`.
3. Unverified baseline (amber): "Your saved posture isn't verified — SitSense couldn't check your {what} from this angle." with the actions `Redo posture setup` and, when there is no AI connection, `Connect an AI model for a second opinion`. It shows once per app start until dismissed, and the score chip (§3.4) stays regardless.
4. Using a fallback camera (slate): the existing `FallbackNote` copy.

---

## 4. Coach (AI chat)

Purpose: talk to an AI coach that can see the user's posture numbers. It is local-first: the
history stays on this device, and nothing is sent unless the user sends a message or presses
*Check my posture now*.

### 4.1 Layout at 1200×800

```
┌ Coach ─────────────────────────────────── Gemini · gemini-3.5-flash-lite [Clear chat] — ✕ ┐
│ ┌───────────────────────────────────────────────────────┐ ┌───────────────────────────┐ │
│ │                                                       │ │ WHAT YOUR COACH SEES      │ │
│ │  (spark) Coach                              14:02     │ │ [✓] Live measurements     │ │
│ │  ┌─────────────────────────────────────────────┐      │ │     Score 86 · Neck +4°   │ │
│ │  │ Your neck sits about 4° ahead of your setup.│      │ │     Back level · 1° left  │ │
│ │  │ Two things help: **raise the screen** …     │      │ │ [✓] Today's stats         │ │
│ │  │ • Tuck your chin                            │      │ │     82% aligned · 4h 06m  │ │
│ │  └─────────────────────────────────────────────┘      │ │ [✓] Your saved posture    │ │
│ │                                                       │ │     Side view · verified  │ │
│ │                        ┌────────────────────────────┐ │ │ ───────────────────────── │ │
│ │                        │ Why does my neck hurt in   │ │ │ PRIVACY                   │ │
│ │                        │ the afternoon?             │ │ │ Messages and the checked  │ │
│ │                        └────────────────────────────┘ │ │ items go to Gemini.       │ │
│ │                                                       │ │ No camera image unless    │ │
│ │  (spark) ● ● ●  Thinking…                    [Stop]   │ │ you check your posture.   │ │
│ │                                                       │ │ History stays on this PC. │ │
│ ├───────────────────────────────────────────────────────┤ └───────────────────────────┘ │
│ │ [How's my posture now?] [What went worst today?] [2-min stretch]                   │ │
│ │ ┌───────────────────────────────────────────────────────────────┐ ┌──────────────┐ │ │
│ │ │ Ask about your posture, desk or a stretch…                     │ │ [→] Send    │ │ │
│ │ └───────────────────────────────────────────────────────────────┘ └──────────────┘ │ │
│ │ [camera] Check my posture now                       Enter to send · Shift+Enter ↵ │ │
│ └───────────────────────────────────────────────────────┘                           │ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
   chat column: flex 1, max 760                              context panel: 280 (e1)
```

* The chat column is one e1 card filling the height. The message list scrolls, and the composer is pinned at the bottom of the card.
* Context panel: 280 px on the right at standard and wide widths. Under 1100 px window width it collapses into a row of **context chips** above the composer (`[✓ Live] [✓ Today] [✓ Setup]`, click to toggle, details in the tooltip), and the privacy text moves under the composer as one `caption` line.
* Top bar: the title `Coach`, a sub with the active connection and model (`caption text-faint`), and the action `Clear chat` (ghost `sm`, `trash` icon). Clear asks for confirmation in an e3 popover: "Clear the whole conversation? This can't be undone." with `Clear` (danger) and `Cancel`.

### 4.2 Messages

* **Assistant**: left-aligned, no bubble fill. A 24 px avatar (the `spark` icon in a sage-soft circle), the name `Coach` in `caption text-dim`, the time `caption text-faint` (HH:MM), and the text in `body-lg text` with max width 620. Hover reveals a small `Copy` ghost icon.
* **User**: right-aligned bubble, `bg-card-2`, radius 14 (4 on the bottom-right), padding 10/14, `body-lg`, max width 520.
* **Posture check result** (a special assistant message): a nested e2 card with a mini score ring (40 px) + `82/100`, the verdict chip (`Looks good` sage / `Adjust` amber), the one-sentence summary, up to 3 numbered tips, a thumbnail of what was sent (the pose sketch, or a blurred-out "Camera snapshot sent" placeholder; the image itself is **not** stored), and a footer `caption text-faint` with `Checked by <label> · <model>`.
* **System notes** (centered `caption text-faint`, no avatar): `Conversation cleared`, `Measurements updated` (when the context changed a lot since the last message), and the day separator `Today` / `Yesterday` / `Mon 5 Oct`.
* Messages are grouped: consecutive messages from the same side within 2 min drop the repeated avatar and time.
* Auto-scroll to the bottom on new messages, unless the user has scrolled up more than 80 px. In that case a floating `↓ New message` pill appears.

### 4.3 Markdown-lite rendering

The renderer is pure (`coach/markdown.ts`): it parses into a small AST and renders React
elements. It **never** uses `dangerouslySetInnerHTML`.

| Input | Rendered as |
|---|---|
| Blank line | paragraph break (12 px) |
| Single newline | `<br>` |
| `**bold**` / `__bold__` | `font-semibold text-text` |
| `*italic*` / `_italic_` | italic |
| `` `code` `` | Plex Mono 12, `bg-white/6`, radius 4, px 4 |
| Lines starting with `- `, `* ` or `• ` | bullet list (sage 4 px dot, 8 px indent) |
| Lines starting with `1. ` / `1) ` | numbered list (Plex Mono numbers, `text-dim`) |
| `# …` to `###### …` | a bold paragraph (no big headings in chat) |
| `> quote` | `text-dim` with a 2 px `white/10` left border |
| Links `[t](url)` and bare URLs | **plain text** `t (url)`, not clickable (no navigation from model output) |
| Code fences ``` | a monospace block, `bg-ink`, horizontal scroll inside the block only |
| Tables, images, HTML | shown as literal text |

Assistant messages are capped at 6000 characters (`… (shortened)` appended).

### 4.4 Composer and actions

* A textarea that grows from 1 to 5 lines, placeholder `Ask about your posture, desk or a stretch…`, max 1000 characters. At 900 a counter appears (`caption`, Plex Mono, `912/1000`).
* `Enter` sends. `Shift+Enter` inserts a newline. `Esc` blurs. `Ctrl+L` focuses the composer from anywhere on Coach. `↑` in an empty composer recalls the last user message for editing.
* **Send** (primary `md`, `send` icon + "Send"): disabled when the input is empty or a reply is pending. While pending it becomes **Stop** (secondary, `stop` icon), which aborts the request. An aborted request leaves the system note `Stopped`.
* **Suggested prompts** (chips, 28 px, `bg-white/[0.04]` → `sage-soft` on hover): shown above the composer when the chat is empty, or after an assistant reply (3 chips, rotated from the pool in §10.4). Clicking one sends its text immediately.
* **Check my posture now** (ghost `sm`, `camera` icon): builds the image per `ai.share` (sketch, or a snapshot ≤ 640 px) plus the measurements, and sends an `AiReviewRequest` with `purpose: 'check'` through the existing `aiReviewPosture`. The result is inserted as a posture-check message (§4.2), and the user's side shows a small chip `Checked my posture`. If the user isn't in view: an inline note `Sit in view of the camera first — SitSense needs to see you.` If paused: `Resume monitoring to check your posture.`

### 4.5 What the coach sees (context)

Three toggles, each persisted per device in `settings.ai.coachContext = { live: true, today:
true, baseline: true }`:

| Chip / row | Sent as text with each message (never an image) |
|---|---|
| **Live measurements** | score, status word, active issues with stage and duration, view, readout values with units, tracking level |
| **Today's stats** | aligned %, minutes good/off, minutes per issue, sitting stretch, breaks taken, nudges |
| **Your saved posture** | view, verified/forced, neck/trunk/shoulder angles from the baseline (`measurementsFromBaseline`) |

Each row in the panel shows a one-line live preview of the values (`caption text-dim`, Plex
Mono numbers), so the user sees exactly what goes out.

### 4.6 States

| State | UI |
|---|---|
| **No AI connected** | The whole chat card becomes an empty state: a 64 px illustration (a chat bubble with the spine glyph), `h3` "Your coach needs an AI model", the body "Connect your own AI model — Gemini, OpenAI, Anthropic, OpenRouter, or a local one like Ollama. On-device posture tracking keeps working without it.", the primary `Connect a model` → Settings › AI models, and the ghost `How privacy works` → Settings › Privacy & data. The context panel stays visible (it teaches what would be shared). |
| **AI turned off** | The same layout. Headline "Your AI model is turned off", primary `Turn on AI` (sets `ai.enabled = true` in place, then shows the chat). |
| **Coach use off** (`ai.useInCoach === false`) | Headline "Coach chat is turned off", primary `Turn on` → sets it. |
| **Empty chat** | Greeting message from Coach (not persisted): "Hi! I can see your live posture numbers and today's stats. Ask me anything — or press *Check my posture now*." plus 4 suggested prompt chips in a 2×2 grid. |
| **Thinking** | An assistant row with three 6 px dots pulsing in sequence (motion-safe; static `…` otherwise) and `Thinking…`. After 8 s, `Still thinking — local models can take a while.` |
| **Error** | An inline assistant-side row with a coral-tinted (12 %) background: one line from `aiErrorLine()` and a `Retry` ghost button that resends the same user message. If the message mentions Settings, add `Open AI settings`. |
| **Offline** (`navigator.onLine === false` and every usable connection is non-local) | A banner on top of the chat: `You're offline. Messages will work again once you're connected — local models like Ollama still work.` Send is disabled with a tooltip. |
| **Fallback used** | If the primary failed and a fallback answered: a `caption text-faint` note under the reply, `Answered by <fallback label> — <primary> didn't respond.` |

### 4.7 Persistence and contract

* History is **local only**: `userData/coach-history.json`, written by main (atomic write). The cap is the last 200 messages, and images are never stored (a posture-check message keeps its numbers, text and `share` mode only). `Clear chat` deletes the file contents. Settings › Privacy & data shows the count and offers *Clear coach chat*.
* IPC (new, validated in main like the other AI calls):

  ```ts
  coachHistoryGet(): Promise<CoachMessage[]>
  coachHistorySet(messages: CoachMessage[]): Promise<void>      // main enforces the cap and the length limits
  coachHistoryClear(): Promise<void>
  aiChat(req: { id: string; messages: { role: 'user' | 'assistant'; content: string }[];  // last 20, each ≤ 2000 chars
                context: string /* ≤ 4000 chars, built by the renderer from §4.5 */ }): Promise<AiChatReply>
  aiChatCancel(id: string): Promise<void>
  type AiChatReply = { ok: true; text: string; connectionLabel: string; model: string; fallbackFrom: string | null }
                   | { ok: false; message: string; cancelled?: boolean }
  interface CoachMessage { id: string; role: 'user' | 'assistant' | 'system'; kind: 'text' | 'check';
                           text: string; at: number; review?: AiReviewOk; meta?: { label: string; model: string } }
  ```

* The system prompt (owned by `main/ai`): a friendly ergonomics coach for a seated computer user. Short answers (≤ 120 words unless asked for more), concrete, not medical diagnosis (it suggests a professional for pain lasting more than a couple of weeks, numbness or sharp pain), it uses the user's own left/right, and it knows the camera may be at any angle. Timeout 45 s, with the same fallback order as the reviews.
* A new setting `ai.useInCoach: boolean`, default `true`, sits in Settings › AI models.

---

## 5. History

Purpose: patterns over time. Day and week views.

### 5.1 Layout: Day view at 1200×800

```
┌ History ─────────────────────── [Day|Week]   ‹  Today, Mon 5 Oct  ›   — ✕ ┐
│ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐                │
│ │ ALIGNED  ││ SITTING  ││ BREAKS   ││ NUDGES   ││ STREAK   │  KPI tiles      │
│ │ 82%      ││ 5h 00m   ││ 4        ││ 6        ││ 3 days   │  (5 × equal)    │
│ │ +6 vs avg││ 1 long   ││ every 52m││ 2 severe ││ best 9   │                 │
│ └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘                │
│ ┌ TIMELINE ─────────────────────────────────────────────────────────────────┐│
│ │ 08  09  10  11  12  13  14  15  16  17                                    ││
│ │ ▁▁▂████▁▂▂▁▁████▁▁▂▁▁▁▁   ░░lunch░░   ███▂▂▁████▁▁                        ││
│ │ legend: ■ good ■ slight ■ clear ■ severe ┄ away/paused                    ││
│ └───────────────────────────────────────────────────────────────────────────┘│
│ ┌ BY ISSUE ─────────────────────────────┐┌ BY HOUR ─────────────────────────┐│
│ │ Slouching      ▓▓▓▓▓▒▒░  31 min       ││ 00 … 07 08 09 10 11 12 13 14 15 …││
│ │ Head forward   ▓▓▒░      14 min       ││  ·  ·  ▇  ▇  ▇  ▆  ·  ▇  ▇  ▅   ││
│ │ Leaning        ▓░         6 min       ││ best hour 10–11 · worst 15–16     ││
│ │ Too close      ░          3 min       ││                                   ││
│ └───────────────────────────────────────┘└───────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

* **Top bar**: a segmented `Day | Week` (persisted in the store for the session), then a date navigator: `‹` icon button, a label button (`Today, Mon 5 Oct` / `Yesterday, Sun 4 Oct` / `Thu 1 Oct`; clicking it opens a 2-week mini calendar popover where days with data have a dot), and `›` (disabled on today). `←` and `→` keys step the date.
* **KPI tiles** (5 equal, e1 dense, 96 px). Eyebrow, `h2` number, `caption` delta or context:
  * **Aligned**: `82%`, delta vs the 7-day average (`+6 vs avg` sage when better, amber when worse, `text-faint` when within ±2).
  * **Sitting**: active minutes `5h 00m`; sub `1 long stretch` (stretches > 2× `breaks.everyMinutes`) or `no long stretches`.
  * **Breaks**: count; sub `every 52 min` (average active time between breaks) or `none yet`.
  * **Nudges**: count; sub `2 severe` or `all gentle`.
  * **Streak**: `3 days`, sub `best 9`. Definition in §5.3.
* **Timeline card**: the day's timeline at 28 px height, spanning first to last tracked minute with hour labels. Breaks ≥ L render as labeled gaps (`break · 34 min` inside when wide enough). Hover tooltips as on Live. A legend row follows (12 px swatches: good, slight, clear, severe, and a dotted swatch for away/paused).
* **By issue** (cols 1–6): one row per issue (all four, even at 0): the label, a horizontal stacked bar (slight amber / clear ember / severe coral, scaled to the largest issue that day, minimum 4 px when > 0), and minutes in Plex Mono. Hover gives a split tooltip (`slight 18 · clear 10 · severe 3 min`). Sorted by minutes, descending.
* **By hour** (cols 7–12): a heat strip of 24 cells (each ~22×28, radius 4, gap 3), labeled every 3 hours (`00 03 06 …`). Cell color = band of that hour's aligned % (§3.4.1 band colors); cell opacity `0.35 + 0.65·min(1, activeMin/30)`. An hour with no data gets a `white/[0.03]` fill and a dotted outline. Tooltip: `14:00–15:00 · 74% aligned · 48 min tracked`. Footer: `best hour 10–11 · worst 15–16` (only hours with ≥ 15 active minutes).

### 5.2 Week view

```
┌ History ─────────────────────── [Day|Week]   ‹  28 Sep – 4 Oct  ›     — ✕ ┐
│ KPI tiles (same five, week totals; Aligned delta vs the previous week)       │
│ ┌ DAYS ─────────────────────────────────────────────────────────────────────┐│
│ │  82%    74%    90%    —     68%    85%    88%   ← aligned % labels        ││
│ │  ███    ███    ███          ███    ███    ███   ← stacked minutes:        ││
│ │  ███    ██▒    ███          ██▒    ███    ███     good/slight/clear/sev.  ││
│ │  Mon    Tue    Wed    Thu   Fri    Sat    Sun                             ││
│ └───────────────────────────────────────────────────────────────────────────┘│
│ ┌ BY ISSUE (week) ──────────────────────┐┌ WEEK × HOUR ─────────────────────┐│
│ │ same rows, week minutes               ││ 7 rows × 24 cells heat grid       ││
│ └───────────────────────────────────────┘└───────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

* **Days chart**: 7 columns, each a vertical stacked bar (height = active minutes, scaled to the week's max; segments good sage-deep / slight / clear / severe, bottom to top), with the aligned % above it (Plex Mono 13, colored by band) and the weekday below. Today's column label is `text` with a sage underline. A day without data shows `—` and a dotted 4 px baseline. Clicking a column switches to that day's Day view.
* **Week × hour grid**: 7 × 24 cells (14×14, gap 2) with the same coloring rules as By hour; row labels are weekdays.
* Weeks start on Monday (locale-independent, matching the German user).

### 5.3 Definitions (pure functions in `lib/history.ts`, unit-tested)

* **Active minute**: `s === 'good'` or an issue state. **Aligned %** = good / active, rounded. Not shown (`—`) when active < 5.
* **Break**: a run of non-active minutes (away, paused, or no data between two logged minutes) of length ≥ `breaks.lengthMinutes` (default 3), between two active minutes on the same day.
* **Sitting stretch** (Live): minutes from the end of the last break (or the first active minute today) to now, counting wall-clock time. While away for less than L it keeps counting; once away for L or more it resets to 0 at return.
* **Long stretch**: a sitting stretch longer than `2 × breaks.everyMinutes`.
* **Good day**: active ≥ 30 min and aligned ≥ 70 %. **Streak**: consecutive good days ending today (today counts only once it qualifies; otherwise the streak ends yesterday). **Best**: the longest such run in the stored 90 days.
* **Best stretch** (Today): the longest run of consecutive good minutes.

### 5.4 Data contract (main, `stats.ts`)

* The day file gains `alerts: { t: number; issue: IssueId; stage: 1 | 2 | 3; kind: 'initial' | 'escalation' }[]`. Only alerts that produced a toast are logged. The count is shown as "nudges".
* New IPC `statsGetRange(from: string, to: string): Promise<DayStats[]>` (inclusive `YYYY-MM-DD`, max 62 days), with `DayStats = { date: string; minutes: StatMinute[]; alerts: AlertLogEntry[] }`. Missing days are returned as `{ date, minutes: [], alerts: [] }`.
* New IPC `statsClear(): Promise<void>` (Privacy & data).

### 5.5 Empty and partial states

* **No data at all**: a centered empty state in place of the KPI and charts: the `history` illustration, "Your history starts today", "SitSense logs one tiny line per minute — good, slouching, away. Come back after a few hours at your desk.", and the ghost `Go to Live`.
* **A day with no data**: KPI tiles show `—`; the timeline card says `Nothing tracked on Thu 1 Oct.`; the other cards stay but are muted.
* **Before setup**: a banner `History only counts time after posture setup.` with `Set up posture`.

---

## 6. Settings

### 6.1 Layout

```
┌ Settings ──────────────────────────────────────────────────────────────────────── — ✕ ┐
│ ┌──────────────────────────┐  Camera & preview                                         │
│ │ [gear] General           │  Which camera SitSense uses and how the preview looks.     │
│ │  Startup, window, setup  │                                                            │
│ │▌[camera] Camera & preview│  ┌ CAMERA ───────────────────┐ ┌ PREVIEW ────────────────┐ │
│ │  Camera, overlay style   │  │ [Integrated Camera   ▾]   │ │ ┌──────────────────────┐ │ │
│ │ [spine] Posture detection│  │ ┌─────────┐ Using: Integr.│ │ │ live preview with   │ │ │
│ │  Sensitivity, speed      │  │ │ thumb   │ Any angle     │ │ │ the chosen overlay  │ │ │
│ │ [bell] Notifications &   │  │ └─────────┘ works.        │ │ └──────────────────────┘ │ │
│ │  breaks — Nudges, breaks │  └───────────────────────────┘ │ Style [Lines|Mesh|Off]  │ │
│ │ [spark] AI models        │                                │ Mesh strength ──●──── 45%│ │
│ │  Connect your own model  │  ┌ COLOR ────────────────────┐ │ Dim camera behind mesh ○│ │
│ │ [shield] Privacy & data  │  │ (posture) ○ ○ ○ ○ ○ ○ ○ + │ └─────────────────────────┘ │
│ │  What stays on this PC   │  │ Follows your posture …    │                             │
│ │ [info] About             │  └───────────────────────────┘                             │
│ │  Version, licenses       │                                                            │
│ └──────────────────────────┘                                                            │
│   260 px category list                     category content (2-col grid ≥ 1100 window)     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Category list** (260 px, sticky, its own scroll if needed): each item is 56 px tall, radius 12, padding 10/12, with a 20 px icon, a title (`title` 14/600) and a one-line description (`caption text-dim`, ellipsis). States: rest transparent; hover `white/[0.04]`; selected e2 (`bg-card-2` + ring) with the icon in sage and the 3 px sage left bar. Keyboard: ↑/↓ move, Enter selects; `Ctrl+,` opens Settings from anywhere.
* **Compact (< 1000)**: the list shrinks to 200 px, title only (description in the tooltip). Under 860 px it becomes a horizontal scrollable chip row at the top of the content.
* **Content**: a header with the category title (`h3`) and a one-sentence intro (`body-lg text-dim`), then a grid of cards: 2 columns when the content column ≥ 760 px (12-col grid with spans), 1 column otherwise. Cards follow §1.4. Every control commits immediately, and the `Saved` fade is kept (1 s, `caption text-faint`, next to the control).
* Deep links: `openSettings('ai')` etc. Main's tray "Settings" opens the last category (default `general`).
* No search box in v3.

### 6.2 Categories

#### General: "Startup, window and posture setup"

| Card (span) | Contents |
|---|---|
| **Startup** (6) | `Start with Windows` toggle; `Start minimized to tray` toggle (disabled with the hint "Turn on Start with Windows first" when that is off). |
| **Window** (6) | Text "Closing the window keeps SitSense running in the tray." The `Quit SitSense` button (secondary). |
| **Posture setup** (12) | A left 48 px Spine Glyph in the baseline's state. Title `Your good posture`. Line: `Set up 2 days ago · Side view · Verified by on-device AI` / `… · Verified by on-device AI and Gemini` / `… · Not verified` (amber) / `Not set up yet`. The primary `Redo posture setup` (or `Set up posture`) button. Sub: "Redo it after moving your camera, desk or chair." |

#### Camera & preview: "Which camera SitSense uses and how the preview looks"

| Card (span) | Contents |
|---|---|
| **Camera** (5) | Device select (full width), a 160×90 live thumbnail below it, and the line `In use: Integrated Camera` or the fallback note. Hint: "Any angle works — front, side or in between. Only part of you needs to be in the picture." |
| **Preview** (7) | A large live preview (16:9, the full card width) rendering the current overlay. Below it: `Style` segmented `[lines] Lines · [mesh] Mesh · [eye-off] Off` with a one-line description per style (§10.5). When Mesh: a `Mesh strength` slider (15–100 %, Plex Mono value) and a `Dim camera behind mesh` toggle. Changes apply live in the preview. |
| **Color** (12) | The swatches row (posture conic swatch, 7 presets, custom picker) and the description line, as in v2, restyled: 28 px swatches, a selected ring of 2 px sage + 2 px offset. |

#### Posture detection: "How strict SitSense is, per issue"

| Card (span) | Contents |
|---|---|
| **Issue cards** (6 each, 2×2) | One per issue. Header: the 28 px mini Spine Glyph showing that issue's deformation at stage 2, the issue name (`title`), and an enable toggle on the right. Body: a 5-step sensitivity slider with notches, end labels `Relaxed` / `Strict`, the current step name in Plex Mono (`Balanced`), and a hint line (existing `SENSITIVITY_HINTS`). A footer `caption text-faint` with what it watches (§10.5). A disabled card dims to 50 %, collapses the slider and shows "Not watched." |
| **Speed** (6) | `Performance` segmented `Efficient · Balanced · Responsive` with the fps in Plex Mono under each; the hint "Higher settings react faster and use more CPU." |
| **Processing** (6) | `Run the model on` segmented `Auto · Graphics card · Processor` (maps to `delegate`), with the `In use: GPU` line from `resolvedDelegate`. |
| **Posture setup** (12) | The same card as in General (one component). |

#### Notifications & breaks: "When and how SitSense nudges you"

| Card (span) | Contents |
|---|---|
| **Nudges** (7) | The master toggle `Posture nudges`. Then four rows: issue name + `Nudge me from:` segmented `slight · clear · severe` (stage-tinted when selected, as in v2), with `Fine-tune per stage ▾` for the 4×3 matrix. Separator. `Wait before nudging` slider (Plex Mono `12 s`), `Quiet period between nudges` (`3 min`), `Escalate if it gets worse` toggle, `Sound` toggle. All rows below the master dim when it is off. |
| **Preview** (5) | A **notification preview mock**: a Windows-11-style toast drawn in HTML (e2, 360×~120, radius 8): the app row (16 px spine glyph + "SitSense" `caption`), the title (`title`) and body (`body`) from the first phrasing of the selected issue × stage, and the action button `Pause 15 min` (non-functional, `aria-hidden`). Above it, two small selects: issue and stage (default Slouching · clear). The `Send a test notification` secondary button below, with the hint "If nothing appears, check Windows notification settings for SitSense." |
| **Breaks** (12) | The toggle `Remind me to take breaks` (new `breaks.enabled`, default **true**). `Remind me every` slider 30–90 min step 5 (default **50**). `A break counts after` slider 1–10 min (default **3**). Hint: "SitSense notices when you leave your desk — walking away for {L} minutes counts as a break. No need to tell it." |

The break toast (main, `notifications.ts`): it fires once when the stretch reaches
`everyMinutes`, and once more 15 min later if the user is still sitting. Never while paused,
away, or before setup. Copy in §10.3.

#### AI models: "Connect your own model for second opinions and the coach"

| Card (span) | Contents |
|---|---|
| **Status hero** (12) | The `spark` icon, then the title `Use a connected AI model` + the master toggle, and the existing subtitle. A status line: `Off — SitSense sends nothing to an AI model.` / `On · Primary: Gemini (gemini-3.5-flash-lite) · 2 fallbacks` / `On, but no connection works yet` (amber). |
| **What's sent** (7) | Two **option cards** side by side (radio semantics, 112 px tall), each with a small illustration: `Pose sketch` "Lines and dots only — no camera image." (default) and `Camera snapshot` "A small, downscaled frame from your camera." The selected card gets a sage ring and a check. Under them, the disclosure line (`shareDisclosure`), which describes posture checks and coach messages separately: a posture check or setup review sends the sketch/still plus the measured angles; a coach message sends the words, the recent conversation and the ticked context — never an image; nothing in the background; while paused nothing from the camera leaves the PC, coach questions are still answered. |
| **Where AI helps** (5) | Toggles: `Double-check posture setup` (`useInSetup`), `Coach chat` (`useInCoach`). Hint: "Never runs in the background. While paused, only coach questions are answered — nothing from the camera is sent." |
| **Connections** (12) | The existing `AiModelsSection` list and form, restyled: each connection is a row card (e2 on hover) with the provider glyph, label, model (Plex Mono), status dot + `Tested 2 min ago`, the `Primary` badge, and actions (`Test`, `Edit`, `•••` menu with Move up / Move down / Remove). `+ Add connection` is a dashed `hairline-strong` card button at the end of the list, which expands the form inline in a full-width card. |

#### Privacy & data: "What stays on this PC and what can leave it"

| Card (span) | Contents |
|---|---|
| **Stays on this PC** (6) | A check list (sage `check` icons): "Your camera image — analyzed live, never saved", "Your posture numbers and setup", "Your daily history (90 days)", "Your coach chat". |
| **Can leave this PC** (6) | When AI is off: the `lock` icon + "Only an update check." and, for a portable copy, "With AI models off, the only request SitSense makes is asking GitHub for its latest version." — an installed copy (or before the update status has loaded) says "With AI models off, SitSense only talks to GitHub: it asks for its latest version and downloads a newer one in the background when there is one." (with automatic update checks off: "Nothing. With AI models and automatic update checks off, SitSense makes no network requests."). When on: "Only when you ask the coach, check your posture or run setup: {disclosure} sent to {recipients}." plus the ghost `Change in AI models`. Under it, after a hairline, a caption on update checks: portable "Update checks: SitSense asks GitHub for its latest version shortly after it starts and every 6 hours. No posture data, camera image or settings are sent."; installed "…every 6 hours, and downloads a newer version from GitHub in the background when there is one. No posture data…" (auto-check off: "…only when you press “Check for updates” in About…", installed adds "(a newer version then downloads right away)") and a dim `Updates →` link to About. |
| **Data on this PC** (12) | Rows with a size or count in Plex Mono and an action: `Posture history` · `12 days · 84 KB` · `Delete history` (danger, confirm); `Coach chat` · `38 messages` · `Clear chat` (danger, confirm); `Your saved posture` · `Set up 2 days ago` · `Delete and redo setup` (danger, confirm, then opens setup); `AI keys` · `2 keys, encrypted with Windows` · (none; removed per connection). |
| **Reset** (12) | `Reset all settings` (danger) — "Puts every setting back to its default. Your history and AI keys stay." Confirm popover. Needs IPC `settingsReset()`. |

#### About

| Card (span) | Contents |
|---|---|
| **SitSense** (6) | A 64 px breathing glyph, `h3` "SitSense", `Version 0.2.0` in Plex Mono (`value-lg`, text), a `caption text-faint` channel line (`Installed · updates from GitHub` / `Portable · updates from GitHub` / `Development build`), and "Posture coaching that runs on your PC." |
| **Updates** (6) | A status row: a 28 px round tone icon, a `body` 500 title and a `caption` line (coral for errors, release notes clamped to 3 lines), and one `sm` button on the right. States: `Not checked yet` (info) + `Check for updates` · `Checking for updates…` (spinner, button loading) · `You’re up to date` (sage check) + "SitSense 0.2.0 is the latest version. Checked 3 min ago." · `Version 0.3.0 is available` (amber spark) + the release notes + primary `Download` → (portable: opens the GitHub release page) / `Download update` (installed) · `Downloading version 0.3.0` + a 6 px progress bar and the percent in Plex Mono · `Version 0.3.0 is ready` (sage refresh) + "Restart to finish (a few seconds), or it installs when SitSense quits." + primary `Restart to update` · `Update didn’t go through` (coral alert) + the friendly message + `Try again` · dev build: `Updates come with the installed app`, button disabled. Then a hairline and the toggle row `Check automatically` — portable "Asks GitHub for the latest version — no posture data is sent."; installed "Asks GitHub for the latest version and downloads new versions in the background — no posture data is sent." Portable adds a footer caption: "Portable copy: new versions download from the GitHub release page — replace this exe with the new one." |
| **Keyboard shortcuts** (6) | A table: `Ctrl+1…4` places, `Ctrl+,` settings, `Ctrl+L` ask the coach (from any screen: opens Coach with the message box focused), `Ctrl+Shift+P` pause or resume, `Ctrl+W` hide to the tray, `Esc` leave setup. `Ctrl+M` minimizes (not listed). The packaged build has no application menu, so the renderer handles Ctrl+W / Ctrl+M itself. |
| **Credits** (6) | Four tiles in a 2×2 grid: Pose tracking — MediaPipe (Apache 2.0) · Display type — Bricolage Grotesque · Interface type — Hanken Grotesk · Numbers — IBM Plex Mono (SIL OFL 1.1). |

---

## 7. Posture setup flow

Setup is a focused, full-window flow that **replaces the shell** (no sidebar). It has its own
identity: a darker background (`--color-setup-bg`) with a soft sage glow
(`radial-gradient(900px 520px at 72% -8%, rgb(147 201 162 / 0.10), transparent 62%)`), a
stepper, and large coaching type. It enters with 220 ms fade + scale 0.98 → 1 (motion-safe).

### 7.1 Frame

```
1200 × 800
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [spine] Posture setup        (1) Camera ── (2) Posture ── (3) Saved          [✕ Exit setup]│ 56 header (drag)
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ┌──────────────────────────────────────────────────┐   STEP 2 OF 3                       │
│  │                                                  │   Sit back — let your back         │
│  │                                                  │   rest against the chair.          │ h1 (32)
│  │          live camera, Lines overlay              │   Suggested by on-device AI        │
│  │          (forced; no switcher)                   │                                    │
│  │                                                  │   ✓ In view                        │
│  │                                                  │   ◐ Upright back      sit back     │
│  │                                                  │   ✓ Head over shoulders            │
│  │                                                  │   ! Centered weight   can't check  │
│  │ [Side view]                                      │   – Level head        not visible  │
│  └──────────────────────────────────────────────────┘   ─────────────────────────────    │
│   cols 1–7 (≈ 640 wide)                                  ( ring )  Hold it…              │
│                                                          Essentials checked: 3 of 4      │
│                                                                                          │
│                          [Save this posture anyway — unverified]  (after 20 s, ghost)    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Header (56 px)**: `[spine 20] Posture setup` (`title`); the **stepper** centered: three nodes (24 px circles; done = sage fill + `check`, current = sage ring + number, upcoming = `white/10` ring + number in `text-faint`), labels `Camera`, `Posture`, `Saved` (`caption`, current in `text`), connected by 48 px hairlines (sage when passed). On the right, the window controls (minimize, close-to-tray) after the **Exit setup** button (ghost `sm`, `close` icon). Close-to-tray (the ✕ or Ctrl+W) also leaves setup (main sends `window:closed-to-tray`), so nudges resume in the tray; a minimize keeps setup open, but no coaching session, raised frame rate or review image runs while the window is hidden — coaching starts over when it is shown.
* **Exit**: `Esc` or the button. Nothing is saved; `detectionController.cancelSetup()`, return to `returnTo`. If a baseline existed, it is kept. If none exists, Live shows its not-set-up state. No confirm dialog, except during *capturing*: "Leave setup? Your posture hasn't been saved yet." with `Leave` / `Keep going`.
* **Body**: a 12-column grid, 32 px padding. The camera is cols 1–7, and the coach panel cols 8–12 (no card background; it sits on the setup background with 8 px left padding for big type).
* **compact (780×580)**: the header stepper shows numbers only; the camera is cols 1–6 at 16:9 (~330 px wide), the instruction drops to `h2` (26), the checklist rows go to 28 px, and the "anyway" button moves under the progress. Nothing scrolls at 780×580.

### 7.2 Step 1: Camera

Goal: make sure SitSense can measure what it needs before coaching begins.

* Headline (`h1`): `Let's check your camera.` Sub (`body-lg text-dim`): "Sit where you normally work. Any camera angle is fine — your head and at least one shoulder need to be in the picture."
* A camera select (full width of the panel) when more than one camera exists.
* **What I can see** list (live, 36 px rows):

  | Row | Good when | Text when good | Text otherwise |
  |---|---|---|---|
  | Camera | frames arriving | `Camera is on` | `Starting the camera…` / the camera error |
  | You | `inView` good | `I can see you` | `Move so your head and a shoulder are in the picture` |
  | Hips | features include hips (`trunkFwd` measurable) | `I can see your hips — full tracking` | amber: `I can't see your hips — I won't be able to tell if you slump down. Tilt the camera down a little or sit a bit farther back.` |
  | Angle | always | `Side view · works great` (only for a side view the back can be checked from) / `Side view` / `Front view` / `Angled view` | — |

* Primary `lg` button **Start coaching** (Enter), enabled once *You* has been good for 1 s. If *Hips* is amber, the button stays enabled (any-angle requirement), but a secondary line warns: "Without your hips in view, setup needs an AI second opinion to confirm your back — or you can improve the view now." The AI part changes with the AI state (`aiSetupState`): none "connect an AI model for one", turned off "turn your AI model back on", needs setup (a switched-on connection without its key, model or server address) "finish setting up your AI model", available but off for setup "turn your AI model on for setup". From a view that sees the hips but not the back angle, the lead is "From this view I can’t confirm your back angle myself".
* If a valid baseline exists and this is a redo, Step 1 shows the line "Redoing setup replaces your saved posture once the new one is confirmed."

### 7.3 Step 2: Posture (the coach)

**The rule: setup never passes what it cannot check.** The AI keeps coaching until every
*essential* check is verified good. Essentials are `inView`, `trunkUpright`,
`headOverShoulders`, plus any check the detection contract (§11) marks essential for the
current view (e.g. a slump/recline check).

* **Eyebrow**: `STEP 2 OF 3`.
* **Primary instruction** (`h1` 32/38, max 3 lines, `text`): from `primaryCopy()`. It crossfades 200 ms on change and only changes after the new instruction has held for 0.6 s (no flicker). Attribution line (`caption text-faint`): `Suggested by on-device AI` or `Suggested by <model>`.
* **Strict language rules** (the copy must follow these):
  * Never say "good enough", "close enough", "fine" or "looks OK" while any essential is not verified.
  * Name the body part and the direction: "Sit back", "Bring your head back", "Sit up — you're sliding down in the chair."
  * When the user is reclined or slumped, say so plainly: `You're sliding down in your chair — scoot your hips back and sit up tall.`
  * When good: `That's it — hold still.` Only then.
* **Checklist** (36 px rows, `body-lg`): the icon (20 px), the label, and right-aligned short status text (`caption`):

  | Status | Icon | Status text | Blocks auto-save |
  |---|---|---|---|
  | good | sage circle + `check` | — | no |
  | adjust | amber half-circle | short hint, e.g. `sit back` | **yes** |
  | unknown, essential (`unverified` list) | amber outlined `!` | `can't check yet` | **yes** (§7.4) |
  | unknown, not essential | faint `–` | `not visible from here` | no |

  Rows change with a 150 ms crossfade, and a row that turns good does a single 300 ms sage pulse.
* **Essentials counter** (`caption text-dim`, Plex Mono numbers): `Essentials checked: 3 of 4`.
* **Progress** (bottom of the panel, 56 px ring + label):
  * holding: sage ring fills over the hold time, `Hold it…`
  * capturing: `Capturing your posture…`
  * reviewing: an indeterminate shimmer ring, `Asking <label> for a second opinion…`
  * break: the ring drains amber over 300 ms, and the label becomes the new instruction.
* **Failure states** (`unstable`, `lost`): the instruction becomes the fail message with the sub "No problem — setup picks up again by itself." There is still no Retry button.
* **Save anyway**: a ghost `md` button after 20 s of coaching, labeled **`Save this posture anyway — unverified`**, with the sub "SitSense couldn't confirm it. Your score will be marked unverified until you redo setup." It is never shown as primary and never shown before 20 s.

### 7.4 Unverifiable from this angle: what happens

An essential check is `unknown` (e.g. hips out of view, so a slump can't be ruled out).

1. **Auto-save is blocked.** `holding` does not start while `unverified.length > 0`, unless an AI reviewer is available for setup. The instruction becomes, in this order:
   * `I can't see your hips from here, so I can't check whether you're slumped. Tilt the camera down a little or sit a bit farther back.` (hips out of view)
   * Camera fixes by `setup.viewFix` (detection's reason): `front` "I can't judge your back angle from straight in front." / "Turn the camera to your side — side-on works best — or let an AI model check it." · `profile` (angled or not-quite-side) "I can't judge your back angle from this angle yet." / "Turn the camera further to your side — about 90°, squarely side-on — or let an AI model check it." · `level` (the hip line says the camera is rolled) "Your camera looks tilted." / "So I can't confirm your back angle. Straighten the camera so it sits level — or let an AI model check it." Posture fixes (`lean`: sit back and look ahead; `head`: the head a little past the limit) keep the session's own instruction.
   * the generic form: `I can't check your {what} from this angle. Show me a bit more of you.`
2. **With an AI reviewer** (`aiReviewsSetup` true): once every *measurable* check is good and held, setup asks the model. The image plus the measurements go out, and the request marks the unverified checks as *must judge*. Only an AI `good` verdict saves, and the result is `verified: true`, attributed to the model. AI `adjust`: its first instruction becomes the primary (attributed), and coaching continues. After 2 rejections, auto-capture stops until the user changes something (the existing `autoCapture: false`), and the copy is `<model> still sees a problem: {instruction}`.
3. **AI unreachable**: the note `Couldn't reach <label> — I still can't check your {what}.` The flow stays blocked (it does **not** fall back to passing). Only *Save anyway* remains, after 20 s.
4. **Without AI**: the panel adds a hint card (e2, compact): `Want a second opinion? Connect an AI model and it can check what the camera can't.` with the ghost `Open AI settings`, which opens Settings › AI models *inside* the flow as a modal sheet (720×560, e3, its own close), so setup isn't lost.
5. **Forced save** stores `verified: false`. The consequences are visible everywhere: the `Unverified baseline` chip on Live (§3.4), the banner (§3.7), and `Not verified` in Settings › General.

### 7.5 AI double-check presentation

The reviewing card replaces the progress area. It is e2, full panel width:

* Header: the `spark` icon + `Second opinion` + `<label> · <model>` (`caption text-faint`).
* Pending: a shimmer bar (1.4 s loop) + `Looking at your posture…` (after 8 s: `Still looking — some models take a moment.`), and a ghost `Skip` button that cancels. When essentials are unverified, Skip means *not saved*: it returns to coaching with the copy from §7.4.3.
* Result `good`: `Looks good` (sage chip), its summary in quotes, then the flow proceeds to Saved after 1.2 s.
* Result `adjust`: `Adjust` (amber chip), its summary, and the numbered instructions. The first becomes the primary instruction. The card stays visible under the checklist until the next review.

### 7.6 Step 3: Saved

* The Spine Glyph draws in (stroke-dash, 600 ms) at 120 px, sage, then breathes.
* Headline `h1`: **This is your good posture.**
* The readout (`value 15 text-dim`), from `baselineReadout()`, e.g. `Neck 9° · Trunk upright · Shoulders level — seen from the side`.
* **Verification badge** (chip): `Verified by on-device AI` (sage) / `Verified by on-device AI and Gemini` (sage; the on-device judge verified the capture and the model confirmed it) / `Verified by Gemini` (sage; the model judged what the on-device judge could not — `reviewResult.covered`) / `Not verified — saved anyway` (amber).
* The AI's summary in quotes with the model name, when one ran.
* Buttons: the primary `lg` **Start monitoring** (closes setup → Live) and the ghost `Redo setup` (back to Step 1).
* Footnote `caption text-faint`: `Only these numbers are stored, on this device.`
* Save error: the headline `Couldn't save your posture.`, the sub `Redo setup to try again.`, and the primary `Redo setup`.

---

## 8. Polish rules

### 8.1 Interaction states (all interactive elements)

| State | Treatment |
|---|---|
| hover | background `+white/4` (on card) or `card-2` (on ink); text dim → text; 150 ms color transition |
| active (pressed) | `scale-[0.98]` 80 ms (buttons only, motion-safe); primary button `brightness-95` |
| focus-visible | `ring-2 ring-sage/70 ring-offset-2 ring-offset-<surface beneath>` (offset color matches the parent: ink, surface or card) |
| disabled | 40 % opacity, `cursor-not-allowed`, no hover change, a tooltip saying why when it isn't obvious |
| selected | `bg-sage-soft text-sage` (segments, chips, nav), or a sage ring (option cards) |
| loading | the button keeps its width, its label becomes a 14 px spinner + the label in `-ing` form ("Testing…"), and it is disabled |

Every icon-only control has an `aria-label` and a tooltip (e3, `caption`, 300 ms delay,
120 ms fade, max width 260, placed above by default and flipped when it would clip).

### 8.2 Motion (all behind `motion-safe:`; instant under reduced motion)

| What | Duration / easing |
|---|---|
| color, background, border | 150 ms ease-out |
| tooltips, popovers, menus | 120 ms fade + 4 px slide |
| screen change | 180 ms fade + 4 px rise |
| setup enter / exit | 220 ms fade + scale 0.98 ↔ 1 |
| score ring arc | 400 ms ease-out |
| gauge marker | 250 ms ease-out |
| Spine Glyph morph | 300 ms ease-out (unchanged) |
| list rows in/out (chat, issues) | 150 ms fade + 6 px rise |
| thinking dots | 1.2 s loop, staggered 150 ms |
| breathing glow | 6 s (unchanged) |

Nothing bounces, and nothing loops forever except the breathing glow, the monitoring dot
pulse (2 s, opacity 0.6 → 1), the thinking dots, the shimmer, and the mesh sweep.

### 8.3 Number formatting (`lib/format.ts`, single source)

| Kind | Rule | Examples |
|---|---|---|
| Duration ≥ 1 h | `{h}h {mm}m` | `4h 06m` |
| Duration < 1 h | `{m} min` | `38 min` |
| Duration < 1 min | `{s}s` live counters; `<1 min` in totals | `42s`, `<1 min` |
| Countdown | `m:ss` | `12:41` |
| Percent | integer + `%`, no space | `82%` |
| Score | integer, no unit (the `/100` is a separate caption) | `86` |
| Angles | integer, sign only for deviations, U+2212 minus | `+4°`, `−3°` |
| Distance | integer `cm` with space | `5 cm closer` |
| Clock | `Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })` (24 h for de-DE) | `14:20` |
| Dates | `Intl` weekday short + day + month short | `Mon 5 Oct` |
| Relative | `just now`, `2 min ago`, `3 h ago`, `yesterday`, `2 days ago` | |
| Counts | `Intl.NumberFormat` | `1,204` / `1.204` |

Every number uses Plex Mono `tabular-nums`, except big `h2`/`score` numbers (Bricolage, with
`tabular-nums` set). Never show `NaN`, `null`, `undefined` or negative durations: use `—`.

### 8.4 Layout hygiene

* Align to the 12-col grid. Card edges in the same row share their top and bottom.
* No text line wider than 72 characters (`max-w-[68ch]` on paragraphs).
* No full-width rows whose only content is a tiny right-aligned control: group them in cards.
* Use icons and labels consistently: the same icon always means the same thing (§8.7).
* No horizontal scroll at any size ≥ 780×580. Verify Live, Coach, History (both views), every Settings category and every setup step at **1200×800, 1000×700 and 780×580**.

### 8.5 Loading

* App boot: a centered 48 px breathing glyph + `Starting SitSense…` (replaces "Starting…").
* Camera starting: a skeleton shimmer over the camera frame (`white/[0.03]` → `white/[0.06]`, 1.4 s) + the chip `Starting the camera…`.
* History loading: skeleton blocks shaped like the KPI tiles and charts (no spinners for layouts).
* Buttons: an inline spinner (§8.1).

### 8.6 Empty and error states (one component: `EmptyState`)

`EmptyState { icon (48 px line icon in a 72 px card-2 circle), headline (h3), body (body-lg
text-dim, ≤ 2 lines), primary?, secondary? }`, centered in its container with 24 px gaps.
Errors state the fact and the fix, without apologies. The v2 camera/permission/in-use copy
is kept (ui.md §7).

### 8.7 Icon set

One file, `components/icons.tsx`, exports `Icon({ name, size = 20, className })`. Inline SVG
on a 20×20 viewBox, `stroke="currentColor"`, stroke width 1.6 (1.4 at 16 px), round caps and
joins, no fills except where noted. **The complete list:**

| name | Drawing | Used for |
|---|---|---|
| `live` | a circle with a heartbeat line through it | Live nav |
| `coach` | a speech bubble with a small 4-point spark inside | Coach nav |
| `history` | 3 vertical bars of different heights on a baseline | History nav |
| `settings` | a gear (6 teeth) | Settings nav, category General |
| `setup` | a seated figure: head circle, upright back against a backrest line | Redo posture setup, setup header |
| `spine` | the 3-capsule spine glyph (filled) | brand, Posture detection category |
| `camera` | a camera body + lens | Camera category, Check my posture |
| `lines` | a polyline with 3 joint dots + a dashed vertical | overlay Lines |
| `mesh` | a triangle lattice in a rounded silhouette | overlay Mesh |
| `eye` / `eye-off` | an eye / an eye with a slash | show/hide preview, overlay Off |
| `pause` / `play` / `stop` | two bars / a triangle / a rounded square | monitoring, Stop reply |
| `bell` | a bell | Notifications category |
| `coffee` | a cup with steam | breaks, Sitting card |
| `spark` | a 4-point star (filled) | AI, Coach avatar |
| `send` | a paper plane | chat send |
| `shield` | a shield outline | privacy badge, Privacy category |
| `lock` | a padlock | "nothing leaves this PC" |
| `info` | a circle + i | About, tooltips |
| `check` / `close` / `plus` / `minus` | — | status, dismiss, add |
| `alert` | a triangle + ! | warnings, unverified |
| `chevron-left` / `chevron-right` / `chevron-down` | — | date nav, links, menus |
| `arrow-down` | — | "New message" pill |
| `trash` | a bin | Clear chat, delete data |
| `copy` | two overlapping rects | copy a message |
| `refresh` | a circular arrow | Retry, Redo setup (secondary use) |
| `calendar` | — | date picker |
| `more` | three horizontal dots | overflow menus |
| `cpu` | a chip | Processing |
| `keyboard` | — | shortcuts |

The old dot-grid "Dashboard" icon is retired.

---

## 9. Component inventory (new and changed)

| Component / module | Notes |
|---|---|
| `components/Sidebar.tsx` | nav, badges, MonitoringPill, PrivacyBadge; collapses below 1000 px (`useWindowWidth`) |
| `components/TopBar.tsx` | page title, actions slot, window controls |
| `components/icons.tsx` | §8.7 |
| `components/ScoreRing.tsx` | `value: number \| null`, `size`, band color |
| `components/MetricGauge.tsx` | `label, value, unit, range, ticks, stage, unavailableReason` |
| `components/OverlaySwitcher.tsx` | shared by the camera hero and Settings |
| `components/Timeline.tsx` | from the v2 Today strip; `height`, `hourTicks`, `labels` |
| `components/HeatStrip.tsx` / `HeatGrid.tsx` | History |
| `components/StackedBar.tsx` | By issue, Days chart |
| `components/KpiTile.tsx` | eyebrow, value, sub, tone |
| `components/NotificationMock.tsx` | Settings preview |
| `components/EmptyState.tsx`, `Banner.tsx`, `Tooltip.tsx`, `Popover.tsx` | shared |
| `screens/Live.tsx` | replaces `Dashboard.tsx` |
| `screens/Coach.tsx` + `coach/markdown.ts`, `coach/useCoach.ts`, `coach/context.ts` | §4 |
| `screens/History.tsx` + `lib/history.ts` | §5 |
| `screens/settings/SettingsScreen.tsx` + one file per category | §6 |
| `screens/setup/SetupFlow.tsx` (+ `StepCamera`, `StepPosture`, `StepSaved`, `Stepper`) | replaces `PostureSetup.tsx`; keeps `setupCopy.ts` (extended) |
| `lib/score.ts`, `lib/format.ts` | pure, unit-tested |
| main: `stats.ts` (alerts, range, clear), `notifications.ts` (break toast), `ai/chat.ts` (aiChat), `coach-history.ts`, `window.ts` (1200×800), `tray.ts` (rename item) | §4.7, §5.4, §6.2 |
| shared: `settings.ts` (`overlay.meshIntensity`, `overlay.meshBackdrop`, `breaks`, `ai.useInCoach`, `ai.coachContext`, hologram migration), `ipc.ts` (routes, new channels) | |

New settings defaults:

```ts
overlay: { …, meshIntensity: 0.45, meshBackdrop: 'camera' }
breaks: { enabled: true, everyMinutes: 50, lengthMinutes: 3 }   // 30–90 step 5; 1–10
ai: { …, useInCoach: true, coachContext: { live: true, today: true, baseline: true } }
```

`mergeSettings` clamps each new number, falls back on bad enums, and migrates `'hologram'` →
`'mesh'` + `'dim'`.

---

## 10. Copy (English; plain, friendly, concrete)

### 10.1 Shell

* Nav: `Live` · `Coach` · `History` · `Settings`. Coach badge: `AI`.
* Monitoring pill: `Monitoring` · `Paused · {m:ss}` · `Paused` · `Camera unavailable` · `Not set up` · `Nudges off · new camera`. Buttons: `Pause` (tooltip "Pause monitoring") · `Resume` · pause menu `15 minutes` / `30 minutes` / `60 minutes` / `Until I resume`.
* Privacy badge: `On-device` · `On-device · AI: {label}`.
* Boot: `Starting SitSense…`.
* Tray menu item: `Redo posture setup` (was `Recalibrate`).

### 10.2 Live

* Top bar: `Redo posture setup` · `Set up posture`.
* Tracking chip: `Looking for you…` · `Seeing head, shoulders & hips` · `Seeing head & shoulders` · `View changed` (tooltips in §3.2.1).
* Overlay switcher: `Lines` · `Mesh` · `Off`. Hide button: `Hide preview (monitoring continues)`. Hidden panel: `Preview hidden — SitSense is still watching.` / `Show preview`.
* Posture card: `POSTURE`; info tooltip `Score 0–100 from how far you are from your saved good posture right now.`; `/100`; `{n} min aligned`; `for {duration}`; chip `Unverified baseline`.
* Gauges: `Head position` · `Back angle` · `Sitting height` · `Side lean` · `Screen distance`; values `+{n}° forward` · `{n}° back` · `level with baseline` · `{n}° forward` · `{n}° reclined` · `level` · `{n} cm lower` · `{n} cm higher` · `same` · `{n}° to your left` · `{n}° to your right` · `centered` · `{n} cm closer` · `{n} cm farther` · `can't see from here` · `off`; link `Turn on`; tick caption `your setup`.
* Gauge placeholders: `Paused — gauges resume with monitoring.` · `Waiting for you to sit in view.` · `Set up your posture to see live measurements.`
* Today: `TODAY` · `aligned` · `{d} good · {d} off` · `Best stretch {d} · {n} nudges` (`1 nudge`) · `History →` · empty: `Your day fills in here once SitSense has watched you sit for a minute.`
* Sitting: `SITTING` · `in your chair` · `Next break in {n} min` · `Break due now — stand up for {L} minutes` · `On a break · {n} min` · `Breaks are off` · `Turn on` · `{n} breaks today` (`1 break today`, `No breaks yet today`).
* Coach card: `COACH` · `Open →` · `Ask anything about your posture, your desk or a stretch.` · placeholder `Ask your coach…` · `Check my posture now` · no-AI: `Your coach can answer questions about your posture once you connect an AI model.` / `Connect a model` · AI off: `Your AI model is turned off.` / `Turn on`.
* Banners: `This posture was set up with a different camera.` [`Redo posture setup`] [`Keep it for this camera`] · `Your view changed a lot since setup — readings may be off.` [`Redo posture setup`] [`Dismiss`] · `Your saved posture isn't verified — SitSense couldn't check your {what} from this angle.` [`Redo posture setup`] [`Connect an AI model for a second opinion`].

### 10.3 Notifications (new)

Break toast pool (shuffle bag, as with the posture toasts):

| Title | Body |
|---|---|
| Time for a break | You've been sitting for {n} min. Stand up and walk around for a few minutes. |
| Stretch your legs | {n} min in the chair — a short walk resets your back. |
| Give your back a rest | Stand, roll your shoulders and look out a window for a minute. |
| Break time | Fill your water glass — it's a good excuse to stand up. |
| You've earned a pause | {n} min of sitting. Two minutes on your feet helps more than you'd think. |

Second reminder (15 min later): **Still sitting** — `It's been {n} min. Even one minute standing helps.`
Action button: `Snooze 15 min`.

### 10.4 Coach

* Title `Coach`; sub `{label} · {model}`; `Clear chat`; confirm `Clear the whole conversation? This can't be undone.` [`Clear`] [`Cancel`]; system notes `Conversation cleared` · `Stopped` · `Measurements updated` · `Today` · `Yesterday`.
* Greeting: `Hi! I can see your live posture numbers and today's stats. Ask me anything — or press Check my posture now.`
* Composer: `Ask about your posture, desk or a stretch…` · `Send` · `Stop` · `Enter to send · Shift+Enter for a new line` · `Check my posture now` · user chip `Checked my posture`.
* Suggested prompts pool: `How's my posture right now?` · `What went worst today?` · `Why does my neck get tired in the afternoon?` · `Give me a 2-minute stretch for my upper back` · `How high should my screen be?` · `Is my chair set up right?` · `How often should I take breaks?` · `What does "head forward" actually mean?`
* Context panel: `WHAT YOUR COACH SEES` · `Live measurements` · `Today's stats` · `Your saved posture` · `PRIVACY` · `Messages and the checked items go to {provider phrase}. No camera image unless you check your posture.` · `Your chat history stays on this PC.`
* Posture check card: `Looks good` · `Adjust` · `Checked by {label} · {model}` · `Pose sketch sent` · `Camera snapshot sent`.
* States: `Your coach needs an AI model` / `Connect your own AI model — Gemini, OpenAI, Anthropic, OpenRouter, or a local one like Ollama. On-device posture tracking keeps working without it.` / `Connect a model` / `How privacy works` · `Your AI model is turned off` / `Turn on AI` · `Coach chat is turned off` / `Turn on` · `Thinking…` · `Still thinking — local models can take a while.` · `Retry` · `Open AI settings` · `You're offline. Messages will work again once you're connected — local models like Ollama still work.` · `Answered by {fallback} — {primary} didn't respond.` · `Sit in view of the camera first — SitSense needs to see you.` · `Resume monitoring to check your posture.` · `New message`.

### 10.5 Settings

* Categories (title — description): `General` — `Startup, window and posture setup` · `Camera & preview` — `Camera, overlay style and colors` · `Posture detection` — `Sensitivity and speed` · `Notifications & breaks` — `Nudges, sounds and break reminders` · `AI models` — `Connect your own model` · `Privacy & data` — `What stays on this PC` · `About` — `Version, updates and credits`.
* Category intros: General `How SitSense starts and runs.` · Camera `Which camera SitSense uses and how the preview looks.` · Detection `How strict SitSense is, per issue.` · Notifications `When and how SitSense nudges you.` · AI `Connect your own model for second opinions and the coach.` · Privacy `What stays on this PC and what can leave it.` · About `SitSense, version {v}.`
* Style descriptions: Lines `What the AI measures: ear, shoulder and hip joined by a line, next to true vertical.` · Mesh `A light wireframe over your whole body. You stay clearly visible.` · Off `Just the camera image.` · `Mesh strength` · `Dim camera behind mesh`.
* Issue footers: Slouching `Watches your back angle and how far you sink.` · Head forward `Watches how far your head drifts ahead of your shoulders.` · Leaning `Watches side lean and tilted shoulders.` · Too close `Watches how close you get to the screen.` · disabled `Not watched.`
* Processing: `Run the model on` · `Auto` · `Graphics card` · `Processor` · `In use: {GPU|CPU}`.
* Posture setup card: `Your good posture` · `Set up {relative} · {view} · Verified by on-device AI` / `… and {label}` / `Not verified` / `Not set up yet` · `Redo it after moving your camera, desk or chair.`
* Breaks: `Remind me to take breaks` · `Remind me every` · `A break counts after` · `SitSense notices when you leave your desk — walking away for {L} minutes counts as a break. No need to tell it.`
* Notification preview: `Preview` · `Send a test notification`.
* AI: `Pose sketch` / `Lines and dots only — no camera image.` · `Camera snapshot` / `A small, downscaled frame from your camera.` · `Double-check posture setup` · `Coach chat` · `Never runs in the background. While paused, only coach questions are answered — nothing from the camera is sent.` · status `Off — SitSense sends nothing to an AI model.` / `On · Primary: {label} ({model})` (+ ` · {n} fallback(s)`) / `On, but no connection works yet` · `+ Add connection`.
* Privacy: `STAYS ON THIS PC` items (§6.2) · `CAN LEAVE THIS PC` · `Only an update check.` / `Nothing.` (see §6.2) · `Only when you ask the coach, check your posture or run setup: {disclosure}` · `Change in AI models` · data rows `Posture history` / `Delete history` · `Coach chat` / `Clear chat` · `Your saved posture` / `Delete and redo setup` · `AI keys` / `{n} keys, encrypted with Windows` · `Reset all settings` / `Puts every setting back to its default. Your history and AI keys stay.` · confirms: `Delete all posture history? This can't be undone.` · `Delete your saved posture and start setup?` · `Reset every setting to its default?`
* About: `Posture coaching that runs on your PC.` · `Updates` card copy (§6.2) · `Check automatically` / `Asks GitHub for the latest version — no posture data is sent.` (portable) / `Asks GitHub for the latest version and downloads new versions in the background — no posture data is sent.` (installed) · `Keyboard shortcuts` · credits (§6.2).
* Sidebar footer (§2.3): `v0.2.0` (caption, text-faint, right of the privacy badge → Settings › About; an amber 6 px dot while a newer version is available) · while an update is ready, above the monitoring pill: `Update ready` + `Restart` (sage-soft, 36 px, refresh icon; tooltip "SitSense 0.3.0 is downloaded. Restart to install it — takes a few seconds."; compact rail: a 40 px refresh icon button with a sage dot).

### 10.6 Setup

* Header: `Posture setup` · steps `Camera` / `Posture` / `Saved` · `Exit setup` · leave confirm `Leave setup? Your posture hasn't been saved yet.` [`Leave`] [`Keep going`].
* Step 1: `Let's check your camera.` · `Sit where you normally work. Any camera angle is fine — your head and at least one shoulder need to be in the picture.` · rows (§7.2) · `Start coaching` · warning `Without your hips in view, setup needs an AI second opinion to confirm your back — or you can improve the view now.` (no AI: `… — connect an AI model in Settings for one, or improve the view now.`) · redo line `Redoing setup replaces your saved posture once the new one is confirmed.`
* Step 2: `STEP 2 OF 3` · `Suggested by on-device AI` · `Suggested by {model}` · `Essentials checked: {n} of {m}` · status texts `can't check yet` / `not visible from here` · `Hold it…` · `Capturing your posture…` · `Asking {label} for a second opinion…` · `That's it — hold still.` · slump: `You're sliding down in your chair — scoot your hips back and sit up tall.` · unverified: `I can't see your hips from here, so I can't check whether you're slumped. Tilt the camera down a little or sit a bit farther back.` / `I can't check your {what} from this angle. Show me a bit more of you.` · AI hint card `Want a second opinion? Connect an AI model and it can check what the camera can't.` / `Your AI model is turned off. Turn it on…` / `Your AI model needs a key or a model — finish it in AI settings and it can check what the camera can’t.` / `Open AI settings` · unreachable `Couldn't reach {label} — I still can't check your {what}.` · rejected `REVIEW_MAX_AUTO` (3) times `{model} still sees a problem: {instruction}` · `Save this posture anyway — unverified` / `SitSense couldn't confirm it. Your score will be marked unverified until you redo setup.`
* Review card: `Second opinion` · `Looking at your posture…` · `Still looking — some models take a moment.` · `Skip` · `Looks good` · `Adjust`.
* Step 3: `This is your good posture.` · badges `Verified by on-device AI` / `Verified by on-device AI and {label}` / `Not verified — saved anyway` · `Start monitoring` · `Redo setup` · `Only these numbers are stored, on this device.` · `Couldn't save your posture.` / `Redo setup to try again.`

---

## 11. Contract this UI needs from detection and AI (owned by `detection.md` / `ai-providers.md`)

The UI renders whatever these modules report. It must not add its own posture judgments.
The user-facing promise, "setup keeps coaching until it is *really* a good position; lying in
the chair must never pass", needs the following:

1. **Slump/recline must be an `adjust`, not a pass.** A user sliding down in the chair (pelvis forward, trunk reclined, head pushed forward to keep the eyes on the screen) must fail at least one essential check from every view where it is measurable. The exact thresholds belong to detection.md. The UI expects either a tighter `trunkUpright` recline limit or a dedicated essential check (any new `CheckId` with a label in `CHECK_LABELS` renders automatically), and the instruction copy from §10.6 (`You're sliding down in your chair — …`).
2. **`unverified` drives blocking.** `PostureAssessment.unverified` lists every essential the current view cannot measure. `SetupSession` must not enter `holding` while it is non-empty, unless a setup reviewer is available; in that case the review is mandatory and only a `good` verdict saves (`verified: true`). An unreachable reviewer keeps the session blocked. `force()` remains the only way to save unverified.
3. **`AiReviewRequest.measurements`** gains `unverified: CheckId[]`, and the setup prompt tells the model to judge those specifically (slump/recline included) and to answer `adjust` when unsure.
4. **`IssueSnapshot.level?: number`** (continuous severity, §3.4.1). It is optional: the score falls back to `stage`.
5. **`aiChat`** (§4.7) in `main/ai`, using the same connections, fallbacks, validation and key handling as `aiReviewPosture`.

---

## 12. Acceptance checklist (screenshots via the built app, fake camera)

* [ ] Sidebar labeled; Live, Coach, History and Settings are visually distinct at a glance (camera hero, chat, charts, two-pane).
* [ ] At 780×580 the sidebar is a 64 px rail with tooltips, and no screen scrolls horizontally.
* [ ] Default window 1200×800; Live fits without scrolling at that size.
* [ ] Settings: category list + one category; ≥ 2 card columns at 1200 wide; the preview card shows the overlay live; the mesh strength slider changes it.
* [ ] Mesh at the default strength: the person is clearly visible, and no triangle fills except issue hotspots.
* [ ] Coach without AI shows the CTA empty state; with AI it shows the greeting, chips, context panel, composer and Check my posture.
* [ ] History empty state at first run; Day and Week views with fixture data (unit tests cover `lib/history.ts`).
* [ ] Setup opens full-window with a stepper and Exit; Esc exits; with hips out of view and no AI, it never auto-saves, and *Save anyway — unverified* appears only after 20 s.
* [ ] Unverified baseline: the chip on Live, the banner, and `Not verified` in Settings.
* [ ] All motion is off under `prefers-reduced-motion`; every icon button has a label and a tooltip; focus rings are visible on every control.
