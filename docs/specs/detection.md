# SitSense Posture Detection — v2 (any camera angle, AI-judged posture)

v1 assumed a frontal, centered webcam: it measured 2D shoulder width, the 2D ear line and
2D shoulder line, and it captured whatever posture the user held as "good". From an angled,
elevated or side camera that produced false "severe" alerts, and setup made users center
themselves and show both shoulders and both ears.

v2 requirements (from the user):

1. **Any camera angle.** Front, oblique, side, above, below. The user only needs to be about
   half visible: the head plus at least one shoulder.
2. **The AI decides what good posture is.** Setup coaches the user ("bring your ears back over
   your shoulders") and saves the baseline automatically once the posture is good. The user
   is never asked to define good posture.
3. Never tuned to one setup. Correctness is proven with a 3D posture simulator rendered from
   many virtual camera viewpoints (§10).

v3 (the strict judge) answers "it said fine while I was practically lying in the chair":
the judge keeps coaching until the posture is really good, never saves a posture it
cannot verify from the camera on its own word, and lying back in the chair raises
Slouching at runtime. See §4a, the `recline` sub-metric in §5, "Setup session (v3)" in
§7, the simulator's realistic postures in §10, and the v3 limitations at the end.

Runtime: Electron renderer, MediaPipe Tasks Vision `PoseLandmarker` (lite), `runningMode:
VIDEO`, 5–15 fps. All timing is wall-clock (fps-independent).

---

## 1. Inputs and coordinate frames

Per frame the controller passes a `PoseFrame`:

```ts
interface PoseFrame {
  image: readonly Landmark[]          // 33 normalized landmarks: x by width, y by height, y down
  world: readonly Landmark[] | null   // 33 world landmarks (metres), see below
  aspect: number                      // video width / height
}
type Frame = PoseFrame | null         // null = no pose detected
```

* **Image landmarks.** `x, y ∈ [0,1]` (may fall slightly outside for off-frame points),
  `visibility ∈ [0,1]`. Convert to **isotropic image coordinates** (height units, origin at
  the image center) before any 2D geometry: `u = (x − 0.5)·aspect`, `v = y − 0.5`. (v1 measured
  angles on raw normalized x/y, which distorts every angle on 16:9 video.)
* **World landmarks.** Metres, origin at the hip midpoint, **axes aligned with the camera**:
  `+x` image-right, `+y` image-down, `+z` away from the camera (smaller z = closer). They are
  the model's 3D estimate. Far-side and off-frame points are still predicted but are less
  reliable, so their image `visibility` is used as the weight. (The model's axes are
  really those of its crop; the code first rotates them into camera axes, see the
  Implementation notes, "viewing-ray correction".)
* **Camera coordinates** (`X` right, `Y` down, `Z` forward) share the world axes, so a vector
  between two world landmarks *is* a camera-frame vector. `camUp = (0, −1, 0)`.
* **Pinhole model** (for positions only). We do not know the webcam's field of view and
  assume `HFOV_ASSUMED = 65°`: focal length in height units `f = aspect · 0.5 / tan(HFOV/2)`.
  A FOV error rescales metric distances; angles change only through the small residual of
  the viewing-ray correction (Implementation notes).

Landmark indices used: nose 0, eye-outer L/R 3/6, ears L/R 7/8, shoulders L/R 11/12,
hips L/R 23/24, knees L/R 25/26. "Left/right" are the person's anatomical sides.

A landmark is **seen** iff `visibility ≥ V_SEEN = 0.5` and its image point lies within the
frame expanded by 5% on every side.

## 2. Presence ("halfway visible")

A frame is **GOOD** iff a pose was detected, world landmarks are present, the head is seen
(nose seen OR any ear seen), and at least one shoulder is seen. Otherwise it is **BAD** and
feeds the presence state machine (§8). Nothing else is required: no centering, no second
shoulder, no ears, no hips. The pose must, however, be plausibly a person sitting at the
screen: not farther than a desk user (or than a few times the user's own setup distance),
and upright for some level-camera pitch (a figure
printed on a desk mat, a poster, someone behind the user are not the user; Implementation
notes, "Presence plausibility"). `frameReject(frame)` / `engine.frameReject` /
`SetupState.frameReject` say why a frame is BAD: `'no-pose' | 'not-in-view' | 'too-far' |
'not-upright'`; the last two mean "not you".

## 3. Per-frame geometry (`features.ts`, pure)

`extractFeatures(frame, opts?: { up?: Vec3 }) → PostureFeatures | null` (null for BAD frames).

### 3.1 Visibility-weighted points and vectors

For a left/right pair the **side weight** is `w = vis²`, with `ε = 1e−3` added to avoid
dividing by zero. A **pair point** (e.g. "shoulder") is the weight-averaged world position of
its L and R landmarks. A **pair vector** between two pairs (e.g. neck = shoulder→ear) is
averaged per side, `V = Σ_s w_s (B_s − A_s) / Σ_s w_s` with `w_s = min(vis(A_s), vis(B_s))²`,
so in a side view the near side dominates.

* `N` = neck vector, shoulder→ear (pair vector).
* `T` = trunk vector, hip→shoulder (pair vector). Defined only if **hips are seen** (at least
  one hip seen).
* `S` = shoulder line, `world[11] − world[12]` (points to the person's left).
* `H` = hip line, `world[23] − world[24]`.
* `E` = ear line `world[7] − world[8]`, or the eye-outer line `world[3] − world[6]` if both
  ears aren't seen. Used only when both points of the chosen pair are seen.
* `n` = head direction, `nose − ear point` (nose-side weighted ear point).

### 3.2 Gravity ("up") estimate

`estimateUp(frame) → { up: Vec3, source: 'body' | 'hips' | 'camera' }`:

1. **body.** Both hips seen and at least one knee seen with `vis ≥ 0.7`. Thigh direction
   `K` = hip point → knee point (per side). Seated thighs and the hip line are both near
   horizontal, so `up = normalize(K × H)`, sign flipped so `up · camUp > 0`. Requires
   `angle(K, H) ∈ [45°, 135°]`.
2. **hips.** Both hips seen. `up = camUp` with its component along `Ĥ` removed, then
   normalized. This corrects camera roll; camera pitch stays unknown.
3. **camera.** `up = camUp`.

Reject any estimate more than `UP_MAX_TILT = 60°` from `camUp` and fall to the next rule.

During setup, `UpEstimator` accumulates the per-frame estimates: a running mean of the unit
vectors from the best source seen so far, renormalized. The baseline stores the final `up`
and its source. **At runtime the engine always uses the baseline's `up`** (the camera is
fixed), via `extractFeatures(frame, { up })`.

### 3.3 Body frame

* **Lateral axis `L̂`** (the person's left): `H` if both hips are seen, else `S`. Project it
  onto the horizontal plane (remove its `Û` component) and normalize.
* **Forward `F̂ = L̂ × Û`**, oriented so that `n · F̂ > 0` (the nose is in front of the ears).
  After any flip, recompute `L̂ = Û × F̂`. This keeps left/right consistent even when the model
  swaps L/R labels.
* **Sagittal up `Û_s`**: `Û` with its `L̂` component removed, normalized.

### 3.4 Angles (degrees)

`tilt(v, a, b) = atan2(v·b, v·a)` is the angle of `v` away from axis `a` toward axis `b`.

| Feature | Definition | Needs |
|---|---|---|
| `neckFwd` | `tilt(N, Û_s, F̂)`: ears ahead of shoulders (+) | always (GOOD frame) |
| `neckLat` | lateral neck tilt toward the person's left (+). With hips: `tilt(N, T̂_⊥, L̂)` where `T̂_⊥` = `T` minus its `F̂` part (relative to the trunk). Without hips: `tilt(N, Û_L, L̂)` with `Û_L` = `Û` minus its `F̂` part | always |
| `headPitch` | `atan2(−n·Û, |n − (n·Û)Û|)`: head direction below horizontal (+ = looking down). Invariant to head yaw | nose seen |
| `headRollRel` | angle between `E` and `S` within the body's frontal plane: project both onto the plane ⟂ `F̂` and take the signed angle (+ = left ear higher than the shoulder line). Body-relative, no gravity needed | both ears or both eyes seen, both shoulders vis ≥ 0.3, `view.yaw < 60°` |
| `shoulderTilt` | `asin(Ŝ·Û)` (+ = left shoulder higher) | both shoulders seen; see lateral confidence |
| `trunkFwd` | `tilt(T, Û_s, F̂)` (+ = leaning forward, − = reclined) | hips seen |
| `trunkLat` | `tilt(T, Û_H, L̂)` with `Û_H` = `Û` minus its `Ĥ` part (relative to the pelvis) | both hips seen |
| `torsoLen` | `|T|` (m) | both hips seen |
| `neckOnTrunk`, `headOnTrunk` (v3) | the neck's and the head direction's angles on the trunk, in the body's own sagittal plane — gravity-free (§4a.1) | a hip, an ear reliably in frame (+ the nose) |

v3 also reports `vis.hipsInFrame` (hips whose image point is inside the frame, seen or
not), which tells hips hidden by a desk from hips outside the picture.

**Lateral confidence.** With `up.source === 'camera'`, an unknown camera pitch `p` biases
any gravity-referenced lateral angle by about `asin(sin p · sin ψ)`, where `ψ` is the body's
yaw relative to the camera. So `shoulderTilt` is reported only if `up.source !== 'camera'` or
`view.yaw ≤ 20°`. The engine additionally holds it whenever the body has swiveled more than
`SWIVEL_HOLD = 15°` from the baseline forward direction (§5).

### 3.5 Scale, positions, view

* **Scale `ppm`** (image height-units per metre at the body). Least squares over all
  segments whose two endpoints are both seen: shoulders, ears, eye-outers, ear→shoulder per
  side, nose→ear per side, shoulder→hip per side.
  `ppm = Σ |d₂|·|d_w| / Σ |d_w|²`, where `d₂` is the isotropic image difference and `d_w` the
  world difference restricted to its x,y components. Requires ≥ 2 segments, else null.
* **Depth** `Z = f / ppm` (m).
* **Camera-frame position** of image point `i`: `P_i = (u_i·Z/f, v_i·Z/f, Z)`.
* `anchor` = position of the shoulder pair point (visibility-weighted image point).
  `head` = position of the ear pair point, or the nose if no ear is seen.
* **View.** `toCam = −normalize(anchor)`. Remove its `Û` component to get `toCam_h`.
  `view.yaw = angle(F̂, toCam_h)` in [0°, 180°]: 0 = facing the camera, 90 = profile.
  `view.elevation = asin(toCam · Û)` (+ = camera above the shoulders).
  `view.kind = 'front'` if yaw < 25°, `'angled'` if < 60°, else `'side'`.
* `nearSide` = `'left'` or `'right'`, whichever side has the higher summed visibility of
  ear + shoulder + hip. Used by the overlay to draw the near-side alignment line.

## 4. AI posture assessment (`assess.ts`, pure)

> **Superseded in part by §4a, "Posture judge v3 (strict)".** The table below is the v2
> baseline the v3 judge builds on; §4a lists what changed (stricter limits, the
> gravity-free head-on-trunk evidence, `verified`, and setup never saving what it cannot
> verify).

`assessPosture(f: PostureFeatures | null, upSource) → PostureAssessment`. This is the "AI
judge" used during setup (and shown live on the dashboard). Each check is `good`, `adjust`
(with one concrete instruction) or `unknown` (not measurable from this view; never blocks).

**Confidence and tolerance.** Gravity-referenced checks get a tolerance multiplier `k`.
Sagittal checks: `k = 1.0` if `up.source = 'body'` or `view.yaw ≥ 50°` (in a side view,
camera pitch barely affects sagittal angles); `1.3` for `'hips'`; `1.6` for a `'camera'`
source in a non-side view. Lateral checks: `k = 1.0` unless the source is `'camera'`, then
`1.4`. The thresholds below are multiplied by `k`.

| id | Measure | Good when | Instruction when not (pick the matching direction) |
|---|---|---|---|
| `inView` | GOOD frame | — | "Move so your head and at least one shoulder are in the picture." |
| `trunkUpright` | `trunkFwd` | `−35° ≤ trunkFwd ≤ 12°·k` | forward: "Sit back — let your back rest against the chair." Too far reclined: "Sit up a little — you're leaning far back." |
| `headOverShoulders` | `neckFwd` | `neckFwd ≤ 20°·k` | "Bring your head back until your ears sit over your shoulders." |
| `sideLean` | `trunkLat` | `|trunkLat| ≤ 6°·k` | "You're leaning to your {side} — center your weight on both hips." |
| `shouldersLevel` | `shoulderTilt` | `|shoulderTilt| ≤ 5°·k` | "Your {higher} shoulder is raised — let it drop and relax." |
| `headLevel` | `headRollRel` | `|headRollRel| ≤ 7°·k` | "Straighten your head — it's tilted toward your {side}." |
| `gaze` | `headPitch` | `−15° ≤ headPitch ≤ 30°·k` | down: "Lift your gaze a little — if your screen sits low, raise it." Up: "Lower your chin slightly." |

`{side}`/`{higher}` are the person's own left/right. Priority, which picks the single
`primary` instruction shown large: inView, trunkUpright, headOverShoulders, sideLean,
shouldersLevel, headLevel, gaze. `allGood` = no check is `adjust` and `inView` is good.

## 4a. Posture judge v3 (strict)

v2 let bad postures through. A user practically lying in the chair (trunk 30–50° back,
pelvis slid forward, neck craned forward to keep the eyes on the screen) passed: from a
frontal camera the back angle was `unknown` ("can't see from this angle", non-blocking)
and the rest looked fine; with thigh gravity the recline limit was −35° and the head was
judged against gravity only (ears roughly over the shoulders — while the neck was craned
far forward on the reclined trunk). v3 rests on three principles:

1. **Absolute evidence verifies, relative evidence detects.** Gravity-referenced sagittal
   angles (trunk lean, neck, gaze) are trustworthy only with thigh gravity or in a
   near-profile view (§4 notes). Gravity-free angles of the head on the trunk are exact
   from any camera; they can show that a posture is bad, but cannot alone prove that a
   trunk is upright (a whole-body lean with an aligned neck looks the same on the trunk).
2. **Never pass what cannot be verified.** The essential checks — `trunkUpright` and
   `headOverShoulders` (`ESSENTIAL_CHECKS`) — must be verified from this view, or the
   posture is not `verified`. Setup never saves an unverified posture on its own (§7).
3. **The captured posture is judged as a whole** ("final exam", §7) without the hold's
   widened tolerances.

### 4a.1 Gravity-free evidence: the head on the trunk

Per frame (`features.ts`), in the body's own sagittal plane — the plane ⟂ the body's
lateral line (hip line, else shoulder line; no gravity enters) — with the trunk `T`
(hip → shoulder) as the axis:

| Feature | Definition | ≈ |
|---|---|---|
| `neckOnTrunk` | tilt of the neck `N` (shoulder midpoint → ear point) from `T` toward the body's front | `neckFwd − trunkFwd` |
| `headOnTrunk` | the head direction (ear point → nose) below the plane ⟂ `T` (+ = nose down on the trunk) | `headPitch − trunkFwd` |

Both use **world-landmark vectors only**: any rotation of the world frame (gravity
error, the viewing-ray correction's FOV residual) cancels exactly. (The v2 head pitch
uses back-projected points; mixed with the world trunk it was up to 9° off on an 85°
webcam, and a camera pitch seen from a turned body leaked into a diagonal nose vector —
one ear in view — by up to 25°.) They need a hip (the trunk) and an ear reliably inside
the frame (summed in-frame trust ≥ 0.5: a single ear grazing the frame edge may be
extrapolated); `headOnTrunk` also needs the nose. The features also carry the vectors'
components in the trunk's sagittal frame (`neckOnTrunkVec`, `headOnTrunkVec`,
`[forward, up]` in metres); a summary of several frames (`medianFeatures`) takes the
angle of their component-wise centre — the angle of a short noisy vector is skewed and
heavy-tailed, its components are not.

What they read (the ear→nose line droops 14° below the head's Frankfort plane in the
simulator; 6–17° across real faces):

| Posture (eyes on the screen) | headOnTrunk | neckOnTrunk |
|---|---|---|
| upright, Frankfort level to 12° down | 14–26° | 0–6° (+ the person's own ear-ahead offset) |
| reclined 5–15° against the backrest, head stacked | 25–33° | 8–20° |
| lying 30–50° back, pelvis 10–20 cm forward | 45–59° | 21–44° |
| slumped / perched forward (trunk leaning in) | −16–5° | −14–2° |

Lying back while looking at the screen *requires* tipping the head far forward on the
trunk; leaning in requires tipping it back.

### 4a.2 Checks

`f` is the (time-smoothed) features; `absolute` = thigh gravity (`body`) OR a near-profile
optical yaw (75–105°); `trunkKnown` = `absolute` and the trunk in view.

**trunkUpright**

| Evidence | Verdict |
|---|---|
| `trunkKnown`, `trunkFwd > 12°·k` | adjust forward: "Sit back — let your back rest against the chair." |
| `trunkKnown`, `trunkFwd < −25°` (fixed) | adjust back: "Sit up a little — you're leaning far back."; below −32° or with the lying signature: **"Slide your hips back and sit up tall — you're lying in the chair."** |
| lying signature (below) | adjust back, the lying instruction (basis `relative`) |
| `trunkKnown`, `headOnTrunk < 0°` | `unknown`, unverified: the absolute reading says upright, the head on the trunk says leaning in (hips predicted under a desk shift the trunk by up to ±12°); "Sit back against your backrest and look at the middle of your screen." |
| `trunkKnown` otherwise | good (basis `absolute`) — the only way it is verified |
| not `trunkKnown`, `headOnTrunk < −8°` | adjust forward (leaning in; basis `relative`, a hint) |
| no hip in view | `unknown`, unverified; hips outside the picture: "Tilt the camera down a little so your hips are in the picture — SitSense needs them to check your back."; hips in the picture but hidden or judged hallucinated: "Sit tall against your backrest — your hips are hidden, so SitSense can't check your back from this camera." |
| a hip in view, no absolute reference | `unknown`, unverified: a front view "Sit tall against your backrest — SitSense can't judge your back angle from straight in front."; an angled (or not-quite-profile) view "…from this camera angle." (`backFromAngle`) |

**Lying signature.** `neckOnTrunk > 12°` (the neck cranes forward on the trunk — a plain
look down tips the head, not the neck) AND either `trunkKnown` with `trunkFwd < −18°`
and `headOnTrunk > 36°`, or (trunk lean unknown) `headOnTrunk > 48°`. The higher bar
without a known trunk keeps a reclined good posture from ever being told it lies in the
chair; a missed signature there only leaves the view coaching, since such a view never
verifies the back.

The recline limit −25° is fixed (not × k). Neutral sitting is a hip angle of ~90–110°
(trunk 0–20° back); with thigh gravity the reading *is* the hip angle − 90°, so −25°
admits a 15° recline on a seat whose thighs slope 10° down.

**headOverShoulders**: absolute where `absolute` (`neckFwd ≤ 20°·k`); else on the trunk
when it is visible (`neckOnTrunk ≤ 20°·1.3`) — not both: sitting back 15° with the head
stacked flexes the neck 15–30° on the trunk, which is fine, and a neck craned on a trunk
reclined past that is the lying signature. With neither a gravity reference nor the
trunk, the neck angle carries the camera's unknown pitch: only a neck past any plausible
tilt (`neckFwd > 20°·k` with the gravity's own k — 1.3 hips, 1.6 camera —, basis
`estimate`, assumes a roughly level camera) is called out; otherwise `unknown` and
unverified (instruction: the hips' one).

**Coaching vs confirming (v0.2.1).** The widened sagittal limits (× k: 1.3 thigh gravity,
1.6 camera) only decide what is *coached*. An absolute reading between the plain ergonomic
limit and its widened one — trunk 12–15.6°, neck 20–26° with thigh gravity — is `unknown`
(not coached, not confirmed: reason "within the allowance for an imprecise gravity
reference"; the trunk gets "sit back and look ahead", the head the head-forward line). The
allowance models the reference's error (a thigh slope, a small camera roll), which can hide
a slump as easily as fake one. On top of that, an absolute reading only confirms when:

* the hip line agrees with a level camera (`levelUnconfirmed` false). Otherwise both
  `trunkUpright` and `headOverShoulders` stay unconfirmed with `INSTRUCTIONS.levelCamera`
  ("…straighten the camera — it looks tilted…"): a rolled camera leaks into the sagittal
  angles of a turned body, because the estimate keeps the camera level;
* the head does not tip as far forward on the trunk as when lying back (`headOnTrunk` and
  `neckOnTrunk` past the lying thresholds × slack → unconfirmed, "sit back and look ahead");
* a forward trunk reading is backed by the head on the trunk: the corroboration bar rises
  with the reading, `headOnTrunk ≥ VERIFY_HEAD_ON_TRUNK_MIN + VERIFY_HEAD_ON_TRUNK_PER_DEG ·
  max(0, trunkFwd)` (1°/°). A slump on a seat whose knees point down reads up to ~10° too
  upright, with the head tipped back on it.

Trade-off: someone truly leaning ~10° in while looking straight ahead is no longer confirmed
locally; they are never coached wrongly and go to the review (or "save anyway").

**Hips instruction.** "…so your hips are in the picture — SitSense needs them to check your
back" (`showHips`) is only used where the hips *would* let the back be checked (thigh
gravity in use or knees in view, or a near-profile view). Elsewhere the back gets the
front/angle instruction and the head check `showHipsForHead` ("…to check your head
position").

**Near-profile hysteresis (setup).** A view is near-profile from `SIDE_VIEW_YAW` (75°); while
holding or capturing — and in the final exam of an unforced capture — it stays so down to
75° − `SIDE_VIEW_YAW_HYST` (5°). The session's yaw is the median over the 2 s window. A
capture discarded as unverifiable sets the exam's instruction, so the user is told why.

The lateral checks and `gaze` are unchanged (not essential: `unknown` never blocks them).
In a near-profile view the gaze is now judged absolutely (it was on the trunk); a gaze
judged against an unconfirmed gravity (basis `estimate`) gets that gravity's own k.

### 4a.3 Output (additive)

* `verified` = `allGood` AND no essential check unverified.
* `unverified`: the essential checks the local judge could not make from this view.
* `viewInstruction`: the first unverified check's instruction (how to make it checkable).
* `headOnTrunk: { neck, gaze }`: the gravity-free angles the verdict used.
* per check: `basis` (`absolute` | `relative` | `estimate`) and, for an unverified one,
  `viewInstruction`.

### 4a.4 What each camera can verify

| View | Trunk lean | Head over shoulders | Head-on-trunk signatures (lying; leaning in only where the trunk lean is unknown) |
|---|---|---|---|
| Thighs in view (thigh gravity), any yaw | verified, ±10–15° thigh slope (× 1.3 forward; −25° recline fixed) | verified, absolute | yes (if a hip and an ear are in frame) |
| Near profile (optical yaw 75–105°), a hip in view | verified, ±3° camera roll | verified, absolute | yes |
| Near profile, no hip | unverified (no trunk) | verified, absolute | no |
| Frontal / angled, a hip in view, no thighs | **unverified** (camera pitch unknown) | verified on the trunk | yes |
| Frontal / angled, no hip (head + shoulders) | **unverified** | **unverified** (except a neck far past any tilt) | no |
| Behind the profile (yaw > 105°), no thighs | unverified | on the trunk | yes |

A hip "in view" means seen inside the frame and not judged hallucinated (§ notes, hip
consistency). The camera's pitch is unknown unless the thighs give it, and it leaks into
every sagittal angle as ≈ pitch·cos(yaw); body-relative angles cancel it. A frontal desk
webcam (knees under the desk) therefore never verifies the back angle on its own: the
setup asks the cloud review, or the user saves knowingly (§7).

## 5. Issues, metrics and stages (engine)

All metrics are **deviations from the baseline**, computed with the baseline's `up`.
Positive means worse. The base thresholds below apply at sensitivity σ = 1; the effective
threshold is `base / σ`. Every issue's severity is the **maximum stage over its available
sub-metrics**. Hysteresis and the episode machine are unchanged from v1 (`HYST = 0.75`).

Let `ψ` be the swivel, the horizontal angle between the current `F̂` and the baseline's
`forward`.

### Issue `sink` — Slouching
| sub | value | stages | needs |
|---|---|---|---|
| `trunkFwd` | `trunkFwd − trunkFwd₀` (deg) | 10 / 18 / 28 | hips seen now and at baseline |
| `drop` | vertical drop of `anchor` along `−Û`, (`anchor − anchor₀`)·(−Û), in cm | 5 / 10 / 16 | always |
| `torso` | `1 − torsoLen/torsoLen₀` | 0.07 / 0.12 / 0.18 | both hips seen now and at baseline |
| `recline` | recline-slump ("lying in the chair"): `min(R, 1.5·C)`, `R = trunkFwd₀ − trunkFwd` (the recline since the baseline), `C = neckOnTrunk − neckOnTrunk₀` (the neck's extra forward flexion on the trunk, gravity-free) | 20 / 28 / 36 | hips seen now and at baseline; held with the head metrics (one ear + head turned) and on a swivel without thigh gravity |

`recline` (v3) scores lying back while craning the neck forward to keep the eyes on the
screen. It needs both: leaning back with the head going along (resting, stretching) has
no crane, and a forward head without a recline is head-forward, not slouching. Sitting
back 15° with the head stacked stays below stage 1; lying 30° back reads ~22–27 (stage
1), 35° ~30–34 (2), 40–50° ~36–45 (3). `C` compares the gravity-free `neckOnTrunk` with
the baseline's (stored since v3; an older baseline falls back to
`(neckFwd − trunkFwd) − (neckFwd₀ − trunkFwd₀)`, where a constant camera tilt cancels as
well). Before v3 only the forward trunk lean counted; a recline showed only through the
shoulders' `drop`.

### Issue `headForward` — Head forward
| sub | value | stages | needs |
|---|---|---|---|
| `neck` | `neckFwd − neckFwd₀` (deg) | 10 / 18 / 28 | always |
| `neckDrop` | `1 − h/h₀`, where `h` = image-plane vertical ear→shoulder distance along the projected `Û`, in metres (÷ ppm) | 0.15 / 0.28 / 0.42 | front view now and at baseline (yaw < 35°) |
| `pitch` | `headPitch − headPitch₀` (deg, looking down more) | 15 / 25 / 35 | nose seen |

When `pitch` is the only sub-metric at stage ≥ 1, the dwell is multiplied by
`PITCH_ONLY_DWELL_MULT = 1.5`, because glancing down at a keyboard or phone is normal.

### Issue `lean` — Leaning to one side
| sub | value (signed, then abs for staging) | stages | needs |
|---|---|---|---|
| `trunkLat` | `trunkLat − trunkLat₀` | 6 / 11 / 18 | both hips seen |
| `neckLat` | `neckLat − neckLat₀` | 8 / 14 / 22 | always |
| `shoulderTilt` | `shoulderTilt − shoulderTilt₀` | 5 / 9 / 15 | available per §3.4 and `ψ ≤ 15°` |
| `headRoll` | `headRollRel − headRollRel₀` | 8 / 14 / 22 | available per §3.4 |

`direction` comes from the sign of the dominant sub-metric's signed value: positive means
toward the person's **left**. It is reported as `'left' | 'right'` in the user's own terms
(the preview is mirrored, so their left is also on screen-left).

### Issue `tooClose` — Too close to screen
| sub | value | stages | needs |
|---|---|---|---|
| `forward` | `(anchor − anchor₀) · forward₀` in cm (toward the screen; `forward₀` = baseline `F̂`) | 7 / 13 / 19 | always |

### Recalibration hint
`D = ppm / ppm₀`. If `D ∉ [0.5, 1.8]` for 10 s while ACTIVE, set `recalibrationSuggested`.
While the hint is up and `D` is still out of range, every detector is suspended
(`snapshot.suspended = true`, all stages 0): the UI shows "View changed" and no score
(ui-v3 §3.4), the tray is neutral ("view changed — redo posture setup"), the history
minute is not counted as good (`paused` bucket) and the coach gets no stages. Once `D` is
back in range, detection resumes at once; the hint is withdrawn after the view has stayed
in range for `RECAL_SUGGEST_S` (10 s) — a camera that really moved keeps it up. Redoing
setup clears it.

## 6. Smoothing

Unchanged in spirit from v1. Every sub-metric passes a median-of-3, then an fps-adaptive EMA
with `τ = 0.6 s`; `ppm` uses `τ = 1.0 s`. Outlier gate: a single-frame `ppm` jump of more
than 35% discards the frame, and 3 consecutive discards are accepted as real. A sub-metric
that is unavailable this frame holds its value; its issue's timers pause through
`dataAvailable`. Returning from AWAY reseeds everything.

## 7. Setup ("calibration") session (`calibration.ts`)

`SetupSession.push(frame, tMs) → SetupState` is driven purely by frames and timestamps.

```
phase: 'searching'  no GOOD frame yet / user out of view
     → 'coaching'   GOOD, assessment shown live, at least one check is 'adjust'
     → 'holding'    allGood continuously for HOLD_S = 1.5 s (progress 0..1)
     → 'capturing'  CAPTURE_S = 3 s of frames collected (progress 0..1)
     → 'done'       baseline built
```

* Any `adjust` check lasting more than `BREAK_S = 0.7 s` during holding or capturing goes
  back to `coaching` and discards the captured frames. A BAD frame for more than 1 s goes to
  `searching`.
* `canForce` becomes true after `FORCE_AFTER_S = 20 s` in coaching. `force()` captures the
  current posture anyway (3 s capture, same stability check) with `verified: false`.
* **Strict (v3).** Without a reviewer, holding starts only on a `verified` assessment
  (§4a), not on `allGood`; see "Setup session (v3)" below.
* **Building the baseline.** Average `up` from the `UpEstimator` over the captured frames,
  then recompute `extractFeatures` for every captured frame with that fixed `up` and store
  the **median** of every feature. A null feature is stored as null if it was available in
  fewer than half the frames.
* **Stability.** The MAD (×1.4826) of `neckFwd` must be ≤ 4°, and the MAD of `anchor`
  ≤ 2 cm. Otherwise fail with `'unstable'` ("Hold still for a moment").
* Need ≥ 15 GOOD frames in the capture, else `'lost'`.

### Setup session (v3): nothing unverified is saved on the local judge's word

```
coaching ──verified (no reviewer) / allGood (reviewer)──▶ holding ─▶ capturing ─▶ final exam
   ▲  needsVerification: good in all the camera shows, not verifiable here      │
   │  → instruction = viewInstruction; canForce after UNVERIFIED_FORCE_AFTER_S   │
   └──────────── exam: something to adjust, or unverifiable and no reviewer ◀────┤
                 exam verified (no reviewer) ─────────────────────────▶ done (verified)
                 reviewer: review true, or 'auto' and not verified ──▶ reviewing
```

* **needsVerification** (`SetupState`, additive): coaching without a reviewer on a posture
  that is `allGood` but not `verified`. `instruction` is the assessment's
  `viewInstruction` (show the hips / sit tall, the back angle cannot be judged from the
  front). After `UNVERIFIED_FORCE_AFTER_S = 3 s` of it (interruptions up to `BREAK_S` —
  a lateral check flickering on noise — do not restart the clock) `canForce` turns on:
  "Save this posture anyway" saves it with `verified: false`. The earlier rule (20 s of
  coaching) still applies too.
* **With a reviewer** (`review: true`, or `'auto'` for a capture that is not verified),
  `allGood` suffices to hold and capture, and the cloud review decides.
  `acceptReview()` → done, verified.
* **skipReview()** (the review could not run, or the user skipped it): a capture the local
  judge verified is saved (done, verified). One it could not verify is **not** saved: back
  to coaching, without a reviewer until `restart()` (no capture/review loop while the AI is
  unavailable), with `canForce` on at once. (v2 saved it unverified, with a notice.)
* **Final exam.** `buildBaseline` returns `assessment`: the captured posture's robust
  average (every hold and capture frame, the baseline's own gravity, no hold slack)
  judged once more. A capture whose exam finds an essential check (back, head) to adjust
  goes back to coaching, and its instruction is shown until the next capture
  (`examInstruction`) — the live window's noise or the hold's ×1.2 tolerances can let a
  borderline-bad posture run on (e.g. sliding back to 27° during the hold). The lateral
  checks and the gaze keep the hold's verdict (a borderline lateral reading — a rolled
  camera reads as one — must not loop captures). Without a reviewer only an exam with every
  essential check verified saves the baseline. A forced capture skips the exam.
* **One gravity per window.** The live window's frames are re-measured whenever the
  gravity estimate (or the hips' use) changes by more than 0.5°, so a median never mixes
  frames measured with different gravities (while the estimate settles over the first
  frames it made an upright trunk read 15° forward for a second).
* **Head-on-trunk window.** `neckOnTrunk`/`headOnTrunk` in the live assessment are the
  medians of the last `ASSESS_RELATIVE_WINDOW_S = 2 s` (the other features: 1 s): they rest
  on short vectors near the head and are the noisiest features per frame, while lying or
  leaning in is a posture held for a while.
* `notice` / `UNVERIFIED_NOTICE` stay for compatibility; a baseline saved unverified now
  always comes from `force()`, which shows no notice.

### Baseline (persisted, numbers only)

```ts
interface CalibrationBaseline {
  version: 2
  capturedAt: number
  cameraDeviceId: string | null
  up: Vec3; upSource: 'body' | 'hips' | 'camera'
  forward: Vec3                  // body forward (toward the screen) at capture
  view: { kind: 'front' | 'angled' | 'side'; yawDeg: number; elevationDeg: number }
  verified: boolean              // AI judged it good (false = saved anyway)
  neckFwd: number; neckLat: number; headPitch: number | null
  headRollRel: number | null; shoulderTilt: number | null
  trunkFwd: number | null; trunkLat: number | null; torsoLen: number | null
  neckH: number | null           // h₀ for neckDrop (front views only)
  ppm: number
  anchor: Vec3                   // camera-frame metres
}
```

Settings migration: a stored baseline without `version: 2` is dropped (`calibration =
null`), and the app asks for the quick setup again.

v3 adds two optional numbers, written by `buildBaseline` (typed `PostureBaseline` in
`posture/types.ts`, a candidate for `CalibrationBaseline` in `src/shared/posture.ts`):
`neckOnTrunk` and `headOnTrunk` (deg, null without a hip in view). They are always
written (null when unmeasurable), so a deep-merged settings patch never keeps an older
baseline's value; readers fall back when they are absent.

## 8. Presence and episode machines

Presence ACTIVE/AWAY (enter 2.0 s, exit 1.5 s, full reset after 30 s away). The engine
starts AWAY: nobody counts as present — sitting, judged — until 1.5 s of real landmarks
(an app launched at login must not open a sitting stretch for an empty chair). A gap
without frames longer than the full reset (pause, sleep, camera restart) also returns to
AWAY until the person is confirmed again. Per issue: IDLE → PENDING → ALERTED → RECOVERING → COOLDOWN with dwell, cooldown, escalation,
band-hold and data-loss reset (see `episodeMachine.ts` and `constants.ts`; long gaps,
cooldown arming and quiet-period escalation: Implementation notes). There is no reminder:
the machine never emits `kind: 'reminder'` (the shared `AlertKind` keeps the value for
compatibility only). A worsening stage during the quiet period is not announced at once:
it needs the escalation dwell (`ESC_DWELL_S`, 4 s at the worse stage) and at least
`ESC_MIN_GAP_S` (30 s) since the previous alert. Dwell factors: sink 1.0, headForward 1.0,
lean 1.25, tooClose 0.7, times the user's base dwell.

## 9. Engine outputs

`PostureEngine.processFrame(frame, tMs) → { snapshot, alerts }`. `PostureSnapshot` keeps its
v1 fields and gains an optional `readout` for the UI:

```ts
readout?: {
  view: 'front' | 'angled' | 'side'
  /** live deviations from the baseline (deg / cm), null when unavailable */
  neckFwd: number | null; trunkFwd: number | null; drop: number | null
  forward: number | null; lateral: number | null
  /** what `lateral` was measured from: the neck tilt has its own stages (8/14/22°) */
  lateralFrom?: 'trunk' | 'neck'
}
/** every detector paused: the view is far off the setup distance (§5 Recalibration hint) */
suspended?: boolean
```

The engine also exposes `lastFeatures` (the latest `PostureFeatures`) for the overlay.

## 10. Verification: 3D posture simulator (`__tests__/sim.ts`)

A parametric seated skeleton in body coordinates, rendered by a virtual pinhole camera into
MediaPipe-shaped output. It is the main test harness for "works from any angle".

* **Body** (metres; origin at the hip midpoint; X = person's left, Y = up, Z = forward). Hip
  joints ±0.09; shoulders ±0.18 at torso length 0.48 above the hips; ear midpoint 0.15 above
  the shoulder midpoint with the ears ±0.075; nose 0.10 forward of and 0.025 below the ear
  midpoint; eye-outers ±0.045, 0.08 forward of and 0.015 above the ears; knees 0.45 forward
  of the hips at ±0.10 (horizontal thighs), with an optional thigh slope.
* **Posture parameters:** `trunkPitch` (+ forward), `trunkRoll` (+ toward the left),
  `slump` (torso compression fraction), `neckFlex` (+ head forward, relative to the trunk),
  `neckLat`, `headPitch` (+ nose down), `headRoll`, `headYaw` (turning to a second monitor),
  `shoulderShrug` (L/R raise), `swivel` (whole-body yaw), `slide` (forward/back), `sink`
  (vertical).
* **Camera:** spherical placement around the body (azimuth −90…90°, elevation −20…50°),
  distance 0.5–2.0 m, aimed at the chest, roll −3…3° (webcams are mounted level; see the
  notes for rolled cameras), HFOV 55–85° (deliberately not the assumed 65°), aspect 16:9 or 4:3.
* **Output:** projected image landmarks with Gaussian noise (σ ≈ 0.002), visibility
  `clamp(0.75 + 0.9·(n̂·toCam), 0.05, 0.99)` from each landmark's outward normal (0.05 if out
  of frame), world landmarks = camera-rotated (in the crop-ray frame, see the notes),
  hip-centered positions plus noise (xy 1 cm, z 2.5 cm). Off-frame points get an extra 6–10 cm bias, so the code must not trust them.
* **Realistic seated postures (v3).** `shoulderRound` (metres): the shoulder joints move
  forward of the top of the trunk (and 0.35× inward, 0.25× down) while the neck still rises
  from the trunk, so — as for MediaPipe's shoulder landmarks — the ears read less far ahead
  and the hip→shoulder chord leans forward. `eyesOnScreen(p, frankfortDeg)` pitches the
  head (relative to the neck) so that its Frankfort plane sits at the given angle: every
  realistic posture keeps the eyes on the screen. `GOOD_SEATED`: upright (several head and
  thigh variants, thighs ±10°) and reclined 5–15° against the backrest with the head
  stacked (thighs ±5°). `BAD_SEATED`: lying in the chair (trunk 30–50° back, pelvis
  10–20 cm forward and 2–4 cm down, the neck craned to keep the eyes on the screen,
  shoulders rounded; also head back with the chin tucked, knees ±8°), slumped (trunk
  compressed 10–14% and rounded, chord 20–25° forward, head forward; and slouched back with
  the pelvis tucked and the head poked forward), and a perched forward hunch (20–35°).
* **Required tests** (grid of ≥ 40 viewpoints):
  1. Good posture passes setup from every viewpoint where `inView` holds — under the v3
     judge: verified and saved by the local judge wherever the camera can verify the
     essential checks (thighs or a near profile with a hip: about half the grid); elsewhere
     the session waits (`needsVerification`, the view instruction, no capture, no wrong
     advice from a measured essential check), offers "save anyway", and a (simulated) cloud
     reviewer's confirmation saves it. With `body` gravity, angle features are within ±6°
     of the truth.
  2. Each bad posture fails its own check with the right instruction (and direction for
     lateral ones) from every viewpoint where that check is measurable.
  3. After a setup at a viewpoint, every issue at every stage magnitude is detected at the
     expected stage (±1), and every viewpoint where it is measurable detects it at stage ≥ 1.
  4. No false alerts: 10 simulated minutes of good posture with micro-motion (±3°, ±1 cm),
     a 30° swivel, a 40° head turn, and 5 s glances down produce no alerts.
  5. Partial view: head plus one shoulder only (frame cut off), and a true profile, still
     yield GOOD frames and head-forward detection.
  6. (v3, `seated.test.ts`) No bad seated posture is ever saved by the local judge, from
     any viewpoint (without a reviewer, and with `review: 'auto'`); lying is told to sit up
     wherever a hip is in view; every good seated posture is verified where the camera
     allows and is never coached for long on a measured essential check; the head-on-trunk
     angles match the truth from every viewpoint with any gravity and the assumed FOV;
     lying back after a good setup raises Slouching from every view (stage ≥ 2 from 35°
     where the trunk is visible), a brief lean back does not.
  7. (`phantoms.test.ts`) Phantoms (`SimOptions.figure`: the body moved, turned and
     scaled, its world landmarks human-size): a figure lying flat across the view on a desk
     below any grid camera is never GOOD; with a measured gravity a flat figure in any
     orientation is never GOOD; a small print, a poster figure and a person 4.5 m away are
     too far. An empty chair with a phantom keeps the engine AWAY (uncalibrated, and after
     the user leaves), raises no alert, and keeps setup searching. Every seated posture —
     the extremes lying back 50° with the head going along and a 35° hunch included — stays
     GOOD from every viewpoint, also with the saved baseline's gravity.

## 11. Constants (defaults)

| Constant | Value | Constant | Value |
|---|---|---|---|
| `V_SEEN` | 0.5 | `HFOV_ASSUMED` | 65° |
| `UP_MAX_TILT` | 60° | `SWIVEL_HOLD` | 15° |
| `HOLD_S` / `CAPTURE_S` | 1.5 / 3 s | `BREAK_S` | 0.7 s |
| `FORCE_AFTER_S` | 20 s | setup min GOOD frames | 15 |
| `τ_metric` / `τ_scale` | 0.6 / 1.0 s | `HYST` | 0.75 |
| outlier jump / max consec | 0.35 / 3 | `DT_CAP` | 0.5 s |
| `AWAY_ENTER/EXIT/FULL_RESET` | 2.0 / 1.5 / 30 s | `RECAL_D_MIN/MAX`, `RECAL_SUGGEST_S` | 0.5 / 1.8, 10 s |
| sink stages | trunkFwd 10/18/28°, drop 5/10/16 cm, torso 0.07/0.12/0.18, recline 20/28/36° (v3; `RECLINE_CRANE_GAIN` 1.5) | headForward | neck 10/18/28°, neckDrop 0.15/0.28/0.42, pitch 15/25/35° |
| near profile | `SIDE_VIEW_YAW` 75–105°, setup hysteresis `SIDE_VIEW_YAW_HYST` 5° | forward-trunk corroboration | `VERIFY_HEAD_ON_TRUNK_PER_DEG` 1°/° |
| v3 judge | recline limit −25° (lying below −32°); lying: neckOnTrunk > 12°, and headOnTrunk > 36° with a known trunk < −18°, else > 48°; leaning in: headOnTrunk < −8°; corroboration: headOnTrunk ≥ 0° | v3 setup | `UNVERIFIED_FORCE_AFTER_S` 3 s, `ASSESS_RELATIVE_WINDOW_S` 2 s, `HIP_TWIST_HYST` ±3° |
| lean stages | trunkLat 6/11/18°, neckLat 8/14/22°, shoulderTilt 5/9/15°, headRoll 8/14/22° | tooClose | forward 7/13/19 cm |
| presence: depth / neck and trunk from up | `PRESENCE_MAX_DEPTH_M` 3.0 m, with a baseline ×`PRESENCE_BASELINE_DEPTH_RATIO` 2.5 of its depth (≥ +1.0 m, ≤ 4.5 m) / `PRESENCE_NECK_MAX` 72° (trunk from `PRESENCE_TRUNK_MIN_M` 0.2 m) | presence: shoulder line / pitch search | `PRESENCE_SHOULDER_TILT_MAX` 45°, falling from a 25° recline to 8° at 72° (`PRESENCE_ROLL_FULL_UNTIL` / `_AT_NECK_MAX`) / `PRESENCE_PITCH_MIN…MAX` −45…75° |
| presence: tracking a stale gravity | `PRESENCE_TRACK_GAP_S` 0.5 s, `PRESENCE_TRACK_JUMP_M` 0.3 m, `PRESENCE_TRACK_TURN_MAX` 40° | | |

---

## Implementation notes (deviations found by the simulator)

The v2 implementation (`src/renderer/src/posture/`) follows this spec except where the
§10 simulator (or a real recording) exposed a real problem. Each deviation is listed here;
the constants live in `constants.ts`.

**World frame: viewing-ray correction (§1).** MediaPipe predicts world landmarks from a
crop centred on the body as if the crop were viewed along the optical axis; only the
crop's in-plane roll is undone. For a user off the image centre the world frame is
therefore rotated against the camera by the angle `α` between the optical axis and the ray
to the crop centre: up to half the FOV at the frame edge (20–35° on wide webcams). This is
inferred from the model's design, not documented. `rayCorrected` (features.ts) first
rotates every world landmark by the shortest rotation that takes camera `+z` onto that
ray, which brings them into true camera axes. The ray goes through the image hip midpoint, also when
the hips are below or beside the frame: BlazePose builds its ROI around the hip centre it
predicts (detector alignment keypoint, then auxiliary landmark 0 of the previous frame)
whether or not the hips are visible, and the reported off-frame hips are that model's
extrapolation. (An earlier version switched to the shoulder midpoint as the hips left the
frame; with a 3% blend band that swung the neck angle by 20–26° within 3% of frame height,
so hip jitter at a desk webcam's bottom edge swung the readings.) The shoulder midpoint is
only a fallback for non-finite hips, and the point is clamped to 50% outside the frame as a
guard against wild extrapolations. The simulator renders with the same rule, so it checks
that the correction inverts this model, not that the model matches MediaPipe; the real
recording keeps its hips inside the frame and does not settle it either. The ray angle uses the assumed focal length, so
world-based angles now depend a little on the FOV. For a 55–85° webcam the remaining
error is `|α − atan(tan α · f_true/f_65)|`, about 30% of `α` at 85°, instead of the whole
`α`. Deviations from the baseline barely change.

**Landmark trust and pair points (§3.1).** Pair points and pair vectors are weighted by
*in-frame trust* (0 at the image edge, 1 from 3% inside) instead of `vis²`. With `vis²`
weighting, a pure 40° head turn reads as ≈ 18° of head-forward because the ear that is
still visible has moved ~5 cm forward. Points just outside the frame are extrapolated by
the model (the simulator biases them 6–10 cm). The neck vector is `ear point − shoulder
midpoint`; the ear *midpoint* does not move under head yaw. The **shoulder midpoint is
reconstructed**: each in-frame shoulder proposes itself plus half the world shoulder
vector (the model predicts the other shoulder's position even off-frame), and the
proposals are trust-weighted. With one shoulder cut off, the midpoint stays on the body
axis instead of collapsing onto the visible shoulder 18 cm to the side. A swivel then
moves neither the neck vector nor the `anchor`. The trunk keeps the per-side pair vector,
so it never gains a lateral offset when one side is cut off.

**GOOD frame (§2).** A GOOD frame additionally needs an ear and a shoulder inside the frame
and ≥ 2 measurable scale segments. A head cut off at the top (only the nose visible)
cannot be measured or calibrated, so the user is coached to move into the picture
instead.

**Presence plausibility (§2).** MediaPipe finds a "person" in anything person-like and
reconstructs it at human size. A real recording: with the chair empty, a printed anime figure
on the desk mat, lying flat in front of an elevated camera, was tracked as "Seeing head,
shoulders & hips"; sitting time ran, break reminders would have fired and setup coached the
print. Posters and people behind the user are the same risk. A GOOD frame therefore also has
to be plausible for someone sitting at the screen (`presenceReject`, features.ts; the
reasons are exposed as `FrameReject`):
- *Distance* (`'too-far'`). The shoulders' perspective-fit depth (`f / ppm`, assumed 65° FOV)
  is ≤ `presenceMaxDepth`. Without a baseline (setup, an uncalibrated engine) that is
  `PRESENCE_MAX_DEPTH_M = 3.0 m`: desk users sit 0.3–1.5 m away and the unknown FOV scales
  the reading ×0.8–1.45 for 55–85° lenses, so a desk user lying back reads ≤ ~2.6 m (the
  simulator's desk viewpoints: ≤ 2.6 m). A small figure is reconstructed at human size, i.e.
  ×(person / figure) farther away, and a person 4 m away reads ≥ 3.1 m through any lens of 52°
  or more (3.5 m away: through ≥ 58°). A figure of scale s at distance d is indistinguishable
  from a person at d / s — the image is identical — so only that equivalent distance can be
  judged. With a baseline of this camera (`ExtractOptions.baselinePpm`, set by
  `extractOptionsFor`) the bound follows the user's own depth D_b read through the same lens:
  `max(2.5·D_b, D_b + 1 m)`, at most 4.5 m. The ratio of two depths read through one lens does
  not depend on its FOV, so a user who sat 0.8 m away is followed out to ~2 m (the
  recalibration hint starts at 2× the setup distance) while a figure or a person reading
  ≥ 2.5× farther is not the user; and a user who set up 1–2 m from a wide-angle webcam can lean
  back without crossing the absolute bound.
- *Uprightness* (`'not-upright'`). A seated user's neck (shoulder midpoint → ear point) is
  within `PRESENCE_NECK_MAX = 72°` of up: lying back 50° with the head going along, or a 35°
  hunch with the head forward, stays ~15–20° inside it; a body lying flat is at 90°. The
  trunk (hip → shoulder, a hip seen, ≥ 20 cm) is held to the same bound: it is three times
  longer than the neck, so its direction is far less noisy (the neck's depth noise in the
  simulator, ~10°/frame, let ~5% of a flat figure's frames through on the neck alone;
  hallucinated hips move the trunk by ≤ 12°). Gravity, however, is often unknown: camera-only
  gravity from a 60°-pitched camera is 60° off, so a fixed test against camUp would drop a
  user leaning toward a steep camera (a 40° hunch under a 50° camera read 69° with the true
  pitch, 119° against camUp). The test is therefore **pitch-free** (webcams are level, roll
  ≲ 3°, at an unknown pitch): the pose is upright if SOME level camera pitch in −45…75°
  (`PRESENCE_PITCH_MIN/MAX`, a margin around the supported −30…65°) puts neck and trunk
  within 72° of up and the shoulder line (both shoulders in the frame) within
  `PRESENCE_SHOULDER_TILT_MAX = 45°` of horizontal. The user's true pitch is always such a
  witness, so no real user is rejected for the camera's angle. A flat figure lying ACROSS
  the view (as desk-mat prints do) has its neck and trunk along the camera's horizontal x
  axis, which is perpendicular to every level up: rejected from every camera (the simulator:
  within ±10° of across from every grid camera, also off-centre and through wide lenses).
- *Roll budget* (diagonal prints). A flat figure at heading h from the line of sight, seen by
  a camera pitched p, has its neck at `cos h · sin(p − q)` along the up of a witness pitch q,
  and its shoulder line at `sin h · sin(p − q)`: with only the bounds above, a witness pitch
  far below the real one (the camera "looking up" 10–45°) made a print up to ~65° from the
  line of sight (25° off across) upright enough — the real screenshot's figure lies visibly
  diagonal. For that witness the figure is reclined AND rolled at once (h = 60°: reclined
  55–68° with the shoulders 32–45° off level), which a seated user is not: one who leans far
  sideways is upright in the body's sagittal plane, one lying back far keeps the shoulders
  level. So the shoulder-line tilt allowed falls with the recline — the trunk (else the
  neck) in the body's sagittal plane, its sideways part removed so a lean is not counted twice
  — from 45° at a recline of `PRESENCE_ROLL_FULL_UNTIL = 25°` to `PRESENCE_ROLL_AT_NECK_MAX =
  8°` at 72° (`rollMaxAt`). In the simulator (every grid camera, centred, off-centre and
  life-size placements, face up or down), prints 55–90° from the line of sight (≤ 35° off
  across) are GOOD in < 1% of noise-free placements (off-centre ones, whose view ray turns them)
  and < 3% of noisy frames — never 1.5 s in a row, so presence stays away (before: 60–80% of
  noisy frames); 50° from it: 14%. Real users are rejected in 0.09% of noisy frames (lying back
  60–65° with roll noise; before: 0.07%).
- *Measured gravity.* A flat figure lying ALONG the line of sight is a rigid rotation about
  the camera's x axis away from a reclined user under another pitch — e.g. lying flat, head
  away from a 60° camera, is exactly a user reclined 30° under a level one: no pitch-free test
  can tell them apart. When the pitch is measured, neck and trunk must also be within 72° of
  that gravity (`ExtractOptions.gravityKnown`), which rejects a flat figure in any
  orientation. Measured means: thigh gravity (`upSource 'body'`, the default), or at runtime a
  baseline with `'body'` or `'hips'` gravity (`baselinePitchKnown`; in the simulator within
  ~11° of the truth, so a flat figure reads ≥ 79°, a user lying back 50° ≤ 61°). Camera-only
  baselines are not: without a trunk they keep the assumed pitch (20° off from a camera
  looking up), and the trunk refinement of a turned body recovers only ~cos(yaw) of the pitch
  (23–30° off at 60° yaw). A hip-line estimate during setup is not either (facing the camera
  it has no pitch).
- *A stale measured gravity.* The baseline's gravity is only as good as the camera's aim: after
  the webcam is re-aimed by ~35° (or "Keep it for this camera" adopts a baseline from a camera
  pitched differently) a user lying back 40–50° reads 75–85° from it and would vanish instead
  of being flagged. The engine therefore follows the **tracked user**: a track is established
  by 1.5 s (`AWAY_EXIT_S`) of fully GOOD frames, each continuing the previous one (shoulder
  anchor within `PRESENCE_TRACK_JUMP_M = 0.3 m`, neck direction — head − anchor, camera axes —
  within `PRESENCE_TRACK_TURN_MAX = 40°`; the simulator's frame-to-frame p99.9 is 0.23 m /
  35°), and is followed by every GOOD frame that continues it, for up to
  `PRESENCE_TRACK_GAP_S = 0.5 s` between them. While present and tracked, a frame that fails
  only the measured-gravity test (the pitch-free test still passes) and continues the track
  counts as GOOD. A figure never builds a track: a noisy frame that slips through now and
  then is not 1.5 s of continuous ones, and the jump from the user to a print on the desk
  breaks the track (the simulator: the pose model jumping straight from the user to the print,
  no gap — every desk heading and size stays away). Not covered: a user who is ALREADY lying
  back 40°+ when they are first seen after such a re-aim is not acquired until they sit up
  (no alert either way); with a re-aim of 45° even an upright user hunching 25° reads beyond
  72°. A camera moved that far invalidates the baseline anyway (its gravity-referenced angles
  are off by the same amount); redo setup.
- *Limits.* No geometric test separates an upright, person-like figure from a person at its
  equivalent distance (d / s, see Distance): an acrylic standee or framed portrait 43 cm tall
  0.6 m from the camera, or a life-size poster ≤ 2.7 m away (65–70° lens), reads like a person
  sitting 2.4–2.7 m away and is GOOD without a baseline (with one taken at ≤ 1 m it is too far).
  A flat print lying within ~45° of the line of sight passes the pitch-free test (only a
  measured gravity rejects it). The depth bound trades narrow lenses against ultra-wide ones,
  because the FOV is unknown: a person 3.5 m away through a 55° lens reads 2.9 m (GOOD), while
  without a baseline a 110° lens reaches the bound with the user ~1.5 m away (lying back 40°:
  ~1.3 m), a 120° lens at ~1.1 m; 90–100° lenses only beyond 1.5 m. Once set up, the bound is
  relative to the user's own distance. With camera-only gravity and a profile view, a 40° hunch
  with the head dropped toward the desk (neck ≥ 75° from vertical) is rejected; front and
  angled views accept it.
- An image-plane test (the neck pointing "up" in the picture) was tried and dropped: a user
  leaning toward a camera above them is seen with the head *below* the shoulders (the neck
  dips under the line of sight), and the neck's image direction is noise when it runs near
  the viewing ray. The world-landmark vectors already carry the image-plane direction.

**Gravity (§3.2): a level-camera model.** Webcams are mounted level — their **roll** (the
rotation about the optical axis, i.e. the tilt of the true vertical at the image centre,
`cameraRollDeg`) is within `UP_MAX_ROLL = 3°` — while their **pitch** can be anything
(−30…65°: laptops look up, monitor-top and shelf cameras down). Gravity is therefore
estimated as a camera pitch only: `up = cameraUp(pitch)`, roll 0. Body cues never roll it.
(The spec's rules fit roll and pitch from the hip line and thighs. A turned body's hip line
seen through a pitched camera rises or falls in camera axes from the pitch alone, and
hallucinated hips or knees (under a desk, at the frame edge) tilt it at random; both were
read as camera roll: 14–43° in the simulator, 30–41° on a real elevated webcam, drawn as a
dashed "true vertical" visibly off the door frames and coached as phantom "Level
shoulders"/"Centered weight". A later roll clamp at 12° only capped it: the live vertical sat
at the clamp, 12.4° off.)

The hip line counts when both hips are inside the frame and at least one is seen (in a
profile the far hip is occluded but predicted; only the direction is used), 8–50 cm long.
- *Hip line* (`hipLineUp`). For a level camera a horizontal line `H` is horizontal at the
  pitch `p_H` with `tan p_H = −H_y/H_z`: a pitch tilts the line in the picture as far as the
  body is turned (the far hip of a turned body seen from above sits higher). That needs a
  lever: with β = the angle between `H` and camera x (≈ the body's yaw), the line's depth
  noise and the camera's own small roll enter the reading ~1/sin β-fold. The pitch is
  `w·p_H` with a weight `w` (`hipPerspectiveWeight`) rising smoothly from 0 at
  `UP_HIP_PERSPECTIVE_MIN = 8°` to 1 at `UP_HIP_PERSPECTIVE_FULL = 16°`: a line facing the
  camera gives no pitch (unknown, level), a turned one gives it. A line steeper than any
  camera explains (`|p_H| > 80°`: an in-plane tilt) is not perspective. If the reading — its
  pitch plus the roll it would still need — is more than `UP_MAX_TILT = 60°` from camUp, the
  hips give no estimate.
- *Thighs* (`thighHipUp`): a knee seen with vis ≥ 0.7, 45–135° between thigh and hip line,
  and a trunk within `UP_MAX_TRUNK_TILT = 50°` of the estimate (else the frame counts neither
  for nor against the thighs: the user may be hunched). `K × H` is ⟂ `H`; the thighs' own
  error (a slope of ±10–15°, or a hallucinated knee) is a rotation about `H`. Facing the
  camera that rotation is pitch, which only the thighs measure. For a turned body it shows
  as roll (slope·sin β) — which a level camera does not have — plus a pitch error
  (slope·cos β) that tilted level shoulders by 5–8° at 30–40° yaw. So the estimate is
  rotated about `H` to the member nearest the thighs' own whose roll a level camera
  explains: within `UP_MAX_ROLL` plus 2 standard errors of the measured roll (from its
  per-frame scatter; the simulator's depth noise makes it 2–3° at steep cameras), with
  spread `UP_THIGH_SIGMA = 8°` on the rotation. This rests on the roll, i.e. mostly on the
  precise image-plane directions rather than the hips' depth. Of that member only the pitch
  is kept.
- *Camera*: `camUp`. Estimates past `UP_MAX_TILT` fall through to the next source.
- *Level unconfirmed.* A hip line that would still need more than `2·UP_MAX_ROLL` of roll at
  its pitch (a camera rolled past the prior, hallucinated or tilted hips; also a nearly
  facing body under a steep, unknown pitch) never tilts the vertical, but the UpEstimator
  reports `levelConsistent = false`, and setup then does not judge `shouldersLevel` (the
  only gravity-referenced lateral check) — see AI assessment.

*UpEstimator* keeps a sum per source; a source needs 5 frames to outrank a lower one. The
hip source averages the frames' unit hip lines (sign-aligned) and reads the mean line once
(a per-frame reading is a nonlinear function of a noisy line). The thigh source averages
the raw `K × H` and applies `thighHipUp` once, with the mean hip line and the roll's
standard error. `pitchWeight` reports how much of the pitch was observed (1 thighs, `w`
hips, 0 camera) for the baseline's trunk refinement. Each frame passes only a loose sanity
gate (`UP_FRAME_MAX_TILT = 80°`); the *mean* is gated at 60° (gating each frame would keep,
for a camera near the bound, only the frames noise pulled under it). A source is used only
when ≥ 70% of the frames that had its inputs produced it.

*Hip consistency*: a seated person's pelvis and shoulder lines face the same way. Hips
whose line is twisted more than 15° against the shoulder line about the trunk axis are
treated as hallucinated (e.g. predicted under a desk with high visibility) and ignored:
no hip line, no thighs, no trunk. The verdict is the median over the last 30 frames that
show both lines, and it is made only after ≥ 5 such frames. Since v3 the live verdict has
a hysteresis of ±3° (`HIP_TWIST_HYST`: distrust above 18°, trust again below 12°): the
median of the first few noisy twists flipped the hips — and with them the gravity source
and the trunk, i.e. the strict judge's verification — off for single frames. A one-shot
verdict over a capture (`buildBaseline`) keeps the plain median. Setup exposes it as
`hipsTrusted`. At runtime the engine uses the hips exactly when the baseline did
(`trunkFwd !== null`). (With the hysteresis the real elevated-camera recording's hips —
predicted under the desk — are now judged hallucinated: its trunk is not used.)

**Body frame (§3.3).** The lateral axis always comes from the body, in this order:
1. the hip line;
2. the shoulder line (both shoulders in the frame);
3. at runtime, the baseline's forward (`forwardHint`; `F̂` is then not re-oriented);
4. the shoulder line built with the other shoulder's predicted position, if it is ≥ 15 cm;
5. the ear line.

The axis never comes from the head while the body can give it, because the head turns on
its own. `F̂` is oriented toward the nose: the in-frame nose, else the baseline forward,
else any nose. This also fixes swapped L/R labels (`labelsSwapped`). The sign test uses
the forward of the body's own up (`Û` plus the neck axis). With a badly wrong gravity,
such as camera-only gravity from a steep camera, the nose can lie almost along `Û`. A
test on `F̂` alone then flipped the frame on noise.

**Lateral features (§3.4).** Every lateral feature (`neckLat`, `shoulderTilt`,
`headRollRel`, `trunkLat`) needs both points of its pairs inside the frame and a body yaw
below `LAT_MAX_YAW = 60°` (the spec asks this only of `headRollRel`). The engine instead
extracts them up to 68° and gates on its smoothed yaw (§5–§9 below). The lateral angles
are gravity-free where possible: an error in `Û`'s pitch would scale them by
`1/cos(error)`, ×2 for a 60°-tilted camera.
- `trunkLat` is the angle of `T` out of the pelvis's sagittal plane (⟂ `Ĥ`).
- `neckLat` is measured relative to the trunk when both hips are seen: the tilt of `N`
  within the trunk's frontal plane, spanned by `T̂` and the pelvis line (`neckLatRef =
  'trunk'`). Otherwise it is the angle of `N` out of the body's sagittal plane (⟂ `L̂`;
  `'gravity'`), so a lean of the whole upper body is still seen. It is nullable
  (`CalibrationBaseline.neckLat: number | null`). The baseline stores one reference, and
  only like is compared with like.
- `headRollRel` is measured in the body's own frontal plane, spanned by `L̂` and the trunk
  (else the neck), because `F̂` inherits gravity errors.

**Scale and positions (§3.5).** The weak-perspective `ppm` ratio was replaced by a
perspective placement. Ray-corrected world landmarks share the camera's axes, so
`camera = world + T`, and each seen landmark gives two equations linear in `T`
(`u·(z+T_z) = f·(x+T_x)`). Per-segment image/world ratios differ by up to ±25% within one
frame (segments that run in depth while off-axis). The old `ppm` and the anchor depth
therefore jumped whenever the set of visible segments changed: a 30° swivel produced 10 cm
of false "sink". `ppm` is now `f / Z_shoulders`. Positions (`anchor` = reconstructed
shoulder midpoint, `head`) and the short nose→ear head vector are pinhole back-projections
of the precise 2D landmarks at depth `z + T_z`. All longer body vectors stay on the world
landmarks, because back-projection over large depth spans is biased when the assumed FOV
is wrong. `view.opticalYawDeg` is the horizontal angle between `F̂` and the optical axis.
Unlike `view.yaw`, which uses the anchor's ray, it does not shift when the user leans: a
forward lean moves the anchor ray by ~15° up close.

**AI assessment (§4).** Without thigh gravity, the camera's pitch leaks into sagittal
angles as ≈ `pitch·cos(yaw)`; a 50°-elevated frontal camera made an upright user read 50°
forward. The rules:
- **Thigh gravity** (`gravity: 'strong'`): every check is absolute. The *upper* sagittal
  limits get k = 1.3, because thigh gravity assumes level thighs, and seated thighs slope
  ±10–15°, which shifts every absolute sagittal angle one-for-one.
- **Fixed lower limits.** For every source, the limits for reclining (−35°) and chin-up
  (−15°) do not scale. k models how far an unknown tilt can push a reading *forward*; it
  does not allow more reclining.
- **No thigh gravity, trunk.** The trunk is judged only in the near-profile window of
  75–105° *optical-axis* yaw, with k = 1.3 for camera roll. Beyond 105°, behind the
  profile, the pitch leak grows as |cos yaw| again. Outside the window the trunk check is
  `unknown`.
- **No thigh gravity, head.** The head checks are judged relative to the trunk when the
  trunk is visible (`neckFwd − trunkFwd`, `headPitch − trunkFwd`); the camera bias then
  cancels exactly (k = 1.3). Without a visible trunk they are absolute, with k = 1.3
  (side or hips gravity) or 1.6 (camera).
- **Lateral.** Lateral checks use k = 1.0, or 1.4 with camera gravity. `shouldersLevel` is
  `unknown` with camera-only gravity, and while the hips contradict a level camera
  (`AssessOptions.levelUnconfirmed`, from `UpEstimator.levelConsistent`): it is the one
  lateral check measured against gravity, and the estimate keeps the camera level.

The assessment exposes `gravity`, `headRelativeToTrunk`, an optional `slack` and
`unverified`. `unverified` lists the essential checks that the local judge could not make
for this posture from this camera: `trunkUpright` (the hips are out of view, or there is
no thigh gravity outside the profile window, or — v3 — the head on the trunk contradicts
the absolute reading) and, since v3, `headOverShoulders` (neither a gravity reference nor
the trunk). (In v2 these never blocked; in v3 they keep the posture from being `verified`,
§4a.)

**Verification (§7, v3).** The local judge never saves a posture it could not verify:
- **Without a review** the session keeps coaching (`needsVerification`) and offers
  "save anyway" after `UNVERIFIED_FORCE_AFTER_S`. (v2 saved it with `verified: false`,
  `unverifiedChecks` and a `notice`.)
- **Review mode.** `review: true` reviews every capture. `review: 'auto'` reviews only
  captures that are not verified. While reviewing, the session waits in `'reviewing'`.
- **Review outcomes.** `acceptReview()` → `done`, verified. `rejectReview(instruction)` →
  coaching, with the instruction shown. `skipReview()`, for when the review could not run →
  `done` only if the local judge verified everything; otherwise coaching without a
  reviewer, with `canForce` on.
- **Forced capture.** It skips the review and the final exam, is saved with
  `verified: false`, and shows no notice, because the user chose it.

**Setup session (§7).**
- **Live judgement.** The session assesses the per-feature median of the last 1 s of GOOD
  frames. While holding or capturing, tolerances widen ×1.2 (Schmitt trigger).
- **Warm-up.** The first verdict waits for 5 GOOD frames counted since the user came into
  view, not the frames in the 1 s window, so it also works below 5 fps. The count resets
  when the user is lost (BAD for > 1 s → `searching`).
- **Baseline frames.** The baseline uses the hold's GOOD frames plus the capture frames
  that were judged good (a forced capture keeps all of them). It stores 20%-trimmed means,
  which are as robust as the median here and ~25% more precise. The capture needs ≥ 15
  GOOD frames of its own and may extend to 6 s to collect them before failing `lost`.
- **Wobble handling.** An `adjust` verdict shorter than `BREAK_S` during the capture is
  tolerated, but it marks the capture as wobbled. `buildBaseline` drops brief-movement
  outliers: frames whose neck angle or image-plane anchor lies beyond 4 robust σ plus
  2°/1 cm, at most 25% of the frames. If a wobbled capture then fails its stability check,
  the session goes back to coaching instead of failing `unstable`, at most 2 times in a
  row.
- **Stability** is noise-corrected. Motion variance = robust (10%-trimmed) variance − half
  the robust variance of frame-to-frame differences. The limit is 4² deg² / (2 cm)² plus
  an allowance of `5·noiseVar/√n`. The spec's MAD ≤ 4° fails every capture of a perfectly
  still user under the simulator's depth noise (~10° per frame for a frontal neck angle).
  The anchor is measured in the image plane.
- **Gravity refinement.** Without thigh gravity and outside the profile window, the part of
  the baseline's pitch the estimate did not observe (`1 − pitchWeight`: all of it for camera
  gravity or a hip line facing the camera, none for a turned one) comes from the captured
  trunk: the pitch of `up` rotated about the body's left axis by the median `trunkFwd`.
  Once the posture was judged good, the trunk is the best sagittal cue left; it keeps the
  engine's drop and toward-the-screen metrics from being rotated by an unknown pitch. Only
  the pitch is taken and the camera stays level: the full rotation about a turned body's
  left axis also rolled the camera (a 10° capture lean rolled a 45°-turned body's `up` by
  7°, drawn at runtime as a tilted vertical).
- **Review rejections.** After a rejection the session coaches for at least
  `REVIEW_RETRY_S = 5 s` before the next hold (rejection pause). After 2 rejections,
  `canForce` turns on, also while capturing or reviewing; forcing a pending review saves
  it unverified. After 3 rejections, `autoCapture` becomes false: no automatic captures
  until `restart()` or `force()`. `canForce` is also earned after 20 s of coaching or
  holding, and it is kept across `restart()`.

**Engine (§5–§9).**
- **Stale sub-metrics.** A sub-metric that becomes unavailable holds its smoothed value,
  but stops driving severity after 1 s. A hidden nose had kept a stale stage-3 pitch alive
  through a head turn.
- **Smoothed gates.** The swivel, view-yaw and head-yaw gates use values smoothed with
  τ = 0.6 s, so single biased frames cannot pass them.
- **Swivel hold.** An unknown camera tilt leaks into gravity-referenced angles as the body
  swivels: ≈ `tilt·(cos ψ − 1)` sagittally, `asin(sin tilt · sin ψ)` laterally. While
  `ψ > SWIVEL_HOLD = 15°`, the lateral gravity-referenced metrics (`shoulderTilt`,
  gravity-referenced `neckLat`) are held for every gravity source. The sagittal ones
  (`trunkFwd`, `neck`, `neckDrop`, `pitch`) are held too, unless gravity came from the
  thighs.
- **Head-turn holds.** With only one ear in the frame and the head turned more than
  `HEAD_TURN_HOLD = 20°` (or the nose hidden), every head metric is held, because the
  neck vector rides on that ear. Without thigh gravity, head pitch is also held while the
  head is turned more than 20°.
- **Lateral yaw hysteresis.** Features are extracted up to 68° (`LAT_MAX_YAW +
  LAT_YAW_SLACK`). The engine switches the lateral metrics off when the smoothed view yaw
  exceeds 63° and back on below 57° (±`LAT_GATE_HYST`). `shoulderTilt` with camera-only
  gravity additionally needs yaw ≤ 20°.
- **Lean direction.** The direction is the sign of the sum of the signed lean
  sub-metrics, each in units of its own stage-1 threshold, so one noisy sub-metric cannot
  flip the side. `shoulderTilt` and `headRoll` deviations are negated so that every lean
  sub-metric reads "+ = toward the left" (a lean to the left *lowers* the left shoulder).
- **Long frame gap.** A gap of more than `AWAY_FULL_RESET_S` (30 s) between two
  `processFrame` calls counts as a long absence: smoothing is reseeded, and all episodes
  and cooldowns are reset. Presence never sees such a gap (pause, system sleep, camera
  restart).
- `engine.availability` reports data availability per issue.

**Episode machine (§8).** The v1 machine, plus three changes:
- **Long gaps.** A gap of more than 30 s between two `step()` calls fully resets the
  machine, cooldown included, like a long AWAY. Before, a 60-minute pause counted as
  `DT_CAP` (0.5 s): an alerted episode carried over, and a pending one fired on the first
  frame with the pause in its duration. Shorter gaps still add at most `DT_CAP`.
- **Data-loss resets arm the cooldown.** A data-loss reset (> 10 s unavailable) of an
  episode that already alerted starts the cooldown, as a recovery does. Before, the next
  toast could come ~23 s after the last one.
- **Quiet-period escalation.** The cooldown remembers the highest stage alerted by the
  episode(s) that armed it. With escalation on, a new episode during the cooldown alerts
  (kind `'escalation'`) when its stage is higher than that, once it has met the normal
  dwell, held the worse stage for `ESC_DWELL = 4 s`, and is `ESC_MIN_GAP = 30 s` past the
  previous alert. The same or a lower stage still waits for the cooldown to end. Escalation
  inside an episode is unchanged.

**Simulator (§10).** The simulator adds elbows, wrists and feet, and optional desk
occlusion and label swaps.
- **Hallucinated hips.** `HallucinatingSim` reports desk-occluded hips and legs (world
  coordinates biased 6–10 cm, so the hip line can point anywhere) with visibility 0.9, as
  MediaPipe did in the real recording (0.83–0.89). The simulator's own hips are otherwise
  exact, which is why it never exposed the false roll: only hip lines seen through a
  pitched camera do.
- **Camera roll.** The grid's rolls are its former ones clamped to the level-mount prior
  (−8/5/8° → −3/3/3°): absolute lateral accuracy from an 8°-rolled camera without a
  horizontal cue is not physically available to a level-camera model. The former rolls are
  re-run (`viewpointGrid(ROLLED_GRID_ROLLS)`) for graceful degradation: setup completes,
  the estimate stays level, the drawn vertical is off by at most the camera's own roll
  (+1°), and 10 minutes of good posture raise no alert. Required 1 compares the baseline's
  `up` with `hypot(6° + residual, |roll|)`, since the grid's ≤ 3° roll is not recovered.
  A still user fails the capture's stability check in ~1% of simulator captures (neck noise
  ~8°/frame, independent of gravity); required 3 retries such a setup once, as the app's
  "Hold still" flow does.
- **Gravity regressions** (`gravity.test.ts`). A body turned 30–60° under a level camera
  pitched 30–60° (hips only, and with thighs): roll ≤ `UP_MAX_ROLL`, the drawn vertical
  (`projectUp` at the features' anchor) within 3° of upright and of the truth (measured:
  roll 0°, drawn ≤ 0.9°), hip-line pitch within 8° below the bound (measured ≤ 4.5°).
  Hallucinated hips and knees under a level camera: per frame, accumulated and live, roll
  ≤ 3° and the drawn vertical within 3° (measured ≤ 0.4°). A camera rolled 8° facing the
  user stays level, leaves `shouldersLevel` unknown and completes setup; a level or
  3°-rolled one is confirmed and a raised shoulder is coached. The real recording (both
  4:3, the camera's aspect, and 16:9): roll ≤ 3° accumulated, per frame and live, and so is
  the drawn vertical (measured 0°; its hip line faces the camera, β ≈ 6°, so its pitch
  stays unknown).
- **Crop-ray frame.** World landmarks are rendered in the crop-ray frame (`cropRay`,
  default on). It uses the same centre rule as the features, computed from the true
  projection and the true focal length. `cropRay: false` renders true camera axes.
- **Grid tolerance.** The grid's absolute-accuracy test (required 1) allows ±6° plus the
  FOV residual of the ray correction.
- **Off-centre tests.** Dedicated tests put the user at the edge of a 90° HFOV picture,
  with a crop ray > 20° off-axis. Angles and axes must match the truth within ~1° when the
  true FOV is passed, and within the residual with the assumed 65°. A features test pins
  that hips crossing the bottom frame edge (fixed world landmarks, only the image hips
  moving) change the neck/trunk angles by less than 2° per step and 5° in all.
- **Stage detection with a wrong FOV.** Required 3 lets at most one view per issue miss
  detection when only the stage-1 magnitude stays in frame and the true FOV differs from
  the assumed 65° (depth and the crop-ray angle both use the wrong focal length, so a case
  just above the threshold may read just below it; its ±1 stage check still applies).
- **Timeouts.** The simulator-heavy test files raise the per-test timeout to 60 s, so a
  loaded machine (parallel workers) does not turn a 1–4 s case into a spurious failure.
- **Measurable checks.** In the tests, "measurable" is decided by an oracle that is
  independent of the bad posture under test: the noise-free good posture must be accurate
  within 10°, and the check must be reported for the posture. Coverage assertions keep the
  oracle from hollowing out the tests.
- Issue stages are read as the sustained (median) stage over 2 s. `SIM_SEED_OFFSET=<n>`
  re-runs the grid with other noise draws.
- **Phantoms** (`SimOptions.figure`, `deskPhantom`, `uprightPhantom`). The body is moved,
  turned and scaled (a print or figurine: scale < 1); the image shows the figure, the world
  landmarks stay human-size, as MediaPipe reconstructs any person. `deskPhantom` lays it flat
  (face up or down, any heading relative to the camera's view) on a desk plane 35 cm below
  the camera, where a ray through the lower half of the picture meets it (cameras looking up
  see no desk); `uprightPhantom` stands it facing the camera at a distance (a poster, a
  person across the room). A rigid figurine is a stand-in for a print: MediaPipe's 3D guess for a
  flat drawing seen obliquely is unknown, but its image-plane geometry — which the world
  landmarks' x/y follow — is what the across test rests on.

**Known limitations.**
- **v3: what landmarks cannot show.** A slump whose only signs are a compressed, rounded
  back (the hip→shoulder chord upright because the pelvis is tucked, the head within ~25°
  of the trunk line) looks like good posture to any landmark-based judge: MediaPipe has no
  spine points. The simulator's slouched-back case therefore has its head clearly poked
  forward. At runtime, relative to a good baseline, `torso` and `drop` still catch such a
  slump; at setup only the cloud review can.
- **v3: predicted (hallucinated) hips and knees.** Hips or knees hidden under a desk are
  still predicted, plausibly and with high visibility (0.83–0.99 in the real recording,
  consistent in 2D and 3D, so neither visibility nor reprojection exposes them). When they
  pass the hip-consistency check they shift the trunk angle by up to ±12° and can give a
  wrong thigh gravity. The head-on-trunk corroboration catches a hunch read as upright
  only when the head is clearly tipped back; in the simulator (`HallucinatingSim`, 6–10 cm
  random bias) ~1% of bad-posture setups from views with thigh gravity or a near profile
  still verify. The cloud review is the backstop; a frontal desk camera without visible
  thighs never verifies the back angle locally anyway.
- **v3: noise of the head direction.** The gravity-free head-on-trunk angles rest on the
  10 cm ear→nose vector of world landmarks. Under the simulator's noise (2.5 cm depth per
  landmark per frame, ~10× real jitter) a single frame scatters by ~16° in frontal views;
  the 2 s component-wise median and the final exam's average keep the decisions stable
  (a reclined good posture is not told it is lying), at the price of a high bar for the
  lying signature where the trunk's own lean is unknown (headOnTrunk > 48°, so lying 30° in
  a frontal view gets the view instruction rather than "you're lying in the chair").
- **v3: gravity warm-up.** Over a setup's first seconds the gravity estimate still
  settles; from a steep frontal camera the thigh gravity can be 15–20° off for a moment, so
  an upright user may briefly hear "Sit back" before the posture is verified (as in v2).
  The tests count advice only after the first 5 s.
- **v3: anatomy.** The thresholds assume the simulator's face (the ear→nose line 14°
  below the Frankfort plane; real faces 6–17°) and the ear over the shoulder joint in good
  posture (real: 0–4 cm ahead, i.e. 0–15° on the neck angle). The margins (lying ≥ 45°
  vs. accepted ≤ 33° head-on-trunk) absorb this for typical faces, not for every one.
- **Thigh slope.** Thigh gravity assumes level thighs, so a thigh slope adds one-for-one
  to every *absolute* sagittal reading, and to the baseline's `up` (drop and
  toward-the-screen axes tilt by it). The ×1.3 tolerance absorbs about ±3.6° on the trunk,
  ±6° on the neck and ±9° on the gaze limit. An upright user with ±15° thighs still passes
  setup, because an upright trunk has the whole 15.6° to spare. A slope combined with a
  real lean can still push the verdict either way. Deviations from the baseline are not
  affected.
- **No thigh gravity.** In a non-profile view, absolute trunk lean is not judged locally;
  that is what the review is for. A reclined trunk with an upright head can read as
  head-forward relative to the trunk. Without a visible trunk, the absolute head checks
  assume a roughly level camera (|pitch| ≲ 10°).
- **Hallucinated knees.** The thigh estimate trusts MediaPipe's knees. In the real
  elevated-camera recording, the knees under a desk had visibility 0.83–0.89 and gave an
  `up` ~40° from the likely truth. The trunk-plausibility gate, the hip-consistency check
  and the level-camera model (a hallucinated knee can move the pitch, never the roll) guard
  against this.
- **Camera roll.** The estimate is always level. A camera really rolled by `r` (webcams:
  `|r| ≲ 3°`) leaves `r` in the vertical and in `shoulderTilt`; every other lateral angle
  is body-relative. Past ~6° a hip line facing the camera exposes it (`shouldersLevel`
  unknown); for a turned body nothing can: a hip line read with roll 0 turns the roll into
  pitch (~r·cot β), e.g. 8° at 15° yaw reads as a ~29° pitch. Deviations from the baseline
  are unaffected (the roll is constant), and the trunk refinement bounds the pitch error of
  hip-line baselines. Setup (v0.2.1) no longer confirms the back or head while the hip line
  contradicts a level camera, which closed the rolled-grid leak (0 of 723 bad postures
  saved over 3 seeds); an ~8° roll in an angled view can still, rarely, get through.
- **Viewing-ray correction.** The correction is a model of MediaPipe's behaviour, not a
  documented fact. It assumes the 65° HFOV, so it leaves the residual above on wider or
  narrower webcams.
- **Noise.** Under the simulator's noise (2.5 cm i.i.d. depth per landmark, ~10× real
  jitter), the baseline head pitch from a 50°-elevated camera has σ ≈ 2.3°. About 1% of
  setups exceed the ±6° target there. Lateral measures stop at 60° body yaw.
- **Depth scale.** Metric depth scales with the assumed 65° HFOV: toward-the-screen motion
  reads ×0.8–1.4 of the truth for 55–85° webcams, within the ±1 stage tolerance.
- **Very close views.** At ≤ 0.6 m, body parts straddle the frame edge and the readings are
  noisier.
- **Phantoms along the line of sight.** Without a measured gravity (no baseline yet, a
  camera-only baseline, early setup), a flat figure lying roughly along the camera's line of
  sight (more than ~20° from across) is indistinguishable from a reclined user under another
  camera pitch, and is rejected only when it is small enough to be too far. With a body or
  hip-line baseline it is always rejected. A life-size poster of a person close to the camera
  is upright and near: it is not rejected.
- **Phantoms under noise.** With only the neck (no hip in view) the per-frame test on a flat
  figure is noisy in the simulator (~5% of frames pass on its 10× real depth jitter). The
  engine needs 1.5 s of consecutive GOOD frames, so presence stays away; setup's warm-up
  counts GOOD frames with gaps < 1 s and could start coaching such a figure in the
  simulator. With a hip in view (the tested case, as on the real desk mat) the trunk test
  leaves no frame through.
