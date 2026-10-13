import {
  CaretDown,
  Microphone,
  SlidersHorizontal,
  SpeakerHigh,
  Stop,
  X
} from '@phosphor-icons/react'
import { VOICE_TURN_LABELS, type VoiceTurnMode } from '@offgrid/speech'
import { Button } from './ui/button'
import { LoadingDots } from './ui/loading-dots'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

const TURN_MODES: readonly VoiceTurnMode[] = ['tap', 'silence', 'handsfree']

/** The turn mode, as a small dropdown where the composer may change it (God's voice mode). */
function TurnModePicker(props: {
  readonly mode: VoiceTurnMode
  readonly onChange: (mode: VoiceTurnMode) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Voice turns: ${VOICE_TURN_LABELS[props.mode].label}`}
        className="flex shrink-0 items-center gap-1 rounded px-1 text-[10px] uppercase tracking-wide text-primary hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
      >
        {VOICE_TURN_LABELS[props.mode].label}
        <CaretDown className="h-2.5 w-2.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={props.mode}
          onValueChange={(value) => props.onChange(value as VoiceTurnMode)}
        >
          {TURN_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode} className="text-xs">
              {VOICE_TURN_LABELS[mode].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
import type { ChatVoicePhase } from './use-chat-voice-turns'

interface ChatVoiceComposerProps {
  phase: ChatVoicePhase
  turnMode: VoiceTurnMode
  suspended: boolean
  transcriptionLabel: string
  error: string | null
  onToggleRecording: () => void
  /** Lets the user change the turn mode here (God's voice mode); absent, it is just shown. */
  onTurnModeChange?: (mode: VoiceTurnMode) => void
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

/** Compact voice input that occupies the same row as the normal text field. */
export function ChatVoiceComposer({
  phase,
  turnMode,
  suspended,
  transcriptionLabel,
  error,
  onToggleRecording,
  onTurnModeChange
}: ChatVoiceComposerProps): React.JSX.Element {
  const active = phase !== 'idle'
  const transcribing = phase === 'transcribing'
  const label = recordButtonLabel(phase, suspended)

  return (
    <div className="flex min-h-11 w-full flex-col justify-center gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          {onTurnModeChange ? (
            <TurnModePicker mode={turnMode} onChange={onTurnModeChange} />
          ) : (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-primary">
              {VOICE_TURN_LABELS[turnMode].label}
            </span>
          )}
          <span aria-live="polite" className="truncate text-xs text-neutral-500">
            {statusText({
              phase,
              mode: turnMode,
              suspended,
              transcriptionLabel
            })}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onToggleRecording}
              aria-label={label}
              className={`absolute bottom-2.5 right-2.5 rounded-full ${active ? 'border-red-500/50 text-red-400 hover:bg-red-500/10' : 'border-green-500 text-primary hover:bg-green-500/10'}`}
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
      </div>
      {error ? (
        <p role="alert" className="text-[11px] text-amber-500">
          {visibleError(error)}
        </p>
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
