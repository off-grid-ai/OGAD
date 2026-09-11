import { useState } from 'react'

interface ConnectorSecret {
  readonly key: string
  readonly label: string
  readonly placeholder?: string
}

interface ConnectorSecretsFormProps {
  readonly secrets: readonly ConnectorSecret[]
  /** Connect with the secrets as typed. Nothing is stored until this is called. */
  readonly onConnect: (secrets: Record<string, string>) => void
  readonly onCancel: () => void
}

/**
 * The secret fields a catalog connector asks for before it is connected.
 *
 * The typed secrets used to sit in a map on the connectors screen, so every character re-rendered
 * every connector row and the whole gallery, and the values outlived a cancelled connection. They
 * live here for as long as the form is open: the screen receives them once, on Connect, and they
 * go with the form when it closes.
 */
export function ConnectorSecretsForm({
  secrets,
  onConnect,
  onCancel
}: ConnectorSecretsFormProps): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})

  return (
    <>
      {secrets.map((s) => (
        <input
          key={s.key}
          type="password"
          value={values[s.key] ?? ''}
          onChange={(ev) => setValues((p) => ({ ...p, [s.key]: ev.target.value }))}
          placeholder={s.label + (s.placeholder ? ` (${s.placeholder})` : '')}
          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-600"
        />
      ))}
      <div className="flex gap-2">
        <button
          onClick={() => onConnect(values)}
          className="rounded-md bg-green-500 px-2.5 py-1 text-xs text-neutral-950 hover:bg-green-400"
        >
          Connect
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-400"
        >
          Cancel
        </button>
      </div>
    </>
  )
}
