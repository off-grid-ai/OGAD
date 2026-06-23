// The "secretary" — Off Grid's agency. It surveys the tools it actually has
// (whatever connectors are connected), reads your context (today's calendar, open
// to-dos, recent email), and proposes concrete actions that would make your day
// smoother — drafting a reply, scheduling something, creating a task, etc.
//
// It NEVER acts on its own: every proposal goes into the approval queue, and only
// executes after you approve (crm-ipc 'approvals:approve' → callConnectorTool).
// The set of possible actions is fully DYNAMIC — it's just whatever tools the
// connected integrations expose.

import { llm } from '../llm';
import { listConnectors, fetchTools } from '../mcp';
import { proposeApproval, listApprovals } from './approvals';
import { getAhead } from './ahead';
import { getDB } from '../database';
import { listMeetings } from '../meetings';
import { getIdentity } from '../identity';

// Automated / promotional / transactional mail never needs a personal reply —
// keep it out of the secretary's context so it doesn't propose "reply to the
// Supabase security alert" or "draft a response to the newsletter".
const AUTOMATED_RE = /no-?reply|noreply|notification|unsubscribe|newsletter|digest| via |do not reply|automated|verify your|confirm your|reset your password|sign in to|security (?:alert|issue|vulnerab|notif)|invoice|receipt|payment (?:failed|declined|received)|your (?:subscription|order|account)|% off|sale ends|webinar|register now|spam (?:report|folder)|\bseo\b|grow your (?:traffic|sales|business|revenue|audience)|boost your|cold (?:email|outreach)|limited (?:time|offer)|book a (?:demo|call)|free trial|increase your/i;

interface ToolEntry { connector: string; tool: string; description: string }

// Read-only tools aren't "actions" — the agent proposes things that DO something.
function isActionTool(name: string): boolean {
  return !/^(list|get|search|read|fetch|whoami|describe)[_-]/i.test(name);
}
// Rank toward the high-value "secretary" verbs (draft/send/schedule/create a
// task), away from low-level admin (labels, toolbar, domains).
function toolScore(name: string): number {
  const n = name.toLowerCase();
  if (/(draft|send|reply|respond|compose)/.test(n)) return 5;
  if (/(create_event|schedule|suggest_time|invite|book)/.test(n)) return 5;
  if (/(create_issue|create_task|create_page|add_)/.test(n)) return 4;
  if (/create/.test(n)) return 3;
  if (/(update|move|assign|comment)/.test(n)) return 2;
  if (/(label|unlabel|delete|toolbar|domain|deploy|fetch)/.test(n)) return -2;
  return 1;
}

// Cap the catalog so the proposer prompt stays small/fast and the local model can
// reason well — keep the top-ranked action tools across connectors.
async function buildToolCatalog(limit = 24): Promise<ToolEntry[]> {
  const out: ToolEntry[] = [];
  for (const c of listConnectors().filter((c) => c.enabled)) {
    try {
      const tools = await fetchTools(c.id);
      for (const t of tools) {
        if (isActionTool(t.name)) out.push({ connector: c.name, tool: t.name, description: (t.description ?? '').slice(0, 100) });
      }
    } catch {
      /* connector unreachable — skip */
    }
  }
  return out.sort((a, b) => toolScore(b.tool) - toolScore(a.tool)).slice(0, limit);
}

function extractJson(s: string): string {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  return a >= 0 && b > a ? s.slice(a, b + 1) : '{}';
}

interface Proposed { connector?: string; tool?: string; args?: Record<string, unknown>; title?: string; why?: string }

/**
 * Look at the available tools + the user's context and propose helpful actions
 * into the approval queue. Returns how many it queued. Idempotent-ish: it skips
 * proposing a tool-call that's already pending with the same title.
 */
export async function proposeActions(nowSec: number): Promise<{ proposed: number; error?: string }> {
  const catalog = await buildToolCatalog();
  console.log(`[secretary] tool catalog: ${catalog.length} action tools — ${catalog.map((t) => `${t.connector}/${t.tool}`).slice(0, 20).join(', ')}`);
  if (!catalog.length) {
    return { proposed: 0, error: 'No connected tools yet — connect an integration first.' };
  }

  const view = getAhead(nowSec);
  const ident = getIdentity();
  const meLabel = [ident.name, ...ident.aliases].filter(Boolean).join(', ') || 'me';
  // Real correspondence only — drop automated/promotional mail before it ever
  // reaches the model, so it can't propose replying to a security alert.
  const emails = (getDB().prepare(`SELECT summary FROM observations WHERE surface = 'Gmail' ORDER BY ts DESC LIMIT 25`).all() as { summary: string }[])
    .filter((e) => e.summary && !AUTOMATED_RE.test(e.summary))
    .slice(0, 12);
  // Recent calls — a meeting that just happened is prime material for a CRM note,
  // a follow-up task, or a recap email. Feed the secretary the title + summary.
  const weekAgoMs = (nowSec - 7 * 86400) * 1000;
  const recentMeetings = listMeetings(8).filter((m) => (m.started_at ?? 0) >= weekAgoMs && (m.summary || m.title));

  const hhmm = (s: number): string => new Date(s * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const events = view.upcoming.map((e) => `- ${e.starts_at ? hhmm(e.starts_at) : '?'} ${e.title}${e.attendees ? ` (with ${e.attendees})` : ''}`).join('\n') || '(none)';
  const todos = view.priorities.slice(0, 18).map((p) => `- ${p.text}${p.due ? ` [due ${p.due}]` : ''}`).join('\n') || '(none)';
  const mail = emails.map((e) => `- ${e.summary}`).join('\n') || '(none)';
  const calls = recentMeetings.map((m) => `- ${m.title ?? 'Meeting'}: ${(m.summary ?? '').slice(0, 220)}`).join('\n') || '(none)';
  const toolList = catalog.map((t) => `- ${t.connector} / ${t.tool}: ${t.description}`.slice(0, 220)).join('\n');

  const prompt = `You are my proactive personal secretary. You can use the TOOLS listed below (and ONLY those). Looking at my context, propose a few concrete, genuinely useful actions that move things forward.

WHO I AM: I am ${ident.name || 'the user'} — also referred to as: ${meLabel}; my email is ${ident.email || '(unknown)'}. These all mean ME.
- NEVER draft a message TO me, never create a task to "meet/call/speak with/follow up with" me, never treat any of my own names as a contact or recipient. An email from me, or only involving me, is not something to reply to.

What GOOD looks like:
- After a CALL (see RECENT CALLS): log it in the CRM — add a note to the relevant company/person in Attio with the key points + next steps, and/or create a follow-up task. If a recap/next-step email is owed to the OTHER side, draft it. Use the OTHER people/company named in the call (never me).
- Draft a reply to a real email from another person that's clearly waiting on my response.
- Turn an open to-do into the right action (create the task/issue, draft the message to the person).
- A follow-up I'd otherwise forget.

Rules:
- Every action MUST use one of the listed tools, with connector + tool names EXACTLY as written.
- Only act on REAL correspondence/people. Skip anything automated/promotional (security alerts, newsletters, notifications, receipts, no-reply) — it never needs a personal reply or a task.
- Do NOT duplicate things that already exist — e.g. do NOT create a calendar event already in TODAY'S MEETINGS, and never propose two actions about the same person/topic — pick one.
- Fill "args" with values grounded ONLY in the context — never invent emails, times, names, or IDs that aren't present. If you can't fill the required args from context, skip that action.
- Quality over quantity: 1-4 strong proposals, or zero if nothing is genuinely worth doing.
- Each action is a PROPOSAL — I review and approve before anything runs.

Return JSON only:
{"actions":[{"connector":"<exact>","tool":"<exact>","args":{...},"title":"<short imperative>","why":"<one sentence>"}]}

TOOLS:
${toolList}

TODAY'S MEETINGS:
${events}

OPEN TO-DOS:
${todos}

RECENT CALLS (just happened — consider a CRM note / follow-up task / recap email):
${calls}

RECENT EMAILS:
${mail}`;

  let actions: Proposed[] = [];
  try {
    const resp = await llm.chat(prompt, [], 150_000, 1200, { temperature: 0.3, disableThinking: true });
    const parsed = JSON.parse(extractJson(resp)) as { actions?: Proposed[] };
    actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch (e) {
    return { proposed: 0, error: e instanceof Error ? e.message : 'planning failed' };
  }

  // INTELLIGENCE GATE — before creating any item, let the LLM judge each candidate
  // instead of trusting brittle rules: is it genuinely worth surfacing? Drops
  // self-directed, promotional/automated, trivial/already-done, and duplicate
  // proposals. This is the reasoning step the user asked for.
  if (actions.length) {
    try {
      const list = actions.map((a, i) => `${i + 1}. [${a.connector}/${a.tool}] ${a.title}${a.why ? ` — ${a.why}` : ''}`).join('\n');
      const gate = `You are the quality gate for my proactive assistant. I am ${meLabel}. Keep ONLY actions genuinely worth surfacing to me. DROP any that:
- are directed at ME or involve only me (never act toward myself),
- come from a promotional / automated / no-reply / marketing / cold-outreach email (e.g. "AI SEO advice", security alerts, newsletters),
- are trivial, vague, or likely already done,
- duplicate another listed action (same person + same intent) — keep just one.
Return JSON ONLY: {"keep":[<the item numbers to keep>]}

ACTIONS:
${list}`;
      const resp = await llm.chat(gate, [], 90_000, 300, { temperature: 0, disableThinking: true });
      const keep = new Set(((JSON.parse(extractJson(resp)) as { keep?: unknown[] }).keep ?? []).map((n) => Number(n)));
      const before = actions.length;
      actions = actions.filter((_, i) => keep.has(i + 1));
      console.log(`[secretary] intelligence gate kept ${actions.length}/${before}`);
    } catch (e) {
      console.error('[secretary] gate failed (keeping all):', e);
    }
  }

  // Dedup key: connector + tool + the title's INTENT (lowercased, punctuation and
  // filler words stripped), so "Draft one-pager FOR Dhanraj" and "…TO Dhanraj"
  // collapse to one. Seeded with what's already pending, and grows within the
  // batch so the LLM can't queue two near-identical actions at once.
  // Fuzzy dedup: same connector+tool AND ≥60% title-word overlap counts as the
  // same action — so reworded variants ("Create 'Review UI changes' label" vs
  // "Create label for UI review") collapse, not just literal duplicates. Seeded
  // with what's pending, and grows within the batch.
  const tokSet = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((w) => w.length > 1 && !/^(to|for|the|a|an|of|on|in|with|re|and|create|draft)$/.test(w))
    );
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    a.forEach((x) => { if (b.has(x)) inter += 1; });
    return inter / (a.size + b.size - inter);
  };
  // Char-level similarity so a typo'd name ("johson" ~ "johnson") still matches.
  const charSim = (a: string, b: string): number => {
    if (a === b) return 1;
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    const dp = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return 1 - dp[n] / Math.max(m, n);
  };
  // The "subject" of an action = its distinctive long tokens (names, topics) —
  // "emma","johnson","anurag","supabase". Two same-tool actions sharing a subject
  // (exact OR near-typo) are the same action ("reply to Emma" == "follow up w/ Emma").
  const subjectToks = (s: string): string[] => [...tokSet(s)].filter((w) => w.length >= 4);
  const sameSubject = (a: string[], b: string[]): boolean =>
    a.some((x) => b.some((y) => charSim(x, y) >= 0.82));
  const kept = listApprovals('pending').map((a) => ({ c: (a.connector ?? '').toLowerCase(), t: (a.tool ?? '').toLowerCase(), toks: tokSet(a.title), subj: subjectToks(a.title) }));
  const isDup = (connector: string, tool: string, title: string): boolean => {
    const toks = tokSet(title);
    const subj = subjectToks(title);
    return kept.some(
      (k) =>
        k.c === connector.toLowerCase() &&
        k.t === tool.toLowerCase() &&
        (jaccard(k.toks, toks) >= 0.5 || sameSubject(k.subj, subj))
    );
  };

  // Backstop: drop anything aimed at ME (the model occasionally still proposes
  // "draft reply to Mac"). Strong self-names only (not the ambiguous "ali").
  const selfTarget = /\b(mac|mohammed|chherawalla|alichherawalla)\b/i;

  let n = 0;
  for (const a of actions) {
    const entry = catalog.find((t) => t.connector === a.connector && t.tool === a.tool);
    if (!entry || !a.title) continue;
    if (selfTarget.test(a.title)) { console.log(`[secretary] dropped self-directed: ${a.title}`); continue; }
    if (isDup(entry.connector, entry.tool, a.title)) continue;
    kept.push({ c: entry.connector.toLowerCase(), t: entry.tool.toLowerCase(), toks: tokSet(a.title), subj: subjectToks(a.title) });
    proposeApproval({
      title: a.title.slice(0, 160),
      detail: a.why ?? '',
      connector: entry.connector,
      tool: entry.tool,
      args: a.args ?? {},
      source: 'secretary',
    });
    n += 1;
  }
  return { proposed: n };
}
