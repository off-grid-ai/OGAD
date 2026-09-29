#!/usr/bin/env node
// One-time packager for verified CUDA directories extracted from a build artifact.
// The versioned archive is immutable. Publish its hash and byte count in the app.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const [, , platform, binRoot, archive, version] = process.argv
if (!['win32', 'linux'].includes(platform) || !binRoot || !archive || !/^[a-zA-Z0-9._-]+$/.test(version ?? '')) {
  throw new Error('Usage: node scripts/package-performance-pack.mjs <win32|linux> <bin-root> <output.tar.gz> <version>')
}

const folders = platform === 'win32'
  ? ['llama-cuda', 'llama-prism-cuda', 'cuda-runtime', 'sd-cuda', 'whisper', 'kev-runtime']
  : ['llama-cuda', 'llama-prism-cuda', 'cuda-runtime', 'sd-cuda', 'whisper-cuda', 'kev-runtime']
const required = platform === 'win32'
  ? ['llama-cuda/llama-server.exe', 'llama-prism-cuda/llama-server.exe', 'cuda-runtime/cudart64_12.dll', 'sd-cuda/sd-cli.exe', 'whisper/whisper-cli.exe', 'kev-runtime/python/python.exe']
  : ['llama-cuda/llama-server', 'llama-prism-cuda/llama-server', 'cuda-runtime/libcudart.so.12', 'sd-cuda/sd-cli', 'whisper-cuda/whisper-cli', 'kev-runtime/python/bin/python3']
for (const relative of required) {
  if (!fs.statSync(path.join(binRoot, relative)).isFile()) throw new Error(`Missing CUDA input: ${relative}`)
}

fs.mkdirSync(path.dirname(path.resolve(archive)), { recursive: true })
// Stream straight from the extracted installer. A second full copy can exhaust
// the runner disk before the archive is ready.
const tar = spawnSync('tar', [
  '-czf', path.resolve(archive), '--dereference',
  '--transform', 's,^,bin/,', '-C', path.resolve(binRoot), ...folders
], { stdio: 'inherit' })
if (tar.status !== 0) throw new Error(`tar failed with exit code ${tar.status}`)
const hash = createHash('sha256')
for await (const chunk of fs.createReadStream(archive)) hash.update(chunk)
const bytes = fs.statSync(archive).size
const asset = {
  url: `https://runtime.getoffgridai.co/desktop/cuda/${platform}/${version}.tar.gz`,
  sha256: hash.digest('hex'),
  bytes,
  version
}
fs.writeFileSync(`${archive}.json`, `${JSON.stringify(asset, null, 2)}\n`)
console.log(`${platform} CUDA pack: ${bytes} bytes, sha256 ${asset.sha256}`)
