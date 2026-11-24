import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyEngineFloors } from '../../../scripts/engine-floors.mjs'
import { enginesToInstall, parseEngineIndex } from '../engine-updates'

// An engine that moves with app code gets a floor in its pin; staging and publishing carry it into
// the signed index; an older app then skips it. Staging and publishing run as the real scripts
// (publish with --dry-run, which prints the release instead of uploading it).
const root = path.resolve(__dirname, '../../..')
const repoPins = JSON.parse(fs.readFileSync(path.join(root, 'resources/engine-pins.json'), 'utf8'))
const basePins = { ...repoPins, llama: { ...repoPins.llama, ref: 'b100' } }
const headPins = { ...repoPins, llama: { ...repoPins.llama, ref: 'b200' } }
delete basePins.llama.minApp
delete headPins.llama.minApp

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Stage the Linux llama engine from these pins and publish it (dry run): the release the index gets. */
function publishedLlama(pins: object): unknown {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-floors-'))
  temps.push(work)
  fs.mkdirSync(path.join(work, 'bin/llama'), { recursive: true })
  fs.writeFileSync(path.join(work, 'bin/llama/llama-server'), 'server', { mode: 0o755 })
  fs.writeFileSync(path.join(work, 'pins.json'), JSON.stringify(pins))
  const node = (...args: string[]): string =>
    execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  node(
    'scripts/stage-engines.mjs',
    ...['--platform', 'linux', '--bin', path.join(work, 'bin'), '--out', path.join(work, 'out')],
    ...['--pins', path.join(work, 'pins.json')]
  )
  const out = node(
    'scripts/publish-engine.mjs',
    ...['--platform', 'linux', '--dir', path.join(work, 'out/llama'), '--dry-run']
  )
  return JSON.parse(out.slice(out.indexOf('{')))
}

describe('engine floors', () => {
  it('floors an engine that moved with app code, and the published index carries it', () => {
    const { pins, floors } = applyEngineFloors({
      basePins,
      headPins,
      changedFiles: ['resources/engine-pins.json', 'src/main/llama-server-args.ts'],
      appVersion: '0.0.70'
    })
    expect(floors).toEqual({ llama: '0.0.70' })
    expect(publishedLlama(pins)).toMatchObject({
      id: 'llama',
      version: 'b200',
      minAppVersion: '0.0.70'
    })
  })

  it('publishes a pins-only bump with no floor', () => {
    const { pins, floors } = applyEngineFloors({
      basePins,
      headPins,
      changedFiles: ['resources/engine-pins.json'],
      appVersion: '0.0.70'
    })
    expect(floors).toEqual({})
    expect(publishedLlama(pins)).not.toHaveProperty('minAppVersion')
  })

  it('does not count a test file as app code', () => {
    const { floors } = applyEngineFloors({
      basePins,
      headPins,
      changedFiles: ['resources/engine-pins.json', 'src/shared/__tests__/engine-floors.test.ts'],
      appVersion: '0.0.70'
    })
    expect(floors).toEqual({})
  })

  it('keeps an existing floor through a later pins-only bump', () => {
    const floored = { ...headPins, llama: { ...headPins.llama, minApp: '0.0.70' } }
    const next = { ...floored, llama: { ...floored.llama, ref: 'b300' } }
    const { pins } = applyEngineFloors({
      basePins: floored,
      headPins: next,
      changedFiles: ['resources/engine-pins.json'],
      appVersion: '0.0.71'
    })
    expect(pins.llama?.minApp).toBe('0.0.70')
  })

  it('an older app skips the floored engine; the floor version and newer install it', () => {
    const { pins } = applyEngineFloors({
      basePins,
      headPins,
      changedFiles: ['src/main/llama-server-args.ts'],
      appVersion: '0.0.70'
    })
    const index = parseEngineIndex(
      { schemaVersion: 1, platform: 'linux', engines: [publishedLlama(pins)] },
      'linux'
    )
    expect(index).not.toBeNull()
    const ids = (appVersion: string): string[] =>
      enginesToInstall(index!, {}, appVersion, { nvidia: false }).map((engine) => engine.id)
    expect(ids('0.0.69')).toEqual([])
    expect(ids('0.0.70')).toEqual(['llama'])
    expect(ids('0.0.71')).toEqual(['llama'])
  })
})
