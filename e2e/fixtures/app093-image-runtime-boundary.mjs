#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const outputFlag = process.argv.indexOf('-o')
const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined
const previewFlag = process.argv.indexOf('--preview-path')
const previewPath = previewFlag >= 0 ? process.argv[previewFlag + 1] : undefined
const logPath = process.env.APP093_IMAGE_RUNTIME_LOG
const promptFlag = process.argv.findIndex((arg) => arg === '-p' || arg === '--prompt')
const prompt = promptFlag < 0 ? '' : process.argv[promptFlag + 1]
const audit = (event) => {
  if (logPath)
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ event, pid: process.pid, prompt, args: process.argv.slice(2) })}\n`
    )
}

if (!outputPath) {
  process.stderr.write('app093 boundary: missing -o output path\n')
  process.exit(2)
}

// A real, checksum-valid PNG. The native diffusion executable is the sole controlled
// boundary in this test; all Off Grid AI ownership, persistence and rendering remains real.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAv0lEQVR4nO3ZsQnDQADFUDc3rBbKvOkDcRPCd/HgJhD68tm+zivnfIdwoXNuFQEogPplJQwKoBjU/x41JhZAMSgTa3Wh1aAAikGZWBrUM78riHQAxaBMLA1q3mORDqAYlIk1746LYgDFoEyseYC8rAZQDMrE0qDmMRbpAIpBmVjz6LgoBlAMysR6yPFnNYBiUCaWBjXvsUgHUAzKxJp3x0UxgGJQJtY8QF5WAygGZWJpUPMYi3QAxaBMrHl0Ps4bguphafFRYPAAAAAASUVORK5CYII=',
  'base64'
)

audit('start')

process.stderr.write('seed 93\n')
// Hold only this external process so the UI can queue and interrupt a real image job.
if (prompt === 'Hold this image for Send Now APP093') await sleep(30_000)
if (prompt === 'Finish this image after reopen APP093') await sleep(10_000)
for (let step = 1; step <= 4; step += 1) {
  await sleep(350)
  if (previewPath) {
    fs.mkdirSync(new URL('.', `file://${previewPath}`).pathname, { recursive: true })
    fs.writeFileSync(previewPath, png)
  }
  process.stderr.write(`${step}/4 - 0.35s/it\n`)
  audit(`progress:${step}`)
}

fs.mkdirSync(new URL('.', `file://${outputPath}`).pathname, { recursive: true })
fs.writeFileSync(outputPath, png)
audit('complete')
