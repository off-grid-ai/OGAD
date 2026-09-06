// Integration: reconcileActiveModelProjector heals a stale active-model.json end-to-end
// through the REAL catalog + REAL filesystem. A model activated before its entry had a
// vision projector stored mmproj:null; once the projector is on disk, hasVision must turn
// on WITHOUT a re-activate. Only the data dir is redirected to a temp profile and electron
// is stubbed — the file read/write, catalog lookup, and disk check all stay real.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-reconcile-projector-'))
process.env.OFFGRID_DATA_DIR = path.join(testRoot, 'data')

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(testRoot, 'data'),
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const [applicationModule, modelsModule, modelServices, applicationAccess] = await Promise.all([
  import('@offgrid/application'),
  import('@offgrid/models'),
  import('../../model-services'),
  import('../../composition/application-access')
])
const manager = await import('../../models-manager')
const { llm } = await import('../../llm')
let application: ReturnType<typeof applicationModule.createOffGridApplication> | null = null
let releaseApplication: (() => void) | null = null

// A real catalog vision model whose projector download is the healable case.
const VISION_ID = 'unsloth/gemma-4-E2B-it-GGUF'
const PROJECTOR = 'mmproj-gemma-4-E2B-it-F16.gguf'
const PRIMARY = 'gemma-4-E2B-it-Q4_K_M.gguf'
const HOLO_ID = 'mradermacher/Holo-3.1-4B-GGUF'
const HOLO_PRIMARY = 'Holo-3.1-4B.Q4_K_M.gguf'

const modelsDir = (): string => llm.getModelsDir()
const activeFile = (): string => path.join(modelsDir(), 'active-model.json')

function writeActive(mmproj: string | null): void {
  fs.mkdirSync(modelsDir(), { recursive: true })
  fs.writeFileSync(activeFile(), JSON.stringify({ id: VISION_ID, primary: PRIMARY, mmproj }))
}
function writeActiveModel(id: string, primary: string): void {
  fs.mkdirSync(modelsDir(), { recursive: true })
  fs.writeFileSync(activeFile(), JSON.stringify({ id, primary, mmproj: null }))
}
function putFile(name: string): void {
  fs.mkdirSync(modelsDir(), { recursive: true })
  const bytes = name.endsWith('.gguf')
    ? Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_044, 1)])
    : Buffer.from('x')
  fs.writeFileSync(path.join(modelsDir(), name), bytes)
}

function putModelFiles(modelId: string): void {
  const model = modelsModule.CATALOG.find((entry) => entry.id === modelId)
  if (!model) throw new Error(`Missing catalog fixture: ${modelId}`)
  model.files.forEach((file) => {
    putFile(file.name)
    if (file.sizeBytes) fs.truncateSync(path.join(modelsDir(), file.name), file.sizeBytes)
  })
}

async function startApplication(): Promise<void> {
  application = applicationModule.createOffGridApplication({
    models: {
      ...modelServices.desktopModelWorkspacePorts,
      activation: { resolve: manager.resolveDesktopActivation }
    }
  })
  releaseApplication = applicationAccess.registerDesktopApplication(application)
  await application.start()
}

beforeEach(() => {
  fs.rmSync(modelsDir(), { recursive: true, force: true })
})
afterEach(async () => {
  releaseApplication?.()
  await application?.stop()
  releaseApplication = null
  application = null
  vi.restoreAllMocks()
})
afterAll(() => {
  process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('reconcileActiveModelProjector', () => {
  it('writes the projector into active-model.json once it is on disk', async () => {
    writeActive(null) // activated before the catalog had a projector
    putFile(PROJECTOR) // projector now downloaded
    await startApplication()
    const reload = vi.spyOn(llm, 'reloadModel').mockImplementation(() => {})

    const healed = await manager.reconcileActiveModelProjector()

    expect(healed).toBe(true)
    expect(JSON.parse(fs.readFileSync(activeFile(), 'utf-8')).mmproj).toBe(PROJECTOR)
    expect(reload).toHaveBeenCalled() // engine reloaded so it picks up the projector
  })

  it('does nothing while the projector is not yet downloaded', async () => {
    writeActive(null)
    // no projector file on disk
    await startApplication()
    const reload = vi.spyOn(llm, 'reloadModel').mockImplementation(() => {})

    const healed = await manager.reconcileActiveModelProjector()

    expect(healed).toBe(false)
    expect(JSON.parse(fs.readFileSync(activeFile(), 'utf-8')).mmproj).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('leaves an already-reconciled config untouched', async () => {
    writeActive(PROJECTOR) // already records the projector
    putFile(PROJECTOR)
    await startApplication()
    const reload = vi.spyOn(llm, 'reloadModel').mockImplementation(() => {})

    expect(await manager.reconcileActiveModelProjector()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('reconcileActiveModelClassification', () => {
  it('moves a legacy Holo chat selection into Computer Use and clears the text route', async () => {
    writeActiveModel(HOLO_ID, HOLO_PRIMARY)
    putModelFiles(HOLO_ID)
    await startApplication()

    expect(await manager.reconcileActiveModelClassification()).toBe(true)

    expect(fs.existsSync(activeFile())).toBe(false)
    expect(manager.getActiveModalities().computer_use).toBe(HOLO_ID)
    expect(manager.getActiveModalities().text).toBeNull()
  })

  it('does not replace an explicit Computer Use selection during migration', async () => {
    writeActiveModel(HOLO_ID, HOLO_PRIMARY)
    putModelFiles(HOLO_ID)
    putModelFiles('mradermacher/Holo-3.1-0.8B-GGUF')
    await startApplication()
    await manager.setActiveModalChoice('computer_use', 'mradermacher/Holo-3.1-0.8B-GGUF')

    expect(await manager.reconcileActiveModelClassification()).toBe(true)

    expect(manager.getActiveModalities().computer_use).toBe('mradermacher/Holo-3.1-0.8B-GGUF')
    expect(manager.getActiveModalities().text).toBeNull()
  })
})
