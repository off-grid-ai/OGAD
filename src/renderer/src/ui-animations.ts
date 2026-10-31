import { useEffect, useState } from 'react'

// Hover and click animations (Settings > UI). On by default. Kept like the theme: saved in
// localStorage and applied as data-ui-animations on <html> before first paint, so main.css turns
// the motion off in one place instead of every component asking.

const KEY = 'og-ui-animations'
/** Fired on window when the setting changes; `detail` is the new value. */
export const UI_ANIMATIONS_CHANGED = 'og:ui-animations-changed'
const CHANGED = UI_ANIMATIONS_CHANGED

export function uiAnimationsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function applyUiAnimations(): void {
  document.documentElement.dataset.uiAnimations = uiAnimationsOn() ? 'on' : 'off'
}

export function setUiAnimations(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* The attribute below still changes this session. */
  }
  document.documentElement.dataset.uiAnimations = on ? 'on' : 'off'
  window.dispatchEvent(new CustomEvent<boolean>(CHANGED, { detail: on }))
}

/** For the few hover and press motions written in JS (motion/react whileHover, whileTap), which
 *  CSS cannot reach. */
export function useUiAnimations(): boolean {
  const [on, setOn] = useState(uiAnimationsOn)
  useEffect(() => {
    const handle = (event: Event): void => setOn((event as CustomEvent<boolean>).detail)
    window.addEventListener(CHANGED, handle)
    return () => window.removeEventListener(CHANGED, handle)
  }, [])
  return on
}
