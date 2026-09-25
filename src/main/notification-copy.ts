import type { IssueId, PostureAlert } from '../shared/posture'

export interface ToastCopy {
  title: string
  body: string
}

type Pool = readonly ToastCopy[]

// Friendly coach, never a scold: title = what we noticed, body = one concrete
// fix. Escalation adds urgency through specificity and duration, not blame.
// Several phrasings per issue × stage so a long day of nudges doesn't read
// like a broken record. Tokens: {n} → minutes in the episode,
// {toSide} → "to the left" / "to the right" / "to one side".
export const COPY: Record<IssueId, Record<1 | 2 | 3, Pool>> = {
  sink: {
    1: [
      { title: 'Sinking a little', body: 'A gentle lift through the chest fixes it.' },
      { title: 'Starting to settle', body: 'Grow an inch taller through the crown of your head.' },
      { title: 'A small slump is creeping in', body: 'Draw your shoulder blades down and back.' },
      { title: 'Drifting down a bit', body: 'Sit up onto your sit bones, not your tailbone.' },
      { title: 'Losing a little height', body: 'Picture a string lifting you from the top of your head.' }
    ],
    2: [
      { title: "You've settled into a slouch", body: 'Roll your shoulders back and sit tall.' },
      { title: 'Slouch spotted', body: 'Scoot your hips to the back of the chair and stack up from there.' },
      { title: 'Your spine is curling forward', body: 'Open your chest and let your shoulders drop back.' },
      { title: 'Sitting pretty low now', body: 'Feet flat, hips back, then lengthen through your spine.' },
      { title: 'The chair is winning', body: 'Press through your feet and sit back up tall.' }
    ],
    3: [
      { title: 'Deep slouch, {n} min now', body: 'Worth a reset: sit back, feet flat, spine tall.' },
      { title: '{n} min deep in a slouch', body: 'Stand up for a moment, then sit back down tall.' },
      { title: 'Fully folded', body: 'Take a breath, roll your shoulders three times and reset.' },
      { title: 'Slumped for {n} min', body: 'Your back would love a stretch — reach up high, then sit tall.' },
      { title: 'Seriously sunk in', body: 'Time for a real reset: hips back, chest open, chin level.' }
    ]
  },
  headForward: {
    1: [
      { title: "Head's creeping forward", body: 'Tuck your chin back a touch.' },
      { title: 'Leaning in a little', body: 'Glide your head back until your ears sit over your shoulders.' },
      { title: 'Chin is drifting out', body: 'A small chin tuck brings it home.' },
      { title: 'Edging toward the screen', body: 'Let the screen come to your eyes, not the other way round.' },
      { title: 'Neck is starting to reach', body: 'Lengthen the back of your neck.' }
    ],
    2: [
      { title: "Head's well past your shoulders", body: 'Bring your ears back over them.' },
      { title: 'Craning toward the screen', body: 'Pull your chin straight back, like making a double chin.' },
      { title: 'Your neck is carrying the load', body: 'Stack your head back over your shoulders.' },
      { title: 'Head out front', body: 'Try a slow chin tuck and hold it for one breath.' },
      { title: 'Turtle mode detected', body: 'Draw your head back and lengthen your neck.' }
    ],
    3: [
      { title: "Neck's doing all the work", body: 'Chin back and screen up — your neck will thank you.' },
      { title: 'Head way forward, {n} min now', body: 'Five slow chin tucks, then check your screen height.' },
      { title: 'Heavy load on your neck', body: 'Every inch forward adds strain — ease your head back over your shoulders.' },
      { title: 'Craning for {n} min', body: 'Roll your shoulders, tuck your chin and reset.' },
      { title: 'Your neck needs a break', body: 'Look up, tuck your chin, and raise the screen toward eye level.' }
    ]
  },
  lean: {
    1: [
      { title: 'Listing {toSide}', body: 'Re-center over both sit bones.' },
      { title: 'Tilting {toSide} a little', body: 'Even out your weight on both hips.' },
      { title: 'A slight lean {toSide}', body: 'Level your shoulders and sit square.' },
      { title: 'Drifting {toSide}', body: 'Plant both feet and find your center.' },
      { title: 'Off-center {toSide}', body: 'Imagine a plumb line through your spine and line up with it.' }
    ],
    2: [
      { title: 'Propped up on one side', body: 'Level your shoulders and square up to the screen.' },
      { title: 'Clear lean {toSide}', body: 'Uncross your legs if they are crossed, then re-center.' },
      { title: 'One shoulder is dropping', body: 'Lift it to match the other and sit square.' },
      { title: 'Resting on an armrest?', body: 'Bring both arms in and share the weight evenly.' },
      { title: 'Leaning {toSide}', body: 'Shift your weight back to the middle of the seat.' }
    ],
    3: [
      { title: 'Strong lean, {n} min now', body: 'Plant both feet and re-center — maybe stretch that side.' },
      { title: 'Heavily tilted {toSide}', body: 'Stand up briefly, then sit back down evenly.' },
      { title: 'Leaning for {n} min', body: 'Stretch the side you have been leaning away from, then re-center.' },
      { title: 'Way off-center', body: 'Both feet flat, both hips back, shoulders level.' },
      { title: 'Your spine is bending sideways', body: 'Sit up straight and give the other side a stretch.' }
    ]
  },
  tooClose: {
    1: [
      { title: 'Drifting toward the screen', body: 'Ease back a few centimeters.' },
      { title: 'Getting a bit close', body: 'Lean back into your chair — the screen will wait.' },
      { title: 'Screen is pulling you in', body: 'Slide back a little and relax your shoulders.' },
      { title: 'Creeping closer', body: 'Sit back until the whole screen fits in view without moving your eyes much.' },
      { title: 'Closing the gap', body: 'A small push back keeps your eyes relaxed.' }
    ],
    2: [
      { title: 'Getting close to the screen', body: 'Sit back — about an arm’s length is right.' },
      { title: 'Quite close now', body: 'Push back until your fingertips just reach the screen.' },
      { title: 'Leaning into the screen', body: 'Sit back and bump the text size up instead.' },
      { title: 'Your eyes are working hard', body: 'Move back a little and blink a few times.' },
      { title: 'Up close and personal', body: 'Roll your chair back an arm’s length.' }
    ],
    3: [
      { title: 'Nose-to-screen territory', body: 'Push back from the desk and reset your distance.' },
      { title: 'Very close, {n} min now', body: 'Sit back and look at something far away for 20 seconds.' },
      { title: 'Practically inside the screen', body: 'Roll back, zoom in on the content instead, and relax your neck.' },
      { title: 'Too close for {n} min', body: 'Give your eyes a break: back up, then look out a window.' },
      { title: 'Way too close', body: 'Push back an arm’s length and let your shoulders drop.' }
    ]
  }
}

/** Lead-ins for a stage that worsened inside the quiet period. */
export const ESCALATION_LEADS = ['Still going — ', "It's crept further — ", 'Getting deeper — ', 'A notch further — '] as const

/** Lead-ins for a repeat nudge about an episode that never ended. */
export const REMINDER_LEADS = ['Still there — ', 'Still at it — ', 'Quick reminder — '] as const

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

/**
 * Shuffle-bag selection: every phrasing is used once before any repeats,
 * and a refill never starts with the one just shown.
 */
export class CopyPicker {
  private bags = new Map<string, number[]>()
  private last = new Map<string, number>()

  constructor(private rng: () => number = Math.random) {}

  next(key: string, size: number): number {
    if (size <= 1) return 0
    let bag = this.bags.get(key)
    if (!bag || bag.length === 0) {
      bag = shuffle(
        Array.from({ length: size }, (_, i) => i),
        this.rng
      )
      if (bag[bag.length - 1] === this.last.get(key)) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]]
      this.bags.set(key, bag)
    }
    const i = bag.pop()!
    this.last.set(key, i)
    return i
  }
}

function interpolate(text: string, alert: PostureAlert): string {
  const toSide = alert.direction ? `to the ${alert.direction}` : 'to one side'
  return text
    .replaceAll('{toSide}', toSide)
    .replaceAll('{n}', String(Math.max(1, Math.round(alert.durationMs / 60_000))))
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** Title/body for one alert; stage must be 1–3. */
export function composeToast(alert: PostureAlert, picker: CopyPicker): ToastCopy {
  const stage = alert.stage as 1 | 2 | 3
  const pool = COPY[alert.issue][stage]
  const copy = pool[picker.next(`${alert.issue}:${stage}`, pool.length)]
  let body = interpolate(copy.body, alert)
  if (alert.kind === 'escalation' || alert.kind === 'reminder') {
    const leads = alert.kind === 'escalation' ? ESCALATION_LEADS : REMINDER_LEADS
    body = leads[picker.next(`lead:${alert.kind}`, leads.length)] + lowerFirst(body)
  }
  return { title: interpolate(copy.title, alert), body }
}
