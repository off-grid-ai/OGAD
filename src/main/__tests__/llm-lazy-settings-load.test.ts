// Regression: LLMService must read its persisted state LAZILY, not in the constructor.
//
// `llm` is a module-level singleton (`export const llm = new LLMService()`), so it is
// constructed while index.ts's IMPORTS are still evaluating — which under ESM finishes
// BEFORE index.ts's own body runs `unifyUserDataPath()` → `app.setPath('userData', …)`.
// Any path resolved during construction therefore points at the PRE-override profile.
//
// Two real consequences, both of which these tests pin:
//   1. Production: the canonical-dir migration ("My Memories" / "my-memories" →
//      "Off Grid AI Desktop") has not run yet at construction, so the user's saved
//      settings and active model were silently missed and replaced by defaults.
//   2. E2E/harness: an OFFGRID_USER_DATA temp profile was ignored entirely — which is
//      what made `settings-sections.spec.ts` "resource mode survives a relaunch" fail.
//      A probe confirmed the constructor resolving the REAL profile while
//      OFFGRID_USER_DATA pointed at the temp dir.
//
// Writes never had the bug: `persist()` goes through the `settingsFile` getter, which
// resolves late. These tests assert the READ side now behaves the same way, by doing
// what production does — construct FIRST, point the data dir somewhere SECOND.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { LLMService } from '../llm'
import { configureRuntime } from '../runtime-env'

let tmp: string

/** Write an llm-settings.json into the models dir of a data dir, as `persist()` would. */
const seedSettings = (dataDir: string, settings: Record<string, unknown>): void => {
  const modelsDir = path.join(dataDir, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, 'llm-settings.json'), JSON.stringify(settings))
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-llm-lazy-'))
})

afterEach(() => {
  // Release the override so a later test isn't pinned to a deleted temp dir.
  configureRuntime({ dataDir: undefined })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('LLMService reads persisted settings lazily (not at construction)', () => {
  it('picks up a data dir configured AFTER the instance was constructed', () => {
    // Construct FIRST — mirrors the module-level singleton being built during imports.
    const svc = new LLMService()
    // ...then point the runtime at the profile, as index.ts's body does later.
    seedSettings(tmp, { performanceMode: 'extreme', temperature: 0.42 })
    configureRuntime({ dataDir: tmp })

    const s = svc.getSettings()
    expect(s.performanceMode).toBe('extreme')
    expect(s.temperature).toBe(0.42)
  })

  it('survives the relaunch shape: persisted mode is read back by a fresh instance', () => {
    // What settings-sections.spec.ts "resource mode survives a relaunch" exercises:
    // one process writes the mode, the next process constructs and must read it back.
    seedSettings(tmp, { performanceMode: 'conservative' })
    const relaunched = new LLMService()
    configureRuntime({ dataDir: tmp })

    expect(relaunched.getSettings().performanceMode).toBe('conservative')
  })

  it('loads once and does not re-read after the first access', () => {
    seedSettings(tmp, { performanceMode: 'conservative' })
    const svc = new LLMService()
    configureRuntime({ dataDir: tmp })
    expect(svc.getSettings().performanceMode).toBe('conservative')

    // A later on-disk edit must NOT leak in: the load is once-only, so in-memory state
    // stays authoritative until something explicitly persists. This guards against
    // turning the lazy guard into a read-on-every-call, which would re-read the file
    // on every getSettings and clobber unsaved in-memory changes.
    seedSettings(tmp, { performanceMode: 'extreme' })
    expect(svc.getSettings().performanceMode).toBe('conservative')
  })

  it('falls back to defaults when the profile has no settings file', () => {
    const svc = new LLMService()
    configureRuntime({ dataDir: tmp }) // seeded with nothing
    expect(svc.getSettings().performanceMode).toBe('balanced')
  })

  // The direct guard on the defect, stated behaviourally rather than by spying on fs:
  // if construction reads eagerly, it reads the profile configured AT THAT MOMENT.
  // Point the runtime at profile A, construct, then switch to profile B before first
  // use — a lazy reader returns B, an eager one returns A. This is the exact shape of
  // the production bug (construct during imports, real profile chosen afterwards).
  it('reads the profile configured at FIRST USE, not the one present at construction', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-llm-lazy-other-'))
    try {
      seedSettings(other, { performanceMode: 'extreme' }) // profile A
      seedSettings(tmp, { performanceMode: 'conservative' }) // profile B

      configureRuntime({ dataDir: other }) // A is current...
      const svc = new LLMService() // ...at construction
      configureRuntime({ dataDir: tmp }) // the override lands afterwards

      // Eager construction would have pinned 'extreme' from profile A.
      expect(svc.getSettings().performanceMode).toBe('conservative')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
