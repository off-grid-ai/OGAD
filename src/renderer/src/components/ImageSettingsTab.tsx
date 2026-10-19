import { useEffect, useRef, useState } from 'react'
import {
  resolveImageParams,
  setOverride,
  type ImageParamOverride,
  type ImageParamStore
} from '@renderer/lib/image-params'
import { announceImageSettingsChanged } from '@renderer/lib/image-settings-events'
import { modelDisplayName } from '@offgrid/models'
import { useRuntimeBackends } from '@renderer/hooks/useRuntimeBackends'
import { SettingsSelect } from './SettingsSelect'
import { BackendPreferencesSection } from './ProcessingControls'
import { SettingsSection } from './SettingsSection'
import { SettingsRow } from './SettingsRow'
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput
} from '@offgrid/operator-ui/operator/coss/number-field'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'

type ImageSettings = {
  imageParams?: ImageParamStore
  imgSeed?: string
  imgNegative?: string
  enhanceImagePrompts?: boolean
}

// The number field hands typed input over already clamped into range, so a partial "1" on the
// way to "12" would arrive as 4 and be saved. Range-check the text that was actually typed.
const typedText = (value: number | null, details: { reason: string; event: Event }): string =>
  details.reason === 'input-change'
    ? ((details.event.target as HTMLInputElement | null)?.value ?? '')
    : String(value ?? '')

export function ImageSettingsTab(): React.JSX.Element {
  const [models, setModels] = useState<{ value: string; label: string }[]>([])
  const [model, setModel] = useState('')
  const [params, setParams] = useState<ImageParamStore>({})
  const [seed, setSeed] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [enhance, setEnhance] = useState(true)
  const settingsChangedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // On CUDA the image and chat models stay loaded together (runtime-manager), so they share
  // GPU memory. Only a running engine's confirmed backend counts; nothing here probes the GPU.
  const onCuda = useRuntimeBackends().some(
    (runtime) => runtime.state === 'loaded' && /CUDA/i.test(runtime.backend ?? '')
  )

  useEffect(
    () => () => {
      if (settingsChangedTimer.current) {
        clearTimeout(settingsChangedTimer.current)
        announceImageSettingsChanged()
      }
    },
    []
  )

  useEffect(() => {
    void Promise.all([
      window.api.imageGenStatus(),
      window.api.getSettings(),
      window.api.getModelCatalog().catch(() => ({ models: [] }))
    ])
      .then(([status, settings, catalog]) => {
        const available: string[] = status?.models ?? []
        const active = status?.active ?? available[0] ?? ''
        const saved = settings as ImageSettings
        // Main names each runtime file; the catalog resolves anything it did not name.
        const names: Record<string, string> = status?.modelNames ?? {}
        const sources = { catalog: catalog.models as { id: string; name?: string }[] }
        setModels(
          available.map((item) => ({
            value: item,
            label: names[item] ?? modelDisplayName(item, sources) ?? item
          }))
        )
        setModel(active)
        setParams(saved.imageParams ?? {})
        setSeed(saved.imgSeed ?? '')
        setNegativePrompt(saved.imgNegative ?? '')
        setEnhance(saved.enhanceImagePrompts ?? true)
      })
      .catch(() => {})
  }, [])

  const effective = resolveImageParams(model, params)

  const announceAfterTyping = (): void => {
    if (settingsChangedTimer.current) clearTimeout(settingsChangedTimer.current)
    settingsChangedTimer.current = setTimeout(() => {
      settingsChangedTimer.current = null
      announceImageSettingsChanged()
    }, 180)
  }

  const persist = (key: string, value: unknown): void => {
    void Promise.resolve(window.api.saveSetting(key, value))
      .then(announceAfterTyping)
      .catch(() => {})
  }

  const chooseModel = (nextModel: string): void => {
    setModel(nextModel)
    void Promise.resolve(window.api.setActiveModalModel('image', nextModel))
      .then(announceImageSettingsChanged)
      .catch(() => {})
  }

  const saveOverride = (key: keyof ImageParamOverride, value: number): void => {
    if (!model) return
    const next = setOverride(params, model, key, value)
    setParams(next)
    persist('imageParams', next)
  }

  // Save each complete value as it is typed. Closing Settings with Esc or an outside click
  // removes the field without a blur, so a blur-only save silently dropped the edit.
  const saveTypedOverride = (
    key: keyof ImageParamOverride,
    raw: string,
    min: number,
    max: number
  ): void => {
    const value = Number(raw)
    if (raw.trim() && Number.isFinite(value) && value >= min && value <= max)
      saveOverride(key, value)
  }

  const processing = (
    <SettingsSection
      id="image.processing"
      title="Processing"
      summary="The hardware that generates images on this device"
    >
      <BackendPreferencesSection modalities={['image']} />
    </SettingsSection>
  )

  if (!model) {
    return (
      <>
        {processing}
        <div className="border border-neutral-800 bg-neutral-900/40 p-4 text-xs text-neutral-500">
          Download and activate an image model to configure image generation.
        </div>
      </>
    )
  }

  const modelName =
    models.find((item) => item.value === model)?.label ?? modelDisplayName(model) ?? ''
  const generationSummary = `${modelName} · ${effective.size} × ${effective.size}`
  const tuningSummary = `${effective.steps} steps · guidance ${effective.cfgScale} · ${seed ? `seed ${seed}` : 'random seed'}`
  const promptsSummary = `${enhance ? 'Enhanced by the chat model' : 'Sent as written'} · ${negativePrompt.trim() ? 'negative prompt set' : 'no negative prompt'}`

  return (
    <div>
      <SettingsSection
        id="image.generation"
        title="Generation"
        summary={generationSummary}
        defaultOpen
      >
        <div className="divide-y divide-neutral-900">
          <SettingsRow
            label="Active image model"
            controlId="active-image-model"
            inline
            hint={
              onCuda
                ? 'Chat and image models stay loaded together on CUDA and share GPU memory. Generation may fail on smaller cards.'
                : undefined
            }
          >
            <SettingsSelect
              id="active-image-model"
              label="Active image model"
              value={model}
              onValueChange={chooseModel}
              options={models}
            />
          </SettingsRow>
          <SettingsRow label="Size" controlId="image-size" inline>
            <SettingsSelect
              id="image-size"
              label="Image size"
              value={String(effective.size)}
              onValueChange={(value) => saveOverride('size', Number(value))}
              options={[256, 512, 640, 768, 1024].map((size) => ({
                value: String(size),
                label: `${size} × ${size}`
              }))}
            />
          </SettingsRow>
        </div>
      </SettingsSection>

      <SettingsSection id="image.tuning" title="Fine tuning" summary={tuningSummary}>
        <div className="grid grid-cols-2 gap-3 pb-3">
          <label>
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
              Steps
            </span>
            <NumberField
              key={model}
              size="sm"
              min={4}
              max={50}
              defaultValue={effective.steps}
              onValueChange={(value, details) =>
                saveTypedOverride('steps', typedText(value, details), 4, 50)
              }
              onValueCommitted={(value) =>
                saveOverride('steps', Math.max(4, Math.min(50, value || 4)))
              }
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput aria-label="Image steps" />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          </label>
          <label>
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
              Guidance
            </span>
            <NumberField
              key={model}
              size="sm"
              min={0}
              max={20}
              step={0.5}
              defaultValue={effective.cfgScale}
              onValueChange={(value, details) =>
                saveTypedOverride('cfgScale', typedText(value, details), 0, 20)
              }
              onValueCommitted={(value) =>
                saveOverride('cfgScale', Math.max(0, Math.min(20, value || 0)))
              }
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput aria-label="Image guidance" />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
          </label>
          <label>
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
              Seed
            </span>
            <input
              aria-label="Image seed"
              value={seed}
              onChange={(event) => {
                const next = event.target.value.replace(/[^0-9]/g, '')
                setSeed(next)
              }}
              onBlur={() => persist('imgSeed', seed)}
              placeholder="random"
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 placeholder-neutral-700 outline-none focus:border-green-500"
            />
          </label>
        </div>
      </SettingsSection>

      <SettingsSection id="image.prompts" title="Prompts" summary={promptsSummary}>
        <div className="space-y-4 pb-3">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
              Negative prompt
            </span>
            <textarea
              aria-label="Negative prompt"
              value={negativePrompt}
              onChange={(event) => {
                setNegativePrompt(event.target.value)
              }}
              onBlur={() => persist('imgNegative', negativePrompt)}
              rows={3}
              className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500"
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between gap-8 py-1">
            <span className="min-w-0">
              <span className="block text-[13px] text-neutral-200">Enhance prompts</span>
              <span className="mt-1 block text-[11.5px] leading-relaxed text-neutral-500">
                Let the local chat model add useful visual detail before generation.
              </span>
            </span>
            <Switch
              aria-label="Enhance prompts"
              checked={enhance}
              onCheckedChange={(checked) => {
                setEnhance(checked)
                persist('enhanceImagePrompts', checked)
              }}
            />
          </label>
        </div>
      </SettingsSection>

      {processing}
    </div>
  )
}
