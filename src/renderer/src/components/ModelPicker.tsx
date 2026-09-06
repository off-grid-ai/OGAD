import { useCallback, useEffect, useRef, useState } from 'react'
import { IconLoader2, IconCheck, IconCpu, IconPower } from '@tabler/icons-react'
import { X } from '@phosphor-icons/react'
import { SidePanel } from './SidePanel'
import type { ComputerUseActiveModelProjection } from '../../../shared/computer-use-settings'
import { openModelSettingsPanel } from '@renderer/lib/model-settings-panel'
import { SettingsSelect } from './SettingsSelect'
import {
  modelsFailureMessage,
  type ModelControlCatalogModel,
  type ModelControlProjection,
  type ModelControlSuccess
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

// A section is in exactly one of three states. PENDING is not EMPTY and neither is UNAVAILABLE:
// conflating any two of them is the defect class this whole migration has been removing.
type SectionRead =
  | { readonly state: 'pending' }
  | { readonly state: 'read' }
  | { readonly state: 'unavailable'; readonly message: string }

// Which row's spinner is showing, and WHICH REQUEST owns it. Two clicks on the same model are
// two requests, so the model id cannot be the identity: an older reply would clear a newer
// request's spinner. The model id stays the display key; the operationId is the identity.
interface BusyRequest {
  readonly modelId: string
  readonly operationId: string
}

// An outstanding load confirmation. `message` is the domain's own text and is rendered verbatim.
interface PendingConfirmation {
  readonly confirmationId: string
  readonly message: string
  readonly modelId: string
}

/** The outstanding confirmation an activate answered with, if it answered with one. */
function pendingConfirmationOf(result: ModelControlSuccess): PendingConfirmation | null {
  return result.status === 'confirmation_required'
    ? {
        confirmationId: result.confirmation.confirmationId,
        message: result.confirmation.message,
        modelId: result.confirmation.modelId
      }
    : null
}

/** The consent affordance for a `caution` load. The message is the domain's, rendered verbatim. */
function LoadConfirmationNotice({
  confirmation,
  onConfirm,
  onDecline
}: {
  confirmation: PendingConfirmation
  onConfirm: () => void
  onDecline: () => void
}): React.ReactElement {
  return (
    <div role="alert" className="px-2 py-1.5 text-xs text-amber-400">
      <div>{confirmation.message}</div>
      <div className="mt-1 flex gap-3">
        <button type="button" onClick={onConfirm} className="underline hover:text-amber-300">
          Load anyway
        </button>
        <button type="button" onClick={onDecline} className="underline hover:text-neutral-300">
          Keep current model
        </button>
      </div>
    </div>
  )
}

/** Pending is not empty and neither is unavailable — one message per state, never merged. */
function InventoryEmptyState({
  read,
  label
}: {
  read: SectionRead
  label: string
}): React.ReactElement {
  return (
    <p className="px-2 py-1.5 text-xs text-neutral-600">
      {read.state === 'pending' ? (
        <IconLoader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" />
      ) : read.state === 'read' ? (
        `No ${label.toLowerCase()} model downloaded — get one in Models.`
      ) : (
        `Your ${label.toLowerCase()} models could not be read — this list is unavailable, not empty.`
      )}
    </p>
  )
}

/** The Computer Use section. Its own three-state read; it never blanks the model inventory. */
function ComputerUseSection({
  read,
  computerUse,
  models,
  installed,
  busy,
  onChoose
}: {
  read: SectionRead
  computerUse: ComputerUseActiveModelProjection | null
  models: ModelEntry[]
  installed: string[]
  busy: BusyRequest | null
  onChoose: (modelId: string) => void
}): React.ReactElement {
  return (
    <section aria-label="Computer Use">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-wide text-neutral-600">Computer Use</span>
        {computerUse ? (
          <span className="text-[10px] text-neutral-500">{computerUse.strategyLabel}</span>
        ) : null}
      </div>
      {read.state === 'unavailable' ? (
        <p role="alert" className="px-2 py-1.5 text-xs text-amber-400">
          {`Your Computer Use models could not be read — this section is unavailable, not empty. ${read.message}`}
        </p>
      ) : read.state === 'pending' ? (
        <p className="px-2 py-1.5 text-xs text-neutral-600">
          <IconLoader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" />
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
                    onValueChange={onChoose}
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
        <p className="px-2 py-1.5 text-xs text-neutral-600">No Computer Use model is selected.</p>
      )}
    </section>
  )
}

function openSettings(onClose: () => void): void {
  onClose()
  openModelSettingsPanel('model')
}

export function ModelPicker({ onClose }: { onClose: () => void }): React.ReactElement {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  const [active, setActive] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState<BusyRequest | null>(null)
  const [unload, setUnload] = useState<Record<string, UnloadStatus>>({})
  const [computerUse, setComputerUse] = useState<ComputerUseActiveModelProjection | null>(null)
  // An inventory still in flight is NOT an empty one and NOT a failed one. Only a projection
  // that actually arrived makes "nothing is downloaded" true; only a real refusal makes
  // "could not be read" true. `failure` carries the typed refusal's own message.
  const [inventoryRead, setInventoryRead] = useState<SectionRead>({ state: 'pending' })
  const [failure, setFailure] = useState<string | null>(null)
  // The optional Computer Use read owns its own state: it is never collapsed into "no model
  // selected", never filled with a guessed empty list, and never called failed while pending.
  const [computerUseRead, setComputerUseRead] = useState<SectionRead>({ state: 'pending' })
  // A `caution` memory advice answers `confirmation_required` instead of loading. The token is
  // single-use and domain-owned; we hold it until the user consents or declines.
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)

  // One store, one writer: the most recently ISSUED control request owns it. An answer to a
  // request nobody is waiting for any more — a mount refresh resolving after an activate — must
  // NOT publish, or the panel silently reverts to the pre-command state. `operationId` is the
  // control API's own request identity (it is accepted on the intent and echoed on the
  // success), so ownership is carried by that field rather than by a second copy of the store.
  const controlOwner = useRef<string | null>(null)
  const claimControl = useCallback((): string => {
    const operationId = crypto.randomUUID()
    controlOwner.current = operationId
    // An outstanding consent question belongs to the claim that produced it, so ISSUING any
    // newer command retires it here — at issue, not at reply, and whether or not that newer
    // command later succeeds. Consent the user gave for one model must never stay actionable
    // after they have moved on to another. The confirm leg passes its token by value, so
    // minting its own claim cannot invalidate the very confirmation it is carrying.
    setConfirmation(null)
    return operationId
  }, [])
  const ownsControl = useCallback(
    (operationId: string): boolean => controlOwner.current === operationId,
    []
  )

  const applyProjection = useCallback((projection: ModelControlProjection): void => {
    setModels([...projection.models])
    setInstalled([...projection.installed])
    setActive(
      Object.fromEntries(
        Object.entries(projection.active).map(([surface, value]) => [surface, value.modelId])
      )
    )
    setInventoryRead({ state: 'read' })
  }, [])

  // The canonical model inventory. Owns only its own failure.
  const readInventory = useCallback(async (): Promise<void> => {
    const operationId = claimControl()
    try {
      const outcome = await modelControlClient.control({ type: 'refresh', operationId })
      if (!outcome.ok) {
        if (!ownsControl(operationId)) return
        const message = modelsFailureMessage(outcome.failure)
        setFailure(message)
        setInventoryRead({ state: 'unavailable', message })
        return
      }
      // The success echoes the id we sent; an answer to any other request is not ours to apply.
      if (!ownsControl(outcome.value.operationId)) return
      setFailure(null)
      // Every success status carries the fresh projection, not only `completed`. Dropping the
      // others left the panel showing a stale (or absent) active model after a refusal.
      applyProjection(outcome.value.projection)
    } catch (cause) {
      if (!ownsControl(operationId)) return
      const message = transportFailureMessage(cause)
      setFailure(message)
      setInventoryRead({ state: 'unavailable', message })
    }
  }, [applyProjection, claimControl, ownsControl])

  // Computer Use is an OPTIONAL section read over a separate channel. It is deliberately not
  // combined with the inventory read: a rejection here must never suppress a model-control
  // projection that arrived intact. It reports its own error and guesses nothing.
  const readComputerUse = useCallback(async (): Promise<void> => {
    try {
      setComputerUse(await window.api.getComputerUseActiveModels())
      setComputerUseRead({ state: 'read' })
    } catch (cause) {
      setComputerUseRead({ state: 'unavailable', message: transportFailureMessage(cause) })
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

  // The consent leg of the same journey. It is a SECOND command, so it claims ownership in its
  // own right: its answer publishes, and any answer to a superseded request still does not.
  const confirmActivation = async (pending: PendingConfirmation): Promise<void> => {
    // `pending` is held BY VALUE, so claiming below (which retires the notice) cannot strand
    // this leg: the single-use token travels in the argument, never read back from state.
    const operationId = claimControl()
    setBusy({ modelId: pending.modelId, operationId })
    try {
      const outcome = await modelControlClient.control({
        type: 'confirm-activation',
        confirmationId: pending.confirmationId,
        operationId
      })
      if (!outcome.ok) {
        if (!ownsControl(operationId)) return
        setFailure(modelsFailureMessage(outcome.failure))
        return
      }
      if (!ownsControl(outcome.value.operationId)) return
      setFailure(null)
      applyProjection(outcome.value.projection)
    } catch (cause) {
      if (!ownsControl(operationId)) return
      setFailure(transportFailureMessage(cause))
    } finally {
      setBusy((current) => (current?.operationId === operationId ? null : current))
    }
  }

  const choose = async (mode: PickerMode, m: ModelEntry): Promise<void> => {
    clearUnloadStatus(mode) // re-selecting reloads this modality on next use
    const operationId = claimControl()
    setBusy({ modelId: m.id, operationId })
    try {
      const outcome = await modelControlClient.control({
        type: 'activate',
        modelId: m.id,
        surface: mode,
        operationId
      })
      if (!outcome.ok) {
        if (!ownsControl(operationId)) return
        setFailure(modelsFailureMessage(outcome.failure))
        return
      }
      if (!ownsControl(outcome.value.operationId)) return
      setFailure(null)
      applyProjection(outcome.value.projection)
      setConfirmation(pendingConfirmationOf(outcome.value))
    } catch (cause) {
      if (!ownsControl(operationId)) return
      // A rejected IPC (bridge missing, main process gone, serialization failure) would
      // otherwise escape this void-called handler: the spinner stops and nothing is said.
      setFailure(transportFailureMessage(cause))
    } finally {
      // Clear only THIS request's spinner; a stale answer must not clear a newer one's.
      setBusy((current) => (current?.operationId === operationId ? null : current))
    }
  }

  const chooseComputerUse = async (modelId: string): Promise<void> => {
    if (!modelId) return
    const operationId = claimControl()
    setBusy({ modelId, operationId })
    try {
      const outcome = await modelControlClient.control({
        type: 'activate',
        modelId,
        surface: 'computer_use',
        operationId
      })
      if (!outcome.ok) {
        if (!ownsControl(operationId)) return
        setFailure(modelsFailureMessage(outcome.failure))
        return
      }
      if (!ownsControl(outcome.value.operationId)) return
      setFailure(null)
      applyProjection(outcome.value.projection)
      setConfirmation(pendingConfirmationOf(outcome.value))
    } catch (cause) {
      if (!ownsControl(operationId)) return
      setFailure(transportFailureMessage(cause))
    } finally {
      // Clear only THIS request's spinner; a stale answer must not clear a newer one's.
      setBusy((current) => (current?.operationId === operationId ? null : current))
    }
  }

  // Unload one modality's model from memory now (frees RAM; reloads on next use).
  // Independent per modality — writes only this mode's status.
  const unloadModel = async (mode: PickerMode): Promise<void> => {
    setUnloadStatus(mode, 'unloading')
    const operationId = claimControl()
    try {
      const outcome = await modelControlClient.control({
        type: 'unload',
        surface: mode,
        operationId
      })
      if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
      // Ownership gates the SHARED inventory only. This modality's unload status is per-mode
      // state that no other modality's command supersedes, so it always records its own answer.
      if (ownsControl(outcome.value.operationId)) applyProjection(outcome.value.projection)
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
        {confirmation ? (
          <LoadConfirmationNotice
            confirmation={confirmation}
            onConfirm={() => void confirmActivation(confirmation)}
            onDecline={() => setConfirmation(null)}
          />
        ) : null}
        <ComputerUseSection
          read={computerUseRead}
          computerUse={computerUse}
          models={models}
          installed={installed}
          busy={busy}
          onChoose={(modelId) => void chooseComputerUse(modelId)}
        />
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
                <InventoryEmptyState read={inventoryRead} label={label} />
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
                      {busy?.modelId === m.id ? (
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
