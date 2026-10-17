// Tool-calling loop for Off Grid AI Chat. All main Chat memory scopes use this
// path; memory scope changes which search tool is offered, not the chat engine.
//
// The local model (llama-server, OpenAI-compatible /v1/chat/completions) is given
// tool schemas; we parse its tool_calls, run them, feed results back, and loop
// until it answers. Built-in tools and selected connector extensions share it.

import { offgridGuideTool } from './tools/offgrid-guide-tool'
import { llm } from './llm'
import type { GenerationMetrics } from '../shared/generation-metrics'
import type { ResponseCutoffContract } from '../shared/ipc-contracts'
import { SEARCH_KB_TOOL, sanitizePromptExcerpt } from '@offgrid/rag'
import { stripChatControlTokens } from '@offgrid/sync'
import { isMemoryToolAllowed } from './tools/memory-scope'
import { parseToolCallsFromText, stripQwenToolCallMarkup } from './tools/tool-call-parse'
import { getSetting, saveSetting, searchProjectConversations } from './database'
import {
  projectDocumentsMode,
  type ProjectDocumentsMode
} from './documents/project-knowledge-mode'
import { buildContentParts } from './llm/chat-payload'
import { readImages } from './llm/read-images'
import { stripTags, htmlToText, decodeDdgHref } from './tools-parsers'
import { evaluateArithmetic } from './calculator'
import type { SearchKind, SearchResult } from '../shared/search-contract'
import { selectToolExtensions } from './tools/extension-select'
import { isTaskAction } from './tools/nativeActionToolExtension-logic'
import { callHookAsync, HOOKS } from './bootstrap/hookRegistry'
import {
  CONVERSATION_SUMMARY_MAX_TOKENS,
  boundToolResult,
  callsWithinToolBudget,
  conversationSummaryRequest,
  conversationSummaryTurn,
  elideStaleToolResults,
  normalizeConversationSummary,
  normalizeMaxToolCalls,
  repeatedToolCallDecision,
  repeatedToolCallFinalAnswerInstruction,
  resolveToolName,
  toolCallKey,
  toolFailureMessage,
  toolLimitFinalAnswerInstruction,
  toolResultCharBudget,
  unknownToolMessage,
  type ToolCallRecord
} from '@offgrid/models'
import { toolPromptChars, toolPromptTokens } from './tools/prompt-budget'
import { checkCitations } from '@offgrid/rag/documents'
import { noteDocumentPrefill } from './documents'
import { buildPageBlock, buildPageFence, pageBudgetChars } from './tools/page-fence'
import {
  isToolAllowedForOrigin,
  toolOriginRefusal,
  toolOriginOf,
  type ToolOrigin
} from './tools/tool-origin'
import { selectChatToolSchemas } from './tools/chat-tool-selection'
import { budgetTools } from './tools/tool-budget'
import { ANSWER_NOW_INSTRUCTION, emptyAnswerReason } from '../shared/empty-answer'

/** What a project chat's system prompt says about its knowledge base (Settings → Project knowledge). */
function projectKnowledgeHint(mode: ProjectDocumentsMode | undefined): string {
  const rule = ' Do not invent project facts or use information from other projects.'
  return mode === 'when-needed'
    ? ` This project has a knowledge base of documents. Call search_knowledge_base when a question needs them or earlier conversations in this project, and answer other questions without searching.${rule}`
    : ` This project's documents are already in your context. Use search_knowledge_base only when they do not hold the answer, or to find earlier conversations in this project.${rule}`
}

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
  /** Trusted request boundary; never read from model arguments. */
  origin?: ToolOrigin
  /** Trusted request mode; never read from model arguments. */
  acting?: boolean
  /** Who asked: a person in a chat, or a routine nobody is watching (its actions always wait for approval). */
  actionSource?: 'chat' | 'routine'
  /** Authenticated Mobile launch identity. Only the MCP admission boundary sets it. */
  taskLaunch?: { launchId: string; requestingDeviceId: string }
  /** The paired browser's tab a web task should run in: the tab of the chat that asked. Only
   *  the extension bridge sets it; it travels with that one task (browser-start-tab.ts). */
  startTab?: { browserId: string; tabId: number }
  /** The exact user message. Approval-gated tools use this instead of trusting model-made args. */
  userQuery?: string
  /** Bounded prior user/assistant turns. Intake tools combine these facts with
   *  the current query instead of treating a follow-up as a new task. */
  history?: ToolConversationTurn[]
  onActivity?: (activity: ToolActivity) => void
  /** The active project (if the chat is in one), so search_knowledge_base can query
   *  that project's documents, chats and (when the project includes it) captured memory. */
  projectId?: string
  /** The `[S#]` number of a document passage in this turn's sources, adding it when new. */
  citeDocumentPassage?: (source: UnifiedSource) => number
  /** Per-turn location result. Nearby task tools use this to fail closed when
   *  the device location request did not return usable coordinates. */
  currentLocation?: { latitude: number; longitude: number }
  currentLocationFailed?: boolean
  /** Successful prerequisite actions completed earlier in this same tool turn.
   * Task tools receive these facts so they continue from real state instead of
   * planning the prerequisite again. */
  completedPrerequisites?: string[]
}

export interface ToolConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export type ToolCallStatus = 'completed' | 'failed' | 'pending'

export type ToolActivity =
  | { kind: 'planning'; label: 'Planning next action…' }
  | { kind: 'preparing_tool_calls'; label: 'Preparing actions…'; name?: string }
  /** `summary` stands in for every earlier turn; the app keeps it with the conversation. */
  | { kind: 'compacted'; label: 'Compacted'; summary?: string }
  /** Reading the conversation's attached documents, then what was read. */
  | import('./documents/chat-turn').DocumentsActivity

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
  imageRequest?: { prompt: string; enhancePrompt?: boolean }
  imageRequests?: { prompt: string; enhancePrompt?: boolean }[]
  /** For a task tool (web_use, computer_use): the accepted task's id. Its run, its progress and
   *  Stop all use it, from the moment it is accepted, queued or waiting for approval. */
  taskId?: string
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
  while (u.length > 0 && '"\'<> '.includes(u[u.length - 1]!)) u = u.slice(0, -1)
  while (u.length > 0 && '"\'<> '.includes(u[0]!)) u = u.slice(1)
  if (!u) throw new Error('Invalid URL: empty')
  const scheme = u.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]
  if (scheme && !/^https?$/i.test(scheme))
    throw new Error(`Invalid URL: unsupported scheme ${scheme}`)
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return htmlToText(await res.text())
}

// --- Built-in tools --------------------------------------------------------
const TOOLS: ToolDef[] = [
  offgridGuideTool,
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
        if (!titles.length) {
          const fallback = await fetch(
            'https://www.bing.com/search?format=rss&q=' + encodeURIComponent(q),
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          )
          if (!fallback.ok) throw new Error(`search providers returned HTTP ${fallback.status}`)
          const xml = await fallback.text()
          const items: { title: string; url: string; snippet: string }[] = []
          const ire = /<item>([\s\S]*?)<\/item>/gi
          let item: RegExpExecArray | null
          while ((item = ire.exec(xml)) && items.length < 6) {
            const title = /<title>([\s\S]*?)<\/title>/i.exec(item[1]!)
            const link = /<link>([\s\S]*?)<\/link>/i.exec(item[1]!)
            const description = /<description>([\s\S]*?)<\/description>/i.exec(item[1]!)
            if (!title || !link) continue
            items.push({
              title: stripTags(title[1]!),
              url: stripTags(link[1]!),
              snippet: description ? stripTags(description[1]!) : ''
            })
          }
          if (!items.length) throw new Error('search providers returned no usable results')
          return items
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
            .join('\n')
        }
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
      const url = String(a.url ?? '').trim()
      if (!url) return 'Error: empty url.'
      try {
        const text = await readUrlText(url)
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
    // Only OFFERED in a project chat (gated in schemas() by projectId). The project's documents
    // are already in each turn (budgeted by the document engine); this looks up more passages,
    // sibling conversations and, when the project includes it, captured memory.
    // Global search_memory stays outside this scope.
    name: SEARCH_KB_TOOL.function.name,
    description:
      "Search the current project's knowledge base and conversations for information relevant to the user's question.",
    parameters: SEARCH_KB_TOOL.function.parameters,
    run: async (a, ctx): Promise<ToolResult> => {
      if (!ctx.projectId) {
        return { text: 'No active project — the knowledge base needs an open project.' }
      }
      try {
        const query = String(a.query ?? '').trim()
        if (!query) return { text: 'Give a query to search for.' }
        const { searchDocumentsForTool } = await import('./documents/tool-extension')
        const { projectIncludesMemory } = await import('./rag')
        const conversations = searchProjectConversations(ctx.projectId, query, ctx.conversationId)
        const documents = await searchDocumentsForTool(ctx, query)
        const memory = projectIncludesMemory(ctx.projectId)
          ? await searchMemoryToolResult(query, {
              limit: 5,
              // Captured memory only: other projects' files and chats stay out of this project.
              kinds: ['screen', 'message', 'meeting', 'memory', 'entity', 'fact'],
              excludeChatId: ctx.conversationId,
              emptyText: 'No matching captured memory.'
            })
          : null
        const chats = conversations.length
          ? conversations
              .map(
                (message, index) =>
                  `[C${index + 1}] ${sanitizePromptExcerpt(message.title || 'Project conversation')} · ${message.role}: ${sanitizePromptExcerpt(message.content.slice(0, 1500))}`
              )
              .join('\n\n')
          : 'No matching project conversations found.'
        return {
          text: `Project documents:\n${documents}\n\nProject conversations:\n${chats}${
            memory ? `\n\nCaptured memory:\n${memory.text}` : ''
          }`,
          ...(memory?.sources?.length ? { sources: memory.sources } : {})
        }
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
        prompt: { type: 'string', description: 'a detailed description of the image to create' },
        enhance_prompt: {
          type: 'boolean',
          description:
            'whether to rewrite the prompt before generation; set false when the prompt is already detailed and final'
        }
      },
      required: ['prompt']
    },
    run: (a): ToolResult => {
      const prompt = String(a.prompt ?? '').trim()
      const enhancePrompt = typeof a.enhance_prompt === 'boolean' ? a.enhance_prompt : undefined
      return prompt
        ? {
            text: 'Image generation started - it will appear in the chat.',
            imageRequest: { prompt, ...(enhancePrompt === undefined ? {} : { enhancePrompt }) }
          }
        : { text: 'Error: no image prompt provided.' }
    }
  }
]

// generate_image is gated on an image model being available and is never offered
// otherwise; every other built-in obeys only the disabled-set.
function schemas(
  imageAvailable: boolean,
  scope: { projectActive: boolean; allMemory: boolean },
  allTools = false
): unknown[] {
  const off = allTools ? new Set<string>() : disabledSet()
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

/** The tools a paired browser's agent is offered: the same built-ins and extensions this chat
 *  uses, minus what Settings turned off. generate_image is left out; its image lands in chat. */
export async function enabledToolSchemas(
  exts: ToolExtension[]
): Promise<{ schema: unknown; extension?: ToolExtension }[]> {
  const off = disabledSet()
  const builtins = schemas(false, { projectActive: false, allMemory: true }).map((schema) => ({
    schema
  }))
  const extended = await Promise.all(
    exts.map(async (extension) =>
      (await extension.schemas())
        .filter((s) => !off.has((s as { function?: { name?: string } }).function?.name ?? ''))
        .map((schema) => ({ schema, extension }))
    )
  )
  return [...builtins, ...extended.flat()]
}

/** Normalize a tool's return (bare string or structured) to a ToolResult. */
function asToolResult(r: string | ToolResult): ToolResult {
  return typeof r === 'string' ? { text: r } : r
}

/** Dispatch a tool call UNIFORMLY: a registered extension that owns the name wins,
 *  else the matching built-in. An unknown name or a throw becomes a recoverable
 *  error result the model reads and can correct (a single tool failing never aborts
 *  the turn). `available` names the tools the model may call instead. No name-based
 *  special-casing — each tool owns its own text + side channels (sources /
 *  imageRequest) via its ToolResult. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  exts: ToolExtension[],
  available: readonly string[] = TOOLS.map((t) => t.name)
): Promise<ToolResult> {
  try {
    const origin = toolOriginOf(ctx)
    const ext = exts.find((e) => e.canHandle(name))
    if (!isToolAllowedForOrigin(name, origin.origin, { ...origin, extension: ext })) {
      return {
        text: toolOriginRefusal(name),
        status: 'failed',
        authoritative: true
      }
    }
    if (ext) return asToolResult(await ext.execute(name, args, ctx))
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return { text: unknownToolMessage(name, available), status: 'failed' }
    return asToolResult(await tool.run(args, ctx))
  } catch (e) {
    return { text: toolFailureMessage(name, (e as Error).message), status: 'failed' }
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
  /** Trusted side lookup; true only for declared non-destructive reads. Never sent to the model. */
  isReadOnlyTool?(name: string): boolean
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

export async function selectChatTools(
  query: string | undefined,
  opts: {
    origin?: ToolOrigin
    assistantOnly?: boolean
    allTools?: boolean
    connectors?: boolean
    projectId?: string
    allMemory?: boolean
    imageAvailable?: boolean
    conversationId?: string
  } = {},
  history: { role: string; content: string }[] = []
): Promise<{
  tools: unknown[]
  protectedToolCount: number
  hints: string[]
  exts: ToolExtension[]
}> {
  const toolsEnabled = opts.allTools || getSetting<boolean>('toolsEnabled', true) !== false
  const imageAvailable = opts.imageAvailable ?? false
  // Opt-in: pull in tools from registered pro extensions (e.g. MCP connectors)
  // alongside the built-ins. Schemas are built once per turn; each extension
  // caches whatever per-turn state it needs for execute(). Free build registers
  // no extensions, so this is just the built-ins.
  const exts =
    toolsEnabled || opts.assistantOnly
      ? selectToolExtensions(getToolExtensions(), {
          // Settings → Connectors can switch every connector off at once, like tools.
          connectors:
            toolsEnabled &&
            !!opts.connectors &&
            getSetting<boolean>('connectorsEnabled', true) !== false
        })
      : []
  const extSchemas: unknown[] = []
  const hints: string[] = []
  const extensionHints: { names: Set<string>; text: string }[] = []
  const disabled = opts.allTools ? new Set<string>() : disabledSet()
  for (const e of exts) {
    try {
      const s = await e.schemas()
      const enabledSchemas = s.filter((schema) => {
        const name = (schema as { function?: { name?: unknown } }).function?.name
        if (
          !isToolAllowedForOrigin(name, opts.origin, {
            acting: opts.assistantOnly,
            extension: e
          })
        ) {
          return false
        }
        if (opts.assistantOnly && (name === 'web_use' || name === 'computer_use')) return true
        return toolsEnabled && (typeof name !== 'string' || !disabled.has(name))
      })
      if (enabledSchemas.length) {
        extSchemas.push(...enabledSchemas)
        if (e.systemHint && toolsEnabled) {
          extensionHints.push({
            names: new Set(
              enabledSchemas.flatMap((schema) => {
                const name = (schema as { function?: { name?: unknown } }).function?.name
                return typeof name === 'string' ? [name] : []
              })
            ),
            text: e.systemHint()
          })
        }
      }
    } catch (err) {
      console.error('[tools] extension schemas', e.id, err)
    }
  }
  const builtins = toolsEnabled
    ? schemas(
        imageAvailable,
        { projectActive: !!opts.projectId, allMemory: !!opts.allMemory },
        opts.allTools
      ).filter((schema) =>
        isToolAllowedForOrigin(
          (schema as { function: { name: string } }).function.name,
          opts.origin,
          {
            acting: opts.assistantOnly
          }
        )
      )
    : []
  const assistantRequiredTools = opts.assistantOnly
    ? extSchemas.filter((schema) => {
        const name = (schema as { function?: { name?: unknown } }).function?.name
        return name === 'web_use' || name === 'computer_use'
      })
    : []
  const otherExtSchemas = extSchemas.filter((schema) => !assistantRequiredTools.includes(schema))
  const rawTools = [...assistantRequiredTools, ...builtins, ...otherExtSchemas]
  const {
    tools: relevantTools,
    protectedToolCount,
    droppedCount
  } = await selectChatToolSchemas(query, rawTools, assistantRequiredTools, {
    ...opts,
    imageAvailable,
    history,
    contextSize: llm.effectiveContextSize()
  })
  const relevantNames = new Set(
    relevantTools.flatMap((schema) => {
      const name = (schema as { function?: { name?: unknown } }).function?.name
      return typeof name === 'string' ? [name] : []
    })
  )
  hints.push(
    ...extensionHints
      .filter((hint) => [...hint.names].some((name) => relevantNames.has(name)))
      .map((hint) => hint.text)
  )
  if (droppedCount) {
    hints.push(
      `Note: ${droppedCount} connector tool(s) were omitted this turn to fit the context window; ask the user to disable some connectors if a needed tool is missing.`
    )
  }
  return { tools: relevantTools, protectedToolCount, hints, exts }
}

/**
 * Run a chat turn with tool-calling. STREAMS by default (thinking -> tool-call activity
 * -> answer) through the callbacks: `onDelta` gets reasoning/content deltas, `onStep`
 * fires as each tool is about to run so the UI can show "Running web_search...". Omit the
 * callbacks (e.g. the pro skills-engine caller) and it just buffers - the final answer is
 * always the return value either way. Returns the final answer + the calls made.
 */
/**
 * The user's standing rules, last in the system prompt where the model weighs them most. Every
 * rule is kept: tone and persona rules ("speak like a Greek god") shape every reply.
 */
function standingRules(rules: readonly string[] | undefined): string {
  const kept = (rules ?? []).map((rule) => rule.trim()).filter(Boolean)
  if (!kept.length) return ''
  return `\n\nThe user's standing rules. Follow every one in every reply, including how you speak and the persona you take:\n${kept.map((rule) => `- ${rule}`).join('\n')}`
}

/** A complete generate_image call's request, or null when its arguments are not usable yet. */
function earlyImageRequest(
  rawArguments: string
): { prompt: string; enhancePrompt?: boolean } | null {
  try {
    const args = JSON.parse(rawArguments) as { prompt?: unknown; enhance_prompt?: unknown }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt) return null
    return typeof args.enhance_prompt === 'boolean'
      ? { prompt, enhancePrompt: args.enhance_prompt }
      : { prompt }
  } catch {
    return null
  }
}

export async function toolChat(
  query: string,
  history: { role: string; content: string }[] = [],
  opts: {
    pageText?: string
    page?: { title: string; url: string; text: string }
    origin?: ToolOrigin
    startTab?: ToolContext['startTab']
    /** Assistant is selected for this turn; always include its browser and desktop tools. */
    assistantOnly?: boolean
    /** God: every tool is on, whatever the Tools switch and per-tool settings say. */
    allTools?: boolean
    /** A routine runs this turn: what it tries to do waits for approval (god-routines.ts). */
    actionSource?: 'chat' | 'routine'
    /** What the user is doing now (God's context): added to the system prompt, bounded. */
    context?: string
    /** God's standing rules: closing the system prompt, kept whole so none is cut away. */
    rules?: readonly string[]
    connectors?: boolean
    conversationId?: string
    /** Active project — offers search_knowledge_base + scopes it to this project. */
    projectId?: string
    /** Documents attached to this message. Earlier ones are read from the conversation. */
    documents?: import('./documents/chat-turn').TurnDocumentRef[]
    /** < 1 on a retry after the prompt did not fit the window: less document text. */
    documentScale?: number
    /** Chat is in "All memory" scope — offers search_memory over everything. */
    allMemory?: boolean
    images?: string[]
    imageAvailable?: boolean
    thinking?: boolean
    signal?: AbortSignal
    onDelta?: (text: string, kind: 'content' | 'reasoning') => void
    onStep?: (call: { name: string; args: Record<string, unknown> }) => void
    onToolResult?: (call: {
      name: string
      result: string
      status: ToolCallStatus
      taskId?: string
    }) => void
    onActivity?: (activity: ToolActivity) => void
    /** The orchestrator's plan for this turn, emitted once before its steps run. */
    onPlan?: (steps: { tool: string; why: string }[]) => void
    /**
     * Each image request as soon as the model finishes writing its call, before the round ends.
     * Only for callers whose image generation can run beside this chat turn; the final result
     * still lists every request, so a caller matches these against it.
     */
    onImageRequest?: (request: { prompt: string; enhancePrompt?: boolean }) => void
  } = {}
): Promise<{
  answer: string
  toolCalls: ToolCall[]
  unified: UnifiedSource[]
  imageRequests: { prompt: string; enhancePrompt?: boolean }[]
  /** Compatibility alias for older renderer bundles that can generate only one image. */
  imageRequest?: { prompt: string; enhancePrompt?: boolean }
  toolsOffered?: string[]
  metrics?: GenerationMetrics
  cutoff?: ResponseCutoffContract
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
  // A selected remote model does not need the local server to be installed or warm.
  if (!(await import('./vision/remote-vision-server')).getActiveRemoteVisionServer()) {
    await llm.init() // respects pause; ensures the local server is up
  }
  const onDelta = opts.onDelta ?? ((): void => {})
  const toolContext: ToolContext = {
    conversationId: opts.conversationId,
    startTab: opts.startTab,
    origin: opts.origin,
    acting: opts.assistantOnly,
    ...(opts.actionSource ? { actionSource: opts.actionSource } : {}),
    projectId: opts.projectId,
    userQuery: query,
    history: boundedToolHistory(history),
    onActivity: opts.onActivity
  }

  // Offer generate_image only when an image model is available. The renderer passes
  // this; fall back to the main-process check so a caller that omits it still gates
  // correctly (single source of truth for "can we make an image right now").
  const toolsEnabled = opts.allTools || getSetting<boolean>('toolsEnabled', true) !== false
  let imageAvailable = opts.imageAvailable ?? false
  if ((!opts.assistantOnly || toolsEnabled) && opts.imageAvailable === undefined) {
    try {
      const { activeImageModel } = await import('./imagegen')
      imageAvailable = !!activeImageModel()
    } catch {
      /* no image runtime -> stay false */
    }
  }

  const { tools, protectedToolCount, hints, exts } = await selectChatTools(
    query,
    { ...opts, imageAvailable },
    history
  )
  const ctx = llm.effectiveContextSize()
  if (tools.length) {
    const plannerUnavailable = await llm.toolPlannerPreflight()
    if (plannerUnavailable) {
      return {
        answer: plannerUnavailable,
        toolCalls: [],
        unified: [],
        imageRequests: []
      }
    }
  }
  const projectPrompt = opts.projectId
    ? (await import('./rag/store'))
        .listProjects()
        .find((project) => project.id === opts.projectId)
        ?.systemPrompt.trim()
    : undefined
  const projectKnowledgeMode = opts.projectId
    ? projectDocumentsMode(getSetting<unknown>('knowledgeBaseRetrieval', null))
    : undefined
  const sys =
    'You are Off Grid AI, a private on-device assistant. Answer general questions using your knowledge. Use the provided tools when they help answer precisely. Before calling web_use, use the full conversation and ask the user one concise set of questions only when a material fact is missing. Answer questions directly. Call web_use only when the user asks you to do something on a website. Keep answers concise.' +
    (opts.allMemory
      ? ' Use search_memory when the user asks about their memories, past conversations, people, or captured activity. Do not invent personal facts or claim to have searched when you have not. Cite retrieved sources accurately.'
      : '') +
    (opts.projectId ? projectKnowledgeHint(projectKnowledgeMode) : '') +
    (projectPrompt ? `\n\nProject instructions:\n${projectPrompt}` : '') +
    (opts.assistantOnly
      ? ' web_use and computer_use are available when the user asks you to do something on a website or in a desktop app.'
      : '') +
    (hints.length ? ' ' + hints.join(' ') : '') +
    (typeof opts.context === 'string' && opts.context.trim()
      ? `\n\nWhat you know about the user right now:\n${opts.context.trim().slice(0, 2000)}`
      : '') +
    (opts.startTab
      ? '\nThis request comes from a paired browser tab. Use web_use for requested work on that website, including opening notifications. It will use that tab and its current login. Prefer visible page controls; do not invent URL paths or supply a guessed starting URL.'
      : '') +
    standingRules(opts.rules)

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
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: buildContentParts(
        query +
          (opts.page
            ? buildPageBlock(opts.page, pageBudgetChars(ctx))
            : buildPageFence(opts.pageText)),
        decodedImages
      )
    }
  ]
  // Tokens counted by script: characters / 4 lets a Japanese or Chinese chat overflow first.
  const compactAtTokens = Math.floor(ctx * 0.8)
  // Documents attached anywhere in this conversation are rebuilt for every turn by the shared turn
  // service (@offgrid/rag/documents): whole when they fit the time the model takes to read them,
  // otherwise hybrid-ranked, reranked passages with every document given a share. They never ride
  // in history, so they never trigger compaction and are never forgotten on the next question.
  // The stable part (whole documents or document maps) follows the system prompt unchanged from
  // turn to turn, so the model server reuses its cached prefix; this turn's passages sit beside
  // the question.
  const historyTokens = toolPromptTokens(messages.slice(1, -1))
  const turnReplyReserve = Math.min(1024, Math.max(256, Math.floor(ctx * 0.1)))
  let documentSources: UnifiedSource[] = []
  const { prepareTurnDocuments } = await import('./documents/chat-turn')
  const attachedDocuments = await prepareTurnDocuments({
    conversationId: opts.conversationId,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    current: opts.documents ?? [],
    question: query,
    history,
    budget: {
      ctx,
      replyReserve: turnReplyReserve,
      systemTokens: toolPromptTokens([messages[0]]),
      requiredToolTokens: opts.assistantOnly ? Math.max(0, toolPromptTokens([], tools)) : 0,
      historyTokens,
      questionTokens: toolPromptTokens([{ role: 'user', content: query }]),
      ...(opts.documentScale ? { scale: opts.documentScale } : {})
    },
    onActivity: opts.onActivity
  })
  if (attachedDocuments) {
    // A model that uses tools may look further into the documents (search, exact pages). In a
    // project chat search_knowledge_base already searches the same documents.
    if (tools.length) {
      const { documentToolExtension, documentToolSchemas } =
        await import('./documents/tool-extension')
      tools.push(
        ...documentToolSchemas.filter(
          (schema) => !opts.projectId || schema.function.name !== 'search_documents'
        )
      )
      exts.push(documentToolExtension)
      messages[0].content = `${messages[0].content}\n${documentToolExtension.systemHint()}`
    }
    if (attachedDocuments.stable)
      messages[0].content = `${messages[0].content}\n\n${attachedDocuments.stable}`
    if (attachedDocuments.turn) {
      const turn = messages[messages.length - 1]
      if (typeof turn.content === 'string')
        turn.content = `${attachedDocuments.turn}\n\n${turn.content}`
      else if (Array.isArray(turn.content)) {
        const textPart = turn.content.find((part: { type?: string }) => part.type === 'text')
        if (textPart) textPart.text = `${attachedDocuments.turn}\n\n${textPart.text}`
      }
    }
    documentSources = attachedDocuments.sources
  }
  // One model call folds every earlier turn into a structured summary that stands in for them
  // from now on. If it fails, the oldest turns fall back to short excerpts as before.
  const summary =
    toolPromptTokens(messages, tools) >= compactAtTokens && history.length
      ? await summarizeConversation(history, ctx, opts.signal)
      : null
  const summarized = summary
    ? [messages[0], conversationSummaryTurn(summary), messages[messages.length - 1]]
    : null
  if (summarized && toolPromptTokens(summarized, tools) < toolPromptTokens(messages, tools)) {
    messages.splice(0, messages.length, ...summarized)
    opts.onActivity?.({ kind: 'compacted', label: 'Compacted', summary: summary! })
  } else if (toolPromptTokens(messages, tools) >= compactAtTokens && history.length) {
    const older: { role: string; content: string }[] = []
    const recent = history.slice()
    let compacted = messages
    while (recent.length && toolPromptTokens(compacted, tools) >= compactAtTokens) {
      older.push(recent.shift()!)
      const excerptTurns = [older[0]!, ...older.slice(-3).filter((turn) => turn !== older[0])]
      const excerpts = excerptTurns.map(
        (turn) =>
          `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content.slice(0, 90)}`
      )
      const excerpt = {
        role: 'user',
        content:
          `Earlier chat excerpts (${older.length} turns; some details omitted): ${excerpts.join(' | ')}`.slice(
            0,
            400
          )
      }
      compacted = [messages[0], excerpt, ...recent, messages[messages.length - 1]]
    }
    if (toolPromptTokens(compacted, tools) < toolPromptTokens(messages, tools)) {
      messages.splice(0, messages.length, ...compacted)
      opts.onActivity?.({ kind: 'compacted', label: 'Compacted' })
    }
  }
  // Track the prompt sent on the latest model round, including tool results.
  let retainedPromptTokens = Math.ceil(toolPromptChars(messages, tools) / 4)
  const offeredTools = new Set<string>()
  const toolCalls: ToolCall[] = []
  // Document passages lead the sources, so `[S1]…[Sn]` in the prompt are the first n sources.
  const unified: UnifiedSource[] = [...documentSources]
  const unifiedKeys = new Set<string>(documentSources.map((source) => source.key))
  // A document search tool cites passages by their place in these sources: a passage the turn
  // already gave keeps its number, a new one is added now so its number is fixed.
  toolContext.citeDocumentPassage = (source) => {
    const known = unified.findIndex((existing) => existing.key === source.key)
    if (known >= 0) return known + 1
    unifiedKeys.add(source.key)
    unified.push(source)
    return unified.length
  }
  // Deferred image generation: keep EVERY request in tool-call order. The renderer generates after
  // the turn so we never evict the LLM mid-loop, and one model round that asks for two pictures does
  // not silently replace the first request with the last.
  const imageRequests: { prompt: string; enhancePrompt?: boolean }[] = []
  const earlyImagePrompts = new Set<string>()
  let finishAfterDeferredImages = false
  const toolRoundAnswers: string[] = []
  const resultWithImages = (result: {
    answer: string
    toolCalls: ToolCall[]
    unified: UnifiedSource[]
    metrics?: GenerationMetrics
    cutoff?: ResponseCutoffContract
  }): {
    answer: string
    toolCalls: ToolCall[]
    unified: UnifiedSource[]
    metrics?: GenerationMetrics
    cutoff?: ResponseCutoffContract
    imageRequests: { prompt: string; enhancePrompt?: boolean }[]
    imageRequest?: { prompt: string; enhancePrompt?: boolean }
    toolsOffered?: string[]
  } => {
    const finalImageRequest = imageRequests.at(-1)
    noteDocumentPrefill(result.metrics)
    const answer = [...toolRoundAnswers, result.answer].filter((text) => text.trim()).join('\n\n')
    return {
      ...result,
      // A citation that points at no source would lead nowhere in the Sources panel.
      answer:
        documentSources.length || result.unified.some((source) => source.kind === 'attachment')
          ? checkCitations(answer, result.unified.length)
          : answer,
      metrics: {
        ...result.metrics,
        contextWindowTokens: result.metrics?.contextWindowTokens ?? ctx,
        ...(result.metrics?.promptTokens ? {} : { estimatedPromptTokens: retainedPromptTokens })
      },
      imageRequests,
      ...(offeredTools.size ? { toolsOffered: [...offeredTools] } : {}),
      ...(finalImageRequest ? { imageRequest: finalImageRequest } : {})
    }
  }

  const settings = llm.getSettings()
  const maxToolCalls = normalizeMaxToolCalls(settings.maxToolCalls)
  const requestedImageCountMatch = query.match(
    /\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:distinct\s+|different\s+|separate\s+|unique\s+)?(?:images|pictures|photos|illustrations|variations)\b/i
  )
  const requestedImageCountWords: Record<string, number> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  }
  const requestedImageCount = Math.min(
    maxToolCalls,
    Math.max(
      1,
      requestedImageCountMatch
        ? (requestedImageCountWords[requestedImageCountMatch[1]!.toLowerCase()] ??
            Number(requestedImageCountMatch[1]))
        : 1
    )
  )
  // Tool chat compacts at 80% above. Fit schemas around the retained turns and
  // reserve space for the reply; never discard another turn without a notice.
  const replyReserve = Math.min(1024, Math.max(256, Math.floor(ctx * 0.1)))
  const maxPromptChars = Math.max(0, ctx - replyReserve) * 4
  const answerFrom = (content: string): string => {
    return stripChatControlTokens(stripQwenToolCallMarkup(content))
  }
  let round = 0
  // Every call this response made or declined, in order, for repeat detection.
  const callRecords: ToolCallRecord[] = []
  let stopInstruction: string | undefined
  while (toolCalls.length < maxToolCalls) {
    // Past the soft threshold, older bulky tool results become short stubs so a long
    // tool sequence keeps room to finish instead of ending in "Context is full."
    const elision = elideStaleToolResults(messages, maxPromptChars)
    if (elision.elided) messages.splice(0, messages.length, ...elision.messages)
    if (toolPromptChars(messages) > maxPromptChars) {
      return resultWithImages({ answer: 'Context is full.', toolCalls, unified })
    }
    const availableToolTokens = Math.max(
      0,
      Math.floor((maxPromptChars - toolPromptChars(messages)) / 4)
    )
    const fittedTools = budgetTools(tools, availableToolTokens, protectedToolCount)
    if (opts.assistantOnly && fittedTools.estTokens > availableToolTokens) {
      return resultWithImages({ answer: 'Context is full.', toolCalls, unified })
    }
    const roundTools =
      !finishAfterDeferredImages && fittedTools.estTokens <= availableToolTokens
        ? fittedTools.tools
        : []
    retainedPromptTokens = Math.ceil(toolPromptChars(messages, roundTools) / 4)
    const remainingOutputTokens = Math.max(
      1,
      ctx - Math.ceil(toolPromptChars(messages, roundTools) / 4) - 32
    )
    const roundMaxTokens =
      typeof settings.maxTokens === 'number' && settings.maxTokens > 0
        ? Math.min(settings.maxTokens, remainingOutputTokens)
        : remainingOutputTokens
    if (tools.length && !roundTools.length) {
      console.warn('[tools] no tool schemas fit beside the retained conversation')
    }
    for (const tool of roundTools) {
      const name = (tool as { function?: { name?: unknown } }).function?.name
      if (typeof name === 'string' && name) offeredTools.add(name)
    }
    // Stream this round: reasoning + any answer text flow through onDelta live; tool_calls
    // are accumulated and returned. Tool-calling rounds can also contain visible prose;
    // keep it in the returned answer as well as the live stream.
    const {
      content,
      toolCalls: calls,
      reasoningDetails,
      finishReason,
      metrics
    } = await llm.streamChat(messages, onDelta, {
      tools: roundTools,
      toolChoice: roundTools.length ? 'auto' : undefined,
      temperature: 0.3,
      // Keep the user's lower Max Output setting, but never request more than
      // this round has room to generate inside the configured context window.
      maxTokens: roundMaxTokens,
      thinking: opts.thinking,
      signal: opts.signal,
      onToolCallStart: (name) =>
        opts.onActivity?.({ kind: 'preparing_tool_calls', label: 'Preparing actions…', name }),
      onToolCallReady:
        opts.onImageRequest &&
        roundTools.some(
          (tool) => (tool as { function?: { name?: unknown } }).function?.name === 'generate_image'
        )
          ? (call) => {
              if (call.name !== 'generate_image' || opts.signal?.aborted) return
              const request = earlyImageRequest(call.arguments)
              if (
                !request ||
                earlyImagePrompts.has(request.prompt) ||
                earlyImagePrompts.size >= requestedImageCount
              )
                return
              earlyImagePrompts.add(request.prompt)
              opts.onImageRequest?.(request)
            }
          : undefined
    })

    // Stop pressed during the round: streamCompletion resolves with the partial
    // tool_calls it assembled (it doesn't reject on abort), so we MUST NOT execute
    // them — a cancelled turn fires no side effects (e.g. an MCP send/create).
    // Return what we have; the renderer treats the turn as cancelled.
    if (opts.signal?.aborted)
      return resultWithImages({ answer: content.trim(), toolCalls, unified, metrics })

    // Native tool_calls are preferred; but small on-device models (the gemma-4 we
    // ship) often emit a call as TEXT instead of on the tool_calls channel. When
    // the native channel is empty, recover any text-form call so the turn isn't a
    // dead narration ("I would search for…"). Normalize both into one shape with
    // args already parsed to an object. A misnamed call (`search`, `functions.web_search`)
    // is mapped to the offered tool it meant rather than failing as unknown.
    const roundToolNames = roundTools.flatMap((tool) => {
      const name = (tool as { function?: { name?: unknown } }).function?.name
      return typeof name === 'string' && name ? [name] : []
    })
    const effective = !roundTools.length
      ? []
      : calls.length > 0
        ? calls.map((c) => ({
            id: c.id,
            name: resolveToolName(c.name, roundToolNames),
            args: safeParseArgs(c.arguments),
            rawArgs: c.arguments || '{}'
          }))
        : parseToolCallsFromText(content).map((c, i) => ({
            id: `txt-${String(round)}-${String(i)}`,
            name: resolveToolName(c.name, roundToolNames),
            args: c.args,
            rawArgs: JSON.stringify(c.args)
          }))
    // A text-form call is not permission to cross the selected memory scope.
    const scopedEffective = effective.filter((call) =>
      isMemoryToolAllowed(call.name, {
        projectActive: !!opts.projectId,
        allMemory: !!opts.allMemory
      })
    )

    // A long-running Web Use or Computer Use call owns the whole goal. Preserve
    // an explicit open_url prerequisite before Computer Use, then execute only
    // the first task call. The task runtime owns all later work and retries.
    const taskCall = scopedEffective.find((call) => isTaskAction(call.name))
    const taskIndex = taskCall ? scopedEffective.indexOf(taskCall) : -1
    const prerequisites =
      taskCall?.name === 'computer_use'
        ? scopedEffective.slice(0, taskIndex).filter((call) => call.name === 'open_url')
        : []
    const permitted = taskCall ? [...prerequisites, taskCall] : scopedEffective
    if (permitted.length) {
      const roundAnswer = answerFrom(content)
      if (roundAnswer.trim()) toolRoundAnswers.push(roundAnswer)
      // One model round can request several tools in parallel. Count the actual calls, as Mobile
      // does, and execute only the remaining allowance so the configured ceiling stays truthful.
      let remainingImageRequests = requestedImageCount - imageRequests.length
      const callsToRun = callsWithinToolBudget(permitted, toolCalls.length, maxToolCalls).filter(
        (call) => call.name !== 'generate_image' || remainingImageRequests-- > 0
      )
      // Re-add the assistant turn (with its tool_calls) so the model sees what it invoked.
      messages.push({
        role: 'assistant',
        content: content || null,
        ...(reasoningDetails?.length ? { reasoning_details: reasoningDetails } : {}),
        tool_calls: callsToRun.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.rawArgs }
        }))
      })
      for (const c of callsToRun) {
        // Small models sometimes call a search tool with no query — backfill the
        // user's message so the search isn't empty (rather than erroring out).
        if (
          (c.name === 'web_search' || c.name === 'brave_search') &&
          !String((c.args as { query?: unknown }).query ?? '').trim()
        ) {
          c.args = { ...c.args, query }
        }
        // A call identical to the one just before it is not run again: the model is told it
        // already has that result. Repeating after that ends tool use with a forced answer.
        const key = toolCallKey(c.name, c.args)
        const repeat = repeatedToolCallDecision(callRecords, c.name, key)
        if (repeat.action === 'stop') {
          for (const unrun of callsToRun.slice(callsToRun.indexOf(c))) {
            messages.push({
              role: 'tool',
              tool_call_id: unrun.id,
              content: 'Not run: tool use has ended because the same call kept repeating.'
            })
          }
          stopInstruction = repeatedToolCallFinalAnswerInstruction(c.name)
          break
        }
        if (repeat.action === 'skip') {
          callRecords.push({ key, outcome: 'repeated' })
          messages.push({ role: 'tool', tool_call_id: c.id, content: repeat.note })
          continue
        }
        opts.onStep?.({ name: c.name, args: c.args }) // surface the tool activity BEFORE running it
        // Uniform dispatch — every tool owns its own result. Merge any structured
        // side channels: sources are deduped into `unified` across rounds; image requests retain
        // call order for deferred generation after the turn.
        const rawResult = await runTool(c.name, c.args, toolContext, exts, roundToolNames)
        const resultBudget = toolResultCharBudget({
          contextLength: llm.effectiveContextSize(),
          promptChars: toolPromptChars(messages, roundTools),
          replyReserveTokens: settings.maxTokens
        })
        const resultRoom = Math.max(
          0,
          maxPromptChars -
            toolPromptChars([...messages, { role: 'tool', tool_call_id: c.id, content: '' }])
        )
        const boundedText = boundToolResult(
          c.name,
          rawResult.text,
          rawResult.authoritative
            ? resultBudget
            : Math.min(resultBudget, Math.max(0, resultRoom - 100))
        )
        const res = {
          ...rawResult,
          text: rawResult.authoritative
            ? boundedText
            : resultRoom <= 100
              ? rawResult.text.slice(0, resultRoom)
              : boundedText.slice(0, resultRoom)
        }
        for (const s of res.sources ?? []) {
          if (unifiedKeys.has(s.key)) continue
          unifiedKeys.add(s.key)
          unified.push(s)
        }
        if (res.imageRequests?.length) {
          imageRequests.push(...res.imageRequests)
          finishAfterDeferredImages = true
        } else if (res.imageRequest) {
          imageRequests.push(res.imageRequest)
          finishAfterDeferredImages = imageRequests.length >= requestedImageCount
        }
        const status = res.status ?? 'completed'
        callRecords.push({ key, outcome: status })
        toolCalls.push({ name: c.name, args: c.args, result: res.text, status })
        // Surface the COMPLETED call (with its result) live, so the UI can show each
        // tool call + result as it lands, not only in the final batch.
        opts.onToolResult?.({ name: c.name, result: res.text, status, taskId: res.taskId })
        messages.push({ role: 'tool', tool_call_id: c.id, content: res.text })
        // Long-running tasks are always terminal for this outer Chat turn. Keep
        // this boundary independent of extension result flags so a regression or
        // a model retry cannot start a second task for the same user request.
        if (isTaskAction(c.name) || res.authoritative) {
          onDelta(res.text, 'content')
          return resultWithImages({ answer: res.text, toolCalls, unified, metrics })
        }
      }
      if (stopInstruction) break
      round += 1
      continue // let the model use the results
    }
    // No tool calls this round: `content` is the final answer (already streamed via onDelta).
    if (!answerFrom(content).trim() && !opts.signal?.aborted) {
      // Finished with nothing to say (often reasoning used the whole allowance): ask once more
      // for an answer from what is already here, then say why if there is still none.
      const retry = await llm.streamChat(
        [...messages, { role: 'system', content: ANSWER_NOW_INSTRUCTION }],
        onDelta,
        { temperature: 0.3, maxTokens: roundMaxTokens, thinking: false, signal: opts.signal }
      )
      const retried = answerFrom(retry.content)
      return resultWithImages({
        answer: retried.trim()
          ? retried
          : emptyAnswerReason(retry.finishReason ?? finishReason, roundMaxTokens),
        toolCalls,
        unified,
        metrics: retry.metrics ?? metrics
      })
    }
    return resultWithImages({
      answer: answerFrom(content),
      toolCalls,
      unified,
      metrics,
      ...(finishReason === 'length'
        ? { cutoff: { reason: 'max_tokens' as const, maxTokens: roundMaxTokens } }
        : {})
    })
  }
  // The configured emergency cap was reached, or the model kept repeating one call, with the
  // model still calling tools. Instead of dead-ending with a canned "stopped" message, FORCE one
  // final answer WITHOUT tools, so the user gets a real response built from the results gathered so far.
  if (opts.signal?.aborted) {
    return resultWithImages({ answer: '', toolCalls, unified })
  }
  const finalMessages = [
    { role: 'system', content: stopInstruction ?? toolLimitFinalAnswerInstruction(maxToolCalls) },
    ...messages.filter((message) => message.role !== 'system')
  ]
  if (toolPromptChars(finalMessages) > maxPromptChars) {
    return resultWithImages({ answer: answerFrom('') || 'Context is full.', toolCalls, unified })
  }
  const finalOutputRoom = Math.max(1, ctx - Math.ceil(toolPromptChars(finalMessages) / 4) - 32)
  const finalMaxTokens =
    typeof settings.maxTokens === 'number' && settings.maxTokens > 0
      ? Math.min(settings.maxTokens, finalOutputRoom)
      : finalOutputRoom
  const final = await llm.streamChat(finalMessages, onDelta, {
    temperature: 0.3,
    // Forced final answer obeys the same context-bound cap as every tool round.
    maxTokens: finalMaxTokens,
    thinking: false,
    signal: opts.signal
  })
  return resultWithImages({
    answer: answerFrom(final.content) || 'Stopped after too many tool steps.',
    toolCalls,
    unified,
    metrics: final.metrics,
    ...(final.finishReason === 'length'
      ? { cutoff: { reason: 'max_tokens' as const, maxTokens: finalMaxTokens } }
      : {})
  })
}

/** Summarize the conversation so far in one tool-free call; `null` when no usable summary came back. */
async function summarizeConversation(
  history: { role: string; content: string }[],
  ctx: number,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return null
  // A budget too small for the request throws inside the try, so excerpts are used instead.
  const maxTokens = Math.max(0, ctx - CONVERSATION_SUMMARY_MAX_TOKENS - 256)
  try {
    const reply = await llm.streamChat(
      conversationSummaryRequest(history, { maxTokens }),
      () => {},
      {
        temperature: 0.2,
        maxTokens: CONVERSATION_SUMMARY_MAX_TOKENS,
        thinking: false,
        signal
      }
    )
    if (signal?.aborted) return null
    return normalizeConversationSummary(
      stripChatControlTokens(stripQwenToolCallMarkup(reply.content))
    )
  } catch (error) {
    console.warn('[tools] conversation summary failed; keeping excerpts', error)
    return null
  }
}

const TOOL_HISTORY_TURNS = 8
const TOOL_HISTORY_CHARS_PER_TURN = 1_500

function boundedToolHistory(history: { role: string; content: string }[]): ToolConversationTurn[] {
  return history
    .filter(
      (turn): turn is { role: 'user' | 'assistant'; content: string } =>
        (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string'
    )
    .slice(-TOOL_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.slice(0, TOOL_HISTORY_CHARS_PER_TURN)
    }))
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
