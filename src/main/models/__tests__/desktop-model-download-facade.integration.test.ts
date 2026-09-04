import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOffGridApplication,
  type ModelsEvent,
  type ModelsPlatformPorts
} from '@offgrid/application'
import type { PublicDownloadProgressEvent, RemoteServerConfiguration } from '@offgrid/models'
import { createDesktopModelDownloadAdapter } from '../desktop-model-download-ports'

const roots: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function modelPorts(
  downloads: ReturnType<typeof createDesktopModelDownloadAdapter>['ports']
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
  it('installs every catalog artifact, reports monotonic job progress, and publishes final paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-desktop-download-facade-'))
    roots.push(root)
    const modelsDir = path.join(root, 'models')
    const adapter = createDesktopModelDownloadAdapter({ modelsDir, metadataRepair: null })
    const modelId = 'offgrid-test/multi-artifact'
    const primary = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 1)])
    const projector = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_048, 2)])

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith(`/api/models/${modelId}`)) {
          return new Response(
            JSON.stringify({
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
        writeAtomically: async () => {
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
        if (url.endsWith(`/api/models/${modelId}`)) {
          return new Response(
            JSON.stringify({
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
