import { memo } from 'react'
import { Check } from '@phosphor-icons/react'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'

export const ASK_EXAMPLES = [
  'Explain how RAG works, simply',
  'Write a Python function to dedupe a list',
  'Draft a friendly out-of-office email',
  'Generate an image of a mountain cabin at dawn'
]
export const ASK_EXAMPLES_PRO = [
  'What did I work on today?',
  'Summarize my last meeting',
  'What have I spent the most time on this week?',
  'What open action items do I have?'
]
export const IMAGE_EXAMPLES = [
  'A serene mountain lake at dawn, photorealistic',
  'Minimal logo mark for a coffee brand, flat',
  'Cyberpunk city street at night, neon, rain',
  'Studio portrait of a husky, soft lighting'
]

// Visual style presets. The prompt modifier and bundled preview share this key.
export const STYLE_PRESETS: { name: string; prompt: string }[] = [
  {
    name: 'Photoreal',
    prompt: 'photorealistic, sharp focus, high detail, 50mm photo'
  },
  {
    name: 'Cinematic',
    prompt: 'cinematic film still, dramatic lighting, shallow depth of field, color graded'
  },
  {
    name: 'Anime',
    prompt: 'anime illustration, clean lineart, vibrant colors'
  },
  {
    name: 'Sketch',
    prompt: 'detailed pencil sketch on paper, monochrome line art'
  },
  {
    name: 'Watercolor',
    prompt: 'watercolor painting, soft washes, paper texture'
  },
  {
    name: 'Oil painting',
    prompt: 'oil painting, visible brushstrokes, classical, rich color'
  },
  {
    name: 'Monochrome',
    prompt: 'black and white, high contrast, monochrome'
  },
  {
    name: 'Neon',
    prompt: 'neon-lit cyberpunk, glowing lights, night, moody'
  },
  {
    name: '3D render',
    prompt: '3D render, octane, soft studio lighting, subsurface detail'
  },
  {
    name: 'Steampunk',
    prompt: 'steampunk, brass and gears, victorian, intricate'
  },
  {
    name: 'Surreal',
    prompt: 'surreal, dreamlike, imaginative composition'
  },
  {
    name: 'Vintage film',
    prompt: 'vintage film photograph, faded colors, grain, 1970s'
  },
  {
    name: 'Minimal',
    prompt: 'minimal flat design, clean, simple shapes, lots of negative space'
  },
  {
    name: 'Risograph',
    prompt: 'risograph print, halftone texture, limited palette'
  },
  {
    name: 'Fantasy art',
    prompt: 'epic fantasy concept art, dramatic, highly detailed'
  },
  {
    name: 'Studio portrait',
    prompt: 'studio portrait, soft key light, bokeh background'
  }
]

function styleKey(name: string): string {
  return name.replace(/[^\w-]+/g, '_')
}

function StylePresetPickerComponent({
  activeStyle,
  compact = false,
  styleThumbs,
  onChange
}: Readonly<{
  activeStyle: string | null
  compact?: boolean
  styleThumbs: Record<string, string>
  onChange: (style: string | null) => void
}>): React.JSX.Element {
  console.log('MemoryChat StylePresetPicker rendered')
  return (
    <div className={compact ? 'mb-2 w-full' : 'mt-4 w-full'}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-neutral-600">Style</span>
        {activeStyle ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[10px] text-neutral-600 transition-colors hover:text-neutral-300"
          >
            Clear {activeStyle}
          </button>
        ) : null}
      </div>
      <div
        className={`grid w-full grid-cols-2 gap-2.5 sm:grid-cols-4 ${compact ? 'lg:grid-cols-8' : ''}`}
      >
        {STYLE_PRESETS.map((style) => {
          const thumb = styleThumbs[styleKey(style.name)]
          const selected = activeStyle === style.name
          return (
            <button
              key={style.name}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? null : style.name)}
              className={`group relative overflow-hidden rounded-md border transition-all ${compact ? 'h-48' : 'aspect-[16/9]'} ${selected
                ? 'border-green-500 ring-1 ring-green-500'
                : 'border-neutral-800 hover:border-neutral-600'
                }`}
            >
              {thumb ? (
                <img
                  src={captureUrlForPath(thumb)}
                  alt={style.name}
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
              ) : (
                <span className="absolute inset-0 bg-neutral-900" />
              )}
              <span className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1.5 text-left text-[11px] font-medium text-white">
                {style.name}
              </span>
              {selected ? (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-neutral-950">
                  <Check className="h-3 w-3" weight="bold" />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export const StylePresetPicker = memo(StylePresetPickerComponent)
