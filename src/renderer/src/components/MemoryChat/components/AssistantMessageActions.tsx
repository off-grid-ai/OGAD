import { memo } from 'react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { AppWindow, CaretLeft, CaretRight } from '@phosphor-icons/react'
import { DropdownMenuItem } from '@renderer/components/ui/dropdown-menu'
import type { Artifact } from '../../ArtifactCanvas'
import type { ChatMessage } from '../types'
import { isSupportingMessage } from '../utlis'
import { CopyAction, MessageActionsMenu, RegenerateAction } from './MessageActions'

export type SpeechControlState = 'idle' | 'loading' | 'playing'

export function speechControlState(
  messageId: string,
  speakingId: string | null,
  loadingId: string | null
): SpeechControlState {
  if (loadingId === messageId) return 'loading'
  if (speakingId === messageId) return 'playing'
  return 'idle'
}

function SpeechActionComponent({
  state,
  onSpeak
}: Readonly<{
  state: SpeechControlState
  onSpeak: () => void
}>): React.JSX.Element {
  let label = 'Speak'
  let icon: React.JSX.Element = (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 5L6 9H2v6h4l5 4V5z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"
      />
    </svg>
  )
  if (state === 'loading') {
    label = 'Generating…'
    icon = (
      <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    )
  } else if (state === 'playing') {
    label = 'Stop'
    icon = (
      <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
    )
  }
  return (
    <DropdownMenuItem onSelect={onSpeak} title={label}>
      {icon}
      <TextMorph as="span">{label}</TextMorph>
    </DropdownMenuItem>
  )
}

function VariantNavigationComponent({
  message,
  onSelect,
  noun = 'response'
}: Readonly<{
  message: ChatMessage
  onSelect: (direction: -1 | 1) => void
  /** What the versions are of: an answer, or an edited question. */
  noun?: 'response' | 'question'
}>): React.JSX.Element | null {
  // Saved versions (a retry or an edit added one beside the old) come from the thread; a reply
  // still streaming in this session may carry its versions in memory.
  const count = message.threadVersions?.count ?? message.variants?.length ?? 0
  if (count <= 1) return null
  const index = message.threadVersions?.index ?? message.variantIndex ?? 0
  return (
    <span className="flex items-center gap-1 text-[11px] text-neutral-500">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Previous ${noun}`}
        onClick={() => onSelect(-1)}
        disabled={index <= 0}
      >
        <CaretLeft aria-hidden="true" />
      </Button>
      <span>
        <AnimatedNumber value={index + 1} />/<AnimatedNumber value={count} />
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Next ${noun}`}
        onClick={() => onSelect(1)}
        disabled={index >= count - 1}
      >
        <CaretRight aria-hidden="true" />
      </Button>
    </span>
  )
}

function AssistantMessageActionsComponent({
  message,
  artifact,
  copied,
  speechState,
  speechError,
  speechEnabled,
  onCopy,
  onOpenArtifact,
  onRegenerate,
  onSelectVariant,
  onSpeak
}: Readonly<{
  message: ChatMessage
  artifact: Artifact | null
  copied: boolean
  speechState: SpeechControlState
  speechError?: string
  speechEnabled: boolean
  onCopy: () => void
  onOpenArtifact: (artifact: Artifact) => void
  onRegenerate: () => void
  onSelectVariant: (direction: -1 | 1) => void
  onSpeak: () => void
}>): React.JSX.Element | null {
  if (isSupportingMessage(message)) return null
  // An image answer has its own controls, but its earlier versions stay reachable.
  if (message.image) return <VariantNavigation message={message} onSelect={onSelectVariant} />
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <MessageActionsMenu>
        {speechEnabled ? <SpeechAction state={speechState} onSpeak={onSpeak} /> : null}
        <CopyAction copied={copied} onCopy={onCopy} />
        {!message.context?.executionApproval ? (
          <RegenerateAction label="Regenerate" title="Regenerate" onRegenerate={onRegenerate} />
        ) : null}
        {artifact ? (
          <DropdownMenuItem onSelect={() => onOpenArtifact(artifact)} title="Open canvas">
            <AppWindow className="h-3.5 w-3.5" aria-hidden="true" />
            Open canvas
          </DropdownMenuItem>
        ) : null}
      </MessageActionsMenu>
      <VariantNavigation message={message} onSelect={onSelectVariant} />
      {speechError ? (
        <p role="alert" className="basis-full text-[11px] leading-4 text-red-400">
          {speechError}
        </p>
      ) : null}
    </div>
  )
}

function MessageTimeComponent({
  message
}: Readonly<{ message: ChatMessage }>): React.JSX.Element | null {
  if (message.createdAt === undefined) return null
  const time = new Date(message.createdAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
  const ms = message.generationTimeMs
  return (
    <span className="font-mono text-[11px] tabular-nums text-neutral-500">
      {time}
      {ms !== undefined ? (
        <AnimatedNumber value={ms} format={formatGenerationTime} className="ml-2 text-green-500" />
      ) : null}
    </span>
  )
}

function formatGenerationTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

export const SpeechAction = memo(SpeechActionComponent)
export const VariantNavigation = memo(VariantNavigationComponent)
export const AssistantMessageActions = memo(AssistantMessageActionsComponent)
export const MessageTime = memo(MessageTimeComponent)
