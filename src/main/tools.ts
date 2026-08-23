// Agentic tool-calling loop for the Off Grid chat. Kept ISOLATED from the
// default rag:chat path (opt-in) so a tool run can never break normal chat.
//
// The local model (llama-server, OpenAI-compatible /v1/chat/completions) is given
// tool schemas; we parse its tool_calls, run them on-device, feed results back,
// and loop until it answers. Built-in tools only (no network) for now — web
// search + MCP connectors plug in here later.

import { llm } from './llm'
import { SEARCH_KB_TOOL, makeSearchKnowledgeBaseHandler } from '@offgrid/rag'
import { isMemoryToolAllowed } from './tools/memory-scope'
import { parseToolCallsFromText } from './tools/tool-call-parse'
import { getSetting, saveSetting } from './database'
import { buildContentParts } from './llm/chat-payload'
import { readImages } from './llm/read-images'
import { stripTags, htmlToText, decodeDdgHref } from './tools-parsers'
import { evaluateArithmetic } from './calculator'
import { selectToolExtensions } from './tools/extension-select'
import { planTask } from './tools/planner'
import { makePlanExecutor } from './tools/plan-executor'
import { shouldPlan, backfillGoals, preferNativeApp } from './tools/planner-logic'
import { resolveNativeApp } from './accessibility/ax-host'

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
interface ToolContext {
  conversationId?: string
  /** The active project (if the chat is in one), so search_knowledge_base can query
   *  that project's uploaded docs + captured memory. */
  projectId?: string
}

// A tool's structured result. Most tools just return text (a bare string, which the
// loop normalizes to { text }); a tool may ALSO emit side channels — `sources`
// (interactive citations, from search_memory) and `imageRequest` (the deferred
// image prompt, from generate_image) — so the loop dispatches every tool uniformly
// and no longer branches on the tool's name.
interface ToolResult {
  text: string
  sources?: UnifiedSource[]
  imageRequest?: { prompt: string }
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
    name: 'web_search',
    description:
      "Search the web via DuckDuckGo and return the top results (title, URL, snippet). Use for current events or facts not in the user's memory. Requires network.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'the search query' } },
      required: ['query']
    },
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
    name: 'read_url',
    description:
      'Fetch a web page and return its readable text. Use to read a specific URL (e.g. one from web_search). Requires network.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'the page URL' } },
      required: ['url']
    },
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
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression and return the numeric result.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "(3+4)*2/7"' } },
      required: ['expression']
    },
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
           WHERE COALESCE(surface_app,'') NOT LIKE '%Off Grid%' AND COALESCE(surface_app,'') NOT LIKE '%Electron%'
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
    run: async (a, ctx): Promise<ToolResult> => {
      try {
        const { universalSearch } = await import('./search')
        const n = Math.min(20, Math.max(1, Number(a.limit) || 8))
        const hits = await universalSearch(String(a.query ?? ''), {
          limit: n,
          semantic: true,
          excludeChatId: ctx.conversationId
        })
        const sources: UnifiedSource[] = hits.map((h) => ({
          key: h.key,
          kind: h.kind,
          refId: h.refId,
          title: h.title,
          snippet: h.snippet,
          surface: h.surface,
          ts: h.ts,
          imagePath: h.imagePath
        }))
        const text = hits.length
          ? hits
              .map((h) => {
                const when = h.ts
                  ? ' · ' + new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ')
                  : ''
                return `(${h.surface || h.kind}${when}) ${h.title ? h.title + ' — ' : ''}${h.snippet}`
              })
              .join('\n')
          : 'Nothing found in memory for that.'
        return { text, sources }
      } catch (e) {
        return { text: 'Error searching memory: ' + (e as Error).message }
      }
    }
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
    description: 'Get the current local date and time.',
    parameters: { type: 'object', properties: {} },
    run: () => new Date().toString()
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
  }
]

// generate_image is gated on an image model being available and is never offered
// otherwise; every other built-in obeys only the disabled-set.
function schemas(
  imageAvailable: boolean,
  scope: { projectActive: boolean; allMemory: boolean }
): unknown[] {
  const off = disabledSet()
  return (
    TOOLS.filter((t) => !off.has(t.name))
      .filter((t) => t.name !== 'generate_image' || imageAvailable)
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
    if (ext) return { text: String(await ext.execute(name, args)) }
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return { text: `Error: unknown tool ${name}` }
    return asToolResult(await tool.run(args, ctx))
  } catch (e) {
    return { text: `Error: ${(e as Error).message}` }
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
  /** OpenAI tool schemas to add when extensions are enabled. Built once per turn;
   *  the extension may cache any per-turn state it needs for execute(). */
  schemas(): Promise<unknown[]> | unknown[]
  /** Whether this extension owns a given tool name. */
  canHandle(name: string): boolean
  /** Execute a call this extension owns; returns a string result for the model. */
  execute(name: string, args: Record<string, unknown>): Promise<string> | string
  /** Optional system-prompt addition when this extension contributes tools. */
  systemHint?(): string
}

const toolExtensions: ToolExtension[] = []
export function registerToolExtension(ext: ToolExtension): void {
  if (!toolExtensions.some((e) => e.id === ext.id)) toolExtensions.push(ext)
}
export function getToolExtensions(): ToolExtension[] {
  return toolExtensions
}

export type ToolCall = { name: string; args: Record<string, unknown>; result: string }
// Structured sources surfaced by search_memory so the chat can render them as
// interactive citation cards (thumbnail + open-in-Replay), same as the RAG path.
export type UnifiedSource = {
  key: string
  kind: string
  refId: number
  title: string
  snippet: string
  surface: string
  ts: number
  imagePath: string | null
}

/**
 * Run a chat turn with tool-calling. STREAMS by default (thinking -> tool-call activity
 * -> answer) through the callbacks: `onDelta` gets reasoning/content deltas, `onStep`
 * fires as each tool is about to run so the UI can show "Running web_search...". Omit the
 * callbacks (e.g. the pro skills-engine caller) and it just buffers - the final answer is
 * always the return value either way. Returns the final answer + the calls made.
 */
/** Compose the closing reply after the orchestrator ran a plan: seed the model
 *  with the plan's tool calls + results and stream one natural summary (the same
 *  shape as the reactive loop's forced-final-answer). */
async function composePlanAnswer(
  sys: string,
  query: string,
  history: { role: string; content: string }[],
  res: { toolCalls: ToolCall[]; stopped?: string },
  signal: AbortSignal | undefined,
  onDelta: (text: string, kind: 'content' | 'reasoning') => void
): Promise<string> {
  if (signal?.aborted) {
    return ''
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    { role: 'system', content: sys },
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: query }
  ]
  res.toolCalls.forEach((c, i) => {
    const id = `plan-${String(i)}`
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }
      ]
    })
    messages.push({ role: 'tool', tool_call_id: id, content: c.result })
  })
  if (res.stopped) {
    messages.push({
      role: 'user',
      content: `Note: the task stopped early - ${res.stopped}. Tell the user plainly what happened.`
    })
  }
  const final = await llm.streamChat(messages, onDelta, {
    temperature: 0.3,
    thinking: false,
    signal
  })
  return final.content.trim() || res.stopped || 'Done.'
}

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
    onToolResult?: (call: { name: string; result: string }) => void
    /** The orchestrator's plan for this turn, emitted once before its steps run. */
    onPlan?: (steps: { tool: string; why: string }[]) => void
  } = {}
): Promise<{
  answer: string
  toolCalls: ToolCall[]
  unified: UnifiedSource[]
  imageRequests: { prompt: string }[]
  /** Compatibility alias for older renderer bundles that can generate only one image. */
  imageRequest?: { prompt: string }
}> {
  await llm.init() // respects pause; ensures the server is up
  const onDelta = opts.onDelta ?? ((): void => {})

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
  for (const e of exts) {
    try {
      const s = await e.schemas()
      if (s.length) {
        extSchemas.push(...s)
        if (e.systemHint) hints.push(e.systemHint())
      }
    } catch (err) {
      console.error('[tools] extension schemas', e.id, err)
    }
  }
  const builtins = schemas(imageAvailable, {
    projectActive: !!opts.projectId,
    allMemory: !!opts.allMemory
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
      const { rankConnectorToolsSemantic } = await import('./tools/tool-embedding-ranking')
      rankedTools = await rankConnectorToolsSemantic(query, rawTools, builtins.length, {
        embed: (t) => embeddings.generateEmbedding(t)
      })
    } catch {
      const { rankConnectorTools } = await import('./tools/tool-ranking')
      rankedTools = rankConnectorTools(query, rawTools, builtins.length)
    }
  }
  const { budgetTools } = await import('./tools/tool-budget')
  const ctx = llm.effectiveContextSize()
  // Cap tool tokens in ABSOLUTE terms too, not just as a fraction of context:
  // llama-server re-processes the entire tool prompt every tool round (gemma-4's
  // sliding-window attention defeats the prompt cache), so on CPU-only inference a
  // large tool payload dominates latency. ~4k keeps a useful connector set while
  // roughly halving per-round prompt cost vs the old 45%-of-a-big-context budget.
  const MAX_TOOL_TOKENS = 4000
  const toolBudget = Math.max(1024, Math.min(Math.floor(ctx * 0.4), MAX_TOOL_TOKENS))
  const budgeted = budgetTools(rankedTools, toolBudget, builtins.length)
  if (budgeted.pruned || budgeted.droppedCount) {
    console.warn(
      `[tools] context budget ${toolBudget} tok: pruned schemas${budgeted.droppedCount ? `, dropped ${budgeted.droppedCount} connector tool(s)` : ''} to fit (final ~${budgeted.estTokens} tok)`
    )
    if (budgeted.droppedCount)
      hints.push(
        `Note: ${budgeted.droppedCount} connector tool(s) were omitted this turn to fit the context window; ask the user to disable some connectors if a needed tool is missing.`
      )
  }
  const tools = budgeted.tools
  const sys =
    'You are Off Grid, a private on-device assistant. Use the provided tools when they help answer precisely. Keep answers concise.' +
    (hints.length ? ' ' + hints.join(' ') : '')

  // --- Orchestrator: plan-and-execute for action requests --------------------
  // Before the reactive loop, run ONE focused planning pass. It routes to the
  // right tool and fills its args - the judgment a small model fumbles inline
  // (open_url vs web_task, the missing url, sequencing contacts -> message). An
  // empty/absent plan (a question, chit-chat, a request no tool fits) falls
  // straight through to the reactive loop below, so normal chat is untouched.
  if (shouldPlan(query)) {
    try {
      const catalog = tools
        .map((t) => {
          const fn = (t as { function?: { name?: unknown; description?: unknown } }).function
          return { name: String(fn?.name ?? ''), description: String(fn?.description ?? '') }
        })
        .filter((c) => c.name.length > 0)
      // Backfill an empty web_task/computer_task goal with the user's request,
      // then apply rail-per-surface: a task naming a RUNNING native app drives
      // the app (computer_task), not its website (web_task/open_url).
      const nativeApp = await resolveNativeApp(query)
      const plan = preferNativeApp(
        backfillGoals(await planTask(query, history, catalog), query),
        query,
        nativeApp
      )
      console.log(
        `[orchestrator] goal="${query}" plan=[${plan.steps.map((s) => s.tool).join(' -> ') || 'none'}]`
      )
      if (plan.steps.length > 0) {
        opts.onPlan?.(plan.steps.map((s) => ({ tool: s.tool, why: s.why })))
        const execute = makePlanExecutor((name, args) =>
          runTool(
            name,
            args,
            { conversationId: opts.conversationId, projectId: opts.projectId },
            exts
          )
        )
        const res = await execute(plan, { onStep: opts.onStep, onToolResult: opts.onToolResult })
        const answer = await composePlanAnswer(sys, query, history, res, opts.signal, onDelta)
        // The plan executor yields at most one image request; widen it to the plural
        // contract (main's orchestrator return) and keep the singular compat alias.
        return {
          answer,
          toolCalls: res.toolCalls,
          unified: res.unified,
          imageRequests: res.imageRequest ? [res.imageRequest] : [],
          ...(res.imageRequest ? { imageRequest: res.imageRequest } : {})
        }
      }
    } catch (e) {
      console.warn(
        '[orchestrator] planning failed; falling back to the reactive loop:',
        (e as Error).message
      )
    }
  }

  // Attached images ride on the current user turn so the vision model can read
  // them even in tools/connectors mode (otherwise they were silently dropped).
  // Gate on the ACTIVE model's real vision capability — main is the single source
  // of truth (the renderer's flag is fetched once per mount and can be stale). A
  // text-only model given image_url parts either ignores them (silent wrong answer)
  // or errors, so drop the attachments when there's no vision projector.
  const decodedImages = opts.images?.length && llm.hasVision() ? readImages(opts.images) : []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    { role: 'system', content: sys },
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: buildContentParts(query, decodedImages) }
  ]
  const toolCalls: ToolCall[] = []
  const unified: UnifiedSource[] = []
  const unifiedKeys = new Set<string>()
  // Deferred image generation: keep EVERY request in tool-call order. The renderer generates after
  // the turn so we never evict the LLM mid-loop, and one model round that asks for two pictures does
  // not silently replace the first request with the last.
  const imageRequests: { prompt: string }[] = []
  const resultWithImages = (result: {
    answer: string
    toolCalls: ToolCall[]
    unified: UnifiedSource[]
  }): {
    answer: string
    toolCalls: ToolCall[]
    unified: UnifiedSource[]
    imageRequests: { prompt: string }[]
    imageRequest?: { prompt: string }
  } => {
    const finalImageRequest = imageRequests.at(-1)
    return {
      ...result,
      imageRequests,
      ...(finalImageRequest ? { imageRequest: finalImageRequest } : {})
    }
  }

  for (let step = 0; step < 5; step++) {
    // Stream this round: reasoning + any answer text flow through onDelta live; tool_calls
    // are accumulated and returned. A tool-calling round streams thinking (and no content);
    // the final round streams the answer. tool temperature stays 0.3 (was the blocking path).
    const { content, toolCalls: calls } = await llm.streamChat(messages, onDelta, {
      tools,
      toolChoice: 'auto',
      temperature: 0.3,
      // No hardcoded output cap: the round that produces the FINAL answer (no tool calls) must be
      // free to write a long response. Inherit the user's Max-output setting (auto by default →
      // until EOS / window fills). A tool-selection round stays short on its own (it emits a call).
      thinking: opts.thinking,
      signal: opts.signal
    })

    // Stop pressed during the round: streamCompletion resolves with the partial
    // tool_calls it assembled (it doesn't reject on abort), so we MUST NOT execute
    // them — a cancelled turn fires no side effects (e.g. an MCP send/create).
    // Return what we have; the renderer treats the turn as cancelled.
    if (opts.signal?.aborted)
      return resultWithImages({ answer: content.trim(), toolCalls, unified })

    // Native tool_calls are preferred; but small on-device models (the gemma-4 we
    // ship) often emit a call as TEXT instead of on the tool_calls channel. When
    // the native channel is empty, recover any text-form call so the turn isn't a
    // dead narration ("I would search for…"). Normalize both into one shape with
    // args already parsed to an object.
    const effective =
      calls.length > 0
        ? calls.map((c) => ({
            id: c.id,
            name: c.name,
            args: safeParseArgs(c.arguments),
            rawArgs: c.arguments || '{}'
          }))
        : parseToolCallsFromText(content).map((c, i) => ({
            id: `txt-${String(step)}-${String(i)}`,
            name: c.name,
            args: c.args,
            rawArgs: JSON.stringify(c.args)
          }))

    if (effective.length) {
      // Re-add the assistant turn (with its tool_calls) so the model sees what it invoked.
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: effective.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.rawArgs }
        }))
      })
      for (const c of effective) {
        // Small models sometimes call a search tool with no query — backfill the
        // user's message so the search isn't empty (rather than erroring out).
        if (
          (c.name === 'web_search' || c.name === 'brave_search') &&
          !String((c.args as { query?: unknown }).query ?? '').trim()
        ) {
          c.args = { ...c.args, query }
        }
        opts.onStep?.({ name: c.name, args: c.args }) // surface the tool activity BEFORE running it
        // Uniform dispatch — every tool owns its own result. Merge any structured
        // side channels: sources are deduped into `unified` across rounds; image requests retain
        // call order for deferred generation after the turn.
        const res = await runTool(
          c.name,
          c.args,
          { conversationId: opts.conversationId, projectId: opts.projectId },
          exts
        )
        for (const s of res.sources ?? []) {
          if (unifiedKeys.has(s.key)) continue
          unifiedKeys.add(s.key)
          unified.push(s)
        }
        if (res.imageRequest) imageRequests.push(res.imageRequest)
        toolCalls.push({ name: c.name, args: c.args, result: res.text })
        // Surface the COMPLETED call (with its result) live, so the UI can show each
        // tool call + result as it lands, not only in the final batch.
        opts.onToolResult?.({ name: c.name, result: res.text })
        messages.push({ role: 'tool', tool_call_id: c.id, content: res.text })
      }
      continue // let the model use the results
    }
    // No tool calls this round: `content` is the final answer (already streamed via onDelta).
    return resultWithImages({ answer: content.trim(), toolCalls, unified })
  }
  // Step cap reached with the model still calling tools. Instead of dead-ending
  // with a canned "stopped" message, FORCE one final answer WITHOUT tools, so the
  // user gets a real response built from the results gathered so far.
  if (opts.signal?.aborted) {
    return resultWithImages({ answer: '', toolCalls, unified })
  }
  const final = await llm.streamChat(messages, onDelta, {
    temperature: 0.3,
    // Forced final answer — inherit the user's Max-output setting (auto by default), never a fixed
    // 1024 cap that truncated the response mid-sentence.
    thinking: false,
    signal: opts.signal
  })
  return resultWithImages({
    answer: final.content.trim() || 'Stopped after too many tool steps.',
    toolCalls,
    unified
  })
}

/** Parse a tool-call arguments JSON string to an object; empty object on failure. */
function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Names + descriptions + enabled state of all tools (for the settings UI). */
export function listTools(): { name: string; description: string; enabled: boolean }[] {
  const off = disabledSet()
  return TOOLS.map((t) => ({ name: t.name, description: t.description, enabled: !off.has(t.name) }))
}
