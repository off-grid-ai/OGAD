#!/usr/bin/env node
// Verify the Windows pack bootstrap executes before Rollup's hoisted ONNX import.
import fs from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') process.exit(0)

for (const name of ['index.js', 'embeddings-worker.js', 'tts-onnx-worker.js']) {
  const file = path.join(import.meta.dirname, '..', 'out', 'main', name)
  const source = fs.readFileSync(file, 'utf8')
  const bootstrap = source.indexOf('process.arch === "x64"')
  const manifest = source.indexOf('performance-packs.json')
  const onnx = source.indexOf('require("@huggingface/transformers")')
  if (bootstrap < 0 || manifest < 0 || onnx < 0 || bootstrap >= onnx || manifest >= onnx) {
    throw new Error(`Windows ONNX bootstrap does not precede external import in ${name}`)
  }
}
console.log('Windows ONNX bootstrap precedes external imports in all three main entries')
