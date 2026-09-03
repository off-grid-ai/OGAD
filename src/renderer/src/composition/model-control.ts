// Renderer composition root: the shared model-control application over the preload port.
import { ModelControlApplicationService } from '@offgrid/models'
import {
  desktopModelControlPorts,
  type DesktopModelControlModel
} from '@renderer/lib/model-control-application'
import type { ComputerUseActiveModelProjection } from '../../../shared/computer-use-settings'

export const desktopModelControl = new ModelControlApplicationService<
  DesktopModelControlModel,
  ComputerUseActiveModelProjection
>(desktopModelControlPorts())
