import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PersistedModelDownload } from '@offgrid/models'
import { DownloadRecoveryStore, type DownloadRecoveryFilePort } from '../download-recovery-store'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): PersistedModelDownload {
  return {
    manifest: {
      id: 'model',
      modelId: 'model',
      kind: 'text',
      revision: 'main',
      artifacts: [
        {
          id: 'model:file',
          name: 'model.gguf',
          localName: 'model.gguf',
          url: 'https://example.test/model.gguf',
          required: true
        }
      ]
    },
    phase: 'interrupted',
    artifacts: [
      {
        artifactId: 'model:file',
        phase: 'interrupted',
        bytesDownloaded: 128,
        totalBytes: 1024
      }
    ],
    createdAt: 1,
    updatedAt: 2,
    attempt: 1
  }
}

describe('download recovery filesystem adapter', () => {
  it('rejects damaged recovery data, preserves it, and blocks false-success writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-recovery-'))
    roots.push(root)
    const file = path.join(root, 'downloads.json')
    fs.writeFileSync(file, '{broken')
    const events: string[] = []
    const store = new DownloadRecoveryStore(file, (event) => events.push(event))

    await expect(store.read()).rejects.toThrow('Download recovery data could not be migrated.')
    expect(store.snapshot()).toEqual({
      status: 'degraded',
      error: `Download recovery data could not be migrated. The original file was kept at ${file}. Move it aside to start with empty recovery data.`
    })
    expect(events).toEqual(['read.failed'])
    await expect(store.write([])).rejects.toThrow(
      'Download recovery data could not be saved because its original data could not be read.'
    )
    expect(store.snapshot()).toEqual({
      status: 'degraded',
      error: `Download recovery data could not be migrated. The original file was kept at ${file}. Move it aside to start with empty recovery data.`
    })
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken')
  })

  it('migrates a real legacy progress file through model id and artifact identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-recovery-'))
    roots.push(root)
    const file = path.join(root, 'downloads.json')
    const legacy = [
      {
        modelId: 'unsloth/gemma-4-12b-it-GGUF',
        status: 'failed',
        percent: 47,
        currentFile: 'gemma-4-12b-it-Q4_K_M.gguf',
        fileIndex: 1,
        fileCount: 2,
        downloadedBytes: 3_458_001_921,
        totalBytes: 7_296_977_280,
        error: 'interrupted - retry to resume'
      },
      {
        modelId: 'prithivMLmods/Holo-3.1-9B-GGUF',
        status: 'failed',
        currentFile: 'Holo-3.1-9B.Q4_K_M.gguf',
        fileIndex: 1,
        downloadedBytes: 2_213_535_049,
        error: 'interrupted - retry to resume'
      },
      {
        modelId: 'mradermacher/UI-TARS-1.5-7B-GGUF',
        status: 'failed',
        currentFile: 'UI-TARS-1.5-7B.Q4_K_M.gguf',
        fileIndex: 1,
        downloadedBytes: 2_196_570_986,
        error: 'interrupted - retry to resume'
      }
    ]
    const source = JSON.stringify(legacy)
    fs.writeFileSync(file, source)
    const store = new DownloadRecoveryStore(file, () => undefined)

    const migrated = await store.read()
    expect(migrated).toHaveLength(3)
    expect(migrated.map((record) => record.manifest.modelId)).toEqual([
      'unsloth/gemma-4-12b-it-GGUF',
      'mradermacher/Holo-3.1-9B-GGUF',
      'mradermacher/UI-TARS-1.5-7B-GGUF'
    ])
    expect(migrated.every((record) => record.phase === 'interrupted')).toBe(true)
    expect(migrated[0]?.artifacts[0]).toMatchObject({
      phase: 'interrupted',
      bytesDownloaded: 3_458_001_921
    })
    expect(store.snapshot()).toEqual({ status: 'healthy' })
    expect(fs.readFileSync(file, 'utf8')).toBe(source)

    await store.write(migrated)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).toHaveProperty('manifest')
  })

  it('keeps an unsupported legacy file and reports an actionable migration failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-recovery-'))
    roots.push(root)
    const file = path.join(root, 'downloads.json')
    const source = JSON.stringify([
      { modelId: 'retired/unknown-model', status: 'failed', error: 'interrupted' }
    ])
    fs.writeFileSync(file, source)
    const store = new DownloadRecoveryStore(file, () => undefined)

    await expect(store.read()).rejects.toThrow('Download recovery data could not be migrated.')
    expect(store.snapshot().error).toContain('The original file was kept at')
    await expect(store.write([])).rejects.toThrow(
      'Download recovery data could not be saved because its original data could not be read.'
    )
    expect(fs.readFileSync(file, 'utf8')).toBe(source)
  })

  it('keeps the last valid snapshot when atomic promotion fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-recovery-'))
    roots.push(root)
    const file = path.join(root, 'downloads.json')
    const record = fixture()
    const healthy = new DownloadRecoveryStore(file, () => undefined)
    await healthy.write([record])

    const failingFiles: DownloadRecoveryFilePort = {
      readFile: (target, encoding) => fs.promises.readFile(target, encoding),
      mkdir: (target, options) => fs.promises.mkdir(target, options),
      writeFile: (target, data, options) => fs.promises.writeFile(target, data, options),
      rename: async () => {
        throw Object.assign(new Error('disk is read only'), { code: 'EROFS' })
      },
      rm: (target, options) => fs.promises.rm(target, options)
    }
    const events: string[] = []
    const failing = new DownloadRecoveryStore(file, (event) => events.push(event), failingFiles)
    await expect(failing.write([])).rejects.toThrow('Download recovery data could not be saved.')

    expect(failing.snapshot()).toEqual({
      status: 'degraded',
      error: 'Download recovery data could not be saved.'
    })
    expect(events).toEqual(['write.failed'])
    await expect(healthy.read()).resolves.toEqual([record])
    expect(fs.readdirSync(root)).toEqual(['downloads.json'])
  })
})
