/**
 * Download / select / remove the Mac's voice-recognition models for the native diarization runtime.
 * Python-free: files land as plain ONNX in the app's models dir, exactly where diarization-native.ts
 * looks, so the Models-screen card manages them like any other model.
 *
 * A bundle = the shared pyannote segmentation model + one fingerprint (speaker-embedding) model. The
 * segmentation ships as a .tar.bz2 (model.onnx + license); we stream it, then extract just model.onnx
 * with the system `tar` (bsdtar handles bzip2 on macOS/Windows/Linux). The fingerprint is a direct
 * .onnx download.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveDiarizationModel } from '@offgrid/models'
import { modelsDir } from '../runtime-env'
import {
  diarizationStatus,
  segmentationPath,
  fingerprintPath,
  fingerprintFile,
  setActiveModelId,
  SEGMENTATION_FILE,
  type DiarizationStatus
} from './diarization-native'

const execFileP = promisify(execFile)

export type InstallProgress = (fraction: number, label: string) => void

async function streamDownload(
  url: string,
  dest: string,
  onBytes: (received: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.length
        out.write(Buffer.from(value))
        onBytes(received, total)
      }
    }
  } finally {
    out.end()
  }
  await new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve())
    out.on('error', reject)
  })
  fs.renameSync(tmp, dest)
}

async function installSegmentation(model: ReturnType<typeof resolveDiarizationModel>, onProgress: InstallProgress, base: number, span: number): Promise<void> {
  const dir = modelsDir()
  const tmpTar = path.join(os.tmpdir(), `offgrid-seg-${process.pid}.tar.bz2`)
  await streamDownload(model.segmentationUrl, tmpTar, (r, t) => {
    const frac = base + span * (t ? r / t : 0)
    onProgress(Math.min(base + span, frac), 'Downloading speaker separation…')
  })
  onProgress(base + span, 'Unpacking speaker separation…')
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-seg-'))
  try {
    await execFileP('tar', ['xjf', tmpTar, '-C', extractDir])
    const found = findFile(extractDir, 'model.onnx')
    if (!found) throw new Error('segmentation archive did not contain model.onnx')
    fs.copyFileSync(found, path.join(dir, SEGMENTATION_FILE))
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true })
    fs.rmSync(tmpTar, { force: true })
  }
}

/**
 * Ensure the bundle `modelId` is installed (shared segmentation + its fingerprint), then make it the
 * active one. Streams only what's missing, reports 0..1 progress. Idempotent.
 */
export async function installVoiceModels(
  onProgress: InstallProgress,
  modelId?: string
): Promise<DiarizationStatus> {
  const model = resolveDiarizationModel(modelId)
  const dir = modelsDir()
  fs.mkdirSync(dir, { recursive: true })

  const needSeg = !segmentationPath()
  const needFingerprint = !fingerprintPath(model.id)

  // Weight progress: segmentation ~7MB, fingerprint ~27MB. Skip a leg that's already present.
  const segSpan = needSeg ? 0.2 : 0
  const fpSpan = needFingerprint ? 1 - segSpan : 0

  if (needSeg) {
    await installSegmentation(model, onProgress, 0, segSpan)
  }
  if (needFingerprint) {
    await streamDownload(model.embeddingUrl, path.join(dir, fingerprintFile(model.id)), (r, t) => {
      const frac = segSpan + fpSpan * (t ? r / t : 0)
      onProgress(Math.min(1, frac), 'Downloading voice fingerprint…')
    })
  }

  setActiveModelId(model.id)
  onProgress(1, 'Voice models ready')
  return diarizationStatus()
}

/**
 * Ensure `modelId`'s fingerprint (+ the shared segmentation) is present, downloading only what's
 * missing and WITHOUT changing this Mac's stored default. Called per offload request so the Mac can
 * serve whichever fingerprint the phone selected — one shared space, the phone drives it.
 */
export async function ensureFingerprint(modelId?: string): Promise<void> {
  const model = resolveDiarizationModel(modelId)
  if (segmentationPath() && fingerprintPath(model.id)) return
  const dir = modelsDir()
  fs.mkdirSync(dir, { recursive: true })
  if (!segmentationPath()) {
    await installSegmentation(model, () => {}, 0, 1)
  }
  if (!fingerprintPath(model.id)) {
    await streamDownload(model.embeddingUrl, path.join(dir, fingerprintFile(model.id)), () => {})
  }
}

/** Switch the active bundle to one that's already installed (no download). */
export async function selectVoiceModel(modelId: string): Promise<DiarizationStatus> {
  if (!fingerprintPath(modelId)) {
    throw new Error('that voice fingerprint isn’t downloaded yet')
  }
  setActiveModelId(modelId)
  return diarizationStatus()
}

/**
 * Remove a bundle's fingerprint (all bundles, if `modelId` omitted). The shared segmentation model is
 * only removed when no fingerprint remains.
 */
export async function removeVoiceModels(modelId?: string): Promise<DiarizationStatus> {
  const dir = modelsDir()
  const status = diarizationStatus()
  const targets = modelId ? [modelId] : status.models.map(m => m.id)
  for (const id of targets) {
    fs.rmSync(path.join(dir, fingerprintFile(id)), { force: true })
  }
  // Drop the shared segmentation only if nothing uses it anymore.
  const anyLeft = diarizationStatus().models.some(m => m.installed)
  if (!anyLeft) fs.rmSync(path.join(dir, SEGMENTATION_FILE), { force: true })
  return diarizationStatus()
}

function findFile(root: string, name: string): string | null {
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else if (entry.name === name) return p
    }
  }
  return null
}
