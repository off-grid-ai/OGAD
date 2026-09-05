/**
 * Resource-mode integration coverage at the owning main-process seams.
 *
 * The Playwright tour proves that a user can select a mode in SetupPanel. This test
 * proves what happens after that renderer intent crosses IPC: the real LLM settings
 * owner applies and persists the preset, a fresh service reloads it into the exact
 * llama-server launch arguments, and the real setup planner consumes the saved mode
 * when choosing models and capabilities.
 *
 * Host RAM is the only fake because it is an uncontrollable machine boundary. All
 * Off Grid AI services, filesystem persistence, catalog decisions, and plan assembly
 * stay real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import os from 'os'
import * as path from 'path'
import type { PerformanceMode } from '@offgrid/models'
import type { OffGridApplication } from '@offgrid/application'

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

describe('resource mode settings -> restart -> setup plan', () => {
  let dataDir: string
  let application: OffGridApplication | undefined
  let releaseApplication: (() => void) | undefined
  const previousDataDir = process.env.OFFGRID_DATA_DIR

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-resource-mode-'))
    fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
    process.env.OFFGRID_DATA_DIR = dataDir
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1e9)
    vi.resetModules()
  })

  afterEach(async () => {
    await application?.stop()
    releaseApplication?.()
    application = undefined
    releaseApplication = undefined
    vi.restoreAllMocks()
    if (previousDataDir === undefined) {
      delete process.env.OFFGRID_DATA_DIR
    } else {
      process.env.OFFGRID_DATA_DIR = previousDataDir
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('applies every preset to persisted launch limits and settings-driven model plans', async () => {
    const [
      { llm, LLMService },
      {
        TEXT_RUNTIME_MODE_PRESETS: MODE_PRESETS,
        GUIDED_SETUP_STT_MODEL_BY_MODE: STT_MODEL_BY_MODE
      },
      setup,
      { createOffGridApplication },
      { desktopModelWorkspacePorts },
      { createDesktopGuidedSetupPorts },
      applicationAccess
    ] = await Promise.all([
      import('../../llm'),
      import('@offgrid/models'),
      import('../../setup'),
      import('@offgrid/application'),
      import('../../model-services'),
      import('../../composition/guided-setup'),
      import('../../composition/application-access')
    ])

    application = createOffGridApplication({
      models: {
        ...desktopModelWorkspacePorts,
        guidedSetup: createDesktopGuidedSetupPorts(desktopModelWorkspacePorts.guidedSetupRuntime)
      }
    })
    releaseApplication = applicationAccess.registerDesktopApplication(application)
    await application.start()

    const recommendations = new Map<PerformanceMode, string>()

    for (const mode of ['conservative', 'balanced', 'extreme'] as const) {
      // The engine settings owner persists launch arguments without starting or restarting the
      // runtime. The application settings command owns the separate restart decision.
      await expect(llm.setSettings({ performanceMode: mode })).resolves.toEqual({
        launchChanged: true
      })

      const selected = llm.getSettings()
      expect(selected.performanceMode).toBe(mode)
      expect(selected.ctxSize).toBe(MODE_PRESETS[mode].ctxSize)
      expect(selected.kvCacheType).toBe(MODE_PRESETS[mode].kvCacheType)
      expect(selected.flashAttn).toBe(MODE_PRESETS[mode].flashAttn)

      const persisted = JSON.parse(
        fs.readFileSync(path.join(dataDir, 'models', 'llm-settings.json'), 'utf8')
      ) as Record<string, unknown>
      expect(persisted.performanceMode).toBe(mode)

      const restarted = new LLMService()
      expect(restarted.getSettings().performanceMode).toBe(mode)
      const args = restarted.launchArgs()
      expect(argValue(args, '-c')).toBe(String(MODE_PRESETS[mode].ctxSize))
      if (MODE_PRESETS[mode].kvCacheType === 'f16') {
        expect(args).not.toContain('--cache-type-k')
      } else {
        expect(argValue(args, '--cache-type-k')).toBe(MODE_PRESETS[mode].kvCacheType)
        expect(argValue(args, '--cache-type-v')).toBe(MODE_PRESETS[mode].kvCacheType)
        expect(argValue(args, '--flash-attn')).toBe('on')
      }

      // No override: both calls must consume the mode held by the real settings owner.
      const recommendation = await setup.getRecommendation()
      const plan = await setup.getSetupPlan()
      expect(recommendation?.mode).toBe(mode)
      expect(plan.mode).toBe(mode)
      expect(plan.items.find((item) => item.kind === 'chat')?.id).toBe(recommendation?.id)
      expect(plan.items.find((item) => item.kind === 'transcription')?.id).toBe(
        STT_MODEL_BY_MODE[mode]
      )
      expect(plan.items.some((item) => item.kind === 'image')).toBe(mode !== 'conservative')
      recommendations.set(mode, recommendation?.id ?? '')
    }

    // At a deterministic 16 GB boundary, Conservative really selects the lighter
    // chat recommendation. Balanced and Extreme still differ in context and STT tier.
    expect(recommendations.get('conservative')).not.toBe(recommendations.get('balanced'))
  })
})
