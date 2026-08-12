/** A screen ⌘K can jump to. Supplied by the shell from the sidebar it already builds. */
export interface PaletteScreen {
  label: string
  view: string
  locked?: boolean
}

/**
 * Screens whose name is not the word people reach for. Matched in addition to the label, so
 * "preferences" finds Settings and "sync" finds Devices.
 */
export const SCREEN_ALIASES: Record<string, string[]> = {
  settings: ['preferences', 'config'],
  devices: ['sync', 'mesh', 'phone', 'pairing'],
  models: ['download', 'gguf', 'llm'],
  connectors: ['integrations', 'mcp', 'tools'],
  'memory-chat': ['chat', 'ask'],
  memories: ['memory', 'notes'],
  replay: ['timeline', 'movie', 'history'],
  day: ['today', 'timeline'],
  reflect: ['reflection', 'mind share'],
  entities: ['people', 'contacts'],
  actions: ['todos', 'tasks'],
  gateway: ['server', 'api', 'proxy'],
  vault: ['passwords', 'secrets'],
  meetings: ['calls', 'zoom'],
  projects: ['folders'],
  search: ['find'],
  clipboard: ['copy', 'paste'],
  voice: ['speech', 'dictation'],
  notifications: ['alerts', 'inbox']
}

/** Does this screen answer to what the user typed - by its own name, or by what they call it. */
export function matchesScreen(screen: PaletteScreen, needle: string): boolean {
  const typed = needle.trim().toLowerCase()
  if (!typed) return true
  if (screen.label.toLowerCase().includes(typed)) return true
  return (SCREEN_ALIASES[screen.view] ?? []).some((alias) => alias.includes(typed))
}

/** The screens to show for a query: everything when nothing is typed, best few once it is. */
export function paletteScreenMatches(
  screens: readonly PaletteScreen[],
  needle: string,
  limit = 6
): PaletteScreen[] {
  if (!needle.trim()) return [...screens]
  return screens.filter((screen) => matchesScreen(screen, needle)).slice(0, limit)
}
