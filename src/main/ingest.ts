// Connector ingestion — pull recent items from an authorized MCP connector and
// turn them into observations in the SAME memory the screen capture feeds, tagged
// with the connector as their surface so they're viewable per-source (and flow
// into Day / Reflect / Actions / search). First cut: pick a read/search tool,
// call it, distill the results into observations with the local model.

import { BrowserWindow } from 'electron';
import { llm } from './llm';
import { getDB } from './database';
import { fetchTools, getConnectorMeta, callConnectorTool, withConnector, listConnectors } from './mcp';
import { googleCalendarEvents, googleGmailMessages, senderName } from './google-rest';
import { upsertUpcomingEvents } from './crm/calendar';
import { recordObservation } from './crm/observations';

let ready = false;
function ensureCols(): void {
  if (ready) return;
  for (const ddl of [
    'ALTER TABLE connectors ADD COLUMN last_synced INTEGER',
    'ALTER TABLE connectors ADD COLUMN synced_count INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      getDB().exec(ddl);
    } catch {
      /* column exists */
    }
  }
  ready = true;
}

function emitChanged(): void {
  try {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('crm:changed'));
  } catch {
    /* ignore */
  }
}

function extractJson(s: string): string {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : '{}';
}

// MCP tool results carry a `content` array of {type:'text', text} blocks.
function resultToText(result: unknown, max = 8000): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (result as any)?.content;
  const full = Array.isArray(c)
    ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? JSON.stringify(x))).join('\n')
    : JSON.stringify(result);
  return full.slice(0, max);
}

// Map a connector to the observation category its items belong to.
function categoryFor(name: string): 'work' | 'communication' | 'consumption' | 'other' {
  const n = name.toLowerCase();
  if (/gmail|mail|outlook|slack|discord|whatsapp|teams|intercom/.test(n)) return 'communication';
  return 'work';
}

const DISTILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          entity: { type: 'string' },
          entityType: { type: 'string', enum: ['Person', 'Company', 'Project', 'Topic', 'Object', 'Place'] },
          url: { type: 'string' },
        },
        required: ['summary', 'entity', 'entityType', 'url'],
      },
    },
  },
  required: ['items'],
} as const;

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Build valid call args DETERMINISTICALLY from the tool's input schema property
 * names — no LLM (fast, reliable). Handles the common shapes: jql (Jira),
 * cql (Confluence), query (Notion/most), and pagination; injects a resolved
 * cloudId when the schema asks for one. Empty {} is the right answer for many
 * list_* tools (e.g. Linear list_issues).
 */
function buildArgs(tool: ToolDef, q: string, cloudId: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (tool.inputSchema as any)?.properties ?? {};
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(props, k);
  const args: Record<string, unknown> = {};
  if (has('cloudId') && cloudId) args.cloudId = cloudId;
  if (has('jql')) args.jql = q ? `text ~ "${q}" ORDER BY updated DESC` : 'ORDER BY updated DESC';
  else if (has('cql')) args.cql = q ? `text ~ "${q}" order by lastmodified desc` : 'order by lastmodified desc';
  else if (has('query') && q) args.query = q;
  else if (has('searchQuery') && q) args.searchQuery = q;
  for (const [k, v] of [['maxResults', 25], ['limit', 25], ['first', 25], ['pageSize', 25]] as const) {
    if (has(k)) { args[k] = v; break; }
  }
  return args;
}

/** Pick the tool that returns the USER'S OWN recent items — not docs/admin/writes. */
function pickReadTool(tools: { name: string; description?: string }[]): string | null {
  // Exclude writes, and noise: help docs, comments/labels/statuses, diffs,
  // attachments, team/user/member admin lists.
  const exclude = /create|update|delete|write|send|post|move|archive|upload|prepare|save|extract|documentation|\bdocs?\b|help|comment|label|status|diff|attachment|team|user|member|webhook|setting/i;
  const cands = tools.filter((t) => /search|list|recent|query|fetch|get|read|find|inbox/i.test(t.name) && !exclude.test(t.name));
  const score = (raw: string): number => {
    const n = raw.toLowerCase();
    if (/(^|_)(my|assigned|inbox)/.test(n) && /issue|task|ticket/.test(n)) return 110;
    if (/(search|list|query).*(issue|ticket|task)/.test(n)) return 105; // searchJiraIssuesUsingJql
    if (/list.*(issue|task|ticket)|issues$/.test(n)) return 100;
    if (/list.*(page|email|message|event|record|item)/.test(n)) return 80;
    if (/list.*(project|cycle|initiative|milestone|note)/.test(n)) return 70;
    if (/^notion-?search$|^search$|^list$/.test(n)) return 60;
    if (/^list_|^list-/.test(n)) return 50;
    if (/search/.test(n)) return 30;
    return 10;
  };
  const best = cands.map((t) => ({ t, s: score(t.name) })).sort((a, b) => b.s - a.s)[0];
  return best?.t.name ?? null;
}

/**
 * Periodic pull of EVERY enabled connector, so memory stays up to speed without
 * the user hitting Sync. (Webhooks aren't viable for a local desktop app — no
 * public endpoint — so we poll on a schedule.) Sequential to avoid hammering the
 * local LLM / connectors at once. Returns total items ingested.
 */
export async function syncAllConnectors(): Promise<number> {
  let total = 0;
  for (const c of listConnectors().filter((c) => c.enabled)) {
    try {
      const r = await ingestConnector(c.id);
      if (r.ok) total += r.count;
      console.log(`[autosync] ${c.name}: ${r.ok ? `${r.count} items` : r.error}`);
    } catch (e) {
      console.error('[autosync]', c.name, e);
    }
  }
  return total;
}

export async function ingestConnector(id: number, query?: string): Promise<{ ok: boolean; count: number; error?: string }> {
  ensureCols();
  const meta = getConnectorMeta(id);
  if (!meta) return { ok: false, count: 0, error: 'connector not found' };

  // Google's MCP endpoints are preview-gated ("caller does not have permission"
  // even with a valid token), so for Google we use the plain REST APIs directly
  // with the OAuth token from the connector flow. Same data, same privacy.
  if (meta.url?.includes('calendarmcp.googleapis.com')) return ingestGoogleCalendar(id, meta.name);
  if (meta.url?.includes('gmailmcp.googleapis.com')) return ingestGoogleGmail(id, meta.name, query);

  let tools: ToolDef[];
  try {
    tools = await fetchTools(id);
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
  }
  console.log(`[ingest] ${meta.name} tools:`, tools.map((t) => t.name).join(', '));

  // Slack needs a multi-step pull (channels → history → resolve users), so it
  // gets a dedicated adapter rather than the generic single-tool path.
  if (tools.some((t) => t.name === 'slack_get_channel_history')) {
    return ingestSlack(id, meta.name, query?.trim() ?? '');
  }

  const toolName = pickReadTool(tools);
  if (!toolName) return { ok: false, count: 0, error: 'no readable tool found on this connector' };
  const toolDef = tools.find((t) => t.name === toolName) ?? { name: toolName };
  console.log(`[ingest] ${meta.name} picked read tool: ${toolName}`);

  const isErr = (result: unknown): boolean => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((result as any)?.isError) return true;
    return /\berror -?\d|Invalid arguments|validation error|\brequired\b/i.test(resultToText(result));
  };

  const q = (query ?? '').trim();

  // Prerequisite resolution: some tools (e.g. Jira's searchJiraIssuesUsingJql)
  // require a cloudId that comes from ANOTHER tool. Fetch it first if the schema needs it.
  let cloudId = '';
  const schemaStr = JSON.stringify(toolDef.inputSchema ?? {});
  if (/cloud\W?id/i.test(schemaStr)) {
    const resTool = tools.find((t) => /resources|accessible|sites|cloud/i.test(t.name));
    if (resTool) {
      const rr = await callConnectorTool(id, resTool.name, {});
      if (rr.ok) {
        const m = resultToText(rr.result, 50_000).match(/"id"\s*:\s*"([0-9a-f-]{8,})"/i);
        if (m) {
          cloudId = m[1];
          console.log(`[ingest] ${meta.name} resolved cloudId=${cloudId}`);
        }
      }
    }
  }

  // Build args deterministically from the schema (fast, no LLM); fall back to {}.
  const args = buildArgs(toolDef, q, cloudId);
  console.log(`[ingest] ${meta.name} ${toolName} args:`, JSON.stringify(args));
  let r = await callConnectorTool(id, toolName, args);
  let good: unknown = r.ok && !isErr(r.result) ? r.result : null;
  if (good === null && Object.keys(args).length > 0) {
    const errTxt = (r.ok ? resultToText(r.result) : r.error ?? 'failed').slice(0, 200);
    console.log(`[ingest] ${meta.name} attempt 1 not usable (${errTxt}); retrying with {}`);
    r = await callConnectorTool(id, toolName, {});
    good = r.ok && !isErr(r.result) ? r.result : null;
  }
  if (good === null) {
    return { ok: false, count: 0, error: (r.ok ? resultToText(r.result) : r.error ?? 'failed').slice(0, 200) };
  }

  // Parse structured results from the FULL payload (not the truncated text) —
  // a truncated JSON won't parse and would wrongly fall through to the slow LLM.
  const fullText = resultToText(good, 500_000);
  const text = resultToText(good); // truncated copy for the LLM-distill fallback + frame storage
  console.log(`[ingest] ${meta.name} result length=${fullText.length}; head:`, fullText.slice(0, 160));

  // Many connectors (Notion, Linear, …) return STRUCTURED results with title +
  // url. Parse those directly — accurate titles + real links, no LLM rewrite.
  const structured = structuredItems(fullText);
  if (structured && structured.length) {
    console.log(`[ingest] ${meta.name} parsed ${structured.length} structured items`);
    return recordItems(id, meta.name, text, structured);
  }
  if (text.trim().length < 20) {
    getDB().prepare('UPDATE connectors SET last_synced = ? WHERE id = ?').run(Date.now(), id);
    return { ok: true, count: 0 };
  }

  const prompt = `These are items pulled from "${meta.name}". Extract the notable ones as concise observations of what they are.
For each item give: a one-line factual "summary", the main "entity" it's about (the page/project/person/doc title), "entityType", and "url" — the item's link COPIED VERBATIM from the data (e.g. a Notion page URL). If no URL is present for an item, use "".
Be concrete; use real names/titles from the data. Never invent a URL. Max 12 items. If there's nothing meaningful, return {"items": []}.

Data:
"""
${text}
"""

JSON only: {"items": [{"summary": "...", "entity": "...", "entityType": "Person|Company|Project|Topic|Object|Place", "url": "https://… or empty"}]}`;

  let items: IngestItem[] = [];
  try {
    const resp = await llm.chat(prompt, [], 120_000, 700, {
      responseFormat: { type: 'json_schema', json_schema: { name: 'ingest', schema: DISTILL_SCHEMA, strict: true } },
      temperature: 0.2,
      disableThinking: true,
    });
    items = (JSON.parse(extractJson(resp)).items ?? []) as IngestItem[];
    console.log(`[ingest] ${meta.name} distilled ${items.length} items`);
  } catch (e) {
    return { ok: false, count: 0, error: 'distill failed: ' + (e instanceof Error ? e.message : String(e)) };
  }
  return recordItems(id, meta.name, text, items);
}

interface IngestItem {
  summary: string;
  entity: string;
  entityType: string;
  url?: string;
}

// --- Google via REST (preview-gated MCP bypassed) ---

async function ingestGoogleCalendar(id: number, name: string): Promise<{ ok: boolean; count: number; error?: string }> {
  let events;
  try {
    events = await googleCalendarEvents(id);
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
  }
  // Feed the prospective "Ahead" view (connector = source of truth).
  upsertUpcomingEvents(
    events.map((e) => ({ title: e.title, startsAt: e.start, endsAt: e.end, location: e.location, attendees: e.attendees.join(', ') || null, sourceApp: name, url: e.url }))
  );
  const fmt = (sec: number): string =>
    new Date(sec * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const items: IngestItem[] = events.map((e) => ({
    summary: `${e.title}${e.start ? ` — ${fmt(e.start)}` : ''}${e.location ? ` @ ${e.location}` : ''}`,
    entity: '',
    entityType: '',
    url: e.url ?? undefined,
  }));
  return recordItems(id, name, JSON.stringify(events).slice(0, 4000), items);
}

async function ingestGoogleGmail(id: number, name: string, query?: string): Promise<{ ok: boolean; count: number; error?: string }> {
  let msgs;
  try {
    msgs = await googleGmailMessages(id, query);
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
  }
  const items: IngestItem[] = msgs.map((m) => ({
    // Carry from / to / cc into the observation so the secretary can judge whether
    // a mail is actually addressed to me (and awaits my reply) vs. one I'm merely
    // cc'd on / that's between other people.
    summary: `${m.subject} — from ${senderName(m.from)} · to: ${(m.to || '—').slice(0, 160)}${m.cc ? ` · cc: ${m.cc.slice(0, 160)}` : ''}${m.snippet ? ` — ${m.snippet.slice(0, 140)}` : ''}`,
    entity: senderName(m.from),
    entityType: 'Person',
    url: m.url,
  }));
  return recordItems(id, name, JSON.stringify(msgs).slice(0, 4000), items);
}

// Parse a structured tool result (Notion/Linear/etc.) into items directly — uses
// real titles + urls instead of an LLM rewrite. Returns null if not structured.
function structuredItems(text: string): IngestItem[] | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = obj as any;
  const arr: unknown[] | null = Array.isArray(o) ? o : o?.results ?? o?.items ?? o?.data ?? o?.pages ?? o?.issues ?? null;
  if (!Array.isArray(arr)) return null;
  const out: IngestItem[] = [];
  for (const r of arr) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const it = r as any;
    if (!it || typeof it !== 'object') continue;
    const title: string = it.title ?? it.name ?? it.subject ?? it.summary ?? '';
    const url: string = typeof it.url === 'string' && /^https?:/i.test(it.url) ? it.url : '';
    const hl: string = it.highlight ?? it.snippet ?? it.description ?? '';
    if (!title && !hl) continue;
    const summary = title ? (hl ? `${title} — ${hl}`.slice(0, 160) : title) : hl.slice(0, 160);
    out.push({ summary, entity: title || summary.slice(0, 40), entityType: 'Topic', url });
  }
  return out.length ? out : null;
}

function recordItems(id: number, name: string, rawText: string, items: IngestItem[]): { ok: boolean; count: number } {
  const category = categoryFor(name);
  let count = 0;
  for (const it of items) {
    if (!it.summary || it.summary.trim().length < 4) continue;
    const url = it.url && /^https?:\/\//i.test(it.url.trim()) ? it.url.trim() : undefined;
    recordObservation({
      summary: it.summary.trim(),
      surface: name,
      surfaceApp: name,
      url,
      category,
      engagement: 0.5,
      salience: 0.7,
      mentions: it.entity && it.entity.trim().length > 1 ? [{ name: it.entity.trim(), type: it.entityType }] : [],
      frames: [{ app: name, url, text: rawText.slice(0, 4000), source: 'connector' }],
    });
    count += 1;
  }
  getDB().prepare('UPDATE connectors SET last_synced = ?, synced_count = COALESCE(synced_count,0) + ? WHERE id = ?').run(Date.now(), count, id);
  emitChanged();
  return { ok: true, count };
}

/** Slack adapter: resolve users, list channels, pull recent message history.
 * All over ONE connection (withConnector) — never spawn npx per call. */
async function ingestSlack(id: number, name: string, q: string): Promise<{ ok: boolean; count: number; error?: string }> {
  return withConnector(id, async (call) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = async (tool: string, args: Record<string, unknown>): Promise<any | null> => {
      const r = await call(tool, args);
      if (!r.ok) return null;
      try {
        return JSON.parse(resultToText(r.result, 500_000));
      } catch {
        return null;
      }
    };

    const usersRes = await json('slack_get_users', { limit: 200 });
    const userMap: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const u of (usersRes?.members ?? usersRes?.users ?? []) as any[]) {
      userMap[u.id] = u?.profile?.real_name || u?.real_name || u?.name || u.id;
    }
    const chRes = await json('slack_list_channels', { limit: 100 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allChannels = (chRes?.channels ?? []) as any[];
    if (!allChannels.length) return { ok: false, count: 0, error: 'No channels returned — the bot token still needs channels:read / groups:read.' };
    // Slack only returns history for channels the bot has JOINED. Read only those.
    const channels = allChannels.filter((c) => c.is_member);
    console.log(`[ingest] Slack: ${allChannels.length} channels, ${channels.length} the bot is in`);
    if (!channels.length) {
      return {
        ok: false,
        count: 0,
        error: `Slack returns messages only for channels your bot has joined. It's in 0 of ${allChannels.length}. In Slack, run “/invite @<your bot>” in the channels you want synced, then Sync again.`,
      };
    }

    const items: IngestItem[] = [];
    let logged = false;
    for (const ch of channels.slice(0, 12)) {
      if (items.length >= 50) break;
      const raw = await call('slack_get_channel_history', { channel_id: ch.id, limit: 10 });
      if (!logged) {
        console.log(`[ingest] Slack history[#${ch.name}] ok=${raw.ok}:`, (raw.ok ? resultToText(raw.result, 300) : raw.error));
        logged = true;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let hist: any = null;
      if (raw.ok) { try { hist = JSON.parse(resultToText(raw.result, 500_000)); } catch { /* ignore */ } }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const m of (hist?.messages ?? []) as any[]) {
        if (m.subtype) continue; // skip joins/leaves/system
        const text = String(m.text || '')
          .replace(/<@([A-Z0-9]+)>/g, (_s: string, uid: string) => '@' + (userMap[uid] || 'user'))
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length < 4) continue;
        if (q && !text.toLowerCase().includes(q.toLowerCase())) continue;
        const author = userMap[m.user] || 'someone';
        items.push({ summary: `#${ch.name} · ${author}: ${text.slice(0, 180)}`, entity: author, entityType: 'Person', url: '' });
        if (items.length >= 50) break;
      }
    }
    console.log(`[ingest] Slack adapter: ${channels.length} channels → ${items.length} messages`);
    return recordItems(id, name, JSON.stringify({ channels: channels.length }), items);
  });
}

/** Recent observations INGESTED FROM A CONNECTOR (not screen capture, even though
 * both can share a surface name) — filtered to connector-sourced frames. */
export function listConnectorItems(surface: string, limit = 50): { id: number; summary: string; ts: string; url: string | null }[] {
  return getDB()
    .prepare(
      `SELECT o.id AS id, o.summary AS summary, o.url AS url, datetime(o.ts,'localtime') AS ts
       FROM observations o
       WHERE o.surface = ?
         AND EXISTS (
           SELECT 1 FROM observation_frames of JOIN frames f ON f.id = of.frame_id
           WHERE of.observation_id = o.id AND f.source = 'connector'
         )
       ORDER BY o.id DESC LIMIT ?`
    )
    .all(surface, limit) as { id: number; summary: string; ts: string; url: string | null }[];
}
