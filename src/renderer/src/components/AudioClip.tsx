// The one player for a recorded audio file, anywhere in the app: a voice note in chat, an
// attachment, a dictation on the Voice screen, a request in AI activity. It is the voice bubble's
// player (real waveform, seek, speed, one clip playing at a time) without chat's speech synthesis,
// so every recording looks and behaves the same. Use this, not a second player.

import { VoiceBubble } from './VoiceBubble'

/** A recording has its audio already; there is nothing to synthesize. */
const noSynthesis = (): Promise<{ dataUrl: string }> =>
  Promise.reject(new Error('A recorded clip plays its own audio.'))

export function AudioClip({
  src,
  id,
  durationSeconds,
  transcript = '',
  autoPlay = false
}: Readonly<{
  /** A URL the page can fetch (the waveform decodes the bytes): http, blob or data. */
  src: string
  /** Stable identity for "one clip at a time"; defaults to the URL. */
  id?: string
  durationSeconds?: number
  /** Shown on demand under the player when given. */
  transcript?: string
  autoPlay?: boolean
}>): React.JSX.Element {
  return (
    <VoiceBubble
      messageId={id ?? src}
      isUser
      audioUrl={src}
      durationSeconds={durationSeconds}
      transcript={transcript}
      synthesize={noSynthesis}
      autoPlay={autoPlay}
    />
  )
}
