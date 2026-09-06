import { useEffect, useState } from 'react'

/**
 * One two-minute mixed sample of a real program (#60).
 *
 * `url` is used verbatim. It is minted by the server, which is the only thing
 * that knows the sample is really on this box — `engine/catalog.json` is
 * committed and rides every deploy, the audio is gitignored and does not, and
 * #139 exists because that gap already bit once for the masters.
 */
export interface ProgramSample {
  key: string
  goal: string
  voiceSet: string
  goalTitle: string | null
  bytes: number
  url: string
}

/**
 * The samples this box can actually play, or `[]` while unknown.
 *
 * Deliberately silent on failure. Every caller falls back to the solo voice
 * clips, which are static assets and always there — so a storefront whose
 * samples have not been cut yet is the site as it was before #60, not a broken
 * page with dead play buttons on it.
 */
export function useProgramSamples(): ProgramSample[] {
  const [samples, setSamples] = useState<ProgramSample[]>([])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch('/api/samples', { signal: controller.signal })
        if (!res.ok) return
        const body = (await res.json()) as { samples?: ProgramSample[] }
        if (Array.isArray(body.samples)) setSamples(body.samples)
      } catch {
        // Offline, aborted, or a server too old to know the route. Nothing here
        // is worth telling a visitor about.
      }
    })()
    return () => controller.abort()
  }, [])

  return samples
}

/** The sample for one engine goal, preferring `voiceSet` when there is a choice. */
export function sampleFor(
  samples: readonly ProgramSample[],
  goal: string | undefined,
  voiceSet?: string,
): ProgramSample | undefined {
  if (!goal) return undefined
  const forGoal = samples.filter((s) => s.goal === goal)
  return forGoal.find((s) => s.voiceSet === voiceSet) ?? forGoal[0]
}
