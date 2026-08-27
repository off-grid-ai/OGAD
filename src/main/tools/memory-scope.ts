// Which memory-search tools a chat's memory scope exposes to the model. Mirrors the
// composer's memory selector (the user's stated model):
//   • project scope  → the project knowledge base (docs + this project's chats)
//   • all-memory     → search_memory over everything Off Grid AI has accumulated
//   • no-memory      → neither (just this chat)
// Non-memory tools (web_search, read_url, calculator, …) are never gated by scope.
// Pure + Electron-free so it unit-tests the semantics directly.

export const KB_TOOL_NAME = 'search_knowledge_base'
export const MEMORY_TOOL_NAME = 'search_memory'

export interface MemoryScope {
  projectActive: boolean
  allMemory: boolean
}

export function isMemoryToolAllowed(toolName: string, scope: MemoryScope): boolean {
  if (toolName === KB_TOOL_NAME) {
    return scope.projectActive
  }
  if (toolName === MEMORY_TOOL_NAME) {
    return scope.allMemory
  }
  return true
}
