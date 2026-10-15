// Windows: ONNX Runtime's CUDA addon (from the performance pack) replaces the stock addon, which
// carries DirectML and WebGPU. Loading it on a machine where CUDA cannot start would leave voice
// and search on the CPU, so it is loaded only after one embedding has run on CUDA in a helper.
// The result is kept per pack and driver version, so a driver update tests again.

import fs from 'node:fs'
import path from 'node:path'
import type { BackendReason } from '@offgrid/models'
import { installedPerformancePackBin } from '../performance-pack'
import { nvidiaDriverVersion } from '../backend-facts'
import { resolveTransformersPackage, modelReadDirectories } from '../model-paths'
import { chosenModelsDir, modelsDir } from '../runtime-env'
import { DEFAULT_EMBEDDER } from '../embedding-models'

const PROBE_TIMEOUT_MS = 120_000

interface ProbeRecord {
  packRoot: string
  driver: string | null
  at: string
  error?: string
}

function packRoot(): string | null {
  const bin = installedPerformancePackBin()
  return bin ? path.dirname(bin) : null
}

function readRecord(file: string): ProbeRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProbeRecord
  } catch {
    return null
  }
}

function matches(record: ProbeRecord | null, root: string): boolean {
  return !!record && record.packRoot === root && record.driver === nvidiaDriverVersion()
}

/** Whether helpers may load the CUDA addon on this machine (Windows only). */
export function onnxCudaVerified(): { usable: boolean; reason?: BackendReason } {
  if (process.platform !== 'win32') return { usable: false, reason: { code: 'no-device' } }
  const root = packRoot()
  if (!root) return { usable: false, reason: { code: 'needs-pack' } }
  if (matches(readRecord(path.join(root, 'onnx-cuda-verified.json')), root)) return { usable: true }
  return { usable: false, reason: { code: 'not-verified' } }
}

function needsProbe(root: string): boolean {
  return (
    !matches(readRecord(path.join(root, 'onnx-cuda-verified.json')), root) &&
    !matches(readRecord(path.join(root, 'onnx-cuda-failed.json')), root)
  )
}

let running: Promise<boolean> | null = null

/** Run one embedding on CUDA in a helper and record the result. Windows only; true when CUDA ran.
 *  Waits until the default embedder is on disk, so an offline machine is not marked failed. */
export function probeOnnxCuda(): Promise<boolean> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return Promise.resolve(false)
  const root = packRoot()
  if (!root || !needsProbe(root)) return Promise.resolve(onnxCudaVerified().usable)
  if (
    !resolveTransformersPackage(DEFAULT_EMBEDDER.model, 'model.onnx', modelReadDirectories()) &&
    !resolveTransformersPackage(
      DEFAULT_EMBEDDER.model,
      'model_quantized.onnx',
      modelReadDirectories()
    )
  ) {
    return Promise.resolve(false)
  }
  running ??= runProbe(root).finally(() => {
    running = null
  })
  return running
}

async function runProbe(root: string): Promise<boolean> {
  const [{ forkHelper }, { onnxHelperEnv }] = await Promise.all([
    import('./utility-host'),
    import('./onnx-runtime-env')
  ])
  const entry = path.join(__dirname, 'embeddings-worker.js')
  const record: ProbeRecord = {
    packRoot: root,
    driver: nvidiaDriverVersion(),
    at: new Date().toISOString()
  }
  let helper: Awaited<ReturnType<typeof forkHelper>> | null = null
  try {
    helper = forkHelper(
      entry,
      {
        modelsDir: modelsDir(),
        chosenModelsDir: chosenModelsDir(),
        modelReadDirectories: modelReadDirectories(),
        devices: ['cuda']
      },
      { serviceName: 'offgrid-onnx-cuda-probe', label: 'GPU check', env: onnxHelperEnv('force') }
    )
    const started = helper
    const device = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The CUDA check timed out.')),
        PROBE_TIMEOUT_MS
      )
      started.on(
        'message',
        (response: { id: number; vectors?: unknown; device?: string; error?: string }) => {
          if (response.id !== 1 || (!response.vectors && !response.error)) return
          clearTimeout(timer)
          if (response.error) reject(new Error(response.error))
          else resolve(response.device ?? 'cpu')
        }
      )
      started.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`The CUDA check stopped (exit code ${code}).`))
      })
      started.postMessage({ id: 1, texts: ['probe'], model: DEFAULT_EMBEDDER.model })
    })
    if (device !== 'cuda') throw new Error(`ONNX Runtime ran on ${device}, not CUDA.`)
    fs.writeFileSync(path.join(root, 'onnx-cuda-verified.json'), JSON.stringify(record))
    fs.rmSync(path.join(root, 'onnx-cuda-failed.json'), { force: true })
    console.log('[ONNX] CUDA verified for voice and search')
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fs.writeFileSync(
      path.join(root, 'onnx-cuda-failed.json'),
      JSON.stringify({ ...record, error: message })
    )
    console.warn(
      '[ONNX] CUDA check failed; voice and search keep DirectML, WebGPU or CPU:',
      message
    )
    return false
  } finally {
    await helper?.terminate()
  }
}
