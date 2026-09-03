// Composition root: the shared @offgrid/use engine and handler registry. The actions runtime
// supplies the ports (DB driver, rails, gate); it constructs nothing from shared.
import { HandlerRegistry, UseEngine } from '@offgrid/use'

export function createHandlerRegistry(): HandlerRegistry {
  return new HandlerRegistry()
}

export function createUseEngine(host: ConstructorParameters<typeof UseEngine>[0]): UseEngine {
  return new UseEngine(host)
}
