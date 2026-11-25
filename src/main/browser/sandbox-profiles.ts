import { readFileSync } from 'node:fs'

/**
 * Test-account profiles for signed-in agent practice (email, calendar, shop, airline, bank).
 *
 * A profile is a fenced room, never a real account:
 *  - its own cookie jar (partition), apart from the person's own browsing;
 *  - its own sites: a Web Use task on a profile can open only those hosts, so it cannot reach a
 *    real Gmail or bank even if the model tries;
 *  - its logins are ordinary Vault logins saved for those hosts, so the Vault fills them the same
 *    way it fills the person's own (the model never sees a password);
 *  - send, pay and delete run without asking, because nothing real can be sent or paid there.
 *
 * Each sandbox site has its own registrable domain (offgrid-mail.test, offgrid-bank.test, ...), so
 * the Vault's site match never offers the mail login to the bank. The sites are open-source apps
 * self-hosted on the training machine behind a local-CA https proxy (docs/agent-browser/SANDBOX.md);
 * a profile trusts that local certificate for its own hosts only.
 *
 * OFFGRID_SANDBOX_PROFILES=<file.json> replaces the built-in list (same shape).
 */
export interface SandboxProfile {
  id: string
  label: string
  /** The paid-agent job family it practises (docs/agent-browser/training-tasks.json). */
  category: 'email' | 'calendar' | 'shop' | 'travel' | 'bank' | 'docs' | 'forms'
  /** Hosts the profile may open. Subresources (scripts, images) are not limited. */
  hosts: string[]
  startUrl: string
}

const BUILT_IN: SandboxProfile[] = [
  {
    id: 'mail',
    label: 'Sandbox mail',
    category: 'email',
    hosts: ['offgrid-mail.test'],
    startUrl: 'https://offgrid-mail.test/'
  },
  {
    id: 'calendar',
    label: 'Sandbox calendar and files',
    category: 'calendar',
    hosts: ['offgrid-cloud.test'],
    startUrl: 'https://offgrid-cloud.test/apps/calendar/'
  },
  {
    id: 'shop',
    label: 'Sandbox shop',
    category: 'shop',
    hosts: ['offgrid-shop.test'],
    startUrl: 'https://offgrid-shop.test/'
  },
  {
    id: 'airline',
    label: 'Sandbox airline',
    category: 'travel',
    hosts: ['offgrid-air.test'],
    startUrl: 'https://offgrid-air.test/'
  },
  {
    id: 'bank',
    label: 'Sandbox bank',
    category: 'bank',
    hosts: ['offgrid-bank.test'],
    startUrl: 'https://offgrid-bank.test/'
  },
  {
    id: 'forms',
    label: 'Sandbox forms and government errands',
    category: 'forms',
    hosts: ['offgrid-forms.test'],
    startUrl: 'https://offgrid-forms.test/'
  }
]

function isProfile(value: unknown): value is SandboxProfile {
  const p = value as Partial<SandboxProfile> | null
  return (
    typeof p?.id === 'string' &&
    /^[a-z0-9-]{1,40}$/.test(p.id) &&
    typeof p.label === 'string' &&
    typeof p.category === 'string' &&
    Array.isArray(p.hosts) &&
    p.hosts.length > 0 &&
    p.hosts.every((host) => typeof host === 'string' && /^[a-z0-9.-]+$/i.test(host)) &&
    typeof p.startUrl === 'string'
  )
}

let cached: SandboxProfile[] | null = null

export function sandboxProfiles(): SandboxProfile[] {
  if (cached) return cached
  const file = process.env.OFFGRID_SANDBOX_PROFILES
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(parsed) && parsed.every(isProfile)) return (cached = parsed)
      console.warn('[browser] OFFGRID_SANDBOX_PROFILES is not a list of profiles; using built-in')
    } catch {
      console.warn('[browser] OFFGRID_SANDBOX_PROFILES could not be read; using built-in')
    }
  }
  return (cached = BUILT_IN)
}

export function sandboxProfile(id: string | undefined): SandboxProfile | undefined {
  return id ? sandboxProfiles().find((profile) => profile.id === id) : undefined
}

export function sandboxPartition(profile: SandboxProfile): string {
  return `persist:sandbox-${profile.id}`
}

/** A top-level page the profile may open: its own hosts (and their subdomains), https only. */
export function sandboxAllows(profile: SandboxProfile, url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'about:') return true
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return profile.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}
