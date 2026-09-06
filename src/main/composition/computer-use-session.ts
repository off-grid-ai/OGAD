// Composition root: the shared Computer Use session application over Desktop's vision ports.
import {
  ComputerUseSessionApplicationService,
  type ComputerUseSessionApplicationPorts
} from '@offgrid/models/computer-use'

export function createComputerUseSessionApplication<
  Environment,
  Model,
  DecisionInput,
  DecisionResult
>(
  ports: ComputerUseSessionApplicationPorts<Environment, Model, DecisionInput, DecisionResult>
): ComputerUseSessionApplicationService<Environment, Model, DecisionInput, DecisionResult> {
  return new ComputerUseSessionApplicationService(ports)
}
