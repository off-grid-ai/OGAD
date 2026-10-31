/**
 * A model switch while the chat engine is still loading. The llama-server executable is the
 * only fake (a real process from harness/fake-llama-engine); model import, activation, the
 * engine ladder, spawn, health polling and teardown are the production LLMService.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  writeGguf,
  type FakeLlamaEngine
} from '../../__tests__/harness/fake-llama-engine'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-switch-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
const previousBinDir = process.env.OFFGRID_BIN_DIR

vi.mock('electron', () => ({
  app: { getPath: () => PROFILE_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let binDir: string
let engine: FakeLlamaEngine
let service: import('../../llm').LLMService

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = PROFILE_DIR
  // Activation reloads the app's own engine; with no engine installed yet that ends at once.
  process.env.OFFGRID_BIN_DIR = fs.mkdtempSync(path.join(PROFILE_DIR, 'no-engines-'))
  const manager = await import('../../models-manager')
  const model = await manager.importLocalModel(writeGguf(path.join(PROFILE_DIR, 'fixtures'), 'switch.gguf'))
  expect(await manager.setActiveModel(model.id!)).toEqual({ success: true })
})

async function startService(folders: string[]): Promise<void> {
  binDir = fs.mkdtempSync(path.join(PROFILE_DIR, 'bin-'))
  process.env.OFFGRID_BIN_DIR = binDir
  engine = installFakeLlamaEngine(binDir, folders)
  const { LLMService } = await import('../../llm')
  service = new LLMService()
  ;(service as unknown as { port: number }).port = await unusedPort()
}

afterEach(() => {
  service?.stop()
  for (const { pid } of engine?.launches() ?? []) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
})

afterAll(async () => {
  ;(await import('../../llm')).llm.stop()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBinDir
})

describe('model switch during startup', () => {
  it('waits for the cancelled load, then starts a fresh load', async () => {
    await startService(['llama'])
    engine.hold()
    const oldLoad = service.init().catch(() => {})
    await vi.waitFor(() => expect(engine.launches()).toHaveLength(1))
    const first = engine.launches()[0]!.pid

    service.stop()
    const newLoad = service.init()
    engine.release()
    await Promise.all([oldLoad, newLoad])

    const launches = engine.launches()
    expect(launches).toHaveLength(2)
    expect(processAlive(first)).toBe(false)
    expect(processAlive(launches[1]!.pid)).toBe(true)
    expect(service.isReady()).toBe(true)
  })

  it('does not try another engine after the current load is cancelled', async () => {
    await startService(['llama', 'llama-cpu'])
    engine.hold()
    const load = service.init().catch(() => {})
    await vi.waitFor(() => expect(engine.launches()).toHaveLength(1))
    service.stop()
    await load

    // The Metal engine was cancelled; the CPU engine behind it never started.
    expect(engine.launches().map((launch) => launch.folder)).toEqual(['llama'])
    expect(service.isReady()).toBe(false)
  })
})
