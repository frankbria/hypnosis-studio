import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Plays short voice-preview clips with exclusive playback:
 * starting a clip stops whichever clip was playing before,
 * and playback stops when the owner unmounts.
 *
 * Since #81 it also distinguishes "pressed" from "playing", and warms the
 * clips ahead of the press. The preview is the primary trust mechanism on the
 * voice step — it is the only place a visitor hears what they are buying — so
 * a press that appears to do nothing for half a second is expensive.
 *
 * @param warm Clips to fetch ahead of time. Must be a STABLE array (a module
 *   constant or a useMemo), since its contents key the prefetch effect.
 */
export function useAudioPreview(warm: readonly string[] = []) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** Cancels the background warming the instant a real press needs the link. */
  const warmingRef = useRef<AbortController | null>(null)
  const [playingSrc, setPlayingSrc] = useState<string | null>(null)
  /** Pressed, but not yet audible. */
  const [pendingSrc, setPendingSrc] = useState<string | null>(null)

  const warmKey = warm.join('|')
  useEffect(() => {
    if (!warmKey) return
    // Only the bytes. The Audio element is still constructed inside the click
    // handler, which is what iOS requires — prefetching is orthogonal to that,
    // and it is what takes the network round-trip off the critical path.
    //
    // ONE AT A TIME, AT LOW PRIORITY, AND ABANDONED THE MOMENT A PRESS HAPPENS.
    //
    // Measured, not assumed. Firing all four at once on a 400 kbps link made
    // the press SLOWER — 854 ms to 1266 ms — because the warming saturates the
    // link and the clip the visitor actually presses queues behind the three
    // they did not. `priority: 'low'` alone did not fix it: it does not preempt
    // bytes already in flight.
    //
    // Warming starts when the wizard mounts, so on any normal connection it is
    // long finished before anyone reaches the voice step. When it is not, the
    // press cancels it and takes the link.
    //
    // Deliberately not awaited and deliberately silent: a failed prefetch costs
    // nothing, because the press still works exactly as it did before.
    const controller = new AbortController()
    warmingRef.current = controller
    void (async () => {
      for (const src of warmKey.split('|')) {
        if (controller.signal.aborted) return
        try {
          await fetch(src, { signal: controller.signal, priority: 'low' })
        } catch {
          return
        }
      }
    })()
    return () => controller.abort()
  }, [warmKey])

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current = null
    }
    setPlayingSrc(null)
    setPendingSrc(null)
  }, [])

  const toggle = useCallback(
    (src: string) => {
      // The visitor wants a specific clip now; background warming must not
      // compete with it for the connection.
      warmingRef.current?.abort()

      // A second press while it is still loading stops it, rather than being
      // ignored — otherwise the only way out of a slow load is to wait for it.
      if (playingSrc === src || pendingSrc === src) {
        stop()
        return
      }
      stop()

      const audio = new Audio(src)
      audio.preload = 'auto'
      audioRef.current = audio

      const release = () => {
        if (audioRef.current === audio) {
          audioRef.current = null
          setPlayingSrc(null)
          setPendingSrc(null)
        }
      }
      // `playing` is the first moment there is actually sound. This used to set
      // the playing state immediately on press, so the button said "Playing"
      // over silence for as long as the clip took to load (#81).
      audio.addEventListener('playing', () => {
        if (audioRef.current !== audio) return
        setPendingSrc(null)
        setPlayingSrc(src)
      })
      audio.addEventListener('ended', release)
      audio.addEventListener('error', release)

      // Set before play() so the feedback is synchronous with the press.
      setPendingSrc(src)
      setPlayingSrc(null)
      audio.play().catch(release)
    },
    [playingSrc, pendingSrc, stop],
  )

  // Stop playback on unmount.
  useEffect(() => stop, [stop])

  return { playingSrc, pendingSrc, toggle, stop }
}
