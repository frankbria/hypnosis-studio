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

/** What this box can do for the storefront right now. */
export interface StorefrontCapability {
  /** The samples it can actually play, or `[]` while unknown. */
  samples: ProgramSample[]
  /**
   * Whether a purchase downloads immediately instead of rendering (#137).
   *
   * Asked of the server rather than worked out at build time. `engine/catalog.json`
   * is committed and rides every deploy, so a build-time check knows what is
   * publishable *in the repo*; the masters are gitignored and do not ride the
   * deploy, so only the server knows whether *this* box can actually hand the
   * files over. That gap is #139, and putting "downloads in seconds" on the hero
   * of a box that renders every purchase is #61 all over again.
   *
   * `false` until the server says otherwise, so the honest wait copy is what a
   * visitor sees while this is unknown. The failure direction is under-promising,
   * which is the only safe direction for a claim made before payment.
   */
  instantDelivery: boolean
}

/**
 * What this box can do for the storefront, asked once per page.
 *
 * Deliberately silent on failure. Every caller falls back to the solo voice
 * clips, which are static assets and always there — so a storefront whose
 * samples have not been cut yet is the site as it was before #60, not a broken
 * page with dead play buttons on it. The same silence gives `instantDelivery`
 * its conservative default.
 */
export function useProgramSamples(): StorefrontCapability {
  const [capability, setCapability] = useState<StorefrontCapability>({
    samples: [],
    instantDelivery: false,
  })

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch('/api/samples', { signal: controller.signal })
        if (!res.ok) return
        const body = (await res.json()) as {
          samples?: ProgramSample[]
          instantDelivery?: boolean
        }
        setCapability({
          samples: Array.isArray(body.samples) ? body.samples : [],
          // Strictly `=== true`: a server too old to know the field must read as
          // "not instant", not as truthy-undefined.
          instantDelivery: body.instantDelivery === true,
        })
      } catch {
        // Offline, aborted, or a server too old to know the route. Nothing here
        // is worth telling a visitor about.
      }
    })()
    return () => controller.abort()
  }, [])

  return capability
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
