import { useCallback, useEffect, useState } from 'react'
import {
  resolveImageParams,
  setOverride,
  type ImageParamOverride,
  type ImageParamStore
} from '@renderer/lib/image-params'
import {
  publishActiveImageModelChanged,
  publishImageSettings,
  type ImageSettingKey,
  type ImageSettingsProjection
} from '@renderer/lib/image-settings-store'
import { SettingsNumberField } from './SettingsNumberField'
import { SettingsSelect } from './SettingsSelect'
import { SettingsTextField, type SettingsWriteOutcome } from './SettingsTextField'
import { desktopModelControl } from '@renderer/composition/model-control'
import { failed, modelFileDisplayName, ok } from '@offgrid/application'

type ImageSettings = ImageSettingsProjection

const modelLabel = modelFileDisplayName

export function ImageSettingsTab(): React.JSX.Element {
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [params, setParams] = useState<ImageParamStore>({})
  const [seed, setSeed] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [enhance, setEnhance] = useState(true)
  const [saveFailure, setSaveFailure] = useState('')

  useEffect(() => {
    void Promise.all([window.api.imageGenStatus(), window.api.getSettings()])
      .then(([status, settings]) => {
        const available = status?.models ?? []
        const active = status?.defaultModel ?? ''
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

  // One write path for this tab: save, then tell the rest of the app what changed. A failed
  // write is returned as a typed failure so the field or the tab can show it, never dropped.
  const save = useCallback(
    async <K extends ImageSettingKey>(
      key: K,
      value: NonNullable<ImageSettingsProjection[K]>
    ): Promise<SettingsWriteOutcome> => {
      try {
        await window.api.saveSetting(key, value)
        publishImageSettings({ [key]: value } as ImageSettingsProjection)
        return ok(undefined)
      } catch {
        return failed({ message: 'This setting could not be saved.' })
      }
    },
    []
  )

  const persist = <K extends ImageSettingKey>(
    key: K,
    value: NonNullable<ImageSettingsProjection[K]>
  ): void => {
    void save(key, value).then((outcome) => {
      setSaveFailure(outcome.ok ? '' : outcome.failure.message)
    })
  }

  const commitSeed = useCallback((value: string) => save('imgSeed', value), [save])
  const commitNegativePrompt = useCallback((value: string) => save('imgNegative', value), [save])

  const chooseModel = (nextModel: string): void => {
    const previous = model
    setModel(nextModel)
    void desktopModelControl
      .execute({ type: 'select', surface: 'image', modelId: nextModel })
      .then((result) => {
        if (result.status === 'completed') publishActiveImageModelChanged()
        else setModel(previous)
      })
      .catch(() => setModel(previous))
  }

  const writeOverride = useCallback(
    async (key: keyof ImageParamOverride, value: number): Promise<SettingsWriteOutcome> => {
      if (!model) return ok(undefined)
      const next = setOverride(params, model, key, value)
      setParams(next)
      return save('imageParams', next)
    },
    [model, params, save]
  )

  const saveOverride = (key: keyof ImageParamOverride, value: number): void => {
    void writeOverride(key, value).then((outcome) => {
      setSaveFailure(outcome.ok ? '' : outcome.failure.message)
    })
  }

  const commitSteps = useCallback((value: number) => writeOverride('steps', value), [writeOverride])
  const commitGuidance = useCallback(
    (value: number) => writeOverride('cfgScale', value),
    [writeOverride]
  )

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
          <SettingsNumberField
            key={`${model}-steps`}
            id="image-steps"
            label="Image steps"
            min={4}
            max={50}
            value={effective.steps}
            commit={commitSteps}
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Guidance
          </span>
          <SettingsNumberField
            key={`${model}-guidance`}
            id="image-guidance"
            label="Image guidance"
            min={0}
            max={20}
            step={0.5}
            value={effective.cfgScale}
            commit={commitGuidance}
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Seed
          </span>
          <SettingsTextField
            id="image-seed"
            label="Image seed"
            initialValue={seed}
            sanitize={(value) => value.replace(/[^0-9]/g, '')}
            commit={commitSeed}
            placeholder="random"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 placeholder-neutral-700 outline-none focus:border-green-500"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
          Negative prompt
        </span>
        <SettingsTextField
          id="image-negative-prompt"
          label="Negative prompt"
          initialValue={negativePrompt}
          commit={commitNegativePrompt}
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

      {saveFailure ? (
        <p role="alert" className="text-[10px] text-red-400">
          {saveFailure}
        </p>
      ) : null}
    </div>
  )
}
