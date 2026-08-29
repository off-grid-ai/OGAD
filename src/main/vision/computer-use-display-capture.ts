/** One capture owner for Computer Use. Platform boundaries exclude the supervisor before pixels. */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { desktopCapturer } from 'electron'
import sharp from 'sharp'
import { binRoots, exe } from '../runtime-env'
import { existing } from '../transcription/bin-resolution'
import { getSupervisorCaptureWindowId } from './supervisor-window'

const execFileAsync = promisify(execFile)
const CAPTURE_TIMEOUT_MS = 10_000

export interface ComputerUseDisplayCapture {
  png: Buffer
  width: number
  height: number
}

interface CaptureInput {
  displayId: number
  width: number
  height: number
}

function captureBinary(): string | null {
  return existing(binRoots().map((root) => path.join(root, exe('computer-use-capture'))))
}

async function captureMacDisplay(input: CaptureInput): Promise<ComputerUseDisplayCapture> {
  const binary = captureBinary()
  if (!binary) throw new Error('Computer Use screen-capture helper is not installed.')
  const excludedWindowId = getSupervisorCaptureWindowId()
  if (!excludedWindowId) {
    throw new Error('Computer Use cannot identify its supervisor window for safe screen capture.')
  }
  const output = path.join(
    os.tmpdir(),
    `offgrid-computer-use-${process.pid}-${crypto.randomUUID()}.png`
  )
  try {
    await execFileAsync(
      binary,
      [
        output,
        String(input.displayId),
        String(excludedWindowId),
        String(input.width),
        String(input.height)
      ],
      { timeout: CAPTURE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    )
    const png = await fs.promises.readFile(output)
    const metadata = await sharp(png).metadata()
    if (!metadata.width || !metadata.height) {
      throw new Error('Computer Use screen capture returned invalid dimensions.')
    }
    return { png, width: metadata.width, height: metadata.height }
  } finally {
    await fs.promises.rm(output, { force: true }).catch(() => undefined)
  }
}

async function captureElectronDisplay(input: CaptureInput): Promise<ComputerUseDisplayCapture> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: input.width, height: input.height }
  })
  const source =
    sources.find((candidate) => String(candidate.display_id) === String(input.displayId)) ??
    sources[0]
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('Computer Use screen capture returned no pixels.')
  }
  const size = source.thumbnail.getSize()
  return { png: source.thumbnail.toPNG(), width: size.width, height: size.height }
}

/** Capture the display with the Computer Use PiP excluded at the native source. */
export async function captureComputerUseDisplay(
  input: CaptureInput
): Promise<ComputerUseDisplayCapture> {
  return process.platform === 'darwin' ? captureMacDisplay(input) : captureElectronDisplay(input)
}
