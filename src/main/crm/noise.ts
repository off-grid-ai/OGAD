// The deterministic noise gate — the integrity rule the extractor lacked.
// A NAME is only allowed to become an entity if it could plausibly be a real
// person / company / project / topic. Code files, modules, branches, PRs,
// domains, email-sender strings, UI/code symbols, doc filenames, and the user
// themselves are NEVER entities. Used at CREATION time (reject before insert)
// and to retroactively hide the backlog. Reversible by design (we only hide).
import { isMe } from '../identity';

const FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cpp|h|swift|kt|sh|bat|ps1|png|jpe?g|webp|gif|svg|ico|pptx?|docx?|xlsx?|pdf|apk|ipa|json|ya?ml|toml|lock|html?|css|scss|md|markdown|txt|csv|sql|env)$/i;
const DOC_SUFFIX = /\b(md|pdf|docx?|xlsx?|pptx?|csv)$/i; // "ROADMAP_DESKTOP md", "CASE STUDY pdf"
const DOMAIN = /\.(com|dev|de|net|io|co|online|app|ai|org|gov|in|xyz)$/i;
const SENDER = / via |digest|briefing|weekly|noreply|no-reply|newsletter|unsubscribe| alert\b|the morning report/i;
// camelCase/Pascal code identifiers and common code-symbol suffixes.
const CODE_SYMBOL = /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/;
const CODE_SUFFIX = /(Store|Engine|Bridge|Sheet|Picker|Toggle|Handler|Provider|Context|Wrapper|Schema|Config|Screen|Tab|Modal|Service|Controller|Component)$/;
// all-lowercase hyphenated slug = a repo/module/branch name, not a human entity
// (crm-ipc, sd-cli, mix-image-runtime-lora, coreml-sd, audio-mode-pro, github-mcp-server)
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)+$/;

/** Why a name is noise (for logging), or null if it's allowed to be an entity. */
export function noiseReason(name: string): string | null {
  const n = (name || '').trim();
  if (n.length < 2) return 'too-short';
  if (isMe(n)) return 'self';
  if (FILE_EXT.test(n) || DOC_SUFFIX.test(n)) return 'file';
  if (n.includes('/')) return 'path/repo';
  if (n.includes('#')) return 'pr/issue';
  if (DOMAIN.test(n) || /googleapis|atlassian/i.test(n)) return 'domain';
  if (SENDER.test(n)) return 'newsletter/sender';
  if (CODE_SYMBOL.test(n) || CODE_SUFFIX.test(n)) return 'code-symbol';
  if (SLUG.test(n)) return 'slug/module';
  return null;
}

export function isNoiseEntityName(name: string): boolean {
  return noiseReason(name) !== null;
}
