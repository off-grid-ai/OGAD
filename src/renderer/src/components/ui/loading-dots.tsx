import type { ReactElement } from 'react'

interface LoadingDotsProps {
  readonly size?: 'small' | 'medium'
  readonly className?: string
}

/** One three-dot busy state for every Desktop surface. */
export function LoadingDots({ size = 'medium', className = '' }: LoadingDotsProps): ReactElement {
  const dot = size === 'small' ? 'h-1 w-1' : 'h-1.5 w-1.5'
  return (
    <span className={`inline-flex items-center gap-1 px-1 ${className}`} aria-hidden="true">
      <span className={`${dot} animate-bounce rounded-full bg-green-500 [animation-delay:0ms]`} />
      <span className={`${dot} animate-bounce rounded-full bg-green-500 [animation-delay:150ms]`} />
      <span className={`${dot} animate-bounce rounded-full bg-green-500 [animation-delay:300ms]`} />
    </span>
  )
}
