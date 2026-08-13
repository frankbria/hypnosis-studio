import type { LucideIcon } from 'lucide-react'
import {
  Brain,
  Cloud,
  DoorOpen,
  Infinity as InfinityIcon,
  Moon,
  Mountain,
  Palette,
  PenLine,
  Waves,
} from 'lucide-react'

// ─── Doors ───────────────────────────────────────────────────────────────────

/** The two storefronts: performance (learning/optimization) and healing (rest/repair imagery). */
export type DoorId = 'performance' | 'healing'

// ─── Goals ───────────────────────────────────────────────────────────────────

export interface Goal {
  id: string
  name: string
  /**
   * Plain-English outcome, in the gold slot at the top of the card (#62).
   *
   * A human reviewer could not tell what these programs were: "are they
   * different ways people learn, hypnosis themes, objective outcomes, or
   * something else?" The names were not the problem — the hierarchy was. The
   * metaphor got 40px and the meaning got 12px at 35% opacity.
   *
   * All five performance titles also share one grammar (The [Adjective]
   * [Noun]), so they read as a set of themes rather than a set of products.
   * This field is what makes them products again, without renaming anything.
   */
  outcome: string
  /**
   * "Choose this if…" — the reader's actual situation (#62).
   *
   * The only line on the card that lets someone say "that's me" in under two
   * seconds. Written as an experience, never a condition: the healing goals in
   * particular must not describe insomnia or anxiety, because the door's stance
   * is HEALING_NONMEDICAL — rest and personal growth, never treatment.
   */
  chooseIf: string
  tagline: string
  description: string
  icon: LucideIcon
  /** Which door (storefront) this goal belongs to */
  door: DoorId
  /** Thematic names used for tracks II and III */
  themes: [string, string]
  /** Whether this goal can actually be rendered today */
  available: boolean
  /** Goal key expected by the render API, when different from id */
  apiGoal?: string
}

export const GOALS: Goal[] = [
  {
    id: 'polymath',
    outcome: 'Learn faster, remember more',
    chooseIf: 'you read and study constantly, and retain less of it than you want',
    name: 'The Polymath Mind',
    tagline: 'Accelerated learning, cross-domain connection',
    description:
      'Train the mind to absorb deeply, connect widely, and recall on demand — learning as a way of being, not a task.',
    icon: Brain,
    door: 'performance',
    themes: ['The Deep Library', 'The Whispering Index'],
    available: true,
    apiGoal: 'polymath',
  },
  {
    id: 'golden-thread',
    outcome: 'Finish what you start',
    chooseIf: 'you begin well and lose the thread somewhere in the middle',
    name: 'The Golden Thread',
    tagline: 'Focus and follow-through',
    description:
      'One clear line from intention to completion. Distraction loosens its grip; the thread holds.',
    icon: InfinityIcon,
    door: 'performance',
    themes: ['The Loom of Attention', 'The Unbroken Line'],
    available: true,
    apiGoal: 'golden_thread',
  },
  {
    id: 'inner-studio',
    outcome: 'Make the work without stalling',
    chooseIf: 'you sit down to create and freeze, edit too early, or wait to feel ready',
    name: 'The Inner Studio',
    tagline: 'Creative confidence and flow',
    description:
      'A quiet room inside you where the work makes itself. Enter, and the flow is already waiting.',
    icon: Palette,
    door: 'performance',
    themes: ['The Quiet Atelier', 'The Flowing Hand'],
    available: true,
    apiGoal: 'inner_studio',
  },
  {
    id: 'open-gate',
    outcome: 'Notice chances and move on them',
    chooseIf: 'you keep recognising opportunities just after they have passed',
    name: 'The Open Gate',
    tagline: 'Noticing and acting on opportunities',
    description:
      'Opportunity rarely knocks twice — but it always whispers first. Learn to hear it, and to move.',
    icon: DoorOpen,
    door: 'performance',
    themes: ['The Widening Field', 'The Threshold Walk'],
    available: true,
    apiGoal: 'open_gate',
  },
  {
    id: 'deep-confidence',
    outcome: 'Stay steady under pressure',
    chooseIf: 'you know your work, but lose your footing when it counts',
    name: 'Deep Confidence',
    tagline: 'Steadiness under pressure',
    description:
      'Not bravado — bedrock. A calm that pressure cannot reach, rehearsed until it is simply yours.',
    icon: Mountain,
    door: 'performance',
    themes: ['The Bedrock', 'The Still Center'],
    available: false,
  },
  {
    id: 'custom',
    outcome: 'Your own goal, scripted',
    chooseIf: 'nothing above fits, and you can describe the change in your own words',
    name: 'Custom',
    tagline: 'Describe your own change',
    description:
      'Name the change you want, in your own words. The script is written around it — and only it.',
    icon: PenLine,
    door: 'performance',
    themes: ['The Turning', 'The Deep Water'],
    available: false,
  },
  {
    id: 'river',
    outcome: 'Deep rest and recovery',
    chooseIf: 'you are running on empty and want rest, not another task',
    name: 'The River of Renewal',
    tagline: 'Deep rest and symbolic repair',
    description:
      'A slow drift down warm water — deep relaxation, symbolic renewal, and a rehearsal of wellness. Rest, not medicine.',
    icon: Waves,
    door: 'healing',
    themes: ['The Mending Current', 'The Far Shore'],
    available: true,
    apiGoal: 'river',
  },
  {
    id: 'deep-sleep',
    outcome: 'A long, slow wind-down',
    chooseIf: 'you want the end of the day to actually end',
    name: 'Deep Sleep',
    tagline: 'Rest, all the way down',
    description:
      'A long, slow descent into the deepest natural rest — nothing to do, nowhere to be, only drifting.',
    icon: Moon,
    door: 'healing',
    themes: ['The Dark Water', 'The Undisturbed House'],
    available: false,
  },
  {
    id: 'the-quiet-mind',
    outcome: 'Quiet a busy mind',
    chooseIf: 'your thoughts keep running when you would rather they settled',
    name: 'The Quiet Mind',
    tagline: 'Stillness for a busy mind',
    description:
      'For minds that run hot — a practice of unhooking, softening, and letting the noise settle on its own.',
    icon: Cloud,
    door: 'healing',
    themes: ['The Empty Sky', 'The Settling Snow'],
    available: false,
  },
]

/**
 * The catalog for a door — what someone can actually buy today (#66).
 *
 * This used to return every goal, and the grids rendered the unbuilt ones as
 * greyed-out cards behind an "In production" badge. The arithmetic worked
 * against us exactly where it mattered: the Healing landing showed three cards
 * with two greyed out — a shelf two-thirds empty, on the page whose job is to
 * make an anxious visitor feel they are in careful hands.
 *
 * Roadmap credibility is worth about one sentence, and nothing at all at the
 * moment of payment.
 */
export const goalsForDoor = (door: DoorId): Goal[] =>
  GOALS.filter((g) => g.door === door && g.available)

/**
 * Titles worth naming as coming, for the one sentence that replaces the cards.
 *
 * `custom` is excluded deliberately: it is not unfinished. It is the $129
 * personalized tier, and it was being rendered at 50% opacity under a badge
 * saying it does not exist. It belongs in PRICING, which already has it.
 */
export const upcomingForDoor = (door: DoorId): Goal[] =>
  GOALS.filter((g) => g.door === door && !g.available && g.id !== 'custom')

/** "A", "A and B", "A, B and C" — for naming upcoming titles in prose. */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// ─── Voice sets ──────────────────────────────────────────────────────────────

export interface VoiceRole {
  /**
   * The label a listener sees at the moment of previewing (#64).
   *
   * "AI" lives in the value rather than in the markup because these render in
   * two places — the wizard's voice step and the delivery screen — and the
   * aria-label is built from this string too. Putting the disclosure in one
   * render site is how the other one ships without it.
   */
  role: 'AI narrator' | 'AI whisper layer'
  name: string
  description: string
  src: string
}

export interface VoiceSet {
  id: 'male' | 'female'
  label: string
  narrator: VoiceRole
  whisper: VoiceRole
}

export const VOICE_SETS: VoiceSet[] = [
  {
    id: 'male',
    label: 'Male voices',
    narrator: {
      role: 'AI narrator',
      name: 'Brian',
      description: 'Deep, comforting',
      src: '/voices/brian.mp3',
    },
    whisper: {
      role: 'AI whisper layer',
      name: 'Frank',
      description: 'Low, close, almost subliminal',
      src: '/voices/frank.mp3',
    },
  },
  {
    id: 'female',
    label: 'Female voices',
    narrator: {
      role: 'AI narrator',
      name: 'Sarah',
      description: 'Mature, reassuring',
      src: '/voices/sarah.mp3',
    },
    whisper: {
      role: 'AI whisper layer',
      name: 'Lily',
      description: 'Velvety, weightless',
      src: '/voices/lily.mp3',
    },
  },
]

// ─── Tracks ──────────────────────────────────────────────────────────────────

/**
 * The engine writes these into manifest.json (render_program.py TRACKS), and the
 * delivery screen renders that value. "Mastery" rather than "Suggestion" because
 * the engine is what the customer actually receives — the badge used to change
 * between what was bought and what arrived (#15).
 */
export type TrackPhase = 'Foundation' | 'Deepening' | 'Mastery' | 'Integration'

export interface Track {
  numeral: 'I' | 'II' | 'III' | 'IV'
  title: string
  phase: TrackPhase
  duration: string
}

/**
 * Kept in step with `TRACKS` in engine/render_program.py, whose `total_s` is
 * 780/780/780/420. Nothing enforces that coupling across the language boundary,
 * so it is written down here and asserted in test/web.claims.test.js.
 *
 * These are MINIMUMS, not predictions. The assembler renders
 * `max(total_s, voice_end + 75 s)` bounded by the pad (#5), and `voice_end` is
 * the sum of real TTS durations — so a track runs at least this long and
 * typically two to three minutes longer, varying by goal. Advertising the floor
 * never overstates what is delivered, which is the direction that matters for
 * something shown at the moment of purchase.
 *
 * The previous values (14:20 / 13:45 / 14:55 / 13:10, totalling 56:10) were
 * invented and unconnected to the engine. Track IV was sold at 13:10 and
 * delivered at 7:00 (#14).
 *
 * #58's catalog manifest carries real measured durations and should replace
 * these floors once it exists.
 */
const TRACK_META: ReadonlyArray<{ phase: TrackPhase; minimumSeconds: number }> = [
  { phase: 'Foundation', minimumSeconds: 780 },
  { phase: 'Deepening', minimumSeconds: 780 },
  { phase: 'Mastery', minimumSeconds: 780 },
  { phase: 'Integration', minimumSeconds: 420 },
]

/** `780` → `"13:00"`. */
export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = Math.floor(totalSeconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** The shortest a full program can be, for copy that quotes a total. */
export const PROGRAM_MINIMUM_SECONDS = TRACK_META.reduce(
  (total, t) => total + t.minimumSeconds,
  0,
)

const NUMERALS = ['I', 'II', 'III', 'IV'] as const

export function buildTracks(goal: Goal): Track[] {
  const programName = goal.id === 'custom' ? 'Custom Program' : goal.name
  const parts = ['Foundation', goal.themes[0], goal.themes[1], 'Integration']
  return NUMERALS.map((numeral, i) => ({
    numeral,
    title: `${programName} ${numeral} — ${parts[i]}`,
    phase: TRACK_META[i].phase,
    duration: formatDuration(TRACK_META[i].minimumSeconds),
  }))
}

// ─── Pricing ─────────────────────────────────────────────────────────────────

export interface PricingTier {
  name: string
  price: string
  cadence: string
  features: string[]
  cta: string
  highlighted?: boolean
  badge?: string
  /**
   * Whether this tier can actually be bought today. A tier that is visible but
   * not purchasable must never render a payment CTA — advertising something the
   * studio cannot deliver on the day of sale is the exposure #13 was opened
   * about.
   */
  available: boolean
}

/**
 * The ladder from tasks/marketing-plan.md §3: $39 → $129 → $649.
 *
 * Only the $39 tier is purchasable at launch. The plan puts the personalized
 * tier post-launch ("ship the catalog, then this"), and the anchor contains two
 * personalized programs, so neither can be fulfilled on day one. They stay
 * visible because the ladder is what makes $39 read as the easy decision — an
 * anchor removed is a price with nothing to be cheap against — but neither
 * carries a payment CTA.
 *
 * The anchor is $649 with TWO programs, not the $1,499 with five that issue #63
 * quotes: §3 records a later owner decision, and at $649 five programs invert
 * the tier into a 23% discount, which is the opposite of an anchor. $649 against
 * $453 piecemeal is a 43% premium, so it still does its job.
 *
 * No tier may claim a subscription, a library, a priority queue (there is no
 * queue — the server returns 409 busy), human consultation, or lifetime access
 * (retention is 30 days).
 */
export const PRICING: PricingTier[] = [
  {
    name: 'Program',
    price: '$39',
    cadence: 'one-time',
    cta: 'Choose your program',
    available: true,
    features: [
      'Any one catalog title — four tracks',
      'Your choice of voice',
      'WAV + MP3, studio-mastered',
      'Ready in about twenty minutes · 30-day access',
    ],
  },
  {
    name: 'Personalized Program',
    price: '$129',
    cadence: 'one-time',
    cta: 'Opening soon',
    highlighted: true,
    badge: 'Next to open',
    available: false,
    features: [
      'Describe what you want to work on',
      'A script written around your answers',
      'Rendered on the same four-track engine',
      'WAV + MP3 · 30-day access',
    ],
  },
  {
    name: 'The Complete Studio',
    price: '$649',
    cadence: 'one-time',
    cta: 'Opening soon',
    available: false,
    features: [
      'Every catalog title, live at purchase',
      'Two personalized programs',
      'Both voice sets throughout',
      'WAV + MP3 · 30-day access',
    ],
  },
]

export const PROGRAM_PRICE = '$39'

// ─── Copy constants ──────────────────────────────────────────────────────────

/**
 * The seizure and photosensitivity warning, standing on its own.
 *
 * It used to be the fifth clause of a 55-word paragraph rendered at 11px and 40%
 * opacity (3.79:1, below WCAG AA) — and that same paragraph was the label of the
 * consent checkbox, so it did double duty as the safety notice and the thing
 * nobody reads before clicking (#65).
 *
 * Every track carries an isochronic entrainment bed: a deliberate rhythmic
 * auditory stimulus, which is why this warning exists at all. The reason is
 * stated rather than left implicit — "consult a professional" means little
 * without it. The audio already opens with a spoken disclaimer on all 20
 * scripts; the written one should be no less prominent.
 */
export const SAFETY_WARNING =
  'These tracks carry a pulsing tone beneath the narration. If you have a history of seizures or are photosensitive, speak to a doctor before listening. Never listen while driving or operating machinery.'

export const DISCLAIMER =
  'Hypnosis Studio audio is for relaxation and personal development. It is not medical or psychological treatment and is not a substitute for professional care. Never listen while driving or operating machinery. If you have a history of seizures, severe mental illness, or are under 18, consult a qualified professional before use.'

/**
 * The attestation, checked separately from the disclaimer (#20).
 *
 * DISCLAIMER names three real contraindications — a history of seizures, severe
 * mental illness, and being under 18 — but it named them inside a single
 * checkbox that also covered everything else. One box acknowledging a paragraph
 * attests to nothing in particular; the contraindications were doing no work.
 *
 * Phrased in the first person and about *this* buyer, so ticking it is a
 * statement rather than an acknowledgement that text exists. It does not bar
 * anyone: the condition is having spoken to a professional, which is exactly
 * what DISCLAIMER already asks for. Barring people would push them to lie; this
 * asks them to have done the thing.
 */
export const ATTESTATION =
  'I am 18 or older. I do not have a history of seizures or a severe mental ' +
  'illness — or if I do, I have spoken to a qualified professional about using ' +
  'hypnosis audio.'

/**
 * How the programs are made (#64).
 *
 * Nothing on the site said the voices were synthetic. They are audibly so,
 * which means a customer discovered it on first listen — after paying, which
 * is the worst possible moment, and the one that reads as concealment.
 *
 * Led with capability rather than apology. "AI-generated hypnosis" leads with
 * the commodity; "AI so we could build something otherwise impossible" is
 * engineering, and it happens to be the true reason the whisper layer exists at
 * all. Two synthetic voices render from one script in two registers and land in
 * exact time with each other. Two human performers would drift, and drift is
 * audible when one voice runs underneath the other.
 *
 * The curated claim is "fixed", never "hand-written" — the latter invites a
 * challenge we would lose.
 */
export const HOW_MADE: ReadonlyArray<{ heading: string; body: string }> = [
  {
    heading: 'The scripts are fixed',
    body:
      'Each program is written for one outcome, revised, and then locked. Every ' +
      'listener gets the same four tracks. That is the point: a script that is ' +
      'settled can be worked on until it is right, rather than generated fresh ' +
      'and hoped over.',
  },
  {
    heading: 'The voices are AI, and that is why there are two of them',
    body:
      'Both voices are synthetic. That is what makes the whisper layer possible: ' +
      'two synthetic voices can be rendered from one script in two registers and ' +
      'land in exact time with each other. Two human performers would drift, and ' +
      'drift is audible when one voice runs underneath the other.',
  },
  {
    heading: 'The bed is engineered, not a loop',
    body:
      'Underneath the narration is an isochronic entrainment bed, notched so it ' +
      'sits out of the way of the narrator rather than fighting for the same ' +
      'frequencies. It is built per program, mastered with the voices, not laid ' +
      'over the top afterwards.',
  },
]

/** Where a script actually written around your own words does live. */
export const PERSONALIZED_POINTER =
  'If you want a script written around your own situation rather than one of ' +
  'these, that is the Personalized Program.'

/** The healing door's non-medical stance — shown on the chooser card, healing landing, and wizard footer. */
export const HEALING_NONMEDICAL =
  'Not medicine. Not treatment. Always alongside — never instead of — medical care.'

export const GENERATION_STAGES = [
  'Writing your script…',
  'Voicing the narration…',
  'Layering the whisper track…',
  'Mixing the entrainment bed…',
  'Mastering & QA…',
] as const

