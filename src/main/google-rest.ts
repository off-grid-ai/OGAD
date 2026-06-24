// Google via the plain REST APIs (Calendar v3, Gmail v1) using the OAuth token we
// already obtain through the connector flow. We use this INSTEAD of Google's MCP
// endpoints (gmailmcp/calendarmcp), which are preview/allowlist-gated and return
// "caller does not have permission" even with a valid token — while these REST
// APIs return 200 with the same token. Data path stays device <-> Google. The MCP
// connectors remain wired and will light up if/when Google opens the gate.

import { getSecret, setSecret } from './secrets';
import { GOOGLE_OAUTH_CLIENT } from './google-client';
import { learnIdentity } from './identity';
import { listConnectors } from './mcp';

interface Tok { access_token?: string; refresh_token?: string; [k: string]: unknown }

function loadTok(id: number): Tok | null {
  const raw = getSecret(`connector:${id}:oauth:tokens`);
  return raw ? (JSON.parse(raw) as Tok) : null;
}

// Refresh the access token with the saved refresh_token + our OAuth client.
async function refresh(id: number, t: Tok): Promise<string | null> {
  if (!t.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: GOOGLE_OAUTH_CLIENT.client_id,
    client_secret: GOOGLE_OAUTH_CLIENT.client_secret,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  setSecret(`connector:${id}:oauth:tokens`, JSON.stringify({ ...t, access_token: j.access_token, expires_in: j.expires_in }));
  return j.access_token;
}

// Authenticated GET with a one-shot refresh-and-retry on 401.
async function gget(id: number, url: string): Promise<Response> {
  const t = loadTok(id);
  if (!t?.access_token) throw new Error('Not authorized — connect the account first.');
  let res = await fetch(url, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (res.status === 401) {
    const at = await refresh(id, t);
    if (at) res = await fetch(url, { headers: { Authorization: `Bearer ${at}` } });
  }
  return res;
}

export interface CalEvent {
  title: string;
  start: number | null; // epoch seconds
  end: number | null;
  location: string | null;
  attendees: string[];
  url: string | null;
}

/** Upcoming events on the primary calendar, now → horizonDays ahead. */
export async function googleCalendarEvents(id: number, horizonDays = 14): Promise<CalEvent[]> {
  const now = new Date().toISOString();
  const timeMax = new Date(Date.now() + horizonDays * 86400000).toISOString();
  const url =
    'https://www.googleapis.com/calendar/v3/calendars/primary/events' +
    `?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(timeMax)}`;
  const res = await gget(id, url);
  if (!res.ok) throw new Error(`Calendar API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await res.json()) as { items?: any[] };
  const sec = (s?: string): number | null => (s ? Math.floor(Date.parse(s) / 1000) || null : null);
  return (j.items ?? []).map((e) => ({
    title: e.summary || '(no title)',
    start: sec(e.start?.dateTime) ?? sec(e.start?.date),
    end: sec(e.end?.dateTime) ?? sec(e.end?.date),
    location: e.location || null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attendees: Array.isArray(e.attendees) ? e.attendees.map((a: any) => a.displayName || a.email).filter(Boolean) : [],
    url: e.htmlLink || null,
  }));
}

export interface GmailMsg { id: string; subject: string; from: string; to: string; cc: string; snippet: string; date: string; url: string }

/** Recent inbox messages (or a search query), with metadata headers. */
export async function googleGmailMessages(id: number, query?: string, max = 20): Promise<GmailMsg[]> {
  const q = query && query.trim() ? `&q=${encodeURIComponent(query.trim())}` : '&q=in:inbox';
  const listRes = await gget(id, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}${q}`);
  if (!listRes.ok) throw new Error(`Gmail API ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const out: GmailMsg[] = [];
  for (const m of (list.messages ?? []).slice(0, max)) {
    const r = await gget(
      id,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date`
    );
    if (!r.ok) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (await r.json()) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (n: string): string => (d.payload?.headers ?? []).find((x: any) => x.name === n)?.value || '';
    out.push({
      id: m.id,
      subject: h('Subject') || '(no subject)',
      from: h('From'),
      to: h('To'),
      cc: h('Cc'),
      snippet: (d.snippet || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
      date: h('Date'),
      url: `https://mail.google.com/mail/u/0/#all/${m.id}`,
    });
  }
  return out;
}

/** The connected Google account's email (+ name if the profile scope is granted). */
export async function googleAccount(id: number): Promise<{ email?: string; name?: string }> {
  // userinfo gives name + email (needs the profile scope — granted on reconnect).
  try {
    const r = await gget(id, 'https://www.googleapis.com/oauth2/v3/userinfo');
    if (r.ok) {
      const j = (await r.json()) as { email?: string; name?: string };
      if (j.email || j.name) return { email: j.email, name: j.name };
    }
  } catch {
    /* fall through */
  }
  // Email-only fallbacks that work with the read scopes we already have.
  try {
    const r = await gget(id, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    if (r.ok) return { email: ((await r.json()) as { emailAddress?: string }).emailAddress };
  } catch {
    /* ignore */
  }
  try {
    const r = await gget(id, 'https://www.googleapis.com/calendar/v3/calendars/primary');
    if (r.ok) return { email: ((await r.json()) as { id?: string }).id };
  } catch {
    /* ignore */
  }
  return {};
}

/** Auto-detect the user from every connected Google account → identity + aliases. */
export async function learnIdentityFromGoogle(): Promise<void> {
  for (const c of listConnectors().filter((c) => c.enabled && (c.url || '').includes('googleapis.com'))) {
    try {
      const a = await googleAccount(c.id);
      if (a.email || a.name) {
        learnIdentity({ name: a.name, emails: a.email ? [a.email] : [] });
        console.log(`[identity] learned from ${c.name}: ${a.name ?? '(no name)'} <${a.email ?? '?'}>`);
      }
    } catch {
      /* skip */
    }
  }
}

/** "Alice Smith <alice@x.com>" -> "Alice Smith" (falls back to the email). */
export function senderName(from: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  if (m && m[1].trim()) return m[1].trim();
  if (m) return m[2].trim();
  return from.trim();
}
