export interface DesktopModelManagerPorts {
  getCatalog(): Promise<{ kinds: readonly string[]; models: unknown[] }>
  listInstalled(): Promise<string[]>
  resolveCanonicalModelSelectionId(modelId: string): Promise<string>
  projectActiveTextModelSelection(modelId: string): Promise<{ success: boolean; error?: string }>
}

let ports: DesktopModelManagerPorts | null = null

export function registerDesktopModelManagerPorts(value: DesktopModelManagerPorts): void {
  ports = value
}

function current(): DesktopModelManagerPorts {
  if (!ports) throw new Error('Desktop model manager ports are not initialized.')
  return ports
}

export const desktopModelManagerPorts: DesktopModelManagerPorts = new Proxy(
  {} as DesktopModelManagerPorts,
  {
    get: (_target, property) => {
      const value = current()[property as keyof DesktopModelManagerPorts]
      return typeof value === 'function' ? value.bind(current()) : value
    }
  }
)
