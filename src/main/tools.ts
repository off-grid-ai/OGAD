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

// --- Tool extensions (open-core seam) --------------------------------------
// Pro features (e.g. MCP connectors) plug extra tools into the chat loop without
// core ever importing them. A pro extension registers itself during activation;
// in the free build nothing is registered and toolChat uses only the built-ins.
// Mirrors mobile/src/services/tools/extensions.ts.
export interface ToolExtension {
  id: string;
  /** OpenAI tool schemas to add when extensions are enabled. Built once per turn;
   *  the extension may cache any per-turn state it needs for execute(). */
  schemas(): Promise<unknown[]> | unknown[];
  /** Whether this extension owns a given tool name. */
  canHandle(name: string): boolean;
  /** Execute a call this extension owns; returns a string result for the model. */
  execute(name: string, args: Record<string, unknown>): Promise<string> | string;
  /** Optional system-prompt addition when this extension contributes tools. */
  systemHint?(): string;
}

const toolExtensions: ToolExtension[] = [];
export function registerToolExtension(ext: ToolExtension): void {
  if (!toolExtensions.some((e) => e.id === ext.id)) toolExtensions.push(ext);
}
export function getToolExtensions(): ToolExtension[] {
  return toolExtensions;
}

export type ToolCall = { name: string; args: Record<string, unknown>; result: string };

/** Run a chat turn with tool-calling. Returns the final answer + the calls made. */
export async function toolChat(
  query: string,
  history: { role: string; content: string }[] = [],
  opts: { connectors?: boolean } = {},
): Promise<{ answer: string; toolCalls: ToolCall[] }> {
  await llm.init(); // respects pause; ensures the server is up

  // Opt-in: pull in tools from registered pro extensions (e.g. MCP connectors)
  // alongside the built-ins. Schemas are built once per turn; each extension
  // caches whatever per-turn state it needs for execute(). Free build registers
  // no extensions, so this is just the built-ins.
  const exts = opts.connectors ? getToolExtensions() : [];
  const extSchemas: unknown[] = [];
  const hints: string[] = [];
  for (const e of exts) {
    try {
      const s = await e.schemas();
      if (s && s.length) {
        extSchemas.push(...s);
        if (e.systemHint) hints.push(e.systemHint());
      }
    } catch (err) { console.error('[tools] extension schemas', e.id, err); }
  }
  const tools = extSchemas.length ? [...schemas(), ...extSchemas] : schemas();
  const sys = 'You are Off Grid, a private on-device assistant. Use the provided tools when they help answer precisely. Keep answers concise.'
    + (hints.length ? ' ' + hints.join(' ') : '');

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
        const ext = exts.find((e) => e.canHandle(c.function.name));
        const result = ext
          ? await ext.execute(c.function.name, args)
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
