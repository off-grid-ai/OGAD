import { useState } from 'react'
import { LOCALES, resolveLocale, t } from '@offgrid/i18n'
import { SettingsRow } from './SettingsRow'
import { SettingsSelect, type SettingsSelectOption } from './SettingsSelect'
import { pickedLanguage, setPickedLanguage, systemLanguages } from '../lib/app-language'

const COMPUTER = 'system'

/**
 * The language list: the computer's language or any shipped one, each in its own name. The pick applies at
 * once. Settings → Language and the first onboarding step both show it.
 */
export function LanguageSelect({ id }: { id: string }): React.JSX.Element {
  const [value, setValue] = useState(() => pickedLanguage() ?? COMPUTER)
  const computer = resolveLocale(systemLanguages())
  const options: SettingsSelectOption<string>[] = [
    { value: COMPUTER, label: t('Computer language'), hint: computer.name },
    ...LOCALES.map((locale) => ({
      value: locale.code,
      label: locale.name,
      hint: locale.english
    }))
  ]
  return (
    <SettingsSelect<string>
      id={id}
      label="App language"
      value={value}
      options={options}
      onValueChange={(next) => {
        setValue(next)
        setPickedLanguage(next === COMPUTER ? null : next)
      }}
    />
  )
}

/** Settings → Language. */
export function LanguageSettingsSection(): React.JSX.Element {
  return (
    <SettingsRow label="App language" controlId="app-language" inline>
      <LanguageSelect id="app-language" />
    </SettingsRow>
  )
}
