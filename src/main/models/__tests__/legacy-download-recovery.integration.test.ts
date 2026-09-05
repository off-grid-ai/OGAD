import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ModelDownloadCoordinator,
  createModelArtifactManifest,
  DownloadAbortedError,
  type PersistedModelDownload
} from '@offgrid/models'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture(active = false): Promise<{
  root: string
  state: string
  coordinator: ModelDownloadCoordinator
  manifest: PersistedModelDownload['manifest']
  attached: Promise<void>
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-download-alias-'))
  roots.push(root)
  const manifest = createModelArtifactManifest({
    id: 'synthetic/model',
    name: 'Model',
    kind: 'text',
    files: [
      { name: 'model.gguf', role: 'primary', url: 'https://example.invalid/model', sizeBytes: 2048 }
    ]
  })
  const canonical: PersistedModelDownload = {
    manifest,
    phase: 'interrupted',
    createdAt: 1,
    updatedAt: 2,
    attempt: 0,
    artifacts: [
      {
        artifactId: manifest.artifacts[0]!.id,
        phase: 'interrupted',
        bytesDownloaded: 8,
        totalBytes: 2048
      }
    ]
  }
  const legacyId = `${manifest.modelId}:model.gguf`
  const legacy: PersistedModelDownload = {
    ...canonical,
    updatedAt: 3,
    phase: active ? 'downloading' : 'interrupted',
    manifest: {
      ...manifest,
      id: manifest.modelId,
      artifacts: [{ ...manifest.artifacts[0]!, id: legacyId }]
    },
    artifacts: [
      {
        ...canonical.artifacts[0]!,
        artifactId: legacyId,
        bytesDownloaded: 4,
        phase: active ? 'downloading' : 'interrupted',
        transferId: 'native-survivor'
      }
    ]
  }
  await fs.writeFile(path.join(root, 'model.gguf.part'), 'partial!')
  const state = path.join(root, 'downloads.json')
  await fs.writeFile(state, JSON.stringify([canonical, legacy]))
  let attachedResolve!: () => void
  const attached = new Promise<void>((resolve) => {
    attachedResolve = resolve
  })
  const coordinator = new ModelDownloadCoordinator({
    persistence: {
      read: async () => JSON.parse(await fs.readFile(state, 'utf8')),
      write: async (records) => {
        await fs.writeFile(state, JSON.stringify(records))
      }
    },
    files: {
      pathFor: (name) => path.join(root, name),
      exists: async (file) => {
        try {
          return (await fs.stat(file)).isFile()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
      },
      size: async (file) => (await fs.stat(file)).size,
      readPrefix: async (file) => new Uint8Array(await fs.readFile(file)),
      remove: async (file) => {
        await fs.rm(file, { force: true })
      }
    },
    transfers: {
      start: async () => {
        throw new Error('Recovery must not start another transfer')
      },
      isActive: async (id) => active && id === 'native-survivor',
      attach: async (input) => {
        attachedResolve()
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new DownloadAbortedError()), {
            once: true
          })
        })
      }
    }
  })
  return { root, state, coordinator, manifest, attached }
}

it('merges exact legacy aliases durably without deleting partial bytes and stays idempotent', async () => {
  const f = await fixture()
  try {
    const records = await f.coordinator.hydrate()
    expect(records).toHaveLength(1)
    expect(records[0]?.manifest.id).toBe(f.manifest.id)
    expect(records[0]?.artifacts[0]?.bytesDownloaded).toBe(8)
    expect(await fs.readFile(path.join(f.root, 'model.gguf.part'), 'utf8')).toBe('partial!')
    expect(await f.coordinator.hydrate()).toEqual(records)
    expect(JSON.parse(await fs.readFile(f.state, 'utf8'))).toHaveLength(1)
  } finally {
    await f.coordinator.shutdown()
  }
})

it('keeps the native legacy attempt, attaches once, and cancels its canonical handle', async () => {
  const f = await fixture(true)
  try {
    const recovered = await f.coordinator.hydrateWithHandles()
    expect(recovered.records).toHaveLength(1)
    expect(recovered.handles).toHaveLength(1)
    await f.attached
    expect((await f.coordinator.hydrateWithHandles()).handles[0]).toBe(recovered.handles[0])
    expect(f.coordinator.get(f.manifest.id)?.artifacts[0]?.transferId).toBe('native-survivor')
    expect(await recovered.handles[0]!.cancel(false)).toBe(true)
    expect(await recovered.handles[0]!.completion).toEqual({ outcome: { kind: 'cancelled' } })
    expect(f.coordinator.get(f.manifest.id)?.phase).toBe('cancelled')
    expect(await fs.readFile(path.join(f.root, 'model.gguf.part'), 'utf8')).toBe('partial!')
  } finally {
    await f.coordinator.shutdown()
  }
})

it('does not collapse different source bytes that happen to use the same file name', async () => {
  const f = await fixture()
  try {
    const rows: PersistedModelDownload[] = JSON.parse(await fs.readFile(f.state, 'utf8'))
    rows[1]!.manifest.artifacts[0]!.sha256 = 'different-source-hash'
    await fs.writeFile(f.state, JSON.stringify(rows))
    expect(await f.coordinator.hydrate()).toHaveLength(2)
    expect(await fs.readFile(path.join(f.root, 'model.gguf.part'), 'utf8')).toBe('partial!')
  } finally {
    await f.coordinator.shutdown()
  }
})

it('reports ambiguous native ownership without changing durable records or partial bytes', async () => {
  const f = await fixture(true)
  try {
    const rows: PersistedModelDownload[] = JSON.parse(await fs.readFile(f.state, 'utf8'))
    rows[0]!.artifacts[0]!.transferId = 'native-survivor'
    await fs.writeFile(f.state, JSON.stringify(rows))
    await expect(f.coordinator.hydrate()).rejects.toThrow('Multiple active transfers')
    expect(f.coordinator.durabilityHealth().status).toBe('degraded')
    expect(f.coordinator.list()).toEqual([])
    expect(JSON.parse(await fs.readFile(f.state, 'utf8'))).toEqual(rows)
    expect(await fs.readFile(path.join(f.root, 'model.gguf.part'), 'utf8')).toBe('partial!')
  } finally {
    await f.coordinator.shutdown()
  }
})
