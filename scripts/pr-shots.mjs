#!/usr/bin/env node
// Retake the PR screens for a set of screens, light mode, into docs/pr-screenshots/<branch>/.
//
//   npm run shots -- --list                 what sets there are
//   npm run shots -- video before           the screens as they are now
//   npm run shots -- video after            the same screens after the change
//   npm run shots -- video after --no-build skip the rebuild (the build is already current)
//   npm run shots -- video after --upload   also put them on the PR, once you have looked
//
// A set is one Playwright spec that drives the real app and screenshots each screen. The phase
// ("before" or "after") reaches the spec as VIDEO_SHOTS and only changes the file name suffix,
// so a pair is comparable. Every shot it could not reach is named at the end, with why.
//
// --upload hands the new screens to the release PR through the Contents API ([skip ci], no code
// pushed). It is opt-in because the standard is to LOOK at a screen before it goes up.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Each set: the Playwright config and spec that take its screens, and what they cover. */
const SETS = {
  video: {
    config: 'pro/e2e/playwright.config.ts',
    grep: 'video-screens',
    covers:
      'Video home, making, watch (with the player), your videos, the shot editor, character, and the clip and film cards in chat'
  }
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const positional = args.filter((arg) => !arg.startsWith('--'))
const [name, phase = 'after'] = positional

const branch =
  spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).stdout?.trim() ?? ''
const shotDir = path.join(root, 'docs/pr-screenshots', branch)

if (flag('list') || !name) {
  console.log('Screen sets:')
  for (const [key, set] of Object.entries(SETS)) console.log(`  ${key.padEnd(8)} ${set.covers}`)
  console.log(`\nUsage: npm run shots -- <set> <before|after>\nInto:  ${shotDir}`)
  process.exit(flag('list') ? 0 : 1)
}

const set = SETS[name]
if (!set) {
  console.error(`No screen set called "${name}". Try: ${Object.keys(SETS).join(', ')}`)
  process.exit(1)
}
if (phase !== 'before' && phase !== 'after') {
  console.error(`The phase is "before" or "after", not "${phase}".`)
  process.exit(1)
}

const run = (command, commandArgs, env) =>
  spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })

if (!flag('no-build')) {
  console.log('Building, so the screens come from the code as it is now…')
  const built = run('npx', ['electron-vite', 'build'])
  if (built.status !== 0) process.exit(built.status ?? 1)
}

const before = new Set(fs.existsSync(shotDir) ? fs.readdirSync(shotDir) : [])
const result = run('npx', ['playwright', 'test', '-c', set.config, set.grep], {
  VIDEO_SHOTS: phase
})

const taken = (fs.existsSync(shotDir) ? fs.readdirSync(shotDir) : []).filter(
  (file) => file.endsWith(`-${phase}.png`) && !before.has(file)
)
console.log(`\n${taken.length} new screen${taken.length === 1 ? '' : 's'} in ${shotDir}`)
for (const file of taken) console.log(`  ${file}`)
if (result.status !== 0)
  console.log('\nSome screens were not reached — the run above names each one and why.')

if (flag('upload') && taken.length) {
  const pr = JSON.parse(
    spawnSync(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'number,headRepository', '--limit', '1'],
      {
        cwd: root,
        encoding: 'utf8'
      }
    ).stdout || '[]'
  )[0]
  if (!pr) {
    console.log(`\nNo open PR for ${branch}, so nothing was uploaded.`)
  } else {
    const repo =
      spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
        cwd: root,
        encoding: 'utf8'
      }).stdout?.trim() ?? ''
    console.log(`\nPutting them on ${repo}#${pr.number}…`)
    run('python3', [
      '-I',
      path.join(process.env.HOME ?? '', '.claude/skills/hand-test/scripts/pr_shots.py'),
      root,
      repo,
      String(pr.number),
      ...taken
    ])
  }
} else if (taken.length) {
  console.log('\nLook at them, then run the same command with --upload to put them on the PR.')
}
process.exit(result.status ?? 1)
