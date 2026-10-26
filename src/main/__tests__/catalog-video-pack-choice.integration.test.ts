import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG } from '@offgrid/models'
import { flushDiagnosticLog } from '../diagnostics-log'
import { configureRuntime } from '../runtime-env'
import { getActiveModal } from '../active-models'
import { activateModel, getCatalog, videoModelFileName } from '../models-manager'

// A phone picks a video model from this computer's catalog by id, and a render loads a file.
// The models folder (a temp dir) is the only boundary. Activation and the catalog are the
// functions the gateway's /v1/models/activate and /v1/models/catalog routes return.
const COMFY_WAN21 = 'Comfy-Org/Wan_2.1_ComfyUI_repackaged'
const OFF_GRID_WAN21_LIGHT = 'off-grid-ai/Wan2.1-T2V-1.3B-GGUF-Q4'
const Q3_VARIANT = 'Wan2.1-T2V-1.3B-Q3_K_S.gguf'

let profile: string
let models: string

const fileNames = (id: string): string[] =>
  CATALOG.find((m) => m.id === id)!.files.map((f) => f.name)
const write = (name: string): void =>
  fs.writeFileSync(path.join(models, name), `GGUF${'x'.repeat(256)}`)

beforeEach(() => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-video-pack-choice-')))
  models = path.join(profile, 'models')
  fs.mkdirSync(models)
  configureRuntime({ dataDir: profile, modelsDir: models })
})
afterEach(async () => {
  await flushDiagnosticLog()
  configureRuntime({ dataDir: undefined, modelsDir: undefined })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('choosing a catalog video model', () => {
  beforeEach(() => {
    // The Comfy-Org fp16 pack, and an earlier Q3 build recorded under the same catalog family.
    for (const name of fileNames(COMFY_WAN21)) write(name)
    write(Q3_VARIANT)
    fs.writeFileSync(
      path.join(models, 'downloaded-models.json'),
      JSON.stringify([
        {
          id: 'pkg-wan21-q3',
          familyId: COMFY_WAN21,
          packageIdentity: 'pkg-wan21-q3',
          name: 'Wan 2.1 · Q3_K_S',
          kind: 'video',
          files: [Q3_VARIANT, 'wan_2.1_vae.safetensors', 'umt5-xxl-encoder-Q4_K_M.gguf']
        }
      ])
    )
  })

  it('uses its own pack when all its files are here, not a variant of the same family', async () => {
    expect(getActiveModal('video')).toBeNull()
    expect(await activateModel(COMFY_WAN21, 'video')).toEqual({ success: true })
    expect(getActiveModal('video')).toBe('wan2.1_t2v_1.3B_fp16.safetensors')
    // A render named by the same catalog id loads the same file.
    expect(await videoModelFileName(COMFY_WAN21)).toBe('wan2.1_t2v_1.3B_fp16.safetensors')
  })

  it('lets the recorded variant stand in when the catalog pack is not complete', async () => {
    fs.rmSync(path.join(models, 'wan2.1_t2v_1.3B_fp16.safetensors'))
    expect(await videoModelFileName(COMFY_WAN21)).toBe(Q3_VARIANT)
  })
})

describe('a phone naming a video model by catalog id', () => {
  it("resolves Off Grid AI's Light build to the weight file its pack loads", async () => {
    for (const name of fileNames(OFF_GRID_WAN21_LIGHT)) write(name)
    expect(await videoModelFileName(OFF_GRID_WAN21_LIGHT)).toBe(
      'Wan2.1-T2V-1.3B-calibrated-Q4_K_S.gguf'
    )
  })

  it('reads how much memory this computer has from the catalog', async () => {
    const catalog = (await getCatalog()) as { memoryGb: number; models: { id: string }[] }
    expect(catalog.memoryGb).toBe(Math.round(os.totalmem() / 1e9))
    expect(catalog.memoryGb).toBeGreaterThan(0)
    expect(catalog.models.map((m) => m.id)).toContain(COMFY_WAN21)
  })
})
