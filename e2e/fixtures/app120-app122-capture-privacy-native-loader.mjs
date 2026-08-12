/**
 * Native active-window boundary for APP-120 / APP-122.
 *
 * The production focus scheduler imports get-windows lazily. This loader replaces only that
 * operating-system helper and reads the current synthetic native surface from a test-owned control
 * file. Capture policy, extraction, persistence, IPC, and every rendered surface remain real.
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node loader hooks are JavaScript runtime contracts. */
const syntheticModuleUrl = 'offgrid-app120-app122:active-window'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'get-windows') {
    return { url: syntheticModuleUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url !== syntheticModuleUrl) return nextLoad(url, context)
  return {
    format: 'module',
    shortCircuit: true,
    source: `
      import fs from 'node:fs'
      const controlPath = process.env.OFFGRID_APP120_APP122_NATIVE_CONTROL
      const ledgerPath = process.env.OFFGRID_APP120_APP122_NATIVE_LEDGER
      const readControl = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'))
      const record = (event, details = {}) => {
        fs.appendFileSync(ledgerPath, JSON.stringify({ event, ...details }) + '\\n')
      }
      export async function activeWindow() {
        const control = readControl()
        const surface = control.surface ?? {}
        const result = {
          owner: { name: String(surface.appName ?? 'APP-120 Recovery Workbench') },
          title: String(surface.windowTitle ?? 'APP-120 capture privacy recovery'),
          url: String(surface.url ?? 'offgrid-e2e://capture-privacy'),
          bounds: { x: 40, y: 40, width: 1200, height: 800 }
        }
        record('active-window', {
          appName: result.owner.name,
          windowTitle: result.title,
          captureMode: String(control.captureMode ?? 'normal')
        })
        return result
      }
      export function activeWindowSync() { return undefined }
      export async function openWindows() { return [] }
      export function openWindowsSync() { return [] }
    `
  }
}
