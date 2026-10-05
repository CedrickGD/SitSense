# SitSense — Connect your own AI model (BYOK)

Users can connect their own cloud or local AI models: a settings screen where they paste an
API key (or point at a local model server), similar in spirit to the provider screens of
OpenRouter or Cline. SitSense then uses a connected model as a **posture judge and
coach**. The on-device pose model stays the always-on detector: it runs every frame, offline
and free. A connected model is asked only at deliberate moments, so the default stays private
and cheap.

## 1. What the connected model does

1. **Setup check.** When the on-device AI says the user's setup posture is good, and before
   the baseline is saved, SitSense asks the connected model to confirm (§5). If the model says
   "adjust", its instruction is shown and coaching continues. After two model rejections, or if
   the model is unreachable, the on-device verdict decides, and the UI says so plainly.
2. **"Ask AI" on the dashboard.** An on-demand posture review that returns a score, a
   one-sentence summary and up to three concrete tips.

3. **Coach chat.** The user asks free questions in a small chat window and the connected model
   answers as a friendly ergonomics coach, using the app's live readout and stats as context
   (§7).

The model never runs per frame and never runs in the background. Nothing camera-derived
(image or live readout) is sent while monitoring is paused; a text-only coach question is
still answered then.

## 2. Privacy contract

* Off by default (`ai.enabled = false`). With it off, the app makes **zero** network requests
  (unchanged promise).
* `ai.share` decides what is sent. The default is `'sketch'`: a pose drawing of lines and dots
  on a plain background, no camera pixels. The alternative is `'snapshot'`: a downscaled camera
  frame (≤ 640 px, JPEG). Both always include the numeric measurements from the local model
  (angles and view type).
* The Settings section shows a plain-language disclosure next to the choice: who receives the
  data (the connected provider), when (setup check and Ask AI only), and what is sent.
* The `on-device` chip in the camera preview changes to `on-device · AI: <label>` while AI is
  enabled. Its tooltip names the provider and the share mode.
* Coach chat sends the conversation plus a small numeric context (§7). An image goes along
  only when the renderer attaches one, under the same rules as a review.
* Nothing returned by the model is persisted except the last test status of a connection
  (chat history lives in the renderer only).

## 3. Data model

`src/shared/ai.ts` (shared by main, preload and renderer):

```ts
export type AiProviderKind = 'gemini' | 'vertex' | 'openai' | 'anthropic' | 'openrouter' | 'openai-compatible'

export interface AiConnection {
  id: string                    // random id
  kind: AiProviderKind
  label: string                 // user-visible, defaults to the preset name
  baseUrl: string | null        // required for 'openai-compatible'; optional override otherwise
  model: string                 // model id
  enabled: boolean
  hasKey: boolean               // a key is stored (main-owned; the key itself never reaches the renderer)
  keyHint: string | null        // e.g. "…x2Ig"
  lastTest: { ok: boolean; at: number; message: string; latencyMs: number | null } | null
}

export interface AiSettings {
  enabled: boolean              // master switch, default false
  share: 'sketch' | 'snapshot'  // default 'sketch'
  useInSetup: boolean           // default true
  connections: AiConnection[]   // order = priority; first enabled one is primary, the rest are fallbacks
}
```

`Settings` gains `ai: AiSettings`. `mergeSettings` validates every field and drops unknown
kinds and malformed connections. `hasKey`/`keyHint` are **always recomputed by main** from the
key store, never trusted from the persisted file or from a renderer patch.

### Presets (`AI_PRESETS` in `src/shared/ai.ts`)

A preset is a template: it fills in the kind, label, base URL and suggested models. A
connection stores only its kind and its base URL.

| preset | kind | base URL | auth | default model |
|---|---|---|---|---|
| Google Gemini | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` header | `gemini-3.5-flash-lite` |
| Google Vertex AI (express) | `vertex` | `https://aiplatform.googleapis.com/v1` | `x-goog-api-key` header | `gemini-3.5-flash-lite` |
| OpenAI | `openai` | `https://api.openai.com/v1` | `Authorization: Bearer` | `gpt-6-luna` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` | `x-api-key` + `anthropic-version: 2023-06-01` | `claude-haiku-4-5-20251001` |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | `Authorization: Bearer` | `google/gemini-3.5-flash-lite` |
| Ollama | `openai-compatible` | `http://localhost:11434/v1` | none | user picks |
| LM Studio | `openai-compatible` | `http://localhost:1234/v1` | none | user picks |
| Custom (OpenAI-compatible) | `openai-compatible` | user-entered | optional Bearer | user picks |

**Google keys.** Since May 2026, new AI Studio keys are "auth keys" that start with `AQ.`.
Vertex express-mode keys also start with `AQ.`. Legacy AI Studio keys start with `AIza`.
**The prefix does not identify the endpoint.** So a Google connection's **Test** probes:

1. `GET {gemini}/models?pageSize=1000` with `x-goog-api-key`. A 200 means Gemini.
2. On a 401/403, `POST {vertex}/publishers/google/models/{model}:countTokens`. A 200 means
   Vertex express.
3. Otherwise it reports Google's error message.

If the probe finds the other Google endpoint, Test switches the connection's kind and says so
("This key works with Vertex AI — switched."). Error mapping: 400 `API_KEY_INVALID` and 401
`UNAUTHENTICATED` mean a bad key; 403 `SERVICE_DISABLED` or "has not been used in project"
means the wrong endpoint for this key or that the API is not enabled.

## 4. Main-process architecture (`src/main/ai/`)

* `keystore.ts`. Keys are encrypted with Electron `safeStorage` (DPAPI on Windows) and stored
  in `userData/ai-keys.json` as `{ [connectionId]: base64(cipher) }`, with atomic writes. If
  `safeStorage.isEncryptionAvailable()` is false, refuse to store the key and return a clear
  error; never write plaintext. Deleting a connection deletes its key.
* `providers/<kind>.ts`. Each adapter implements:
  ```ts
  interface ProviderAdapter {
    analyze(req: { conn: AiConnection; key: string | null; prompt: string; imageJpegB64: string; signal: AbortSignal }): Promise<string> // raw model text
    listModels(conn: AiConnection, key: string | null, signal: AbortSignal): Promise<string[]>
  }
  ```
  Use JSON-mode or structured output where the provider supports it. HTTP errors are mapped to
  short user-facing messages: `bad key`, `quota/rate limit`, `model not found`, `network`,
  `timeout`, `unexpected response`. Keys must never appear in logs or error messages.
* `judge.ts`. Builds the prompt (§5), calls the enabled connections in priority order (falling
  back on failure), parses and validates the JSON, and returns `AiPostureReview`. Timeout:
  25 s per connection.
* IPC (`src/shared/ipc.ts` + `src/main/ipc.ts` + preload). All payloads are validated in main:
  type checks, string length caps, image ≤ 1.5 MB, base URL must be `https:`, or `http:` only
  for `localhost`/`127.0.0.1`/`[::1]`.
  ```ts
  aiSaveConnection(conn: Partial<AiConnection> & { id?: string }, key?: string | null): Promise<Settings> // key undefined = keep, null = delete
  aiRemoveConnection(id: string): Promise<Settings>
  aiMoveConnection(id: string, delta: -1 | 1): Promise<Settings>
  aiTestConnection(id: string): Promise<AiTestResult>        // tiny text-only request; updates lastTest
  aiListModels(id: string): Promise<{ ok: true; models: string[] } | { ok: false; message: string }>
  aiReviewPosture(req: AiReviewRequest): Promise<AiPostureReview>
  ```

## 5. Posture review request and response

```ts
interface AiReviewRequest {
  purpose: 'setup' | 'check'
  imageJpegB64: string           // sketch or snapshot per ai.share (renderer builds it)
  share: 'sketch' | 'snapshot'
  measurements: {                // from the on-device model; null = not measurable
    view: 'front' | 'angled' | 'side'
    neckFwdDeg: number | null; trunkFwdDeg: number | null; headPitchDeg: number | null
    shoulderTiltDeg: number | null; headRollDeg: number | null; trunkLatDeg: number | null
    localVerdict: 'good' | 'adjust'; localInstruction: string | null
  }
}

type AiPostureReview =
  | { ok: true; connectionLabel: string; model: string; verdict: 'good' | 'adjust'; score: number;
      summary: string; instructions: string[] }
  | { ok: false; message: string }   // all connections failed / AI disabled
```

The prompt (system plus user) tells the model:

* It is an ergonomics coach reviewing a person seated at a computer, seen by a webcam from an
  arbitrary angle (front, angled, side, above).
* For a sketch: the image is a pose drawing, not a photo. Gray lines are the body, and a
  dashed line marks true vertical through the shoulder.
* The reference for good seated posture: ears roughly over the shoulders, trunk upright or
  slightly reclined against a backrest, shoulders level and relaxed, head level, gaze roughly
  horizontal to slightly down.
* The on-device measurements, as context it may override when the image clearly disagrees.
* Respond with **JSON only**: `{"verdict":"good"|"adjust","score":0-100,"summary":"<one short
  sentence>","instructions":["<imperative, ≤ 12 words>", …max 3]}`. Speak to the user as "you",
  use their left/right, and never mention the camera image's own left/right.

The parser tolerates fenced code blocks and surrounding prose (it extracts the first JSON
object), clamps `score`, truncates strings (summary ≤ 200 chars, each instruction ≤ 120),
and treats an invalid response as a failure of that connection.

## 6. Settings UI ("AI models" section)

* A master toggle: **Use a connected AI model**, with the subtitle "On-device AI always
  watches your posture. A connected model double-checks setup and answers Ask AI."
* **What's sent:** a segmented control, `Pose sketch (no camera image)` · `Camera snapshot`,
  with the disclosure line underneath.
* **Use during setup:** a toggle.
* **Connections list.** Each row shows a provider glyph, label, model, a status dot (green =
  last test ok, red = failed, gray = untested), an enabled toggle, up/down reorder (priority and
  fallback, with a `Primary` badge on the first enabled one), `Test`, `Edit` and `Remove`
  (with confirm).
* **Add / edit form** (inline card): a provider preset select; label; API key as a password
  field (when a key is stored it shows `Saved key …x2Ig` with Replace/Remove, and the key is
  never displayed); base URL (always shown for Custom, behind "Advanced" otherwise); and a model
  field with a datalist filled by `Load models`, plus preset suggestions. Save, then Test. Error
  messages are short and specific.
* Everything is keyboard accessible and uses the existing primitives and visual language.

## 7. Coach chat (`aiChat`)

`src/main/ai/coach.ts` (prompt, fallback, reply cleanup), `validate.ts` (`validateChatRequest`),
and a `chat()` method on every adapter.

```ts
aiChat(req: AiChatRequest): Promise<AiChatReply>   // never rejects
interface AiChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[]  // oldest first, ends with the user's turn
  context?: { live?; today?; history?; baseline?; recentAlerts? }  // AiChatContext in shared/ai.ts
  image?: { jpegB64: string; share: 'sketch' | 'snapshot' }
}
type AiChatReply = { ok: true; reply: string; connectionLabel: string; model: string } | { ok: false; message: string }
```

* **Messages.** At most 200 sent; control characters stripped, consecutive same-role turns
  merged, leading assistant turns dropped, and only the last 30 turns kept. The newest user
  message must be non-empty and at most 4000 characters (refused otherwise); older ones are cut.
* **Context** is advisory: unknown or malformed fields are dropped rather than refused. Only
  enums, booleans, bounded numbers and the app's own coaching line (at most 200 characters)
  survive, at most 10 recent alerts. Main renders it as a plain-language block appended to the
  system prompt.
* **Consent.** Requires `ai.enabled`. An image follows the review rules: refused while paused,
  and `share` must equal `settings.ai.share`. While paused, `context.live` is removed before
  sending. Only one chat runs at a time. Pausing aborts chats that carry an image or live data,
  and switching AI off aborts everything.
* **Providers.** Same priority order, 25 s per-connection timeout, error mapping, response-size
  cap and sender validation as reviews. Gemini/Vertex use `contents` with roles `user`/`model`
  plus `systemInstruction` (thinkingLevel LOW on 3.x, retried without it on a 400).
  OpenAI-compatible APIs use `messages` with a `system` turn (OpenAI sends `reasoning_effort: low`
  first and drops it on a 400/422). Anthropic uses `messages` plus `system` (`output_config.effort:
  low` on models that support it, dropped on a 400). An image rides on the last user turn. The
  output cap is 4096 tokens, and a reply cut off by it is kept with a trailing "…".
* **System prompt.** A friendly, practical SitSense coach. It knows the features (setup, the
  four issues and their stages, nudges, break reminders, pause, stats), is concise (2–6 sentences
  or a few bullets), uses only the given numbers, never diagnoses, suggests a physiotherapist or
  doctor for pain, stays on topic, and answers in the user's language. Output is markdown-lite:
  paragraphs, `- ` bullets and `**bold**`, with no headings, tables, code or links.
* **Reply.** `<think>` blocks and control characters are removed, blank-line runs are collapsed,
  and the reply is capped at 4000 characters. An empty reply counts as that connection failing.
  Nothing is logged.
