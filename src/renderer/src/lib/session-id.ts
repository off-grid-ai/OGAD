// Single source for parsing a chat session id into its display parts. A session
// id is "<model>-<dash-separated-title>"; the first dash splits the model from the
// title. ChatDetail and ChatList each parsed this inline, identically — extracted
// here so the two views can't drift on how a title/model label is derived.

import { modelDisplayName } from '@offgrid/models'

export interface ParsedSessionId {
  /** The model segment before the first dash, if any. */
  modelName?: string
  /** Title with dashes turned to spaces, lowercased. */
  chatTitle: string
  /** Title capitalized for display; falls back to the raw id when empty. */
  readableTitle: string
  /** The model's name from the shared resolver, or 'LLM' when there's no model. */
  llmLabel: string
}

export function parseSessionId(sessionId: string): ParsedSessionId {
  const firstDashIndex = sessionId.indexOf('-')
  const modelName = firstDashIndex > 0 ? sessionId.slice(0, firstDashIndex) : undefined
  const chatTitleRaw = firstDashIndex > 0 ? sessionId.slice(firstDashIndex + 1) : sessionId
  const chatTitle = chatTitleRaw.split('-').join(' ').toLowerCase()
  const readableTitle = chatTitle
    ? `${chatTitle.charAt(0).toUpperCase()}${chatTitle.slice(1)}`
    : sessionId
  const llmLabel = modelDisplayName(modelName) ?? 'LLM'
  return { modelName, chatTitle, readableTitle, llmLabel }
}
