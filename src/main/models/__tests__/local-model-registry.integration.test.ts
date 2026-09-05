import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-local-registry-integration-'))
process.env.OFFGRID_DATA_DIR = dataDir

const [applicationModule, modelServices, manager, applicationAccess] = await Promise.all([
  import('@offgrid/application'),
  import('../../model-services'),
  import('../../models-manager'),
  import('../../composition/application-access')
])
const application = applicationModule.createOffGridApplication({
  models: {
    ...modelServices.desktopModelWorkspacePorts,
    library: manager.desktopModelLibraryPorts
  }
})
const releaseApplication = applicationAccess.registerDesktopApplication(application)
await application.start()

afterAll(async () => {
  await application.stop()
  releaseApplication()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('local model registry application boundary', () => {
  it('does not overwrite damaged state or report a successful import', async () => {
    const modelsDir = path.join(dataDir, 'models')
    const registry = path.join(modelsDir, 'local-models.json')
    const source = path.join(dataDir, 'valid-local.gguf')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.writeFileSync(registry, '{damaged')
    fs.writeFileSync(
      source,
      Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 12)])
    )

    await expect(manager.importLocalModel(source)).resolves.toEqual({
      success: false,
      error: 'The local model library is damaged. Repair it before changing local models.'
    })
    expect(fs.readFileSync(registry, 'utf8')).toBe('{damaged')
    expect(fs.existsSync(path.join(modelsDir, 'valid-local.gguf'))).toBe(false)
  })
})
