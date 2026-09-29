// This runs before Rollup's external requires in every main-process entry.
// The optional pack is trusted only after its manifest and install marker match.
if (process.platform === 'win32' && process.arch === 'x64') {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const app = require('electron').app
    const manifestPath = app.isPackaged
      ? path.join(process.resourcesPath, 'performance-packs.json')
      : path.join(app.getAppPath(), 'resources', 'performance-packs.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const asset = manifest.schemaVersion === 1 && manifest.cuda?.win32
    if (asset && /^[a-f0-9]{64}$/i.test(asset.sha256) && /^[a-zA-Z0-9._-]+$/.test(asset.version) &&
        new URL(asset.url).origin === 'https://runtime.getoffgridai.co' &&
        new URL(asset.url).pathname === `/desktop/cuda/win32/${asset.version}.tar.gz`) {
      const data = process.env.OFFGRID_DATA_DIR || process.env.OFFGRID_USER_DATA ||
        path.join(app.getPath('appData'), 'Off Grid AI Desktop')
      const root = path.join(data, 'performance-packs', `cuda-${asset.version}-${asset.sha256.slice(0, 12)}`)
      const marker = fs.readFileSync(path.join(root, 'verified.sha256'), 'utf8').trim()
      const bin = path.join(root, 'bin')
      const libraries = path.join(bin, 'onnx-cuda')
      if (marker === asset.sha256.toLowerCase() &&
          fs.existsSync(path.join(libraries, 'onnxruntime.dll')) &&
          fs.existsSync(path.join(libraries, 'onnxruntime_providers_shared.dll')) &&
          fs.existsSync(path.join(libraries, 'cudnn64_9.dll'))) {
        process.env.OFFGRID_PERFORMANCE_PACK_BIN = bin
        process.env.PATH = `${libraries};${process.env.PATH || ''}`
      }
    }
  } catch {
    // No verified pack yet. The stock ONNX Runtime remains available.
  }
}
