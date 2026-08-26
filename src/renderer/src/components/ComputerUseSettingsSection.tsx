import { useEffect, useState } from 'react'
import { SettingsRow } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import {
  COMPUTER_USE_SETTINGS_KEY,
  DEFAULT_COMPUTER_USE_SETTINGS,
  normalizeComputerUseSettings,
  type ComputerUseCheckpointInterval,
  type ComputerUseContext,
  type ComputerUseModelStrategy,
  type ComputerUseScreenshotQuality,
  type ComputerUseScreenshotSize,
  type ComputerUseSettings,
  type ComputerUseVisualHistoryFrames
} from '../../../shared/computer-use-settings'

export function ComputerUseSettingsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ComputerUseSettings>({
    ...DEFAULT_COMPUTER_USE_SETTINGS
  })
  const [specialists, setSpecialists] = useState<Array<{ id: string; name: string }>>([])
  const [activeSpecialist, setActiveSpecialist] = useState('')
  const [specialistError, setSpecialistError] = useState<string | null>(null)

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

  useEffect(() => {
    void Promise.all([
      window.api.getModelCatalog(),
      window.api.getInstalledModels(),
      window.api.getActiveModalities()
    ])
      .then(([catalog, installedIds, active]) => {
        const installed = new Set(installedIds as string[])
        const choices = (catalog as { models: Array<Record<string, unknown>> }).models
          .filter(
            (model) =>
              model.kind === 'computer_use' &&
              model.availability !== 'coming_soon' &&
              typeof model.id === 'string' &&
              installed.has(model.id)
          )
          .map((model) => ({ id: String(model.id), name: String(model.name ?? model.id) }))
        setSpecialists(choices)
        const selected = (active as Record<string, unknown>).computer_use
        setActiveSpecialist(typeof selected === 'string' ? selected : '')
      })
      .catch(() => setSpecialistError('Could not load installed Computer Use models.'))
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
        Choose which local model controls your screen, plus how much screen detail and task history
        it keeps while it works.
      </p>

      <SettingsRow
        label="Model strategy"
        controlId="computer-use-model-strategy"
        hint={
          settings.modelStrategy === 'same_as_chat'
            ? 'Uses the resident Chat model. Computer Use still sends a screenshot when the task needs visual grounding.'
            : 'Loads your Computer Use specialist for the task, then restores the resident Chat model.'
        }
      >
        <SettingsSelect<ComputerUseModelStrategy>
          id="computer-use-model-strategy"
          label="Computer Use model strategy"
          value={settings.modelStrategy}
          onValueChange={(modelStrategy) => update({ modelStrategy })}
          options={[
            { value: 'same_as_chat', label: 'Same as Chat' },
            { value: 'separate_specialist', label: 'Separate specialist' }
          ]}
        />
      </SettingsRow>

      {settings.modelStrategy === 'separate_specialist' ? (
        <SettingsRow
          label="Specialist model"
          controlId="computer-use-specialist-model"
          hint={
            specialistError ??
            (specialists.length > 0
              ? 'This model loads only for Computer Use, then Off Grid restores Chat.'
              : 'Install a ready Computer Use model before choosing a specialist.')
          }
        >
          {specialists.length > 0 ? (
            <SettingsSelect<string>
              id="computer-use-specialist-model"
              label="Computer Use specialist model"
              value={activeSpecialist}
              onValueChange={(modelId) => {
                if (!modelId) return
                const previous = activeSpecialist
                setActiveSpecialist(modelId)
                setSpecialistError(null)
                void window.api
                  .setActiveModalModel('computer_use', modelId)
                  .then((result) => {
                    if (!result?.success) {
                      setActiveSpecialist(previous)
                      setSpecialistError(result?.error ?? 'Could not select this specialist.')
                    }
                  })
                  .catch(() => {
                    setActiveSpecialist(previous)
                    setSpecialistError('Could not select this specialist.')
                  })
              }}
              options={[
                { value: '', label: 'Choose model' },
                ...specialists.map((model) => ({ value: model.id, label: model.name }))
              ]}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                window.sessionStorage.setItem('offgrid:models:initial-kind', 'computer_use')
                window.dispatchEvent(new CustomEvent('og:navigate', { detail: 'models' }))
              }}
              className="border border-neutral-700 px-3 py-2 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
            >
              Open Computer Use catalog
            </button>
          )}
        </SettingsRow>
      ) : null}

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
        label="Visual history"
        controlId="computer-use-visual-history"
        hint="Keep recent screenshots for visual continuity. Older steps stay as compact text."
      >
        <SettingsSelect<`${ComputerUseVisualHistoryFrames}`>
          id="computer-use-visual-history"
          label="Computer Use visual history"
          value={String(settings.visualHistoryFrames) as `${ComputerUseVisualHistoryFrames}`}
          onValueChange={(value) =>
            update({ visualHistoryFrames: Number(value) as ComputerUseVisualHistoryFrames })
          }
          options={[
            { value: '0', label: 'Current only' },
            { value: '1', label: '1 prior screenshot' },
            { value: '2', label: '2 prior screenshots' },
            { value: '5', label: '5 prior screenshots' }
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
