// The app language: the person's pick (Settings → Language, or the first onboarding step), else the
// computer's language, else English (shared resolveLocale). The pick is kept in this window's storage, as
// the theme is. Catalogs are separate chunks, and only the one in use is loaded.
import { resolveLocale, setCatalog, type Locale, type Strings } from '@offgrid/i18n'

const KEY = 'og-language'
export const LANGUAGE_CHANGED = 'og:language-changed'

const CATALOGS = import.meta.glob<Strings>(
  '../../../../node_modules/@offgrid/i18n/catalogs/*/desktop.json',
  {
    import: 'default'
  }
)

/** The language picked, or null for the computer's language. */
export function pickedLanguage(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** The language this computer prefers, best first. */
export function systemLanguages(): readonly string[] {
  return navigator.languages.length ? navigator.languages : [navigator.language]
}

/** The language the app shows now: the pick, else the computer's, else English. */
export function currentLanguage(): Locale {
  return resolveLocale(systemLanguages(), pickedLanguage())
}

/** Loads and turns on the catalog for the current language. Resolves to the locale now in use. */
export async function applyAppLanguage(): Promise<Locale> {
  const locale = currentLanguage()
  // Every shipped locale, English included, has a catalog file (the i18n check keeps it so).
  const load =
    CATALOGS[`../../../../node_modules/@offgrid/i18n/catalogs/${locale.code}/desktop.json`]!
  setCatalog(locale.code, await load())
  document.documentElement.lang = locale.tag
  return locale
}

/** Saves the pick (null: the computer's language) and tells the app to redraw in it. */
export function setPickedLanguage(code: string | null): void {
  try {
    if (code) localStorage.setItem(KEY, code)
    else localStorage.removeItem(KEY)
  } catch {
    // No storage: the pick lasts until the window closes.
  }
  window.dispatchEvent(new Event(LANGUAGE_CHANGED))
}

/** Calls back after a pick, once its catalog is on. Returns the unsubscribe. */
export function onLanguageChanged(listener: (locale: Locale) => void): () => void {
  const handle = (): void => void applyAppLanguage().then(listener)
  window.addEventListener(LANGUAGE_CHANGED, handle)
  return () => window.removeEventListener(LANGUAGE_CHANGED, handle)
}
