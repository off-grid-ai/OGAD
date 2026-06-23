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
  const emails = getDB().prepare(`SELECT summary FROM observations WHERE surface = 'Gmail' ORDER BY ts DESC LIMIT 12`).all() as { summary: string }[];
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

What GOOD looks like:
- Draft a reply to an email that's clearly waiting on my response.
- Turn an open to-do into the right action (create the task/issue, draft the message to the person).
- A follow-up I'd otherwise forget.
- After a CALL (see RECENT CALLS): log it in the CRM — e.g. add a note to the relevant company/person in Attio with the key points + next steps, and/or create a follow-up task. If a recap or next-step email is owed to the other side, draft it. Use the people/company named in the call summary.

Rules:
- Every action MUST use one of the listed tools, with connector + tool names EXACTLY as written.
- Do NOT duplicate things that already exist — e.g. do NOT "schedule"/create a calendar event that is already in TODAY'S MEETINGS. They are already on my calendar.
- Fill "args" with values grounded ONLY in the context — never invent emails, times, names, or IDs that aren't present. If you can't fill the required args from context, skip that action.
- No duplicates: never propose two actions that accomplish the same thing (e.g. two drafts to the same person about the same topic) — pick one.
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
  const kept = listApprovals('pending').map((a) => ({ c: (a.connector ?? '').toLowerCase(), t: (a.tool ?? '').toLowerCase(), toks: tokSet(a.title) }));
  const isDup = (connector: string, tool: string, title: string): boolean => {
    const toks = tokSet(title);
    return kept.some((k) => k.c === connector.toLowerCase() && k.t === tool.toLowerCase() && jaccard(k.toks, toks) >= 0.6);
  };

  let n = 0;
  for (const a of actions) {
    const entry = catalog.find((t) => t.connector === a.connector && t.tool === a.tool);
    if (!entry || !a.title) continue;
    if (isDup(entry.connector, entry.tool, a.title)) continue;
    kept.push({ c: entry.connector.toLowerCase(), t: entry.tool.toLowerCase(), toks: tokSet(a.title) });
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
