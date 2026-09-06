import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Electron is the only device boundary here; the image library is real files under a scratch data dir.
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0'
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'og-imagegen-library-')))
const dataDir = path.join(root, 'data')
const modelsDir = path.join(dataDir, 'models')
const resources = [path.join(root, 'resources-a'), path.join(root, 'resources-b')]
const gallery = path.join(dataDir, 'generated-images')

beforeAll(async () => {
  fs.mkdirSync(gallery, { recursive: true })
  fs.mkdirSync(modelsDir, { recursive: true })
  const { configureRuntime } = await import('../runtime-env')
  configureRuntime({ dataDir, resourceDirs: resources })
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function seedImage(name: string, ageMs: number, sidecar?: Record<string, unknown>): string {
  const file = path.join(gallery, name)
  fs.writeFileSync(file, Buffer.from(`png:${name}`))
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(file, when, when)
  if (sidecar) fs.writeFileSync(`${file}.json`, JSON.stringify(sidecar))
  return file
}

describe('generated image library', () => {
  it('lists real images newest first with their sidecar facts, skipping previews and foreign files', async () => {
    const { listGeneratedImages } = await import('../imagegen')
    seedImage('older.png', 60_000, { syncId: 's-old', conversationId: 'c1', projectId: 'p1' })
    seedImage('newer.jpg', 1_000, { syncId: 's-new', conversationId: 'c2' })
    seedImage('preview-step.png', 0)
    fs.writeFileSync(path.join(gallery, 'notes.txt'), 'not an image')

    const all = listGeneratedImages()
    expect(all.map((r) => r.name)).toEqual(['newer.jpg', 'older.png'])
    expect(all[0]).toMatchObject({ syncId: 's-new', conversationId: 'c2', projectId: null })
    expect(all[1]).toMatchObject({ syncId: 's-old', conversationId: 'c1', projectId: 'p1' })

    expect(listGeneratedImages({ conversationId: 'c1' }).map((r) => r.name)).toEqual(['older.png'])
    expect(listGeneratedImages({ projectId: 'p1' }).map((r) => r.name)).toEqual(['older.png'])
    // A conversation scope wins over a project scope when both are named.
    expect(listGeneratedImages({ conversationId: 'c2', projectId: 'p1' }).map((r) => r.name)).toEqual(['newer.jpg'])
  })

  it('saves scope by merging into the sidecar and refuses paths outside the library', async () => {
    const { saveGeneratedImageScope, listGeneratedImages } = await import('../imagegen')
    const file = seedImage('scoped.png', 0, { syncId: 'keep-me' })
    saveGeneratedImageScope(file, { conversationId: 'c9', projectId: 'p9' })
    const row = listGeneratedImages({ conversationId: 'c9' })[0]
    expect(row).toMatchObject({ name: 'scoped.png', syncId: 'keep-me', projectId: 'p9' })

    const outside = path.join(root, 'elsewhere.png')
    fs.writeFileSync(outside, 'x')
    expect(() => saveGeneratedImageScope(outside, { conversationId: 'c9' })).toThrow(/outside the app image library/)
    expect(() => saveGeneratedImageScope(path.join(gallery, 'missing.png'), {})).toThrow()
  })

  it('deletes an image with its sidecar and never a file outside the library', async () => {
    const { deleteGeneratedImage } = await import('../imagegen')
    const file = seedImage('doomed.png', 0, { syncId: 'd' })
    expect(deleteGeneratedImage(file)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.json`)).toBe(false)

    const outside = path.join(root, 'outside.png')
    fs.writeFileSync(outside, 'x')
    expect(deleteGeneratedImage(outside)).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
    expect(deleteGeneratedImage(path.join(gallery, 'notes.txt'))).toBe(false)
    expect(deleteGeneratedImage(path.join(gallery, 'absent.png'))).toBe(false)
  })

  it('keeps the app copy of an init image under sources/, and tolerates a missing source', async () => {
    const { preserveGeneratedImageSource, listGeneratedImages } = await import('../imagegen')
    const picked = path.join(root, 'picked.JPG')
    fs.writeFileSync(picked, 'init')
    const kept = preserveGeneratedImageSource('sync-1', picked)
    expect(kept).toBe(path.join(gallery, 'sources', 'sync-1.jpg'))
    expect(fs.readFileSync(kept!, 'utf8')).toBe('init')
    expect(fs.existsSync(`${kept}.part`)).toBe(false)
    // The kept source is not a generated image, so the gallery scan does not list it.
    expect(listGeneratedImages().some((r) => r.name.startsWith('sync-1'))).toBe(false)

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(preserveGeneratedImageSource('sync-2', path.join(root, 'nope.png'))).toBeNull()
    errors.mockRestore()
  })

  it('exports a library image atomically and refuses an outside path', async () => {
    const { exportGeneratedImage } = await import('../imagegen')
    const file = seedImage('export-me.webp', 0)
    const destination = path.join(root, 'exported', 'copy.webp')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    await exportGeneratedImage(file, destination)
    expect(fs.readFileSync(destination, 'utf8')).toBe('png:export-me.webp')
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['copy.webp'])
    await expect(exportGeneratedImage(path.join(root, 'elsewhere.png'), destination)).rejects.toThrow(
      /outside the app image library/
    )
  })
})

describe('style thumbnails, LoRA adapters, and installed image models', () => {
  it('maps style keys to the first bundled thumbnail across resource roots', async () => {
    const { listStyleThumbs } = await import('../imagegen')
    fs.mkdirSync(path.join(resources[0]!, 'style-thumbs'), { recursive: true })
    fs.mkdirSync(path.join(resources[1]!, 'style-thumbs'), { recursive: true })
    fs.writeFileSync(path.join(resources[0]!, 'style-thumbs', 'anime.png'), 'a')
    fs.writeFileSync(path.join(resources[1]!, 'style-thumbs', 'anime.jpg'), 'b')
    fs.writeFileSync(path.join(resources[1]!, 'style-thumbs', 'noir.webp'), 'n')
    fs.writeFileSync(path.join(resources[1]!, 'style-thumbs', 'readme.md'), 'x')
    expect(listStyleThumbs()).toEqual({
      anime: path.join(resources[0]!, 'style-thumbs', 'anime.png'),
      noir: path.join(resources[1]!, 'style-thumbs', 'noir.webp')
    })
  })

  it('lists LoRA adapters by tidy label from the folder it creates on demand', async () => {
    const { ensureLoraDir, listLoras } = await import('../imagegen')
    expect(listLoras()).toEqual([])
    const dir = ensureLoraDir()
    expect(dir).toBe(path.join(modelsDir, 'loras'))
    expect(fs.existsSync(dir)).toBe(true)
    fs.writeFileSync(path.join(dir, 'zeta_style-v2.safetensors'), Buffer.alloc(10))
    fs.writeFileSync(path.join(dir, 'alpha.safetensors'), Buffer.alloc(3))
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'x')
    expect(listLoras()).toEqual([
      { name: 'alpha', label: 'alpha', file: path.join(dir, 'alpha.safetensors'), sizeBytes: 3 },
      { name: 'zeta_style-v2', label: 'zeta style v2', file: path.join(dir, 'zeta_style-v2.safetensors'), sizeBytes: 10 }
    ])
  })

  it('lists installed checkpoints and reports no TAESD decoder until one is installed', async () => {
    const { listImageModels, resolveTaesd } = await import('../imagegen')
    fs.writeFileSync(path.join(modelsDir, 'sd-turbo.safetensors'), Buffer.alloc(1))
    fs.writeFileSync(path.join(modelsDir, 'text-model.gguf.part'), Buffer.alloc(1))
    expect(listImageModels()).toContain('sd-turbo.safetensors')
    expect(listImageModels()).not.toContain('text-model.gguf.part')
    expect(resolveTaesd('sd-turbo.safetensors')).toBeNull()
  })
})
