import { useEffect, useState } from 'react'
import { SettingsRow } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import {
  COMPUTER_USE_SETTINGS_KEY,
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseCheckpointInterval,
  type ComputerUseContext,
  type ComputerUseScreenshotQuality,
  type ComputerUseScreenshotSize,
  type ComputerUseSettings
} from '../../../shared/computer-use-settings'

export function ComputerUseSettingsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ComputerUseSettings>({
    ...DEFAULT_COMPUTER_USE_SETTINGS
  })

  useEffect(() => {
    void Promise.resolve(window.api.getSettings())
      .then((stored) => {
        setSettings(
          normalizeComputerUseSettings(
            (stored as Record<string, unknown> | undefined)?.[COMPUTER_USE_SETTINGS_KEY]
          )
        )
      })
      .catch(() => {})
  }, [])

  const update = (patch: Partial<ComputerUseSettings>): void => {
    const previous = settings
    const next = normalizeComputerUseSettings({ ...settings, ...patch })
    setSettings(next)
    void Promise.resolve(window.api.saveSetting(COMPUTER_USE_SETTINGS_KEY, next)).catch(() => {
      setSettings(previous)
    })
  }

  return (
    <div>
      <p className="mb-5 text-xs text-neutral-500">
        Choose how much screen detail and task history Computer Use keeps while it works. Each step
        sends only the current screenshot to your model.
      </p>

      <SettingsRow
        label="Task context"
        controlId="computer-use-context"
        hint="Auto follows the loaded model. A fixed size is reduced when the model supports less."
      >
        <SettingsSelect<ComputerUseContext>
          id="computer-use-context"
          label="Computer Use task context"
          value={settings.context}
          onValueChange={(context) => update({ context })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: '16k', label: '16K' },
            { value: '32k', label: '32K' }
          ]}
        />
      </SettingsRow>

      <SettingsRow
        label="Screenshot size"
        controlId="computer-use-screenshot-size"
        hint="Use a larger image when small controls or text are hard to target."
      >
        <SettingsSelect<ComputerUseScreenshotSize>
          id="computer-use-screenshot-size"
          label="Computer Use screenshot size"
          value={settings.screenshotSize}
          onValueChange={(screenshotSize) => update({ screenshotSize })}
          options={[
            { value: 'compact', label: 'Compact · 1024 px' },
            { value: 'balanced', label: 'Balanced · 1440 px' },
            { value: 'large', label: 'Large · 1920 px' }
          ]}
        />
      </SettingsRow>

      <SettingsRow
        label="Resize detail"
        controlId="computer-use-screenshot-quality"
        hint="Higher detail takes more time when Off Grid AI prepares each screenshot."
      >
        <SettingsSelect<ComputerUseScreenshotQuality>
          id="computer-use-screenshot-quality"
          label="Computer Use resize detail"
          value={settings.screenshotQuality}
          onValueChange={(screenshotQuality) => update({ screenshotQuality })}
          options={[
            { value: 'efficient', label: 'Efficient' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'detailed', label: 'Detailed' }
          ]}
        />
      </SettingsRow>

      <SettingsRow
        label="Recovery checkpoint"
        controlId="computer-use-checkpoint"
        hint="Save task progress after this many planning steps."
      >
        <SettingsSelect<`${ComputerUseCheckpointInterval}`>
          id="computer-use-checkpoint"
          label="Computer Use recovery checkpoint"
          value={String(settings.checkpointInterval) as `${ComputerUseCheckpointInterval}`}
          onValueChange={(value) =>
            update({ checkpointInterval: Number(value) as ComputerUseCheckpointInterval })
          }
          options={[
            { value: '8', label: 'Every 8 steps' },
            { value: '9', label: 'Every 9 steps' },
            { value: '10', label: 'Every 10 steps' }
          ]}
        />
      </SettingsRow>

      <div className="flex items-start justify-between gap-4 border-t border-neutral-800/70 pt-4">
        <div>
          <div className="text-sm text-neutral-200">Use past task facts</div>
          <div className="mt-0.5 text-xs text-neutral-600">
            Give the model text outcomes from recent Computer Use tasks. Past screenshots stay out
            of the prompt.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.retrieveOlderVisuals}
          aria-label="Use past task facts"
          onClick={() => update({ retrieveOlderVisuals: !settings.retrieveOlderVisuals })}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-all duration-150 active:scale-95 ${settings.retrieveOlderVisuals ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${settings.retrieveOlderVisuals ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
    </div>
  )
}
