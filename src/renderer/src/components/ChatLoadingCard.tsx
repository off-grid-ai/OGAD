import type { ReactElement } from 'react'
import { LoadingDots } from './ui/loading-dots'

interface ChatLoadingCardProps {
  readonly label: string
}

/** The one compact three-dot state used while a chat reply is still being prepared. */
export function ChatLoadingCard({ label }: ChatLoadingCardProps): ReactElement {
  if (label === 'Thinking...' || label === 'Thinking…') {
    return (
      <div role="status">
        <LoadingDots />
        <span className="sr-only">{label}</span>
      </div>
    )
  }
  const isPreparingReply = label === 'Preparing reply...' || label === 'Preparing reply…'
  return (
    <div
      className={
        isPreparingReply
          ? 'flex items-center gap-2'
          : 'flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5'
      }
    >
      <LoadingDots />
      <span className="text-xs text-neutral-500" role="status" aria-live="polite">
        {label}
      </span>
    </div>
  )
}
