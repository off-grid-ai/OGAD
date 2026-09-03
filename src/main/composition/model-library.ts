// Composition root: the shared model-library commands over Desktop's filesystem, registry, and
// runtime ports (all exported as functions from models-manager so module order never matters).
import {
  LocalModelImportService,
  ModelActivationService,
  ModelLibraryRemovalService,
  ModelMetadataRepairCommandService,
  ModelTransferRegistrationService
} from '@offgrid/models'
import {
  desktopActiveProjectorRepairPorts,
  desktopLocalModelImportPorts,
  desktopModelActivationPorts,
  desktopModelLibraryRemovalPorts,
  desktopModelTransferRegistrationPorts,
  type DesktopProjectorRepair
} from '../models-manager'
import { once } from '@offgrid/models'

export const modelLibraryRemovalService = once(
  () => new ModelLibraryRemovalService(desktopModelLibraryRemovalPorts())
)
export const activeProjectorRepairService = once(
  () => new ModelMetadataRepairCommandService<DesktopProjectorRepair>(desktopActiveProjectorRepairPorts())
)
export const modelActivationService = once(
  () => new ModelActivationService(desktopModelActivationPorts())
)
export const localModelImportService = once(
  () => new LocalModelImportService(desktopLocalModelImportPorts())
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
  const created = new ModelTransferRegistrationService(
    desktopModelTransferRegistrationPorts(dir, afterRegistered)
  )
  transferRegistrations.set(key, created)
  return created
}
