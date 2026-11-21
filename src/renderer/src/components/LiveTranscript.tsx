import { useEffect, useState } from 'react'
import { AutoHeight } from '@offgrid/operator-ui/operator/presence'
import { EMPTY_LIVE_TRANSCRIPT, type LiveTranscript as Transcript } from '@offgrid/speech'

interface LiveTranscriptProps {
  /** From useChatVoiceTurns: updates arrive here without re-rendering the chat. */
  subscribe: (listener: (transcript: Transcript) => void) => () => void
  className?: string
}

/**
 * What the microphone has heard so far, while the person is still speaking. Guesses are lighter and
 * darken in place as they settle, so text fades in and firms up instead of popping or jumping.
 */
export function LiveTranscript({ subscribe, className }: LiveTranscriptProps): React.JSX.Element {
  const [transcript, setTranscript] = useState<Transcript>(EMPTY_LIVE_TRANSCRIPT)
  useEffect(() => subscribe(setTranscript), [subscribe])
  const segments = transcript.segments.filter((segment) => segment.text)

  return (
    <AutoHeight>
      {segments.length > 0 ? (
        <p
          aria-live="polite"
          aria-label="Live transcript"
          className={`whitespace-pre-wrap text-sm leading-relaxed ${className ?? ''}`}
        >
          {segments.map((segment, index) => (
            <span
              key={segment.id}
              data-final={segment.final || undefined}
              className={`animate-[og-live-word-in_240ms_ease-out] transition-colors duration-500 ${
                segment.final ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              {index > 0 ? ' ' : ''}
              {segment.text}
            </span>
          ))}
        </p>
      ) : null}
    </AutoHeight>
  )
}
