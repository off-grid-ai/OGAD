import { useEffect, useRef, useState } from 'react'

const FOCUS_DELAY_MS = 80

interface NewProjectNameFieldProps {
  readonly onCreate: (name: string) => void
  readonly onCancel: () => void
}

export function NewProjectNameField({
  onCreate,
  onCancel
}: NewProjectNameFieldProps): React.JSX.Element {
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="mb-2">
      <input
        ref={input}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            finished.current = true
            onCreate(name)
          }
          if (event.key === 'Escape') {
            finished.current = true
            onCancel()
          }
        }}
        onBlur={() => {
          if (finished.current) return
          finished.current = true
          onCreate(name)
        }}
        placeholder="New project name…  (Enter to create, Esc to cancel)"
        className="w-full rounded-md border border-green-500 bg-neutral-900 px-3 py-2 text-xs text-white placeholder-neutral-600 outline-none"
      />
    </div>
  )
}
