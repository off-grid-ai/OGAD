import { Check } from '@phosphor-icons/react'
import { captureUrlForPath } from '../../../shared/ogcapture-url'
import { IMAGE_STYLE_PRESETS } from './image-style-presets'

const styleKey = (name: string): string => name.replace(/[^\w-]+/g, '_')

export function StylePresetPicker({
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
        {IMAGE_STYLE_PRESETS.map((style) => {
          const thumb = styleThumbs[styleKey(style.name)]
          const selected = activeStyle === style.name
          return (
            <button
              key={style.name}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? null : style.name)}
              className={`group relative overflow-hidden rounded-md border transition-all ${compact ? 'h-48' : 'aspect-[16/9]'} ${
                selected
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
