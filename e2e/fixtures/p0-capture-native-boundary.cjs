/**
 * Native-only boundary for the P0 capture-consent Electron journey.
 *
 * The app, settings store, capture scheduler, IPC, persistence, and renderer remain production
 * code. This fixture controls only facts Playwright cannot own deterministically: macOS TCC,
 * Electron's desktopCapturer, and the native active-window provider. Every boundary crossing is
 * appended to a JSONL ledger so the rendered journey can prove when frame capture did and did not
 * happen.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron loads this boundary bootstrap as CommonJS before the built app. */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { register } = require('node:module')

const ledgerPath = process.env.OFFGRID_P0_CAPTURE_NATIVE_LEDGER
if (!ledgerPath) {
  throw new Error('OFFGRID_P0_CAPTURE_NATIVE_LEDGER is required')
}

fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
const record = (event, details = {}) => {
  fs.appendFileSync(ledgerPath, `${JSON.stringify({ event, ...details })}\n`)
}

// get-windows is ESM and imported lazily by the production scheduler. Registering a loader here
// replaces that native helper only; focus.ts and every owner above it stay real.
register('./p0-capture-native-loader.mjs', pathToFileURL(__filename))

const electron = require('electron')
// Electron treats this fixture as the app entry point. Restore the production app root before the
// real main bundle resolves resources, package metadata, and renderer assets.
electron.app.setAppPath(path.resolve(__dirname, '../..'))
electron.app.setPath('userData', process.env.OFFGRID_USER_DATA)
const originalMediaStatus = electron.systemPreferences.getMediaAccessStatus.bind(
  electron.systemPreferences
)
electron.systemPreferences.getMediaAccessStatus = (mediaType) => {
  if (mediaType === 'screen') {
    record('permission-read', { result: 'granted' })
    return 'granted'
  }
  return originalMediaStatus(mediaType)
}

// A valid opaque PNG. Vision persists these bytes through the real capture-frame pipeline.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const syntheticTitle = 'P0 Synthetic Capture Boundary'

electron.desktopCapturer.getSources = async (options) => {
  const types = Array.isArray(options?.types) ? options.types : []
  const width = Number(options?.thumbnailSize?.width ?? -1)
  const height = Number(options?.thumbnailSize?.height ?? -1)
  // A 1920px request is the production VisionService taking a frame. The meeting-presence scan
  // asks only for zero-sized window names and is intentionally kept distinct in the ledger.
  const event = width >= 100 ? 'frame-capture' : 'source-enumeration'
  record(event, { types, width, height })
  return [
    {
      id: 'p0-capture-source',
      name: syntheticTitle,
      display_id: '1',
      thumbnail: electron.nativeImage.createFromBuffer(png)
    }
  ]
}

record('fixture-ready')

// Delegate immediately to the exact main bundle every normal dev-target E2E launches.
require('../../out/main/index.js')
