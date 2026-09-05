import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OffGridApplication } from '@offgrid/application'
import {
  CATALOG,
  LLMService,
  decodeModelRouteId,
  encodeModelRouteId,
  type CatalogEntry,
  type ModelModality,
  type RuntimeModel
} from '@offgrid/models'

const previousDataDir = process.env.OFFGRID_DATA_DIR
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-selection-authority-'))
const modelDirectory = path.join(profile, 'models')
const applications: OffGridApplication[] = []

// The journey uses the real Desktop remote-server adapter and its real SQLite credential cleanup.
// Only Electron's OS profile and encryption boundaries are replaced.
vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

type DesktopModelTestPorts = Parameters<
  typeof import('../model-services').createDesktopModelWorkspacePorts
>[0]

async function createModelsApplication(
  ports: DesktopModelTestPorts,
  selectionPersistence?: import('../model-selection-persistence').DesktopModelSelectionPersistence
): Promise<OffGridApplication> {
  const [
    { createOffGridApplication },
    { createDesktopModelWorkspacePorts },
    { registerDesktopApplication }
  ] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services'),
    import('../composition/application-access')
  ])
  const application = createOffGridApplication({
    models: createDesktopModelWorkspacePorts(ports, selectionPersistence)
  })
  applications.push(application)
  registerDesktopApplication(application)
  await application.start()
  return application
}

beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = profile
  fs.mkdirSync(modelDirectory, { recursive: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()))
})

describe('Desktop active-model authority', () => {
  it('uses the persisted route for inventory, runtime state, UI projection, and execution', async () => {
    const byKind = (kind: string): CatalogEntry => {
      const model = CATALOG.find(
        (candidate) => candidate.kind === kind && candidate.availability !== 'coming_soon'
      )
      if (!model) throw new Error(`The catalog needs a ready ${kind} fixture.`)
      return model
    }
    const textModel = byKind('vision')
    const computerUseModel = byKind('computer_use')
    const imageModel = byKind('image')
    const voiceModel = byKind('voice')
    const transcriptionModel = byKind('transcription')
    const selectedModels = [textModel, computerUseModel, imageModel, voiceModel, transcriptionModel]
    for (const model of selectedModels) {
      for (const file of model.files) {
        fs.writeFileSync(path.join(modelDirectory, file.name), Buffer.alloc(64, 1))
      }
    }

    const { DesktopModelSelectionPersistence } = await import('../model-selection-persistence')
    const persistence = new DesktopModelSelectionPersistence(() => modelDirectory)
    let textRuntimeLoaded = false
    const application = await createModelsApplication(
      {
        listCatalog: async () => selectedModels,
        listInstalled: async () => selectedModels.map((model) => model.id),
        localTextRuntimeState: async () => ({
          ready: textRuntimeLoaded,
          loaded: textRuntimeLoaded
        }),
        localTextLifecycle: {
          load: async () => {
            textRuntimeLoaded = true
          },
          unload: async () => {
            textRuntimeLoaded = false
          }
        },
        localVoiceRuntimeState: async () => ({ installed: true, ready: true })
      },
      persistence
    )
    await application.models.refresh()
    const inventory = application.models.snapshot().inventory

    const selections: Array<[ModelModality, string]> = [
      ['text', textModel.id],
      ['computer_use', computerUseModel.id],
      ['image', imageModel.id],
      ['voice', voiceModel.id],
      ['transcription', transcriptionModel.id],
      ['embedding', 'all-MiniLM-L6-v2']
    ]

    for (const [modality, modelId] of selections) {
      const inventoryRoute = inventory.find(
        (model) => model.modality === modality && model.id === modelId
      )
      if (!inventoryRoute?.routeId) {
        throw new Error(
          `No ${modality} route for ${modelId}. Inventory: ${inventory
            .map((model) => `${model.modality}:${model.id}`)
            .join(', ')}`
        )
      }

      await expect(
        application.models.select({ modality, modelId: inventoryRoute.routeId })
      ).resolves.toMatchObject({ ok: true })
      if (modality === 'text') {
        await expect(application.models.prepare(modality)).resolves.toMatchObject({ ok: true })
      }

      const active = application.models.snapshot().active[modality]
      const executed = application.models.resolve({ modality, allowFallback: false }).selected
      const currentInventoryRoute = application.models.lookup(inventoryRoute.routeId)
      if (!active) throw new Error(`No active-model projection exists for ${modality}.`)
      if (!currentInventoryRoute) throw new Error(`The selected ${modality} route disappeared.`)
      expect(persistence.readCanonical(modality)).toBe(inventoryRoute.routeId)
      expect(active.selectedRouteId).toBe(inventoryRoute.routeId)
      expect(active.model).toMatchObject({
        id: modelId,
        routeId: inventoryRoute.routeId,
        loaded: currentInventoryRoute.loaded,
        ready: true
      })
      expect(executed?.routeId).toBe(inventoryRoute.routeId)
    }

    expect(application.models.activeModelId('text')).toBe(textModel.id)
    expect(application.models.activeModelId('computer_use')).toBe(computerUseModel.id)
    expect(application.models.activeModelId('image')).toBe(imageModel.id)
    expect(application.models.activeModelId('voice')).toBe(voiceModel.id)
    expect(application.models.activeModelId('transcription')).toBe(transcriptionModel.id)
    expect(application.models.activeModelIds()).toEqual(
      expect.arrayContaining([...selectedModels.map((model) => model.id), 'all-MiniLM-L6-v2'])
    )
  })

  it('migrates the legacy remote active server into the exact shared execution route', async () => {
    const remoteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-selection-'))
    try {
      fs.writeFileSync(
        path.join(remoteDirectory, 'remote-vision-server.json'),
        JSON.stringify({
          version: 3,
          activeServerId: 'remote-a',
          servers: [
            {
              id: 'remote-a',
              name: 'Remote A',
              provider: 'openrouter',
              endpoint: 'https://openrouter.ai/api/v1',
              model: 'google/gemini-test',
              screenFramesAllowed: false
            }
          ]
        })
      )
      const { DesktopModelSelectionPersistence } = await import('../model-selection-persistence')
      const persistence = new DesktopModelSelectionPersistence(() => remoteDirectory)
      const migratedRoute = persistence.read('text')
      expect(decodeModelRouteId(migratedRoute ?? '')).toEqual({
        adapterId: 'desktop.remote-chat',
        providerId: 'openrouter',
        serverId: 'remote-a',
        modelId: 'google/gemini-test'
      })
      expect(persistence.readCanonical('text')).toBe(migratedRoute)

      const remoteModel: RuntimeModel = {
        id: 'google/gemini-test',
        name: 'Gemini test',
        kind: 'vision',
        modality: 'text',
        source: 'remote',
        adapterId: 'desktop.remote-chat',
        providerId: 'openrouter',
        serverId: 'remote-a',
        capabilities: { textGeneration: true, vision: true, streaming: true },
        installed: true,
        ready: true,
        loaded: true
      }
      const llm = new LLMService(persistence)
      llm.registerAdapter({ id: 'desktop.remote-chat', listModels: async () => [remoteModel] })
      await llm.refresh()
      const active = llm.active('text')
      expect(active.selectedRouteId).toBe(migratedRoute)
      expect(active.model).toMatchObject({
        id: remoteModel.id,
        serverId: remoteModel.serverId,
        loaded: true
      })
      expect(llm.resolveRoute({ modality: 'text', allowFallback: false }).selected?.routeId).toBe(
        migratedRoute
      )
    } finally {
      fs.rmSync(remoteDirectory, { recursive: true, force: true })
    }
  })

  it('clears every route for a removed remote server through the one selection writer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-clear-'))
    try {
      const { DesktopModelSelectionPersistence } = await import('../model-selection-persistence')
      const persistence = new DesktopModelSelectionPersistence(() => directory)
      const removedText = encodeModelRouteId({
        adapterId: 'desktop.remote-chat',
        providerId: 'openai',
        serverId: 'removed',
        modelId: 'text-model'
      })
      const removedImage = encodeModelRouteId({
        adapterId: 'desktop.remote-image',
        providerId: 'openai',
        serverId: 'removed',
        modelId: 'image-model'
      })
      const retained = encodeModelRouteId({
        adapterId: 'desktop.remote-voice',
        providerId: 'openai',
        serverId: 'retained',
        modelId: 'voice-model'
      })
      persistence.write('text', removedText)
      persistence.write('image', removedImage)
      persistence.write('voice', retained)
      persistence.projectLegacyModality('image', 'image-model')

      fs.mkdirSync(modelDirectory, { recursive: true })
      fs.writeFileSync(
        path.join(modelDirectory, 'remote-vision-server.json'),
        JSON.stringify({
          version: 4,
          servers: [
            {
              id: 'removed',
              name: 'Removed server',
              provider: 'custom',
              endpoint: 'https://removed.example/v1',
              model: 'text-model',
              selections: { text: 'text-model' },
              catalog: {},
              // A disabled server has no inventory rows. Its canonical selections must still clear.
              enabled: false
            }
          ]
        })
      )
      const application = await createModelsApplication(
        {
          listCatalog: async () => [],
          listInstalled: async () => [],
          localTextRuntimeState: async () => ({ ready: false, loaded: false })
        },
        persistence
      )
      expect(application.models.remoteServer('removed')).not.toBeNull()
      await application.models.removeRemoteServer('removed')

      expect(persistence.readCanonical('text')).toBeNull()
      expect(persistence.readCanonical('image')).toBeNull()
      expect(persistence.projectedModelId('image')).toBeNull()
      expect(persistence.readCanonical('voice')).toBe(retained)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
