#!/usr/bin/env node
// ONNX Runtime's published Windows Node addon has no CUDA provider. The optional
// performance pack supplies a CUDA-enabled addon; keep the stock addon for other
// Windows GPUs and for machines without the pack.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const transformersRoot = path.join(root, 'node_modules', '@huggingface', 'transformers')
const packageInfo = JSON.parse(fs.readFileSync(path.join(transformersRoot, 'package.json'), 'utf8'))
if (packageInfo.version !== '4.3.0') {
  throw new Error(`Review the Windows CUDA patch for Transformers.js ${packageInfo.version}`)
}

function replaceOnce(file, before, after) {
  const current = fs.readFileSync(file, 'utf8')
  if (current.includes(after)) return
  if (current.split(before).length !== 2) throw new Error(`Unexpected ONNX source layout: ${file}`)
  fs.writeFileSync(file, current.replace(before, after))
}

for (const file of ['transformers.node.mjs', 'transformers.node.cjs']) {
  replaceOnce(
    path.join(transformersRoot, 'dist', file),
    'case "win32":\n      supportedDevices.push("dml");',
    'case "win32":\n      if (process.arch === "x64") supportedDevices.push("cuda");\n      supportedDevices.push("dml");'
  )
}

replaceOnce(
  path.join(transformersRoot, 'src', 'backends', 'onnx.js'),
  "case 'win32': // Windows x64 and Windows arm64\n            supportedDevices.push('dml');",
  "case 'win32': // Windows x64 and Windows arm64\n            if (process.arch === 'x64') supportedDevices.push('cuda');\n            supportedDevices.push('dml');"
)

const nestedOrtRoot = path.join(transformersRoot, 'node_modules', 'onnxruntime-node')
const ortRoot = fs.existsSync(nestedOrtRoot)
  ? nestedOrtRoot
  : path.join(root, 'node_modules', 'onnxruntime-node')
const ortInfo = JSON.parse(fs.readFileSync(path.join(ortRoot, 'package.json'), 'utf8'))
if (ortInfo.version !== '1.30.0') {
  throw new Error(`Review the Windows CUDA binding for ONNX Runtime Node ${ortInfo.version}`)
}
const bindingFile = path.join(ortRoot, 'dist', 'binding.js')
replaceOnce(
  bindingFile,
  'require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`);',
  `(() => {
    const stock = \`../bin/napi-v6/\${process.platform}/\${process.arch}/onnxruntime_binding.node\`;
    const pack = process.platform === 'win32' && process.arch === 'x64'
        ? process.env.OFFGRID_PERFORMANCE_PACK_BIN : undefined;
    const cuda = pack ? require('node:path').join(pack, 'onnx-cuda', 'onnxruntime_binding.node') : undefined;
    if (cuda && require('node:fs').existsSync(cuda)) {
        try {
            const selected = require(cuda);
            console.log('[ONNX] selected Windows CUDA binding');
            return selected;
        } catch (error) {
            console.warn('[ONNX] Windows CUDA binding failed; using stock binding:', error);
        }
    }
    return require(stock);
})();`
)

console.log('[ONNX] Windows CUDA package patch is ready')
