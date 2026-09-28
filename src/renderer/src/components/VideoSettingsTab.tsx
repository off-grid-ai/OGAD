import { VIDEO_DEFAULTS } from '@offgrid/models'
import { useEffect, useState } from 'react'
import { SettingsSelect } from './SettingsSelect'

type VideoValues = {
  width: number
  height: number
  frames: number
  fps: number
  steps: number
  guidance: number
}
const DEFAULT: VideoValues = VIDEO_DEFAULTS
type VideoSettings = {
  videoParams?: Record<string, Partial<VideoValues>>
  videoSeed?: string | number
  videoNegative?: string
  enhanceVideoPrompts?: boolean
}

const notify = (): void => { window.dispatchEvent(new Event('og:video-settings-changed')) }

export function VideoSettingsTab(): React.JSX.Element {
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [allParams, setAllParams] = useState<Record<string, Partial<VideoValues>>>({})
  const [seed, setSeed] = useState('')
  const [negative, setNegative] = useState('')
  const [enhance, setEnhance] = useState(false)

  useEffect(() => {
    void Promise.all([window.api.videoGenStatus(), window.api.getSettings()])
      .then(([status, raw]) => {
        const settings = raw as VideoSettings
        setModels(status.models)
        setModel(status.active ?? status.models[0] ?? '')
        setAllParams(settings.videoParams ?? {})
        setSeed(settings.videoSeed === -1 ? '' : String(settings.videoSeed ?? ''))
        setNegative(settings.videoNegative ?? '')
        setEnhance(settings.enhanceVideoPrompts ?? false)
      })
      .catch(() => {})
  }, [])

  const values = { ...DEFAULT, ...(allParams[model] ?? {}) }
  const persist = (key: string, value: unknown): void => {
    void Promise.resolve(window.api.saveSetting(key, value)).then(notify)
  }
  const chooseModel = (value: string): void => {
    setModel(value)
    void Promise.resolve(window.api.setActiveModalModel('video', value)).then(notify)
  }
  const setValue = (key: keyof VideoValues, value: number): void => {
    if (!model) return
    const next = { ...allParams, [model]: { ...allParams[model], [key]: value } }
    setAllParams(next)
    persist('videoParams', next)
  }

  if (!model) return <p className="border border-neutral-800 bg-neutral-900/40 p-4 text-xs text-neutral-500">Download a complete video model pack in Models to set video options.</p>

  return (
    <div className="space-y-4 text-xs text-neutral-300">
      <div>
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
          Active video model
        </span>
        <SettingsSelect
          id="active-video-model"
          label="Active video model"
          value={model}
          onValueChange={chooseModel}
          options={models.map((name) => ({
            value: name,
            label: name.replace(/\.(gguf|safetensors)$/i, '')
          }))}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Size
          </span>
          <SettingsSelect
            id="video-size"
            label="Video size"
            value={`${values.width}x${values.height}`}
            onValueChange={(value) => {
              const [width, height] = value.split('x').map(Number)
              if (width && height) {
                const next = { ...allParams, [model]: { ...values, width, height } }
                setAllParams(next)
                persist('videoParams', next)
              }
            }}
            options={[
              { value: '320x192', label: '320 × 192' },
              { value: '512x288', label: '512 × 288' },
              { value: '832x480', label: '832 × 480' }
            ]}
          />
        </div>
        <div>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Frames
          </span>
          <SettingsSelect
            id="video-frames"
            label="Video frames"
            value={String(values.frames)}
            onValueChange={(value) => setValue('frames', Number(value))}
            options={[17, 33, 49, 81].map((frames) => ({
              value: String(frames),
              label: `${frames} frames`
            }))}
          />
        </div>
        <div>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Playback speed
          </span>
          <SettingsSelect
            id="video-fps"
            label="Video frames per second"
            value={String(values.fps)}
            onValueChange={(value) => setValue('fps', Number(value))}
            options={[8, 16].map((fps) => ({ value: String(fps), label: `${fps} fps` }))}
          />
        </div>
        <label>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Steps
          </span>
          <input
            aria-label="Video steps"
            type="number"
            min={4}
            max={50}
            value={values.steps}
            onChange={(event) =>
              setValue('steps', Math.max(4, Math.min(50, Number(event.target.value) || 4)))
            }
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Guidance
          </span>
          <input
            aria-label="Video guidance"
            type="number"
            min={0}
            max={20}
            step={0.5}
            value={values.guidance}
            onChange={(event) =>
              setValue('guidance', Math.max(0, Math.min(20, Number(event.target.value) || 0)))
            }
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
            Seed
          </span>
          <input
            aria-label="Video seed"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
            onBlur={() => persist('videoSeed', seed)}
            placeholder="Random"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-neutral-400">
          Negative prompt
        </span>
        <textarea
          aria-label="Video negative prompt"
          value={negative}
          onChange={(event) => setNegative(event.target.value)}
          onBlur={() => persist('videoNegative', negative)}
          rows={2}
          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200"
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enhance}
          onChange={(event) => {
            setEnhance(event.target.checked)
            persist('enhanceVideoPrompts', event.target.checked)
          }}
        />
        Enhance short video prompts
      </label>
      <p className="text-[11px] text-neutral-500">
        Clip length: {(values.frames / values.fps).toFixed(1)} seconds. Video has no audio. Longer
        and larger clips need more memory and time.
      </p>
    </div>
  )
}
