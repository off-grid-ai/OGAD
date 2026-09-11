import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createTextDraftStore, type TextDraftStore } from '@renderer/lib/text-draft-store'
import type { SettingsWriteOutcome } from './SettingsTextField'

interface SettingsNumberFieldProps {
  readonly id: string
  /** Accessible name; the visible caption is the caller's own label element. */
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step?: number
  /** The persisted value. The field owns what is typed until it commits. */
  readonly value: number
  readonly className?: string
  /** Write the settled value. Its failure is shown under the field, never swallowed. */
  readonly commit: (value: number) => Promise<SettingsWriteOutcome>
}

/** What the field will accept: inside the range, and never NaN from a half-typed number. */
function clamp(raw: string, bounds: { min: number; max: number; fallback: number }): number {
  const parsed = Number(raw)
  if (raw.trim() === '' || Number.isNaN(parsed)) return bounds.fallback
  return Math.max(bounds.min, Math.min(bounds.max, parsed))
}

/**
 * A settings number field that keeps typing local and writes once.
 *
 * Typing "1024" into a size or step field used to be four writes to SQLite and four global
 * settings changes, each one clamped mid-number - so "10" became the minimum before the user had
 * finished. The typed text lives in its own draft store, so a keystroke re-renders this field
 * alone, and the number is clamped and written when the user leaves the field or presses Enter.
 */
export function SettingsNumberField({
  id,
  label,
  min,
  max,
  step,
  value,
  className,
  commit
}: SettingsNumberFieldProps): React.JSX.Element {
  const [store] = useState<TextDraftStore>(() => createTextDraftStore(String(value)))
  const text = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [failure, setFailure] = useState('')
  const committed = useRef(value)
  const request = useRef(0)

  const write = (): void => {
    const next = clamp(store.getSnapshot(), { min, max, fallback: committed.current })
    // What is shown always ends up being a value the field would accept.
    store.set(String(next))
    if (next === committed.current) return
    committed.current = next
    const token = ++request.current
    void commit(next).then((outcome) => {
      // A newer edit has already been written; this result is stale.
      if (token !== request.current) return
      setFailure(outcome.ok ? '' : outcome.failure.message)
    })
  }

  // A field left mid-edit (the panel closes) still saves the number the user typed.
  const writeRef = useRef(write)
  useEffect(() => {
    writeRef.current = write
  })
  useEffect(() => {
    return () => writeRef.current()
  }, [])

  return (
    <>
      <input
        id={id}
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(event) => store.set(event.target.value)}
        onBlur={write}
        onKeyDown={(event) => {
          if (event.key === 'Enter') write()
        }}
        className={className}
      />
      {failure ? (
        <span role="alert" className="mt-1 block text-[10px] text-red-400">
          {failure}
        </span>
      ) : null}
    </>
  )
}
