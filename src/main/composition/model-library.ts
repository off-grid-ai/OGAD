// Composition root: the shared model-library commands over Desktop's filesystem, registry, and
// runtime ports. Desktop registers I/O factories; this root owns only Shared service construction.
import {
  LocalModelImportService,
  ModelLibraryRemovalService,
  ModelTransferRegistrationService
} from '@offgrid/models'
import { once } from '@offgrid/models'

interface DesktopModelLibraryPortFactories {
  removal: () => ConstructorParameters<typeof ModelLibraryRemovalService>[0]
  localImport: () => ConstructorParameters<typeof LocalModelImportService>[0]
  transfer: (
    dir: () => string,
    afterRegistered?: () => Promise<void>
  ) => ConstructorParameters<typeof ModelTransferRegistrationService>[0]
}

let desktopPorts: DesktopModelLibraryPortFactories | null = null

export function registerDesktopModelLibraryPorts(ports: DesktopModelLibraryPortFactories): void {
  if (desktopPorts) throw new Error('Desktop model-library ports are already registered.')
  desktopPorts = ports
}

function ports(): DesktopModelLibraryPortFactories {
  if (!desktopPorts) throw new Error('Desktop model-library ports are not registered.')
  return desktopPorts
}

export const modelLibraryRemovalService = once(
  () => new ModelLibraryRemovalService(ports().removal())
)
export const localModelImportService = once(
  () => new LocalModelImportService(ports().localImport())
)

const transferRegistrations = new Map<string, ModelTransferRegistrationService>()
/** One registration service per models directory (the default directory is the common case). */
export function modelTransferRegistration(
  dir: () => string,
  afterRegistered?: () => Promise<void>
): ModelTransferRegistrationService {
  const key = dir()
  const existing = transferRegistrations.get(key)
  if (existing) return existing
  const created = new ModelTransferRegistrationService(ports().transfer(dir, afterRegistered))
  transferRegistrations.set(key, created)
  return created
}
