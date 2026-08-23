import type { ChatStreamTool, ProjectedSyncedTool } from '@offgrid/sync'
import { CaretDown, Wrench } from '@phosphor-icons/react'
import { ChatMarkdown } from './ChatMarkdown'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'

type DisplayTool =
  | Pick<ProjectedSyncedTool, 'name' | 'result' | 'status' | 'durationMs'>
  | ChatStreamTool

interface ChatToolRowsProps {
  tools: readonly DisplayTool[] | undefined
}

/** One tool layout for live previews and durable assistant messages. */
export function ChatToolRows({ tools }: Readonly<ChatToolRowsProps>): React.JSX.Element | null {
  const visible = (tools ?? []).filter((tool) => tool.name !== 'search_memory')
  if (visible.length === 0) return null

  return (
    <div className="mt-1 flex w-full max-w-[85%] flex-col gap-1">
      {visible.map((tool, index) => {
        const running = tool.status === 'running'
        const result = tool.result ?? ''
        const hasDetails = !running && result.trim().length > 0
        const durationMs = 'durationMs' in tool ? tool.durationMs : undefined
        const completionLabel = `${tool.status === 'failed' ? 'Failed' : 'Completed'}${
          durationMs !== undefined ? ` in ${Math.round(durationMs)} ms` : ''
        }`
        return (
          <Collapsible
            key={`${tool.name}:${index}`}
            defaultOpen={false}
            className="rounded-sm border border-neutral-800 px-2 py-1 text-[10px] text-neutral-500"
          >
            <CollapsibleTrigger
              disabled={!hasDetails}
              className="group flex w-full items-center gap-1.5 text-left transition-colors enabled:hover:text-neutral-300 disabled:cursor-default"
            >
              <Wrench className="h-3 w-3 shrink-0 text-neutral-600" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {running ? `Using ${tool.name}...` : tool.name}
              </span>
              {!running ? <span className="text-neutral-600">{completionLabel}</span> : null}
              {hasDetails ? (
                <CaretDown
                  className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              ) : null}
            </CollapsibleTrigger>
            {hasDetails ? (
              <CollapsibleContent className="mt-1 border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
                <ChatMarkdown content={result} />
              </CollapsibleContent>
            ) : null}
          </Collapsible>
        )
      })}
    </div>
  )
}
