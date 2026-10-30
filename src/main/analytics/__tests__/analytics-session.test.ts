import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSettingsStore, initializeSettingsStore } from '../../settings-store'
import { AnalyticsService, type AnalyticsServiceDeps } from '../service'
import { createPostHogClient } from '../client'
import { UncleanExitMarker } from '../unclean-exit'
import { createOfflineFetchBoundary } from '../../__tests__/harness/offline-fetch'
import { startFakePostHog, type FakePostHog } from '../../__tests__/harness/fake-posthog'

/**
 * Sessions over the real
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
  })
})
