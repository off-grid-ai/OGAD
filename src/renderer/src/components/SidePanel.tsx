import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
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
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    panel?.focus()

    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !panel) return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => {
        const style = window.getComputedStyle(element)
        return (
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true' &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        )
      })
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    panel?.addEventListener('keydown', trapFocus)
    return () => {
      panel?.removeEventListener('keydown', trapFocus)
      previousFocus?.focus()
    }
  }, [])

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 transition-opacity duration-150"
        onClick={onClose}
        aria-hidden="true"
        data-testid="side-panel-backdrop"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
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
