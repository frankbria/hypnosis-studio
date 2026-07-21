import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Plays short voice-preview clips with exclusive playback:
 * starting a clip stops whichever clip was playing before,
 * and playback stops when the owner unmounts.
 */
export function useAudioPreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingSrc, setPlayingSrc] = useState<string | null>(null)

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current = null
    }
    setPlayingSrc(null)
  }, [])

  const toggle = useCallback(
    (src: string) => {
      if (playingSrc === src) {
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
        }
      }
      audio.addEventListener('ended', release)
      audio.addEventListener('error', release)

      audio.play().catch(release)
      setPlayingSrc(src)
    },
    [playingSrc, stop],
  )

  // Stop playback on unmount.
  useEffect(() => stop, [stop])

  return { playingSrc, toggle, stop }
}
