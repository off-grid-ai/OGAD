// Which memory-search tools a chat's memory scope exposes to the model. Mirrors the
// composer's memory selector (the user's stated model):
//   • project scope  → the project knowledge base (docs + this project's chats)
//   • all-memory     → search_memory over everything Off Grid AI has accumulated
//   • no-memory      → neither (just this chat)
// Non-memory tools (web_search, read_url, calculator, …) are never gated by scope.
// Pure + Electron-free so it unit-tests the semantics directly.

import {
  ALL_MEMORY_TOOL_ID,
  KNOWLEDGE_BASE_TOOL_ID,
  isMemoryToolAllowed as sharedMemoryToolAllowed
} from '@offgrid/models'

export const KB_TOOL_NAME = KNOWLEDGE_BASE_TOOL_ID
export const MEMORY_TOOL_NAME = ALL_MEMORY_TOOL_ID

export interface MemoryScope {
  projectActive: boolean
  allMemory: boolean
}

export function isMemoryToolAllowed(toolName: string, scope: MemoryScope): boolean {
  return sharedMemoryToolAllowed(toolName, scope)
}
