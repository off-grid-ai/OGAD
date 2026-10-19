// @vitest-environment jsdom
// What each Active-models slot says a model can do. The real panel runs over the shared capability
// rule; only Main is faked, at the IPC line, with catalog rows shaped like the ones it sends.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelPicker } from '../ModelPicker'
import { withTaskRoles } from './harness/task-roles'

afterEach(() => {
  cleanup()
})

const MODELS = [
  {
    id: 'local/gemma',
    name: 'Gemma 4 E4B',
    kind: 'vision',
    params: 4,
    tools: true,
    reasoning: true,
    files: [
      { name: 'gemma.gguf', role: 'primary' },
      { name: 'mmproj-gemma.gguf', role: 'mmproj' }
    ]
  },
  {
    id: 'local/qwen',
    name: 'Qwen 3.8 4B Distill',
    kind: 'text',
    params: 4,
    tools: true,
    files: [{ name: 'qwen.gguf', role: 'primary' }]
  },
  {
    id: 'local/smol',
    name: 'SmolLM2 135M',
    kind: 'text',
    files: [{ name: 'smol.gguf', role: 'primary', sizeBytes: 135_000_000 }]
  },
  {
    id: 'external:posix-decider',
    name: 'Decider 2B',
    kind: 'text',
    files: [{ name: '/Users/me/models/decision-eval/decider-2b.gguf', role: 'primary' }]
  },
  {
    id: 'external:windows-decider',
    name: 'Decider 0.8B',
    kind: 'text',
    files: [{ name: 'C:\\models\\decision-eval\\decider-0.8b.gguf', role: 'primary' }]
  },
  {
    id: 'image/qwen-image',
    name: 'Qwen-Image 2.1',
    kind: 'image',
    imageModes: ['txt2img', 'img2img'],
    files: [
      { name: 'qwen-image.gguf', role: 'primary' },
      { name: 'qwen-image-mmproj.gguf', role: 'mmproj' }
    ]
  },
  {
    id: 'image/z-image',
    name: 'Z-Image Turbo',
    kind: 'image',
    imageModes: ['txt2img'],
    files: [{ name: 'z-image.gguf', role: 'primary' }]
  },
  {
    id: 'stt/whisper-small',
    name: 'Whisper Small',
    kind: 'transcription',
    files: [{ name: 'ggml-small.bin', role: 'primary' }]
  },
  {
    id: 'stt/whisper-small-en',
    name: 'Whisper Small English',
    kind: 'transcription',
    sourceModelId: 'ggerganov/whisper.cpp/small.en',
    files: [{ name: 'ggml-small.en.bin', role: 'primary' }]
  }
]

function renderPicker(): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getModelCatalog: async () => ({ models: MODELS }),
    getInstalledModels: async () => MODELS.map((model) => model.id),
    getActiveModel: async () => 'local/gemma',
    getActiveModalities: async () => ({
      image: 'qwen-image.gguf',
      transcription: 'ggml-small.bin'
    }),
    getActiveModelIds: async () => [],
    getComputerUseActiveModels: async () => ({
      strategy: 'same_as_chat',
      strategyLabel: 'Same as Chat',
      models: []
    })
  }
  withTaskRoles((window as unknown as { api: Record<string, unknown> }).api)
  render(<ModelPicker onClose={() => {}} />)
}

const iconNames = (element: HTMLElement): string[] =>
  within(element)
    .queryAllByRole('img')
    .map((icon) => icon.getAttribute('aria-label') ?? '')

describe('<ModelPicker/> capabilities', () => {
  it('names what the chosen chat model can do on its card', async () => {
    renderPicker()
    const card = await screen.findByLabelText('Text & Vision active model')
    await within(card).findByText('Gemma 4 E4B')
    expect(iconNames(card)).toEqual(['Sees images', 'Calls tools', 'Reasons step by step'])
  })

  it('lists the other chat models with their capabilities and size, never a staged decision model', async () => {
    renderPicker()
    await screen.findByText('Gemma 4 E4B')
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Text & Vision model' }))
    const qwen = await screen.findByRole('option', { name: /^Qwen 3\.8 4B Distill/ })
    expect(iconNames(qwen)).toEqual(['Calls tools'])
    expect(qwen.textContent).toContain('4B')
    const smol = screen.getByRole('option', { name: /^SmolLM2 135M/ })
    expect(iconNames(smol)).toEqual([])
    expect(smol.textContent).toContain('129 MB')
    // Decision models staged for evaluation stay out, whichever separator the path uses.
    expect(screen.queryByRole('option', { name: /Decider/ })).toBeNull()
  })

  it('marks image-to-image on image models, and never "sees images" for a generator', async () => {
    renderPicker()
    const card = await screen.findByLabelText('Image active model')
    await within(card).findByText('Qwen-Image 2.1')
    expect(iconNames(card)).toEqual(['Image to image'])
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Image model' }))
    expect(iconNames(await screen.findByRole('option', { name: /^Z-Image Turbo/ }))).toEqual([])
  })

  it('marks many languages on multilingual transcription, not on an English-only build', async () => {
    renderPicker()
    const card = await screen.findByLabelText('Transcription active model')
    await within(card).findByText('Whisper Small')
    expect(iconNames(card)).toEqual(['Many languages'])
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Transcription model' }))
    expect(
      iconNames(await screen.findByRole('option', { name: /^Whisper Small English/ }))
    ).toEqual([])
  })
})
