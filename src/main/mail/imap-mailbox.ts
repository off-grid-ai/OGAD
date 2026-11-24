import type { ImapFlow } from 'imapflow'
import { getSecret } from '../secrets'
import type { ConnectorToolSource } from '../mcp'
import { extractOneTimeCodes, type CodeMail } from '../browser/one-time-code'

/**
 * An email account over IMAP (Fastmail, iCloud, a work server, the agent sandbox's test mailbox).
 * It is an ordinary connection: a connectors row whose url starts with `imap`, with its server,
 * address and password in the secret store (IMAP_SERVER, IMAP_USER, IMAP_PASSWORD), entered on
 * the Connections screen like any token.
 *
 * Reads only. Messages are fetched with BODY.PEEK, so nothing is marked read.
 */

export const IMAP_URL_PREFIX = 'imap'

interface ImapAccount {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

/** `imap.example.com`, `imap.example.com:993`, `imaps://host`, `imap://127.0.0.1:1143`. */
export function parseImapServer(server: string): { host: string; port: number; secure: boolean } {
  const trimmed = server.trim()
  const scheme = /^(imaps?):\/\//i.exec(trimmed)?.[1]?.toLowerCase()
  const rest = trimmed.replace(/^imaps?:\/\//i, '').replace(/\/.*$/, '')
  const [, host = '', portText] = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(rest) ?? []
  const port = portText ? Number(portText) : scheme === 'imap' ? 143 : 993
  const secure = scheme === 'imaps' || (scheme !== 'imap' && port === 993)
  if (!host) throw new Error('Enter the IMAP server, for example imap.fastmail.com.')
  // A password in the clear goes only to this computer itself (the sandbox mailbox).
  if (!secure && !isLoopback(host)) {
    throw new Error('Use the server’s secure IMAP address (port 993).')
  }
  return { host, port, secure }
}

function accountFor(connectorId: number): ImapAccount {
  const server = getSecret(`connector:${connectorId}:IMAP_SERVER`)
  const user = getSecret(`connector:${connectorId}:IMAP_USER`)
  const pass = getSecret(`connector:${connectorId}:IMAP_PASSWORD`)
  if (!server || !user || !pass) throw new Error('Enter the IMAP server, email and password.')
  return { ...parseImapServer(server), user, pass }
}

async function withInbox<T>(account: ImapAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    socketTimeout: 30_000
  })
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      return await fn(client)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

interface InboxMessage extends CodeMail {
  uid: number
}

/** The newest inbox messages since a time, optionally from one domain, newest first. */
async function recentMessages(
  account: ImapAccount,
  query: { sinceMs: number; fromDomain?: string; max: number }
): Promise<InboxMessage[]> {
  const { simpleParser } = await import('mailparser')
  return withInbox(account, async (client) => {
    // SEARCH SINCE is by day; the exact time is checked on INTERNALDATE below.
    const found = await client.search(
      {
        since: new Date(query.sinceMs - 24 * 60 * 60 * 1000),
        ...(query.fromDomain ? { from: `@${query.fromDomain}` } : {})
      },
      { uid: true }
    )
    const uids = (found || []).slice(-query.max)
    if (!uids.length) return []
    const out: InboxMessage[] = []
    for await (const message of client.fetch(
      uids,
      { uid: true, internalDate: true, source: true },
      { uid: true }
    )) {
      const receivedAt = new Date(message.internalDate ?? 0).getTime()
      if (!message.source || receivedAt < query.sinceMs) continue
      const parsed = await simpleParser(message.source)
      out.push({
        uid: message.uid,
        from: parsed.from?.text ?? '',
        subject: parsed.subject ?? '',
        text: parsed.text ?? '',
        receivedAt
      })
    }
    return out.sort((a, b) => b.receivedAt - a.receivedAt)
  })
}

/**
 * Fresh mail from one site, for the agent's emailed one-time codes. Read live from the server on
 * every call, so each call is the mailbox's sync. Never stored and never logged.
 */
export async function readImapCodeMail(
  connectorId: number,
  query: { domain: string; sinceMs: number }
): Promise<CodeMail[]> {
  const messages = await recentMessages(accountFor(connectorId), {
    sinceMs: query.sinceMs,
    fromDomain: query.domain,
    max: 20
  })
  return messages.map(({ from, subject, text, receivedAt }) => ({ from, subject, text, receivedAt }))
}

/** A snippet for the chat and memory: a one-time code inside it is masked. */
function safeSnippet(subject: string, text: string): string {
  let snippet = text.replace(/\s+/g, ' ').trim().slice(0, 300)
  for (const code of extractOneTimeCodes(subject, text)) {
    snippet = snippet.split(code).join('••••••')
  }
  return snippet
}

const LIST_TOOL = 'list_recent_mail'

/** The account as a connection: verify signs in, one read-only tool lists recent mail. */
export function imapConnectorToolSource(
  connectorId: number,
  url: string | null
): ConnectorToolSource | undefined {
  if (!url?.toLowerCase().startsWith(IMAP_URL_PREFIX)) return undefined
  return {
    tools: [
      {
        name: LIST_TOOL,
        description:
          'List the newest messages in the inbox: sender, subject, date and a short snippet.',
        inputSchema: {
          type: 'object',
          properties: {
            max_results: { type: 'integer', minimum: 1, maximum: 50 },
            newer_than_days: { type: 'integer', minimum: 1, maximum: 30 }
          }
        },
        annotations: { readOnlyHint: true }
      }
    ],
    // Nothing to authorize in a browser: the password is entered on the Connections screen.
    authorize: async () => {},
    verify: async () => {
      await withInbox(accountFor(connectorId), async () => undefined)
    },
    callTool: async (tool, args) => {
      if (tool !== LIST_TOOL) return { ok: false, error: `unknown tool ${tool}` }
      const input = (args ?? {}) as { max_results?: number; newer_than_days?: number }
      const days = Math.min(Math.max(Number(input.newer_than_days) || 7, 1), 30)
      const max = Math.min(Math.max(Number(input.max_results) || 20, 1), 50)
      try {
        const messages = await recentMessages(accountFor(connectorId), {
          sinceMs: Date.now() - days * 24 * 60 * 60 * 1000,
          max
        })
        const items = messages.map((m) => ({
          from: m.from,
          subject: m.subject,
          date: new Date(m.receivedAt).toISOString(),
          snippet: safeSnippet(m.subject, m.text)
        }))
        return { ok: true, result: { content: [{ type: 'text', text: JSON.stringify(items) }] } }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }
}
