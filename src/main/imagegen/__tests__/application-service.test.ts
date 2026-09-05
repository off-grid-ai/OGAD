import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  desktopImageApplicationPorts,
  persistImageGenerationOutput,
  registerDesktopImageCancelBoundary,
  registerDesktopImageInspectionBoundary
} from '../application-service'
import { DesktopModelsOperationError } from '../../composition/application-access'
import {
  ImageExecutionPlanError,
  ModelAdmissionError,
  type ImageNativeExecutionFacts,
  type RuntimeModel
} from '@offgrid/models'

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

  it('reports a failed remote download with its HTTP status instead of saving nothing silently', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('gone', { status: 404 })
    try {
      await expect(
        persistImageGenerationOutput({
          dataUrl: '',
          path: 'http://example.test/generated-image',
          seed: 25,
          model: 'remote-image-model',
          prompt: 'Draw a graph'
        })
      ).rejects.toThrow('Remote image download failed (404).')
    } finally {
      globalThis.fetch = originalFetch
    }
    const directory = path.join(process.env.OFFGRID_DATA_DIR!, 'generated-images')
    expect(fs.readdirSync(directory)).toEqual([])
  })

  it('rejects damaged bytes that carry a supported declared MIME', async () => {
    const damaged = Buffer.from('0102030405060708090a0b0c', 'hex')
    await expect(
      persistImageGenerationOutput({
        dataUrl: `data:image/png;base64,${damaged.toString('base64')}`,
        path: '',
        seed: 26,
        model: 'remote-image-model',
        prompt: 'Draw a graph'
      })
    ).rejects.toThrow('unsupported or damaged image data')
  })

  it('reads an absolute plain path inside the generated-images root', async () => {
    const directory = path.join(process.env.OFFGRID_DATA_DIR!, 'generated-images')
    const artifactPath = path.join(directory, 'plain.jpg')
    const jpeg = Buffer.from('ffd8ffe000104a464946ffd9', 'hex')
    fs.writeFileSync(artifactPath, jpeg)

    const output = await persistImageGenerationOutput({
      dataUrl: '',
      path: artifactPath,
      seed: 27,
      model: 'image-model',
      prompt: 'Draw a graph'
    })
    expect(output.path).toBe(fs.realpathSync.native(artifactPath))
    expect(output.dataUrl).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
  })

  it('rejects a relative path, an unparsable file URI, and an empty artifact alike', async () => {
    for (const candidate of ['relative/image.png', 'file://%zz/broken.png', '']) {
      await expect(
        persistImageGenerationOutput({
          dataUrl: '',
          path: candidate,
          seed: 28,
          model: 'image-model',
          prompt: 'Draw a graph'
        })
      ).rejects.toThrow('no readable image artifact')
    }
  })

  it('rejects an empty data URL payload', async () => {
    await expect(
      persistImageGenerationOutput({
        dataUrl: 'data:image/png;base64,',
        path: '',
        seed: 29,
        model: 'image-model',
        prompt: 'Draw a graph'
      })
    ).rejects.toThrow('no readable image artifact')
  })
})

const imageModel: RuntimeModel = {
  id: 'sd-turbo',
  routeId: 'native:sd-turbo',
  name: 'SD Turbo',
  kind: 'image',
  modality: 'image',
  source: 'local',
  adapterId: 'native-image',
  capabilities: {},
  residencyLifecycle: 'persistent'
} as unknown as RuntimeModel

describe('desktop image application ports', () => {
  const ports = desktopImageApplicationPorts()

  it('prefers an explicit route id over model resolution', async () => {
    expect(await ports.resolveRouteId!({ prompt: 'x', routeId: 'route-7' } as never)).toBe('route-7')
  })

  it.each([
    ['memory-guard marker in a plain error', new Error('OFFGRID_IMAGE_MEMORY_LIMIT:too big'), true],
    ['model admission refusal', new ModelAdmissionError(imageModel), true],
    [
      'desktop models memory refusal',
      new DesktopModelsOperationError({
        kind: 'memory_refused',
        modality: 'image',
        reason: 'not enough RAM',
        overridable: true
      }),
      true
    ],
    [
      'other desktop models failure',
      new DesktopModelsOperationError({ kind: 'memory_refused', modality: 'image', reason: 'x', overridable: false } as never),
      true
    ],
    ['execution plan memory limit', new ImageExecutionPlanError('over budget', 'memory-limit'), true],
    ['execution plan missing companion', new ImageExecutionPlanError('no vae', 'missing-companion'), false],
    ['unrelated error', new Error('disk full'), false],
    ['non-error value', 'string failure', false]
  ])('classifies %s as force-load=%s', (_label, error, expected) => {
    expect(ports.isForceLoadError!(error)).toBe(expected)
  })

  it('routes inspection to the registered native boundary with the persistent flag', async () => {
    const seen: { modelId: string; sourceImageUri?: string; persistentRequested: boolean }[] = []
    const facts = { kind: 'facts' } as unknown as ImageNativeExecutionFacts
    registerDesktopImageInspectionBoundary(async (input) => {
      seen.push(input)
      return facts
    })
    const result = await ports.inspectExecution!({
      model: imageModel,
      request: { prompt: 'x', sourceImageUri: 'file:///tmp/source.png' }
    } as never)
    expect(result).toBe(facts)
    expect(seen).toEqual([
      { modelId: 'sd-turbo', sourceImageUri: 'file:///tmp/source.png', persistentRequested: true }
    ])

    await ports.inspectExecution!({
      model: { ...imageModel, residencyLifecycle: 'ephemeral' },
      request: { prompt: 'x' }
    } as never)
    expect(seen[1]).toEqual({ modelId: 'sd-turbo', sourceImageUri: undefined, persistentRequested: false })
  })

  it('forwards cancel to the registered native cancel boundary', async () => {
    let cancelled = 0
    registerDesktopImageCancelBoundary(() => {
      cancelled += 1
    })
    await ports.cancelBoundary!()
    expect(cancelled).toBe(1)
  })
})
