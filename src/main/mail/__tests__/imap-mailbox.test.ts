import { EventEmitter } from 'events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Electron's safeStorage and the IMAP server are the boundaries. The secret store, mailparser and
// the code rules run for real.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-imap-mailbox-'))
const previousData = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = PROFILE

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

interface FakeMail {
  uid: number
  source: string
  internalDate: Date
}

const server = {
  mail: [] as FakeMail[],
  searches: [] as Record<string, unknown>[],
  clients: [] as EventEmitter[],
  /** When set, the socket fails during connect: imapflow emits 'error' and rejects connect(). */
  connectError: null as Error | null
}

vi.mock('imapflow', () => ({
  ImapFlow: class extends EventEmitter {
    constructor() {
      super()
      server.clients.push(this)
    }
    async connect(): Promise<void> {
      if (!server.connectError) return
      // imapflow emits the socket error and then rejects the pending command.
      this.emit('error', server.connectError)
      throw server.connectError
    }
    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => {} }
    }
    async search(query: Record<string, unknown>): Promise<number[]> {
      server.searches.push(query)
      const from = typeof query.from === 'string' ? query.from.toLowerCase() : null
      return server.mail
        .filter((m) => !from || /^From: (.*)$/m.exec(m.source)?.[1]?.toLowerCase().includes(from))
        .map((m) => m.uid)
    }
    async *fetch(uids: number[]): AsyncGenerator<FakeMail> {
      for (const m of server.mail) if (uids.includes(m.uid)) yield m
    }
    async logout(): Promise<void> {}
    close(): void {}
  }
}))

import {
  imapConnectorToolSource,
  maskOneTimeCodes,
  readImapCodeMail,
  safeMailSummary
} from '../imap-mailbox'
import { setSecret } from '../../secrets'
import { getDB } from '../../database'

const CONNECTOR = 7

function mail(uid: number, from: string, subject: string, body: string): FakeMail {
  return {
    uid,
    internalDate: new Date(),
    source: [`From: ${from}`, 'To: me@example.com', `Subject: ${subject}`, '', body, ''].join(
      '\r\n'
    )
  }
}

async function listRecentMail(): Promise<{ subject: string; snippet: string }[]> {
  const source = imapConnectorToolSource(CONNECTOR, 'imap')!
  const result = await source.callTool('list_recent_mail', {})
  expect(result.ok).toBe(true)
  const text = (result as { result: { content: { text: string }[] } }).result.content[0]!.text
  return JSON.parse(text)
}

beforeEach(() => {
  setSecret(`connector:${CONNECTOR}:IMAP_SERVER`, 'imap.example.com')
  setSecret(`connector:${CONNECTOR}:IMAP_USER`, 'me@example.com')
  setSecret(`connector:${CONNECTOR}:IMAP_PASSWORD`, 'test-password')
  server.mail = []
  server.searches = []
  server.clients = []
  server.connectError = null
})

afterAll(() => {
  getDB().close()
  fs.rmSync(PROFILE, { recursive: true, force: true })
  if (previousData === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousData
})

describe('maskOneTimeCodes', () => {
  it('masks a code printed with spaces, hyphens or lower case', () => {
    expect(maskOneTimeCodes('Your code: 123 456.', ['123456'])).toBe('Your code: ••••••.')
    expect(maskOneTimeCodes('Use AB-12CD now', ['AB12CD'])).toBe('Use •••••• now')
    expect(maskOneTimeCodes('or type ab-12cd', ['AB12CD'])).toBe('or type ••••••')
    expect(maskOneTimeCodes('code 123456 and 123-456', ['123456'])).toBe('code •••••• and ••••••')
  })

  it('leaves text without the code unchanged', () => {
    expect(maskOneTimeCodes('Order 987654 shipped', ['123456'])).toBe('Order 987654 shipped')
  })
})

describe('safeMailSummary', () => {
  it('masks the code in the subject and in the snippet', () => {
    const summary = safeMailSummary(
      '123456 is your verification code',
      'Hello,\n\nYour verification code is 123 456. It expires soon.'
    )
    expect(summary.subject).toBe('•••••• is your verification code')
    expect(summary.snippet).toBe('Hello, Your verification code is ••••••. It expires soon.')
  })

  it('keeps an ordinary message as it is', () => {
    expect(safeMailSummary('Lunch on Friday?', 'Shall we meet at 12?')).toEqual({
      subject: 'Lunch on Friday?',
      snippet: 'Shall we meet at 12?'
    })
  })
})

describe('list_recent_mail', () => {
  it('returns no one-time code, whether in the subject or the body', async () => {
    server.mail = [
      mail(
        1,
        'Bank <no-reply@bank.com>',
        'AB12CD is your sign-in code',
        'Your sign-in code is AB-12CD.'
      )
    ]
    const [item] = await listRecentMail()
    expect(item!.subject).toBe('•••••• is your sign-in code')
    expect(item!.snippet).toBe('Your sign-in code is ••••••.')
    expect(JSON.stringify(item)).not.toMatch(/AB-?12CD/i)
  })
})

describe('readImapCodeMail', () => {
  it('searches by the bare domain, so mail from a subdomain of the site is found', async () => {
    server.mail = [
      mail(1, 'Bank <no-reply@mail.bank.com>', 'Your code', 'Your verification code is 482913.')
    ]
    const found = await readImapCodeMail(CONNECTOR, { domain: 'bank.com', sinceMs: 0 })
    expect(server.searches[0]!.from).toBe('bank.com')
    expect(found).toHaveLength(1)
    expect(found[0]!.from).toContain('no-reply@mail.bank.com')
  })
})

describe('a failing IMAP socket', () => {
  it('rejects the call instead of throwing an unhandled error event', async () => {
    server.connectError = Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })
    await expect(readImapCodeMail(CONNECTOR, { domain: 'bank.com', sinceMs: 0 })).rejects.toThrow(
      'Socket timeout'
    )
    expect(server.clients[0]!.listenerCount('error')).toBeGreaterThan(0)
  })

  it('stays handled when the socket fails after connecting', async () => {
    server.mail = [mail(1, 'a@b.com', 'Hi', 'Hello')]
    await listRecentMail()
    // A late socket error on the same client must not be thrown as an uncaught exception.
    expect(() => server.clients[0]!.emit('error', new Error('ECONNRESET'))).not.toThrow()
  })
})
