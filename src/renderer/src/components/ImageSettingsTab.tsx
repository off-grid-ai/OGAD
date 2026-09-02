import { useEffect, useState } from 'react'
import {
  resolveImageParams,
  setOverride,
  type ImageParamOverride,
  type ImageParamStore
} from '@renderer/lib/image-params'
import { announceImageSettingsChanged } from '@renderer/lib/image-settings-events'
import { SettingsSelect } from './SettingsSelect'
import { desktopModelControl } from '@renderer/lib/model-control-application'

type ImageSettings = {
  imageParams?: ImageParamStore
  imgSeed?: string
  imgNegative?: string
  enhanceImagePrompts?: boolean
}

const modelLabel = (model: string): string => model.replace(/\.gguf$/i, '').replace(/-Q\d.*$/i, '')

export function ImageSettingsTab(): React.JSX.Element {
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [params, setParams] = useState<ImageParamStore>({})
  const [seed, setSeed] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [enhance, setEnhance] = useState(true)

  useEffect(() => {
    void Promise.all([window.api.imageGenStatus(), window.api.getSettings()])
      .then(([status, settings]) => {
        const available = status?.models ?? []
        const active = status?.active ?? available[0] ?? ''
        const saved = settings as ImageSettings
        setModels(available)
        setModel(active)
        setParams(saved.imageParams ?? {})
        setSeed(saved.imgSeed ?? '')
        setNegativePrompt(saved.imgNegative ?? '')
        setEnhance(saved.enhanceImagePrompts ?? true)
      })
      .catch(() => {})
  }, [])

  const effective = resolveImageParams(model, params)

  const persist = (key: string, value: unknown): void => {
    void Promise.resolve(window.api.saveSetting(key, value))
      .then(announceImageSettingsChanged)
      .catch(() => {})
  }

  const chooseModel = (nextModel: string): void => {
    const previous = model
    setModel(nextModel)
    void desktopModelControl
      .execute({ type: 'select', surface: 'image', modelId: nextModel })
      .then((result) => {
        if (result.status === 'completed') announceImageSettingsChanged()
        else setModel(previous)
      })
      .catch(() => setModel(previous))
  }

  const saveOverride = (key: keyof ImageParamOverride, value: number): void => {
    if (!model) return
    const next = setOverride(params, model, key, value)
    setParams(next)
    persist('imageParams', next)
  }

  if (!model) {
    return (
      <div className="border border-neutral-800 bg-neutral-900/40 p-4 text-xs text-neutral-500">
        Download and activate an image model to configure image generation.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
          Active image model
        </span>
        <SettingsSelect
          id="active-image-model"
          label="Active image model"
          value={model}
          onValueChange={chooseModel}
          options={models.map((item) => ({ value: item, label: modelLabel(item) }))}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Size
          </span>
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
        </div>
        <label>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Steps
          </span>
          <input
            aria-label="Image steps"
            type="number"
            min={4}
            max={50}
            value={effective.steps}
            onChange={(event) =>
              saveOverride('steps', Math.max(4, Math.min(50, Number(event.target.value) || 4)))
            }
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Guidance
          </span>
          <input
            aria-label="Image guidance"
            type="number"
            min={0}
            max={20}
            step={0.5}
            value={effective.cfgScale}
            onChange={(event) =>
              saveOverride('cfgScale', Math.max(0, Math.min(20, Number(event.target.value) || 0)))
            }
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500"
          />
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
              persist('imgSeed', next)
            }}
            placeholder="random"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 placeholder-neutral-700 outline-none focus:border-green-500"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
          Negative prompt
        </span>
        <textarea
          aria-label="Negative prompt"
          value={negativePrompt}
          onChange={(event) => {
            setNegativePrompt(event.target.value)
            persist('imgNegative', event.target.value)
          }}
          rows={3}
          className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500"
        />
      </label>

      <label className="flex items-start gap-2 border border-neutral-800 bg-neutral-900/40 p-3">
        <input
          type="checkbox"
          checked={enhance}
          onChange={(event) => {
            setEnhance(event.target.checked)
            persist('enhanceImagePrompts', event.target.checked)
          }}
          className="mt-0.5 accent-green-500"
        />
        <span>
          <span className="block text-xs text-neutral-200">Enhance prompts</span>
          <span className="mt-0.5 block text-[10px] text-neutral-600">
            Let the local chat model add useful visual detail before generation.
          </span>
        </span>
      </label>
    </div>
  )
}
