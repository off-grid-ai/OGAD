// Agentic tool-calling loop for the Off Grid AI chat. Kept ISOLATED from the
// default rag:chat path (opt-in) so a tool run can never break normal chat.
//
// The local model (llama-server, OpenAI-compatible /v1/chat/completions) is given
// tool schemas; we parse its tool_calls, run them on-device, feed results back,
// and loop until it answers. Built-in tools only (no network) for now — web
// search + MCP connectors plug in here later.

import { llm } from './llm'
import { SEARCH_KB_TOOL, makeSearchKnowledgeBaseHandler } from '@offgrid/rag'
import { isMemoryToolAllowed } from './tools/memory-scope'
import { getSetting, saveSetting } from './database'
import { readImages } from './llm/read-images'
import {
  DeferredImageRequestCollector,
  boundedToolHistory,
  buildAgentToolMessages,
  budgetToolSchemas,
  decodeSearchRedirect as decodeDdgHref,
  evaluateArithmetic,
  executePortableTool,
  htmlToReadableText as htmlToText,
  catalogEntryToDefinition,
  findToolCatalogEntry,
  parseToolArguments,
  prepareToolCallWithQueryFallback,
  rankToolSchemas,
  rankToolSchemasByEmbedding,
  stripHtmlTags as stripTags,
  nativeToolPlannerUnavailableMessage,
  toolSchemaTokenBudget,
  ToolEmbeddingCache
} from '@offgrid/models'

const toolEmbeddingCache = new ToolEmbeddingCache()

const sharedToolDefinition = (
  name: string
): ReturnType<typeof catalogEntryToDefinition> =>
  catalogEntryToDefinition(findToolCatalogEntry(name)!)
const webSearchTool = sharedToolDefinition('web_search')
const readUrlTool = sharedToolDefinition('read_url')
const calculatorTool = sharedToolDefinition('calculator')
const dateTimeTool = sharedToolDefinition('get_current_datetime')
import type { SearchKind, SearchResult } from '../shared/search-contract'
import { selectToolExtensions } from './tools/extension-select'
import {
  PROPOSAL_DECK_TOOL,
  PROPOSAL_DECK_TOOL_NAME,
  runProposalDeckTool,
  type ProposalDeferredImageRequest
} from './proposal-deck/tool'
import { proposalDeckSystemHint, proposalDeckService } from './proposal-deck/service'
import { callHookAsync, HOOKS } from './bootstrap/hookRegistry'
import { DEFAULT_MAX_TOOL_CALLS } from '../shared/llm-defaults'
import { generateDesktopMessages } from './desktop-generation'
import type { GenerationToolCall } from '@offgrid/models'
import { remoteNativeToolCapability } from './llm/remote-chat'
import { currentRemoteScreenTaskSession } from './actions/remote-screen-session'
import { getActiveRemoteVisionServer } from './vision/remote-vision-server'

// Per-tool enable/disable, persisted as a list of disabled tool names.
function disabledSet(): Set<string> {
  try {
    return new Set(getSetting<string[]>('disabledTools', []))
  } catch {
    return new Set()
  }
}
export function setToolEnabled(name: string, enabled: boolean): void {
  const set = disabledSet()
  if (enabled) set.delete(name)
  else set.add(name)
  saveSetting('disabledTools', Array.from(set))
}

// Per-turn context a tool may need beyond its args. Injected by the loop so a tool
// owns its full behavior instead of the loop special-casing it (e.g. search_memory
// excludes the current conversation so it can't cite itself).
export interface ToolContext {
  conversationId?: string
  /** Authenticated Mobile launch identity. Only the MCP admission boundary sets it. */
  taskLaunch?: { launchId: string; requestingDeviceId: string }
  /** The exact user message. Approval-gated tools use this instead of trusting model-made args. */
  userQuery?: string
  /** Bounded prior user/assistant turns. Intake tools combine these facts with
   *  the current query instead of treating a follow-up as a new task. */
  history?: ToolConversationTurn[]
  onActivity?: (activity: ToolActivity) => void
  /** The active project (if the chat is in one), so search_knowledge_base can query
   *  that project's uploaded docs + captured memory. */
  projectId?: string
}

export interface ToolConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export type ToolCallStatus = 'completed' | 'failed' | 'pending'

export type ToolActivity = { kind: 'planning'; label: 'Planning next action…' }

// A tool's structured result. Most tools just return text (a bare string, which the
// loop normalizes to { text }); a tool may ALSO emit side channels — `sources`
// (interactive citations, from search_memory) and `imageRequest` (the deferred
// image prompt, from generate_image) — so the loop dispatches every tool uniformly
// and no longer branches on the tool's name.
export interface ToolResult {
  text: string
  /** Structured execution state. `pending` means the tool needs user input. */
  status?: ToolCallStatus
  /** When true, `text` is the final user-facing answer and no model may rewrite it. */
  authoritative?: boolean
  sources?: UnifiedSource[]
  imageRequest?: { prompt: string }
  imageRequests?: ProposalDeferredImageRequest[]
}

type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (
    args: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<string | ToolResult> | string | ToolResult
}

/** The one retrieval path used by memory and Replay chat tools. A caller may
 *  narrow the source kind, but search, ranking, thumbnails, and citation shape
 *  stay owned by universalSearch. */
export async function searchMemoryToolResult(
  query: string,
  options: {
    limit?: number
    kinds?: SearchKind[]
    collapseScreenMoments?: boolean
    excludeChatId?: string
    emptyText?: string
    errorSubject?: string
  } = {}
): Promise<ToolResult> {
  try {
    const { universalSearch } = await import('./search')
    const limit = Math.min(20, Math.max(1, Number(options.limit) || 8))
    const hits = await universalSearch(query, {
      limit,
      semantic: true,
      kinds: options.kinds,
      collapseScreenMoments: options.collapseScreenMoments,
      excludeChatId: options.excludeChatId
    })
    const sources: UnifiedSource[] = hits.map((hit) => ({ ...hit }))
    const text = hits.length
      ? hits
          .map((hit) => {
            const when = hit.ts
              ? ` · ${new Date(hit.ts).toISOString().slice(0, 16).replace('T', ' ')}`
              : ''
            return `(${hit.surface || hit.kind}${when}) ${hit.title ? `${hit.title} — ` : ''}${hit.snippet}`
          })
          .join('\n')
      : (options.emptyText ?? 'Nothing found in memory for that.')
    return { text, sources }
  } catch (error) {
    return {
      text: `Error searching ${options.errorSubject ?? 'memory'}: ${(error as Error).message}`
    }
  }
}

// --- HTML helpers for the web tools live in ./tools-parsers (pure, unit-tested).
// Fetch a URL and return its readable text (shared by the read_url tool and the
// deterministic "read this URL, then build" flow). Works for localhost too.
export async function readUrlText(url: string): Promise<string> {
  let u = url.trim()
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return htmlToText(await res.text())
}

// --- Built-in tools --------------------------------------------------------
const TOOLS: ToolDef[] = [
  {
    name: webSearchTool.name,
    description: webSearchTool.description ?? '',
    parameters: webSearchTool.inputSchema,
    run: async (a) => {
      const q = String(a.query ?? '').trim()
      if (!q) return 'Error: empty query.'
      try {
        const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        })
        const html = await res.text()
        const titles: { title: string; url: string }[] = []
        const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && titles.length < 6)
          titles.push({ url: decodeDdgHref(m[1]!), title: stripTags(m[2]!) })
        const snippets: string[] = []
        const sre = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
        let s: RegExpExecArray | null
        while ((s = sre.exec(html)) && snippets.length < 6) snippets.push(stripTags(s[1]!))
        if (!titles.length) return 'No results found.'
        return titles
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${snippets[i] || ''}`)
          .join('\n')
      } catch (e) {
        return 'Error: search failed — ' + (e as Error).message
      }
    }
  },
  {
    name: 'brave_search',
    description:
      'Search the web via Brave and return the top results (title, URL). An alternative to web_search. Requires network.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'the search query' } },
      required: ['query']
    },
    run: async (a) => {
      const q = String(a.query ?? '').trim()
      if (!q) return 'Error: empty query.'
      try {
        const res = await fetch(
          'https://search.brave.com/search?q=' + encodeURIComponent(q) + '&source=web',
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          }
        )
        const html = await res.text()
        const out: { title: string; url: string }[] = []
        const seen = new Set<string>()
        const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) && out.length < 6) {
          const url = m[1]!
          if (/brave\.com|search\.brave|\/settings|javascript:/i.test(url)) continue
          const title = stripTags(m[2]!)
          if (!title || title.length < 3 || seen.has(url)) continue
          seen.add(url)
          out.push({ title, url })
        }
        if (!out.length) return 'No results found (Brave markup may have changed — try web_search).'
        return out.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n')
      } catch (e) {
        return 'Error: brave search failed — ' + (e as Error).message
      }
    }
  },
  {
    name: readUrlTool.name,
    description: readUrlTool.description ?? '',
    parameters: readUrlTool.inputSchema,
    run: async (a) => {
      let url = String(a.url ?? '').trim()
      if (!url) return 'Error: empty url.'
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        if (!res.ok) return `Error: HTTP ${res.status}`
        const text = htmlToText(await res.text())
        return text ? text.slice(0, 6000) : 'No readable text on the page.'
      } catch (e) {
        return 'Error: could not fetch — ' + (e as Error).message
      }
    }
  },
  {
    name: calculatorTool.name,
    description: calculatorTool.description ?? '',
    parameters: calculatorTool.inputSchema,
    run: (a) => {
      const expr = String(a.expression ?? '')
      try {
        return String(evaluateArithmetic(expr))
      } catch {
        return 'Error: only basic arithmetic is allowed.'
      }
    }
  },
  {
    name: 'read_screen',
    description:
      "Read what's recently been on the user's screen (the latest captured activity). Fully local, no network. Use to answer questions about what the user was just looking at.",
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'how many recent items (default 5)' } }
    },
    run: async (a) => {
      try {
        const { getDB } = await import('./database')
        const db = getDB()
        const n = Math.min(20, Math.max(1, Number(a.limit) || 5))
        const rows = db
          .prepare(
            `SELECT summary, surface, surface_app, ts FROM observations
           WHERE COALESCE(surface_app,'') NOT LIKE '%Off Grid AI%' AND COALESCE(surface_app,'') NOT LIKE '%Electron%'
           ORDER BY ts DESC LIMIT ?`
          )
          .all(n) as {
          summary: string
          surface: string | null
          surface_app: string | null
          ts: string
        }[]
        if (!rows.length) return 'No recent screen activity captured.'
        return rows
          .map((r) => `(${r.surface || r.surface_app || 'screen'} · ${r.ts}) ${r.summary}`)
          .join('\n')
      } catch (e) {
        return 'Error reading screen: ' + (e as Error).message
      }
    }
  },
  {
    name: 'search_memory',
    description:
      "Search the user's ENTIRE memory — past chats, screen captures, meetings, people, notes, and connected apps (Slack, Gmail, etc.) — for anything relevant. Use this for ANY question about what was said, discussed, or decided, about a PERSON, or to recall past activity (e.g. 'what were Praveen and I talking about', 'my notes on the Q3 launch'). Prefer this over read_screen unless the user explicitly asks what's on screen RIGHT NOW. Fully local.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'what to look for, in natural language (e.g. a person + topic)'
        },
        limit: { type: 'number', description: 'max results (default 8)' }
      },
      required: ['query']
    },
    // Owns BOTH the model's text result AND the structured hits surfaced as
    // interactive citations. Excludes the current conversation (ctx) so it can't
    // cite itself. The loop dedups the returned sources across rounds.
    run: (args, context) =>
      searchMemoryToolResult(String(args.query ?? ''), {
        limit: Number(args.limit) || 8,
        excludeChatId: context.conversationId
      })
  },
  {
    // Only OFFERED in a project chat (gated in schemas() by projectId). Lets the model
    // pull from the current project's uploaded docs + captured memory on demand — the
    // general search_memory doesn't reach a project's separate RAG store.
    name: SEARCH_KB_TOOL.function.name,
    description: SEARCH_KB_TOOL.function.description,
    parameters: SEARCH_KB_TOOL.function.parameters,
    run: async (a, ctx): Promise<ToolResult> => {
      if (!ctx.projectId) {
        return { text: 'No active project — the knowledge base needs an open project.' }
      }
      try {
        const { ragService } = await import('./rag')
        const handler = makeSearchKnowledgeBaseHandler(ragService)
        return { text: await handler({ query: String(a.query ?? '') }, ctx.projectId) }
      } catch (e) {
        return { text: 'Error searching the knowledge base: ' + (e as Error).message }
      }
    }
  },
  {
    name: 'get_datetime',
    description: dateTimeTool.description ?? '',
    parameters: dateTimeTool.inputSchema,
    run: () => executePortableTool('get_datetime', {}) ?? new Date().toString()
  },
  {
    // generate_image is DEFERRED: run() never generates. It records the requested
    // prompt as an image request so the renderer
    // generates AFTER the turn — generating inline would evict the LLM from unified
    // memory mid-loop and risk a nested modality-queue deadlock.
    name: 'generate_image',
    description:
      'Generate an image on-device from a text prompt. Use when the user asks for a picture/photo/logo/art to be created.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'a detailed description of the image to create' }
      },
      required: ['prompt']
    },
    run: (a): ToolResult => {
      const prompt = String(a.prompt ?? '').trim()
      return prompt
        ? {
            text: 'Image generation started - it will appear in the chat.',
            imageRequest: { prompt }
          }
        : { text: 'Error: no image prompt provided.' }
    }
  },
  {
    name: PROPOSAL_DECK_TOOL.name,
    description: PROPOSAL_DECK_TOOL.description,
    parameters: PROPOSAL_DECK_TOOL.parameters,
    run: (args, context) =>
      runProposalDeckTool(args, {
        conversationId: context.conversationId,
        userMessage: context.userQuery
      })
  }
]

// generate_image is gated on an image model being available and is never offered
// otherwise; every other built-in obeys only the disabled-set.
function schemas(
  imageAvailable: boolean,
  scope: { projectActive: boolean; allMemory: boolean; proposalDeck: boolean }
): unknown[] {
  const off = disabledSet()
  return (
    TOOLS.filter((t) => !off.has(t.name))
      .filter((t) => t.name !== 'generate_image' || imageAvailable)
      .filter((t) => t.name !== PROPOSAL_DECK_TOOL_NAME || scope.proposalDeck)
      // Memory tools (search_knowledge_base / search_memory) follow the chat's memory scope.
      .filter((t) => isMemoryToolAllowed(t.name, scope))
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
  )
}

/** Normalize a tool's return (bare string or structured) to a ToolResult. */
function asToolResult(r: string | ToolResult): ToolResult {
  return typeof r === 'string' ? { text: r } : r
}

/** Dispatch a tool call UNIFORMLY: a registered extension that owns the name wins,
 *  else the matching built-in. Any throw becomes an error-text result (a single
 *  tool failing never aborts the turn). No name-based special-casing — each tool
 *  owns its own text + side channels (sources / imageRequest) via its ToolResult. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  exts: ToolExtension[]
): Promise<ToolResult> {
  try {
    const ext = exts.find((e) => e.canHandle(name))
    if (ext) return asToolResult(await ext.execute(name, args, ctx))
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return { text: `Error: unknown tool ${name}`, status: 'failed', authoritative: true }
    return asToolResult(await tool.run(args, ctx))
  } catch (e) {
    return {
      text: `Error: ${(e as Error).message}`,
      status: 'failed',
      authoritative: true
    }
  }
}

// --- Tool extensions (open-core seam) --------------------------------------
// Pro features (e.g. MCP connectors) plug extra tools into the chat loop without
// core ever importing them. A pro extension registers itself during activation;
// in the free build nothing is registered and toolChat uses only the built-ins.
// Mirrors mobile/src/services/tools/extensions.ts.
export interface ToolExtension {
  id: string
  /** What kind of capability this is. 'tool' = the assistant's own on-device
   *  abilities (native actions) - included in every agentic turn. 'connector'
   *  = external service accounts (MCP) - included only when the user turns
   *  Connectors on. Defaults to 'connector' (fail closed for anything that
   *  might touch an external service). */
  category?: 'tool' | 'connector'
  /** On-device tools shown beside core built-ins in Tools settings. Connector
   *  schemas have their own settings surface and omit this. */
  settings?: readonly { name: string; description: string }[]
  /** OpenAI tool schemas to add when extensions are enabled. Built once per turn;
   *  the extension may cache any per-turn state it needs for execute(). */
  schemas(): Promise<unknown[]> | unknown[]
  /** Whether this extension owns a given tool name. */
  canHandle(name: string): boolean
  /** Execute a call this extension owns. Structured results can also carry citations. */
  execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolContext
  ): Promise<string | ToolResult> | string | ToolResult
  /** Optional system-prompt addition when this extension contributes tools. */
  systemHint?(): string
}

const toolExtensions: ToolExtension[] = []
export function registerToolExtension(ext: ToolExtension): void {
  if (!toolExtensions.some((e) => e.id === ext.id)) toolExtensions.push(ext)
}
export function unregisterToolExtension(id: string, expected?: ToolExtension): void {
  const index = toolExtensions.findIndex(
    (extension) => extension.id === id && (!expected || extension === expected)
  )
  if (index >= 0) toolExtensions.splice(index, 1)
}
export function getToolExtensions(): ToolExtension[] {
  return toolExtensions
}

export type ToolCall = {
  name: string
  args: Record<string, unknown>
  result: string
  status: ToolCallStatus
}
// Structured sources surfaced by search_memory so the chat can render them as
// interactive citation cards (thumbnail + open-in-Replay), same as the RAG path.
export type UnifiedSource = SearchResult

/**
 * Run a chat turn with tool-calling. STREAMS by default (thinking -> tool-call activity
 * -> answer) through the callbacks: `onDelta` gets reasoning/content deltas, `onStep`
 * fires as each tool is about to run so the UI can show "Running web_search...". Omit the
 * callbacks (e.g. the pro skills-engine caller) and it just buffers - the final answer is
 * always the return value either way. Returns the final answer + the calls made.
 */
export async function toolChat(
  query: string,
  history: { role: string; content: string }[] = [],
  opts: {
    connectors?: boolean
    conversationId?: string
    /** Active project — offers search_knowledge_base + scopes it to this project. */
    projectId?: string
    /** Chat is in "All memory" scope — offers search_memory over everything. */
    allMemory?: boolean
    images?: string[]
    imageAvailable?: boolean
    thinking?: boolean
    signal?: AbortSignal
    onDelta?: (text: string, kind: 'content' | 'reasoning') => void
    onStep?: (call: { name: string; args: Record<string, unknown> }) => void
    onToolResult?: (call: { name: string; result: string; status: ToolCallStatus }) => void
    onActivity?: (activity: ToolActivity) => void
    /** The orchestrator's plan for this turn, emitted once before its steps run. */
    onPlan?: (steps: { tool: string; why: string }[]) => void
  } = {}
): Promise<{
  answer: string
  toolCalls: ToolCall[]
  unified: UnifiedSource[]
  imageRequests: (ProposalDeferredImageRequest | { prompt: string })[]
  /** Compatibility alias for older renderer bundles that can generate only one image. */
  imageRequest?: { prompt: string }
}> {
  if (opts.conversationId) {
    const decision = await callHookAsync<{ answer: string } | null>(
      HOOKS.actionsResolveChatDecision,
      { conversationId: opts.conversationId, message: query }
    )
    if (decision) {
      return {
        answer: decision.answer,
        toolCalls: [],
        unified: [],
        imageRequests: []
      }
    }
  }
  const screenTask = currentRemoteScreenTaskSession()
  const remoteTextModel = screenTask ? screenTask.activeServer : getActiveRemoteVisionServer()
  const remoteToolCapability = remoteTextModel
    ? await remoteNativeToolCapability(remoteTextModel)
    : null
  const plannerUnavailable =
    remoteToolCapability?.status === 'unsupported'
      ? nativeToolPlannerUnavailableMessage(remoteToolCapability)
      : undefined
  if (plannerUnavailable) {
    return {
      answer: plannerUnavailable,
      toolCalls: [],
      unified: [],
      imageRequests: []
    }
  }
  await llm.init() // respects pause; ensures the server is up
  const onDelta = opts.onDelta ?? ((): void => {})
  const toolContext: ToolContext = {
    conversationId: opts.conversationId,
    projectId: opts.projectId,
    userQuery: query,
    history: boundedToolHistory(history),
    onActivity: opts.onActivity
  }

  // Offer generate_image only when an image model is available. The renderer passes
  // this; fall back to the main-process check so a caller that omits it still gates
  // correctly (single source of truth for "can we make an image right now").
  let imageAvailable = opts.imageAvailable ?? false
  if (opts.imageAvailable === undefined) {
    try {
      const { activeImageModel } = await import('./imagegen')
      imageAvailable = !!activeImageModel()
    } catch {
      /* no image runtime -> stay false */
    }
  }

  // Opt-in: pull in tools from registered pro extensions (e.g. MCP connectors)
  // alongside the built-ins. Schemas are built once per turn; each extension
  // caches whatever per-turn state it needs for execute(). Free build registers
  // no extensions, so this is just the built-ins.
  const exts = selectToolExtensions(getToolExtensions(), { connectors: !!opts.connectors })
  const extSchemas: unknown[] = []
  const hints: string[] = []
  const disabled = disabledSet()
  for (const e of exts) {
    try {
      const s = await e.schemas()
      const enabledSchemas = s.filter((schema) => {
        const name = (schema as { function?: { name?: unknown } }).function?.name
        return typeof name !== 'string' || !disabled.has(name)
      })
      if (enabledSchemas.length) {
        extSchemas.push(...enabledSchemas)
        if (e.systemHint) hints.push(e.systemHint())
      }
    } catch (err) {
      console.error('[tools] extension schemas', e.id, err)
    }
  }
  const proposalDeckActive =
    /# Skill:\s*proposal-deck\b|\/proposal-deck\b/i.test(query) ||
    (!!opts.conversationId && !!proposalDeckService().get(opts.conversationId))
  const builtins = schemas(imageAvailable, {
    projectActive: !!opts.projectId,
    allMemory: !!opts.allMemory,
    proposalDeck: proposalDeckActive
  })
  const rawTools = extSchemas.length ? [...builtins, ...extSchemas] : builtins
  // Keep the tool payload within the model's context. llama-server inlines every
  // tool schema into the prompt AND compiles it to a grammar, so a big connector
  // set can blow past the context window and 400 the whole turn. Budget to a
  // fraction of the effective context (leaving room for system + history +
  // answer); prune verbose schemas first, drop connector tools only if needed.
  // Smart routing: rank connector tools by relevance to this turn's message BEFORE
  // budgeting, so the budgeter (which drops from the end) keeps the tools that
  // actually match the request rather than whichever were last. Built-ins keep
  // their position. Prefer SEMANTIC ranking (embedding similarity — matches on
  // meaning, e.g. "meetings" → a calendar tool); fall back to lexical term-overlap
  // if the embeddings backend isn't ready. No-op with 0-1 connector tools.
  let rankedTools = rawTools
  if (rawTools.length - builtins.length > 1) {
    try {
      const { embeddings } = await import('./embeddings')
      rankedTools = await rankToolSchemasByEmbedding(query, rawTools, builtins.length, {
        embed: (t) => embeddings.generateEmbedding(t)
      }, toolEmbeddingCache)
    } catch {
      rankedTools = rankToolSchemas(query, rawTools, builtins.length)
    }
  }
  const toolBudget = toolSchemaTokenBudget(llm.effectiveContextSize())
  const budgeted = budgetToolSchemas(rankedTools, toolBudget, builtins.length)
  if (budgeted.pruned || budgeted.droppedCount) {
    console.warn(
      `[tools] context budget ${toolBudget} tok: pruned schemas${budgeted.droppedCount ? `, dropped ${budgeted.droppedCount} connector tool(s)` : ''} to fit (final ~${budgeted.estimatedTokens} tok)`
    )
    if (budgeted.droppedCount)
      hints.push(
        `Note: ${budgeted.droppedCount} connector tool(s) were omitted this turn to fit the context window; ask the user to disable some connectors if a needed tool is missing.`
      )
  }
  const tools = budgeted.tools
  if (proposalDeckActive) hints.push(proposalDeckSystemHint(opts.conversationId))

  // Attached images ride on the current user turn so the vision model can read
  // them even in tools/connectors mode (otherwise they were silently dropped).
  // Gate on the ACTIVE model's real vision capability — main is the single source
  // of truth (the renderer's flag is fetched once per mount and can be stale). A
  // text-only model given image_url parts either ignores them (silent wrong answer)
  // or errors, so drop the attachments when there's no vision projector.
  const decodedImages = opts.images?.length && llm.hasVision() ? readImages(opts.images) : []
  const messages = buildAgentToolMessages({
    query,
    history,
    systemHints: hints,
    imageParts: decodedImages.map((image) => ({
      type: 'image' as const,
      mimeType: image.mime,
      data: image.base64
    }))
  })
  const toolCalls: ToolCall[] = []
  const unified: UnifiedSource[] = []
  const unifiedKeys = new Set<string>()
  // Deferred image generation: keep EVERY request in tool-call order. The renderer generates after
  // the turn so we never evict the LLM mid-loop, and one model round that asks for two pictures does
  // not silently replace the first request with the last.
  const imageRequests = new DeferredImageRequestCollector<
    ProposalDeferredImageRequest | { prompt: string }
  >()

  const maxToolRounds = llm.getSettings().maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
  let streamedContent = ''
  const turnId = `desktop-tools:${Date.now()}:${Math.random().toString(36).slice(2)}`
  try {
    const result = await generateDesktopMessages(messages, {
      operation: { type: 'text' },
      tools,
      toolChoice: 'auto',
      temperature: 0.3,
      thinking: opts.thinking,
      signal: opts.signal,
      maxToolRounds,
      maxToolCalls: maxToolRounds,
      identity: {
        conversationId: opts.conversationId ?? turnId,
        turnId,
        projectId: opts.projectId
      },
      events: {
        chunk: (chunk) => {
          if (chunk.reasoning) onDelta(chunk.reasoning, 'reasoning')
          if (chunk.content) {
            streamedContent += chunk.content
            onDelta(chunk.content, 'content')
          }
        }
      },
      toolExecution: {
        prepare: (call) => prepareToolCallWithQueryFallback(call, query),
        execute: async (call: GenerationToolCall) => {
          if (opts.signal?.aborted) throw opts.signal.reason
          const args = parseToolArguments(call.arguments)
          opts.onStep?.({ name: call.name, args })
          const res = await runTool(call.name, args, toolContext, exts)
          for (const source of res.sources ?? []) {
            if (unifiedKeys.has(source.key)) continue
            unifiedKeys.add(source.key)
            unified.push(source)
          }
          imageRequests.add(res)
          const status = res.status ?? 'completed'
          toolCalls.push({ name: call.name, args, result: res.text, status })
          opts.onToolResult?.({ name: call.name, result: res.text, status })
          if (res.authoritative) onDelta(res.text, 'content')
          return {
            content: res.text,
            isError: status === 'failed',
            terminal: res.authoritative,
            metadata: {
              status,
              sources: res.sources,
              imageRequest: res.imageRequest,
              imageRequests: res.imageRequests
            }
          }
        }
      }
    })
    return imageRequests.project({ answer: result.content.trim(), toolCalls, unified })
  } catch (error) {
    if (opts.signal?.aborted) {
      return imageRequests.project({ answer: streamedContent.trim(), toolCalls, unified })
    }
    throw error
  }
}

/** Names + descriptions + enabled state of all tools (for the settings UI). */
export function listTools(): { name: string; description: string; enabled: boolean }[] {
  const off = disabledSet()
  const builtins = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    enabled: !off.has(tool.name)
  }))
  const extensions = toolExtensions.flatMap((extension) =>
    (extension.settings ?? []).map((tool) => ({ ...tool, enabled: !off.has(tool.name) }))
  )
  return [...builtins, ...extensions]
}
