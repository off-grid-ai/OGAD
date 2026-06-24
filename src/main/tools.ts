// Agentic tool-calling loop for the Off Grid chat. Kept ISOLATED from the
// default rag:chat path (opt-in) so a tool run can never break normal chat.
//
// The local model (llama-server, OpenAI-compatible /v1/chat/completions) is given
// tool schemas; we parse its tool_calls, run them on-device, feed results back,
// and loop until it answers. Built-in tools only (no network) for now — web
// search + MCP connectors plug in here later.

import { llm } from './llm';
import { getSetting, saveSetting } from './database';

const PORT = 8439;

// Per-tool enable/disable, persisted as a list of disabled tool names.
function disabledSet(): Set<string> {
  try { return new Set(getSetting<string[]>('disabledTools', [])); } catch { return new Set(); }
}
export function setToolEnabled(name: string, enabled: boolean): void {
  const set = disabledSet();
  if (enabled) set.delete(name); else set.add(name);
  saveSetting('disabledTools', Array.from(set));
}

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string> | string;
};

// --- HTML helpers for the web tools (no deps, no analytics) -----------------
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
function htmlToText(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, '\n');
  return decodeEntities(body.replace(/<[^>]*>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
// Fetch a URL and return its readable text (shared by the read_url tool and the
// deterministic "read this URL, then build" flow). Works for localhost too.
export async function readUrlText(url: string): Promise<string> {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return htmlToText(await res.text());
}

// DuckDuckGo wraps result links in a redirect: //duckduckgo.com/l/?uddg=<encoded>
function decodeDdgHref(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith('//') ? 'https:' + href : href;
}

// --- Built-in tools --------------------------------------------------------
const TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    description: 'Search the web via DuckDuckGo and return the top results (title, URL, snippet). Use for current events or facts not in the user\'s memory. Requires network.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'the search query' } }, required: ['query'] },
    run: async (a) => {
      const q = String(a.query ?? '').trim();
      if (!q) return 'Error: empty query.';
      try {
        const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await res.text();
        const titles: { title: string; url: string }[] = [];
        const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && titles.length < 6) titles.push({ url: decodeDdgHref(m[1]), title: stripTags(m[2]) });
        const snippets: string[] = [];
        const sre = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let s: RegExpExecArray | null;
        while ((s = sre.exec(html)) && snippets.length < 6) snippets.push(stripTags(s[1]));
        if (!titles.length) return 'No results found.';
        return titles.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${snippets[i] || ''}`).join('\n');
      } catch (e) { return 'Error: search failed — ' + (e as Error).message; }
    },
  },
  {
    name: 'brave_search',
    description: 'Search the web via Brave and return the top results (title, URL). An alternative to web_search. Requires network.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'the search query' } }, required: ['query'] },
    run: async (a) => {
      const q = String(a.query ?? '').trim();
      if (!q) return 'Error: empty query.';
      try {
        const res = await fetch('https://search.brave.com/search?q=' + encodeURIComponent(q) + '&source=web', {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        const html = await res.text();
        const out: { title: string; url: string }[] = [];
        const seen = new Set<string>();
        const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && out.length < 6) {
          const url = m[1];
          if (/brave\.com|search\.brave|\/settings|javascript:/i.test(url)) continue;
          const title = stripTags(m[2]);
          if (!title || title.length < 3 || seen.has(url)) continue;
          seen.add(url);
          out.push({ title, url });
        }
        if (!out.length) return 'No results found (Brave markup may have changed — try web_search).';
        return out.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n');
      } catch (e) { return 'Error: brave search failed — ' + (e as Error).message; }
    },
  },
  {
    name: 'read_url',
    description: 'Fetch a web page and return its readable text. Use to read a specific URL (e.g. one from web_search). Requires network.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'the page URL' } }, required: ['url'] },
    run: async (a) => {
      let url = String(a.url ?? '').trim();
      if (!url) return 'Error: empty url.';
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) return `Error: HTTP ${res.status}`;
        const text = htmlToText(await res.text());
        return text ? text.slice(0, 6000) : 'No readable text on the page.';
      } catch (e) { return 'Error: could not fetch — ' + (e as Error).message; }
    },
  },
  {
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression and return the numeric result.',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. "(3+4)*2/7"' } }, required: ['expression'] },
    run: (a) => {
      const expr = String(a.expression ?? '');
      if (!/^[-+*/().\d\s]+$/.test(expr)) return 'Error: only basic arithmetic is allowed.';
      try {
        // eslint-disable-next-line no-new-func
        const v = Function(`"use strict"; return (${expr})`)();
        return String(v);
      } catch {
        return 'Error: could not evaluate expression.';
      }
    },
  },
  {
    name: 'read_screen',
    description: "Read what's recently been on the user's screen (the latest captured activity). Fully local, no network. Use to answer questions about what the user was just looking at.",
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'how many recent items (default 5)' } } },
    run: async (a) => {
      try {
        const { getDB } = await import('./database');
        const db = getDB();
        const n = Math.min(20, Math.max(1, Number(a.limit) || 5));
        const rows = db.prepare(
          `SELECT summary, surface, surface_app, ts FROM observations
           WHERE COALESCE(surface_app,'') NOT LIKE '%Off Grid%' AND COALESCE(surface_app,'') NOT LIKE '%Electron%'
           ORDER BY ts DESC LIMIT ?`
        ).all(n) as { summary: string; surface: string | null; surface_app: string | null; ts: string }[];
        if (!rows.length) return 'No recent screen activity captured.';
        return rows.map((r) => `(${r.surface || r.surface_app || 'screen'} · ${r.ts}) ${r.summary}`).join('\n');
      } catch (e) { return 'Error reading screen: ' + (e as Error).message; }
    },
  },
  {
    name: 'get_datetime',
    description: 'Get the current local date and time.',
    parameters: { type: 'object', properties: {} },
    run: () => new Date().toString(),
  },
];

function schemas(): unknown[] {
  const off = disabledSet();
  return TOOLS.filter((t) => !off.has(t.name)).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

async function execute(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Error: unknown tool ${name}`;
  try { return String(await tool.run(args)); } catch (e) { return `Error: ${(e as Error).message}`; }
}

// --- MCP connector tools (opt-in) ------------------------------------------
// Connector tools are exposed to the model namespaced as `mcp__<id>__<tool>`.
// Read-only tools run inline; anything mutating is routed to the approval queue
// (nothing external is executed without the user's explicit OK).
function isConnectorActionTool(tool: string): boolean {
  return !/^(list|get|search|read|fetch|whoami|describe)[_-]/i.test(tool);
}
const MCP_PREFIX = 'mcp__';

type ConnectorToolCtx = {
  schemas: unknown[];
  byName: Map<string, { id: number; tool: string; connector: string }>;
};

async function buildConnectorTools(): Promise<ConnectorToolCtx> {
  const ctx: ConnectorToolCtx = { schemas: [], byName: new Map() };
  try {
    const { listConnectors, fetchTools } = await import('./mcp');
    const enabled = listConnectors().filter((c) => c.enabled);
    for (const c of enabled) {
      let tools: { name: string; description?: string; inputSchema?: unknown }[] = [];
      try { tools = await fetchTools(c.id); } catch (e) { console.error('[tools] fetchTools', c.name, e); continue; }
      for (const t of tools) {
        const fnName = `${MCP_PREFIX}${c.id}__${t.name}`;
        ctx.byName.set(fnName, { id: c.id, tool: t.name, connector: c.name });
        const action = isConnectorActionTool(t.name);
        ctx.schemas.push({
          type: 'function',
          function: {
            name: fnName,
            description: `[${c.name}] ${t.description ?? t.name}${action ? ' (requires the user to approve before it runs)' : ''}`,
            parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          },
        });
      }
    }
  } catch (e) {
    console.error('[tools] buildConnectorTools', e);
  }
  return ctx;
}

async function executeConnector(
  fnName: string,
  args: Record<string, unknown>,
  ctx: ConnectorToolCtx,
): Promise<string> {
  const meta = ctx.byName.get(fnName);
  if (!meta) return `Error: unknown connector tool ${fnName}`;
  // Mutating tool → propose for approval instead of executing.
  if (isConnectorActionTool(meta.tool)) {
    try {
      const { proposeApproval } = await import('./crm/approvals');
      proposeApproval({
        title: `${meta.tool} via ${meta.connector}`,
        detail: `Requested from chat. Arguments: ${JSON.stringify(args)}`,
        connector: meta.connector,
        tool: meta.tool,
        args,
        source: 'chat',
      });
      return `Queued for the user's approval — "${meta.tool}" on ${meta.connector} will run only after they approve it in the Approvals queue. Do not assume it has happened; tell the user it's pending approval.`;
    } catch (e) {
      return `Error queuing approval: ${(e as Error).message}`;
    }
  }
  // Read-only tool → run inline.
  try {
    const { callConnectorTool } = await import('./mcp');
    const r = await callConnectorTool(meta.id, meta.tool, args);
    if (!r.ok) return `Error: ${r.error ?? 'connector call failed'}`;
    const out = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
    return out.length > 8000 ? out.slice(0, 8000) + '… (truncated)' : out;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

export type ToolCall = { name: string; args: Record<string, unknown>; result: string };

/** Run a chat turn with tool-calling. Returns the final answer + the calls made. */
export async function toolChat(
  query: string,
  history: { role: string; content: string }[] = [],
  opts: { connectors?: boolean } = {},
): Promise<{ answer: string; toolCalls: ToolCall[] }> {
  await llm.init(); // respects pause; ensures the server is up

  // Opt-in: expose enabled MCP connector tools alongside the built-ins. Built
  // once per turn (each fetchTools opens a connection) and reused every step.
  const conn = opts.connectors ? await buildConnectorTools() : null;
  const tools = conn && conn.schemas.length ? [...schemas(), ...conn.schemas] : schemas();
  const sys = conn && conn.schemas.length
    ? 'You are Off Grid, a private on-device assistant. Use the provided tools when they help answer precisely. Connector tools that change anything (send, create, update, delete, etc.) are NOT executed directly — calling them queues the action for the user to approve, so never claim such an action is done. Keep answers concise.'
    : 'You are Off Grid, a private on-device assistant. Use the provided tools when they help answer precisely. Keep answers concise.';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    { role: 'system', content: sys },
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: query },
  ];
  const toolCalls: ToolCall[] = [];

  for (let step = 0; step < 5; step++) {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools, tool_choice: 'auto', temperature: 0.3, max_tokens: 1024 }),
    });
    if (!res.ok) throw new Error(`tool chat failed: ${res.status}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('no response');
    messages.push(msg);

    const calls = msg.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;
    if (calls && calls.length) {
      for (const c of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* keep empty */ }
        const result = c.function.name.startsWith(MCP_PREFIX) && conn
          ? await executeConnector(c.function.name, args, conn)
          : await execute(c.function.name, args);
        toolCalls.push({ name: c.function.name, args, result });
        messages.push({ role: 'tool', tool_call_id: c.id, content: result });
      }
      continue; // let the model use the results
    }
    return { answer: (msg.content || '').trim(), toolCalls };
  }
  return { answer: 'Stopped after too many tool steps.', toolCalls };
}

/** Names + descriptions + enabled state of all tools (for the settings UI). */
export function listTools(): { name: string; description: string; enabled: boolean }[] {
  const off = disabledSet();
  return TOOLS.map((t) => ({ name: t.name, description: t.description, enabled: !off.has(t.name) }));
}
