import { randomBytes } from 'node:crypto'
import { CATALOG, getModelFiles, resolveHuggingFaceModel, type ModelEntry } from '@offgrid/models'
import { platformFetch } from '@offgrid/models/fetch'
import type { ModelControlCatalogModel, ModelsControlPlatformPort } from '@offgrid/application'
import { getCatalog, requireModelControlCatalogModels } from '../models-manager'

type FetchPort = typeof platformFetch

function toControlModel(
  model: ReturnType<typeof requireModelControlCatalogModels>[number] | ModelEntry
): ModelControlCatalogModel {
  const { files = [], ...facts } = model
  return {
    ...facts,
    artifacts: files.map((file) => ({
      name: file.name,
      ...(file.role ? { role: file.role } : {}),
      ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
      ...(file.url ? { url: file.url } : {}),
      ...(file.sha256 ? { sha256: file.sha256 } : {})
    }))
  }
}

async function resolveExternalModel(
  modelId: string,
  selection: { readonly repositoryId: string; readonly fileName: string } | undefined,
  fetchImpl: FetchPort
): Promise<ModelEntry | null> {
  const repositoryId = selection?.repositoryId ?? modelId
  const entry = await resolveHuggingFaceModel(repositoryId, { fetchImpl })
  if (!entry || !selection) return entry
  if (entry.files.some((file) => file.name === selection.fileName)) return entry
  const selected = (await getModelFiles(repositoryId, { fetchImpl })).find(
    (variant) => variant.fileName === selection.fileName
  )
  if (!selected) return entry
  return {
    ...entry,
    files: [
      {
        name: selected.fileName,
        role: 'primary',
        sizeBytes: selected.sizeBytes,
        url: selected.downloadUrl
      },
      ...(selected.mmproj
        ? [
            {
              name: selected.mmproj.fileName,
              role: 'mmproj' as const,
              ...(selected.mmproj.sizeBytes === undefined
                ? {}
                : { sizeBytes: selected.mmproj.sizeBytes }),
              url: selected.mmproj.url
            }
          ]
        : [])
    ]
  }
}

/** Desktop catalog facts and cryptographic entropy. Shared owns every control decision. */
export function createDesktopModelControlPort(input?: {
  readonly fetchImpl?: FetchPort
  readonly readCatalog?: typeof getCatalog
}): ModelsControlPlatformPort {
  const fetchImpl = input?.fetchImpl ?? platformFetch
  const readCatalog = input?.readCatalog ?? getCatalog
  return {
    catalog: {
      read: async (signal) => {
        signal.throwIfAborted()
        const catalog = await readCatalog()
        signal.throwIfAborted()
        return {
          kinds: catalog.kinds,
          models: requireModelControlCatalogModels(catalog.models).map(toControlModel)
        }
      },
      resolve: async (modelId, signal, selection) => {
        signal.throwIfAborted()
        const entry =
          CATALOG.find((model) => model.id === modelId) ??
          (await resolveExternalModel(modelId, selection, fetchImpl))
        signal.throwIfAborted()
        return entry ? toControlModel(entry) : null
      }
    },
    randomBytes: (length) => randomBytes(length)
  }
}
