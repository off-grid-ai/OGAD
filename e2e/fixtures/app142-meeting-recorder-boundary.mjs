#!/usr/bin/env node

/**
 * Native meeting-recorder boundary for APP-142.
 *
 * The production MeetingController owns when this process starts and stops. This
 * executable only replaces ScreenCaptureKit/AVFoundation, which cannot be driven
 * deterministically in CI. It emits a small valid video so production finalization,
 * persistence, IPC, and UI state can run without mocking any Off Grid module.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [outputDirectory] = process.argv.slice(2)
const auditFile = process.env.OFFGRID_APP142_AUDIT_FILE
const ffmpeg = process.env.OFFGRID_APP142_FFMPEG

// Plain JavaScript fixtures are linted with the TypeScript rules.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const audit = (event) => {
  if (!auditFile) return
  fs.appendFileSync(auditFile, `${JSON.stringify({ ...event, at: Date.now() })}\n`)
}

if (!outputDirectory || !auditFile || !ffmpeg) {
  process.exit(64)
}

fs.mkdirSync(outputDirectory, { recursive: true })
const screen = path.join(outputDirectory, 'screen.mov')
const generated = spawnSync(
  ffmpeg,
  [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x180:r=10',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    screen
  ],
  { encoding: 'utf8' }
)

if (generated.status !== 0 || !fs.existsSync(screen) || fs.statSync(screen).size === 0) {
  audit({ event: 'media-error', pid: process.pid, status: generated.status })
  process.exit(65)
}

audit({ event: 'started', pid: process.pid, outputDirectory })

let stopping = false
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const stop = (signal) => {
  if (stopping) return
  stopping = true
  audit({ event: 'stopped', pid: process.pid, signal })
  process.stdout.write(`${JSON.stringify({ screen, mic: '' })}\n`, () => process.exit(0))
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
setInterval(() => {}, 1_000)
