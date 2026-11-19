#!/usr/bin/env node
// The main process must open without loading an optional native runtime. A failed native load at
// startup is an uncaught exception, and Electron then shows an error and never opens the app:
// 0.0.58 crashed at launch on Windows because a static import put transformers.js, and with it
// onnxruntime-node's addon, on the startup path. Those packages load on first use instead.
//
// Follows the static require() graph of the built main entry (out/main/index.js) and fails when it
// reaches one of these packages. Dynamic import() is not followed: it runs on first use. The bundle
// is CommonJS: a static import is a top-level `const x = require("...")` line, while a dynamic one
// is `Promise.resolve().then(() => require("..."))`.
//
// Usage: node scripts/verify-main-startup-imports.mjs [out/main]
import fs from 'node:fs'
import path from 'node:path'

const DEFERRED = ['onnxruntime-node', '@huggingface/transformers', '@gutenye/ocr-node', 'kokoro-js']

const outMain = path.resolve(process.argv[2] ?? 'out/main')
const entry = path.join(outMain, 'index.js')
if (!fs.existsSync(entry)) {
  console.error(`Built main entry not found: ${entry} (run electron-vite build first)`)
  process.exit(2)
}

const seen = new Map([[entry, null]])
const queue = [entry]
const failures = []
while (queue.length) {
  const file = queue.shift()
  const staticLines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^\S/.test(line) && !line.includes('Promise.resolve().then('))
  const specs = staticLines.flatMap((line) =>
    [...line.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map((m) => m[2])
  )
  for (const spec of specs) {
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`)
      if (fs.existsSync(target) && !seen.has(target)) {
        seen.set(target, file)
        queue.push(target)
      }
    } else if (DEFERRED.some((name) => spec === name || spec.startsWith(`${name}/`))) {
      const chain = []
      for (let at = file; at; at = seen.get(at)) chain.unshift(path.relative(outMain, at))
      failures.push(`${spec} loads at startup: ${chain.join(' -> ')}`)
    }
  }
}

for (const failure of failures) console.error(failure)
if (failures.length) {
  console.error('Import these packages with a dynamic import() where they are first used.')
  process.exit(1)
}
console.log(`Main startup path (${seen.size} files) loads no optional native runtime.`)
