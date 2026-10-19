import { useRuntimeBackends } from '../hooks/useRuntimeBackends'
import {
  canonicalModelId,
  modelCapabilities,
  modelSizeLabel,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelFile as CatalogModelFile
} from '@offgrid/models'
import {
  modelRuntimeBackend,
  runtimeBackendLabel,
  type RuntimeId
} from '../../../shared/runtime-backends'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Brain, Cpu, Eye, GearSix, PencilSimple, Translate, Wrench, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { ListRow } from '@offgrid/operator-ui/operator/list-row'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { SidePanel } from './SidePanel'
import { Button } from './ui/button'
import { IconTip } from './IconTip'
import { openModelSettingsPanel } from '@renderer/lib/model-settings-panel'
import { TaskLineups } from './TaskLineups'
import { ActiveModelSlot, type UnloadStatus } from './ActiveModelSlot'
import { isStagedDecisionModel, useTaskRoles } from '../lib/task-roles'
import { resolveActiveTextModel } from '../lib/model-summary'
import { invalidateLlmSettings } from '../lib/settings-invalidation'
import { Field, FieldError } from '@offgrid/operator-ui/operator/coss/field'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any => (window as any).api

interface ModelFile {
  name: string
  role?: CatalogModelFile['role']
  sizeBytes?: number
}
interface ModelEntry {
  id: string
  name: string
  kind: string
  files?: ModelFile[]
  remoteServerId?: string
  grounder?: boolean
  tags?: string[]
  availability?: 'ready' | 'coming_soon'
  // Read by the shared capability rule (catalog fields, plus tools/reasoning from the template).
  sourceModelId?: string
  params?: number
  imageModes?: string[]
  engine?: string
  tools?: boolean
  reasoning?: boolean
}

// The text/vision LLM is selected by catalog id (it reloads llama-server); image
// and transcription runtimes resolve by FILENAME on disk; voice is one engine.
const MODALITIES: {
  label: string
  kinds: string[]
  mode: 'text' | 'image' | 'speech' | 'transcription'
}[] = [
  { label: 'Text & Vision', kinds: ['text', 'vision'], mode: 'text' },
  { label: 'Image', kinds: ['image'], mode: 'image' },
  { label: 'Voice', kinds: ['voice', 'speech'], mode: 'speech' },
  { label: 'Transcription', kinds: ['transcription'], mode: 'transcription' }
]
type PickerMode = (typeof MODALITIES)[number]['mode']

// Picker mode -> runtime Modality (the id the unload/residency seam uses). One map,
// so the composer chip / panel / any future surface all resolve unload the same way.
const MODE_TO_MODALITY: Record<PickerMode, string> = {
  text: 'llm',
  image: 'image',
  speech: 'tts',
  transcription: 'stt'
}

function primaryFile(m: ModelEntry): string {
  return m.files?.find((f) => f.role === 'primary')?.name ?? m.files?.[0]?.name ?? m.id
}

function primaryVariant(m: ModelEntry): string | null {
  const file = primaryFile(m)
  if (!file.toLowerCase().endsWith('.gguf')) return null
  return file.slice(0, -'.gguf'.length).split('-').at(-1) ?? null
}

// The glyph for each capability; the shared rule decides which apply and what they are called.
const CAPABILITY_ICONS: Record<ModelCapability, React.ReactElement> = {
  vision: <Eye />,
  tools: <Wrench />,
  reasoning: <Brain />,
  multilingual: <Translate />,
  image_edit: <PencilSimple />
}
const CAPABILITY_LABELS = new Map(MODEL_CAPABILITIES.map(({ id, label }) => [id, label]))

// Capability icons alone (no size): shown on the chosen model's card, next to its load state.
function capabilityIcons(m: ModelEntry): React.ReactNode {
  const capabilities = modelCapabilities(m)
  if (capabilities.length === 0) return null
  return capabilities.map((capability) => (
    <span
      key={capability}
      role="img"
      title={CAPABILITY_LABELS.get(capability)}
      aria-label={CAPABILITY_LABELS.get(capability)}
      className="flex text-green-500 [&>svg]:h-3.5 [&>svg]:w-3.5"
    >
      {CAPABILITY_ICONS[capability]}
    </span>
  ))
}

// The right side of a dropdown row: capability icons, then the size. Undefined when nothing to say.
function optionMeta(m: ModelEntry): React.ReactNode {
  const size = modelSizeLabel(m)
  const icons = capabilityIcons(m)
  if (!size && !icons) return undefined
  return (
    <>
      {icons}
      {size ? <span className="tabular-nums">{size}</span> : null}
    </>
  )
}

function openSettings(onClose: () => void): void {
  onClose()
  openModelSettingsPanel('model')
}

export function ModelPicker({ onClose }: { onClose: () => void }): React.ReactElement {
  const backends = useRuntimeBackends()
  const backendFor = (id: RuntimeId, modelIds: string[]): string =>
    runtimeBackendLabel(modelRuntimeBackend(backends, id, modelIds))
  const [models, setModels] = useState<ModelEntry[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  // The active selection per modality: id for text, filename for image/STT.
  const [active, setActive] = useState<Record<string, string | null>>({})
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [unload, setUnload] = useState<Record<string, UnloadStatus>>({})
  const [taskRoles, reloadTaskRoles] = useTaskRoles()
  const load = useCallback(async () => {
    const cat = await api().getModelCatalog?.()
    const catalogModels: ModelEntry[] = cat?.models ?? []
    setModels(catalogModels)
    setInstalled((await api().getInstalledModels?.()) ?? [])
    const text = await api().getActiveModel?.()
    const modal = (await api().getActiveModalities?.()) ?? {}
    const nextActiveIds = new Set<string>((await api().getActiveModelIds?.()) ?? [])
    const remoteTextActive = resolveActiveTextModel(catalogModels, text, nextActiveIds).remote
    setActiveIds(nextActiveIds)
    setActive({
      text: remoteTextActive ? null : (text ?? modal.text ?? null),
      image: modal.image ?? null,
      speech: modal.speech ?? null,
      transcription: modal.transcription ?? null,
      computer_use: modal.computer_use ?? null
    })
  }, [])
  useEffect(() => {
    void load()
  }, [load])

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
    setSelectionError(null)
    clearUnloadStatus(mode) // re-selecting reloads this modality on next use
    try {
      if (mode === 'text') {
        const result = await api().activateModel?.(m.id)
        if (!result?.success) {
          throw new Error(result?.error ?? 'Model selection is unavailable. Restart the app.')
        }
        if (result.success) {
          setActive((current) => ({ ...current, text: m.remoteServerId ? null : m.id }))
          setActiveIds(new Set((await api().getActiveModelIds?.()) ?? []))
          await load()
          invalidateLlmSettings()
        }
      } else {
        const fname = primaryFile(m)
        if (m.remoteServerId) {
          const result = await api().activateModel?.(m.id)
          if (!result?.success) {
            throw new Error(result?.error ?? 'Model selection is unavailable. Restart the app.')
          }
          await load()
        } else {
          await api().setActiveModalModel?.(mode, fname)
          setActive((a) => ({ ...a, [mode]: fname }))
        }
      }
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : 'Could not select the model.')
    } finally {
      setBusy(null)
    }
  }

  // Unload one modality's model from memory now (frees RAM; reloads on next use).
  // Independent per modality — writes only this mode's status.
  const unloadModel = async (mode: PickerMode): Promise<void> => {
    const bridge = api()
    if (typeof bridge?.unloadRuntime !== 'function') {
      // Preload method missing — surface it instead of a silent no-op (there'd be no
      // IPC call and no log). Happens until the app is restarted after preload changed.
      setUnloadStatus(mode, 'error')
      console.error('[models] unloadRuntime is unavailable — restart the app')
      return
    }
    setUnloadStatus(mode, 'unloading')
    try {
      const freed = await bridge.unloadRuntime(MODE_TO_MODALITY[mode])
      console.log(
        `[models] unload ${mode} (${MODE_TO_MODALITY[mode]}):`,
        freed ? 'freed' : 'nothing loaded'
      )
      setUnloadStatus(mode, 'unloaded')
    } catch (e) {
      console.error('[models] unload failed', e)
      setUnloadStatus(mode, 'error')
    }
  }

  return (
    <SidePanel ariaLabel="Active models" onClose={onClose} className="w-[30vw] min-w-[420px]">
      <div className="flex items-center justify-between gap-4 border-b border-neutral-900 px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-white">
          <Cpu className="h-4 w-4 text-green-500" aria-hidden /> Active models
        </div>
        <div className="flex items-center gap-1">
          <IconTip label="Settings">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Settings"
              onClick={() => openSettings(onClose)}
            >
              <GearSix className="h-4 w-4" />
            </Button>
          </IconTip>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-6 py-4">
        <AnimatePresence initial={false}>
          {selectionError && (
            <motion.div
              key="selection-error"
              initial={{ opacity: 0, height: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, height: 'auto', filter: 'blur(0px)' }}
              exit={{ opacity: 0, height: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <Field invalid>
                <FieldError match role="alert">
                  {selectionError}
                </FieldError>
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Same order as the Models screen's tabs: Text, Image, Tasks, Voice, Transcription. */}
        {MODALITIES.flatMap(({ label, kinds, mode }) => {
          const list = models.filter(
            (m) => kinds.includes(m.kind) && installed.includes(m.id) && !isStagedDecisionModel(m)
          )
          const duplicateNames = new Set(
            list
              .filter((m, index) =>
                list.some((other, otherIndex) => otherIndex !== index && other.name === m.name)
              )
              .map((m) => m.name)
          )
          const cur = active[mode]
          const isActive = (m: ModelEntry): boolean =>
            mode === 'text'
              ? m.remoteServerId
                ? activeIds.has(m.id)
                : cur === m.id
              : // Media picks are saved as a file name or, from older builds, a catalog id.
                cur === primaryFile(m) ||
                cur === m.id ||
                (!!cur && canonicalModelId(cur, { catalog: models }) === m.id)
          const current = list.find(isActive) ?? null
          const optionLabel = (m: ModelEntry): string =>
            [
              m.name,
              duplicateNames.has(m.name) ? primaryVariant(m) : null,
              m.remoteServerId ? 'Remote' : null
            ]
              .filter(Boolean)
              .join(' · ')
          return (
            <ActiveModelSlot
              key={mode}
              ariaLabel={label}
              label={label}
              busy={busy !== null && list.some((m) => m.id === busy)}
              empty={`No ${label.toLowerCase()} model downloaded — get one in Models.`}
              active={
                current
                  ? {
                      name: current.name,
                      remote: !!current.remoteServerId,
                      capabilities: capabilityIcons(current),
                      detail: current.remoteServerId
                        ? null
                        : backendFor(mode === 'text' ? 'chat' : mode, [
                            current.id,
                            primaryFile(current),
                            ...(mode === 'speech' ? ['Kokoro'] : [])
                          ])
                    }
                  : null
              }
              unload={
                current && !current.remoteServerId
                  ? { status: unload[mode], onUnload: () => void unloadModel(mode) }
                  : undefined
              }
              select={{
                id: `active-model-${mode}`,
                label: `${label} model`,
                value: current?.id ?? '',
                disabled: busy !== null,
                options: list.map((m) => ({
                  value: m.id,
                  label: optionLabel(m),
                  meta: optionMeta(m)
                })),
                onValueChange: (id) => {
                  const next = list.find((m) => m.id === id)
                  if (next && next.id !== current?.id) void choose(mode, next)
                }
              }}
            />
          )
        }).flatMap((slot, index) =>
          index === 2
            ? [
                <Fragment key="tasks">
                  <TaskLineups
                    view={taskRoles}
                    models={models}
                    installed={installed}
                    onChanged={async () => {
                      await reloadTaskRoles()
                      await load()
                    }}
                    localDetail={(slot) =>
                      backendFor(
                        slot.role === 'reasoner'
                          ? 'chat'
                          : slot.role === 'decision'
                            ? 'decision'
                            : 'grounding',
                        [
                          slot.modelId,
                          ...(models.find((m) => m.id === slot.modelId)?.files ?? []).map(
                            (f) => f.name
                          )
                        ]
                      )
                    }
                  />
                </Fragment>,
                slot
              ]
            : [slot]
        )}
        <section aria-label="Embeddings">
          <Section label="Embeddings">
            <ListRow
              title="Search and RAG"
              meta={runtimeBackendLabel(backends.find((value) => value.id === 'embeddings'))}
              density="compact"
            />
          </Section>
        </section>
        <p className="text-xs leading-relaxed text-neutral-500">
          Your selected Text &amp; Vision model handles chat and supported vision work. Image,
          Voice, and Transcription use their selected models.
        </p>
      </div>
    </SidePanel>
  )
}
