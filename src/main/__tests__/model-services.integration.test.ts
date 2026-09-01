/**
 * The Desktop composition root must project the same persisted selections through
 * the shared LLMService that the existing IPC model manager returns. The filesystem
 * is the only test boundary; catalog, inventory, selection codecs, and projections
 * are all production code.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CATALOG } from '@offgrid/models'

const previousDataDir = process.env.OFFGRID_DATA_DIR
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-services-'))
const modelDirectory = path.join(profile, 'models')

beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = profile
  fs.mkdirSync(modelDirectory, { recursive: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop shared model-service composition', () => {
  it('keeps remote media routes off local native engines', async () => {
    const { desktopAdapterId } = await import('../model-services')
    expect(desktopAdapterId('remote', 'image')).toBe('desktop.remote-image')
    expect(desktopAdapterId('remote', 'transcription')).toBe('desktop.remote-transcription')
    expect(desktopAdapterId('remote', 'voice')).toBe('desktop.remote-voice')
    expect(desktopAdapterId('local', 'image')).toBe('desktop.image')
    expect(desktopAdapterId('local', 'transcription')).toBe('desktop.transcription')
    expect(desktopAdapterId('local', 'voice')).toBe('desktop.tts')
  })

  it('uses one canonical inventory and active selection projection', async () => {
    const text = CATALOG.find(
      (model) =>
        (model.kind === 'text' || model.kind === 'vision') &&
        model.availability !== 'coming_soon' &&
        model.files.length > 0
    )
    const image = CATALOG.find(
      (model) =>
        model.kind === 'image' &&
        model.availability !== 'coming_soon' &&
        model.files.length > 0 &&
        model.runtime !== 'mflux'
    )
    if (!text || !image) throw new Error('The catalog needs text and image fixtures.')

    for (const model of [text, image]) {
      for (const file of model.files) {
        fs.writeFileSync(path.join(modelDirectory, file.name), Buffer.alloc(64, 1))
      }
    }
    const textPrimary = text.files.find((file) => file.role !== 'mmproj')?.name
    const textProjector = text.files.find((file) => file.role === 'mmproj')?.name ?? null
    if (!textPrimary) throw new Error('The text fixture needs a primary file.')
    fs.writeFileSync(
      path.join(modelDirectory, 'active-model.json'),
      JSON.stringify({ id: text.id, primary: textPrimary, mmproj: textProjector })
    )
    const imagePrimary = image.files.find((file) => file.role !== 'mmproj')?.name
    if (!imagePrimary) throw new Error('The image fixture needs a primary file.')
    fs.writeFileSync(
      path.join(modelDirectory, 'active-modalities.json'),
      JSON.stringify({ image: imagePrimary })
    )

    const manager = await import('../models-manager')
    const { createDesktopModelServices, desktopModelServices } = await import('../model-services')
    const inventory = await desktopModelServices.refresh()

    expect(inventory.find((model) => model.id === text.id)).toMatchObject({
      modality: 'text',
      source: 'local',
      installed: true,
      adapterId: 'desktop.llama',
      residentSizeMB: Math.ceil(
        text.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) / (1024 * 1024)
      )
    })
    expect(inventory.find((model) => model.id === image.id)).toMatchObject({
      modality: 'image',
      source: 'local',
      installed: true,
      adapterId: 'desktop.image',
      residentSizeMB: Math.ceil(
        image.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) / (1024 * 1024)
      )
    })
    const embedding = inventory.find((model) => model.modality === 'embedding')
    expect(embedding).toMatchObject({
      id: 'all-MiniLM-L6-v2',
      adapterId: 'desktop.embedding',
      ready: true,
      residentSizeMB: 96,
      peakSizeMB: 160
    })
    expect(inventory.find((model) => model.id === image.id)?.peakSizeMB).toBe(
      Math.ceil(
        (image.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) / (1024 * 1024)) * 1.4
      )
    )
    expect(desktopModelServices.llm.active('text').selectedId).toMatch(/^model-route:v1:/)
    expect(desktopModelServices.llm.active('image').selectedId).toMatch(/^model-route:v1:/)
    const migratedSelections = JSON.parse(
      fs.readFileSync(path.join(modelDirectory, 'model-selections.json'), 'utf8')
    ) as { text: string; image: string }
    expect(migratedSelections).toMatchObject({
      text: expect.stringMatching(/^model-route:v1:/),
      image: expect.stringMatching(/^model-route:v1:/)
    })
    expect(manager.getActiveModalities()).toMatchObject({ text: text.id, image: image.id })
    expect(await manager.getActiveModelIds()).toEqual(expect.arrayContaining([text.id, image.id]))

    let nativeReady = false
    let nativeLoads = 0
    let nativeUnloads = 0
    const startupServices = createDesktopModelServices({
      listCatalog: async () => [text],
      listInstalled: async () => [text.id],
      localTextRuntimeState: async () => ({ ready: nativeReady, loaded: nativeReady }),
      localTextLifecycle: {
        async load() {
          expect(startupServices.residency.getResidents()).toEqual([])
          nativeLoads += 1
          nativeReady = true
        },
        async unload() {
          nativeUnloads += 1
          nativeReady = false
        }
      }
    })

    const startupInventory = await startupServices.refresh()
    expect(startupInventory.map((model) => [model.id, model.modality, model.ready])).toContainEqual(
      [text.id, 'text', true]
    )
    const startupTextRoute = startupInventory.find(
      (model) => model.id === text.id && model.modality === 'text'
    )?.routeId
    if (!startupTextRoute) throw new Error('The startup text fixture needs a canonical route.')
    await startupServices.llm.select('text', startupTextRoute)
    await expect(startupServices.warmText()).resolves.toBe(true)
    await expect(startupServices.warmText()).resolves.toBe(false)
    expect(nativeLoads).toBe(1)
    expect(startupServices.residency.getResidents()).toEqual([
      expect.objectContaining({
        key: expect.stringMatching(/^text:model-route:v1:/),
        modelId: expect.stringMatching(/^model-route:v1:/),
        type: 'text'
      })
    ])
    await expect(startupServices.unload('text')).resolves.toBe(true)
    expect(nativeUnloads).toBe(1)
    expect(startupServices.residency.getResidents()).toEqual([])

    const startupError = new Error('Native text runtime failed to start.')
    const failingStartupServices = createDesktopModelServices({
      listCatalog: async () => [text],
      listInstalled: async () => [text.id],
      localTextRuntimeState: async () => ({ ready: false, loaded: false }),
      localTextLifecycle: {
        load: async () => {
          throw startupError
        },
        unload: async () => undefined
      }
    })
    await failingStartupServices.refresh()
    await failingStartupServices.llm.select('text', startupTextRoute)
    await expect(failingStartupServices.warmText()).rejects.toBe(startupError)
    expect(failingStartupServices.residency.getResidents()).toEqual([])

    await expect(manager.activateModel(image.id)).resolves.toEqual({ success: true })
    const persistedRoutes = JSON.parse(
      fs.readFileSync(path.join(modelDirectory, 'model-selections.json'), 'utf8')
    ) as { image: string }
    expect(persistedRoutes.image).toMatch(/^model-route:v1:/)
    expect(desktopModelServices.llm.active('image')).toMatchObject({
      selectedId: persistedRoutes.image,
      model: { id: image.id, adapterId: 'desktop.image' }
    })
    expect(
      JSON.parse(fs.readFileSync(path.join(modelDirectory, 'active-modalities.json'), 'utf8')).image
    ).toBe(image.id)

    expect(desktopModelServices.llm.active('image').selectedId).toBe(persistedRoutes.image)

    vi.resetModules()
    const [{ desktopModelServices: relaunchedServices }, { activeImageModel }] = await Promise.all([
      import('../model-services'),
      import('../imagegen')
    ])
    await relaunchedServices.refresh()
    expect(relaunchedServices.activeModalities().image).toBe(image.id)
    expect(activeImageModel()).toBe(imagePrimary)
  })
})
