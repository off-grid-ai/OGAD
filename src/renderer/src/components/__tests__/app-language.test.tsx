// @vitest-environment jsdom
// The app language on desktop: the person's pick, else the computer's language, else English; Settings →
// Language and the first onboarding step pick it, and the app redraws in it at once. The real catalogs and
// the real Settings select; the computer's language (navigator.languages) is the boundary, faked.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCatalog, t, TRANSLATED_LOCALES } from '@offgrid/i18n'
import {
  applyAppLanguage,
  currentLanguage,
  pickedLanguage,
  setPickedLanguage,
  systemLanguages
} from '../../lib/app-language'
import { AppLanguageRoot } from '../AppLanguageRoot'
import { LanguageSettingsSection } from '../LanguageSettingsSection'

function computerSpeaks(languages: string[]): void {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0] ?? '')
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setCatalog('en', null)
})

describe('the desktop app language', () => {
  it('follows the computer, so a German computer shows German', async () => {
    computerSpeaks(['de-CH', 'en-US'])
    expect((await applyAppLanguage()).code).toBe('de')
    expect(t('App language')).toBe('App-Sprache')
    expect(document.documentElement.lang).toBe('de')
  })

  it('a pick wins over the computer, and Computer language goes back to it', async () => {
    computerSpeaks(['de-DE'])
    setPickedLanguage('ja')
    expect(pickedLanguage()).toBe('ja')
    expect(currentLanguage().code).toBe('ja')
    setPickedLanguage(null)
    expect(pickedLanguage()).toBeNull()
    expect(currentLanguage().code).toBe('de')
  })

  it('a language we do not ship is English, as written', async () => {
    computerSpeaks(['ko-KR'])
    expect((await applyAppLanguage()).code).toBe('en')
    expect(t('App language')).toBe('App language')
  })

  it('with no language list it reads the one language', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR')
    expect(systemLanguages()).toEqual(['fr-FR'])
  })

  it('with no storage the computer decides, and a pick still redraws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const heard = vi.fn()
    window.addEventListener('og:language-changed', heard)
    expect(pickedLanguage()).toBeNull()
    setPickedLanguage('it')
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener('og:language-changed', heard)
  })

  it.each(TRANSLATED_LOCALES.map((locale) => [locale.code]))(
    '%s ships with its own words',
    async (code) => {
      setPickedLanguage(code)
      expect((await applyAppLanguage()).code).toBe(code)
      expect(t('App language')).not.toBe('App language')
    }
  )
})

describe('picking a language redraws the app', () => {
  it('the screens under the root show the new language at once', async () => {
    computerSpeaks(['en-US'])
    await applyAppLanguage()
    const Screen = (): React.JSX.Element => <p>{t('Computer language')}</p>
    render(
      <AppLanguageRoot>
        <Screen />
      </AppLanguageRoot>
    )
    expect(screen.getByText('Computer language')).toBeTruthy()
    act(() => setPickedLanguage('nl'))
    await waitFor(() => expect(screen.getByText('Taal van de computer')).toBeTruthy())
  })

  it('Settings → Language lists every language in its own name and saves the pick', async () => {
    computerSpeaks(['pl-PL'])
    const user = userEvent.setup()
    render(<LanguageSettingsSection />)
    await user.click(screen.getByRole('combobox', { name: 'App language' }))
    // The computer's language is named under Computer language, and again in the list.
    await waitFor(() => expect(screen.getAllByText('Polski')).toHaveLength(2))
    expect(screen.getByText('German')).toBeTruthy()
    await user.click(await screen.findByRole('option', { name: /Deutsch/ }))
    await waitFor(() => expect(pickedLanguage()).toBe('de'))
    await user.click(screen.getByRole('combobox', { name: 'App language' }))
    await user.click(await screen.findByRole('option', { name: /Computer language/ }))
    await waitFor(() => expect(pickedLanguage()).toBeNull())
  })
})
