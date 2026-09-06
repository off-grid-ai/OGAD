// @vitest-environment jsdom

// Integration: the Models screen offers "Add vision support" for an INSTALLED
// vision-capable model whose projector isn't on disk (the Gemma 4 E2B case), and
// clicking it repairs the model by fetching only the missing projector. Real
// ModelsScreen; only window.api is faked, and its methods read mutable per-test state.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@testing-library/react'
import { modelControlBoundary } from './harness/model-control-snapshot'
import { ModelsScreen } from '../ModelsScreen'

type VisionStatus = Record<string, { supportsVision: boolean; projectorInstalled: boolean }>

const VISION_MODEL = {
  id: 'unsloth/gemma-4-E2B-it-GGUF',
  name: 'Gemma 4 E2B',
  kind: 'vision',
  org: 'google',
  params: 2,
  files: [
    { name: 'gemma-4-E2B-it-Q4_K_M.gguf', role: 'primary', sizeBytes: 3.1e9 },
    { name: 'mmproj-gemma-4-E2B-it-F16.gguf', role: 'mmproj', sizeBytes: 0.98e9 }
  ]
}

let visionStatus: VisionStatus = {}
const modelControl = modelControlBoundary({
  kinds: ['text', 'vision'],
  models: [VISION_MODEL],
  installed: [VISION_MODEL.id]
})

;(globalThis as unknown as { window: { api: unknown } }).window.api = {
  systemHealth: async () => ({ ramGb: 32 }),
  ...modelControl,
  getModelCatalog: async () => ({ kinds: ['text', 'vision'], models: [VISION_MODEL] }),
  getInstalledModels: async () => [VISION_MODEL.id],
  getModelVisionStatus: async () => visionStatus,
  getActiveModelIds: async () => [],
  onModelProgress: () => () => {},
  estimateModelFit: async () => ({ level: 'ok' })
}

beforeEach(() => {
  modelControl.reset()
})
afterEach(cleanup)

describe('<ModelsScreen/> — Add vision support', () => {
  it('shows the affordance for an installed vision model missing its projector, and repairs it on click', async () => {
    visionStatus = { [VISION_MODEL.id]: { supportsVision: true, projectorInstalled: false } }
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const btn = await screen.findByRole('button', { name: /add vision support/i })
    await user.click(btn)
    // The projector arrives through the one model-control command, named for this model.
    await waitFor(() =>
      expect(modelControl.intents).toEqual([
        { type: 'refresh', operationId: expect.any(String) },
        {
          type: 'repair-projector',
          modelId: VISION_MODEL.id,
          operationId: expect.any(String)
        }
      ])
    )
  })

  it('does NOT show it once the projector is installed', async () => {
    visionStatus = { [VISION_MODEL.id]: { supportsVision: true, projectorInstalled: true } }
    render(<ModelsScreen />)

    await screen.findByText('Gemma 4 E2B') // card rendered
    expect(screen.queryByRole('button', { name: /add vision support/i })).toBeNull()
  })
})
