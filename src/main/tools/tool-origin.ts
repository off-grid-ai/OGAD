import { findNativeToolSpec } from './nativeActionToolExtension-logic'

/** What the origin rule reads from a tool extension (tools.ts ToolExtension). */
interface OriginExtension {
  category?: 'tool' | 'connector'
  isReadOnlyTool?(name: string): boolean
}

/** Builtins whose implementations only retrieve data or compute a result. */
const READ_ONLY_BUILTINS: ReadonlySet<string> = new Set([
  'offgrid_guide',
  'calculator',
  'read_screen',
  'search_memory',
  'search_knowledge_base',
  'get_datetime'
])

/** Set by the trusted request boundary, independently of browser tab metadata. */
export type ToolOrigin = 'desktop' | 'bridge'

export const PAIRED_BROWSER_COMPUTER_USE_REFUSAL =
  'This request belongs to a paired browser tab. Use web_use for this task; it retains that tab and its login.'

export const PAIRED_BROWSER_AGENT_MODE_REFUSAL =
  'This tool can change data. Switch to Agent mode in the browser panel to use it.'

export function toolOriginRefusal(name: string): string {
  if (name === 'computer_use') {
    return PAIRED_BROWSER_COMPUTER_USE_REFUSAL
  }
  return findNativeToolSpec(name) ? 'Error: tool_unavailable' : PAIRED_BROWSER_AGENT_MODE_REFUSAL
}

export function toolOriginOf(context?: {
  origin?: ToolOrigin
  acting?: boolean
  startTab?: unknown
}): { origin?: ToolOrigin; acting?: boolean } {
  if (context?.origin === 'bridge') return { origin: 'bridge', acting: context.acting }
  // A startTab comes only from a paired browser agent task; preserve any explicit acting mode.
  if (context?.startTab != null) return { origin: 'bridge', acting: context.acting ?? true }
  return { origin: context?.origin, acting: context?.acting }
}

/** Bridge chat may read tools; only an explicit acting request may change an app or page. */
export function isToolAllowedForOrigin(
  name: unknown,
  origin?: ToolOrigin,
  options: { acting?: boolean; extension?: OriginExtension } = {}
): boolean {
  if (origin !== 'bridge') {
    return true
  }
  // Page text can turn outbound fetch URLs into a channel for private data.
  if (['computer_use', 'web_search', 'brave_search', 'read_url'].includes(String(name))) {
    return false
  }
  const spec = typeof name === 'string' ? findNativeToolSpec(name) : undefined
  if (spec) {
    return spec.risk === 'read' || options.acting === true
  }
  if (options.acting === true) {
    return true
  }
  if (typeof name !== 'string') return false
  if (READ_ONLY_BUILTINS.has(name)) return true
  return options.extension?.isReadOnlyTool?.(name) === true
}
