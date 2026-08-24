import { useCallback, useEffect, useState } from 'react'
import { IconLoader2, IconCheck, IconCpu, IconX, IconPower } from '@tabler/icons-react'
import { SidePanel } from './SidePanel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any => (window as any).api

interface ModelFile {
  name: string
  role?: string
}
interface ModelEntry {
  id: string
  name: string
  kind: string
  files?: ModelFile[]
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
  { label: 'Voice', kinds: ['voice'], mode: 'speech' },
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

// Per-modality unload status. Absent = loaded/idle. Kept as a map keyed by mode so each
// modality is independent — unloading one must NOT reset another's state.
type UnloadStatus = 'unloading' | 'unloaded' | 'error'

function primaryFile(m: ModelEntry): string {
  return m.files?.find((f) => f.role === 'primary')?.name ?? m.files?.[0]?.name ?? m.id
}

export function ModelPicker({ onClose }: { onClose: () => void }): React.ReactElement {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  // The active selection per modality: id for text, filename for image/STT.
  const [active, setActive] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [unload, setUnload] = useState<Record<string, UnloadStatus>>({})

  const load = useCallback(async () => {
    const cat = await api().getModelCatalog?.()
    setModels(cat?.models ?? [])
    setInstalled((await api().getInstalledModels?.()) ?? [])
    const text = await api().getActiveModel?.()
    const modal = (await api().getActiveModalities?.()) ?? {}
    setActive({
      text: text ?? modal.text ?? null,
      image: modal.image ?? null,
      speech: modal.speech ?? null,
      transcription: modal.transcription ?? null
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
    clearUnloadStatus(mode) // re-selecting reloads this modality on next use
    try {
      if (mode === 'text') {
        await api().setActiveModel?.(m.id)
        setActive((a) => ({ ...a, text: m.id }))
      } else {
        const fname = primaryFile(m)
        await api().setActiveModalModel?.(mode, fname)
        setActive((a) => ({ ...a, [mode]: fname }))
      }
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
      <div className="flex items-center justify-between border-b border-neutral-900 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-white">
          <IconCpu className="h-4 w-4 text-green-500" aria-hidden /> Active models
        </div>
        <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-white">
          <IconX className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {MODALITIES.map(({ label, kinds, mode }) => {
          const list = models.filter((m) => kinds.includes(m.kind) && installed.includes(m.id))
          const cur = active[mode]
          const status = unload[mode]
          const isActive = (m: ModelEntry): boolean =>
            mode === 'text' ? cur === m.id : cur === primaryFile(m)
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
                  No {label.toLowerCase()} model downloaded — get one in Models.
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
                      <span className="truncate">{m.name}</span>
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
          Text/Vision swaps the chat model (reloads on next message). Image &amp; Transcription
          apply on the next generation/recording. All on-device.
        </p>
      </div>
    </SidePanel>
  )
}
