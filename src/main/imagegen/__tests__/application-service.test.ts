import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { persistImageGenerationOutput } from '../application-service'

const temporaryDirectories: string[] = []
const originalDataDirectory = process.env.OFFGRID_DATA_DIR

beforeEach(() => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-image-profile-'))
  temporaryDirectories.push(profile)
  process.env.OFFGRID_DATA_DIR = profile
  fs.mkdirSync(path.join(profile, 'generated-images'), { recursive: true })
})

afterEach(() => {
  if (originalDataDirectory === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDirectory
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('image-generation output persistence', () => {
  it('normalizes a local file URI into an absolute path and a renderable data URL', async () => {
    const directory = path.join(process.env.OFFGRID_DATA_DIR!, 'generated-images')
    const artifactPath = path.join(directory, 'generated image.png')
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    fs.writeFileSync(artifactPath, bytes)

    const output = await persistImageGenerationOutput({
      dataUrl: pathToFileURL(artifactPath).href,
      path: pathToFileURL(artifactPath).href,
      seed: 17,
      model: 'image-model',
      prompt: 'Draw a chart'
    })

    expect(output.path).toBe(fs.realpathSync.native(artifactPath))
    expect(output.dataUrl).toBe(`data:image/png;base64,${bytes.toString('base64')}`)
  })

  it.each([
    {
      mime: 'image/jpeg',
      extension: '.jpg',
      bytes: Buffer.from('ffd8ffe000104a464946ffd9', 'hex')
    },
    {
      mime: 'image/webp',
      extension: '.webp',
      bytes: Buffer.from('524946460400000057454250', 'hex')
    },
    {
      mime: 'image/png',
      extension: '.png',
      bytes: Buffer.from('89504e470d0a1a0a00000000', 'hex')
    }
  ])('preserves $mime bytes, extension, and data URL', async ({ mime, extension, bytes }) => {
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`

    const output = await persistImageGenerationOutput({
      dataUrl,
      path: dataUrl,
      seed: 20,
      model: 'remote-image-model',
      prompt: 'Draw a graph'
    })

    expect(path.extname(output.path)).toBe(extension)
    expect(fs.readFileSync(output.path)).toEqual(bytes)
    expect(output.dataUrl).toBe(dataUrl)
  })

  it('rejects a declared MIME type that does not match the image signature', async () => {
    const jpeg = Buffer.from('ffd8ffe000104a464946ffd9', 'hex')

    await expect(
      persistImageGenerationOutput({
        dataUrl: `data:image/png;base64,${jpeg.toString('base64')}`,
        path: '',
        seed: 21,
        model: 'remote-image-model',
        prompt: 'Draw a graph'
      })
    ).rejects.toThrow('returned image/jpeg data as image/png')
  })

  it('rejects unsupported response content before persisting it', async () => {
    const gif = Buffer.from('47494638396101000100', 'hex')

    await expect(
      persistImageGenerationOutput({
        dataUrl: `data:image/gif;base64,${gif.toString('base64')}`,
        path: '',
        seed: 22,
        model: 'remote-image-model',
        prompt: 'Draw a graph'
      })
    ).rejects.toThrow('unsupported image content type')

    const directory = path.join(process.env.OFFGRID_DATA_DIR!, 'generated-images')
    expect(fs.readdirSync(directory)).toEqual([])
  })

  it('validates the HTTP content type against the downloaded signature', async () => {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(png, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    try {
      await expect(
        persistImageGenerationOutput({
          dataUrl: '',
          path: 'https://example.test/generated-image',
          seed: 23,
          model: 'remote-image-model',
          prompt: 'Draw a graph'
        })
      ).rejects.toThrow('returned image/png data as image/jpeg')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preserves a supported HTTP response MIME in the saved extension and data URL', async () => {
    const jpeg = Buffer.from('ffd8ffe000104a464946ffd9', 'hex')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(jpeg, {
        status: 200,
        headers: { 'content-type': 'image/jpeg; charset=binary' }
      })
    try {
      const output = await persistImageGenerationOutput({
        dataUrl: '',
        path: 'https://example.test/generated-image',
        seed: 24,
        model: 'remote-image-model',
        prompt: 'Draw a graph'
      })

      expect(path.extname(output.path)).toBe('.jpg')
      expect(fs.readFileSync(output.path)).toEqual(jpeg)
      expect(output.dataUrl).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a missing local file URI instead of reporting an unusable result', async () => {
    const directory = path.join(process.env.OFFGRID_DATA_DIR!, 'generated-images')
    const missingPath = path.join(directory, 'missing.png')

    await expect(
      persistImageGenerationOutput({
        dataUrl: pathToFileURL(missingPath).href,
        path: pathToFileURL(missingPath).href,
        seed: 18,
        model: 'image-model',
        prompt: 'Draw a graph'
      })
    ).rejects.toThrow('no readable image artifact')
  })

  it('rejects a symlink that escapes the generated-media root', async () => {
    const directory = path.join(process.env.OFFGRID_DATA_DIR!, 'generated-images')
    const outsidePath = path.join(process.env.OFFGRID_DATA_DIR!, 'private.txt')
    const linkedPath = path.join(directory, 'linked.png')
    fs.writeFileSync(outsidePath, 'private bytes')
    fs.symlinkSync(outsidePath, linkedPath)

    await expect(
      persistImageGenerationOutput({
        dataUrl: pathToFileURL(linkedPath).href,
        path: pathToFileURL(linkedPath).href,
        seed: 19,
        model: 'image-model',
        prompt: 'Draw a graph'
      })
    ).rejects.toThrow('no readable image artifact')
  })
})
