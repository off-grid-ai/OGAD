import type { OffGridPlatformPorts } from '@offgrid/application'

export type DesktopApplicationExtensionPorts = Pick<OffGridPlatformPorts, 'sync' | 'pro'>
export type DesktopApplicationExtensionPortsFactory = () => DesktopApplicationExtensionPorts

const emptyExtensionPorts: DesktopApplicationExtensionPortsFactory = () => ({})

let registeredFactory = emptyExtensionPorts
let rootConstructed = false

/** Register optional product ports before the Desktop application root is first imported. */
export function registerDesktopApplicationExtensionPorts(
  factory: DesktopApplicationExtensionPortsFactory
): void {
  if (rootConstructed) {
    throw new Error('Desktop application extension ports registered after root construction')
  }
  if (registeredFactory !== emptyExtensionPorts) {
    throw new Error('Desktop application extension ports already registered')
  }
  registeredFactory = factory
}

/** Called once by the application composition root. This seals extension registration. */
export function consumeDesktopApplicationExtensionPorts(): DesktopApplicationExtensionPorts {
  rootConstructed = true
  return registeredFactory()
}
