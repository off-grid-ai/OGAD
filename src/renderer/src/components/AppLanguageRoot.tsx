import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { activeLocale } from '@offgrid/i18n'
import { onLanguageChanged } from '../lib/app-language'

/**
 * Redraws everything under it in a newly picked language. Screens memoize their text, so a redraw alone
 * would keep the old words: the key change remounts them. The route lives in the URL, so the same screen
 * comes back.
 */
export function AppLanguageRoot({ children }: { children: ReactNode }): React.JSX.Element {
  const [code, setCode] = useState(() => activeLocale().code)
  useEffect(() => onLanguageChanged((locale) => setCode(locale.code)), [])
  return <Fragment key={code}>{children}</Fragment>
}
