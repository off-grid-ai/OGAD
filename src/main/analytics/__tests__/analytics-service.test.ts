import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSettingsStore, initializeSettingsStore } from '../../settings-store'
import { AnalyticsService, type AnalyticsServiceDeps } from '../service'
import { createPostHogClient } from '../client'
import { UncleanExitMarker, UNCLEAN_EXIT_MARKER_FILE } from '../unclean-exit'
import { POSTHOG_HOST } from '../config'
import { ANALYTICS_SETTING_KEYS, type AnalyticsPromptKind } from '../../../shared/analytics'
import { createOfflineFetchBoundary } from '../../__tests__/harness/offline-fetch'
import { startFakePostHog, type FakePostHog } from '../../__tests__/harness/fake-posthog'

/**
 * The analytics owner over its real collaborators: the real settings repository (on SQLite), the
 * real PostHog SDK and the real in-flight marker on disk. The network is the only boundary, and it
 * is either the offline harness (proving nothing leaves) or a fake PostHog endpoint on loopback.
 */

const SUPER = {
  platform: 'macos',
  app_version: '0.0.55',
  channel: 'stable',
  pro: false,
  device_class: 'desktop',
  ram_gb: 16,
  os_version: '15.5',
  locale: 'en'
} as const

let dir: string
let offline: ReturnType<typeof createOfflineFetchBoundary>
let fake: FakePostHog | null = null

function settings(): AnalyticsServiceDeps['settings'] {
  const db = new DatabaseSync(':memory:')
  initializeSettingsStore(db as never)
  return createSettingsStore(db as never)
}

function build(
  overrides: Partial<AnalyticsServiceDeps> = {},
  prompts: AnalyticsPromptKind[] = []
): AnalyticsService & { prompts: AnalyticsPromptKind[] } {
  const service = new AnalyticsService({
    settings: settings(),
    createClient: createPostHogClient,
    apiKey: 'phc_test',
    host: fake?.host ?? POSTHOG_HOST,
    buildAllowed: true,
    superProperties: () => ({ ...SUPER }),
    marker: new UncleanExitMarker({
      dir,
      version: '0.0.55',
      bootAt: () => 1_000,
      now: Date.now
    }),
    onPrompt: (kind) => prompts.push(kind),
    ...overrides
  })
  return Object.assign(service, { prompts })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'og-analytics-'))
  offline = createOfflineFetchBoundary()
  vi.stubGlobal('fetch', offline.fetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fake?.close()
  fake = null
  rmSync(dir, { recursive: true, force: true })
})

describe('before the user opts in', () => {
  it('makes no request at all, whatever happens in the app', async () => {
    const service = build()
    service.start()
    service.capture('app_opened', { cold_start_ms: 100 })
    service.captureFromRenderer('screen_viewed', { screen: 'chat', prev_screen: null, prev_ms: 0 })
    service.captureException(new Error('boom'), { process: 'main', handled: false })
    service.flow({ flow: 'onboarding', action: 'start' })
    await service.flush()
    await service.shutdown()
    expect(service.active).toBe(false)
    expect(offline.blockedRequests).toEqual([])
    expect(service.consent()).toEqual({
      usage: false,
      crashes: false,
      asked: false,
      lastPromptAt: null
    })
  })

  it('never creates a client in an unpackaged build or without a project key', async () => {
    for (const overrides of [{ buildAllowed: false }, { apiKey: '' }]) {
      const service = build(overrides)
      service.optIn('settings')
      service.capture('app_opened', { cold_start_ms: 1 })
      await service.shutdown()
      expect(service.active).toBe(false)
    }
    expect(offline.blockedRequests).toEqual([])
  })
})

describe('after the user opts in', () => {
  beforeEach(async () => {
    fake = await startFakePostHog()
  })

  it('sends analytics_opted_in with its source and the properties on every event', async () => {
    const service = build()
    service.optIn('setup')
    service.capture('generation_finished', { modality: 'text', outcome: 'done', source: 'app' })
    await service.shutdown()

    const names = fake!.events.map((event) => event.event)
    expect(names).toContain('analytics_opted_in')
    expect(names).toContain('generation_finished')
    const optedIn = fake!.events.find((event) => event.event === 'analytics_opted_in')!
    expect(optedIn.properties).toMatchObject({
      source: 'setup',
      ...SUPER,
      $process_person_profile: false
    })
    // One random ID for the install, the same on every event, and never an identify call.
    const ids = new Set(fake!.events.map((event) => event.distinctId))
    expect(ids.size).toBe(1)
    expect(names).not.toContain('$identify')
    expect(offline.blockedRequests).toEqual([])
  })

  it('keeps usage and crashes apart', async () => {
    const service = build()
    service.setConsent({ crashes: true }, 'settings')
    service.capture('app_opened', { cold_start_ms: 1 })
    service.captureException(new Error('failed at /Users/alice/secret/notes.txt'), {
      process: 'main',
      handled: false
    })
    await service.shutdown()
    expect(fake!.events.map((event) => event.event)).toEqual(['$exception'])
    expect(fake!.bodies.join('')).not.toContain('alice')
    expect(fake!.bodies.join('')).not.toContain('notes.txt')
    expect(fake!.bodies.join('')).toContain('failed at <file>')
  })

  it('stops sending, drops the queue and resets the ID on opt-out', async () => {
    const service = build()
    service.optIn('settings')
    await service.flush()
    const firstId = fake!.events[0]!.distinctId
    service.capture('chat_created')
    service.setConsent({ usage: false, crashes: false }, 'settings')
    service.capture('project_created')
    await service.shutdown()
    const names = fake!.events.map((event) => event.event)
    // The queued chat_created was dropped, and nothing after opt-out went.
    expect(names).toEqual(['analytics_opted_in'])
    expect(service.active).toBe(false)

    service.optIn('settings')
    await service.shutdown()
    const secondId = fake!.events.at(-1)!.distinctId
    expect(secondId).not.toBe(firstId)
  })

  it('forwards only the renderer events and properties it allows', async () => {
    const service = build()
    service.optIn('settings')
    service.captureFromRenderer('screen_viewed', {
      screen: 'chat',
      prev_screen: 'https://example.com/a',
      prev_ms: 12.6,
      query: 'secret prompt'
    })
    service.captureFromRenderer('message_sent', { has_image: true, text: 'hello there' })
    service.captureFromRenderer('feature_used', { feature: 'not-a-feature' })
    service.captureFromRenderer('feature_used', { feature: 'tts' })
    service.captureFromRenderer('reply_regenerated', { reply: 'x' })
    service.captureFromRenderer('identify', { email: 'a@b.co' })
    service.captureFromRenderer('screen_viewed', { screen: '../etc/passwd' })
    service.captureRendererError({ name: 'TypeError', message: 'bad "quoted secret"', stack: '' })
    service.captureRendererError(null)
    await service.shutdown()
    const events = fake!.events.filter((event) => event.event !== 'analytics_opted_in')
    expect(events.map((event) => event.event)).toEqual([
      'screen_viewed',
      'message_sent',
      'feature_used',
      'reply_regenerated',
      '$exception'
    ])
    expect(events[0]!.properties).toMatchObject({ screen: 'chat', prev_screen: null, prev_ms: 13 })
    expect(events[1]!.properties).toMatchObject({
      has_image: true,
      has_document: false,
      tools_enabled: false
    })
    const all = fake!.bodies.join('')
    for (const leaked of ['secret prompt', 'hello there', 'a@b.co', 'quoted secret', 'passwd'])
      expect(all).not.toContain(leaked)
  })

  it('counts each feature at most once in ten minutes, whichever process reports it', async () => {
    let now = 1_000_000
    const service = build({ now: () => now })
    service.optIn('settings')
    service.capture('feature_used', { feature: 'tools' })
    service.captureFromRenderer('feature_used', { feature: 'tools' })
    service.capture('feature_used', { feature: 'web_search' })
    now += 10 * 60 * 1000
    service.capture('feature_used', { feature: 'tools' })
    await service.shutdown()
    const used = fake!.events.filter((event) => event.event === 'feature_used')
    expect(used.map((event) => event.properties.feature)).toEqual(['tools', 'web_search', 'tools'])
  })

  it('times flows and follows the setup funnel to the first message', async () => {
    let now = 1_000
    const service = build({ now: () => now })
    service.optIn('setup')
    now += 500
    service.capture('model_download_started', { model: 'custom' })
    service.capture('model_download_finished', { model: 'custom' })
    service.capture('model_loaded', { model: 'custom' })
    now += 500
    service.captureFromRenderer('message_sent', {})
    service.flow({
      flow: 'connector_add',
      action: 'step',
      step: 'connector_picked',
      detail: 'github'
    })
    service.flow({ flow: 'connector_add', action: 'step', step: 'not-a-step' })
    service.flow({
      flow: 'connector_add',
      action: 'finish',
      outcome: 'failed',
      errorCode: 'Bad Code!'
    })
    service.flow({ flow: 'pro_upgrade', action: 'step', step: 'gate_shown', detail: 'meetings' })
    service.flow({ flow: 'pro_upgrade', action: 'finish', outcome: 'maybe' })
    service.flow({ flow: 'nope', action: 'start' })
    service.flow(null)
    await service.shutdown()

    const steps = fake!.events
      .filter((event) => event.event === 'flow_step' && event.properties.flow === 'onboarding')
      .map((event) => event.properties.step)
    expect(steps).toEqual([
      'setup_shown',
      'download_started',
      'download_done',
      'model_loaded',
      'first_message'
    ])
    const finished = fake!.events.filter((event) => event.event === 'flow_finished')
    expect(finished[0]!.properties).toMatchObject({
      flow: 'onboarding',
      outcome: 'done',
      duration_ms: 1_000,
      failed_step: null
    })
    expect(finished[1]!.properties).toMatchObject({
      flow: 'connector_add',
      outcome: 'failed',
      failed_step: 'connector_picked',
      error_code: null
    })
    const picked = fake!.events.find(
      (event) => event.event === 'flow_step' && event.properties.step === 'connector_picked'
    )!
    expect(picked.properties.connector).toBe('github')
    const gate = fake!.events.find(
      (event) => event.event === 'flow_step' && event.properties.step === 'gate_shown'
    )!
    expect(gate.properties.feature).toBe('meetings')
    expect(finished).toHaveLength(2)
  })

  it('sends the features snapshot once a calendar day', async () => {
    let now = Date.UTC(2026, 9, 23, 8)
    const service = build({ now: () => now })
    service.optIn('settings')
    const read = async (): Promise<Record<string, boolean>> => ({ tools: true, sync: false })
    expect(await service.snapshotFeatures(read)).toBe(true)
    expect(await service.snapshotFeatures(read)).toBe(false)
    now += 86_400_000
    expect(await service.snapshotFeatures(read)).toBe(true)
    await service.shutdown()
    const snapshots = fake!.events.filter((event) => event.event === 'features_snapshot')
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]!.properties).toMatchObject({ tools: true, sync: false })
  })
})

describe('consent prompts', () => {
  it('asks after a failure at most once a month, and never once opted in', () => {
    let now = 1_000_000
    const prompts: AnalyticsPromptKind[] = []
    const shared = settings()
    const first = build({ settings: shared, now: () => now }, prompts)
    first.noteFailure()
    first.noteFailure()
    expect(prompts).toEqual(['failure'])

    // A later session within 30 days does not ask again; after 30 days it does.
    now += 29 * 86_400_000
    build({ settings: shared, now: () => now }, prompts).noteFailure()
    expect(prompts).toEqual(['failure'])
    now += 2 * 86_400_000
    const later = build({ settings: shared, now: () => now }, prompts)
    later.noteFailure()
    expect(prompts).toEqual(['failure', 'failure'])

    later.setConsent({ crashes: true }, 'failure_prompt')
    now += 90 * 86_400_000
    build({ settings: shared, now: () => now }, prompts).noteFailure()
    expect(prompts).toHaveLength(2)
  })

  it('asks someone who was never asked once, after a reply, and only once ever', () => {
    const prompts: AnalyticsPromptKind[] = []
    const shared = settings()
    const service = build({ settings: shared }, prompts)
    service.noteSuccessfulReply()
    service.noteSuccessfulReply()
    build({ settings: shared }, prompts).noteSuccessfulReply()
    expect(prompts).toEqual(['first_chat'])
  })

  it('does not ask someone who answered the setup checkbox', () => {
    const prompts: AnalyticsPromptKind[] = []
    const service = build({}, prompts)
    service.dismissPrompt()
    service.noteSuccessfulReply()
    service.noteFailure()
    expect(prompts).toEqual([])
    expect(service.consent().asked).toBe(true)
  })
})

describe('unclean exit', () => {
  beforeEach(async () => {
    fake = await startFakePostHog()
  })

  const marker = (over: Partial<{ version: string; bootAt: number }> = {}): UncleanExitMarker =>
    new UncleanExitMarker({
      dir,
      version: over.version ?? '0.0.55',
      bootAt: () => over.bootAt ?? 1_000,
      now: Date.now
    })

  it('reports work that was in flight when the app died in the foreground', async () => {
    const dying = marker()
    const crashed = build({ marker: dying })
    crashed.optIn('settings')
    crashed.beginWork({
      stage: 'generate',
      model: 'custom',
      engine: 'llama.cpp',
      backend: 'gpu',
      freeRamGb: 8,
      startedAt: Date.now() - 5_000
    })
    await crashed.flush()
    // The process dies here: no shutdown, so the marker stays.
    await dying.settled()
    expect(existsSync(path.join(dir, UNCLEAN_EXIT_MARKER_FILE))).toBe(true)

    const next = build({ marker: marker() })
    next.setConsent({ usage: true, crashes: true }, 'settings')
    await next.reportPreviousExit()
    await next.shutdown()
    const report = fake!.events.find((event) => event.event === 'unclean_exit')
    expect(report?.properties).toMatchObject({
      stage: 'generate',
      model: 'custom',
      engine: 'llama.cpp',
      backend: 'gpu',
      free_ram_gb: 8
    })
    expect(report?.properties.elapsed_ms).toBeGreaterThanOrEqual(5_000)
    expect(existsSync(path.join(dir, UNCLEAN_EXIT_MARKER_FILE))).toBe(false)
    // Stop the dead process's heartbeat so it cannot write after the test.
    await dying.clear()
  })

  it('reports nothing after a clean quit, an update, a reboot or a background kill', async () => {
    const work = {
      stage: 'load' as const,
      model: 'custom',
      engine: null,
      backend: null,
      freeRamGb: 4,
      startedAt: Date.now()
    }
    const clean = build({ marker: marker() })
    clean.optIn('settings')
    const end = clean.beginWork(work)
    end()
    end()
    await clean.shutdown()

    const write = (fields: Record<string, unknown>): void =>
      writeFileSync(
        path.join(dir, UNCLEAN_EXIT_MARKER_FILE),
        JSON.stringify({
          ...work,
          version: '0.0.55',
          bootAt: 1_000,
          foreground: true,
          aliveAt: Date.now(),
          ...fields
        })
      )
    for (const fields of [
      { version: '0.0.54' },
      { bootAt: 9_999_999 },
      { foreground: false },
      { stage: 'other' }
    ]) {
      write(fields)
      const next = build({ marker: marker() })
      next.optIn('settings')
      await next.reportPreviousExit()
      await next.shutdown()
    }
    writeFileSync(path.join(dir, UNCLEAN_EXIT_MARKER_FILE), 'not json')
    const last = build({ marker: marker() })
    last.optIn('settings')
    await last.reportPreviousExit()
    await last.shutdown()
    expect(fake!.events.map((event) => event.event)).not.toContain('unclean_exit')
  })

  it('writes no marker while crash reports are off', async () => {
    const quiet = marker()
    const service = build({ marker: quiet })
    service.setConsent({ usage: true }, 'settings')
    service.setForeground(false)
    service.beginWork({
      stage: 'load',
      model: 'custom',
      engine: null,
      backend: null,
      freeRamGb: 4,
      startedAt: Date.now()
    })()
    await quiet.settled()
    expect(existsSync(path.join(dir, UNCLEAN_EXIT_MARKER_FILE))).toBe(false)
    await service.shutdown()
  })
})

describe('forget (delete all data)', () => {
  it('opts out and removes every analytics setting', async () => {
    fake = await startFakePostHog()
    const shared = settings()
    const service = build({ settings: shared })
    service.optIn('setup')
    await service.flush()
    service.forget()
    for (const key of Object.values(ANALYTICS_SETTING_KEYS)) {
      expect(shared.get(key, 'absent')).toBe('absent')
    }
    expect(service.active).toBe(false)
    expect(service.consent()).toEqual({
      usage: false,
      crashes: false,
      asked: false,
      lastPromptAt: null
    })
  })
})
