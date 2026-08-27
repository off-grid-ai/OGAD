// MCP connectors — Off Grid AI acts as an MCP *client*. Each connector is an MCP
// server the user authorizes (stdio command or HTTP/SSE endpoint, e.g. a Gmail
// or Google Calendar MCP). We discover its tools, and skills propose tool calls
// that run ONLY after approval (see crm/approvals.ts). Secrets (tokens) live in
// the encrypted secret store, never here. Connections are made on-demand and
// closed — we don't hold long-lived child processes.

import { getDB } from './database'
import { deleteSecretsByPrefix, getSecret } from './secrets'
import { makeOAuthProvider, ensureLoopback, hasOAuthTokens } from './mcp-oauth'
import { cancelOAuthAuthorization } from './mcp-oauth-cancellation'
import { callHook, HOOKS } from './bootstrap/hookRegistry'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Provider-specific quirks (e.g. Google's MCP endpoints) are a Pro concern and
// register these hooks; in the free build they return undefined → generic MCP.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const googleConfigForUrl = (url: string | null): any => callHook('mcp:googleConfig', url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const googleProbeTool = (url: string | null): any => callHook('mcp:googleProbeTool', url)
const googleQuotaProject = (url: string | null): string | undefined =>
  callHook('mcp:googleQuotaProject', url)

export interface ConnectorToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface ConnectorToolCallResult {
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * A provider-owned connector can verify through its supported protocol while keeping generic MCP
 * discovery disabled. The provider owns execution too, so a published REST-backed tool never falls
 * through to an unavailable preview MCP endpoint.
 */
export interface ConnectorToolSource {
  tools: ConnectorToolDefinition[]
  verify: () => Promise<void>
  callTool: (tool: string, args: unknown) => Promise<ConnectorToolCallResult>
}

let ready = false
function ensure(): void {
  if (ready) return
  getDB().exec(
    `CREATE TABLE IF NOT EXISTS connectors (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       transport TEXT NOT NULL,          -- 'stdio' | 'http'
       command TEXT,                     -- stdio: executable
       args TEXT,                        -- stdio: JSON string[]
       env_keys TEXT,                    -- JSON string[] of secret keys to inject as env
       url TEXT,                         -- http: endpoint
       enabled INTEGER NOT NULL DEFAULT 1,
       status TEXT NOT NULL DEFAULT 'unknown', -- unknown | ok | error
       status_detail TEXT,
       tools TEXT,                       -- JSON [{name, description}] discovered
       created_at INTEGER NOT NULL DEFAULT 0
     )`
  )
  ready = true
}

export interface Connector {
  id: number
  name: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string | null
  env_keys: string | null
  url: string | null
  enabled: number
  status: string
  status_detail: string | null
  tools: string | null
  created_at: number
}

export interface NewConnector {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  envKeys?: string[] // names of secrets to inject as env vars
  url?: string
}

export function listConnectors(): Connector[] {
  ensure()
  return getDB().prepare('SELECT * FROM connectors ORDER BY created_at DESC').all() as Connector[]
}

export function addConnector(c: NewConnector): number {
  ensure()
  const info = getDB()
    .prepare(
      `INSERT INTO connectors (name, transport, command, args, env_keys, url, enabled, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'unknown', ?)`
    )
    .run(
      c.name,
      c.transport,
      c.command ?? null,
      c.args ? JSON.stringify(c.args) : null,
      c.envKeys ? JSON.stringify(c.envKeys) : null,
      c.url ?? null,
      Date.now()
    )
  return Number(info.lastInsertRowid)
}

export function setConnectorEnabled(id: number, enabled: boolean): void {
  ensure()
  getDB()
    .prepare('UPDATE connectors SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, id)
}

/** Single writer for a connector's health status — so testConnector and the chat
 *  tool loader can't diverge on how a failure is recorded. When a background load
 *  can't reach a connector (expired token / server down), this flips its status to
 *  'error' so the UI shows it needs reconnecting instead of silently going dark. */
export function setConnectorStatus(
  id: number,
  status: 'ok' | 'error' | 'unknown',
  detail?: string | null
): void {
  ensure()
  getDB()
    .prepare('UPDATE connectors SET status = ?, status_detail = ? WHERE id = ?')
    .run(status, detail ?? null, id)
}

export function removeConnector(id: number): void {
  ensure()
  cancelOAuthAuthorization(id)
  const database = getDB()
  database.transaction(() => {
    deleteSecretsByPrefix(`connector:${id}:`)
    database.prepare('DELETE FROM connectors WHERE id = ?').run(id)
  })()
}

function getConnector(id: number): Connector | undefined {
  ensure()
  return getDB().prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector | undefined
}

function connectorToolSource(c: Connector): ConnectorToolSource | undefined {
  return callHook<ConnectorToolSource>(HOOKS.mcpConnectorToolSource, c.id, c.url)
}

// Build a connected MCP client for a connector. Caller MUST close().
// interactive=true (a user-initiated Test/Connect) permits the browser OAuth
// dance; interactive=false (background tool call) uses saved tokens silently and
// fails fast if authorization is missing.
async function connect(
  c: Connector,
  interactive: boolean
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  let client = new Client({ name: 'Off Grid AI Desktop', version: '1.0.0' }, { capabilities: {} })

  if (c.transport === 'stdio') {
    if (!c.command) throw new Error('stdio connector missing command')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const env: Record<string, string> = {}
    for (const k of c.env_keys ? (JSON.parse(c.env_keys) as string[]) : []) {
      const v = getSecret(`connector:${c.id}:${k}`)
      if (v) env[k] = v
    }
    const transport = new StdioClientTransport({
      command: c.command,
      args: c.args ? (JSON.parse(c.args) as string[]) : [],
      env: { ...process.env, ...env } as Record<string, string>
    })
    await client.connect(transport)
    return {
      client,
      close: async () => {
        try {
          await client.close()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // HTTP — with OAuth (uses saved tokens; on 401 runs the browser flow if allowed).
  if (!c.url) throw new Error('http connector missing url')
  const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
  // Google MCP endpoints (first-party, no DCR) use our shipped OAuth client +
  // pinned read scope; everything else uses dynamic client registration.
  const authProvider = makeOAuthProvider(c.id, googleConfigForUrl(c.url) ?? undefined, interactive)
  const url = new URL(c.url)
  // Endpoints ending in /sse use the (legacy) SSE transport; everything else uses
  // the current Streamable HTTP transport. Both support OAuth + finishAuth.
  const isSSE = /\/sse\/?$/.test(url.pathname)
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
  // Google MCPs are Cloud APIs → need the x-goog-user-project quota-project header
  // on every request (in addition to the bearer token the authProvider supplies).
  const quotaProject = googleQuotaProject(c.url)
  const requestInit = quotaProject
    ? { headers: { 'x-goog-user-project': quotaProject } }
    : undefined
  const mkTransport = (): SSEClientTransport | StreamableHTTPClientTransport =>
    isSSE
      ? new SSEClientTransport(url, { authProvider, requestInit })
      : new StreamableHTTPClientTransport(url, { authProvider, requestInit })
  let transport = mkTransport()
  if (!interactive) {
    // Background path: only saved tokens, never a browser.
    try {
      await client.connect(transport)
    } catch (e) {
      if (e instanceof UnauthorizedError)
        throw new Error('Authorization required — open Integrations and click Test to sign in.')
      throw e
    }
  } else {
    // Interactive: the persistent loopback catches the redirect by state. Start it
    // up front so it's bound even for an instant skip-consent redirect.
    ensureLoopback()
    // A stored dynamic-client registration can expire server-side (Attio returns
    // "invalid_client: Client registration has expired; please re-register").
    // When we're about to do a FRESH interactive auth (no usable token), drop any
    // stale client so the SDK re-registers cleanly instead of resending a dead
    // client_id. (Google uses a fixed client — never clear it.)
    if (!googleConfigForUrl(c.url) && !hasOAuthTokens(c.id)) {
      authProvider.invalidateCredentials('client')
    }
    // Runs the OAuth handshake after the SDK opened the browser: wait for the code,
    // exchange it (saves tokens), reconnect with a fresh client + transport.
    const finishOAuth = async (): Promise<void> => {
      const code = await authProvider.getCodePromise()
      console.log('[oauth] got code, exchanging for tokens…')
      await transport.finishAuth(code)
      console.log(
        '[oauth] token exchange done; tokens saved =',
        authProvider.tokens() ? 'yes' : 'NO'
      )
      client = new Client({ name: 'Off Grid AI Desktop', version: '1.0.0' }, { capabilities: {} })
      transport = mkTransport()
      await client.connect(transport)
    }
    try {
      await client.connect(transport)
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e
      await finishOAuth() // server required auth on initialize (Notion/Linear/…)
    }
    // Some first-party servers (Google) allow UNAUTH initialize, so connect() never
    // 401s and the token flow never starts. If we still have no token, force it
    // with a probe tool call that DOES require auth → 401 → OAuth → finishAuth.
    const probe = googleProbeTool(c.url)
    if (probe && !hasOAuthTokens(c.id)) {
      try {
        await client.callTool({ name: probe, arguments: {} })
      } catch (e) {
        if (e instanceof UnauthorizedError) await finishOAuth()
        else throw e
      }
    }
  }
  return {
    client,
    close: async () => {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Connect, list tools, cache them + status. Returns the discovered tools. */
export async function testConnector(
  id: number
): Promise<{ ok: boolean; tools: { name: string; description?: string }[]; error?: string }> {
  ensure()
  const c = getConnector(id)
  if (!c) return { ok: false, tools: [], error: 'not found' }
  try {
    const source = connectorToolSource(c)
    let tools: ConnectorToolDefinition[]
    if (source) {
      // A fresh account still needs the existing interactive OAuth handshake. Once tokens exist,
      // provider verification must not touch a preview-gated MCP endpoint.
      if (!hasOAuthTokens(c.id)) {
        const session = await connect(c, true)
        await session.close()
      }
      await source.verify()
      tools = source.tools
    } else {
      const { client, close } = await connect(c, true) // user-initiated → allow browser OAuth
      try {
        const res = await client.listTools()
        tools = res.tools.map((tool) => ({
          name: tool.name,
          description: tool.description
        }))
      } finally {
        await close()
      }
    }
    getDB()
      .prepare("UPDATE connectors SET status='ok', status_detail=NULL, tools=? WHERE id=?")
      .run(JSON.stringify(tools), id)
    return { ok: true, tools }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    setConnectorStatus(id, 'error', msg)
    return { ok: false, tools: [], error: msg }
  }
}

// A background tool load must never hang the chat turn it runs inside: one dead or
// unreachable connector (no server / stalled OAuth) would otherwise block every
// send. Bound each connect+list; on timeout the caller drops that connector's tools
// (and marks it errored) and the turn proceeds.
export const FETCH_TOOLS_TIMEOUT_MS = 8000

/** Full tool definitions (incl. inputSchema) for a connected connector. Rejects if
 *  the connect+list exceeds FETCH_TOOLS_TIMEOUT_MS. */
export async function fetchTools(id: number): Promise<ConnectorToolDefinition[]> {
  ensure()
  const c = getConnector(id)
  if (!c) throw new Error('connector not found')
  const op = (async (): Promise<ConnectorToolDefinition[]> => {
    const source = connectorToolSource(c)
    if (source) return [...source.tools]
    const { client, close } = await connect(c, false)
    try {
      const res = await client.listTools()
      return res.tools as ConnectorToolDefinition[]
    } finally {
      await close()
    }
  })()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`listing tools for ${c.name} timed out`)),
      FETCH_TOOLS_TIMEOUT_MS
    )
    timer.unref()
  })
  try {
    return await Promise.race([op, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

export function getConnectorMeta(
  id: number
): { id: number; name: string; url: string | null } | undefined {
  const c = getConnector(id)
  return c ? { id: c.id, name: c.name, url: c.url ?? null } : undefined
}

/**
 * Resolve a persisted connector reference through the connector repository.
 *
 * New approval rows store connector_id directly. This resolver keeps approvals created by older
 * builds executable when their `connector` field contains either the former numeric string or the
 * human-facing connector name. Callers do not need to know how connectors are persisted.
 */
export function resolveConnectorId(reference: string | null | undefined): number | undefined {
  if (!reference) return undefined
  const numericId = Number(reference)
  if (Number.isSafeInteger(numericId) && numericId > 0 && getConnector(numericId)) return numericId
  return listConnectors().find(
    (connector) =>
      connector.name.localeCompare(reference, undefined, { sensitivity: 'accent' }) === 0
  )?.id
}

/**
 * Open ONE connection (one stdio process / one HTTP session) and run multiple
 * tool calls over it. Essential for multi-step adapters (e.g. Slack: users →
 * channels → history) — otherwise each call would cold-spawn npx and hang.
 */
export async function withConnector<T>(
  id: number,
  fn: (
    call: (
      tool: string,
      args: unknown
    ) => Promise<{ ok: boolean; result?: unknown; error?: string }>
  ) => Promise<T>
): Promise<T> {
  ensure()
  const c = getConnector(id)
  if (!c) throw new Error('connector not found')
  if (!c.enabled) throw new Error('connector disabled')
  const { client, close } = await connect(c, false)
  try {
    const call = async (
      tool: string,
      args: unknown
    ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
      try {
        const result = await client.callTool({
          name: tool,
          arguments: (args ?? {}) as Record<string, unknown>
        })
        return { ok: true, result }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    return await fn(call)
  } finally {
    await close()
  }
}

/** Call a tool on a connector (used by the approval-execution path). */
export async function callConnectorTool(
  id: number,
  tool: string,
  args: unknown
): Promise<ConnectorToolCallResult> {
  ensure()
  const c = getConnector(id)
  if (!c) return { ok: false, error: 'connector not found' }
  if (!c.enabled) return { ok: false, error: 'connector disabled' }
  try {
    const source = connectorToolSource(c)
    if (source) return await source.callTool(tool, args)
    const { client, close } = await connect(c, false) // background → saved tokens only
    const result = await client.callTool({
      name: tool,
      arguments: (args ?? {}) as Record<string, unknown>
    })
    await close()
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
