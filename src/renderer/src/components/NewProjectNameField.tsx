import { useEffect, useRef, useState } from 'react'

/**
 * Focus lands AFTER the dropdown returns focus to its trigger. Without the delay, Radix's
 * focus-return blurs the input immediately and its blur handler tears the field down before the
 * user can type.
 */
const FOCUS_DELAY_MS = 80

interface NewProjectNameFieldProps {
  /** Create the project with this name. Called on Enter and on blur, as it always has been. */
  readonly onCreate: (name: string) => void
  readonly onCancel: () => void
}

/**
 * The inline "new project" name field in the composer.
 *
 * The name lived in the chat screen, so naming a project re-rendered the transcript on every
 * character. It lives here now: the screen is handed the finished name once, when the user
 * commits it.
 */
export function NewProjectNameField({
  onCreate,
  onCancel
}: NewProjectNameFieldProps): React.JSX.Element {
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="mb-2">
      <input
        ref={input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCreate(name)
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => onCreate(name)}
        placeholder="New project name…  (Enter to create, Esc to cancel)"
        className="w-full rounded-md border border-green-500 bg-neutral-900 px-3 py-2 text-xs text-white placeholder-neutral-600 outline-none"
      />
    </div>
  )
}
