import type { LucideIcon } from 'lucide-react'
import {
  Brain,
  DoorOpen,
  Infinity as InfinityIcon,
  Mountain,
  Palette,
  PenLine,
} from 'lucide-react'

// ─── Goals ───────────────────────────────────────────────────────────────────

export interface Goal {
  id: string
  name: string
  tagline: string
  description: string
  icon: LucideIcon
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
    themes: ['The Turning', 'The Deep Water'],
    available: false,
  },
]

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
}

export const PRICING: PricingTier[] = [
  {
    name: 'Custom Program',
    price: '$39',
    cadence: 'one-time',
    cta: 'Create your program',
    features: [
      'One personalized 4-track program',
      'WAV + MP3, studio-mastered',
      'Lifetime download access',
    ],
  },
  {
    name: 'Practice',
    price: '$19',
    cadence: 'per month',
    cta: 'Start practicing',
    highlighted: true,
    badge: 'Most popular',
    features: [
      'One new custom program each month',
      'Full library access',
      'Pause or cancel anytime',
    ],
  },
  {
    name: 'Premium',
    price: '$99',
    cadence: 'one-time',
    cta: 'Go premium',
    features: [
      'One personalized 4-track program',
      'Priority render queue',
      '1:1 script consultation',
    ],
  },
]

export const PROGRAM_PRICE = '$39'

// ─── Copy constants ──────────────────────────────────────────────────────────

export const DISCLAIMER =
  'Hypnosis Studio audio is for relaxation and personal development. It is not medical or psychological treatment and is not a substitute for professional care. Never listen while driving or operating machinery. If you have a history of seizures, severe mental illness, or are under 18, consult a qualified professional before use.'

export const GENERATION_STAGES = [
  'Writing your script…',
  'Voicing the narration…',
  'Layering the whisper track…',
  'Mixing the entrainment bed…',
  'Mastering & QA…',
] as const

export const GENERATION_TOTAL_MS = 14000
