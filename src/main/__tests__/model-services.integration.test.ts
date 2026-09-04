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
import type { OffGridApplication } from '@offgrid/application'

const previousDataDir = process.env.OFFGRID_DATA_DIR
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-services-'))
const modelDirectory = path.join(profile, 'models')
const applications: OffGridApplication[] = []

type DesktopModelTestPorts = Parameters<
  typeof import('../model-services').createDesktopModelWorkspacePorts
>[0]

async function createModelsApplication(
  ports: DesktopModelTestPorts,
  selectionPersistence?: import('../model-selection-persistence').DesktopModelSelectionPersistence
): Promise<OffGridApplication> {
  const [applicationModule, modelServices, applicationAccess] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services'),
    import('../composition/application-access')
  ])
  const application = applicationModule.createOffGridApplication({
    models: modelServices.createDesktopModelWorkspacePorts(ports, selectionPersistence)
  })
  applicationAccess.registerDesktopApplication(application)
  applications.push(application)
  await application.start()
  return application
}

async function createComposedDesktopApplication(): Promise<OffGridApplication> {
  const [applicationModule, modelServices, applicationAccess, modelManager] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services'),
    import('../composition/application-access'),
    import('../models-manager')
  ])
  const application = applicationModule.createOffGridApplication({
    models: {
      ...modelServices.desktopModelWorkspacePorts,
      activation: { resolve: modelManager.resolveDesktopActivation }
    }
  })
  applicationAccess.registerDesktopApplication(application)
  applications.push(application)
  await application.start()
  return application
}

beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = profile
  fs.mkdirSync(modelDirectory, { recursive: true })
})

afterAll(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()))
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
    const application = await createModelsApplication({
      listCatalog: async () => [],
      listInstalled: async () => [],
      localTextRuntimeState: async () => ({ ready: false, loaded: false })
    })

    await expect(
      application.models.select({ modality: 'text', modelId: 'missing-model' })
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'unknown_model', identifier: 'missing-model' }
    })
    await expect(application.models.prepare('text')).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'unknown_model', identifier: '(no selection)' }
    })
  })

  // The panel's projection (active route -> catalog row, remote reference, or native id) is the
  // workspace's and is pinned in shared/packages/models/test/workspace.test.mjs.

  it('publishes runtime-managed speech readiness from the native adapter', async () => {
    const voice = CATALOG.find(
      (model) => model.kind === 'voice' && model.artifactDelivery === 'runtime'
    )
    if (!voice) throw new Error('The catalog needs a runtime-managed voice fixture.')

    const readyApplication = await createModelsApplication({
      listCatalog: async () => [voice],
      listInstalled: async () => [],
      localTextRuntimeState: async () => ({ ready: false, loaded: false }),
      localVoiceRuntimeState: async () => ({ installed: true, ready: true })
    })
    await readyApplication.models.refresh()
    const readyInventory = readyApplication.models.snapshot().inventory
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
      readyApplication.models.resolve({
        modality: 'voice',
        requiredCapabilities: { speechSynthesis: true }
      }).candidates[0]
    ).toMatchObject({ id: voice.id, adapterId: 'desktop.tts' })

    const unavailableApplication = await createModelsApplication({
      listCatalog: async () => [voice],
      listInstalled: async () => [voice.id],
      localTextRuntimeState: async () => ({ ready: false, loaded: false }),
      localVoiceRuntimeState: async () => ({ installed: false, ready: false })
    })
    await unavailableApplication.models.refresh()
    expect(
      unavailableApplication.models.resolve({
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
    const desktopApplication = await createComposedDesktopApplication()
    await desktopApplication.models.refresh()
    const inventory = desktopApplication.models.snapshot().inventory

    const visionRouteApplication = await createModelsApplication({
      listCatalog: async () => [{ ...text, kind: 'vision' }],
      listInstalled: async () => [text.id],
      localTextRuntimeState: async () => ({ ready: true, loaded: true })
    })
    await visionRouteApplication.models.refresh()
    const visionRouteInventory = visionRouteApplication.models.snapshot().inventory
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

    const thinkingRouteApplication = await createModelsApplication({
      listCatalog: async () => [{ ...text, kind: 'vision' }],
      listInstalled: async () => [text.id],
      localTextRuntimeState: async () => ({
        ready: true,
        loaded: true,
        reasoning: { transport: 'llama-server', control: 'enable-thinking' }
      })
    })
    await thinkingRouteApplication.models.refresh()
    const thinkingRouteInventory = thinkingRouteApplication.models.snapshot().inventory
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
    expect(desktopApplication.models.snapshot().active.text?.selectedRouteId).toMatch(
      /^model-route:v1:/
    )
    expect(desktopApplication.models.snapshot().active.image?.selectedRouteId).toMatch(
      /^model-route:v1:/
    )
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
    const startupApplication = await createModelsApplication({
      listCatalog: async () => [text],
      listInstalled: async () => [text.id],
      localTextRuntimeState: async () => ({ ready: nativeReady, loaded: nativeReady }),
      localTextLifecycle: {
        async load() {
          expect(startupApplication.models.snapshot().residents).toEqual([])
          nativeLoads += 1
          nativeReady = true
        },
        async unload() {
          nativeUnloads += 1
          nativeReady = false
        }
      }
    })

    await startupApplication.models.refresh()
    const startupInventory = startupApplication.models.snapshot().inventory
    expect(startupInventory.map((model) => [model.id, model.modality, model.ready])).toContainEqual(
      [text.id, 'text', true]
    )
    const startupTextRoute = startupInventory.find(
      (model) => model.id === text.id && model.modality === 'text'
    )?.routeId
    if (!startupTextRoute) throw new Error('The startup text fixture needs a canonical route.')
    await expect(
      startupApplication.models.select({ modality: 'text', modelId: startupTextRoute })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      startupApplication.models.load({ modality: 'text', modelId: startupTextRoute })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      startupApplication.models.load({ modality: 'text', modelId: startupTextRoute })
    ).resolves.toMatchObject({ ok: true })
    expect(nativeLoads).toBe(1)
    expect(startupApplication.models.snapshot().residents).toEqual([
      expect.objectContaining({
        key: expect.stringMatching(/^text:model-route:v1:/),
        modelId: expect.stringMatching(/^model-route:v1:/),
        type: 'text'
      })
    ])
    await expect(startupApplication.models.unload({ modality: 'text' })).resolves.toMatchObject({
      ok: true,
      value: true
    })
    expect(nativeUnloads).toBe(1)
    expect(startupApplication.models.snapshot().residents).toEqual([])

    const startupError = new Error('Native text runtime failed to start.')
    const failingStartupApplication = await createModelsApplication({
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
    await failingStartupApplication.models.refresh()
    await expect(
      failingStartupApplication.models.select({ modality: 'text', modelId: startupTextRoute })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      failingStartupApplication.models.load({ modality: 'text', modelId: startupTextRoute })
    ).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'runtime', message: startupError.message }
    })
    expect(failingStartupApplication.models.snapshot().residents).toEqual([])

    const { registerDesktopApplication } = await import('../composition/application-access')
    registerDesktopApplication(desktopApplication)
    await expect(manager.activateModel(image.id)).resolves.toEqual({ success: true })
    const persistedRoutes = JSON.parse(
      fs.readFileSync(path.join(modelDirectory, 'model-selections.json'), 'utf8')
    ) as { image: string }
    expect(persistedRoutes.image).toMatch(/^model-route:v1:/)
    expect(desktopApplication.models.snapshot().active.image).toMatchObject({
      selectedRouteId: persistedRoutes.image,
      model: { id: image.id, adapterId: 'desktop.image' }
    })
    expect(
      JSON.parse(fs.readFileSync(path.join(modelDirectory, 'active-modalities.json'), 'utf8')).image
    ).toBe(image.id)

    expect(desktopApplication.models.snapshot().active.image?.selectedRouteId).toBe(
      persistedRoutes.image
    )

    await Promise.all(applications.splice(0).map((application) => application.stop()))
    const relaunchedApplication = await createComposedDesktopApplication()
    const { activeImageModel } = await import('../imagegen')
    await relaunchedApplication.models.refresh()
    expect(relaunchedApplication.models.activeModelId('image')).toBe(image.id)
    expect(activeImageModel()).toBe(imagePrimary)
  })

  it('does not downgrade installed-inventory filesystem failures to absence', async () => {
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
      await expect(manager.listInstalled()).rejects.toMatchObject({
        name: 'ModelFilesystemProbeError',
        code: 'MODEL_FILESYSTEM_PROBE_FAILED',
        filePath: target
      })
    } finally {
      stat.mockRestore()
    }
  })
})
