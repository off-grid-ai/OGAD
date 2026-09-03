// Composition root: the shared download coordinator over Desktop's node artifact ports.
import { ModelDownloadCoordinator } from '@offgrid/models'

export type ModelDownloadCoordinatorPorts = ConstructorParameters<typeof ModelDownloadCoordinator>[0]

export function modelDownloadCoordinator(ports: ModelDownloadCoordinatorPorts): ModelDownloadCoordinator {
  return new ModelDownloadCoordinator(ports)
}
