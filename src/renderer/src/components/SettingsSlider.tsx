import { useEffect, useRef, useState } from 'react'
import { SettingsRow } from './SettingsRow'
import type { SettingsWriteOutcome } from './SettingsTextField'

interface SettingsSliderProps {
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly min: number
  readonly max: number
  readonly step: number
  /** The persisted value. The slider shows its own value only while a move is uncommitted. */
  readonly value: number
  /** How the number reads next to the label ("auto" for a zero thread count, say). */
  readonly format?: (value: number) => string
  /** Write the value the user settled on. Its failure is shown under the slider. */
  readonly commit: (value: number) => Promise<SettingsWriteOutcome>
}

/**
 * A settings slider that keeps dragging local and writes once.
 *
 * These sliders drive launch-time engine arguments, and each one used to persist on every input
 * event: a single drag across the GPU-layer range asked the engine to restart dozens of times,
 * with the model stopping and re-loading behind the panel. The dragged value now lives here, in a
 * leaf, so moving the handle re-renders this row alone, and the value is written once - when the
 * handle is released, the control is left, or the keyboard adjustment ends.
 *
 * A failed write keeps the dragged value on screen and states the error; a settled write hands the
 * display back to the persisted value, so a reset to defaults or an applied preset shows through.
 * A result that a newer move has already superseded is discarded rather than reported.
 */
export function SettingsSlider({
  id,
  label,
  hint,
  min,
  max,
  step,
  value,
  format,
  commit
}: SettingsSliderProps): React.JSX.Element {
  // Null means "nothing uncommitted": the persisted value is what the user sees.
  const [draft, setDraft] = useState<number | null>(null)
  const [failure, setFailure] = useState('')
  const dragging = useRef(false)
  const uncommitted = useRef<number | null>(null)
  const request = useRef(0)
  const shown = draft ?? value

  const write = (next: number): void => {
    dragging.current = false
    uncommitted.current = null
    if (next === value) {
      setDraft(null)
      return
    }
    const token = ++request.current
    void commit(next).then((outcome) => {
      // A newer move has already been written; this result says nothing about what is on screen.
      if (token !== request.current) return
      setFailure(outcome.ok ? '' : outcome.failure.message)
      // A failed write keeps the value the user chose in front of them to retry or change.
      if (outcome.ok) setDraft(null)
    })
  }

  // A drag released off the handle - the pointer left the track first - still commits, so a move
  // can never be left on screen while the engine keeps the argument it replaced.
  useEffect(() => {
    const end = (): void => {
      if (!dragging.current) return
      write(uncommitted.current ?? value)
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  })

  return (
    <SettingsRow label={label} hint={hint} controlId={id} value={(format ?? String)(shown)}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const next = Number(e.target.value)
          dragging.current = true
          uncommitted.current = next
          setDraft(next)
        }}
        onKeyUp={() => write(shown)}
        onBlur={() => write(shown)}
        className="w-full accent-green-500"
      />
      {failure ? (
        <span role="alert" className="mt-1 block text-[10px] text-red-400">
          {failure}
        </span>
      ) : null}
    </SettingsRow>
  )
}
