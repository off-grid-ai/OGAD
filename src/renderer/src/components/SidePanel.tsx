import type { CSSProperties, ReactNode } from 'react'
import { useEscapeToClose } from '@renderer/lib/use-escape-to-close'

type SidePanelProps = {
  ariaLabel: string
  children: ReactNode
  onClose: () => void
  className?: string
  style?: CSSProperties
}

/**
 * Shared frame for dismissible Desktop side panels.
 *
 * The backdrop owns outside-click dismissal and the shared hook owns Escape.
 * Content stays in a sibling dialog, so clicks inside never reach the backdrop.
 */
export function SidePanel({
  ariaLabel,
  children,
  onClose,
  className = '',
  style
}: SidePanelProps): React.JSX.Element {
  useEscapeToClose(onClose)

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 transition-opacity duration-150"
        onClick={onClose}
        aria-hidden="true"
        data-testid="side-panel-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`fixed bottom-0 right-0 top-0 z-50 flex flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl ${className}`}
        style={style}
      >
        {children}
      </div>
    </>
  )
}
