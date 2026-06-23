// Identity anchor — who the user is. Foundational for the "act" pillar: it lets
// Off Grid tell "me" from "others" in email/meetings, own the right action items,
// and address the user. The user is referenced many ways (Mac, Mohammed, Mohammed
// Ali, Chherawalla, alichherawalla, mac@…), so we keep an ALIAS set that's
// auto-learned from connected accounts (name + every email) and matched broadly.

import { getSetting, saveSetting } from './database';

export interface Identity {
  name: string;
  email: string;
  emails: string[]; // additional addresses that are also "me"
  aliases: string[]; // every way the user is referenced (names, handles, local-parts)
}

// Split a name/handle/local-part into matchable tokens ("mohammed.ali" → mohammed, ali).
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s._\-+]+/).map((t) => t.trim()).filter((t) => t.length > 1);
}

/** Build the alias set from a display name + all emails (full strings + tokens). */
export function deriveAliases(name: string, emails: string[]): string[] {
  const out = new Set<string>();
  if (name) {
    out.add(name.toLowerCase());
    tokenize(name).forEach((t) => out.add(t));
  }
  for (const e of emails) {
    const lp = (e || '').split('@')[0]?.toLowerCase();
    if (lp) {
      out.add(lp);
      tokenize(lp).forEach((t) => out.add(t));
    }
  }
  return [...out];
}

export function getIdentity(): Identity {
  const name = getSetting<string>('identity.name', '');
  const email = getSetting<string>('identity.email', '');
  const extra = getSetting<string[]>('identity.emails', []);
  const aliases = getSetting<string[]>('identity.aliases', []);
  return {
    name,
    email,
    emails: Array.isArray(extra) ? extra : [],
    aliases: Array.isArray(aliases) ? aliases : [],
  };
}

export function setIdentity(id: Partial<Identity>): Identity {
  if (id.name !== undefined) saveSetting('identity.name', id.name);
  if (id.email !== undefined) saveSetting('identity.email', id.email);
  if (id.emails !== undefined) saveSetting('identity.emails', id.emails);
  if (id.aliases !== undefined) saveSetting('identity.aliases', id.aliases);
  return getIdentity();
}

/**
 * Merge auto-detected identity (from a connected account) into the stored one
 * WITHOUT clobbering anything the user set by hand. Recomputes the alias set.
 */
export function learnIdentity(input: { name?: string; emails?: string[] }): Identity {
  const cur = getIdentity();
  const name = cur.name || (input.name ?? '').trim();
  const allEmails = Array.from(
    new Set([cur.email, ...cur.emails, ...(input.emails ?? [])].map((e) => (e || '').trim().toLowerCase()).filter(Boolean))
  );
  const email = cur.email || allEmails[0] || '';
  // Auto aliases (from name + emails) unioned with any the user added by hand.
  const aliases = Array.from(new Set([...deriveAliases(name, allEmails), ...cur.aliases]));
  return setIdentity({ name, email, emails: allEmails.filter((e) => e !== email), aliases });
}

/** The full lowercased set of self-identifiers (names, tokens, emails, local-parts). */
export function selfTokens(): Set<string> {
  const id = getIdentity();
  const s = new Set<string>();
  for (const a of [id.name, ...id.aliases]) {
    if (!a) continue;
    s.add(a.toLowerCase());
    tokenize(a).forEach((t) => s.add(t));
  }
  for (const e of [id.email, ...id.emails]) {
    if (!e) continue;
    s.add(e.toLowerCase());
    const lp = e.split('@')[0]?.toLowerCase();
    if (lp) {
      s.add(lp);
      tokenize(lp).forEach((t) => s.add(t));
    }
  }
  return s;
}

/** Is this address/name the user themselves? Matches any known alias/token. */
export function isMe(value: string): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (!v) return false;
  const s = selfTokens();
  if (s.has(v)) return true;
  // Match if any token of the value is a known self-identifier ("Mohammed Ali" → ali/mohammed).
  return tokenize(value).some((t) => s.has(t));
}
