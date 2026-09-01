import fs from 'node:fs'
import path from 'node:path'
import type { RuntimeModel } from '@offgrid/models'

const TEST_INVENTORY_ADAPTER = 'desktop.test-compatible-inventory'
const TEST_GENERATION_ADAPTER = 'desktop.test-compatible-generation'
const TEST_CLASSIFIER_ADAPTER = `${TEST_GENERATION_ADAPTER}.classifier`
const TEST_TOOL_SELECTION_ADAPTER = `${TEST_GENERATION_ADAPTER}.tool-selection`

function readJson(name: string): Record<string, unknown> {
  try {
    const dataDir = process.env.OFFGRID_DATA_DIR
    if (!dataDir) return {}
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'models', name), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

function selectedId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function compatibleModels(): RuntimeModel[] {
  const activeText = readJson('active-model.json')
  const activeModalities = readJson('active-modalities.json')
  const routes: RuntimeModel[] = []
  const textId = selectedId(activeText.id)
  if (textId) {
    const base: RuntimeModel = {
      id: textId,
      name: textId,
      kind: 'vision',
      modality: 'text',
      source: 'local',
      adapterId: TEST_GENERATION_ADAPTER,
      capabilities: {
        textGeneration: true,
        vision: true,
        tools: true,
        thinking: true,
        streaming: true,
        structuredOutput: true
      },
      installed: true,
      ready: true,
      loaded: true,
      residencyMode: 'persistent'
    }
    routes.push(
      base,
      {
        ...base,
        modality: 'classifier',
        adapterId: TEST_CLASSIFIER_ADAPTER,
        capabilities: { classification: true, thinking: true, streaming: true }
      },
      {
        ...base,
        modality: 'tool_selection',
        adapterId: TEST_TOOL_SELECTION_ADAPTER,
        capabilities: {
          tools: true,
          toolSelection: true,
          thinking: true,
          streaming: true,
          structuredOutput: true
        }
      }
    )
  }

  const imageId = selectedId(activeModalities.image)
  if (imageId) {
    routes.push({
      id: imageId,
      name: imageId,
      kind: 'image',
      modality: 'image',
      source: 'local',
      adapterId: 'desktop.image',
      capabilities: { imageGeneration: true },
      installed: true,
      ready: true,
      loaded: false,
      dirtyMemory: true,
      residencyMode: 'operation'
    })
  }

  const voiceId = selectedId(activeModalities.speech) ?? 'desktop-test-voice'
  routes.push({
    id: voiceId,
    name: voiceId,
    kind: 'voice',
    modality: 'voice',
    source: 'local',
    adapterId: 'desktop.tts',
    capabilities: { speechSynthesis: true },
    installed: true,
    ready: true,
    loaded: false,
    residencyMode: 'operation'
  })

  const transcriptionId = selectedId(activeModalities.transcription)
  if (transcriptionId) {
    routes.push({
      id: transcriptionId,
      name: transcriptionId,
      kind: 'transcription',
      modality: 'transcription',
      source: 'local',
      adapterId: 'desktop.transcription',
      capabilities: { transcription: true, audioInput: true },
      installed: true,
      ready: true,
      loaded: false,
      residencyMode: 'operation'
    })
  }

  return routes
}

/**
 * Register one test-only inventory route over Desktop's real local generation adapter.
 *
 * Native-boundary journeys create tiny engines and an active-model.json file instead
 * of installing the complete production catalog. GenerationService must still receive
 * an explicit compatible RuntimeModel: raw engine readiness alone is not routing state.
 * The adapter reads the selection on each refresh, so install/select/relaunch journeys
 * can change the active model without replacing the harness.
 */
export async function installCompatibleGenerationModel(): Promise<() => void> {
  // Import after the test module has installed its Electron/native boundary fakes.
  // A setup-file top-level import would lock in the real Electron module before
  // vi.mock is applied and make database paths unavailable in the test worker.
  const [{ desktopModelServices }, adapters] = await Promise.all([
    import('../../model-services'),
    import('../../model-generation-adapters')
  ])
  const unregisterInventory = desktopModelServices.llm.registerAdapter({
    id: TEST_INVENTORY_ADAPTER,
    listModels: async () => compatibleModels()
  })
  const observations = new adapters.DesktopGenerationObservations()
  const unregisterGeneration = [
    TEST_GENERATION_ADAPTER,
    TEST_CLASSIFIER_ADAPTER,
    TEST_TOOL_SELECTION_ADAPTER
  ].map((adapterId) =>
    desktopModelServices.generation.registerAdapter(
      new adapters.DesktopLocalGenerationAdapter(observations, adapterId)
    )
  )
  return () => {
    for (const unregister of unregisterGeneration) unregister()
    unregisterInventory()
  }
}
