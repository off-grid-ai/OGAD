import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverExternalModels } from '../external-models'
import { CATALOG } from '@offgrid/models'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function gguf(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(1024)]))
}

describe('external model discovery', () => {
  it('finds added folders without listing draft weights as chat models', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-external-'))
    roots.push(home)
    const folder = path.join(home, 'added')
    gguf(path.join(folder, 'chat.gguf'))
    gguf(path.join(folder, 'mtp-chat-Q8_0.gguf'))
    gguf(path.join(folder, 'chat-dflash.gguf'))
    const models = discoverExternalModels(home, path.join(home, 'missing'), undefined, [folder])
    expect(models.map((item) => item.name)).toEqual(['Chat'])
    expect(fs.readdirSync(folder)).toHaveLength(3)
  })

  it('finds LM Studio GGUF files in place and skips projectors', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-external-'))
    roots.push(home)
    const folder = path.join(home, '.lmstudio', 'models', 'publisher', 'model')
    gguf(path.join(folder, 'model.gguf'))
    gguf(path.join(folder, 'mmproj-model.gguf'))
    const models = discoverExternalModels(home, path.join(home, 'missing'))
    expect(models).toMatchObject([{ name: 'Model', source: 'LM Studio', kind: 'vision' }])
    expect(models[0]?.primary).toBe(fs.realpathSync(path.join(folder, 'model.gguf')))
    expect(models[0]?.mmproj).toBe(fs.realpathSync(path.join(folder, 'mmproj-model.gguf')))
  })

  it('names a known model file by its catalog name, never its file name', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-external-'))
    roots.push(home)
    const known = CATALOG.find(
      (entry) =>
        entry.kind === 'text' &&
        entry.files.length === 1 &&
        entry.files[0]!.name.toLowerCase().endsWith('.gguf')
    )!
    const folder = path.join(home, '.lmstudio', 'models', 'publisher', 'known')
    gguf(path.join(folder, known.files[0]!.name))
    const models = discoverExternalModels(home, path.join(home, 'missing'))
    expect(models.map((item) => item.name)).toEqual([known.name])
  })

  it('does not attach one projector to several weights in the same folder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-external-'))
    roots.push(home)
    const folder = path.join(home, '.lmstudio', 'models', 'publisher', 'model')
    gguf(path.join(folder, 'first.gguf'))
    gguf(path.join(folder, 'second.gguf'))
    gguf(path.join(folder, 'mmproj.gguf'))
    const models = discoverExternalModels(home, path.join(home, 'missing'))
    expect(models).toHaveLength(2)
    expect(models.every((item) => item.kind === 'text' && !item.mmproj)).toBe(true)
  })

  it('resolves Ollama manifest model layers to GGUF blobs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-external-'))
    roots.push(home)
    const root = path.join(home, 'ollama-models')
    const digest = 'a'.repeat(64)
    const blob = path.join(root, 'blobs', `sha256-${digest}`)
    gguf(blob)
    const projectorDigest = 'b'.repeat(64)
    const projector = path.join(root, 'blobs', `sha256-${projectorDigest}`)
    gguf(projector)
    const manifest = path.join(
      root,
      'manifests',
      'registry.ollama.ai',
      'library',
      'example',
      'latest'
    )
    fs.mkdirSync(path.dirname(manifest), { recursive: true })
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        layers: [
          { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${digest}` },
          {
            mediaType: 'application/vnd.ollama.image.projector',
            digest: `sha256:${projectorDigest}`
          }
        ]
      })
    )
    expect(discoverExternalModels(home, root)).toMatchObject([
      {
        name: 'Example',
        source: 'Ollama',
        primary: fs.realpathSync(blob),
        mmproj: fs.realpathSync(projector),
        kind: 'vision'
      }
    ])
  })

  it('finds nested GGUF files in a selected storage folder without treating root files as external', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-external-'))
    roots.push(home)
    const selected = path.join(home, 'chosen')
    gguf(path.join(selected, 'managed.gguf'))
    gguf(path.join(selected, 'publisher', 'model.gguf'))
    const models = discoverExternalModels(home, path.join(home, 'missing'), selected)
    expect(models).toMatchObject([{ name: 'Model', source: 'Selected folder' }])
  })

  it('does not offer image or incomplete vision packages as chat models', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'og-external-'))
    roots.push(home)
    const folder = path.join(home, '.lmstudio', 'models', 'publisher', 'model')
    const image = CATALOG.find(
      (entry) => entry.kind === 'image' && entry.files.some((part) => part.name.endsWith('.gguf'))
    )
    const vision = CATALOG.find(
      (entry) => entry.kind === 'vision' && entry.files.some((part) => part.role === 'mmproj')
    )
    if (!image || !vision) throw new Error('Catalog needs image and vision packages')
    const imageWeight = image.files.find((part) => part.name.endsWith('.gguf'))!
    const visionWeight = vision.files.find(
      (part) => part.role === 'primary' && part.name.endsWith('.gguf')
    )!
    gguf(path.join(folder, path.basename(imageWeight.name)))
    gguf(path.join(folder, path.basename(visionWeight.name)))
    expect(discoverExternalModels(home, path.join(home, 'missing'))).toEqual([])
  })
})
