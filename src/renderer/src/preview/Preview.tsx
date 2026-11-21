// The preview's root: the app in the language the translate editor (or ?lang=) asks for. See main.tsx.
import { useEffect, useState } from 'react'
import { setCatalog, type Strings } from '@offgrid/i18n'
import { TooltipProvider } from '../components/ui/tooltip'
import App from '../App'

const params = new URLSearchParams(window.location.search)

interface CatalogMessage {
  type: 'offgrid-i18n'
  locale: string
  strings: Strings | null
}

const isCatalogMessage = (data: unknown): data is CatalogMessage =>
  typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'offgrid-i18n'

// A locale code (en, pt-BR, zh-Hant), so ?lang= can only name a catalog folder, never a path.
const LOCALE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

async function loadCatalog(code: string): Promise<Strings> {
  if (!LOCALE_CODE.test(code)) return {}
  const read = async (file: string): Promise<Strings> => {
    const res = await fetch(`./catalogs/${code}/${file}.json`)
    return res.ok ? ((await res.json()) as Strings) : {}
  }
  const [common, desktop] = await Promise.all([read('common'), read('desktop')])
  return { ...common, ...desktop }
}

/** Remounts the app when the catalog changes, so every memoized screen redraws in the new language. */
export function Preview(): React.JSX.Element {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const apply = (locale: string, strings: Strings | null): void => {
      setCatalog(locale, strings)
      document.documentElement.lang = locale
      setVersion((v) => v + 1)
    }
    const lang = params.get('lang')
    if (lang) void loadCatalog(lang).then((strings) => apply(lang, strings))
    const onMessage = (event: MessageEvent): void => {
      // The editor serves this preview from its own address, so only that origin may send a catalog.
      if (
        event.origin === window.location.origin &&
        event.source === window.parent &&
        isCatalogMessage(event.data)
      )
        apply(event.data.locale, event.data.strings)
    }
    window.addEventListener('message', onMessage)
    window.parent.postMessage(
      { type: 'offgrid-i18n:ready', app: 'desktop' },
      window.location.origin
    )
    return () => window.removeEventListener('message', onMessage)
  }, [])
  return (
    <TooltipProvider delayDuration={300}>
      <App key={version} />
    </TooltipProvider>
  )
}
