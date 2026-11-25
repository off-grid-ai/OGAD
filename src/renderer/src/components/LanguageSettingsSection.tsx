import { useEffect, useState } from 'react'
import { LOCALES, replyLanguageEnabled, resolveLocale, t } from '@offgrid/i18n'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { persistToggle } from '../lib/persist-toggle'
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

/**
 * "Reply in my language": opt-in, off until the person turns it on. Off, the model answers in the
 * language they write in. Main adds the one prompt line (@offgrid/i18n replyLanguageLine).
 */
function ReplyLanguageToggle(): React.JSX.Element {
  const [on, setOn] = useState(false)
  useEffect(() => {
    void Promise.resolve(window.api.getSettings())
      .then((settings) => {
        const stored = settings.replyInAppLanguage
        setOn(replyLanguageEnabled('', typeof stored === 'boolean' ? stored : null))
      })
      .catch(() => {})
  }, [])
  return (
    <SettingsRow
      label="Reply in my language"
      hint="The AI answers in the app language unless you write in another language."
      controlId="reply-language"
      inline
    >
      <Switch
        id="reply-language"
        checked={on}
        onCheckedChange={(next) =>
          void persistToggle(next, on, setOn, (value) =>
            window.api.saveSetting('replyInAppLanguage', value)
          )
        }
      />
    </SettingsRow>
  )
}

/** Settings → Language. */
export function LanguageSettingsSection(): React.JSX.Element {
  return (
    <>
      <SettingsRow label="App language" controlId="app-language" inline>
        <LanguageSelect id="app-language" />
      </SettingsRow>
      <ReplyLanguageToggle />
    </>
  )
}
