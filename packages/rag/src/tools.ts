// The search_knowledge_base tool, ported from Off Grid AI Mobile. Exposed to the
// model during project chats so it can pull from the KB on demand (in addition
// to the always-on retrieval that injects context up front). The OpenAI-style
// schema works with our local llama-server tool calling and remote providers.

import type { SearchResult } from './types'

export const SEARCH_KB_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_knowledge_base',
    description:
      "Search the current project's knowledge base (uploaded documents plus captured memory) for information relevant to the user's question.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up in the knowledge base.' }
      },
      required: ['query']
    }
  }
}

/** Build a tool handler bound to a searcher. Returns a model-ready string. */
export function makeSearchKnowledgeBaseHandler(searcher: {
  searchProject(projectId: string, query: string): Promise<SearchResult>
}) {
  return async (args: { query: string }, projectId?: string): Promise<string> => {
    if (!projectId) return 'No active project. The knowledge base requires an open project.'
    const result = await searcher.searchProject(projectId, args.query)
    if (!result.chunks.length) return `No knowledge-base results found for "${args.query}".`
    return result.chunks
      .map((c, i) => `[${i + 1}] ${c.name} (part ${c.position + 1}):\n${c.content}`)
      .join('\n\n---\n\n')
  }
}
