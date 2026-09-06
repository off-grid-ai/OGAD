// Desktop adapter for the shared downloaded-model registry. Portable reconciliation and query
// policy lives in @offgrid/models; this file owns only JSON persistence, filesystem metadata, and
// the @offgrid/sync package-identity boundary.

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
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
  return value.map((row: unknown, index) => {
    if (!isDownloadedRow(row)) {
      throw new Error(`Downloaded-model registry row ${index + 1} is invalid.`)
    }
    return row
  })
}

function isDownloadedRow(value: unknown): value is DownloadedModel {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const requiredStrings = ['id', 'name', 'kind']
  const optionalStrings = ['familyId', 'packageIdentity']
  return (
    requiredStrings.every((key) => typeof row[key] === 'string') &&
    optionalStrings.every((key) => row[key] === undefined || typeof row[key] === 'string') &&
    Array.isArray(row.files) &&
    row.files.every((file: unknown) => typeof file === 'string')
  )
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
        return requireDownloadedRows(JSON.parse(fs.readFileSync(registryPath(dir), 'utf-8')))
      } catch (error) {
        if (isMissing(error)) return []
        throw error
      }
    },
    write: (models) => {
      // A completed non-catalog download must be discoverable after restart. Let persistence
      // failures reach the facade finalizer so it cannot publish a success-shaped completion while
      // the installed model is absent from the durable registry.
      fs.mkdirSync(dir, { recursive: true })
      const temporaryPath = `${registryPath(dir)}.tmp-${randomUUID()}`
      const contents = JSON.stringify(models, null, 2)
      // Open outside the cleanup scope: a failed exclusive open does not own this path.
      const descriptor = fs.openSync(temporaryPath, 'wx')
      let open = true
      try {
        fs.writeFileSync(descriptor, contents)
        open = false
        fs.closeSync(descriptor)
        fs.renameSync(temporaryPath, registryPath(dir))
      } catch (cause) {
        const failures: unknown[] = [cause]
        if (open) {
          try {
            fs.closeSync(descriptor)
          } catch (closeCause) {
            failures.push(closeCause)
          }
        }
        try {
          fs.rmSync(temporaryPath, { force: true })
        } catch (cleanupCause) {
          failures.push(cleanupCause)
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            'Downloaded-model registry write and cleanup both failed.'
          )
        }
        throw cause
      }
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
    updateAtomically: async (update) => {
      // All Desktop registry writers run in this main process. Do not yield between reading the
      // current rows and replacing them: transfer registration and reconciliation also use this
      // synchronous store. Shared supplies the pure mutation; Desktop owns the atomic file swap.
      const store = desktopDownloadedRegistryPorts(dir)
      store.write([...update(store.read())])
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
