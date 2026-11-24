#!/usr/bin/env node
// Give an engine a floor (`minApp` in resources/engine-pins.json) when its new version needs new app code.
//
//   node scripts/engine-floors.mjs --base <git ref> [--write]
//
// Compares the pins at <base> with the working tree. An engine whose ref moved in a change that also
// touches app code (APP_CODE below: launch flags, the engine runner, the app itself) needs that app, so
// it gets `minApp` = package.json's version, the version that ships with the change (stable ships it
// as-is). A pins-only bump adds no floor and keeps an existing one: an engine past a floor still needs
// the app code that set it. scripts/stage-engines.mjs copies `minApp` into each engine.json and
// scripts/publish-engine.mjs signs it into the index as minAppVersion, which older apps skip
// (enginesToInstall in src/shared/engine-updates.ts).
//
// Without --write it prints what it would set and exits 1 when a floor is missing, for a PR check.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** Engines the app downloads as updates; the rest ship only inside an installer. */
export const UPDATABLE_ENGINES = ['llama', 'prism', 'sd', 'whisper']

/** Paths whose change means an engine moving in the same diff may need this app version. */
const APP_CODE = [/^src\//, /^native\//, /^pro$/]

export const isAppCode = (file) => APP_CODE.some((pattern) => pattern.test(file))

/**
 * The pins with a floor on every engine whose ref moved alongside app code.
 * @returns {{ pins: object, floors: Record<string, string> }} floors: engine -> the minApp it gained
 */
export function applyEngineFloors({ basePins, headPins, changedFiles, appVersion }) {
  const pins = structuredClone(headPins)
  const floors = {}
  if (!changedFiles.some(isAppCode)) return { pins, floors }
  for (const engine of UPDATABLE_ENGINES) {
    const pin = pins[engine]
    if (!pin || pin.ref === basePins[engine]?.ref || pin.minApp === appVersion) continue
    pin.minApp = appVersion
    floors[engine] = appVersion
  }
  return { pins, floors }
}

function main() {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, write: { type: 'boolean', default: false } }
  })
  if (!values.base) {
    console.error('Usage: engine-floors.mjs --base <git ref> [--write]')
    process.exit(1)
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const pinsFile = path.join(root, 'resources/engine-pins.json')
  const { pins, floors } = applyEngineFloors({
    basePins: JSON.parse(git('show', `${values.base}:resources/engine-pins.json`)),
    headPins: JSON.parse(fs.readFileSync(pinsFile, 'utf8')),
    // Committed changes since the base, plus any not committed yet.
    changedFiles: [
      ...git('diff', '--name-only', `${values.base}...HEAD`).split('\n'),
      ...git('diff', '--name-only', 'HEAD').split('\n')
    ].filter(Boolean),
    appVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  })
  const engines = Object.keys(floors)
  if (!engines.length) {
    console.log('No engine needs a new floor.')
    return
  }
  for (const engine of engines) console.log(`${engine}: minApp ${floors[engine]}`)
  if (values.write) fs.writeFileSync(pinsFile, `${JSON.stringify(pins, null, 2)}\n`)
  else {
    console.error(
      'These engines moved with app code. Run: node scripts/engine-floors.mjs --base <base> --write'
    )
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
