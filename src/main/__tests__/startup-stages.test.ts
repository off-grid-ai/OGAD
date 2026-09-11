import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runStartupStage } from '../startup-stages'
import { startupProjection } from '../startup-projection'

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

let temporaryRoot = ''
const originalLogPath = process.env.OFFGRID_DIAGNOSTIC_LOG

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-startup-test-'))
  process.env.OFFGRID_DIAGNOSTIC_LOG = path.join(temporaryRoot, 'startup.log')
})

afterEach(() => {
  if (originalLogPath === undefined) delete process.env.OFFGRID_DIAGNOSTIC_LOG
  else process.env.OFFGRID_DIAGNOSTIC_LOG = originalLogPath
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('startup stages', () => {
  it('refuses a guarded change after the stage deadline', async () => {
    let applied = false
    const stageName = `guarded-${crypto.randomUUID()}`

    const result = await runStartupStage({
      name: stageName,
      deadlineMs: 5,
      lateEffect: 'guard',
      run: async (context) => {
        await delay(20)
        context.commit('apply late result', () => {
          applied = true
        })
      }
    })
    await delay(30)

    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(applied).toBe(false)
    expect(
      startupProjection.snapshot().stages.find((stage) => stage.name === stageName)?.status
    ).toBe('timeout')
  })

  it('records an allowed late result without leaving startup pending', async () => {
    const stageName = `keep-${crypto.randomUUID()}`

    const result = await runStartupStage({
      name: stageName,
      deadlineMs: 5,
      lateEffect: 'keep',
      run: async () => delay(20)
    })
    await delay(30)

    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(
      startupProjection.snapshot().stages.find((stage) => stage.name === stageName)?.status
    ).toBe('late')
    expect(startupProjection.snapshot().running).not.toContain(stageName)
  })

  it('turns a synchronous stage exception into a typed failure', async () => {
    const result = await runStartupStage({
      name: `failure-${crypto.randomUUID()}`,
      deadlineMs: 50,
      required: true,
      lateEffect: 'guard',
      run: () => {
        throw new Error('startup failed')
      }
    })

    expect(result).toMatchObject({ ok: false, reason: 'failed', error: 'startup failed' })
  })
})
