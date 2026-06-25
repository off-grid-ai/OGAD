// MCP connectors — Off Grid acts as an MCP *client*. Each connector is an MCP
// server the user authorizes (stdio command or HTTP/SSE endpoint, e.g. a Gmail
// or Google Calendar MCP). We discover its tools, and skills propose tool calls
// that run ONLY after approval (see crm/approvals.ts). Secrets (tokens) live in
// the encrypted secret store, never here. Connections are made on-demand and
// closed — we don't hold long-lived child processes.

import { getDB } from './database';
import { getSecret } from './secrets';
import { makeOAuthProvider, ensureLoopback, hasOAuthTokens } from './mcp-oauth';
import { callHook } from './bootstrap/hookRegistry';

// Provider-specific quirks (e.g. Google's MCP endpoints) are a Pro concern and
// register these hooks; in the free build they return undefined → generic MCP.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const googleConfigForUrl = (url: string | null): any => callHook('mcp:googleConfig', url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const googleProbeTool = (url: string | null): any => callHook('mcp:googleProbeTool', url);
const googleQuotaProject = (url: string | null): string | undefined => callHook('mcp:googleQuotaProject', url);

let ready = false;
function ensure(): void {
  if (ready) return;
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
  );
  ready = true;
}

export interface Connector {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string | null;
  env_keys: string | null;
  url: string | null;
  enabled: number;
  status: string;
  status_detail: string | null;
  tools: string | null;
  created_at: number;
}

export interface NewConnector {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  envKeys?: string[]; // names of secrets to inject as env vars
  url?: string;
}

export function listConnectors(): Connector[] {
  ensure();
  return getDB().prepare('SELECT * FROM connectors ORDER BY created_at DESC').all() as Connector[];
}

export function addConnector(c: NewConnector): number {
  ensure();
  const info = getDB()
    .prepare(
      `INSERT INTO connectors (name, transport, command, args, env_keys, url, enabled, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'unknown', ?)`
    )
    .run(c.name, c.transport, c.command ?? null, c.args ? JSON.stringify(c.args) : null, c.envKeys ? JSON.stringify(c.envKeys) : null, c.url ?? null, Date.now());
  return Number(info.lastInsertRowid);
}

export function setConnectorEnabled(id: number, enabled: boolean): void {
  ensure();
  getDB().prepare('UPDATE connectors SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function removeConnector(id: number): void {
  ensure();
  getDB().prepare('DELETE FROM connectors WHERE id = ?').run(id);
}

function getConnector(id: number): Connector | undefined {
  ensure();
  return getDB().prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Connector | undefined;
}

// Build a connected MCP client for a connector. Caller MUST close().
// interactive=true (a user-initiated Test/Connect) permits the browser OAuth
// dance; interactive=false (background tool call) uses saved tokens silently and
// fails fast if authorization is missing.
async function connect(c: Connector, interactive: boolean): Promise<{ client: any; close: () => Promise<void> }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  let client = new Client({ name: 'Off Grid AI Desktop', version: '1.0.0' }, { capabilities: {} });

  if (c.transport === 'stdio') {
    if (!c.command) throw new Error('stdio connector missing command');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const env: Record<string, string> = {};
    for (const k of c.env_keys ? (JSON.parse(c.env_keys) as string[]) : []) {
      const v = getSecret(`connector:${c.id}:${k}`);
      if (v) env[k] = v;
    }
    const transport = new StdioClientTransport({
      command: c.command,
      args: c.args ? (JSON.parse(c.args) as string[]) : [],
      env: { ...process.env, ...env } as Record<string, string>,
    });
    await client.connect(transport);
    return { client, close: async () => { try { await client.close(); } catch { /* ignore */ } } };
  }

  // HTTP — with OAuth (uses saved tokens; on 401 runs the browser flow if allowed).
  if (!c.url) throw new Error('http connector missing url');
  const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js');
  // Google MCP endpoints (first-party, no DCR) use our shipped OAuth client +
  // pinned read scope; everything else uses dynamic client registration.
  const authProvider = makeOAuthProvider(c.id, googleConfigForUrl(c.url) ?? undefined, interactive);
  const url = new URL(c.url);
  // Endpoints ending in /sse use the (legacy) SSE transport; everything else uses
  // the current Streamable HTTP transport. Both support OAuth + finishAuth.
  const isSSE = /\/sse\/?$/.test(url.pathname);
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  // Google MCPs are Cloud APIs → need the x-goog-user-project quota-project header
  // on every request (in addition to the bearer token the authProvider supplies).
  const quotaProject = googleQuotaProject(c.url);
  const requestInit = quotaProject ? { headers: { 'x-goog-user-project': quotaProject } } : undefined;
  const mkTransport = (): any =>
    isSSE
      ? new SSEClientTransport(url, { authProvider, requestInit })
      : new StreamableHTTPClientTransport(url, { authProvider, requestInit });
  let transport = mkTransport();
  if (!interactive) {
    // Background path: only saved tokens, never a browser.
    try {
      await client.connect(transport);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new Error('Authorization required — open Integrations and click Test to sign in.');
      throw e;
    }
  } else {
    // Interactive: the persistent loopback catches the redirect by state. Start it
    // up front so it's bound even for an instant skip-consent redirect.
    ensureLoopback();
    // Runs the OAuth handshake after the SDK opened the browser: wait for the code,
    // exchange it (saves tokens), reconnect with a fresh client + transport.
    const finishOAuth = async (): Promise<void> => {
      const code = await authProvider.getCodePromise();
      console.log('[oauth] got code, exchanging for tokens…');
      await transport.finishAuth(code);
      console.log('[oauth] token exchange done; tokens saved =', authProvider.tokens() ? 'yes' : 'NO');
      client = new Client({ name: 'Off Grid AI Desktop', version: '1.0.0' }, { capabilities: {} });
      transport = mkTransport();
      await client.connect(transport);
    };
    try {
      await client.connect(transport);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      await finishOAuth(); // server required auth on initialize (Notion/Linear/…)
    }
    // Some first-party servers (Google) allow UNAUTH initialize, so connect() never
    // 401s and the token flow never starts. If we still have no token, force it
    // with a probe tool call that DOES require auth → 401 → OAuth → finishAuth.
    const probe = googleProbeTool(c.url);
    if (probe && !hasOAuthTokens(c.id)) {
      try {
        await client.callTool({ name: probe, arguments: {} });
      } catch (e) {
        if (e instanceof UnauthorizedError) await finishOAuth();
        else throw e;
      }
    }
  }
  return { client, close: async () => { try { await client.close(); } catch { /* ignore */ } } };
}

/** Connect, list tools, cache them + status. Returns the discovered tools. */
export async function testConnector(id: number): Promise<{ ok: boolean; tools: { name: string; description?: string }[]; error?: string }> {
  ensure();
  const c = getConnector(id);
  if (!c) return { ok: false, tools: [], error: 'not found' };
  try {
    const { client, close } = await connect(c, true); // user-initiated → allow browser OAuth
    const res = await client.listTools();
    const tools = (res.tools ?? []).map((t: any) => ({ name: t.name, description: t.description }));
    await close();
    getDB().prepare("UPDATE connectors SET status='ok', status_detail=NULL, tools=? WHERE id=?").run(JSON.stringify(tools), id);
    return { ok: true, tools };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    getDB().prepare("UPDATE connectors SET status='error', status_detail=? WHERE id=?").run(msg, id);
    return { ok: false, tools: [], error: msg };
  }
}

/** Full tool definitions (incl. inputSchema) for a connected connector. */
export async function fetchTools(id: number): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
  ensure();
  const c = getConnector(id);
  if (!c) throw new Error('connector not found');
  const { client, close } = await connect(c, false);
  try {
    const res = await client.listTools();
    return (res.tools ?? []) as { name: string; description?: string; inputSchema?: unknown }[];
  } finally {
    await close();
  }
}

export function getConnectorMeta(id: number): { id: number; name: string; url: string | null } | undefined {
  const c = getConnector(id);
  return c ? { id: c.id, name: c.name, url: c.url ?? null } : undefined;
}

/**
 * Open ONE connection (one stdio process / one HTTP session) and run multiple
 * tool calls over it. Essential for multi-step adapters (e.g. Slack: users →
 * channels → history) — otherwise each call would cold-spawn npx and hang.
 */
export async function withConnector<T>(
  id: number,
  fn: (call: (tool: string, args: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>) => Promise<T>
): Promise<T> {
  ensure();
  const c = getConnector(id);
  if (!c) throw new Error('connector not found');
  if (!c.enabled) throw new Error('connector disabled');
  const { client, close } = await connect(c, false);
  try {
    const call = async (tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
      try {
        const result = await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    return await fn(call);
  } finally {
    await close();
  }
}

/** Call a tool on a connector (used by the approval-execution path). */
export async function callConnectorTool(id: number, tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  ensure();
  const c = getConnector(id);
  if (!c) return { ok: false, error: 'connector not found' };
  if (!c.enabled) return { ok: false, error: 'connector disabled' };
  try {
    const { client, close } = await connect(c, false); // background → saved tokens only
    const result = await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
    await close();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
