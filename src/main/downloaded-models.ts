// Desktop adapter for the shared downloaded-model registry. Portable reconciliation and query
// policy lives in @offgrid/models; this file owns only JSON persistence, filesystem metadata, and
// the @offgrid/sync package-identity boundary.

import fs from 'fs'
import path from 'path'
import { modelPackageIdentity } from '@offgrid/sync'
import type {
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

type DownloadedRegistryPorts = ConstructorParameters<typeof DownloadedModelRegistryService>[0]

/** JSON persistence, file sizes, and package identity for one models directory. I/O only. */
export function desktopDownloadedRegistryPorts(dir: string): DownloadedRegistryPorts {
  return {
    read: () => {
      try {
        const rows: unknown = JSON.parse(fs.readFileSync(registryPath(dir), 'utf-8'))
        return Array.isArray(rows) ? (rows as DownloadedModel[]) : []
      } catch {
        return []
      }
    },
    write: (models) => {
      try {
        fs.writeFileSync(registryPath(dir), JSON.stringify(models, null, 2))
      } catch {
        /* The registry is best-effort metadata. Model artifacts remain recoverable from disk. */
      }
    },
    fileSize: (fileName) => {
      try {
        return fs.statSync(path.join(dir, fileName)).size
      } catch {
        return 0
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
