import { useState } from 'react'
import {
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
  snapImageDimension
} from '../../../shared/image-dimensions'

/** Width × height inputs for a custom image size. Each value is saved as soon as a complete,
 *  in-range number is typed (closing Settings with Esc removes the field without a blur), and
 *  snapped to 64 and clamped on blur or Enter. */
export function ImageDimensionFields({
  width,
  height,
  onChange
}: {
  width: number
  height: number
  onChange: (width: number, height: number) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 text-neutral-500">
      <DimensionInput label="Image width" value={width} onCommit={(w) => onChange(w, height)} />
      <span aria-hidden="true">×</span>
      <DimensionInput label="Image height" value={height} onCommit={(h) => onChange(width, h)} />
    </div>
  )
}

function DimensionInput({
  label,
  value,
  onCommit
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}): React.JSX.Element {
  // The typed text while editing; otherwise the field shows the saved value, so a preset or
  // another model updates it without rewriting what is being typed.
  const [draft, setDraft] = useState<string | null>(null)

  const finish = (): void => {
    const typed = Number(draft)
    if (draft?.trim() && Number.isFinite(typed)) {
      const snapped = snapImageDimension(typed)
      if (snapped !== value) onCommit(snapped)
    }
    setDraft(null)
  }

  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChange={(e) => {
        const text = e.target.value.replace(/[^0-9]/g, '')
        setDraft(text)
        const typed = Number(text)
        if (text && typed >= MIN_IMAGE_DIMENSION && typed <= MAX_IMAGE_DIMENSION)
          onCommit(snapImageDimension(typed))
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="w-14 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-center text-neutral-300 outline-none focus:border-green-500"
    />
  )
}
