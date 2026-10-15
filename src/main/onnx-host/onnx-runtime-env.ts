// The environment a voice or search helper process starts with. CUDA libraries for ONNX Runtime
// reach the helper here, at spawn, so the app never restarts itself to change its own library path,
// and the CUDA 13 libraries never leak into the chat, image or speech engines.

import fs from 'node:fs'
import path from 'node:path'
import { installedPerformancePackBin } from '../performance-pack'
import { onnxCudaVerified } from './onnx-cuda-probe'

/** The pack's ONNX CUDA library folder, when the pack is installed and has one. */
export function installedOnnxCudaDir(): string | null {
  const bin = installedPerformancePackBin()
  if (!bin) return null
  const libraries = path.join(bin, 'onnx-cuda')
  const marker = process.platform === 'win32' ? 'onnxruntime.dll' : 'libcublasLt.so.13'
  return fs.existsSync(path.join(libraries, marker)) ? libraries : null
}

/** `cuda: 'auto'` adds the CUDA libraries only where they are allowed to load; `'force'` is the
 *  Windows probe that decides whether they are. */
export function onnxHelperEnv(cuda: 'auto' | 'force' = 'auto'): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  const libraries = installedOnnxCudaDir()
  if (!libraries) return env
  if (process.platform === 'linux') {
    const current = (env.LD_LIBRARY_PATH ?? '').split(':').filter(Boolean)
    if (!current.includes(libraries)) env.LD_LIBRARY_PATH = [libraries, ...current].join(':')
    return env
  }
  if (
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    (cuda === 'force' || onnxCudaVerified().usable)
  ) {
    // The patched onnxruntime-node binding loads the pack's CUDA addon only with this flag set
    // (scripts/patch-windows-onnx-cuda.mjs); without it the stock addon keeps DirectML and WebGPU.
    env.OFFGRID_ONNX_CUDA_VERIFIED = '1'
    env.OFFGRID_PERFORMANCE_PACK_BIN = path.dirname(libraries)
    env.PATH = `${libraries}${path.win32.delimiter}${env.PATH ?? ''}`
  }
  return env
}
