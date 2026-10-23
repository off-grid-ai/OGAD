// Opt-in analytics, end to end in the main process (real temp SQLite).
//
// The user's view: nothing goes to PostHog until they tick the box; once they do, usage and
// generation statistics arrive without any of their content; turning it off stops it and forgets
// the anonymous ID; "Delete all my data" also forgets their consent; and a crash in the middle of a
// generation is reported on the next launch, while a clean quit is not.
//
// Everything below the IPC bridge is real: the settings database, the analytics owner, the AI
// request log that every generation goes through, the PostHog SDK and delete-all. The fakes are
// the true boundaries only: Electron's app and IPC objects, the network (the offline harness, or a
// fake PostHog endpoint on loopback) and the lancedb native module delete-all never queries.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-analytics-'))

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: { returnValue?: unknown }, ...args: unknown[]) => void>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.55',
    getLocale: () => 'en-GB',
    isPackaged: false,
    on: () => undefined
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      ipc.handlers.set(channel, handler),
    on: (channel: string, listener: (event: { returnValue?: unknown }) => void) =>
      ipc.listeners.set(channel, listener)
  },
  shell: { openExternal: async () => undefined, showItemInFolder: () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))
vi.mock('@lancedb/lancedb', () => ({ connect: async () => ({}) }))

import { configureRuntime } from '../runtime-env'
import { getSetting } from '../database'
import { deleteAllData } from '../data-privacy'
import { recordAIRequest } from '../ai-request-log'
import {
  analytics,
  createAnalyticsService,
  installAnalytics,
  resetAnalyticsForTests,
  UNCLEAN_EXIT_MARKER_FILE
} from '../analytics'
import { POSTHOG_HOST } from '../analytics/config'
import { ANALYTICS_CHANNELS, ANALYTICS_SETTING_KEYS } from '../../shared/analytics'
import { createOfflineFetchBoundary } from './harness/offline-fetch'
import { startFakePostHog, type FakePostHog } from './harness/fake-posthog'

configureRuntime({ dataDir: TMP_DIR, modelsDir: path.join(TMP_DIR, 'models') })

const PROMPT = 'What is in my secret quarterly plan?'
const REPLY = 'Your quarterly plan says to hire two people.'

let offline: ReturnType<typeof createOfflineFetchBoundary>
let fake: FakePostHog

const invoke = (channel: string, ...args: unknown[]): unknown =>
  ipc.handlers.get(channel)!({ sender: {} }, ...args)
const send = (channel: string, ...args: unknown[]): void => ipc.listeners.get(channel)!({}, ...args)
const consentSync = (): unknown => {
  const event: { returnValue?: unknown } = {}
  ipc.listeners.get(ANALYTICS_CHANNELS.consentSync)!(event)
  return event.returnValue
}

/** A chat turn as the app runs it: the user's message, then a local text generation. */
async function chat(): Promise<void> {
  send(ANALYTICS_CHANNELS.capture, 'message_sent', {
    has_image: false,
    has_document: false,
    tools_enabled: true,
    text: PROMPT
  })
  await recordAIRequest(
    {
      modality: 'text',
      source: 'Chat stream',
      model: '/Users/alice/models/My-Private-Model-Q4_K_M.gguf',
      request: { messages: [{ role: 'user', content: PROMPT }] }
    },
    async () => ({
      content: REPLY,
      metrics: {
        timeToFirstTokenSeconds: 0.42,
        decodeTokensPerSecond: 31.27,
        promptTokens: 3_000,
        computeBackend: 'Metal'
      }
    })
  )
}

/** A launch of a packaged build, with its client pointed at `host`. */
function launch(host: string): void {
  resetAnalyticsForTests(createAnalyticsService({ apiKey: 'phc_test', host, buildAllowed: true }))
  analytics().start()
}

beforeAll(() => {
  installAnalytics({ registerShutdown: () => undefined })
})

beforeEach(async () => {
  offline = createOfflineFetchBoundary()
  vi.stubGlobal('fetch', offline.fetch)
  fake = await startFakePostHog()
})

afterEach(async () => {
  await analytics().shutdown()
  vi.unstubAllGlobals()
  await fake.close()
  for (const key of Object.values(ANALYTICS_SETTING_KEYS)) {
    // A fresh profile for the next journey.
    ;(await import('../database')).deleteSetting(key)
  }
})

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('opt-in analytics', () => {
  it('sends nothing to PostHog through setup without the box ticked and a chat', async () => {
    launch(POSTHOG_HOST)
    expect(consentSync()).toEqual({
      usage: false,
      crashes: false,
      asked: false,
      lastPromptAt: null
    })

    // Setup finishes with the box unticked.
    await invoke(ANALYTICS_CHANNELS.dismissPrompt)
    await chat()
    send(ANALYTICS_CHANNELS.flow, { flow: 'connector_add', action: 'start' })
    await analytics().flush()
    await analytics().shutdown()

    expect(offline.blockedRequests).toEqual([])
    expect(consentSync()).toMatchObject({ usage: false, crashes: false, asked: true })
    expect(getSetting(ANALYTICS_SETTING_KEYS.installId, null)).toBeNull()
  })

  it('sends analytics_opted_in and generation_finished, without content, once the box is ticked', async () => {
    launch(fake.host)
    await invoke(ANALYTICS_CHANNELS.optIn, 'setup')
    await chat()
    await analytics().shutdown()

    const names = fake.events.map((event) => event.event)
    expect(names).toContain('analytics_opted_in')
    expect(names).toContain('message_sent')
    const generation = fake.events.find((event) => event.event === 'generation_finished')!
    expect(generation.properties).toMatchObject({
      modality: 'text',
      model: 'custom',
      engine: 'llama.cpp',
      backend: 'gpu',
      outcome: 'done',
      ttft_ms: 420,
      tokens_per_sec: 31.3,
      context_tokens_bucket: '2-8k',
      source: 'app',
      platform: expect.any(String),
      app_version: '0.0.55',
      device_class: 'desktop',
      locale: 'en'
    })
    const everything = fake.bodies.join('\n')
    for (const leaked of [PROMPT, REPLY, 'alice', 'My-Private-Model', 'secret'])
      expect(everything).not.toContain(leaked)
    expect(offline.blockedRequests).toEqual([])
  })

  it('stops sending and resets the anonymous ID when turned off', async () => {
    launch(fake.host)
    await invoke(ANALYTICS_CHANNELS.optIn, 'settings')
    const firstId = getSetting<string | null>(ANALYTICS_SETTING_KEYS.installId, null)
    expect(firstId).toEqual(expect.any(String))
    await analytics().flush()
    const sentBefore = fake.events.length

    await invoke(ANALYTICS_CHANNELS.setConsent, { usage: false, crashes: false })
    await chat()
    await analytics().shutdown()

    expect(fake.events).toHaveLength(sentBefore)
    expect(getSetting(ANALYTICS_SETTING_KEYS.installId, null)).toBeNull()
    expect(consentSync()).toMatchObject({ usage: false, crashes: false })
  })

  it('forgets consent when the user deletes all their data', async () => {
    launch(fake.host)
    await invoke(ANALYTICS_CHANNELS.optIn, 'setup')
    expect(await deleteAllData()).toEqual({ success: true })

    expect(consentSync()).toEqual({
      usage: false,
      crashes: false,
      asked: false,
      lastPromptAt: null
    })
    for (const key of Object.values(ANALYTICS_SETTING_KEYS))
      expect(getSetting(key, 'absent')).toBe('absent')
    expect(analytics().active).toBe(false)
  })

  it('reports a crash during a generation on the next launch, and not a clean quit', async () => {
    launch(fake.host)
    await invoke(ANALYTICS_CHANNELS.optIn, 'settings')
    // A clean generation and a clean quit leave nothing behind.
    await chat()
    await analytics().shutdown()
    launch(fake.host)
    await analytics().reportPreviousExit()

    // Now the app dies in the middle of a generation: the request never finishes.
    let release!: () => void
    void recordAIRequest(
      { modality: 'text', source: 'Chat stream', model: 'custom.gguf' },
      () => new Promise<void>((resolve) => (release = resolve))
    )
    const marker = path.join(TMP_DIR, UNCLEAN_EXIT_MARKER_FILE)
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true))

    // The next launch reads the marker the dead process left.
    launch(fake.host)
    await analytics().reportPreviousExit()
    await analytics().shutdown()
    release()

    const reports = fake.events.filter((event) => event.event === 'unclean_exit')
    expect(reports).toHaveLength(1)
    expect(reports[0]!.properties).toMatchObject({ stage: 'generate', model: 'custom' })
  })
})
