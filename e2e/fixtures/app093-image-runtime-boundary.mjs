#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outputFlag = process.argv.indexOf('-o')
const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined
const previewFlag = process.argv.indexOf('--preview-path')
const previewPath = previewFlag >= 0 ? process.argv[previewFlag + 1] : undefined
const logPath = process.env.APP093_IMAGE_RUNTIME_LOG

if (!outputPath) {
  process.stderr.write('app093 boundary: missing -o output path\n')
  process.exit(2)
}

// A real, checksum-valid PNG. The native diffusion executable is the sole controlled
// boundary in this test; all Off Grid ownership, persistence and rendering remains real.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAv0lEQVR4nO3ZsQnDQADFUDc3rBbKvOkDcRPCd/HgJhD68tm+zivnfIdwoXNuFQEogPplJQwKoBjU/x41JhZAMSgTa3Wh1aAAikGZWBrUM78riHQAxaBMLA1q3mORDqAYlIk1746LYgDFoEyseYC8rAZQDMrE0qDmMRbpAIpBmVjz6LgoBlAMysR6yPFnNYBiUCaWBjXvsUgHUAzKxJp3x0UxgGJQJtY8QF5WAygGZWJpUPMYi3QAxaBMrHl0Ps4bguphafFRYPAAAAAASUVORK5CYII=',
  'base64'
)

if (logPath) {
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ event: 'start', pid: process.pid, args: process.argv.slice(2) })}\n`
  )
}

process.stderr.write('seed 93\n')
for (let step = 1; step <= 4; step += 1) {
  await sleep(350)
  if (previewPath) {
    fs.mkdirSync(new URL('.', `file://${previewPath}`).pathname, { recursive: true })
    fs.writeFileSync(previewPath, png)
  }
  process.stderr.write(`${step}/4 - 0.35s/it\n`)
}

fs.mkdirSync(new URL('.', `file://${outputPath}`).pathname, { recursive: true })
fs.writeFileSync(outputPath, png)
if (logPath)
  fs.appendFileSync(logPath, `${JSON.stringify({ event: 'complete', pid: process.pid })}\n`)
