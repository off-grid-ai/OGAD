/**
 * Runs the pyannote + ECAPA diarization script for the gateway's /v1/audio/diarize and /v1/audio/embed
 * routes. The phone offloads a recording to this Mac; we shell out to resources/diarization/diarize.py
 * (the user's own Python env — an accelerator, not a per-user dependency) and parse its JSON.
 *
 * Config via env: OGRID_DIARIZE_PYTHON (python interpreter, default "python3"),
 * OGRID_DIARIZE_SCRIPT (script path, default the bundled resources path), HF_TOKEN (pyannote is gated).
 * PYTORCH_ENABLE_MPS_FALLBACK is forced on so unsupported MPS ops fall back to CPU quietly.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface DiarizedTurn {
  startMs: number
  endMs: number
  cluster: string
  embedding?: number[]
}

function scriptPath(): string {
  if (process.env.OGRID_DIARIZE_SCRIPT) return process.env.OGRID_DIARIZE_SCRIPT
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return path.join(base, 'resources', 'diarization', 'diarize.py')
}

function defaultPython(): string {
  if (process.env.OGRID_DIARIZE_PYTHON) return process.env.OGRID_DIARIZE_PYTHON
  // The setup guide creates this venv; prefer it so a normally-launched app finds it.
  const venv = path.join(os.homedir(), '.offgrid-diarize', 'bin', 'python3')
  return fs.existsSync(venv) ? venv : 'python3'
}

function run(mode: 'diarize' | 'embed', wavPath: string): Promise<unknown> {
  const python = defaultPython()
  return new Promise((resolve, reject) => {
    execFile(
      python,
      [scriptPath(), mode, wavPath],
      {
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' }
      },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message))
        try {
          const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}')
          if (parsed && parsed.error) return reject(new Error(String(parsed.error)))
          resolve(parsed)
        } catch (e) {
          reject(new Error(`diarization output was not JSON: ${(e as Error).message}`))
        }
      }
    )
  })
}

/** Diarize a full recording into speaker turns (each with an ECAPA voiceprint). */
export async function diarizeRecording(wavPath: string): Promise<{ turns: DiarizedTurn[] }> {
  const out = (await run('diarize', wavPath)) as { turns?: DiarizedTurn[] }
  return { turns: out.turns ?? [] }
}

/** ECAPA voiceprint for one clip (enrollment) — same model as the diarized turns. */
export async function embedClip(wavPath: string): Promise<{ embedding: number[] }> {
  const out = (await run('embed', wavPath)) as { embedding?: number[] }
  return { embedding: out.embedding ?? [] }
}
