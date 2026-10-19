// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** A Kev package as the catalog sends it: checkpoint files, then the SafeTensors base. */
function kevPackage(spec: {
  size: string
  params: number
  baseRepo: string
  checkpoint: Record<string, number>
  base: Record<string, number>
}): Record<string, unknown> {
  const file =
    (folder: string, repo: string) =>
    ([name, sizeBytes]: [string, number]) => ({
      name: `kev-${spec.size}/${folder}/${name}`,
      url: `https://huggingface.co/${repo}/resolve/${'0'.repeat(40)}/${name}`,
      sizeBytes,
      role: name === 'head.pt' ? 'primary' : 'aux'
    })
  return {
    id: `jaredpalmer/kev-${spec.size}`,
    name: `Kev ${spec.size.toUpperCase()}`,
    kind: 'computer_use',
    org: 'Jared Palmer',
    description: 'Local pointer-head model for typed Computer Use decisions.',
    params: spec.params,
    minRamGb: spec.params === 4 ? 16 : 32,
    tags: ['Decision'],
    files: [
      ...Object.entries(spec.checkpoint).map(
        file('checkpoint-v1.0', `jaredpalmer/kev-${spec.size}`)
      ),
      ...Object.entries(spec.base).map(file('base', spec.baseRepo))
    ]
  }
}

const TOKENIZER = {
  'merges.txt': 3_353_259,
  'tokenizer.json': 12_807_196,
  'tokenizer_config.json': 16_713,
  'vocab.json': 6_722_759
}

const kev = kevPackage({
  size: '4b',
  params: 4,
  baseRepo: 'Qwen/Qwen3.5-4B-Base',
  checkpoint: {
    'head.pt': 5_249_791,
    'adapter_config.json': 1_271,
    'adapter_model.safetensors': 129_924_032
  },
  base: {
    'config.json': 3_161,
    'model.safetensors-00001-of-00002.safetensors': 5_329_398_712,
    'model.safetensors-00002-of-00002.safetensors': 3_990_429_344,
    'model.safetensors.index.json': 76_196,
    ...TOKENIZER
  }
})

const kev9b = kevPackage({
  size: '9b',
  params: 9,
  baseRepo: 'Qwen/Qwen3.5-9B-Base',
  checkpoint: {
    'head.pt': 8_395_071,
    'adapter_config.json': 1_271,
    'adapter_model.safetensors': 173_178_096
  },
  base: {
    'config.json': 3_126,
    'model.safetensors-00001-of-00004.safetensors': 5_276_436_216,
    'model.safetensors-00002-of-00004.safetensors': 5_335_161_576,
    'model.safetensors-00003-of-00004.safetensors': 5_368_717_376,
    'model.safetensors-00004-of-00004.safetensors': 3_325_995_704,
    'model.safetensors.index.json': 79_657,
    ...TOKENIZER
  }
})

;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({ kinds: ['computer_use'], models: [kev, kev9b] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => [],
  downloadModel: async () => ({ success: true })
}

describe('<ModelsScreen/> Kev details', () => {
  afterEach(cleanup)

  it('explains why the existing GGUF chat model cannot replace the SafeTensors base', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const card = (await screen.findByText('Kev 4B')).closest('[role="listitem"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Details' }))

    const details = await screen.findByRole('dialog', { name: 'Kev 4B details' })
    expect(within(details).getByRole('button', { name: /^Download$/ })).toBeTruthy()
    const format = within(details).getByRole('region', { name: 'Kev model format' })
    expect(within(format).getByText(/GGUF contains quantized weights for llama.cpp/)).toBeTruthy()
    expect(within(format).getByText(/9.34 GB across two SafeTensors files/)).toBeTruthy()
    expect(within(details).queryByRole('region', { name: 'Available model files' })).toBeNull()
  })

  it('describes Kev 9B from its own files: its base, four shards and their size', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const card = (await screen.findByText('Kev 9B')).closest('[role="listitem"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Details' }))

    const details = await screen.findByRole('dialog', { name: 'Kev 9B details' })
    const format = within(details).getByRole('region', { name: 'Kev model format' })
    expect(within(format).getByText(/original Qwen3.5-9B-Base SafeTensors weights/)).toBeTruthy()
    expect(within(format).getByText(/Qwen 3.5 9B GGUF chat model cannot be reused/)).toBeTruthy()
    expect(within(format).getByText(/19.33 GB across four SafeTensors files/)).toBeTruthy()
    expect(within(format).getByText(/182 MB Kev adapter/)).toBeTruthy()
    expect(within(details).queryByRole('region', { name: 'Available model files' })).toBeNull()
  })
})
