import { useState } from 'react'

interface ConnectorPullQueryFieldProps {
  /** The connector being asked, for the field's prompt. */
  readonly connectorName: string
  readonly disabled: boolean
  /** Pull with the query the user typed. */
  readonly onPull: (query: string) => void
}

/**
 * The "ask this connector for…" field on a connector's detail view.
 *
 * The query lived in a map on the connectors screen, so each character re-rendered every connector
 * row and the whole catalog gallery behind the panel. It lives here, and the screen is handed the
 * query once, when the user pulls.
 */
export function ConnectorPullQueryField({
  connectorName,
  disabled,
  onPull
}: ConnectorPullQueryFieldProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const pullable = query.trim().length > 0

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && pullable) onPull(query)
        }}
        placeholder={`Ask ${connectorName} for… (e.g. ABSLI)`}
        className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-600"
      />
      <button
        onClick={() => onPull(query)}
        disabled={disabled || !pullable}
        className="shrink-0 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-green-500 hover:text-green-500 disabled:opacity-40"
      >
        Pull
      </button>
    </>
  )
}
