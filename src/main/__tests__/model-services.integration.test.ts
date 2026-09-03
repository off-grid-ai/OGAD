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
    const { desktopAdapterId, LegacyDesktopModelIdCodec } = await import('../model-services')
    expect(desktopAdapterId('remote', 'image')).toBe('desktop.remote-image')
    expect(desktopAdapterId('remote', 'transcription')).toBe('desktop.remote-transcription')
    expect(desktopAdapterId('remote', 'voice')).toBe('desktop.remote-voice')
    expect(desktopAdapterId('local', 'image')).toBe('desktop.image')
    expect(desktopAdapterId('local', 'transcription')).toBe('desktop.transcription')
    expect(desktopAdapterId('local', 'voice')).toBe('desktop.tts')
    expect(desktopAdapterId('local', 'vision')).toBe('desktop.llama')
    expect(desktopAdapterId('remote', 'vision')).toBe('desktop.remote-chat')

    const ids = new LegacyDesktopModelIdCodec()
    ids.index([
      { id: 'unique', familyId: 'unique-family' },
      { id: 'first', familyId: 'shared-family' },
      { id: 'second', familyId: 'shared-family' }
    ])
    expect(ids.canonical('unique-family')).toBe('unique')
    expect(ids.canonical('shared-family')).toBe('shared-family')
  })

  it('fails selection and warm-up truthfully when no model route is available', async () => {
    const { createDesktopModelServices } = await import('../model-services')
    const services = createDesktopModelServices({
      listCatalog: async () => [],
      listInstalled: async () => [],
      localTextRuntimeState: async () => ({ ready: false, loaded: false }),
      resolveLegacyModelId: async () => {
        throw new Error('Legacy model lookup failed.')
      }
    })

    await expect(services.select('text', 'missing-model')).resolves.toEqual({
      success: false,
      error: 'Legacy model lookup failed.'
    })
    await expect(services.warmText()).rejects.toThrow('Models not downloaded')
  })

  // The panel's projection (active route -> catalog row, remote reference, or native id) is the
  // workspace's and is pinned in shared/packages/models/test/workspace.test.mjs.

  it('publishes runtime-managed speech readiness from the native adapter', async () => {
    const { createDesktopModelServices } = await import('../model-services')
    const voice = CATALOG.find(
      (model) => model.kind === 'voice' && model.artifactDelivery === 'runtime'
    )
    if (!voice) throw new Error('The catalog needs a runtime-managed voice fixture.')

    const readyServices = createDesktopModelServices({
      listCatalog: async () => [voice],
      listInstalled: async () => [],
      localTextRuntimeState: async () => ({ ready: false, loaded: false }),
      localVoiceRuntimeState: async () => ({ installed: true, ready: true })
    })
    const readyInventory = await readyServices.refresh()
    expect(readyInventory).toContainEqual(
      expect.objectContaining({
        id: voice.id,
        adapterId: 'desktop.tts',
        installed: true,
        ready: true,
        capabilities: expect.objectContaining({ speechSynthesis: true })
      })
    )
    expect(
      readyServices.llm.resolveRoute({
        modality: 'voice',
        requiredCapabilities: { speechSynthesis: true }
      }).candidates[0]
    ).toMatchObject({ id: voice.id, adapterId: 'desktop.tts' })

    const unavailableServices = createDesktopModelServices({
      listCatalog: async () => [voice],
      listInstalled: async () => [voice.id],
      localTextRuntimeState: async () => ({ ready: false, loaded: false }),
      localVoiceRuntimeState: async () => ({ installed: false, ready: false })
    })
    await unavailableServices.refresh()
    expect(
      unavailableServices.llm.resolveRoute({
        modality: 'voice',
        requiredCapabilities: { speechSynthesis: true }
      }).candidates
    ).toEqual([])
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

    const visionRouteServices = createDesktopModelServices({
      listCatalog: async () => [{ ...text, kind: 'vision' }],
      listInstalled: async () => [text.id],
      localTextRuntimeState: async () => ({ ready: true, loaded: true })
    })
    const visionRouteInventory = await visionRouteServices.refresh()
    expect(
      visionRouteInventory.some((model) => model.id === text.id && model.modality === 'vision')
    ).toBe(false)
    expect(
      visionRouteInventory.find((model) => model.id === text.id && model.modality === 'text')
        ?.capabilities
    ).toMatchObject({ textGeneration: true, vision: true })
    expect(
      visionRouteInventory.find(
        (model) => model.id === text.id && model.modality === 'computer_use'
      )?.capabilities
    ).toMatchObject({ vision: true, computerUse: true, thinking: false })

    const thinkingRouteServices = createDesktopModelServices({
      listCatalog: async () => [{ ...text, kind: 'vision' }],
      listInstalled: async () => [text.id],
      localTextRuntimeState: async () => ({
        ready: true,
        loaded: true,
        reasoning: { transport: 'llama-server', control: 'enable-thinking' }
      })
    })
    const thinkingRouteInventory = await thinkingRouteServices.refresh()
    expect(
      thinkingRouteInventory.find(
        (model) => model.id === text.id && model.modality === 'computer_use'
      )?.capabilities
    ).toMatchObject({ vision: true, computerUse: true, thinking: true })

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
    await startupServices.workspace.select('text', startupTextRoute)
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
    await failingStartupServices.workspace.select('text', startupTextRoute)
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

  it('does not downgrade catalog filesystem failures to a raw model name', async () => {
    const manager = await import('../models-manager')
    const artifact = CATALOG.flatMap((model) => model.files).find((file) => file.name)
    if (!artifact) throw new Error('The catalog needs a file-backed model fixture.')
    const target = path.join(modelDirectory, artifact.name)
    const originalStat = fs.statSync.bind(fs)
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const stat = vi.spyOn(fs, 'statSync').mockImplementation(((candidate: fs.PathLike) => {
      if (String(candidate) === target) throw denied
      return originalStat(candidate)
    }) as typeof fs.statSync)

    try {
      await expect(manager.resolveModelIdentity('unknown-model')).rejects.toMatchObject({
        name: 'ModelIdentityResolutionError',
        code: 'MODEL_IDENTITY_RESOLUTION_FAILED',
        modelId: 'unknown-model',
        cause: expect.objectContaining({
          name: 'ModelFilesystemProbeError',
          code: 'MODEL_FILESYSTEM_PROBE_FAILED',
          filePath: target
        })
      })
    } finally {
      stat.mockRestore()
    }
  })
})
