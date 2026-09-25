No existing SitSense code is present (the working directory contains only an unrelated folder), so this is a greenfield algorithm spec. The deliverable follows.

---

# SitSense Posture-Detection Algorithm Specification

Target runtime: Electron renderer, MediaPipe Tasks Vision `PoseLandmarker` (33 landmarks, normalized image coordinates), 10–15 fps webcam frames. All timing is wall-clock (`performance.now()`), never frame-count, so behavior is fps-independent.

Coordinate convention: MediaPipe returns normalized `x, y ∈ [0,1]` with **y increasing downward**, plus `z` (depth, unreliable for upper-body-only framing — deliberately NOT used by this spec) and `visibility ∈ [0,1]` per landmark. "Left/right" in landmark names is the person's anatomical side; in an unmirrored webcam frame the person's left appears on the image's right. If the UI mirrors the preview, invert reported lean directions in the UI layer only — the math below is frame-space and needs no change.

---

## 1. Landmarks and landmark groups

Used indices (by MediaPipe Pose name):

| Name | Index |
|---|---|
| nose | 0 |
| left_eye_outer | 3 |
| right_eye_outer | 6 |
| left_ear | 7 |
| right_ear | 8 |
| left_shoulder | 11 |
| right_shoulder | 12 |

Per-landmark usability: landmark `i` is **usable** iff `visibility[i] ≥ V_LM` (`V_LM = 0.5`; during calibration use stricter `V_CAL = 0.6`).

Groups (evaluated every frame):

- **SHOULDERS** available iff landmarks 11 and 12 are both usable.
- **EARS** available iff 7 and 8 are both usable.
- **EYES** available iff 3 and 6 are both usable.
- **HEAD** available iff landmark 0 is usable AND (EARS or EYES available).
- **Frame is GOOD** iff the pose detector returned a pose AND (HEAD or SHOULDERS available). Otherwise the frame is BAD (feeds the Away state machine, section 8).

Primitives (2D Euclidean, on x/y only):

```
sh_mid   = midpoint(P11, P12)          // requires SHOULDERS
ear_mid  = midpoint(P7, P8)            // requires EARS
eye_mid  = midpoint(P3, P6)            // requires EYES
head_mid = ear_mid if EARS else eye_mid  // requires HEAD
s_sh     = dist(P11, P12)              // inter-shoulder distance
s_ear    = dist(P7, P8)                // inter-ear distance
s_eye    = dist(P3, P6)                // outer-eye distance
```

## 2. Scale normalization (camera distance/position robustness)

All length metrics are expressed in **baseline shoulder-width units** so the same thresholds work at any camera distance.

Per frame, the **unified scale** `s(t)`:

```
if SHOULDERS and s_sh0 known:  s = s_sh      // a face-only baseline never switches to shoulder units
elif EARS:     s = s_ear * R_ear          // R_ear = s_sh0 / s_ear0 (from calibration)
elif EYES:     s = s_eye * R_eye          // R_eye = s_sh0 / s_eye0 (from calibration)
else:          s = unavailable (frame likely BAD anyway)
```

Baseline unit:

```
U0 = s_sh0                    if shoulders were visible during calibration
U0 = K_SH_PER_EAR * s_ear0    otherwise (face-only mode), K_SH_PER_EAR = 2.4
```

(2.4 is the typical anthropometric ratio of biacromial width to inter-ear distance; in face-only mode `R_ear` is defined as `K_SH_PER_EAR` and `R_eye` as `K_SH_PER_EAR * (s_ear0 / s_eye0)` — if ears were also absent at calibration, `R_eye = 3.0`.)

**Distance ratio** (also the too-close metric): `D(t) = s_ema(t) / U0`, where `s_ema` is the EMA-smoothed unified scale (section 4). `D > 1` means closer than baseline, `D < 1` farther (scale is approximately inverse-proportional to distance).

## 3. Calibration procedure

Trigger: user clicks "Calibrate", instructed to sit upright at their normal working distance, looking at the screen.

1. Countdown `CAL_COUNTDOWN = 3 s` (UI only).
2. Capture window `CAL_DURATION = 5 s` (~50–75 frames at 10–15 fps).
3. A calibration frame is **valid** iff pose detected AND HEAD available with `V_CAL = 0.6`, using whatever of SHOULDERS/EARS/EYES pass `V_CAL`.
4. Require `CAL_MIN_FRAMES = 30` valid frames, else fail with "couldn't see you clearly — adjust lighting/camera and retry."
5. For every stored quantity, aggregate with the **median** across valid frames (robust to blinks/jitter). Angles (`φ_head0`, `φ_sh0`) use a **circular** median, so a line near ±180° doesn't average to 0°.
   - Frames with the head turned away are rejected: `|nose.x − face_mid.x| / face_width > MAX_CAL_YAW = 0.2` (~15–20°). A yawed face would bake a sideways offset and a narrow face width into the baseline. If most frames are rejected for this, the failure reads "face the camera and retry".
   - A capture interrupted by camera loss fails as `interrupted` instead of timing out.
6. Stability check: coefficient of variation of the unified scale `std(s)/median(s) ≤ CAL_MAX_CV = 0.06`, else fail with "please hold still and retry."

Stored baseline (each a median):

| Symbol | Definition | Needs |
|---|---|---|
| `s_sh0`, `s_ear0`, `s_eye0` | raw scales | whichever groups were visible |
| `U0`, `R_ear`, `R_eye` | per section 2 | derived |
| `y_sh0` | `sh_mid.y` | SHOULDERS |
| `y_hd0` | `head_mid.y` | HEAD |
| `y_hd_eye0`, `h_eye0`, `o_eye0` | the same three with the eye midpoint as head reference | EYES |
| `h0` | `(sh_mid.y − head_mid.y) / s` (head-above-shoulder gap in current-scale units) | both |
| `r0` | `s_face / s_sh` where `s_face = s_ear` (or `s_eye * s_ear0/s_eye0`) | both |
| `p0` | `(P0.y − head_mid.y) / s_face` (nose-below-ears pitch proxy) | HEAD |
| `φ_head0` | `atan2deg(P7.y − P8.y, P7.x − P8.x)` (ear-line angle; eyes 3/6 fallback with its own stored baseline `φ_eye0`) | EARS/EYES |
| `φ_sh0` | `atan2deg(P11.y − P12.y, P11.x − P12.x)` | SHOULDERS |
| `o0` | `(head_mid.x − sh_mid.x) / s` | both |
| `capabilities` | which groups were calibrated (full vs face-only mode) | — |

The head reference is the ear midpoint when ears were calibrated, else the eye midpoint against its own `*_eye0` twins. Mixing them — comparing an eye-based head position to an ear-based baseline — reads as ~1 cm of sink the moment an ear drops out of view.

If SHOULDERS were never valid during calibration, detectors that require them (gap-shrink, face-ratio, shoulder-tilt, lateral-offset, shoulder component of sink) are permanently unavailable until recalibration; the app runs in face-only mode using the fallbacks below.

Calibration must be redone if the user moves the camera; see the recalibration hint in section 8.

## 4. Smoothing and outlier rejection

Applied to **metrics**, not raw landmarks (cheaper, sufficient at 10–15 fps):

1. **Outlier gate (per frame):** if the raw unified scale jumps `|s_raw/s_prev − 1| > OUTLIER_SCALE_JUMP = 0.35` within one frame, discard the whole frame (tracking glitch). Accept unconditionally after `OUTLIER_MAX_CONSEC = 3` consecutive discards (the change is real).
2. **Median-of-3 prefilter:** each raw metric passes through a 3-sample sliding median (kills single-frame spikes).
3. **EMA (fps-adaptive):** `m_ema += α(Δt) * (m_med − m_ema)` with `α(Δt) = 1 − exp(−Δt/τ)`, `Δt` capped at `DT_CAP = 0.5 s`.
   - `τ_metric = 0.6 s` for all posture metrics (at 12 fps this gives α ≈ 0.13).
   - `τ_scale = 1.0 s` for the unified scale feeding `D(t)` (slower, so breathing/micro-motion doesn't flicker the too-close detector).
4. A metric whose required group is unavailable this frame is **held** (EMA not updated); its detector timers pause (section 7). After returning from AWAY, all EMAs and median buffers are **reseeded** from the first good frame (no stale carry-over).

All detection conditions below evaluate the **smoothed** metric values.

## 5. Metrics and per-issue detection conditions

All thresholds listed are **base thresholds at sensitivity σ = 1.0** (section 6 scales them). Stage numbering: 1 = slight, 2 = clear, 3 = severe.

### Issue 1 — Sinking / slouching (vertical drop)

Metric (positive = dropped; remember y grows downward):

```
drop_sh = (sh_mid.y − y_sh0) / U0        // if SHOULDERS
drop_hd = (head_mid.y − y_hd0) / U0      // if HEAD
M_sink  = 0.6*drop_sh + 0.4*drop_hd      // both available
        = drop_sh                        // shoulders only
        = drop_hd                        // head only
```

Distance gate: `M_sink` is only meaningful near the calibrated distance. If `D ∉ [SINK_D_MIN, SINK_D_MAX] = [0.85, 1.18]`, hold the metric and pause this issue's timers (the user rolled the chair — geometry is ambiguous; the too-close detector covers the near case).

Stage thresholds (in `U0` units; `U0` ≈ 38 cm real-world, so ≈ cm shown for intuition):

| Stage | `M_sink ≥` | approx. |
|---|---|---|
| slight | 0.14 | ~5 cm |
| clear | 0.28 | ~11 cm |
| severe | 0.45 | ~17 cm |

### Issue 2 — Head-forward / hunching toward screen

Three sub-metrics; issue severity = **max** stage across the available sub-metrics. All are distance-invariant by construction (normalized by current scale or pure ratios).

```
// (a) Gap shrink — head drops toward shoulders. Needs SHOULDERS + HEAD.
h(t)   = (sh_mid.y − head_mid.y) / s(t)
G      = (h0 − h(t)) / h0                       // fraction of baseline gap lost

// (b) Face-growth — face nears camera while shoulders don't. Needs SHOULDERS + face scale.
r(t)   = s_face(t) / s_sh(t)                    // s_face as in section 3
F      = r(t)/r0 − 1

// (c) Pitch proxy — head tips down. Needs HEAD only (face-only fallback).
p(t)   = (P0.y − head_mid.y) / s_face(t)
Pd     = p(t) − p0
```

| Stage | `G ≥` | `F ≥` | `Pd ≥` |
|---|---|---|---|
| slight | 0.15 | 0.10 | 0.12 |
| clear | 0.28 | 0.18 | 0.25 |
| severe | 0.42 | 0.28 | 0.40 |

When **only** `Pd` is available (face-only mode), the issue's dwell time is multiplied by `PITCH_ONLY_DWELL_MULT = 1.5` — looking down briefly (keyboard, phone, notes) is normal and must not alert.

### Issue 3 — Side lean / head tilt

Three sub-metrics; severity = **max** stage across the available ones. Angle deltas are wrapped to `(−180°, 180°]` before taking absolute value.

```
Δroll = | wrap(atan2deg(P7.y − P8.y, P7.x − P8.x) − φ_head0) |   // ears; eyes 3/6 + φ_eye0 fallback
Δtilt = | wrap(atan2deg(P11.y − P12.y, P11.x − P12.x) − φ_sh0) | // shoulder line
ΔL    = | (head_mid.x − sh_mid.x)/s(t) − o0 |                    // lateral head offset, needs both
```

| Stage | `Δroll ≥` | `Δtilt ≥` | `ΔL ≥` |
|---|---|---|---|
| slight | 8° | 6° | 0.18 |
| clear | 15° | 12° | 0.32 |
| severe | 25° | 20° | 0.50 |

Reported direction = sign of the dominant sub-metric's signed value (positive `ΔL` raw sign means head moved toward +x in the image, i.e. toward the person's anatomical left in an unmirrored frame).

### Issue 4 — Too close to screen

```
M_close = D(t) = s_ema(t) / U0
```

| Stage | `M_close ≥` | meaning |
|---|---|---|
| slight | 1.12 | ~11% closer than baseline |
| clear | 1.25 | ~20% closer |
| severe | 1.40 | ~29% closer |

Works in face-only mode automatically (unified scale falls back to ear/eye distance).

## 6. Stages, toggles, sensitivity, hysteresis

- Each issue has an enable toggle; each of its 3 stages has an individual enable toggle. Let `E ⊆ {1,2,3}` be the enabled stages (issue effectively off if `E = ∅`).
- **Sensitivity slider** per issue: `σ ∈ [0.50, 2.00]`, default `1.00`, step `0.05`. Effective trigger thresholds:
  - Length/ratio/angle metrics: `thr_eff(k) = thr_base(k) / σ`.
  - Too close (scale the excess over 1): `thr_eff(k) = 1 + (thr_base(k) − 1) / σ`.
- **Current severity** `sev(t)` = highest stage `k ∈ E` with smoothed metric `≥ thr_eff(k)`, else 0. For multi-sub-metric issues, `sev(t)` = max over available sub-metrics of their individual stage evaluation.
- **Hysteresis** factor `HYST = 0.75`. Recovery thresholds: `rec_eff(k) = HYST * thr_eff(k)` (too close: `rec_eff(k) = 1 + HYST*(thr_eff(k) − 1)`). Let `kmin = min(E)`. The issue counts as **recovered** when every contributing sub-metric is `< rec_eff(kmin)`.

## 7. Per-issue episode state machine

States: `DISABLED, IDLE, PENDING, ALERTED, RECOVERING, COOLDOWN`. One machine instance per issue. All timers pause whenever the global presence state is not `ACTIVE` (section 8) or the issue's required data is on hold (visibility loss / sink distance gate).

Per-issue timing defaults:

| Constant | sink | head-forward | lean/tilt | too close |
|---|---|---|---|---|
| `DWELL` (s) | 12 | 12 | 15 | 8 |
| `COOLDOWN_S` (s) | 120 | 120 | 120 | 120 |

Shared timing constants: `BAND_HOLD_MAX = 5 s`, `DATA_LOSS_RESET = 10 s`, `ESC_DWELL = 4 s`, `ESC_MIN_GAP = 30 s`, `REC_DWELL = 5 s`, `REMINDER_INTERVAL = 300 s` (reminder feature default **off**).

Transitions:

- `IDLE → PENDING`: `sev(t) ≥ 1`. Start dwell accumulator at 0.
- `PENDING` dwell accumulation: accumulate `Δt` while `sev(t) ≥ 1`. If the metric falls into the hysteresis band (`< thr_eff(kmin)` but `≥ rec_eff(kmin)`), **hold** the accumulator (no accumulation, no reset); if the continuous band-hold exceeds `BAND_HOLD_MAX = 5 s`, or the metric recovers (`< rec_eff(kmin)`), → `IDLE`.
- `PENDING → ALERTED`: accumulator `≥ DWELL` (× `PITCH_ONLY_DWELL_MULT` if applicable) AND no active cooldown for this issue. **Fire alert** with `stage = sev(t)` at that instant; set `alerted_stage = sev(t)`, `last_alert_time = now`. (If a cooldown is still running, stay in `PENDING` with the accumulator saturated and fire the moment the cooldown expires, provided `sev(t) ≥ 1` still holds.)
- `ALERTED` (episode ongoing):
  - **Escalation**: if `sev(t) > alerted_stage` continuously for `ESC_DWELL = 4 s` AND `now − last_alert_time ≥ ESC_MIN_GAP = 30 s` → fire escalation alert with the new stage; `alerted_stage = sev(t)`, `last_alert_time = now`. (De-escalation never fires alerts; `alerted_stage` only ratchets up within an episode.)
  - **Reminder** (optional, default off): if still `ALERTED` and `now − last_alert_time ≥ REMINDER_INTERVAL = 300 s` → fire reminder at current stage, update `last_alert_time`.
  - Recovery detected (`sev` using `rec_eff` = 0, per section 6) → `RECOVERING`, start recovery timer.
- `RECOVERING → ALERTED`: any sub-metric `≥ thr_eff(kmin)` before the timer ends (posture relapsed; same episode, no new alert).
- `RECOVERING → COOLDOWN`: recovery sustained `REC_DWELL = 5 s`. Episode ends. (Optional "nice, you recovered" toast — default off.)
- `COOLDOWN → IDLE`: after `COOLDOWN_S = 120 s`. Cooldown only gates alert **emission**; detection continues underneath as described in `PENDING`.
- `DATA_LOSS_RESET`: if a detector's required landmark groups stay unavailable for `> 10 s` (while globally ACTIVE), reset that issue `PENDING/ALERTED/RECOVERING → IDLE` silently (cooldown timers keep running). An episode that had already alerted starts a cooldown on the way out, so a flicker of lost landmarks can't re-fire the same toast.
- **Worse during cooldown** (with escalation on): a new episode whose stage exceeds the stage the cooldown was started at fires at once as an `escalation`, instead of waiting out the quiet period. A cooldown after a slight nudge must not swallow a severe one.
- Disabling an issue or entering calibration → `DISABLED` (silent), re-enable → `IDLE`.

Alert payload: `{ issue, stage, kind: initial | escalation | reminder, metricValue, direction? }`.

## 8. Global presence state machine (away / low visibility)

States: `ACTIVE, AWAY`. Input: per-frame GOOD/BAD classification (section 1).

- `ACTIVE → AWAY`: frames continuously BAD for `AWAY_ENTER = 2.0 s`. (Shorter BAD bursts — occlusion by a coffee mug, lighting flicker — merely pause timers via the hold mechanism; they never reset anything.)
- While `AWAY`: no alerts of any kind; all per-issue timers frozen; record `away_start`.
- `AWAY → ACTIVE`: frames continuously GOOD for `AWAY_EXIT = 1.5 s`. On re-entry:
  - Reseed all EMAs and median buffers from current values.
  - If away duration `≤ AWAY_FULL_RESET = 30 s`: resume all issue machines exactly where they froze.
  - If away duration `> 30 s`: reset every issue machine to `IDLE` and clear cooldowns (the user stood up — the break itself fixed the posture; a fresh episode must earn a fresh dwell).
- **Recalibration hint** (camera likely moved): if `D` stays outside `[RECAL_D_MIN, RECAL_D_MAX] = [0.5, 1.8]` continuously for `RECAL_SUGGEST_S = 10 s` while ACTIVE, show a one-shot-per-session non-alert notification suggesting recalibration, and suspend all detectors except this hint until `D` returns in range or the user recalibrates. `D` back in range for another `RECAL_SUGGEST_S` clears the hint.
- **Frame gaps.** If no frame at all arrives for longer than `AWAY_ENTER` (hidden-window stall, sleep, pause), the smoothing state is reseeded as on re-entry; a gap longer than `AWAY_FULL_RESET` also resets every issue machine. Timers never integrate across a gap they didn't observe.

## 9. Per-frame pipeline (order of operations)

```
onFrame(result, tNow):
  Δt = min(tNow − tPrev, DT_CAP)
  1. classify GOOD/BAD → feed presence FSM; if not ACTIVE → return
  2. compute groups, primitives, unified scale; outlier gate on scale
  3. compute available raw metrics (sections 5.1–5.4)
  4. median-of-3 → EMA (τ_metric; τ_scale for D)
  5. apply sink distance gate; mark held metrics
  6. for each enabled issue: evaluate sev(t) with thr_eff/rec_eff → step its FSM with Δt
  7. emit any fired alerts to the notification layer
```

## 10. Complete constants table (defaults)

| Constant | Value | Constant | Value |
|---|---|---|---|
| `V_LM` | 0.5 | `DWELL` sink/fwd/lean/close | 12 / 12 / 15 / 8 s |
| `V_CAL` | 0.6 | `PITCH_ONLY_DWELL_MULT` | 1.5 |
| `K_SH_PER_EAR` | 2.4 | `BAND_HOLD_MAX` | 5 s |
| `CAL_COUNTDOWN` | 3 s | `DATA_LOSS_RESET` | 10 s |
| `CAL_DURATION` | 5 s | `ESC_DWELL` | 4 s |
| `CAL_MIN_FRAMES` | 30 | `ESC_MIN_GAP` | 30 s |
| `CAL_MAX_CV` | 0.06 | `REC_DWELL` | 5 s |
| `τ_metric` | 0.6 s | `COOLDOWN_S` (all issues) | 120 s |
| `τ_scale` | 1.0 s | `REMINDER_INTERVAL` (off) | 300 s |
| `DT_CAP` | 0.5 s | `AWAY_ENTER` | 2.0 s |
| median window | 3 | `AWAY_EXIT` | 1.5 s |
| `OUTLIER_SCALE_JUMP` | 0.35 | `AWAY_FULL_RESET` | 30 s |
| `OUTLIER_MAX_CONSEC` | 3 | `RECAL_D_MIN/MAX` | 0.5 / 1.8 |
| `SINK_D_MIN/MAX` | 0.85 / 1.18 | `RECAL_SUGGEST_S` | 10 s |
| `σ` range/default/step | 0.5–2.0 / 1.0 / 0.05 | `HYST` | 0.75 |
| Sink stages | 0.14 / 0.28 / 0.45 U0 | Close stages | 1.12 / 1.25 / 1.40 |
| Fwd `G` stages | 0.15 / 0.28 / 0.42 | Fwd `F` stages | 0.10 / 0.18 / 0.28 |
| Fwd `Pd` stages | 0.12 / 0.25 / 0.40 | Lean `Δroll` | 8° / 15° / 25° |
| Lean `Δtilt` | 6° / 12° / 20° | Lean `ΔL` | 0.18 / 0.32 / 0.50 |

## 11. Implementation notes

- Keep the whole pipeline pure/deterministic: `(frameLandmarks, tNow, config, prevState) → (newState, alerts[])`. This makes it unit-testable with recorded landmark traces and independent of MediaPipe.
- Persist calibration + per-issue config (toggles, stage toggles, σ) to disk; invalidate calibration on app-detected camera-device change.
- MediaPipe `PoseLandmarker` should run with `runningMode: "VIDEO"`, `numPoses: 1`, `minTrackingConfidence ≈ 0.5`; its own tracking already provides some temporal stability — the smoothing above is layered on top and is still required.

### Critical Files for Implementation
- C:\Users\cedri\source\repos\SitSense\src\renderer\posture\constants.ts (every default from section 10, plus landmark indices)
- C:\Users\cedri\source\repos\SitSense\src\renderer\posture\metrics.ts (primitives, unified scale, metric formulas, median+EMA smoothing, outlier gate)
- C:\Users\cedri\source\repos\SitSense\src\renderer\posture\calibration.ts (capture window, validity/stability checks, median baseline)
- C:\Users\cedri\source\repos\SitSense\src\renderer\posture\episodeMachine.ts (per-issue FSM + global presence FSM, pure step function)
- C:\Users\cedri\source\repos\SitSense\src\renderer\posture\detectorEngine.ts (per-frame pipeline of section 9, wiring PoseLandmarker output to the FSMs and the notification layer)