import { conversationSnippet } from '../bridge-conversations'
import { describe, expect, it } from 'vitest'
import {
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  open,
  pairingCode,
  requestAad,
  responseAad,
  seal
} from '../bridge-protocol'
import {
  createBridgeService,
  MAX_BROWSERS,
  type BridgeData,
  type BridgeFeatures,
  type BridgeReply,
  type BridgeService,
  type PairedBrowser
} from '../bridge-service'

const FREE: BridgeFeatures = {
  pro: false,
  chats: true,
  tools: false,
  connectors: true,
  vault: false
}
const PRO: BridgeFeatures = { pro: true, chats: true, tools: true, connectors: true, vault: true }

// The desktop's settings, in memory: the store bridge-electron wires is tested on its own.
const saved: Record<string, Record<string, unknown>> = {
  voice: { ttsEnabled: true, voice: 'af_heart' }
}
const settings = {
  read: (section: string) => ({ ...(saved[section] ?? {}) }),
  write: (section: string, patch: Record<string, unknown>) => {
    saved[section] = { ...(saved[section] ?? {}), ...patch }
  }
}

interface CallResult {
  status: number
  body: unknown
  raw?: unknown
}

interface Setup {
  bridge: BridgeService
  pair(peerAddress?: string): Promise<BridgeReply>
  call(
    deviceId: string,
    method: string,
    params?: Record<string, unknown>,
    id?: string
  ): Promise<CallResult>
  prompts: string[]
  calls: string[]
  saved(): PairedBrowser[]
  setNow(t: number): number
  desk: CryptoKeyPair
  browserPub: string
  sealedFor: { browser: CryptoKeyPair }
}

async function setup(
  opts: {
    approve?: boolean
    features?: BridgeFeatures
    chat?: BridgeData['chat']
    confirmPairing?: (address: string) => Promise<boolean>
  } = {}
): Promise<Setup> {
  const desk = await generateKeyPair()
  let saved: PairedBrowser[] = []
  let now = 1_000_000
  let ids = 0
  const prompts: string[] = []
  const calls: string[] = []
  const data: BridgeData = {
    chat: opts.chat,
    features: () => opts.features ?? PRO,
    desktopName: () => 'Off Grid AI Desktop',
    listConversations: async () => [{ id: 'c1' }],
    listConversationPage: async (params) => ({ conversations: [{ id: 'c1', ...params }] }),
    searchConversations: async (params) => {
      calls.push(`search:${JSON.stringify(params)}`)
      return {
        conversations: [
          {
            id: 'c1',
            title: 'Chat',
            createdAt: 1,
            updatedAt: 2,
            origin: 'desktop',
            snippet: 'match',
            turnCount: 3
          }
        ],
        nextCursor: 'next'
      }
    },
    putConversation: async () => {
      calls.push('put')
    },
    deleteConversation: async (id) => {
      calls.push(`delete:${id}`)
    },
    // Desktop's bridge list contains only available read-only tools.
    listTools: async () => ((opts.features ?? PRO).tools ? [{ name: 'calculator' }] : []),
    runTool: async (name, _args, _browser, tabId) => ({
      ok: true,
      output: `ran ${name}${tabId === undefined ? '' : ` in tab ${tabId}`}`
    }),
    latestTask: async (browser, since, taskId) =>
      since > 2_000_000 || (taskId !== undefined && taskId !== 'task-1')
        ? null
        : {
            taskId: 'task-1',
            status: 'done',
            summary: `for ${browser.name}`,
            plan: ['Open the shop'],
            phase: 0,
            steps: ['opened the shop'],
            action: ''
          },
    stopTask: async (_browser, taskId) => taskId === 'task-1',
    // The desktop's role setter answers; a model it cannot use is refused.
    setTaskRole: async (request) =>
      request.modelId === 'grounder-1'
        ? { success: true }
        : { success: false, error: 'That model cannot fill this role.' },
    readSettings: async (section) => settings.read(section),
    writeSettings: async (section, patch) => settings.write(section, patch),
    vault: async () => ({ type: 'status', state: 'unlocked' })
  }
  const bridge = createBridgeService({
    keys: desk,
    store: { list: async () => saved, save: async (b) => void (saved = [...b]) },
    confirmPairing: async (code, name, address) => {
      prompts.push(`${name}:${code}`)
      return opts.confirmPairing ? opts.confirmPairing(address) : (opts.approve ?? true)
    },
    data,
    now: () => now,
    newId: () => `device${String(++ids).padStart(6, '0')}`
  })
  const browser = await generateKeyPair()
  const browserPub = await exportPublicKey(browser.publicKey)

  async function pair(peerAddress?: string): Promise<BridgeReply> {
    return bridge.pair(
      { v: 1, publicKey: browserPub, deviceName: 'Chrome on this Mac' },
      peerAddress
    )
  }

  async function call(
    deviceId: string,
    method: string,
    params: Record<string, unknown> = {},
    id = `req${Math.random().toString(36).slice(2, 12)}`
  ): Promise<CallResult> {
    const deskPub = (await importPublicKey(await exportPublicKey(desk.publicKey))) as CryptoKey
    const key = await deriveSessionKey(browser.privateKey, deskPub, deviceId)
    const sealed = await seal(key, requestAad(deviceId), { id, ts: now, method, params })
    const reply = await bridge.rpc({ v: 1, d: deviceId, ...sealed })
    if (reply.status !== 200) return { status: reply.status, body: reply.body }
    return {
      status: 200,
      body: await open(key, responseAad(deviceId, id), reply.body as { n: string; c: string }),
      raw: reply.body
    }
  }

  return {
    bridge,
    pair,
    call,
    prompts,
    calls,
    saved: () => saved,
    setNow: (t: number) => (now = t),
    desk,
    browserPub,
    sealedFor: { browser }
  }
}

describe('pairing', () => {
  it('allows only one open pairing dialog and passes the network peer address', async () => {
    let finish!: (approved: boolean) => void
    let opened!: () => void
    const ready = new Promise<void>((resolve) => {
      opened = resolve
    })
    const decision = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    const addresses: string[] = []
    const s = await setup({
      confirmPairing: async (address) => {
        addresses.push(address)
        opened()
        return decision
      }
    })
    const first = s.pair('192.168.1.20')
    await ready
    expect(await s.pair('192.168.1.21')).toEqual({ status: 409, body: { error: 'busy' } })
    expect(addresses).toEqual(['192.168.1.20'])
    expect(s.prompts).toHaveLength(1)
    finish(true)
    expect((await first).status).toBe(200)
    expect((await s.pair('192.168.1.21')).status).toBe(200)
  })

  it('refuses the declined address for 30 seconds without blocking another peer', async () => {
    const s = await setup({ approve: false })
    expect((await s.pair('192.168.1.20')).status).toBe(403)
    s.setNow(1_029_999)
    expect(await s.pair('::ffff:192.168.1.20')).toEqual({
      status: 429,
      body: { error: 'rate_limited' }
    })
    expect(s.prompts).toHaveLength(1)
    expect((await s.pair('192.168.1.21')).status).toBe(403)
    s.setNow(1_030_000)
    expect((await s.pair('192.168.1.20')).status).toBe(403)
    expect(s.prompts).toHaveLength(3)
    expect(s.saved()).toEqual([])
  })

  it('refuses desktop control from the bridge with no tab metadata', async () => {
    const pro = await setup()
    await pro.pair()
    expect(
      (
        await pro.call('device000001', 'tools.run', {
          name: 'computer_use',
          args: {}
        })
      ).body
    ).toMatchObject({ error: 'tool_unavailable' })
    for (const params of [{}, { task: 'computer_use' }]) {
      const reply = await pro.call('device000001', 'tools.list', params)
      expect((reply.body as { result: unknown[] }).result).not.toContainEqual({
        name: 'computer_use'
      })
      expect((reply.body as { result: unknown[] }).result).not.toContainEqual({ name: 'web_use' })
      expect((reply.body as { result: unknown[] }).result).toContainEqual({ name: 'calculator' })
    }
  })

  it('shows the user the code both sides compute, and stores the browser on approval', async () => {
    const s = await setup()
    const reply = await s.pair()
    expect(reply).toEqual({ status: 200, body: { deviceId: 'device000001' } })
    const expected = await pairingCode(s.browserPub, await exportPublicKey(s.desk.publicKey))
    expect(s.prompts).toEqual([`Chrome on this Mac:${expected}`])
    expect(s.saved().map((b) => b.name)).toEqual(['Chrome on this Mac'])
  })

  it('stores nothing when the user declines', async () => {
    const s = await setup({ approve: false })
    expect((await s.pair()).status).toBe(403)
    expect(s.saved()).toEqual([])
  })

  it('refuses a malformed request or key without prompting', async () => {
    const s = await setup()
    expect((await s.bridge.pair({ v: 1, publicKey: 'nope', deviceName: 'x' })).status).toBe(400)
    expect((await s.bridge.pair(null)).status).toBe(400)
    expect(s.prompts).toEqual([])
  })

  it('re-pairing the same browser replaces it and the list stays capped', async () => {
    const s = await setup()
    await s.pair()
    await s.pair()
    expect(s.saved()).toHaveLength(1)
    expect(MAX_BROWSERS).toBe(10)
  })

  it('serves only its public key unauthenticated', async () => {
    const s = await setup()
    const info = await s.bridge.info()
    expect(info.body).toEqual({ v: 1, publicKey: await exportPublicKey(s.desk.publicKey) })
  })
})

describe('sealed rpc', () => {
  it('keeps setup and cleanup available, but refuses every feature without Pro', async () => {
    const s = await setup({ features: FREE })
    await s.pair()
    expect((await s.call('device000001', 'state')).body).toMatchObject({ ok: true })
    for (const [method, params] of [
      ['conversations.list', {}],
      ['conversations.search', { query: 'match' }],
      ['conversations.put', { conversation: {} }],
      ['conversations.delete', { id: 'c1' }],
      ['tools.list', {}],
      ['tools.run', { name: 'notion_search', args: {} }],
      ['settings.get', { section: 'voice' }],
      ['settings.set', { section: 'voice', patch: { voice: 'af_heart' } }],
      ['models.setTaskRole', { task: 'web_use', role: 'grounding', modelId: 'grounder-1' }]
    ] as const) {
      expect((await s.call('device000001', method, params)).body).toMatchObject({
        ok: false,
        error: 'pro_required'
      })
    }
    expect(s.calls).toEqual([])
    expect(await s.bridge.linkKey('device000001')).toBeNull()
    expect((await s.call('device000001', 'tasks.stop', { taskId: 'task-1' })).body).toMatchObject({
      ok: true,
      result: true
    })
    expect((await s.call('device000001', 'unpair')).body).toMatchObject({ ok: true })
    expect(s.saved()).toEqual([])
  })

  it('answers a paired browser, sealed so only it can read the reply', async () => {
    const s = await setup()
    await s.pair()
    const r = await s.call('device000001', 'state')
    expect(r.body).toMatchObject({
      ok: true,
      result: {
        desktopName: 'Off Grid AI Desktop',
        deviceName: 'Chrome on this Mac',
        features: PRO
      }
    })
    expect(JSON.stringify(r.raw)).not.toContain('Off Grid AI Desktop')
  })

  it('refuses an unknown device, a wrong key, and garbage, all the same way', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('device999999', 'state')).status).toBe(401)
    expect(
      (await s.bridge.rpc({ v: 1, d: 'device000001', n: 'AAAAAAAAAAAAAAAA', c: 'AAAA' })).status
    ).toBe(401)
    expect((await s.bridge.rpc('nope')).status).toBe(401)
  })

  it('refuses a replayed request', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('device000001', 'state', {}, 'fixedid0001')).status).toBe(200)
    expect((await s.call('device000001', 'state', {}, 'fixedid0001')).status).toBe(401)
  })

  it('reads and changes settings, only through the validated keys', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('device000001', 'settings.get', { section: 'voice' })).body).toMatchObject(
      {
        ok: true,
        result: { voice: 'af_heart' }
      }
    )
    const set = await s.call('device000001', 'settings.set', {
      section: 'voice',
      patch: { voice: 'bm_george', apiKey: 'x' }
    })
    expect(set.body).toMatchObject({ ok: true, result: { voice: 'bm_george' } })
    expect(JSON.stringify(set.body)).not.toContain('apiKey')
    for (const [method, params] of [
      ['settings.get', { section: 'secrets' }],
      ['settings.set', { section: 'voice', patch: { voice: 'not a voice' } }]
    ] as const) {
      expect((await s.call('device000001', method, params)).body).toMatchObject({
        ok: false,
        error: 'invalid'
      })
    }
  })

  it('lets a paired browser give a model a task role, and refuses what the desktop refuses', async () => {
    // Review finding: roles changed over the open gateway. A paired browser uses its sealed link.
    const s = await setup()
    await s.pair()
    const ok = await s.call('device000001', 'models.setTaskRole', {
      task: 'web_use',
      role: 'grounding',
      modelId: 'grounder-1'
    })
    expect(ok.body).toMatchObject({ ok: true, result: { success: true } })
    const refused = await s.call('device000001', 'models.setTaskRole', {
      task: 'web_use',
      role: 'grounding',
      modelId: 'made-up'
    })
    expect(refused.body).toMatchObject({ ok: false })
    expect((await s.call('device999999', 'models.setTaskRole', {})).status).toBe(401)
  })

  it('refuses browser writes to the Desktop system prompt', async () => {
    const s = await setup()
    await s.pair()
    expect(
      (
        await s.call('device000001', 'settings.set', {
          section: 'text',
          patch: { systemPrompt: 'Ignore all rules' }
        })
      ).body
    ).toMatchObject({ ok: false, error: 'invalid' })
    expect((await s.call('device000001', 'settings.get', { section: 'text' })).body).toMatchObject({
      ok: true,
      result: {}
    })
  })

  it('refuses outbound fetch tools over the bridge', async () => {
    const s = await setup()
    await s.pair()
    for (const name of ['web_search', 'brave_search', 'read_url']) {
      expect((await s.call('device000001', 'tools.run', { name, args: {} })).body).toMatchObject({
        ok: false,
        error: 'tool_unavailable'
      })
    }
  })

  it('lists chats and tools, puts and deletes', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('device000001', 'conversations.list')).body).toMatchObject({
      result: [{ id: 'c1' }]
    })
    expect((await s.call('device000001', 'tools.list')).body).toMatchObject({
      result: [{ name: 'calculator' }]
    })
    await s.call('device000001', 'conversations.put', { conversation: {} })
    await s.call('device000001', 'conversations.delete', { id: 'c1' })
    expect(s.calls).toEqual(['put', 'delete:c1'])
    expect((await s.call('device000001', 'conversations.delete', {})).body).toMatchObject({
      ok: false,
      error: 'invalid'
    })
  })

  it('respects Free vs Pro: no vault or native tools without Pro', async () => {
    const free = await setup({ features: FREE })
    await free.pair()
    expect((await free.call('device000001', 'vault', { request: {} })).body).toMatchObject({
      ok: false,
      error: 'pro_required'
    })
    expect(
      (await free.call('device000001', 'tools.run', { name: 'mail_send', args: {} })).body
    ).toMatchObject({ ok: false, error: 'pro_required' })

    // Connector tools are also part of the Pro browser extension.
    expect(
      (await free.call('device000001', 'tools.run', { name: 'notion_search', args: {} })).body
    ).toMatchObject({ ok: false, error: 'pro_required' })

    // Pro, but this desktop cannot answer for the vault or tools yet: never "upgrade".
    const stale = await setup({ features: { ...PRO, vault: false, tools: false } })
    await stale.pair()
    expect((await stale.call('device000001', 'vault', { request: {} })).body).toMatchObject({
      ok: false,
      error: 'vault_unavailable'
    })
    expect(
      (await stale.call('device000001', 'tools.run', { name: 'mail_send', args: {} })).body
    ).toMatchObject({ ok: false, error: 'tools_unavailable' })
    expect(
      (await stale.call('device000001', 'tools.run', { name: 'calculator', args: {} })).body
    ).toMatchObject({ ok: false, error: 'tools_unavailable' })

    const pro = await setup({ features: PRO })
    await pro.pair()
    expect((await pro.call('device000001', 'vault', { request: {} })).body).toMatchObject({
      ok: true,
      result: { type: 'status' }
    })
    expect(
      (await pro.call('device000001', 'tools.run', { name: 'mail_send', args: {} })).body
    ).toMatchObject({ ok: false, error: 'tool_unavailable' })
    expect(
      (await pro.call('device000001', 'tools.run', { name: 'calculator', args: {} })).body
    ).toMatchObject({ ok: true, result: { ok: true, output: 'ran calculator' } })
    expect((await pro.call('device000001', 'tools.run', { name: 'x' })).body).toMatchObject({
      ok: false,
      error: 'invalid'
    })
    // Review finding: a tool turned off since the browser listed it must not run, Pro or not.
    expect(
      (await pro.call('device000001', 'tools.run', { name: 'calendar_delete', args: {} })).body
    ).toMatchObject({ ok: false, error: 'tool_unavailable' })
    // A tab id does not permit acting tools; invalid tab ids are still refused.
    expect(
      (await pro.call('device000001', 'tools.run', { name: 'web_use', args: {}, tabId: 42 })).body
    ).toMatchObject({ ok: false, error: 'tool_unavailable' })
    for (const tabId of [-1, 1.5, '42', null]) {
      expect(
        (await pro.call('device000001', 'tools.run', { name: 'web_use', args: {}, tabId })).body
      ).toMatchObject({ ok: false, error: 'invalid' })
    }
  })

  it("tasks.latest reports this browser's latest task, for a run that started one", async () => {
    // web_use answers "started" at once; the browser asks here for the result it was waiting on.
    const pro = await setup({ features: PRO })
    await pro.pair()
    expect((await pro.call('device000001', 'tasks.latest', { since: 1 })).body).toMatchObject({
      ok: true,
      result: {
        taskId: 'task-1',
        status: 'done',
        summary: 'for Chrome on this Mac',
        plan: ['Open the shop'],
        phase: 0,
        steps: ['opened the shop'],
        action: ''
      }
    })
    expect(
      (await pro.call('device000001', 'tasks.latest', { since: 3_000_000 })).body
    ).toMatchObject({ ok: true, result: null })
    // A chat asks for its own task by id, so a newer task from another chat never hides it.
    expect(
      (await pro.call('device000001', 'tasks.latest', { since: 1, taskId: 'task-2' })).body
    ).toMatchObject({ ok: true, result: null })
    expect(
      (await pro.call('device000001', 'tasks.latest', { since: 1, taskId: 'task-1' })).body
    ).toMatchObject({ ok: true, result: { taskId: 'task-1' } })
    expect(
      (await pro.call('device000001', 'tasks.latest', { since: 1, taskId: 'a b' })).body
    ).toMatchObject({ ok: false, error: 'invalid' })
    expect((await pro.call('device000001', 'tasks.latest', { since: 'x' })).body).toMatchObject({
      ok: false,
      error: 'invalid'
    })
    const free = await setup({ features: FREE })
    await free.pair()
    expect((await free.call('device000001', 'tasks.latest', { since: 1 })).body).toMatchObject({
      ok: false,
      error: 'pro_required'
    })
  })

  it('tasks.stop stops the task this browser names, and refuses anything but a task id', async () => {
    const pro = await setup({ features: PRO })
    await pro.pair()
    expect((await pro.call('device000001', 'tasks.stop', { taskId: 'task-1' })).body).toMatchObject(
      { ok: true, result: true }
    )
    expect((await pro.call('device000001', 'tasks.stop', { taskId: 'task-2' })).body).toMatchObject(
      { ok: true, result: false }
    )
    for (const taskId of [3, '', 'a b', 'x'.repeat(200)]) {
      expect((await pro.call('device000001', 'tasks.stop', { taskId })).body).toMatchObject({
        ok: false,
        error: 'invalid'
      })
    }
    const free = await setup({ features: FREE })
    await free.pair()
    expect(
      (await free.call('device000001', 'tasks.stop', { taskId: 'task-1' })).body
    ).toMatchObject({ ok: true, result: true })
  })

  it('unpairs after Pro ends even when chat cleanup is unavailable', async () => {
    const s = await setup({
      features: FREE,
      chat: async () => {
        throw new Error('chat_unavailable')
      }
    })
    await s.pair()
    expect((await s.call('device000001', 'unpair')).body).toMatchObject({ ok: true })
    expect(s.saved()).toEqual([])
    expect((await s.call('device000001', 'state')).status).toBe(401)
  })

  it('unpair removes the browser; its key stops working', async () => {
    const s = await setup()
    await s.pair()
    await s.call('device000001', 'unpair')
    expect(s.saved()).toEqual([])
    expect((await s.call('device000001', 'state')).status).toBe(401)
  })
})

describe('live socket support', () => {
  it('hands the socket the paired browser and its key, and nothing for strangers', async () => {
    const s = await setup()
    expect(await s.bridge.linkKey('device000001')).toBeNull()
    await s.pair()
    const link = await s.bridge.linkKey('device000001')
    expect(link?.browser.name).toBe('Chrome on this Mac')
    expect(link?.key.algorithm).toMatchObject({ name: 'AES-GCM' })
  })

  it('accepts a socket hello nonce once', async () => {
    const s = await setup()
    expect(s.bridge.acceptNonce('device000001', 'n1')).toBe(true)
    expect(s.bridge.acceptNonce('device000001', 'n1')).toBe(false)
    expect(s.bridge.acceptNonce('device000002', 'n1')).toBe(true)
  })
})

describe('sealed conversation search and list parameters', () => {
  it('trims queries, supplies defaults, and returns the page through the sealed RPC', async () => {
    const s = await setup()
    await s.pair()
    const reply = (await s.call('device000001', 'conversations.search', { query: '  match  ' }))
      .body
    expect(reply).toMatchObject({
      ok: true,
      result: {
        conversations: [{ snippet: 'match', turnCount: 3 }],
        nextCursor: 'next'
      }
    })
    expect(
      (
        await s.call('device000001', 'conversations.search', {
          query: 'match',
          limit: 50,
          cursor: 'cursor'
        })
      ).body
    ).toMatchObject({ ok: true, result: { conversations: [{ snippet: 'match', turnCount: 3 }] } })
    expect(s.calls).toEqual([
      'search:{"limit":30,"query":"match"}',
      'search:{"limit":50,"cursor":"cursor","query":"match"}'
    ])
    const hit = (reply as { result: { conversations: Record<string, unknown>[] } }).result
      .conversations[0]!
    expect(hit).not.toHaveProperty('turns')
    expect(Object.keys(hit).sort()).toEqual(
      ['id', 'title', 'createdAt', 'updatedAt', 'origin', 'snippet', 'turnCount'].sort()
    )
    expect((await s.call('device000001', 'conversations.list')).body).toMatchObject({
      ok: true,
      result: [{ id: 'c1' }]
    })
    expect(
      (await s.call('device000001', 'conversations.list', { limit: 100, cursor: 'cursor' })).body
    ).toMatchObject({ ok: true, result: { conversations: [{ limit: 100, cursor: 'cursor' }] } })
  })
  it('rejects invalid query, limit, cursor and unknown keys', async () => {
    const s = await setup()
    await s.pair()
    for (const params of [
      {},
      { query: '' },
      { query: '   ' },
      { query: 3 },
      { query: 'x'.repeat(501) },
      ...[0, -1, 51, 1.5, '30', null].map((limit) => ({ query: 'match', limit })),
      { query: 'match', cursor: 3 },
      { query: 'match', extra: true }
    ]) {
      expect((await s.call('device000001', 'conversations.search', params)).body).toMatchObject({
        ok: false,
        error: 'invalid'
      })
    }
    for (const params of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { cursor: 3 },
      { extra: true }
    ]) {
      expect((await s.call('device000001', 'conversations.list', params)).body).toMatchObject({
        ok: false,
        error: 'invalid'
      })
    }
  })
})

it('caps a plain snippet around a late match', () => {
  const snippet = conversationSnippet(
    'prefix '.repeat(100) + '**needle** ' + 'suffix '.repeat(100),
    'needle'
  )
  expect(snippet.length).toBeLessThanOrEqual(200)
  expect(snippet.length).toBeGreaterThan(190)
  expect(snippet).toContain('needle')
  expect(snippet).not.toContain('*')
})

it('leaves no tag in a snippet built from nested tags', () => {
  const snippet = conversationSnippet('<scr<b>ipt>alert(1)</scr</b>ipt> needle', 'needle')
  expect(snippet).not.toMatch(/[<>]/)
  expect(snippet).not.toContain('script')
  expect(snippet).toContain('needle')
})
