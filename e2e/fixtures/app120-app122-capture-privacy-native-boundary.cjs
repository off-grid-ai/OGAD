/**
 * Native-only boundary for the rendered APP-120 / APP-122 capture-privacy journey.
 *
 * Controlled here because Playwright cannot change macOS TCC, lock the host session, choose the
 * frontmost native window, or make ScreenCaptureKit return an empty frame safely. The application,
 * capture scheduler, permission controller, policy, persistence, Replay, and Settings are the built
 * production code. A JSONL ledger records every native crossing so the journey can prove absence as
 * well as recovery.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron loads this CommonJS bootstrap before the production bundle. */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { register } = require('node:module')

const ledgerPath = process.env.OFFGRID_APP120_APP122_NATIVE_LEDGER
const controlPath = process.env.OFFGRID_APP120_APP122_NATIVE_CONTROL
if (!ledgerPath || !controlPath) {
  throw new Error('APP-120 / APP-122 native ledger and control paths are required')
}

fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
const record = (event, details = {}) => {
  fs.appendFileSync(ledgerPath, `${JSON.stringify({ event, ...details })}\n`)
}
const readControl = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'))

register('./app120-app122-capture-privacy-native-loader.mjs', pathToFileURL(__filename))

const electron = require('electron')
electron.app.setAppPath(path.resolve(__dirname, '../..'))
electron.app.setPath('userData', process.env.OFFGRID_USER_DATA)

const originalMediaStatus = electron.systemPreferences.getMediaAccessStatus.bind(
  electron.systemPreferences
)
electron.systemPreferences.getMediaAccessStatus = (mediaType) => {
  if (mediaType === 'screen') {
    const permission = readControl().permission === 'granted' ? 'granted' : 'denied'
    record('permission-read', { permission })
    return permission
  }
  return originalMediaStatus(mediaType)
}
electron.systemPreferences.isTrustedAccessibilityClient = () => true

const originalOpenExternal = electron.shell.openExternal.bind(electron.shell)
electron.shell.openExternal = async (target, options) => {
  if (String(target).startsWith('x-apple.systempreferences:')) {
    record('open-system-settings', { target: String(target) })
    return undefined
  }
  return originalOpenExternal(target, options)
}

// The test harness performs the replacement launch itself so Playwright stays attached. Production
// still owns the request, asynchronous shutdown, and commit point; only Electron's process-spawn
// boundary is intercepted.
electron.app.relaunch = (options) => {
  record('application-relaunch', { options: options ?? null })
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const frameWidth = 320
const frameHeight = 240
const frameBitmap = Buffer.alloc(frameWidth * frameHeight * 4)
for (let pixel = 0; pixel < frameWidth * frameHeight; pixel += 1) {
  const offset = pixel * 4
  // Deterministic high-detail pixels model an ordinary nonblank native screenshot and remain over
  // Replay's deliberate 8KB blank-frame threshold after PNG encoding.
  frameBitmap[offset] = (pixel * 17) % 256
  frameBitmap[offset + 1] = (pixel * 31 + Math.floor(pixel / frameWidth)) % 256
  frameBitmap[offset + 2] = (pixel * 47 + Math.floor(pixel / 97)) % 256
  frameBitmap[offset + 3] = 255
}
const capturedFrame = electron.nativeImage.createFromBitmap(frameBitmap, {
  width: frameWidth,
  height: frameHeight,
  scaleFactor: 1
})

electron.desktopCapturer.getSources = async (options) => {
  const types = Array.isArray(options?.types) ? options.types : []
  const width = Number(options?.thumbnailSize?.width ?? -1)
  const height = Number(options?.thumbnailSize?.height ?? -1)
  const control = readControl()

  if (width === 1 && height === 1) {
    record('permission-request', { permission: control.permission })
    return [
      {
        id: 'app120-permission-source',
        name: 'APP-120 permission request',
        display_id: '1',
        thumbnail: electron.nativeImage.createFromBuffer(png)
      }
    ]
  }

  // Meeting presence asks for a zero-sized window-name scan. It is a separate native consumer and
  // must not be mistaken for Replay capture evidence.
  if (width < 100) {
    record('source-enumeration', { types, width, height })
    return []
  }

  const captureMode = control.captureMode === 'blank' ? 'blank' : 'normal'
  record('frame-capture', {
    types,
    width,
    height,
    captureMode,
    appName: control.surface?.appName ?? null
  })
  const thumbnail = captureMode === 'blank' ? electron.nativeImage.createEmpty() : capturedFrame
  return [
    {
      id: `app122-${types[0] ?? 'source'}`,
      name: String(control.surface?.windowTitle ?? 'APP-122 capture surface'),
      display_id: '1',
      thumbnail
    }
  ]
}

record('fixture-ready', { pid: process.pid })
require('../../out/main/index.js')
