/** ESM loader for the native active-window edge of the P0 capture-consent journey. */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node loader hooks are JavaScript runtime contracts. */
const syntheticModuleUrl = 'offgrid-p0-capture:active-window'

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
      let sequence = 0
      const ledgerPath = process.env.OFFGRID_P0_CAPTURE_NATIVE_LEDGER
      const record = (event, details = {}) => {
        fs.appendFileSync(ledgerPath, JSON.stringify({ event, ...details }) + '\\n')
      }
      export async function activeWindow() {
        sequence += 1
        record('active-window', { sequence })
        return {
          owner: { name: 'P0 Synthetic Workbench ' + String(sequence) },
          title: 'P0 Synthetic Capture Boundary',
          url: 'offgrid-p0://synthetic/' + String(sequence),
          bounds: { x: 40, y: 40, width: 1200, height: 800 }
        }
      }
      export function activeWindowSync() { return undefined }
      export async function openWindows() { return [] }
      export function openWindowsSync() { return [] }
    `
  }
}
