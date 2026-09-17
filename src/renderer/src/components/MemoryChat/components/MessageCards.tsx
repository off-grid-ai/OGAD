import { memo } from 'react'
import { Button } from '@renderer/components/ui/button'
import type { Artifact } from '../../ArtifactCanvas'
import type { AskBlock, ChatMessage } from '../types'

function ImageMemoryRetryActionComponent({
  message,
  loading,
  onRetry
}: Readonly<{
  message: ChatMessage
  loading: boolean
  onRetry: (retry: NonNullable<ChatMessage['imageMemoryRetry']>) => void
}>): React.JSX.Element | null {
  console.log('MemoryChat ImageMemoryRetryAction rendered')
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

function ArtifactCardComponent({
  artifact,
  onOpen
}: Readonly<{
  artifact: Artifact | null
  onOpen: (artifact: Artifact) => void
}>): React.JSX.Element | null {
  console.log('MemoryChat ArtifactCard rendered')
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

function AskCardComponent({
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
  console.log('MemoryChat AskCard rendered')
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

export const ImageMemoryRetryAction = memo(ImageMemoryRetryActionComponent)
export const ArtifactCard = memo(ArtifactCardComponent)
export const AskCard = memo(AskCardComponent)
