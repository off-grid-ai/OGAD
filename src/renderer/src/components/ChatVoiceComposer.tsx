import { useEffect, useState } from 'react'
import { Microphone, SlidersHorizontal, SpeakerHigh, Stop, X } from '@phosphor-icons/react'
import { VOICE_TURN_LABELS, type VoiceTurnMode } from '@offgrid/speech'
import {
  VoiceCapture,
  type VoiceCapturePhase
} from '@offgrid/operator-ui/operator/workflows/voice-capture'
import { AutoHeight } from '@offgrid/operator-ui/operator/presence'
import { Button } from './ui/button'
import { LoadingDots } from './ui/loading-dots'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { ChatVoicePhase } from './use-chat-voice-turns'
import type { LiveTranscript as Transcript } from '@offgrid/speech'
import { LiveTranscript } from './LiveTranscript'

interface ChatVoiceComposerProps {
  phase: ChatVoicePhase
  turnMode: VoiceTurnMode
  suspended: boolean
  transcriptionLabel: string
  error: string | null
  onToggleRecording: () => void
  /** Lets the user change the turn mode here (God's voice mode); absent, it is just shown. */
  onTurnModeChange?: (mode: VoiceTurnMode) => void
  /** The live microphone envelope (from useChatVoiceTurns), drawn while the microphone is open. */
  subscribeAmplitudes?: (listener: (amplitudes: number[]) => void) => () => void
  /** What has been heard so far in this turn, shown while the person speaks. */
  subscribeLiveTranscript?: (listener: (transcript: Transcript) => void) => () => void
}

/** The capture's own words for its controls, in the product's voice. */
const CAPTURE_LABELS = {
  start: 'Start voice recording',
  stop: 'Stop voice recording',
  resume: 'Resume hands-free listening',
  cancelRecording: 'Stop voice recording',
  cancelTranscription: 'Cancel transcription'
}

const MODE_LABELS = {
  tap: VOICE_TURN_LABELS.tap.label,
  silence: VOICE_TURN_LABELS.silence.label,
  handsfree: VOICE_TURN_LABELS.handsfree.label
}

function recordButtonLabel(phase: ChatVoicePhase, suspended: boolean): string {
  if (phase === 'transcribing') return 'Cancel transcription'
  if (phase !== 'idle') return 'Stop voice recording'
  if (suspended) return 'Resume hands-free listening'
  return 'Start voice recording'
}

function statusText({
  phase,
  mode,
  suspended,
  transcriptionLabel
}: Omit<ChatVoiceComposerProps, 'error' | 'onToggleRecording' | 'turnMode'> & {
  mode: VoiceTurnMode
}): string {
  if (phase === 'starting') return 'Opening the microphone...'
  if (phase === 'listening') return 'Waiting for your voice'
  if (phase === 'transcribing') return `Transcribing with ${transcriptionLabel}`
  if (phase === 'recording') {
    return mode === 'tap' ? 'Recording - click to send' : 'Recording you now'
  }
  if (suspended) return 'Paused - click the microphone to resume'
  if (mode === 'handsfree') return 'Ready - speak when you want to start'
  return 'Click the microphone to record'
}

function visibleError(error: string): string {
  return error.includes("Didn't catch") ? 'No speech detected. Try again.' : error
}

function capturePhase(
  phase: ChatVoicePhase,
  suspended: boolean,
  error: string | null
): VoiceCapturePhase {
  if (phase === 'starting') return 'opening'
  if (phase !== 'idle') return phase
  if (error) return error.includes("Didn't catch") ? 'no-speech' : 'error'
  return suspended ? 'suspended' : 'idle'
}

/** Seconds since this recording began; the capture shows it beside its state. */
function useRecordingElapsed(recording: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const id = setInterval(() => setElapsedMs(Date.now() - started), 250)
    return () => {
      clearInterval(id)
      setElapsedMs(0)
    }
  }, [recording])
  return elapsedMs
}

/** Voice input in the composer: the shared capture surface, with the record button as its control. */
export function ChatVoiceComposer({
  phase,
  turnMode,
  suspended,
  transcriptionLabel,
  error,
  onToggleRecording,
  onTurnModeChange,
  subscribeAmplitudes,
  subscribeLiveTranscript
}: ChatVoiceComposerProps): React.JSX.Element {
  const active = phase !== 'idle'
  const transcribing = phase === 'transcribing'
  const label = recordButtonLabel(phase, suspended)
  const status = statusText({
    phase,
    mode: turnMode,
    suspended,
    transcriptionLabel
  })
  const elapsedMs = useRecordingElapsed(phase === 'recording')
  const capture = capturePhase(phase, suspended, error)
  const failed = capture === 'error' || capture === 'no-speech'
  const microphoneOpen = phase === 'listening' || phase === 'recording'

  return (
    <div className="w-full px-3 py-2" aria-busy={phase === 'starting' || transcribing || undefined}>
      {onTurnModeChange ? null : (
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-primary">
          {VOICE_TURN_LABELS[turnMode].label}
        </span>
      )}
      <AutoHeight>
        <VoiceCapture
          phase={capture}
          mode={turnMode}
          onModeChange={onTurnModeChange}
          modeLabels={MODE_LABELS}
          labels={CAPTURE_LABELS}
          elapsedMs={phase === 'recording' || transcribing ? elapsedMs : 0}
          subscribeAmplitudes={microphoneOpen ? subscribeAmplitudes : undefined}
          message={failed ? visibleError(error!) : status}
          primaryControl={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={onToggleRecording}
                  aria-label={label}
                  className={`rounded-full ${active ? 'border-red-500/50 text-red-400 hover:bg-red-500/10' : 'border-green-500 text-primary hover:bg-green-500/10'}`}
                >
                  {transcribing ? (
                    <LoadingDots size="small" />
                  ) : active ? (
                    <Stop className="h-3.5 w-3.5" weight="fill" />
                  ) : (
                    <Microphone className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          }
        />
      </AutoHeight>
      {subscribeLiveTranscript ? (
        <LiveTranscript subscribe={subscribeLiveTranscript} className="pt-1.5" />
      ) : null}
    </div>
  )
}

interface VoiceModeControlProps {
  active: boolean
  onToggle: () => void
  onOpenSettings: () => void
}

/** One compact control for voice mode and its settings, without a second options chip. */
export function VoiceModeControl({
  active,
  onToggle,
  onOpenSettings
}: VoiceModeControlProps): React.JSX.Element {
  if (!active) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed="false"
            onClick={onToggle}
            className="h-8 gap-1.5 rounded-full text-neutral-400"
          >
            <SpeakerHigh className="h-3.5 w-3.5" /> Voice
          </Button>
        </TooltipTrigger>
        <TooltipContent>Use voice notes</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div
      role="group"
      aria-label="Voice mode"
      className="inline-flex h-8 items-stretch overflow-hidden rounded-full border border-green-500 text-primary"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed="true"
            onClick={onToggle}
            className="h-[30px] gap-1.5 rounded-none px-2.5 hover:bg-green-500/10 hover:text-primary"
          >
            <SpeakerHigh className="h-3.5 w-3.5" /> Voice
            <X className="h-3.5 w-3.5 opacity-70" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Return to text</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Voice settings"
            onClick={onOpenSettings}
            className="h-[30px] w-7 rounded-none border-l border-green-500/50 hover:bg-green-500/10 hover:text-primary"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Voice settings</TooltipContent>
      </Tooltip>
    </div>
  )
}
