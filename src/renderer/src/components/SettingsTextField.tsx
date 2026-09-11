import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createTextDraftStore, type TextDraftStore } from '@renderer/lib/text-draft-store'
import type { Outcome } from '@offgrid/application'

/** How long a settled draft waits before it is written, for a user who types and walks away. */
const COMMIT_DELAY_MS = 500

export type SettingsWriteOutcome = Outcome<void, { readonly message: string }>

interface SettingsTextFieldProps {
  readonly id: string
  /** Accessible name; the visible caption is the caller's own label element. */
  readonly label: string
  /** The persisted value at mount. The field owns the draft from then on. */
  readonly initialValue: string
  /**
   * The persisted value as it stands, for a field whose setting can also be changed elsewhere.
   * A change to it takes over the draft; the field is otherwise left alone to be typed in.
   */
  readonly persistedValue?: string
  readonly placeholder?: string
  /** Rows makes this a textarea; without it the field is a single-line input. */
  readonly rows?: number
  readonly className?: string
  /** Restrict what the user can type (digits only for a seed, say). */
  readonly sanitize?: (value: string) => string
  /** Write the settled value. Its failure is shown under the field, never swallowed. */
  readonly commit: (value: string) => Promise<SettingsWriteOutcome>
}

/**
 * A settings text field that keeps typing local and writes only what the user settled on.
 *
 * Every character used to be a state update in the tab, an IPC write to SQLite and a global
 * settings broadcast, which re-rendered the chat behind the panel - the input lagged behind the
 * keyboard. The draft lives in its own store so a keystroke re-renders this field alone, and the
 * value is written when the user leaves the field or stops typing.
 */
export function SettingsTextField({
  id,
  label,
  initialValue,
  persistedValue,
  placeholder,
  rows,
  className,
  sanitize,
  commit
}: SettingsTextFieldProps): React.JSX.Element {
  const [store] = useState<TextDraftStore>(() => createTextDraftStore(initialValue))
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [failure, setFailure] = useState('')
  const committed = useRef(initialValue)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const write = (next: string): void => {
    clearTimeout(timer.current)
    if (next === committed.current) return
    committed.current = next
    void commit(next).then((outcome) => {
      setFailure(outcome.ok ? '' : outcome.failure.message)
    })
  }

  // The same setting changed somewhere else - the settings panel while the composer is open -
  // replaces what this field shows. Writing to the draft store is how this field is told; it is
  // not a render-time state update.
  useEffect(() => {
    if (persistedValue === undefined || persistedValue === committed.current) return
    committed.current = persistedValue
    store.set(persistedValue)
  }, [persistedValue, store])

  // A field unmounted mid-typing (the panel closes) still saves what the user typed.
  useEffect(() => {
    return () => {
      clearTimeout(timer.current)
      const pending = store.getSnapshot()
      if (pending !== committed.current) void commit(pending)
    }
  }, [store, commit])

  const change = (raw: string): void => {
    const next = sanitize ? sanitize(raw) : raw
    store.set(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => write(next), COMMIT_DELAY_MS)
  }

  const shared = {
    id,
    'aria-label': label,
    value,
    placeholder,
    className,
    onChange: (event: { target: { value: string } }) => change(event.target.value),
    onBlur: () => write(store.getSnapshot())
  }

  return (
    <>
      {rows === undefined ? <input {...shared} /> : <textarea {...shared} rows={rows} />}
      {failure ? (
        <span role="alert" className="mt-1 block text-[10px] text-red-400">
          {failure}
        </span>
      ) : null}
    </>
  )
}
