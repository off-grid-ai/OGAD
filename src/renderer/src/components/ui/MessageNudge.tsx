/**
 * MessageNudge - the small amber advisory bar used under a chat message (the
 * max-token cutoff notice was the first user of this look). One component so
 * every in-chat nudge reads the same: a warning icon, a line of text, and an
 * optional dismiss. Extracted so new nudges (the vision grounder warning)
 * reuse it instead of re-styling an amber bar each time.
 */
import { WarningCircle } from '@phosphor-icons/react'

export function MessageNudge({
  children,
  onDismiss
}: {
  children: React.ReactNode
  onDismiss?: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="mt-2 flex items-start gap-1.5 border-t border-amber-500/20 pt-2 text-[11px] text-amber-400"
    >
      <WarningCircle className="mt-0.5 h-3 w-3 shrink-0" weight="fill" />
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-amber-400/70 transition-colors hover:text-amber-200"
        >
          ✕
        </button>
      )}
    </div>
  )
}
