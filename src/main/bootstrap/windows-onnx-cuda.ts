import { activateInstalledPerformancePack } from '../performance-pack'
import fs from 'node:fs'
import path from 'node:path'

// ONNX Runtime selects its native binding while modules are imported. Set the
// verified pack path before imports from IPC can load Transformers.js.
if (process.platform === 'win32') {
  activateInstalledPerformancePack()
  const bin = process.env.OFFGRID_PERFORMANCE_PACK_BIN
  if (bin) {
    const libraries = path.join(bin, 'onnx-cuda')
    if (fs.existsSync(path.join(libraries, 'cudnn64_9.dll'))) {
      const current = (process.env.PATH ?? '').split(';').filter(Boolean)
      if (!current.some((entry) => entry.toLowerCase() === libraries.toLowerCase())) {
        process.env.PATH = [libraries, ...current].join(';')
      }
    }
  }
}
