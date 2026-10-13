// `import file from './x.onnx?asset'` gives the file's path in the app (electron-vite). Tests get
// the same: the absolute path of the file on disk, so code that reads it works unchanged.

import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'

const PREFIX = '\0asset:'

export function assetPathPlugin(): Plugin {
  return {
    name: 'offgrid-test-asset-path',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.endsWith('?asset') || !importer) return null
      return PREFIX + resolve(dirname(importer), id.slice(0, -'?asset'.length))
    },
    load(id) {
      return id.startsWith(PREFIX) ? `export default ${JSON.stringify(id.slice(PREFIX.length))}` : null
    }
  }
}
