/**
 * The actions a rendered turn offers - copy, regenerate, speak, move between variants - plus the
 * artifact and ask cards and the metrics and cutoff notices that sit with them. Each one emits
 * intent; none of them decides chat policy.
 */
import { type Artifact } from '@renderer/lib/artifact-parser'
import { formatGenerationDuration, formatGenerationMetrics, type GenerationMetrics } from '../../../shared/generation-metrics'
import { type ResponseCutoffContract } from '../../../shared/ipc-contracts'
import { type AskBlock, type ChatMessage } from '@renderer/lib/chat-transcript-types'
import { Button } from '@renderer/components/ui/button'
import { Check, WarningCircle } from '@phosphor-icons/react'
import { isSupportingMessage, type SpeechControlState } from './chat-message-projection'

export function GenerationMetricsRow({
  metrics
}: Readonly<{ metrics?: GenerationMetrics }>): React.JSX.Element | null {
  const parts = metrics ? formatGenerationMetrics(metrics) : []
  if (!parts.length) return null
  return (
    <p
      className="mt-2 font-mono text-[10px] tabular-nums text-neutral-500"
      data-testid="generation-metrics"
    >
      {parts.join(' · ')}
    </p>
  )
}

export function ResponseCutoffNotice({
  cutoff
}: Readonly<{ cutoff?: ResponseCutoffContract }>): React.JSX.Element | null {
  if (!cutoff) return null
  return (
    <p
      role="status"
      className="mt-2 flex items-start gap-1.5 border-t border-amber-500/20 pt-2 text-[11px] text-amber-400"
    >
      <WarningCircle className="mt-0.5 h-3 w-3 shrink-0" weight="fill" />
      Response stopped at the configured {cutoff.maxTokens.toLocaleString()}-token limit.
    </p>
  )
}

export function ImageMemoryRetryAction({
  message,
  loading,
  onRetry
}: Readonly<{
  message: ChatMessage
  loading: boolean
  onRetry: (retry: NonNullable<ChatMessage['imageMemoryRetry']>) => void
}>): React.JSX.Element | null {
  const retry = message.imageMemoryRetry
  if (!retry) return null
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
      <p className="min-w-0 flex-1 text-[10px] text-muted-foreground">
        Running this model may make your Mac unresponsive.
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={loading}
        onClick={() => onRetry(retry)}
        className="shrink-0 active:scale-95"
      >
        Run anyway
      </Button>
    </div>
  )
}

export function ArtifactCard({
  artifact,
  onOpen
}: Readonly<{
  artifact: Artifact | null
  onOpen: (artifact: Artifact) => void
}>): React.JSX.Element | null {
  if (!artifact) return null
  return (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      className="mt-2 flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-left transition-colors hover:border-green-500/60"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950 text-green-500">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-neutral-200">
          {artifact.title || `${artifact.kind.toUpperCase()} artifact`}
        </span>
        <span className="block text-[11px] text-neutral-500">Click to open in the canvas →</span>
      </span>
    </button>
  )
}

export function AskCard({
  ask,
  selected,
  onSelect,
  onSubmit
}: Readonly<{
  ask: AskBlock | null
  selected: readonly string[]
  onSelect: (option: string, selected: boolean) => void
  onSubmit: () => void
}>): React.JSX.Element | null {
  if (!ask) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <p className="text-xs text-neutral-400">{ask.question}</p>
      <div className="flex flex-wrap gap-1.5">
        {ask.options.map((option) => {
          const active = selected.includes(option)
          const className = active
            ? 'border-green-500 text-green-500'
            : 'border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500'
          return (
            <button
              key={option}
              type="button"
              onClick={() => onSelect(option, active)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${className}`}
            >
              {option}
            </button>
          )
        })}
      </div>
      {ask.multiSelect && selected.length > 0 ? (
        <button
          type="button"
          onClick={onSubmit}
          className="mt-1 self-start rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500"
        >
          Submit ({selected.length})
        </button>
      ) : null}
    </div>
  )
}

export function CopyAction({
  copied,
  onCopy
}: Readonly<{ copied: boolean; onCopy: () => void }>): React.JSX.Element {
  const color = copied ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'
  return (
    <button
      type="button"
      onClick={onCopy}
      className={`flex items-center gap-1 text-[11px] transition-colors ${color}`}
      title="Copy"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" weight="bold" />
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16h8M8 12h8m-7 8h6a2 2 0 002-2V6a2 2 0 00-2-2h-3.586a1 1 0 00-.707.293l-2.414 2.414A1 1 0 009 7.414V18a2 2 0 002 2z"
          />
        </svg>
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function RegenerateAction({
  label,
  title,
  disabled,
  onRegenerate
}: Readonly<{
  label: string
  title: string
  disabled?: boolean
  onRegenerate: () => void
}>): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onRegenerate}
      className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors enabled:hover:text-green-500 disabled:cursor-not-allowed disabled:opacity-40"
      title={title}
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      {label}
    </button>
  )
}

export function UserMessageActions({
  copied,
  regenerationDisabled,
  onCopy,
  onEdit,
  onRegenerate
}: Readonly<{
  copied: boolean
  regenerationDisabled: boolean
  onCopy: () => void
  onEdit: () => void
  onRegenerate: () => void
}>): React.JSX.Element {
  return (
    <div className="mt-1.5 flex items-center gap-3">
      <CopyAction copied={copied} onCopy={onCopy} />
      <RegenerateAction
        label="Resend"
        title={
          regenerationDisabled
            ? 'Wait for the current reply to finish'
            : 'Regenerate the reply to this message'
        }
        disabled={regenerationDisabled}
        onRegenerate={onRegenerate}
      />
      <button
        type="button"
        onClick={onEdit}
        className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
        title="Edit this message"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
        Edit
      </button>
    </div>
  )
}

function SpeechAction({
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
  const color = state === 'idle' ? 'text-neutral-600 hover:text-green-500' : 'text-green-500'
  return (
    <button
      type="button"
      onClick={onSpeak}
      className={`flex items-center gap-1 text-[11px] transition-colors ${color}`}
      title={label}
    >
      {icon}
      {label}
    </button>
  )
}

function VariantNavigation({
  message,
  onSelect
}: Readonly<{
  message: ChatMessage
  onSelect: (direction: -1 | 1) => void
}>): React.JSX.Element | null {
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

export function AssistantMessageActions({
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
  if (message.image || isSupportingMessage(message)) return null
  const generationDuration = formatGenerationDuration({
    generationTimeMs: message.generationTimeMs,
    totalSeconds: message.metrics?.totalSeconds
  })
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      {generationDuration ? (
        <span
          aria-label={`Response duration ${generationDuration}`}
          className="font-mono text-[10px] tabular-nums text-neutral-600"
          data-testid="response-duration"
        >
          {generationDuration}
        </span>
      ) : null}
      {speechEnabled ? <SpeechAction state={speechState} onSpeak={onSpeak} /> : null}
      <CopyAction copied={copied} onCopy={onCopy} />
      {!message.context?.executionApproval ? (
        <RegenerateAction label="Regenerate" title="Regenerate" onRegenerate={onRegenerate} />
      ) : null}
      <VariantNavigation message={message} onSelect={onSelectVariant} />
      {artifact ? (
        <button
          type="button"
          onClick={() => onOpenArtifact(artifact)}
          className="flex items-center gap-1 text-[11px] text-green-500 transition-colors hover:text-emerald-500"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 17V7h10v10M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h10a2 2 0 012 2v2"
            />
          </svg>
          Open canvas
        </button>
      ) : null}
      {speechError ? (
        <p role="alert" className="basis-full text-[11px] leading-4 text-red-400">
          {speechError}
        </p>
      ) : null}
    </div>
  )
}

