// Whether helpers may load the Windows ONNX CUDA addon: the record the CUDA check
// (onnx-cuda-probe.ts) leaves beside the performance pack, per pack and driver version.

import fs from 'node:fs'
import path from 'node:path'
import type { BackendReason } from '@offgrid/models'
import { installedPerformancePackBin } from '../performance-pack'
import { cachedNvidiaDriverVersion } from '../nvidia-driver'

export interface ProbeRecord {
  packRoot: string
  driver: string | null
  at: string
  error?: string
}

export function packRoot(): string | null {
  const bin = installedPerformancePackBin()
  return bin ? path.dirname(bin) : null
}

export function readRecord(file: string): ProbeRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProbeRecord
  } catch {
    return null
  }
}

export function matches(record: ProbeRecord | null, root: string): boolean {
  return !!record && record.packRoot === root && record.driver === cachedNvidiaDriverVersion()
}

/** Whether helpers may load the CUDA addon on this machine (Windows only). */
export function onnxCudaVerified(): { usable: boolean; reason?: BackendReason } {
  if (process.platform !== 'win32') return { usable: false, reason: { code: 'no-device' } }
  const root = packRoot()
  if (!root) return { usable: false, reason: { code: 'needs-pack' } }
  if (matches(readRecord(path.join(root, 'onnx-cuda-verified.json')), root)) return { usable: true }
  return { usable: false, reason: { code: 'not-verified' } }
}
