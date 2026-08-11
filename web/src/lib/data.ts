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

export const goalsForDoor = (door: DoorId): Goal[] =>
  GOALS.filter((g) => g.door === door)

// ─── Voice sets ──────────────────────────────────────────────────────────────

export interface VoiceRole {
  role: 'Narrator' | 'Whisper layer'
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
      role: 'Narrator',
      name: 'Brian',
      description: 'Deep, comforting',
      src: '/voices/brian.mp3',
    },
    whisper: {
      role: 'Whisper layer',
      name: 'Frank',
      description: 'Low, close, almost subliminal',
      src: '/voices/frank.mp3',
    },
  },
  {
    id: 'female',
    label: 'Female voices',
    narrator: {
      role: 'Narrator',
      name: 'Sarah',
      description: 'Mature, reassuring',
      src: '/voices/sarah.mp3',
    },
    whisper: {
      role: 'Whisper layer',
      name: 'Lily',
      description: 'Velvety, weightless',
      src: '/voices/lily.mp3',
    },
  },
]

// ─── Tracks ──────────────────────────────────────────────────────────────────

export type TrackPhase = 'Foundation' | 'Deepening' | 'Suggestion' | 'Integration'

export interface Track {
  numeral: 'I' | 'II' | 'III' | 'IV'
  title: string
  phase: TrackPhase
  duration: string
}

const TRACK_META: ReadonlyArray<{ phase: TrackPhase; duration: string }> = [
  { phase: 'Foundation', duration: '14:20' },
  { phase: 'Deepening', duration: '13:45' },
  { phase: 'Suggestion', duration: '14:55' },
  { phase: 'Integration', duration: '13:10' },
]

const NUMERALS = ['I', 'II', 'III', 'IV'] as const

export function buildTracks(goal: Goal): Track[] {
  const programName = goal.id === 'custom' ? 'Custom Program' : goal.name
  const parts = ['Foundation', goal.themes[0], goal.themes[1], 'Integration']
  return NUMERALS.map((numeral, i) => ({
    numeral,
    title: `${programName} ${numeral} — ${parts[i]}`,
    phase: TRACK_META[i].phase,
    duration: TRACK_META[i].duration,
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
      'Downloads in seconds · 30-day access',
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

export const DISCLAIMER =
  'Hypnosis Studio audio is for relaxation and personal development. It is not medical or psychological treatment and is not a substitute for professional care. Never listen while driving or operating machinery. If you have a history of seizures, severe mental illness, or are under 18, consult a qualified professional before use.'

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

export const GENERATION_TOTAL_MS = 14000
