#!/usr/bin/env node
import path from 'node:path'
import { cp, mkdir } from 'node:fs/promises'
import { prepareVoice } from '@offgrid/executorch-speech'

const destination = path.resolve('../executorch-speech/generated/default-assets')
const seedCache = process.env.OFFGRID_SPEECH_SEED_CACHE
if (seedCache) {
  await mkdir(destination, { recursive: true })
  await cp(seedCache, destination, { recursive: true, force: false, errorOnExist: false })
}
for (const voice of ['af_heart', 'bf_emma']) {
  let last = -1
  await prepareVoice(destination, voice, ({ percentage }) => {
    if (percentage === null || percentage === last) return
    last = percentage
    process.stdout.write(`\r[speech-assets] ${voice} ${percentage}%`)
  })
  process.stdout.write(`\r[speech-assets] ${voice} ready\n`)
}
