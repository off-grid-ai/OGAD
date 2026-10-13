// Connectors grouped by the service they belong to, read from what each one already says about
// itself: the site its address is on (gmailmcp.googleapis.com and calendarmcp.googleapis.com are
// both googleapis.com), or the app scheme of an address that is not a web one
// (offgrid-microsoft://). A group is named by the word most of its connectors' names start with.
// No list of known services: a new one groups the same way. Pure.

export interface GroupableConnector {
  readonly name: string
  readonly url?: string | null
}

export interface ConnectorGroup<T extends GroupableConnector> {
  readonly key: string
  readonly label: string
  readonly connectors: readonly T[]
}

/** The site a connector belongs to: its host's last two labels, or its non-web scheme. */
export function connectorSite(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return parsed.protocol.replace(/:$/, '')
    }
    return parsed.hostname.split('.').slice(-2).join('.')
  } catch {
    return ''
  }
}

const firstWord = (name: string): string => name.trim().split(/[\s(]+/)[0] ?? ''

/** The word most of the names start with; ties keep the first seen. */
function commonLabel(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const name of names) {
    const word = firstWord(name)
    if (word) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  let best = ''
  let most = 0
  for (const [word, count] of counts) {
    if (count > most) {
      best = word
      most = count
    }
  }
  return best || names[0] || 'Other'
}

/** Connectors by service, in the order each service first appears. */
export function groupConnectors<T extends GroupableConnector>(
  connectors: readonly T[]
): ConnectorGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const connector of connectors) {
    // A connector with no address stands on its own, keyed by its name.
    const key = connectorSite(connector.url) || `name:${connector.name}`
    groups.set(key, [...(groups.get(key) ?? []), connector])
  }
  return [...groups].map(([key, members]) => ({
    key,
    // One connector keeps its own name (without the account in brackets); several share a word.
    label:
      members.length === 1
        ? members[0]!.name.replace(/\s*\([^)]*\)\s*$/, '').trim() || members[0]!.name
        : commonLabel(members.map((c) => c.name)),
    connectors: members
  }))
}
