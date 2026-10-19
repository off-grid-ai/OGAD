import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureRuntime, modelsDir } from '../runtime-env'
import { recordDownloaded } from '../downloaded-models'
import { listImageModels } from '../imagegen'

// An image model downloaded from a Hugging Face search on the Image tab can have any filename. Main
// records it as an image model (the repo is labelled text-to-image), and the image runtime must then
// offer it, not only the files whose names match a known diffusion family. Real files on a real
// models folder; nothing of ours is faked.
let profile: string

beforeEach(() => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-hf-image-')))
  configureRuntime({ dataDir: profile, modelsDir: path.join(profile, 'models') })
  fs.mkdirSync(modelsDir(), { recursive: true })
})

afterEach(() => {
  configureRuntime({ dataDir: undefined, modelsDir: undefined })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('image models downloaded from Hugging Face', () => {
  it('offers a downloaded image model whose filename names no known diffusion family', () => {
    const file = 'chroma-unlocked-v50-Q4_K_M.gguf'
    fs.writeFileSync(path.join(modelsDir(), file), 'GGUF synthetic image weights')
    // Before it is recorded as an image model, the filename alone does not make it one.
    expect(listImageModels()).not.toContain(file)

    recordDownloaded(modelsDir(), {
      id: 'someone/Chroma-GGUF',
      name: 'Chroma-GGUF',
      kind: 'image',
      files: [file]
    })
    expect(listImageModels()).toContain(file)
  })

  it('does not offer a downloaded text model as an image model', () => {
    const file = 'chroma-chat-Q4_K_M.gguf'
    fs.writeFileSync(path.join(modelsDir(), file), 'GGUF synthetic text weights')
    recordDownloaded(modelsDir(), {
      id: 'someone/Chroma-Chat-GGUF',
      name: 'Chroma-Chat-GGUF',
      kind: 'text',
      files: [file]
    })
    expect(listImageModels()).not.toContain(file)
  })
})
