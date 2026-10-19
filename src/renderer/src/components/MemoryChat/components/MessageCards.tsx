import { memo } from 'react'
import { Atom, Code, FileHtml, FileSvg, FileText, TreeStructure } from '@phosphor-icons/react'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { Button } from '@renderer/components/ui/button'
import { deviceNoun } from '@renderer/lib/device'
import type { Artifact } from '../../ArtifactCanvas'
import { artifactTitle } from '../../../../../shared/artifact-title'
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
  const retry = message.imageMemoryRetry
  if (!retry) return null
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
      <p className="min-w-0 flex-1 text-[10px] text-muted-foreground">
        Running this model may make your {deviceNoun()} unresponsive.
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

const ARTIFACT_ICON = {
  html: FileHtml,
  react: Atom,
  svg: FileSvg,
  mermaid: TreeStructure,
  text: FileText
} as const

function ArtifactCardComponent({
  artifact,
  building = false,
  onOpen
}: Readonly<{
  artifact: Artifact | null
  /** The answer is still streaming this artifact: it can be opened and watched as it renders. */
  building?: boolean
  onOpen: (artifact: Artifact) => void
}>): React.JSX.Element | null {
  if (!artifact) return null
  const Icon = (ARTIFACT_ICON as Partial<Record<string, typeof Code>>)[artifact.kind] ?? Code
  // Named by what it is (its page title, its component), not by its format.
  const label = artifact.title || artifactTitle(artifact.kind, artifact.code)
  return (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      className="mt-2 flex w-full min-w-64 items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-left transition-colors hover:border-green-500/60"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-950 text-green-500">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-neutral-200">{label}</span>
        {/* A finished artifact is its name; the icon says what kind it is. */}
        {building || artifact.partial ? (
          <span className="block text-[11px] text-neutral-500">
            {building ? (
              <TextShimmer as="span">Building. Open to watch it render</TextShimmer>
            ) : (
              'Stopped before it finished. Open to see what was made'
            )}
          </span>
        ) : null}
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
  if (!ask) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <p className="text-xs text-neutral-400">{ask.question}</p>
      <AnimatedGroup preset="blur-slide" className="flex flex-wrap gap-1.5">
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
      </AnimatedGroup>
      {ask.multiSelect && selected.length > 0 ? (
        <button
          type="button"
          onClick={onSubmit}
          className="mt-1 self-start rounded-md bg-green-600 px-3 py-1 text-xs text-white transition-colors hover:bg-green-500"
        >
          Submit (<AnimatedNumber value={selected.length} />)
        </button>
      ) : null}
    </div>
  )
}

export const ImageMemoryRetryAction = memo(ImageMemoryRetryActionComponent)
export const ArtifactCard = memo(ArtifactCardComponent)
export const AskCard = memo(AskCardComponent)
