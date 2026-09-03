import type { ModelControlApplicationSnapshot } from '@offgrid/models'
import type { ComputerUseActiveModelProjection } from '../../shared/computer-use-settings'
import {
  getModelControlCatalogFacts,
  requireModelControlCatalogModels,
  type DesktopModelControlCatalogModel
} from '../models-manager'
import { getComputerUseActiveModelProjection } from '../vision/vision-task-model-strategy'
import { desktopModels } from './application-access'

/** Compose the model and Computer Use projections without making either domain own the other. */
export async function getModelControlSnapshot(): Promise<
  ModelControlApplicationSnapshot<DesktopModelControlCatalogModel, ComputerUseActiveModelProjection>
> {
  const [{ catalog, installed }, computerUse] = await Promise.all([
    getModelControlCatalogFacts(),
    getComputerUseActiveModelProjection()
  ])
  return desktopModels.controlSnapshot({
    catalog: {
      kinds: catalog.kinds,
      models: requireModelControlCatalogModels(catalog.models)
    },
    installed,
    computerUse
  })
}
