import { useSyncExternalStore } from 'react'

type AppTheme = 'light' | 'dark'

function current(): AppTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
  return () => observer.disconnect()
}

/**
 * The theme the app shows now. Follows data-theme on <html>, which theme.ts sets from
 * Settings, the toggle and the OS scheme, so a surface drawn in its own root (Scribe's
 * cards) matches the app rather than the OS. React reads it again once subscribed, so a
 * change between render and subscribe is never missed.
 */
export function useAppTheme(): AppTheme {
  return useSyncExternalStore(subscribe, current)
}
