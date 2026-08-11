import type { Goal } from '@/lib/data'

/**
 * The text of a goal card, shared by all three places that render one (#62).
 *
 * There were three copies of this block — the performance grid, the healing
 * practices grid, and the wizard's goal step — with identical markup. Three
 * copies is how one of them ends up without the field you just added, which is
 * exactly how the healing door shipped with no seizure warning in #65.
 *
 * ## The hierarchy this fixes
 *
 * A human reviewer could not tell what the programs were: "are they different
 * ways people learn, hypnosis themes, objective outcomes, or something else?"
 *
 * The names were never the problem. The card led with a metaphor and put the
 * only plain-English token — "Focus and follow-through" — at 12px and 35%
 * opacity. **The metaphor got 40px; the meaning got 12px.** And all five
 * performance titles share one grammar (*The [Adjective] [Noun]*), so they read
 * as a set of themes rather than a set of products.
 *
 * So the order is now: what you get, what it is called, what it does, and who
 * it is for. The evocative name keeps its place — it just stops having to do
 * the classifying work.
 */
export default function GoalCardText({ goal }: { goal: Goal }) {
  return (
    <>
      {/* The outcome takes the gold slot the tagline used to occupy. */}
      <p className="mt-5 text-xs font-medium uppercase tracking-[0.15em] text-[#e0c894]">
        {goal.outcome}
      </p>
      <h3 className="mt-2 text-base font-medium text-white/90">{goal.name}</h3>
      {/*
        Was text-white/35 — 3.15:1, under AA. #19 scoped that out as UI chrome
        and recorded it as a decision rather than an oversight; this issue
        rewrites the same hierarchy, so it is the right place to fix it.
      */}
      <p className="mt-1 text-xs leading-relaxed text-white/55">{goal.tagline}</p>
      <p className="mt-4 text-sm leading-relaxed text-white/50">{goal.description}</p>
      {/*
        Last, and the only line that lets someone say "that's me" in under two
        seconds. Written as an experience, never a condition — the healing goals
        must not describe insomnia or anxiety, because the door's stance is
        HEALING_NONMEDICAL: rest and personal growth, never treatment.
      */}
      <p className="mt-4 border-t border-white/10 pt-3 text-xs leading-relaxed text-white/60">
        <span className="text-white/75">Choose this if</span> {goal.chooseIf}.
      </p>
    </>
  )
}
