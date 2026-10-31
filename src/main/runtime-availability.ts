// Whether an optional runtime is on this machine. A model or voice whose runtime is missing is not
// offered: downloading 9 GB of Kev weights, or a voice's assets, only to fail at first use is the
// worst order of events.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binRoots, exe, modelsDir, resourceDirs } from './runtime-env'

/** macOS major version, or null elsewhere (Darwin 22 = macOS 13). */
function macosMajor(): number | null {
  if (process.platform !== 'darwin') return null
  const darwin = Number(os.release().split('.')[0])
  return Number.isFinite(darwin) ? darwin - 9 : null
}

/** Kev's runtime (bundled on macOS, in the CUDA pack on Windows and Linux). Its MLX build on macOS
 *  needs macOS 14. */
export function kevRuntimeInstalled(): boolean {
  const supported =
    (process.platform === 'darwin' && process.arch === 'arm64' && (macosMajor() ?? 0) >= 14) ||
    process.platform === 'win32' ||
    (process.platform === 'linux' && process.arch === 'x64')
  if (!supported) return false
  const python =
    process.platform === 'win32'
      ? path.join('kev-runtime', 'python', 'python.exe')
      : path.join('kev-runtime', 'python', 'bin', 'python3')
  // A source checkout runs Kev from its development virtualenv (models-manager resolves the same).
  const developmentPython = path.join(
    path.dirname(modelsDir()),
    'decision-models',
    'kev-source',
    '.venv',
    'bin',
    'python'
  )
  return (
    (binRoots().some((root) => fs.existsSync(path.join(root, python))) ||
      fs.existsSync(developmentPython)) &&
    binRoots().some((root) => fs.existsSync(path.join(root, 'kev-local-server.py')))
  )
}

/** The sherpa-onnx offline CLI that runs Parakeet. */
export function parakeetBinary(): string | null {
  const name = exe('sherpa-onnx-offline')
  for (const root of binRoots()) {
    for (const candidate of [
      path.join(root, 'parakeet', 'bin', name),
      path.join(root, 'parakeet', name)
    ]) {
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

export function parakeetRuntimeInstalled(): boolean {
  return parakeetBinary() !== null
}

/** The ExecuTorch speech runtime that speaks every non-English voice. */
export function executorchSpeechBinary(): string | null {
  const candidates = [
    ...resourceDirs().map((root) => path.join(root, 'bin', 'executorch-speech')),
    path.resolve(process.cwd(), '../executorch-speech/native/bin/executorch-speech')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

export function executorchSpeechInstalled(): boolean {
  return executorchSpeechBinary() !== null
}
