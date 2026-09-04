import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  DownloadFinalizationTransaction,
  DownloadFinalizePort,
  PersistedModelDownload
} from '@offgrid/models'
import {
  createDesktopModelDownloadFinalizer,
  type FinalizationFileSystem
} from '../desktop-model-download-finalizer'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): PersistedModelDownload {
  return {
    manifest: {
      id: 'download:model',
      modelId: 'model',
      kind: 'vision',
      revision: 'test',
      artifacts: [
        {
          id: 'model:primary',
          name: 'model.gguf',
          localName: '.downloads/model/model.gguf',
          url: 'https://example.test/model.gguf',
          required: true
        },
        {
          id: 'model:projector',
          name: 'mmproj.gguf',
          localName: '.downloads/model/mmproj.gguf',
          url: 'https://example.test/mmproj.gguf',
          role: 'mmproj',
          required: true
        }
      ]
    },
    phase: 'processing',
    artifacts: [
      {
        artifactId: 'model:primary',
        phase: 'completed',
        bytesDownloaded: 8,
        totalBytes: 8
      },
      {
        artifactId: 'model:projector',
        phase: 'completed',
        bytesDownloaded: 8,
        totalBytes: 8
      }
    ],
    createdAt: 1,
    updatedAt: 2,
    attempt: 1
  }
}

function paths(root: string): {
  modelsDir: string
  primaryStage: string
  projectorStage: string
  primaryFinal: string
  projectorFinal: string
} {
  const modelsDir = path.join(root, 'models')
  return {
    modelsDir,
    primaryStage: path.join(modelsDir, '.downloads/model/model.gguf'),
    projectorStage: path.join(modelsDir, '.downloads/model/mmproj.gguf'),
    primaryFinal: path.join(modelsDir, 'model.gguf'),
    projectorFinal: path.join(modelsDir, 'mmproj.gguf')
  }
}

async function write(filePath: string, value: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, value)
}

function realFileSystem(
  afterRename?: (source: string, destination: string) => void
): FinalizationFileSystem {
  return {
    mkdir: async (directory) => {
      await fs.promises.mkdir(directory, { recursive: true })
    },
    exists: async (filePath) => {
      try {
        await fs.promises.stat(filePath)
        return true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw cause
      }
    },
    rename: async (source, destination) => {
      await fs.promises.rename(source, destination)
      afterRename?.(source, destination)
    },
    remove: async (filePath) => {
      await fs.promises.rm(filePath, { recursive: true, force: true })
    }
  }
}

async function begin(
  root: string,
  files?: FinalizationFileSystem
): Promise<ReturnType<typeof paths> & { transaction: DownloadFinalizationTransaction }> {
  const resolved = paths(root)
  const finalizer = makeFinalizer(root, files)
  return { ...resolved, transaction: await finalizer.begin(fixture()) }
}

function makeFinalizer(root: string, files?: FinalizationFileSystem): DownloadFinalizePort {
  const resolved = paths(root)
  return createDesktopModelDownloadFinalizer({
    modelsDir: resolved.modelsDir,
    pathFor: (localName) => path.join(resolved.modelsDir, localName),
    files,
    newId: () => 'transaction'
  })
}

describe('Desktop model installation transaction', () => {
  it('restores every previous file when the second artifact cannot be promoted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const expected = paths(root)
    await write(expected.primaryStage, 'new-primary')
    await write(expected.primaryFinal, 'old-primary')
    await write(expected.projectorFinal, 'old-projector')
    const state = await begin(root)

    await expect(state.transaction.prepare(new AbortController().signal)).rejects.toThrow('ENOENT')
    await state.transaction.rollback()

    await expect(fs.promises.readFile(state.primaryFinal, 'utf8')).resolves.toBe('old-primary')
    await expect(fs.promises.readFile(state.projectorFinal, 'utf8')).resolves.toBe('old-projector')
    await expect(fs.promises.readFile(state.primaryStage, 'utf8')).resolves.toBe('new-primary')
  })

  it('restores the old installation and staged retry state after an abort between artifacts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const controller = new AbortController()
    const expected = paths(root)
    const files = realFileSystem((source, destination) => {
      if (source === expected.primaryStage && destination === expected.primaryFinal) {
        controller.abort(new Error('test abort'))
      }
    })
    await Promise.all([
      write(expected.primaryStage, 'new-primary'),
      write(expected.projectorStage, 'new-projector'),
      write(expected.primaryFinal, 'old-primary'),
      write(expected.projectorFinal, 'old-projector')
    ])
    const state = await begin(root, files)

    await expect(state.transaction.prepare(controller.signal)).rejects.toThrow('test abort')
    await state.transaction.rollback()

    await expect(fs.promises.readFile(state.primaryFinal, 'utf8')).resolves.toBe('old-primary')
    await expect(fs.promises.readFile(state.projectorFinal, 'utf8')).resolves.toBe('old-projector')
    await expect(fs.promises.readFile(state.primaryStage, 'utf8')).resolves.toBe('new-primary')
    await expect(fs.promises.readFile(state.projectorStage, 'utf8')).resolves.toBe('new-projector')
  })

  it('rolls back prepared files when a later durable registry write fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const expected = paths(root)
    await Promise.all([
      write(expected.primaryStage, 'new-primary'),
      write(expected.projectorStage, 'new-projector'),
      write(expected.primaryFinal, 'old-primary'),
      write(expected.projectorFinal, 'old-projector')
    ])
    const state = await begin(root)

    await state.transaction.prepare(new AbortController().signal)
    const registryWrite = Promise.reject(new Error('registry unavailable'))
    await expect(registryWrite).rejects.toThrow('registry unavailable')
    await state.transaction.rollback()

    await expect(fs.promises.readFile(state.primaryFinal, 'utf8')).resolves.toBe('old-primary')
    await expect(fs.promises.readFile(state.projectorFinal, 'utf8')).resolves.toBe('old-projector')
  })

  it('commits a complete replacement and removes its private backups', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const expected = paths(root)
    await Promise.all([
      write(expected.primaryStage, 'new-primary'),
      write(expected.projectorStage, 'new-projector'),
      write(expected.primaryFinal, 'old-primary'),
      write(expected.projectorFinal, 'old-projector')
    ])
    const state = await begin(root)

    await state.transaction.prepare(new AbortController().signal)
    await state.transaction.commit()

    await expect(fs.promises.readFile(state.primaryFinal, 'utf8')).resolves.toBe('new-primary')
    await expect(fs.promises.readFile(state.projectorFinal, 'utf8')).resolves.toBe('new-projector')
    await expect(
      fs.promises.readdir(path.join(state.modelsDir, '.install-backups'))
    ).resolves.toEqual([])
  })

  it('recovers an unowned transaction after a restart during destination backup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const expected = paths(root)
    await Promise.all([
      write(expected.primaryStage, 'new-primary'),
      write(expected.projectorStage, 'new-projector'),
      write(expected.primaryFinal, 'old-primary'),
      write(expected.projectorFinal, 'old-projector')
    ])
    let backupMoves = 0
    const interruptedFiles = realFileSystem((source) => {
      if (source === expected.primaryFinal && ++backupMoves === 1) {
        throw new Error('process stopped after first backup')
      }
    })
    const transaction = await makeFinalizer(root, interruptedFiles).begin(fixture())
    await expect(transaction.prepare(new AbortController().signal)).rejects.toThrow(
      'process stopped after first backup'
    )

    await makeFinalizer(root).recover({
      download: fixture(),
      state: transaction.recoveryState,
      disposition: 'rollback'
    })

    await expect(fs.promises.readFile(expected.primaryFinal, 'utf8')).resolves.toBe('old-primary')
    await expect(fs.promises.readFile(expected.projectorFinal, 'utf8')).resolves.toBe(
      'old-projector'
    )
  })

  it('recovers an unowned prepared transaction after a restart', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const expected = paths(root)
    await Promise.all([
      write(expected.primaryStage, 'new-primary'),
      write(expected.projectorStage, 'new-projector'),
      write(expected.primaryFinal, 'old-primary'),
      write(expected.projectorFinal, 'old-projector')
    ])
    const transaction = await makeFinalizer(root).begin(fixture())
    await transaction.prepare(new AbortController().signal)

    await makeFinalizer(root).recover({
      download: fixture(),
      state: transaction.recoveryState,
      disposition: 'rollback'
    })

    await expect(fs.promises.readFile(expected.primaryFinal, 'utf8')).resolves.toBe('old-primary')
    await expect(fs.promises.readFile(expected.primaryStage, 'utf8')).resolves.toBe('new-primary')
  })

  it('recovers an owned transaction by keeping the new install and cleaning backups', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const expected = paths(root)
    await Promise.all([
      write(expected.primaryStage, 'new-primary'),
      write(expected.projectorStage, 'new-projector'),
      write(expected.primaryFinal, 'old-primary'),
      write(expected.projectorFinal, 'old-projector')
    ])
    const transaction = await makeFinalizer(root).begin(fixture())
    await transaction.prepare(new AbortController().signal)

    await makeFinalizer(root).recover({
      download: fixture(),
      state: transaction.recoveryState,
      disposition: 'commit'
    })

    await expect(fs.promises.readFile(expected.primaryFinal, 'utf8')).resolves.toBe('new-primary')
    await expect(fs.promises.readFile(expected.projectorFinal, 'utf8')).resolves.toBe(
      'new-projector'
    )
  })

  it('retries failed post-ownership backup cleanup without rolling back the installed files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-finalizer-'))
    roots.push(root)
    const expected = paths(root)
    await Promise.all([
      write(expected.primaryStage, 'new-primary'),
      write(expected.projectorStage, 'new-projector'),
      write(expected.primaryFinal, 'old-primary'),
      write(expected.projectorFinal, 'old-projector')
    ])
    const realFiles = realFileSystem()
    let refuseCleanup = true
    const files: FinalizationFileSystem = {
      ...realFiles,
      remove: async (filePath) => {
        if (refuseCleanup && filePath.includes('.install-backups')) {
          refuseCleanup = false
          throw new Error('backup cleanup unavailable')
        }
        await realFiles.remove(filePath)
      }
    }
    const transaction = await makeFinalizer(root, files).begin(fixture())
    await transaction.prepare(new AbortController().signal)

    await expect(transaction.commit()).rejects.toThrow('backup cleanup unavailable')
    await expect(fs.promises.readFile(expected.primaryFinal, 'utf8')).resolves.toBe('new-primary')

    await makeFinalizer(root).recover({
      download: fixture(),
      state: transaction.recoveryState,
      disposition: 'commit'
    })

    await expect(fs.promises.readFile(expected.primaryFinal, 'utf8')).resolves.toBe('new-primary')
    await expect(fs.promises.readFile(expected.projectorFinal, 'utf8')).resolves.toBe(
      'new-projector'
    )
    await expect(
      fs.promises.readdir(path.join(expected.modelsDir, '.install-backups'))
    ).resolves.toEqual([])
  })
})
