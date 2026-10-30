import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSettingsStore, initializeSettingsStore } from '../../settings-store'
import { AnalyticsService, type AnalyticsServiceDeps } from '../service'
import { createPostHogClient } from '../client'
import { UncleanExitMarker } from '../unclean-exit'
import { SUMMARY_KEY_CAP } from '../session-tally'
import { buildUsageSnapshot, countBucket } from '../usage-snapshot'
import {
  ANALYTICS_SETTING_KEYS,
  normalizeUiActionId,
  scrollBucket
} from '../../../shared/analytics'
import { createOfflineFetchBoundary } from '../../__tests__/harness/offline-fetch'
import { startFakePostHog, type FakePostHog } from '../../__tests__/harness/fake-posthog'

/**
 * Sessions, the per-session interaction counters and the daily usage snapshot, over the real
 * settings store and the real PostHog SDK. The fake PostHog endpoint is the only stand-in.
 */

let dir: string
let fake: FakePostHog

function settingsStore(): AnalyticsServiceDeps['settings'] {
  const db = new DatabaseSync(':memory:')
  initializeSettingsStore(db as never)
  return createSettingsStore(db as never)
}

function build(overrides: Partial<AnalyticsServiceDeps> = {}): AnalyticsService {
  return new AnalyticsService({
    settings: settingsStore(),
    createClient: createPostHogClient,
    apiKey: 'phc_test',
    host: fake.host,
    buildAllowed: true,
    superProperties: () => ({ platform: 'macos' }),
    marker: new UncleanExitMarker({ dir, version: '0.0.55', bootAt: () => 1_000, now: Date.now }),
    uiActionIds: new Set(['new-chat', 'send-message', 'close', 'active-models']),
    ...overrides
  })
}

const named = (name: string): Record<string, unknown>[] =>
  fake.events.filter((event) => event.event === name).map((event) => event.properties)

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'og-analytics-session-'))
  vi.stubGlobal('fetch', createOfflineFetchBoundary().fetch)
  fake = await startFakePostHog()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fake.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sessions', () => {
  it('closes the session on quit with its foreground time and one summary', async () => {
    let now = 10_000
    const service = build({ now: () => now })
    service.optIn('settings')
    service.sessionFocused()
    now += 4_000
    service.sessionBlurred()
    now += 60_000 // away: not counted
    service.sessionFocused()
    now += 1_000
    await service.shutdown()

    expect(named('app_backgrounded')).toEqual([expect.objectContaining({ session_ms: 5_000 })])
    expect(named('session_summary')).toEqual([expect.objectContaining({ session_ms: 5_000 })])
  })

  it('pairs a later opening with app_opened, resumed', async () => {
    let now = 0
    const service = build({ now: () => now })
    service.optIn('settings')
    service.sessionFocused()
    now += 1_000
    service.endSession()
    now += 1_000
    service.sessionFocused()
    await service.shutdown()
    expect(named('app_opened')).toEqual([
      expect.objectContaining({ cold_start_ms: null, resumed: true })
    ])
    expect(named('app_backgrounded')).toHaveLength(2)
    expect(named('session_summary')).toHaveLength(2)
  })

  it('counts interactions on the device and sends them once, in the summary', async () => {
    const service = build()
    service.optIn('settings')
    service.sessionFocused()
    service.captureFromRenderer('screen_viewed', { screen: 'chats', prev_screen: null, prev_ms: 0 })
    service.captureFromRenderer('screen_viewed', {
      screen: 'models:image',
      prev_screen: 'chats',
      prev_ms: 5
    })
    service.captureFromRenderer('screen_viewed', {
      screen: 'chats',
      prev_screen: 'models:image',
      prev_ms: 5
    })
    for (let i = 0; i < 3; i++)
      service.captureFromRenderer('ui_action', { screen: 'chats', action: 'new-chat' })
    service.captureFromRenderer('ui_action', { screen: 'models:image', action: 'close' })
    service.captureFromRenderer('scroll_depth', { screen: 'chats', pct: 25 })
    service.captureFromRenderer('scroll_depth', { screen: 'chats', pct: 75 })
    service.captureFromRenderer('scroll_depth', { screen: 'chats', pct: 50 })
    service.captureFromRenderer('scroll_depth', { screen: 'chats', pct: 33 })
    service.captureFromRenderer('shortcut_used', { shortcut: 'command_palette' })
    service.captureFromRenderer('command_used', { command: 'go_to', target: 'settings' })
    service.captureFromRenderer('error_shown', { error_code: 'download_failed' })
    service.captureFromRenderer('error_response', {
      error_code: 'download_failed',
      response: 'action'
    })
    service.captureFromRenderer('empty_state_seen', { screen: 'projects' })
    service.captureFromRenderer('notification_clicked', { type: 'meetings' })
    service.captureFromRenderer('chat_input', { method: 'drop', extension: 'pdf' })
    service.captureFromRenderer('chat_input', { method: 'paste', extension: 'clientsecret' })
    service.countInteraction('settings_changed', 'toolsEnabled=false')
    await service.shutdown()

    // Not one of these went as an event of its own.
    for (const name of ['ui_action', 'scroll_depth', 'shortcut_used', 'chat_input'])
      expect(named(name)).toEqual([])
    const [summary] = named('session_summary')
    expect(summary).toMatchObject({
      screens: 2,
      screen_views: 3,
      actions: { 'chats:new-chat': 3, 'models:close': 1 },
      max_scroll_pct: { chats: 75 },
      shortcuts: { command_palette: 1 },
      commands: { 'go_to:settings': 1 },
      errors_shown: { download_failed: 1 },
      error_responses: { 'download_failed:action': 1 },
      empty_states: { projects: 1 },
      notifications_clicked: { meetings: 1 },
      chat_inputs: { 'drop:pdf': 1, 'paste:other': 1 },
      settings_changed: { 'toolsEnabled=false': 1 }
    })
  })

  it('lets no visible or typed text through as an action or a screen', async () => {
    const service = build()
    service.optIn('settings')
    service.sessionFocused()
    // A computed label normalises to an id that is not in the allow-list from source.
    const computed = normalizeUiActionId('Delete Q3 board notes.pdf')!
    for (const action of [computed, 'ali@example.com', 'Send message', '../etc', ''])
      service.captureFromRenderer('ui_action', { screen: 'chats', action })
    service.captureFromRenderer('ui_action', { screen: 'https://x.y', action: 'new-chat' })
    service.captureFromRenderer('screen_viewed', {
      screen: 'dialog:delete-q3-board-notes-pdf',
      prev_screen: null,
      prev_ms: 0
    })
    service.captureFromRenderer('screen_viewed', {
      screen: 'panel:active-models',
      prev_screen: null,
      prev_ms: 0
    })
    service.captureFromRenderer('shortcut_used', { shortcut: 'cmd+secret' })
    service.captureFromRenderer('error_shown', { error_code: 'Could not open /Users/ali/x' })
    service.captureFromRenderer('notification_clicked', { type: 'Lunch with Sam' })
    await service.shutdown()

    expect(named('screen_viewed').map((p) => p.screen)).toEqual(['dialog', 'panel:active-models'])
    const [summary] = named('session_summary')
    expect(summary).toMatchObject({
      actions: {},
      shortcuts: {},
      errors_shown: {},
      notifications_clicked: {}
    })
    const all = fake.bodies.join('')
    for (const leaked of ['q3', 'ali@', 'Sam', '/Users', 'https']) expect(all).not.toContain(leaked)
  })

  it('caps each map to its most used keys', async () => {
    const service = build({ uiActionIds: new Set(Array.from({ length: 80 }, (_, i) => `a${i}`)) })
    service.optIn('settings')
    service.sessionFocused()
    for (let i = 0; i < 80; i++) {
      for (let n = 0; n <= i; n++)
        service.captureFromRenderer('ui_action', { screen: 'chats', action: `a${i}` })
    }
    await service.shutdown()
    const actions = named('session_summary')[0]!.actions as Record<string, number>
    expect(Object.keys(actions)).toHaveLength(SUMMARY_KEY_CAP)
    expect(actions['chats:a79']).toBe(80)
    expect(actions['chats:a0']).toBeUndefined()
  })

  it('reports a session the app died in on the next launch, once', async () => {
    let now = 100_000
    const settings = settingsStore()
    const first = build({ settings, now: () => now })
    first.optIn('settings')
    first.sessionFocused()
    first.captureFromRenderer('ui_action', { screen: 'chats', action: 'send-message' })
    now += 3_000
    first.sessionBlurred() // persisted here; then the process dies without a shutdown
    await first.flush()
    expect(settings.get(ANALYTICS_SETTING_KEYS.pendingSession, null)).not.toBeNull()

    const relaunch = build({ settings, now: () => now + 50_000 })
    relaunch.start()
    relaunch.reportPreviousSession()
    relaunch.reportPreviousSession()
    await relaunch.shutdown()

    const summaries = named('session_summary')
    expect(summaries).toEqual([
      expect.objectContaining({
        recovered: true,
        session_ms: 3_000,
        actions: { 'chats:send-message': 1 }
      })
    ])
    expect(settings.get(ANALYTICS_SETTING_KEYS.pendingSession, null)).toBeNull()
  })

  it('counts nothing and persists nothing before opt-in', async () => {
    const settings = settingsStore()
    const service = build({ settings })
    service.sessionFocused()
    service.captureFromRenderer('ui_action', { screen: 'chats', action: 'new-chat' })
    service.sessionBlurred()
    await service.shutdown()
    expect(settings.get(ANALYTICS_SETTING_KEYS.pendingSession, null)).toBeNull()
    expect(fake.events).toEqual([])
  })
})

describe('time to first message', () => {
  it('sends first_message once per launch, with the install age only for the first ever', async () => {
    let now = 50_000
    const service = build({
      now: () => now,
      launchedAt: 40_000,
      firstMessageInfo: () => ({ firstEver: true, installedAt: 20_000 })
    })
    service.optIn('settings')
    service.captureFromRenderer('message_sent', {})
    now += 1_000
    service.captureFromRenderer('message_sent', {})
    await service.shutdown()
    expect(named('first_message')).toEqual([
      expect.objectContaining({
        since_launch_ms: 10_000,
        first_ever: true,
        since_install_ms: 30_000
      })
    ])
  })
})

describe('message actions and flows', () => {
  it('sends fixed message actions and keeps a film final render detail', async () => {
    const service = build()
    service.optIn('settings')
    service.captureFromRenderer('message_action', { action: 'copy' })
    service.captureFromRenderer('message_action', { action: 'share to twitter' })
    service.flow({ flow: 'video_story', action: 'step', step: 'final_started', detail: 'tonight' })
    service.flow({ flow: 'video_story', action: 'step', step: 'final_started', detail: 'my film' })
    await service.shutdown()
    expect(named('message_action')).toEqual([expect.objectContaining({ action: 'copy' })])
    const steps = named('flow_step')
    expect(steps[0]).toMatchObject({ step: 'final_started', detail: 'tonight' })
    expect(steps[1]!.detail).toBeUndefined()
  })
})

describe('daily usage snapshot', () => {
  it('buckets every count and never sends an exact number', () => {
    expect([0, 1, 5, 6, 20, 21, 100, 101, 500, 501, -3, Number.NaN].map(countBucket)).toEqual([
      '0',
      '1-5',
      '1-5',
      '6-20',
      '6-20',
      '21-100',
      '21-100',
      '101-500',
      '101-500',
      '>500',
      '0',
      '0'
    ])
  })

  it('merges sources, drops unknown keys and failing sources, and adds the appearance', async () => {
    const snapshot = await buildUsageSnapshot(
      [
        () => ({ chats: 12, messages: 900, models_text: 2 }),
        async () => ({ devices: 1, films: 3, secret_name: 7 }) as never,
        () => {
          throw new Error('pro store closed')
        }
      ],
      { theme: 'dark', ui_animations: false, zoom_level: 0.7 }
    )
    expect(snapshot).toEqual({
      chats: '6-20',
      messages: '>500',
      models_text: '1-5',
      devices: '1-5',
      films: '1-5',
      theme: 'dark',
      ui_animations: false,
      zoom_level: 0.5
    })
  })

  it('goes once a day beside features_snapshot', async () => {
    const service = build({ now: () => Date.parse('2026-10-30T10:00:00Z') })
    service.optIn('settings')
    const features = async (): Promise<Record<string, boolean>> => ({ tools: true })
    const usage = async (): Promise<Record<string, string>> => ({ chats: '1-5' })
    expect(await service.snapshotFeatures(features, usage)).toBe(true)
    expect(await service.snapshotFeatures(features, usage)).toBe(false)
    await service.shutdown()
    expect(named('usage_snapshot')).toEqual([expect.objectContaining({ chats: '1-5' })])
  })
})

describe('value rules', () => {
  it('normalises ids and buckets scroll depth', () => {
    expect(normalizeUiActionId('  Close Panel ')).toBe('close-panel')
    expect(normalizeUiActionId('***')).toBeNull()
    expect([0, 0.1, 0.25, 0.6, 0.8, 0.99, 2].map(scrollBucket)).toEqual([
      0, 0, 25, 50, 75, 100, 100
    ])
  })
})
