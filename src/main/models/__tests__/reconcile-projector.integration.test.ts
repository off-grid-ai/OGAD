// Integration: reconcileActiveModelProjector heals a stale active-model.json end-to-end
// through the REAL catalog + REAL filesystem. A model activated before its entry had a
// vision projector stored mmproj:null; once the projector is on disk, hasVision must turn
// on WITHOUT a re-activate. Only the data dir is redirected to a temp profile, electron is
// stubbed and the chat engine is a llama-server executable (harness/fake-llama-engine) — the file
// read/write, catalog lookup, disk check and the engine reload all stay real.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  type FakeLlamaEngine
} from '../../__tests__/harness/fake-llama-engine'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalBinDir = process.env.OFFGRID_BIN_DIR
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-reconcile-projector-'))
process.env.OFFGRID_DATA_DIR = path.join(testRoot, 'data')
process.env.OFFGRID_BIN_DIR = path.join(testRoot, 'bin')

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(testRoot, 'data'),
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

const manager = await import('../../models-manager')
const { llm } = await import('../../llm')

// A real catalog vision model whose projector download is the healable case.
const VISION_ID = 'unsloth/gemma-4-E2B-it-GGUF'
const PROJECTOR = 'mmproj-gemma-4-E2B-it-F16.gguf'
const PRIMARY = 'gemma-4-E2B-it-Q4_K_M.gguf'

const modelsDir = (): string => llm.getModelsDir()
const activeFile = (): string => path.join(modelsDir(), 'active-model.json')

function writeActive(mmproj: string | null): void {
  fs.mkdirSync(modelsDir(), { recursive: true })
  fs.writeFileSync(activeFile(), JSON.stringify({ id: VISION_ID, primary: PRIMARY, mmproj }))
}
function putFile(name: string): void {
  fs.mkdirSync(modelsDir(), { recursive: true })
  const bytes = Buffer.alloc(2048, 7)
  bytes.write('GGUF')
  fs.writeFileSync(path.join(modelsDir(), name), bytes)
}

let engine: FakeLlamaEngine
/** The chat engine, loaded with whatever active-model.json says. */
async function runningEngine(): Promise<number> {
  await llm.init()
  expect(llm.isReady()).toBe(true)
  return engine.launches().at(-1)!.pid
}
const projectorArg = (args: string[]): string | undefined =>
  args.includes('--mmproj') ? path.basename(args[args.indexOf('--mmproj') + 1]!) : undefined

beforeEach(async () => {
  llm.stop()
  fs.rmSync(modelsDir(), { recursive: true, force: true })
  fs.rmSync(path.join(testRoot, 'bin'), { recursive: true, force: true })
  engine = installFakeLlamaEngine(path.join(testRoot, 'bin'))
  ;(llm as unknown as { port: number }).port = await unusedPort()
  putFile(PRIMARY)
})
afterEach(() => {
  llm.stop()
  for (const { pid } of engine.launches()) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
})
afterAll(() => {
  if (originalBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = originalBinDir
  process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('reconcileActiveModelProjector', () => {
  it('writes the projector into active-model.json once it is on disk', async () => {
    writeActive(null) // activated before the catalog had a projector
    const textOnly = await runningEngine()
    expect(projectorArg(engine.launches()[0]!.args)).toBeUndefined()
    putFile(PROJECTOR) // projector now downloaded

    const healed = await manager.reconcileActiveModelProjector()

    expect(healed).toBe(true)
    expect(JSON.parse(fs.readFileSync(activeFile(), 'utf-8')).mmproj).toBe(PROJECTOR)
    // The engine reloaded: the text-only process is gone and the next load carries the projector.
    await vi.waitFor(() => expect(processAlive(textOnly)).toBe(false))
    await runningEngine()
    expect(projectorArg(engine.launches().at(-1)!.args)).toBe(PROJECTOR)
  })

  it('does nothing while the projector is not yet downloaded', async () => {
    writeActive(null)
    // no projector file on disk
    const pid = await runningEngine()

    const healed = await manager.reconcileActiveModelProjector()

    expect(healed).toBe(false)
    expect(JSON.parse(fs.readFileSync(activeFile(), 'utf-8')).mmproj).toBeNull()
    expect(llm.isReady()).toBe(true)
    expect(processAlive(pid)).toBe(true)
  })

  it('leaves an already-reconciled config untouched', async () => {
    writeActive(PROJECTOR) // already records the projector
    putFile(PROJECTOR)
    const pid = await runningEngine()

    expect(await manager.reconcileActiveModelProjector()).toBe(false)
    expect(llm.isReady()).toBe(true)
    expect(processAlive(pid)).toBe(true)
    expect(engine.launches()).toHaveLength(1)
  })
})
