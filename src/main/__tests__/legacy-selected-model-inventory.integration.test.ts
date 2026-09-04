import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OffGridApplication } from '@offgrid/application'

const previousDataDir = process.env.OFFGRID_DATA_DIR
let profile: string
let modelsDir: string
let application: OffGridApplication | undefined

async function createModelsApplication(): Promise<OffGridApplication> {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }, applicationAccess] =
    await Promise.all([
      import('@offgrid/application'),
      import('../model-services'),
      import('../composition/application-access')
    ])
  const created = createOffGridApplication({ models: desktopModelWorkspacePorts })
  applicationAccess.registerDesktopApplication(created)
  await created.start()
  application = created
  return created
}

beforeEach(() => {
  vi.resetModules()
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-legacy-model-inventory-'))
  modelsDir = path.join(profile, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  process.env.OFFGRID_DATA_DIR = profile
})

afterEach(async () => {
  await application?.stop()
  application = undefined
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe.sequential('legacy selected local artifact inventory migration', () => {
  it('does not expose a legacy installed id when a canonical local entry owns its artifact', async () => {
    const artifact = 'shared-artifact.gguf'
    fs.writeFileSync(path.join(modelsDir, artifact), Buffer.from('GGUF canonical local'))
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: 'legacy-alias', primary: artifact, mmproj: null })
    )
    fs.writeFileSync(
      path.join(modelsDir, 'local-models.json'),
      JSON.stringify([
        {
          id: 'local:shared-artifact.gguf',
          name: 'Canonical local model',
          primary: artifact,
          kind: 'text',
          sizeBytes: fs.statSync(path.join(modelsDir, artifact)).size
        }
      ])
    )

    // The catalog's remote rows are the application's; boot its real model facade first.
    await createModelsApplication()
    const { getCatalog, listInstalled } = await import('../models-manager')
    const catalog = (await getCatalog()).models as Array<{ id: string }>
    const installed = await listInstalled()

    expect(catalog.some((model) => model.id === 'local:shared-artifact.gguf')).toBe(true)
    expect(catalog.some((model) => model.id === 'legacy-alias')).toBe(false)
    expect(installed).toContain('local:shared-artifact.gguf')
    expect(installed).not.toContain('legacy-alias')
  })

  it('projects an existing selected text artifact into canonical inventory once', async () => {
    const legacy = { id: 'legacy-local-text', primary: 'legacy-local-text.gguf', mmproj: null }
    fs.writeFileSync(path.join(modelsDir, legacy.primary), Buffer.from('GGUF legacy text'))
    fs.writeFileSync(path.join(modelsDir, 'active-model.json'), JSON.stringify(legacy))

    const app = await createModelsApplication()
    await app.models.refresh()
    const first = app.models.snapshot().inventory
    await app.models.refresh()
    const second = app.models.snapshot().inventory

    expect(
      first.filter((model) => model.id === legacy.id && model.modality === 'text')
    ).toHaveLength(1)
    expect(
      second.filter((model) => model.id === legacy.id && model.modality === 'text')
    ).toHaveLength(1)
    expect(app.models.snapshot().active.text).toMatchObject({
      selectedRouteId: expect.stringMatching(/^model-route:v1:/),
      model: { id: legacy.id, adapterId: 'desktop.llama', installed: true, ready: true }
    })
    expect(JSON.parse(fs.readFileSync(path.join(modelsDir, 'active-model.json'), 'utf8'))).toEqual(
      legacy
    )
  })

  it('projects an existing selected image artifact into canonical inventory once', async () => {
    const imageId = 'legacy-local-image.gguf'
    fs.writeFileSync(path.join(modelsDir, imageId), Buffer.from('GGUF legacy image'))
    fs.writeFileSync(
      path.join(modelsDir, 'active-modalities.json'),
      JSON.stringify({ image: imageId })
    )

    const app = await createModelsApplication()
    await app.models.refresh()
    const first = app.models.snapshot().inventory
    await app.models.refresh()
    const second = app.models.snapshot().inventory

    expect(
      first.filter((model) => model.id === imageId && model.modality === 'image')
    ).toHaveLength(1)
    expect(
      second.filter((model) => model.id === imageId && model.modality === 'image')
    ).toHaveLength(1)
    expect(app.models.snapshot().active.image).toMatchObject({
      selectedRouteId: expect.stringMatching(/^model-route:v1:/),
      model: { id: imageId, adapterId: 'desktop.image', installed: true, ready: true }
    })
    expect(
      JSON.parse(fs.readFileSync(path.join(modelsDir, 'active-modalities.json'), 'utf8'))
    ).toEqual({ image: imageId })
  })
})
