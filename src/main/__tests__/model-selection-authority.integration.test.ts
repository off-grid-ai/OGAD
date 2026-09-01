import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CATALOG,
  LLMService,
  decodeModelRouteId,
  type ModelModality,
  type RuntimeModel
} from '@offgrid/models'

const previousDataDir = process.env.OFFGRID_DATA_DIR
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-selection-authority-'))
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

describe('Desktop active-model authority', () => {
  it('uses the persisted route for inventory, runtime state, UI projection, and execution', async () => {
    const byKind = (kind: string) => {
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

    const [{ createDesktopModelServices }, { DesktopModelSelectionPersistence }] =
      await Promise.all([import('../model-services'), import('../model-selection-persistence')])
    const persistence = new DesktopModelSelectionPersistence(() => modelDirectory)
    const services = createDesktopModelServices(
      {
        listCatalog: async () => selectedModels,
        listInstalled: async () => selectedModels.map((model) => model.id),
        localTextRuntimeState: async () => ({ ready: true, loaded: true })
      },
      persistence
    )
    const inventory = await services.refresh()

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

      await expect(services.select(modality, inventoryRoute.routeId)).resolves.toEqual({
        success: true
      })

      const active = services.llm.active(modality)
      const executed = services.llm.resolveRoute({ modality, allowFallback: false }).selected
      expect(persistence.readCanonical(modality)).toBe(inventoryRoute.routeId)
      expect(active.selectedRouteId).toBe(inventoryRoute.routeId)
      expect(active.model).toMatchObject({
        id: modelId,
        routeId: inventoryRoute.routeId,
        loaded: inventoryRoute.loaded
      })
      expect(executed?.routeId).toBe(inventoryRoute.routeId)
    }

    expect(services.activeModalities()).toMatchObject({
      text: textModel.id,
      computer_use: computerUseModel.id,
      image: imageModel.id,
      speech: voiceModel.id,
      transcription: transcriptionModel.id
    })
    expect(await services.activeModelIds()).toEqual(
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
})
