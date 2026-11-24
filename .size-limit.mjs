// Bundle budgets (npm run perf:size, after `electron-vite build`). Raw bytes, not gzip: Electron
// reads these from disk, so what costs startup is how much V8 has to parse, not transfer size.
// Each limit is the size when it was set plus about 10%; a PR that grows a bundle past it fails CI.
// To raise one on purpose, see perf/README.md.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

// The renderer's entry chunk and stylesheet carry content hashes, so read them from index.html.
const html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8')
const asset = (pattern) => {
  const match = pattern.exec(html)
  if (!match) throw new Error(`out/renderer/index.html has no ${pattern}`)
  return path.join('out/renderer', match[1])
}
const rendererEntry = asset(/<script[^>]+src="\.\/(assets\/[^"]+\.js)"/)
const rendererCss = asset(/<link[^>]+href="\.\/(assets\/[^"]+\.css)"/)

const raw = { gzip: false, brotli: false }

export default [
  { name: 'main: entry', path: 'out/main/index.js', limit: '2770 kB', ...raw },
  { name: 'main: everything', path: 'out/main/**/*.js', limit: '5150 kB', ...raw },
  { name: 'preload', path: 'out/preload/*.js', limit: '58 kB', ...raw },
  { name: 'renderer: first load (entry JS)', path: rendererEntry, limit: '17460 kB', ...raw },
  { name: 'renderer: first load (CSS)', path: rendererCss, limit: '970 kB', ...raw },
  { name: 'renderer: all JS', path: 'out/renderer/assets/*.js', limit: '24000 kB', ...raw }
]
