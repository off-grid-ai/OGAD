import { randomBytes } from 'node:crypto'
import type {
  ModelControlCatalogModel,
  ModelsControlPlatformPort
} from '@offgrid/application'
import { getCatalog, requireModelControlCatalogModels } from '../models-manager'

function toControlModel(
  model: ReturnType<typeof requireModelControlCatalogModels>[number]
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

/** Desktop catalog facts and cryptographic entropy. Shared owns every control decision. */
export function createDesktopModelControlPort(): ModelsControlPlatformPort {
  return {
    catalog: {
      read: async (signal) => {
        signal.throwIfAborted()
        const catalog = await getCatalog()
        signal.throwIfAborted()
        return {
          kinds: catalog.kinds,
          models: requireModelControlCatalogModels(catalog.models).map(toControlModel)
        }
      }
    },
    randomBytes: (length) => randomBytes(length)
  }
}
