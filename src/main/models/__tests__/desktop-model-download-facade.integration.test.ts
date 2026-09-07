import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOffGridApplication,
  type ModelsControlPlatformPort,
  type ModelsEvent,
  type ModelsPlatformPorts
} from '@offgrid/application'
import type { PublicDownloadProgressEvent, RemoteServerConfiguration } from '@offgrid/models'
import { createDesktopModelDownloadAdapter } from '../desktop-model-download-ports'
import { createDesktopModelControlPort } from '../desktop-model-control-port'

const roots: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function modelPorts(
  downloads: ReturnType<typeof createDesktopModelDownloadAdapter>['ports'],
  control?: ModelsControlPlatformPort
): ModelsPlatformPorts {
  const selections = new Map<string, string>()
  let configuration: RemoteServerConfiguration = {
    version: 1,
    activeServerId: null,
    servers: []
  }
  return {
    selection: {
      read: (modality: string) => selections.get(modality) ?? null,
      write: (modality: string, routeId: string | null) => {
        if (routeId === null) selections.delete(modality)
        else selections.set(modality, routeId)
      }
    },
    memory: {
      current: () => ({ totalMB: 16_000, availableMB: 16_000, platform: 'desktop' as const })
    },
    downloads,
    ...(control ? { control } : {}),
    remote: {
      configuration: {
        read: () => configuration,
        write: (next: RemoteServerConfiguration) => {
          configuration = next
        }
      },
      credentials: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined
      },
      providers: {
        register: async () => undefined,
        unregister: async () => undefined
      },
      activateManaged: async () => ({})
    }
  }
}

describe('Desktop model downloads through the Shared Models facade', () => {
  it('admits one exact dynamic Hub variant and completes from Shared installation facts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-desktop-control-download-'))
    roots.push(root)
    const modelsDir = path.join(root, 'models')
    const repositoryId = 'QuantFactory/SmolLM2-135M-GGUF'
    const defaultFile = 'SmolLM2-135M-Q4_K_M.gguf'
    const selectedFile = 'SmolLM2-135M-Q5_K_M.gguf'
    const primary = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 5)])
    let metadataReads = 0
    let transfers = 0
    const revision = '0123456789abcdef0123456789abcdef01234567'
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith(`/api/models/${repositoryId}`)) {
        metadataReads += 1
        return new Response(
          JSON.stringify({
            siblings: [
              { rfilename: defaultFile, size: primary.length },
              { rfilename: selectedFile, size: primary.length }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.includes(`/api/models/${repositoryId}/revision/`)) {
        return new Response(
          JSON.stringify({
            sha: revision,
            siblings: [{ rfilename: selectedFile, size: primary.length }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      transfers += 1
      return new Response(new Uint8Array(primary), {
        status: 200,
        headers: { 'content-length': String(primary.length) }
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const adapter = createDesktopModelDownloadAdapter({ modelsDir, metadataRepair: null })
    const control = createDesktopModelControlPort({
      fetchImpl,
      readCatalog: async () => ({ kinds: ['text'], models: [] })
    })
    const application = createOffGridApplication({ models: modelPorts(adapter.ports, control) })
    const completed = new Promise<void>((resolve) => {
      application.models.events((event) => {
        if (event.type === 'download' && event.event.status === 'completed') resolve()
      })
    })
    await application.start()

    const intent = {
      type: 'queue-download' as const,
      modelId: repositoryId,
      selection: { repositoryId, fileName: selectedFile }
    }
    const [first, second] = await Promise.all([
      application.models.control({ ...intent, operationId: 'dynamic-click-one' }),
      application.models.control({ ...intent, operationId: 'dynamic-click-two' })
    ])
    expect(first.ok, `${JSON.stringify(first)} ${JSON.stringify(fetchImpl.mock.calls)}`).toBe(true)
    expect(second.ok, JSON.stringify(second)).toBe(true)
    await completed

    expect(metadataReads).toBe(2)
    expect(transfers).toBe(1)
    const row = application.models
      .snapshot()
      .control.downloads.find((download) => download.status === 'completed')
    expect(row).toMatchObject({
      modelId: repositoryId,
      repositoryId,
      fileName: selectedFile
    })
    const registry = JSON.parse(
      await fs.promises.readFile(path.join(modelsDir, 'downloaded-models.json'), 'utf8')
    )
    expect(registry).toEqual([
      expect.objectContaining({
        familyId: repositoryId,
        files: [selectedFile],
        packageIdentity: expect.stringMatching(/^model-package-v1:/)
      })
    ])
    await application.stop()
  })

  it('installs every catalog artifact, reports monotonic job progress, and publishes final paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-desktop-download-facade-'))
    roots.push(root)
    const modelsDir = path.join(root, 'models')
    const adapter = createDesktopModelDownloadAdapter({ modelsDir, metadataRepair: null })
    const modelId = 'offgrid-test/multi-artifact'
    const revision = '0123456789abcdef0123456789abcdef01234567'
    const primary = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 1)])
    const projector = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 2)])

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (new URL(url).pathname.startsWith(`/api/models/${modelId}`)) {
          return new Response(
            JSON.stringify({
              sha: revision,
              siblings: [
                { rfilename: 'model-Q4_K_M.gguf', size: primary.length },
                { rfilename: 'mmproj-model-f16.gguf', size: projector.length }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        const body = url.endsWith('mmproj-model-f16.gguf') ? projector : primary
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.length) }
        })
      })
    )

    const application = createOffGridApplication({ models: modelPorts(adapter.ports) })
    const events: Array<Extract<ModelsEvent, { type: 'download' }>['event']> = []
    application.models.events((event) => {
      if (event.type === 'download') events.push(event.event)
    })
    await application.start()

    const request = await adapter.request(modelId)
    await expect(application.models.downloadAndWait(request)).resolves.toEqual({
      ok: true,
      value: undefined
    })

    const progress = events.filter(
      (event): event is PublicDownloadProgressEvent => event.status === 'downloading'
    )
    expect(progress.map((event) => event.bytesDownloaded)).toEqual(
      [...progress.map((event) => event.bytesDownloaded)].sort((left, right) => left - right)
    )
    expect(progress.at(-1)?.totalBytes).toBe(primary.length + projector.length)
    const completed = events.findLast((event) => event.status === 'completed')
    expect(completed).toMatchObject({
      modelId,
      fileName: 'model-Q4_K_M.gguf',
      localUri: path.join(modelsDir, 'model-Q4_K_M.gguf')
    })
    await expect(fs.promises.stat(path.join(modelsDir, 'model-Q4_K_M.gguf'))).resolves.toBeDefined()
    await expect(
      fs.promises.stat(path.join(modelsDir, 'mmproj-model-f16.gguf'))
    ).resolves.toBeDefined()

    await application.stop()
  })

  it('restores a prior installation when durable registry ownership fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-desktop-download-facade-'))
    roots.push(root)
    const modelsDir = path.join(root, 'models')
    const modelId = 'offgrid-test/registry-failure'
    const revision = '0123456789abcdef0123456789abcdef01234567'
    const primaryName = 'replacement-Q4_K_M.gguf'
    const projectorName = 'replacement-mmproj-F16.gguf'
    const primary = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 3)])
    const projector = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 4)])
    await fs.promises.mkdir(modelsDir, { recursive: true })
    await Promise.all([
      fs.promises.writeFile(path.join(modelsDir, primaryName), 'old-primary'),
      fs.promises.writeFile(path.join(modelsDir, projectorName), 'old-projector')
    ])
    const adapter = createDesktopModelDownloadAdapter({
      modelsDir,
      metadataRepair: null,
      downloadedRegistry: {
        read: async () => [],
        updateAtomically: async () => {
          throw new Error('registry unavailable')
        },
        fileSize: async (fileName) => (await fs.promises.stat(path.join(modelsDir, fileName))).size,
        packageIdentity: () => 'model-package-v1:test'
      }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (new URL(url).pathname.startsWith(`/api/models/${modelId}`)) {
          return new Response(
            JSON.stringify({
              sha: revision,
              siblings: [
                { rfilename: primaryName, size: primary.length },
                { rfilename: projectorName, size: projector.length }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        const body = url.endsWith(projectorName) ? projector : primary
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.length) }
        })
      })
    )
    const application = createOffGridApplication({ models: modelPorts(adapter.ports) })
    const events: Array<Extract<ModelsEvent, { type: 'download' }>['event']> = []
    application.models.events((event) => {
      if (event.type === 'download') events.push(event.event)
    })
    await application.start()

    const result = await application.models.downloadAndWait(await adapter.request(modelId))

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: 'runtime', message: expect.stringContaining('registry unavailable') }
    })
    await expect(fs.promises.readFile(path.join(modelsDir, primaryName), 'utf8')).resolves.toBe(
      'old-primary'
    )
    await expect(fs.promises.readFile(path.join(modelsDir, projectorName), 'utf8')).resolves.toBe(
      'old-projector'
    )
    expect(events.some((event) => event.status === 'completed')).toBe(false)
    expect(events.findLast((event) => event.status === 'failed')).toMatchObject({
      modelId,
      reason: expect.stringContaining('registry unavailable')
    })

    await application.stop()
  })
})
