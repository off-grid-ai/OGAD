import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { NativeActionResponse } from './native-helper-logic'

type LocationBinding = {
  currentLocation(): Promise<NativeActionResponse>
}

let binding: LocationBinding | null = null

export async function currentMacLocation(): Promise<NativeActionResponse> {
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'location.node')
    : path.join(process.cwd(), 'resources', 'bin', 'location.node')
  if (!fs.existsSync(binary)) {
    return { ok: false, error: 'the macOS location bridge is not available in this build' }
  }
  try {
    // The system permission prompt is tied to the foreground app. This bridge
    // runs in Electron itself, so its TCC identity matches the Settings switch.
    app.focus({ steal: true })
    if (!binding) {
      const nativeModule = { exports: {} } as NodeModule
      process.dlopen(nativeModule, binary)
      binding = nativeModule.exports as LocationBinding
    }
    return await binding.currentLocation()
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
