import { budgetTools, MAX_TOOL_TOKENS } from './tool-budget'
import { mergeStickyTools, previousOfferedTools, rememberOfferedTools } from './sticky-tool-set'

/**
 * How long a chat turn waits for MiniLM to download before offering every tool. A fresh install
 * has to fetch the model (~23MB) first, and offline it may never arrive; the turn must not stall.
 * The load keeps going in the background, so later turns route semantically.
 */
export const SEMANTIC_ROUTING_WAIT_MS = 2_000
/** When MiniLM is already on disk the wait is only its load (a few seconds on a cold start). */
export const LOCAL_ROUTING_MODEL_WAIT_MS = 20_000

// The routing model embeddings-core loads (Xenova/all-MiniLM-L6-v2, fp32 or quantized).
async function routingModelOnDisk(): Promise<boolean> {
  const { resolveTransformersPackage } = await import('../model-paths')
  const id = 'Xenova/all-MiniLM-L6-v2'
  return Boolean(
    resolveTransformersPackage(id, 'model.onnx') ??
    resolveTransformersPackage(id, 'model_quantized.onnx')
  )
}

const ROUTING_MODEL_LOADING = Symbol('routing model loading')

/** The semantic ranking, or ROUTING_MODEL_LOADING when MiniLM is still loading after the wait. */
function withinRoutingWait<T>(
  work: Promise<T>,
  waitMs: number
): Promise<T | typeof ROUTING_MODEL_LOADING> {
  // A late result or failure is dropped; the turn has already been routed.
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const loading = new Promise<typeof ROUTING_MODEL_LOADING>((resolve) => {
    timer = setTimeout(() => resolve(ROUTING_MODEL_LOADING), waitMs)
  })
  return Promise.race([work, loading]).finally(() => clearTimeout(timer))
}

export async function selectChatToolSchemas(
  query: string | undefined,
  rawTools: unknown[],
  assistantRequiredTools: unknown[],
  options: {
    contextSize: number
    conversationId?: string
    projectId?: string
    allMemory?: boolean
    imageAvailable?: boolean
    history?: { role: string; content: string }[]
    /** The embedding model boundary; defaults to the app's local MiniLM. */
    embed?: (text: string) => Promise<number[]>
    semanticWaitMs?: number
  }
): Promise<{ tools: unknown[]; protectedToolCount: number; droppedCount: number }> {
  if (query === undefined) {
    return { tools: rawTools, protectedToolCount: assistantRequiredTools.length, droppedCount: 0 }
  }
  const imageAvailable = options.imageAvailable ?? false
  const history = options.history ?? []
  // Keep the tool payload within the model's context. llama-server inlines every
  // tool schema into the prompt AND compiles it to a grammar, so a big connector
  // set can blow past the context window and 400 the whole turn. Budget to a
  // fraction of the effective context (leaving room for system + history +
  // answer); prune verbose schemas first, drop connector tools only if needed.
  // Route every enabled built-in and connector through local MiniLM. The older
  // path ranked connectors only, and only when there were at least two of them;
  // all built-ins were sent on every turn. Selection now runs for any non-empty
  // catalog and sends only the tools pertinent to this message. If MiniLM cannot
  // load, the lexical fallback fails closed to direct matches.
  let relevantTools: unknown[] = []
  if (rawTools.length > 0) {
    const { selectRelevantTools } = await import('./tool-ranking')
    const lexicalTools = selectRelevantTools(query, rawTools)
    const namedTool = rawTools.some((schema) => {
      const name = (schema as { function?: { name?: unknown } }).function?.name
      return typeof name === 'string' && query.toLowerCase().includes(name.toLowerCase())
    })
    // An explicit tool name needs no semantic ranking. If image generation is unavailable,
    // an explicit generate_image request cannot be routed to that missing tool.
    const unavailableImageTool = !imageAvailable && /\bgenerate_image\b/i.test(query)
    if (!namedTool && !unavailableImageTool) {
      try {
        let embed = options.embed
        if (!embed) {
          const { embeddings } = await import('../embeddings')
          embed = (t: string): Promise<number[]> => embeddings.generateEmbedding(t)
        }
        const { contextualToolRoutingText, selectRelevantToolsSemantic } =
          await import('./tool-embedding-ranking')
        const routingText = contextualToolRoutingText(query, history)
        const ranked = await withinRoutingWait(
          selectRelevantToolsSemantic(routingText, rawTools, { embed }),
          options.semanticWaitMs ??
            ((await routingModelOnDisk()) ? LOCAL_ROUTING_MODEL_WAIT_MS : SEMANTIC_ROUTING_WAIT_MS)
        )
        // While MiniLM is still loading (a fresh install downloads it first), offer every tool as
        // 0.0.55-beta.114 did; the budget below still trims the set to fit the context. Words
        // alone would hide tools a request needs ("remind me" never names reminders_create).
        relevantTools = ranked === ROUTING_MODEL_LOADING ? rawTools : ranked
      } catch {
        // The direct-match selection below remains available offline, and while MiniLM loads.
      }
    }
    // A semantic score must not hide a direct name or description match. This
    // also keeps explicit tool requests available when a new embedding model
    // ranks an unrelated schema first.
    relevantTools = [
      ...lexicalTools,
      ...relevantTools.filter((tool) => !lexicalTools.includes(tool))
    ]
  }
  const scopeToolName = options.projectId
    ? 'search_knowledge_base'
    : options.allMemory
      ? 'search_memory'
      : null
  const explicitlyNamedTools = rawTools.filter((schema) => {
    const name = (schema as { function?: { name?: unknown } }).function?.name
    return (
      typeof name === 'string' &&
      (name === scopeToolName || query.toLowerCase().includes(name.toLowerCase()))
    )
  })
  if (explicitlyNamedTools.length) {
    const explicitNames = new Set(explicitlyNamedTools)
    relevantTools = [
      ...explicitlyNamedTools,
      ...relevantTools.filter((schema) => !explicitNames.has(schema))
    ]
  }
  // Acting is offered whenever the assistant may act, and the model decides from the prompt
  // (answer questions; act when asked to do something on a website or in an app). Routing by the
  // words of the message must not hide it: "can you check this site?" shares no words with it.
  if (assistantRequiredTools.length) {
    const acting = new Set(assistantRequiredTools)
    relevantTools = [...assistantRequiredTools, ...relevantTools.filter((t) => !acting.has(t))]
  }
  if (!/\bbrave\b/i.test(query)) {
    const hasPrimarySearch = relevantTools.some(
      (schema) => (schema as { function?: { name?: unknown } }).function?.name === 'web_search'
    )
    if (hasPrimarySearch) {
      relevantTools = relevantTools.filter(
        (schema) => (schema as { function?: { name?: unknown } }).function?.name !== 'brave_search'
      )
    }
  }
  const protectedToolCount =
    explicitlyNamedTools.length +
    assistantRequiredTools.filter((t) => !explicitlyNamedTools.includes(t)).length
  const ctx = options.contextSize
  // Cap tool tokens in ABSOLUTE terms too, not just as a fraction of context:
  // llama-server re-processes the entire tool prompt every tool round (gemma-4's
  // sliding-window attention defeats the prompt cache), so on CPU-only inference a
  // large tool payload dominates latency. ~4k keeps a useful connector set while
  // roughly halving per-round prompt cost vs the old 45%-of-a-big-context budget.
  const toolBudget = Math.max(1024, Math.min(Math.floor(ctx * 0.4), MAX_TOOL_TOKENS))
  // Tools sit in the system message, ahead of the history: keep earlier turns' tools in place
  // so the server reuses its prompt cache. Start fresh only when the kept set no longer fits.
  const stickyTools = mergeStickyTools(
    previousOfferedTools(options.conversationId),
    relevantTools,
    rawTools
  )
  const stickyFits =
    budgetTools(stickyTools, toolBudget, stickyTools.length).estTokens <= toolBudget
  if (stickyFits) relevantTools = stickyTools
  const budgeted = budgetTools(
    relevantTools,
    toolBudget,
    stickyFits ? relevantTools.length : protectedToolCount
  )
  rememberOfferedTools(options.conversationId, budgeted.tools)
  if (budgeted.pruned || budgeted.droppedCount) {
    console.warn(
      `[tools] context budget ${toolBudget} tok: pruned schemas${budgeted.droppedCount ? `, dropped ${budgeted.droppedCount} connector tool(s)` : ''} to fit (final ~${budgeted.estTokens} tok)`
    )
  }
  return { tools: budgeted.tools, protectedToolCount, droppedCount: budgeted.droppedCount }
}
