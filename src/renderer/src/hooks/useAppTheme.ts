import { useEffect, useState } from 'react'

type AppTheme = 'light' | 'dark'

function current(): AppTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * The theme the app shows now. Follows data-theme on <html>, which theme.ts sets from
 * Settings, the toggle and the OS scheme, so a surface drawn in its own root (Scribe's
 * cards) matches the app rather than the OS.
 */
export function useAppTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(current)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(current()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])
  return theme
}
