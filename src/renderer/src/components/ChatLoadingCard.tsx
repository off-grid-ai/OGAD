import type { ReactElement } from 'react'

interface ChatLoadingCardProps {
  readonly label: string
}

/** The one compact three-dot state used while a chat reply is still being prepared. */
export function ChatLoadingCard({ label }: ChatLoadingCardProps): ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5">
      <span className="flex gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:300ms]" />
      </span>
      <span className="text-xs text-neutral-500" role="status" aria-live="polite">
        {label}
      </span>
    </div>
  )
}
