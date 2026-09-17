import { memo } from 'react'
import { DropdownMenuItem } from '@renderer/components/ui/dropdown-menu'
import type { Artifact } from '../../ArtifactCanvas'
import type { ChatMessage } from '../types'
import { isSupportingMessage } from '../utlis'
import {
  CopyAction,
  MessageActionsMenu,
  RegenerateAction
} from './MessageActions'

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
  console.log('MemoryChat SpeechAction rendered')
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
  const color = state === 'idle' ? 'text-neutral-600 hover:text-green-500' : 'text-green-500'
  return (
    <DropdownMenuItem
      onSelect={onSpeak}
      className={`flex items-center gap-1 text-[11px] transition-colors ${color}`}
      title={label}
    >
      {icon}
      {label}
    </DropdownMenuItem>
  )
}

function VariantNavigationComponent({
  message,
  onSelect
}: Readonly<{
  message: ChatMessage
  onSelect: (direction: -1 | 1) => void
}>): React.JSX.Element | null {
  console.log('MemoryChat VariantNavigation rendered')
  if (!message.variants || message.variants.length <= 1) return null
  const index = message.variantIndex ?? 0
  return (
    <span className="flex items-center gap-1 text-[11px] text-neutral-500">
      <button
        type="button"
        onClick={() => onSelect(-1)}
        disabled={index <= 0}
        className="transition-colors hover:text-green-500 disabled:opacity-30"
      >
        ‹
      </button>
      <span>
        {index + 1}/{message.variants.length}
      </span>
      <button
        type="button"
        onClick={() => onSelect(1)}
        disabled={index >= message.variants.length - 1}
        className="transition-colors hover:text-green-500 disabled:opacity-30"
      >
        ›
      </button>
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
  console.log('MemoryChat AssistantMessageActions rendered')
  if (message.image || isSupportingMessage(message)) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <MessageActionsMenu>
        {speechEnabled ? <SpeechAction state={speechState} onSpeak={onSpeak} /> : null}
        <CopyAction copied={copied} onCopy={onCopy} />
        {!message.context?.executionApproval ? (
          <RegenerateAction label="Regenerate" title="Regenerate" onRegenerate={onRegenerate} />
        ) : null}
        {artifact ? (
          <DropdownMenuItem onSelect={() => onOpenArtifact(artifact)}>Open canvas</DropdownMenuItem>
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

function MessageTimeComponent({ message }: Readonly<{ message: ChatMessage }>): React.JSX.Element | null {
  console.log('MemoryChat MessageTime rendered')
  if (message.createdAt === undefined) return null
  const time = new Date(message.createdAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
  const ms = message.generationTimeMs
  const duration =
    ms === undefined
      ? null
      : ms < 1000
        ? `${ms}ms`
        : ms < 60000
          ? `${(ms / 1000).toFixed(1)}s`
          : `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  return (
    <span className="font-mono text-[11px] tabular-nums text-neutral-500">
      {time}
      {duration ? <span className="ml-2 text-green-500">{duration}</span> : null}
    </span>
  )
}

export const SpeechAction = memo(SpeechActionComponent)
export const VariantNavigation = memo(VariantNavigationComponent)
export const AssistantMessageActions = memo(AssistantMessageActionsComponent)
export const MessageTime = memo(MessageTimeComponent)
