import { createOffGridApplication } from '@offgrid/application'
import { DownloadAbortedError, type PersistedModelDownload } from '@offgrid/models'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { observeModelControlIpcProjection } from '../../../../../main/model-download-ipc-projection'

export async function createRealDownloadControlHarness(
  publish: (projection: unknown) => void
): Promise<{
  application: ReturnType<typeof createOffGridApplication>
  aborted: ReadonlySet<string>
  records: () => readonly PersistedModelDownload[]
  releaseTransfers: () => void
  dispose: () => Promise<void>
}> {
  let records: PersistedModelDownload[] = [
    {
      manifest: {
        id: 'retry-job',
        modelId: 'retry-model',
        kind: 'text',
        revision: 'main',
        artifacts: [
          {
            id: 'retry-artifact',
            name: 'retry.gguf',
            localName: 'retry.gguf',
            role: 'primary',
            required: true,
            url: 'https://example.invalid/retry.gguf',
            sizeBytes: 2048
          }
        ]
      },
      phase: 'interrupted',
      createdAt: 1,
      updatedAt: 1,
      attempt: 1,
      artifacts: [
        { artifactId: 'retry-artifact', phase: 'interrupted', bytesDownloaded: 0, totalBytes: 2048 }
      ]
    }
  ]
  const template = records[0]!
  for (const suffix of ['b', 'c']) {
    records.push({
      ...structuredClone(template),
      manifest: {
        ...structuredClone(template.manifest),
        id: `retry-job-${suffix}`,
        modelId: `retry-model-${suffix}`,
        artifacts: template.manifest.artifacts.map((artifact) => ({
          ...artifact,
          name: `retry-${suffix}.gguf`,
          localName: `retry-${suffix}.gguf`
        }))
      }
    })
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-storage-cancel-'))
  const stateFile = path.join(directory, 'downloads.json')
  await fs.writeFile(stateFile, JSON.stringify(records))
  let releaseTransfers!: () => void
  const released = new Promise<void>((resolve) => {
    releaseTransfers = resolve
  })
  const aborted = new Set<string>()
  const application = createOffGridApplication({
    models: {
      selection: { read: () => null, write: async () => undefined },
      memory: { current: () => ({ totalMB: 8000, availableMB: 8000, platform: 'desktop' }) },
      control: {
        catalog: { read: async () => ({ kinds: [], models: [] }) },
        randomBytes: (length) => new Uint8Array(length)
      },
      remote: {
        configuration: {
          read: () => ({ version: 1, activeServerId: null, servers: [] }),
          write: () => undefined
        },
        credentials: {
          read: async () => null,
          write: async () => undefined,
          remove: async () => undefined
        },
        providers: { register: async () => undefined, unregister: async () => undefined },
        activateManaged: async () => ({})
      },
      downloads: {
        sources: {
          resolve: async (_request, selected) => {
            if (!selected) throw new Error('Retry must preserve its selected artifact set')
            return selected
          }
        },
        ports: {
          persistence: {
            read: async () => JSON.parse(await fs.readFile(stateFile, 'utf8')),
            write: async (next) => {
              records = [...next]
              await fs.writeFile(stateFile, JSON.stringify(records))
            }
          },
          files: {
            pathFor: (name) => path.join(directory, name),
            exists: async (file) => {
              try {
                return (await fs.stat(file)).isFile()
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
                throw error
              }
            },
            size: async (file) => (await fs.stat(file)).size,
            readPrefix: async (file, bytes) => (await fs.readFile(file)).subarray(0, bytes),
            remove: async (file) => {
              await fs.rm(file, { force: true })
            },
            removePartial: async (file) => {
              await fs.rm(`${file}.part`, { force: true })
            }
          },
          transfers: {
            start: async (input) => {
              input.onStarted?.(input.id)
              input.onProgress({ bytesDownloaded: 512, totalBytes: 2048 })
              await new Promise<void>((resolve) =>
                input.signal.addEventListener(
                  'abort',
                  () => {
                    aborted.add(input.id)
                    resolve()
                  },
                  { once: true }
                )
              )
              await released
              throw new DownloadAbortedError()
            }
          }
        }
      }
    }
  })
  const unsubscribe = observeModelControlIpcProjection({
    models: application.models,
    targets: () => [
      { isDestroyed: () => false, send: (_channel, projection) => publish(projection) }
    ],
    report: (error) => {
      throw error
    }
  })
  return {
    application,
    aborted,
    records: () => records,
    releaseTransfers,
    dispose: async () => {
      releaseTransfers()
      unsubscribe()
      await application.stop()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
