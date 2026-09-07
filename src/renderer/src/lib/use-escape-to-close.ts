import { useEffect } from 'react'

// Dismiss-on-Escape for overlays/panels/slide-overs. One place so every panel dismisses
// the same way (Escape closes), instead of each re-implementing a keydown listener.
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return

      // A nested popup owns the first Escape press. Radix portals the popup to
      // document.body, so checking the event path is more reliable than checking
      // whether the popup is a DOM child of the panel.
      const target = e.target
      if (target instanceof Element && target.closest('[role="menu"], [role="listbox"]')) return

      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}
