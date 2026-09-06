import { cn } from '@renderer/lib/utils'

/** Flat, theme-aware terminal grid — the Off Grid AI brutalist backdrop (no gradients,
 *  no decoration). A hairline neutral grid at ~6% opacity that reads correctly on
 *  both light and dark, replacing the old dark-only star-field. */
export function GridBackdrop({ className }: { className?: string }): React.ReactElement {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0', className)}
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(128,128,128,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(128,128,128,0.06) 1px, transparent 1px)',
        backgroundSize: '44px 44px'
      }}
    />
  )
}
