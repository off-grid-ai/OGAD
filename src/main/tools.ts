// Agentic tool-calling loop for the Off Grid chat. Kept ISOLATED from the
// default rag:chat path (opt-in) so a tool run can never break normal chat.
//
// The local model (llama-server, OpenAI-compatible /v1/chat/completions) is given
// tool schemas; we parse its tool_calls, run them on-device, feed results back,
// and loop until it answers. Built-in tools only (no network) for now — web
// search + MCP connectors plug in here later.

import { llm } from './llm';

const PORT = 8439;

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
    name: 'get_datetime',
    description: 'Get the current local date and time.',
    parameters: { type: 'object', properties: {} },
    run: () => new Date().toString(),
  },
];

function schemas(): unknown[] {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

async function execute(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return `Error: unknown tool ${name}`;
  try { return String(await tool.run(args)); } catch (e) { return `Error: ${(e as Error).message}`; }
}

export type ToolCall = { name: string; args: Record<string, unknown>; result: string };

/** Run a chat turn with tool-calling. Returns the final answer + the calls made. */
export async function toolChat(
  query: string,
  history: { role: string; content: string }[] = [],
): Promise<{ answer: string; toolCalls: ToolCall[] }> {
  await llm.init(); // respects pause; ensures the server is up
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    { role: 'system', content: 'You are Off Grid, a private on-device assistant. Use the provided tools when they help answer precisely. Keep answers concise.' },
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: query },
  ];
  const toolCalls: ToolCall[] = [];

  for (let step = 0; step < 5; step++) {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools: schemas(), tool_choice: 'auto', temperature: 0.3, max_tokens: 1024 }),
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
        const result = await execute(c.function.name, args);
        toolCalls.push({ name: c.function.name, args, result });
        messages.push({ role: 'tool', tool_call_id: c.id, content: result });
      }
      continue; // let the model use the results
    }
    return { answer: (msg.content || '').trim(), toolCalls };
  }
  return { answer: 'Stopped after too many tool steps.', toolCalls };
}

/** Names + descriptions of available tools (for the picker UI). */
export function listTools(): { name: string; description: string }[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description }));
}
