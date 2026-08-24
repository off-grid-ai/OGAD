import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { useEscapeToClose } from '@renderer/lib/use-escape-to-close'

type SidePanelProps = {
  ariaLabel: string
  children: ReactNode
  onClose: () => void
  className?: string
  style?: CSSProperties
  restoreFocusRef?: RefObject<HTMLElement | null>
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
  style,
  restoreFocusRef
}: SidePanelProps): React.JSX.Element {
  useEscapeToClose(onClose)
  const reduceMotion = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const previousFocus =
      restoreFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const panel = panelRef.current
    panel?.focus()

    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !panel) return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => {
        const computedStyle = window.getComputedStyle(element)
        return (
          !element.matches(':disabled') &&
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true' &&
          computedStyle.display !== 'none' &&
          computedStyle.visibility !== 'hidden'
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
  }, [restoreFocusRef])

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" data-testid="side-panel-layer">
      <motion.div
        className="pointer-events-auto absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
        data-testid="side-panel-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.4, 0, 0.2, 1] }}
      />
      <motion.div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`pointer-events-auto absolute bottom-0 right-0 top-0 flex h-dvh max-w-full flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl ${className}`}
        style={style}
        initial={reduceMotion ? false : { x: '100%' }}
        animate={{ x: '0%' }}
        exit={reduceMotion ? { opacity: 0 } : { x: '100%' }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.4, 0, 0.2, 1] }}
      >
        {children}
      </motion.div>
    </div>,
    document.body
  )
}
