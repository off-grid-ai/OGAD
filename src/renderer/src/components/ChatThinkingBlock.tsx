import type { ReactElement } from 'react'
import { Brain, CaretDown } from '@phosphor-icons/react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'

interface ChatThinkingBlockProps {
  content: string
  live?: boolean
  label?: string
}

/** One Desktop presentation for reasoning, whether this Mac or a paired device produced it. */
export function ChatThinkingBlock({
  content,
  live = false,
  label
}: Readonly<ChatThinkingBlockProps>): ReactElement {
  return (
    <Collapsible defaultOpen={live} className="w-full max-w-[85%]">
      <CollapsibleTrigger className="group inline-flex w-fit max-w-full flex-none items-center justify-start gap-1.5 whitespace-nowrap text-[11px] text-neutral-500 transition-colors hover:text-neutral-300">
        <Brain className="h-3 w-3 shrink-0 text-neutral-600" aria-hidden="true" />
        <span className="whitespace-nowrap">
          {label ?? (live ? 'Thinking…' : 'Thought process')}
        </span>
        <CaretDown
          className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-800 pl-3 text-xs leading-relaxed text-neutral-500">
        {content}
      </CollapsibleContent>
    </Collapsible>
  )
}
