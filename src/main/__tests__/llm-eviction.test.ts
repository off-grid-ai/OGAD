// @vitest-environment node
/**
 * Image generation evicts the chat engine before it starts. The llama-server executable is a
 * real process (harness/fake-llama-engine); LLMService spawns, signals and waits on it for real.
 * The OS is the only other boundary: one test makes the process ignore its signals, as an engine
 * stuck in an uninterruptible Metal abort does, and fakes the clock through the grace windows.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type * as ChildProcessModule from 'child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  writeGguf,
  type FakeLlamaEngine
} from './harness/fake-llama-engine'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-llm-eviction-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
const previousBinDir = process.env.OFFGRID_BIN_DIR
const os_ = vi.hoisted(() => ({ ignoreSignals: false }))

vi.mock('electron', () => ({
  app: { getPath: () => PROFILE_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))
// The OS boundary: an engine in an uninterruptible state does not die on any signal.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args)
    if (os_.ignoreSignals) child.kill = () => true
    return child
  }) as typeof actual.spawn
  return { ...actual, default: { ...actual, spawn }, spawn }
})

import { LLMService } from '../llm'

let engine: FakeLlamaEngine

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = PROFILE_DIR
  process.env.OFFGRID_BIN_DIR = fs.mkdtempSync(path.join(PROFILE_DIR, 'no-engines-'))
  const manager = await import('../models-manager')
  const model = await manager.importLocalModel(writeGguf(path.join(PROFILE_DIR, 'fixtures'), 'chat.gguf'))
  expect(await manager.setActiveModel(model.id!)).toEqual({ success: true })
})

async function runningService(): Promise<LLMService> {
  const binDir = fs.mkdtempSync(path.join(PROFILE_DIR, 'bin-'))
  process.env.OFFGRID_BIN_DIR = binDir
  engine = installFakeLlamaEngine(binDir)
  const svc = new LLMService()
  ;(svc as unknown as { port: number }).port = await unusedPort()
  await svc.init()
  expect(svc.isReady()).toBe(true)
  return svc
}

afterEach(() => {
  vi.useRealTimers()
  os_.ignoreSignals = false
  for (const { pid } of engine?.launches() ?? []) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
})

afterAll(async () => {
  ;(await import('../llm')).llm.stop()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBinDir
})

describe('LLM eviction for image generation', () => {
  it('refuses image admission while the chat engine will not stop', async () => {
    os_.ignoreSignals = true
    const svc = await runningService()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const evict = Promise.resolve(svc.runtime.evict())
    const refused = expect(evict).rejects.toThrow('chat model did not stop')
    await vi.advanceTimersByTimeAsync(10_000)
    await refused
  })

  it('waits for the engine to exit and keeps respawn blocked until release', async () => {
    const svc = await runningService()
    const [{ pid }] = engine.launches()

    await svc.runtime.evict()
    // Eviction resolved only once the engine process was gone.
    expect(processAlive(pid!)).toBe(false)
    expect(svc.isReady()).toBe(false)
    await expect(svc.chat('hello')).rejects.toThrow('paused')
    expect(engine.launches()).toHaveLength(1)

    svc.runtime.release()
    await svc.init()
    expect(svc.isReady()).toBe(true)
    expect(engine.launches()).toHaveLength(2)
    svc.stop()
  })
})
