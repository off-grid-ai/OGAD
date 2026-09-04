// Desktop adapter for the shared downloaded-model registry. Portable reconciliation and query
// policy lives in @offgrid/models; this file owns only JSON persistence, filesystem metadata, and
// the @offgrid/sync package-identity boundary.

import fs from 'fs'
import path from 'path'
import { modelPackageIdentity } from '@offgrid/sync'
import type {
  AsyncDownloadedModelRegistryPort,
  DownloadedModelRegistryService,
  DownloadedModelRecord,
  DownloadedRegistryCatalogEntry
} from '@offgrid/models'
import {
  downloadedModelRegistry,
  registerDesktopDownloadedRegistryPorts
} from './composition/downloaded-models'

export type DownloadedModel = DownloadedModelRecord
export type { DownloadedRegistryCatalogEntry }

function registryPath(dir: string): string {
  return path.join(dir, 'downloaded-models.json')
}

function requireDownloadedRows(value: unknown): DownloadedModel[] {
  if (!Array.isArray(value)) {
    throw new Error('Downloaded-model registry must contain an array.')
  }
  return value as DownloadedModel[]
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

type DownloadedRegistryPorts = ConstructorParameters<typeof DownloadedModelRegistryService>[0]

/** JSON persistence, file sizes, and package identity for one models directory. I/O only. */
export function desktopDownloadedRegistryPorts(dir: string): DownloadedRegistryPorts {
  return {
    read: () => {
      try {
        const rows: unknown = JSON.parse(fs.readFileSync(registryPath(dir), 'utf-8'))
        return Array.isArray(rows) ? (rows as DownloadedModel[]) : []
      } catch (error) {
        if (isMissing(error)) return []
        throw error
      }
    },
    write: (models) => {
      // A completed non-catalog download must be discoverable after restart. Let persistence
      // failures reach the facade finalizer so it cannot publish a success-shaped completion while
      // the installed model is absent from the durable registry.
      fs.writeFileSync(registryPath(dir), JSON.stringify(models, null, 2))
    },
    fileSize: (fileName) => {
      try {
        return fs.statSync(path.join(dir, fileName)).size
      } catch (error) {
        if (isMissing(error)) return 0
        throw error
      }
    },
    packageIdentity: (input) =>
      modelPackageIdentity({
        ...input,
        files: input.files as [(typeof input.files)[number], ...Array<(typeof input.files)[number]>]
      })
  }
}

/** Async durable I/O for the application-owned download completion workflow. */
export function desktopAsyncDownloadedRegistryPorts(dir: string): AsyncDownloadedModelRegistryPort {
  const filePath = registryPath(dir)
  return {
    read: async () => {
      try {
        return requireDownloadedRows(JSON.parse(await fs.promises.readFile(filePath, 'utf-8')))
      } catch (error) {
        if (isMissing(error)) return []
        throw error
      }
    },
    writeAtomically: async (models) => {
      await fs.promises.mkdir(dir, { recursive: true })
      const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
      try {
        await fs.promises.writeFile(temporaryPath, JSON.stringify(models, null, 2))
        await fs.promises.rename(temporaryPath, filePath)
      } catch (cause) {
        try {
          await fs.promises.rm(temporaryPath, { force: true })
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            'Downloaded-model registry write and cleanup both failed.'
          )
        }
        throw cause
      }
    },
    fileSize: async (fileName) => {
      try {
        return (await fs.promises.stat(path.join(dir, fileName))).size
      } catch (error) {
        if (isMissing(error)) return 0
        throw error
      }
    },
    packageIdentity: (input) =>
      modelPackageIdentity({
        ...input,
        files: input.files as [(typeof input.files)[number], ...Array<(typeof input.files)[number]>]
      })
  }
}

registerDesktopDownloadedRegistryPorts(desktopDownloadedRegistryPorts)

function registry(dir: string): DownloadedModelRegistryService {
  return downloadedModelRegistry(dir)
}

export function readDownloaded(dir: string): DownloadedModel[] {
  return registry(dir).read()
}

export function reconcileDownloadedModelRegistry(
  dir: string,
  catalog: readonly DownloadedRegistryCatalogEntry[]
): DownloadedModel[] {
  return registry(dir).reconcile(catalog)
}

export function recordDownloaded(dir: string, model: DownloadedModel): void {
  registry(dir).record(model)
}

export function removeDownloaded(dir: string, id: string): void {
  registry(dir).remove(id)
}

export function findDownloaded(dir: string, id: string): DownloadedModel | undefined {
  return registry(dir).find(id)
}

export function installedDownloadedIds(dir: string): string[] {
  return registry(dir).installedIds()
}

export function downloadedProtectedNames(dir: string): Set<string> {
  return registry(dir).protectedNames()
}
