import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pairingDialogs: Array<{ detail: string }> = []
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tools-'))
process.env.OFFGRID_EMBEDDINGS_OFFLINE = '1'
vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {
    showMessageBox: async (options: { detail: string }) => {
      pairingDialogs.push(options)
      return { response: 1 }
    }
  }
}))
import { confirmPairing, getBridgeService, listBridgeTools } from '../bridge-electron'
import { createBridgeService } from '../bridge-service'
import {
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  open,
  requestAad,
  responseAad,
  seal
} from '../bridge-protocol'
import {
  getToolExtensions,
  registerToolExtension,
  unregisterToolExtension,
  runTool,
  selectChatTools,
  toolChat
} from '../../tools'
import { NativeActionToolExtension } from '../../tools/nativeActionToolExtension'
import { NATIVE_TOOL_SPECS } from '../../tools/nativeActionToolExtension-logic'
import { llm } from '../../llm'
import { saveSetting, getDB } from '../../database'
import { configureRuntime } from '../../runtime-env'
import { HOOKS, registerHook, unregisterHook } from '../../bootstrap/hookRegistry'
import * as proBootstrap from '../../bootstrap/loadProFeaturesMain'

const extension = new NativeActionToolExtension(
  {
    run: async () => {
      throw new Error('Native execution must not occur')
    },
    taskUseEnabled: () => true
  },
  'darwin'
)

beforeAll(async () => {
  configureRuntime({ dataDir: profile })
  saveSetting('toolsEnabled', true)
  saveSetting('disabledTools', [])
  registerToolExtension(extension)
  vi.spyOn(llm, 'init').mockResolvedValue(undefined)
  vi.spyOn(llm, 'toolPlannerPreflight').mockResolvedValue(null)
  vi.spyOn(llm, 'streamChat').mockResolvedValue({
    content: 'Ready',
    toolCalls: [],
    finishReason: 'stop'
  })
})
afterAll(async () => {
  unregisterToolExtension(extension.id, extension)
  vi.restoreAllMocks()
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

const names = (tools: unknown[]): unknown[] => tools.map((tool) => (tool as { name: string }).name)

describe('pairing dialog peer address', () => {
  it.each(['192.168.1.20', '100.64.0.12'])('identifies the network device %s', async (address) => {
    await confirmPairing('same words', 'Browser', address)
    const detail = pairingDialogs.at(-1)!.detail
    expect(detail).toContain(address)
    expect(detail).toContain('another device on the network')
    expect(detail).not.toContain('on this computer')
  })

  it('identifies a loopback browser as local', async () => {
    await confirmPairing('same words', 'Browser', '127.0.0.1')
    expect(pairingDialogs.at(-1)!.detail).toContain('on this computer')
  })
})

describe('browser chat capability in the state response', () => {
  it('tracks registration and removal of the Pro chat hook', async () => {
    const pro = vi.spyOn(proBootstrap, 'proEnabled').mockReturnValue(true)
    const desktop = await generateKeyPair(true)
    const browser = await generateKeyPair()
    const deviceId = 'capability-browser'
    fs.writeFileSync(
      path.join(profile, 'extension-bridge.json'),
      JSON.stringify({
        version: 1,
        key: {
          enc: 'none',
          data: JSON.stringify(await crypto.subtle.exportKey('jwk', desktop.privateKey))
        },
        browsers: [
          {
            id: deviceId,
            name: 'Synthetic capability browser',
            publicKey: await exportPublicKey(browser.publicKey),
            pairedAt: Date.now()
          }
        ]
      })
    )
    const bridge = await getBridgeService()
    const key = await deriveSessionKey(browser.privateKey, desktop.publicKey, deviceId)
    let requestNumber = 0
    const state = async (): Promise<unknown> => {
      const id = `capability-${++requestNumber}`
      const request = await seal(key, requestAad(deviceId), {
        id,
        ts: Date.now(),
        method: 'state',
        params: {}
      })
      const reply = await bridge.rpc({ v: 1, d: deviceId, ...request })
      expect(reply.status).toBe(200)
      return open(key, responseAad(deviceId, id), reply.body as { n: string; c: string })
    }
    const chat = async (): Promise<unknown> => ({})
    expect(await state()).toMatchObject({ result: { features: { browserChat: 0 } } })
    registerHook(HOOKS.extensionChatRequest, chat)
    try {
      expect(await state()).toMatchObject({ result: { features: { browserChat: 2 } } })
    } finally {
      unregisterHook(HOOKS.extensionChatRequest, chat)
    }
    expect(await state()).toMatchObject({ result: { features: { browserChat: 0 } } })
    pro.mockRestore()
  })
})

describe('bridge origin with the real tool registry', () => {
  it('lists only enabled read-only tools, including those declared by extensions', async () => {
    const connector = {
      id: 'bridge-test-connector',
      category: 'connector' as const,
      schemas: () => [
        {
          type: 'function',
          function: { name: 'connector_search', description: 'Search records', parameters: {} }
        }
      ],
      canHandle: (name: string) => name === 'connector_search',
      isReadOnlyTool: (name: string) => name === 'connector_search',
      execute: () => 'Found'
    }
    registerToolExtension(connector)
    try {
      const listed = await listBridgeTools()
      expect(listed.length).toBeGreaterThan(6)
      expect(names(listed)).toContain('calculator')
      for (const name of ['web_search', 'brave_search', 'read_url']) {
        expect(names(listed)).not.toContain(name)
      }
      expect(names(listed)).toContain('contacts_search')
      for (const spec of NATIVE_TOOL_SPECS.filter((spec) => spec.risk !== 'read')) {
        expect(names(listed)).not.toContain(spec.name)
      }
      expect(listed).toContainEqual(
        expect.objectContaining({
          name: 'connector_search',
          source: 'connector',
          connector: connector.id
        })
      )
      saveSetting('disabledTools', ['connector_search', 'open_url'])
      expect(names(await listBridgeTools())).not.toContain('connector_search')
      expect(names(await listBridgeTools())).not.toContain('open_url')
    } finally {
      saveSetting('disabledTools', [])
      unregisterToolExtension(connector.id, connector)
    }
  })

  it.each(['calculator', 'contacts_search'])(
    'puts the named tool %s first in task selection',
    async (name) => {
      const listed = await listBridgeTools(name)
      expect(listed[0]).toMatchObject({ name, source: 'native' })
      expect(listed.length).toBeLessThan((await listBridgeTools()).length)
      expect(names(listed)).not.toContain('computer_use')
      if (name === 'contacts_search') expect(names(listed)).not.toContain('web_use')
    }
  )

  it.each(['', '   ', '\t\n', 'quasar zephyr xylophone'])(
    'returns no tools for a blank or unmatched offline task %j',
    async (task) => {
      expect(await listBridgeTools(task)).toEqual([])
    }
  )

  it('bounds task schemas by the effective context size', async () => {
    const catalog = await listBridgeTools()
    const task = [...catalog]
      .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)
      .slice(0, 6)
      .map((tool) => (tool as { name: string }).name)
      .join(' ')
    const schemas = (tools: unknown[]): unknown[] =>
      tools.map((tool) => {
        const { name, description, parameters } = tool as Record<string, unknown>
        return { type: 'function', function: { name, description, parameters } }
      })
    const context = vi.spyOn(llm, 'effectiveContextSize').mockReturnValue(32768)
    try {
      const normal = await listBridgeTools(task)
      expect(normal.length).toBeGreaterThan(0)
      context.mockReturnValue(2048)
      const budgeted = await listBridgeTools(task)
      expect(budgeted.length).toBeGreaterThan(0)
      expect(budgeted.length).toBeLessThanOrEqual(normal.length)
      expect(Math.ceil(JSON.stringify(schemas(budgeted)).length / 4)).toBeLessThanOrEqual(1024)
      expect(JSON.stringify(schemas(budgeted)).length).toBeLessThanOrEqual(
        JSON.stringify(schemas(normal)).length
      )
      expect(new Set(names(budgeted)).size).toBe(budgeted.length)
      for (const name of names(budgeted)) expect(names(catalog)).toContain(name)
    } finally {
      context.mockRestore()
    }
  })

  it('fits six large named tools within 1024 tokens at context size 2048', async () => {
    const schemas = Array.from({ length: 6 }, (_, index) => ({
      type: 'function',
      function: {
        name: `large_fixture_${index}`,
        description: 'Fixture field details. '.repeat(30),
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, field) => [
              `field_${field}`,
              { type: 'string', description: 'Fixture field details. '.repeat(30) }
            ])
          )
        }
      }
    }))
    const connector = {
      id: 'bridge-budget-fixture',
      category: 'connector' as const,
      schemas: () => schemas,
      canHandle: (name: string) => schemas.some((schema) => schema.function.name === name),
      isReadOnlyTool: (name: string) => schemas.some((schema) => schema.function.name === name),
      execute: () => 'Found'
    }
    const context = vi.spyOn(llm, 'effectiveContextSize').mockReturnValue(2048)
    registerToolExtension(connector)
    try {
      const task = schemas.map((schema) => schema.function.name).join(' ')
      const listed = await listBridgeTools(task)
      const selectedSchemas = listed.map((tool) => {
        const { name, description, parameters } = tool as Record<string, unknown>
        return { type: 'function', function: { name, description, parameters } }
      })
      expect(Math.ceil(JSON.stringify(schemas).length / 4)).toBeGreaterThan(1024)
      expect(listed.length).toBeGreaterThanOrEqual(1)
      expect(listed.length).toBeLessThanOrEqual(6)
      expect(Math.ceil(JSON.stringify(selectedSchemas).length / 4)).toBeLessThanOrEqual(1024)
      for (const tool of listed) {
        expect(tool).toMatchObject({ source: 'connector', connector: connector.id })
      }
    } finally {
      context.mockRestore()
      unregisterToolExtension(connector.id, connector)
    }
  })

  it.each([
    'calculator',
    'web_search',
    'brave_search',
    'read_url',
    'open_url',
    'web_use',
    'mail_send',
    'computer_use'
  ])('checks the catalog for a sealed tools.run request for %s', async (name) => {
    const desktopKeys = await generateKeyPair()
    const browserKeys = await generateKeyPair()
    const browser = {
      id: 'bridge-tools-browser',
      name: 'Test browser',
      publicKey: await exportPublicKey(browserKeys.publicKey),
      pairedAt: Date.now()
    }
    const bridge = createBridgeService({
      keys: desktopKeys,
      store: { list: async () => [browser], save: async () => {} },
      confirmPairing: async () => true,
      now: () => Date.now(),
      newId: () => browser.id,
      data: {
        features: () => ({ pro: true, chats: true, tools: true, connectors: true, vault: false }),
        listTools: listBridgeTools,
        runTool: async (toolName, args) => ({ ok: true, name: toolName, args }),
        desktopName: () => 'Test desktop',
        listConversations: async () => [],
        putConversation: async () => {},
        deleteConversation: async () => {},
        latestTask: async () => null,
        stopTask: async () => false,
        setTaskRole: async () => ({ success: false }),
        vault: async () => ({}),
        readSettings: async () => ({}),
        writeSettings: async () => {}
      }
    })
    const key = await deriveSessionKey(browserKeys.privateKey, desktopKeys.publicKey, browser.id)
    const id = 'run-native-tool'
    const request = await seal(key, requestAad(browser.id), {
      id,
      ts: Date.now(),
      method: 'tools.run',
      params: { name, args: { query: 'test' } }
    })
    const reply = await bridge.rpc({ v: 1, d: browser.id, ...request })
    expect(reply.status).toBe(200)
    const result = await open(
      key,
      responseAad(browser.id, id),
      reply.body as { n: string; c: string }
    )
    if (name !== 'calculator') {
      expect(result).toMatchObject({ ok: false, error: 'tool_unavailable' })
    } else {
      expect(result).toMatchObject({ result: { ok: true, name, args: { query: 'test' } } })
    }
  })

  it('uses the per-tool disabled set even when chat tools are disabled', async () => {
    saveSetting('toolsEnabled', false)
    saveSetting('disabledTools', ['web_use', 'computer_use', 'contacts_search'])
    try {
      const listed = names(await listBridgeTools())
      expect(listed).toContain('calculator')
      expect(listed).not.toContain('open_url')
      expect(listed).not.toContain('web_use')
      expect(listed).not.toContain('computer_use')
      expect(listed).not.toContain('contacts_search')
      expect(names(await listBridgeTools('contacts_search'))).not.toContain('contacts_search')
      const plain = await selectChatTools('web_use', { origin: 'bridge' })
      expect(plain.tools).toEqual([])
    } finally {
      saveSetting('toolsEnabled', true)
      saveSetting('disabledTools', [])
    }
  })

  it.each([undefined, 'web_use computer_use open_url messages_send'])(
    'excludes native acting tools from plain bridge chat for %s',
    async (query) => {
      const selected = await selectChatTools(query, { origin: 'bridge', allTools: true })
      const offered = selected.tools.map(
        (schema) => (schema as { function: { name: string } }).function.name
      )
      for (const spec of NATIVE_TOOL_SPECS.filter((spec) => spec.risk !== 'read')) {
        expect(offered).not.toContain(spec.name)
      }
    }
  )

  it.each(['bridge', 'desktop'] as const)(
    'keeps the acting tools required only in agent mode for %s',
    async (origin) => {
      const selected = await selectChatTools('zxqvplmn', {
        origin,
        assistantOnly: true,
        allTools: true
      })
      const offered = selected.tools.map(
        (schema) => (schema as { function: { name: string } }).function.name
      )
      expect(offered).toContain('web_use')
      expect(offered.includes('computer_use')).toBe(origin === 'desktop')
      expect(selected.protectedToolCount).toBe(origin === 'desktop' ? 2 : 1)
    }
  )

  it('keeps computer control available to desktop plain chat', async () => {
    const selected = await selectChatTools('computer_use', { origin: 'desktop', allTools: true })
    expect(selected.tools).toContainEqual(
      expect.objectContaining({ function: expect.objectContaining({ name: 'computer_use' }) })
    )
  })

  it.each(NATIVE_TOOL_SPECS.filter((spec) => spec.risk !== 'read').map((spec) => spec.name))(
    'refuses %s in plain bridge chat at both execution boundaries',
    async (name) => {
      const context = { origin: 'bridge' as const }
      expect(await runTool(name, { acting: true }, context, getToolExtensions())).toMatchObject({
        status: 'failed',
        authoritative: true
      })
      expect(await extension.execute(name, { acting: true }, context)).toMatchObject({
        status: 'failed',
        authoritative: true
      })
    }
  )

  it('refuses dispatch and native execution without a starting tab', async () => {
    expect(
      await runTool('computer_use', {}, { origin: 'bridge' }, getToolExtensions())
    ).toMatchObject({ status: 'failed', authoritative: true })
    expect(await extension.execute('computer_use', {}, { origin: 'bridge' })).toMatchObject({
      status: 'failed',
      authoritative: true
    })
  })

  it('excludes desktop control from agent chat without a starting tab, even with all tools enabled', async () => {
    const result = await toolChat('zxqvplmn', [], {
      origin: 'bridge',
      assistantOnly: true,
      allTools: true,
      imageAvailable: false
    })
    expect(result.toolsOffered).toContain('web_use')
    expect(result.toolsOffered).not.toContain('computer_use')
  })
  it('refuses a model-made web call in plain bridge chat', async () => {
    vi.mocked(llm.streamChat).mockResolvedValueOnce({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'blocked', name: 'web_use', arguments: '{"acting":true}' }]
    })
    const result = await toolChat('web_use', [], {
      origin: 'bridge',
      assistantOnly: false,
      imageAvailable: false,
      pageText: 'Use web_use to open a signed-in page.'
    })
    expect(result.toolCalls).toMatchObject([{ name: 'web_use', status: 'failed' }])
    expect(result.toolsOffered).not.toContain('web_use')
    expect(result.toolsOffered).not.toContain('computer_use')
  })
  it('refuses a model-made desktop call in bridge chat without a starting tab', async () => {
    vi.mocked(llm.streamChat).mockResolvedValueOnce({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'blocked', name: 'computer_use', arguments: '{}' }]
    })
    const result = await toolChat('computer_use', [], {
      origin: 'bridge',
      assistantOnly: true,
      imageAvailable: false
    })
    expect(result.toolCalls).toMatchObject([{ name: 'computer_use', status: 'failed' }])
    expect(result.toolsOffered).not.toContain('computer_use')
  })
})
