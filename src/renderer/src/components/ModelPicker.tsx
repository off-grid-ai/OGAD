import { useCallback, useEffect, useState } from 'react'
import { IconLoader2, IconCheck, IconCpu, IconPower } from '@tabler/icons-react'
import { X } from '@phosphor-icons/react'
import { SidePanel } from './SidePanel'
import type { ComputerUseActiveModelProjection } from '../../../shared/computer-use-settings'
import { openModelSettingsPanel } from '@renderer/lib/model-settings-panel'
import { SettingsSelect } from './SettingsSelect'
import {
  modelsFailureMessage,
  type ModelControlCatalogModel,
  type ModelControlProjection
} from '@offgrid/application'
import { modelControlClient } from '@renderer/lib/model-control-client'

type ModelEntry = ModelControlCatalogModel

const MODALITIES: {
  label: string
  kinds: string[]
  mode: 'text' | 'image' | 'speech' | 'transcription'
}[] = [
  { label: 'Text & Vision', kinds: ['text', 'vision'], mode: 'text' },
  { label: 'Image', kinds: ['image'], mode: 'image' },
  { label: 'Voice', kinds: ['voice'], mode: 'speech' },
  { label: 'Transcription', kinds: ['transcription'], mode: 'transcription' }
]
type PickerMode = (typeof MODALITIES)[number]['mode']

// Per-modality unload status. Absent = loaded/idle. Kept as a map keyed by mode so each
// modality is independent — unloading one must NOT reset another's state.
type UnloadStatus = 'unloading' | 'unloaded' | 'error'

/** A rejected IPC carries no typed failure. Report what it said, never a guessed value. */
function transportFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function openSettings(onClose: () => void): void {
  onClose()
  openModelSettingsPanel('model')
}

export function ModelPicker({ onClose }: { onClose: () => void }): React.ReactElement {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  const [active, setActive] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [unload, setUnload] = useState<Record<string, UnloadStatus>>({})
  const [computerUse, setComputerUse] = useState<ComputerUseActiveModelProjection | null>(null)
  // An inventory we never managed to read is NOT an empty inventory. `inventoryRead` stays
  // false until a projection has actually been applied, so a failed read can never be
  // rendered as "nothing is downloaded". `failure` carries the typed refusal's own message.
  const [inventoryRead, setInventoryRead] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // The optional Computer Use read owns its own failure. An unread section is its own state:
  // it is never collapsed into "no model selected", and never filled with a guessed empty list.
  const [computerUseFailure, setComputerUseFailure] = useState<string | null>(null)

  const applyProjection = useCallback((projection: ModelControlProjection): void => {
    setModels([...projection.models])
    setInstalled([...projection.installed])
    setActive(
      Object.fromEntries(
        Object.entries(projection.active).map(([surface, value]) => [surface, value.modelId])
      )
    )
    setInventoryRead(true)
  }, [])

  // The canonical model inventory. Owns only its own failure.
  const readInventory = useCallback(async (): Promise<void> => {
    try {
      const outcome = await modelControlClient.control({ type: 'refresh' })
      if (!outcome.ok) {
        setFailure(modelsFailureMessage(outcome.failure))
        return
      }
      setFailure(null)
      // Every success status carries the fresh projection, not only `completed`. Dropping the
      // others left the panel showing a stale (or absent) active model after a refusal.
      applyProjection(outcome.value.projection)
    } catch (cause) {
      setFailure(transportFailureMessage(cause))
    }
  }, [applyProjection])

  // Computer Use is an OPTIONAL section read over a separate channel. It is deliberately not
  // combined with the inventory read: a rejection here must never suppress a model-control
  // projection that arrived intact. It reports its own error and guesses nothing.
  const readComputerUse = useCallback(async (): Promise<void> => {
    try {
      setComputerUse(await window.api.getComputerUseActiveModels())
      setComputerUseFailure(null)
    } catch (cause) {
      setComputerUseFailure(transportFailureMessage(cause))
    }
  }, [])

  useEffect(() => {
    // Both start now and settle independently; neither can reject out or block the other.
    void readInventory()
    void readComputerUse()
  }, [readInventory, readComputerUse])

  const setUnloadStatus = (mode: string, status: UnloadStatus): void =>
    setUnload((s) => ({ ...s, [mode]: status }))
  const clearUnloadStatus = (mode: string): void =>
    setUnload((s) => {
      if (!(mode in s)) {
        return s
      }
      const next = { ...s }
      delete next[mode]
      return next
    })

  const choose = async (mode: PickerMode, m: ModelEntry): Promise<void> => {
    setBusy(m.id)
    clearUnloadStatus(mode) // re-selecting reloads this modality on next use
    try {
      const outcome = await modelControlClient.control({
        type: 'activate',
        modelId: m.id,
        surface: mode
      })
      if (!outcome.ok) {
        setFailure(modelsFailureMessage(outcome.failure))
        return
      }
      setFailure(null)
      applyProjection(outcome.value.projection)
    } catch (cause) {
      // A rejected IPC (bridge missing, main process gone, serialization failure) would
      // otherwise escape this void-called handler: the spinner stops and nothing is said.
      setFailure(transportFailureMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const chooseComputerUse = async (modelId: string): Promise<void> => {
    if (!modelId) return
    setBusy(modelId)
    try {
      const outcome = await modelControlClient.control({
        type: 'activate',
        modelId,
        surface: 'computer_use'
      })
      if (!outcome.ok) {
        setFailure(modelsFailureMessage(outcome.failure))
        return
      }
      setFailure(null)
      applyProjection(outcome.value.projection)
    } catch (cause) {
      setFailure(transportFailureMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  // Unload one modality's model from memory now (frees RAM; reloads on next use).
  // Independent per modality — writes only this mode's status.
  const unloadModel = async (mode: PickerMode): Promise<void> => {
    setUnloadStatus(mode, 'unloading')
    try {
      const outcome = await modelControlClient.control({ type: 'unload', surface: mode })
      if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
      applyProjection(outcome.value.projection)
      // `ok` means the command was carried and answered — NOT that the model left memory.
      // Only `completed` means unloaded; every other status means it is still resident, and
      // reporting "Unloaded" for those would present a refusal as a finished action.
      setUnloadStatus(mode, outcome.value.status === 'completed' ? 'unloaded' : 'error')
    } catch (e) {
      console.error('[models] unload failed', e)
      setUnloadStatus(mode, 'error')
    }
  }

  return (
    <SidePanel ariaLabel="Active models" onClose={onClose} className="w-[30vw] min-w-[420px]">
      <div className="flex items-center justify-between border-b border-neutral-900 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-white">
          <IconCpu className="h-4 w-4 text-green-500" aria-hidden /> Active models
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openSettings(onClose)}
            className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:text-white"
          >
            Settings
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-500 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {failure ? (
          <p role="alert" className="px-2 py-1.5 text-xs text-amber-400">
            {failure}
          </p>
        ) : null}
        <section aria-label="Computer Use">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wide text-neutral-600">
              Computer Use
            </span>
            {computerUse ? (
              <span className="text-[10px] text-neutral-500">{computerUse.strategyLabel}</span>
            ) : null}
          </div>
          {computerUseFailure !== null ? (
            <p role="alert" className="px-2 py-1.5 text-xs text-amber-400">
              {`Your Computer Use models could not be read — this section is unavailable, not empty. ${computerUseFailure}`}
            </p>
          ) : computerUse?.models.length ? (
            <div className="space-y-1">
              {computerUse.models.map((model) => (
                <div
                  key={model.role}
                  className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[9px] uppercase tracking-wide text-neutral-600">
                      {model.role === 'reasoner' ? 'Reasoner' : 'Grounding specialist'}
                    </span>
                    {model.role === 'grounding_specialist' ? (
                      <SettingsSelect<string>
                        id="active-computer-use-model"
                        label="Active Computer Use model"
                        value={model.modelId}
                        disabled={busy !== null}
                        onValueChange={(modelId) => void chooseComputerUse(modelId)}
                        options={[
                          ...models
                            .filter(
                              (candidate) =>
                                installed.includes(candidate.id) &&
                                candidate.availability !== 'coming_soon' &&
                                (candidate.kind === 'computer_use' || candidate.grounder === true)
                            )
                            .map((candidate) => ({ value: candidate.id, label: candidate.name })),
                          ...(models.some((candidate) => candidate.id === model.modelId)
                            ? []
                            : [{ value: model.modelId, label: model.modelName }])
                        ]}
                      />
                    ) : (
                      <span className="block truncate text-neutral-200">{model.modelName}</span>
                    )}
                  </span>
                  {model.remote ? (
                    <span className="shrink-0 rounded-sm border border-green-500/50 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                      Remote
                    </span>
                  ) : (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-neutral-600">
                      On device
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="px-2 py-1.5 text-xs text-neutral-600">
              No Computer Use model is selected.
            </p>
          )}
        </section>
        {MODALITIES.map(({ label, kinds, mode }) => {
          const list = models.filter((m) => kinds.includes(m.kind) && installed.includes(m.id))
          const cur = active[mode]
          const status = unload[mode]
          const isActive = (m: ModelEntry): boolean => cur === m.id
          return (
            <div key={mode}>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-neutral-600">
                  {label}
                </span>
                {cur && (
                  <button
                    type="button"
                    onClick={() => void unloadModel(mode)}
                    disabled={status === 'unloading' || status === 'unloaded'}
                    title={
                      status === 'error'
                        ? 'Unload unavailable — restart the app'
                        : status === 'unloaded'
                          ? 'Already unloaded — reloads on next use'
                          : 'Unload from memory now — frees RAM; reloads on next use'
                    }
                    className={`flex items-center gap-1 text-[10px] uppercase tracking-wide transition-colors disabled:opacity-40 ${
                      status === 'error' ? 'text-amber-400' : 'text-neutral-500 hover:text-red-400'
                    }`}
                  >
                    {status === 'unloading' ? (
                      <IconLoader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <IconPower className="h-3 w-3" />
                    )}
                    {status === 'error' ? 'Restart to unload' : 'Unload'}
                  </button>
                )}
              </div>
              {list.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-neutral-600">
                  {inventoryRead
                    ? `No ${label.toLowerCase()} model downloaded — get one in Models.`
                    : `Your ${label.toLowerCase()} models could not be read — this list is unavailable, not empty.`}
                </p>
              ) : (
                <div className="space-y-1">
                  {list.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => choose(mode, m)}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                        isActive(m)
                          ? 'border-green-500/60 bg-neutral-900 text-white'
                          : 'border-neutral-800 text-neutral-300 hover:bg-neutral-900/60'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{m.name}</span>
                        {m.remoteServerId ? (
                          <span className="shrink-0 rounded-sm border border-green-500/50 px-1 py-px text-[8px] uppercase tracking-wide text-green-500">
                            Remote
                          </span>
                        ) : null}
                      </span>
                      {busy === m.id ? (
                        <IconLoader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-500" />
                      ) : isActive(m) && status === 'unloaded' ? (
                        // Still the active selection, but freed from memory — one coherent
                        // state, not a green check next to an "unloaded" label.
                        <span className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500">
                          <IconPower className="h-3 w-3" /> Unloaded
                        </span>
                      ) : isActive(m) ? (
                        <IconCheck className="h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        <p className="px-1 pt-1 text-[10px] leading-relaxed text-neutral-600">
          Your selected Text &amp; Vision model handles chat and supported vision work. Image,
          Voice, and Transcription use their selected models.
        </p>
      </div>
    </SidePanel>
  )
}
