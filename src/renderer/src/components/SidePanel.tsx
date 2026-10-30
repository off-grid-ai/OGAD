import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
import {
  Sheet,
  SheetContent,
  SheetPortal,
  useSheet
} from '@offgrid/operator-ui/operator/animate-ui/primitives/radix/sheet'
import { isNestedPopupEscape, useEscapeToClose } from '@renderer/lib/use-escape-to-close'
import { acquireNativeSurfaceOcclusion } from '@renderer/lib/native-surface-occlusion'
import { openUsageOverlay, overlayScreenName } from '@renderer/lib/usage-tracker'

type SidePanelProps = {
  ariaLabel: string
  children: ReactNode
  onClose: () => void
  className?: string
  style?: CSSProperties
  restoreFocusRef?: RefObject<HTMLElement | null>
  modal?: boolean
  /** Mount inside this element instead of the document body. */
  container?: HTMLElement | null
}

// The renderer's top layer: side panels sit above every other surface, the backdrop just under.
export const PANEL_LAYER = 2147483647

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The modal panel's scrim. The library's SheetOverlay renders nothing while Radix runs non-modal
 * (see below), so the scrim is OGAD's own: it fades in, fades out with the sheet's exit, and stops
 * catching clicks as soon as the panel starts closing.
 */
function SidePanelBackdrop({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { isOpen } = useSheet()
  return (
    <div
      aria-hidden="true"
      data-testid="side-panel-backdrop"
      className="fixed inset-0 bg-black/30 backdrop-blur-[2px]"
      style={{
        zIndex: PANEL_LAYER - 1,
        pointerEvents: isOpen ? 'auto' : 'none',
        opacity: isOpen ? 1 : 0,
        animation: isOpen ? 'og-overlay-in 160ms ease-out' : undefined,
        transition: 'opacity 130ms ease-in'
      }}
      // Keep focus in the panel through the click, so closing still hands it back.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClose}
    />
  )
}

/**
 * Shared frame for dismissible Desktop side panels, on the library's animate sheet: it portals,
 * slides in and out on the sheet's spring (the exit also plays when a caller's AnimatePresence
 * removes the panel), holds native child views below it until the exit has finished, and returns
 * focus where the panel was opened from (or to restoreFocusRef).
 *
 * The sheet runs non-modal at the Radix level on purpose: a Radix modal blocks pointer events and
 * pulls focus out of every popup that is not a Radix layer, and the settings pickers inside these
 * panels are base-ui popups portalled to the body. The modal behaviour is therefore OGAD's own, as
 * before: the backdrop owns outside-click dismissal, Escape closes it unless a nested picker
 * owns the press (the shared rule in use-escape-to-close), and Tab cycles inside a modal panel.
 */
export function SidePanel({
  ariaLabel,
  children,
  onClose,
  className = '',
  style,
  restoreFocusRef,
  modal = true,
  container
}: SidePanelProps): React.JSX.Element {
  useEscapeToClose(onClose)
  const panelRef = useRef<HTMLDivElement>(null)
  // An open panel is a screen of its own for opt-in usage data (lib/usage-tracker.ts).
  useEffect(() => openUsageOverlay(overlayScreenName('panel', ariaLabel)), [ariaLabel])

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    const panel = panelRef.current
    if (!modal || event.key !== 'Tab' || !panel) return
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => {
        const computedStyle = window.getComputedStyle(element)
        return (
          !element.matches(':disabled') &&
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true' &&
          computedStyle.display !== 'none' &&
          computedStyle.visibility !== 'hidden'
        )
      }
    )
    if (focusable.length === 0) {
      event.preventDefault()
      panel.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <Sheet open modal={false} onOpenChange={(open) => !open && onClose()}>
      <SheetPortal container={container ?? undefined}>
        {modal && <SidePanelBackdrop onClose={onClose} />}
        <SheetContent
          ref={panelRef}
          side="right"
          aria-label={ariaLabel}
          aria-modal={modal || undefined}
          data-testid="side-panel-layer"
          restoreFocusRef={restoreFocusRef}
          occlusion={acquireNativeSurfaceOcclusion}
          // Radix sees Escape first (a capture listener on the document), so preventing it here
          // would also hide the key from the shared hook and nothing would close the panel. Let the
          // sheet dismiss through onOpenChange, except when a nested picker owns the press.
          onEscapeKeyDown={(event) => {
            if (isNestedPopupEscape(event.target)) event.preventDefault()
          }}
          // Outside clicks belong to the backdrop above.
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            panelRef.current?.focus()
          }}
          onKeyDown={trapFocus}
          className={`flex h-full max-h-svh max-w-full flex-col border-l border-border/60 bg-background/85 font-mono shadow-2xl outline-none backdrop-blur-xl ${className}`}
          style={{ zIndex: PANEL_LAYER, pointerEvents: 'auto', ...style }}
        >
          {children}
        </SheetContent>
      </SheetPortal>
    </Sheet>
  )
}
