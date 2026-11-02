// CI's vitest shards, balanced by run time (scripts/config/vitest-duration-sequencer.ts), and the
// run times they are balanced by (scripts/update-vitest-timings.mjs).
//
// SPEC: every file is placed, once, on the shard with the least time so far, longest first. A file's
// time is its recorded test time plus the import and setup every file pays, or an estimate from its
// size when it has no record. The timings file is rewritten from the json results the shards save.
//
// Real files on disk, and the real update script run as a maintainer runs it.
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestSpecification } from 'vitest/node'
import {
  balance,
  DurationSequencer,
  fileSeconds,
  readTimings,
  TIMINGS_FILE
} from '../../../scripts/config/vitest-duration-sequencer'

const UPDATE = resolve(__dirname, '../../../scripts/update-vitest-timings.mjs')

function files(sizes: Record<string, number>): { root: string; paths: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vitest-sequencer-')))
  const paths = Object.entries(sizes).map(([name, size]) => {
    const path = join(root, 'src', name)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(path, 'x'.repeat(size))
    return path
  })
  return { root, paths }
}

describe('vitest duration sequencer', () => {
  it('splits by recorded time, not by count', () => {
    const { root, paths } = files({
      'slow.test.ts': 10,
      'a.test.ts': 10,
      'b.test.ts': 10,
      'c.test.ts': 10
    })
    const timings = {
      'src/slow.test.ts': 30,
      'src/a.test.ts': 10,
      'src/b.test.ts': 10,
      'src/c.test.ts': 10
    }

    const shards = balance(
      paths,
      2,
      (path) => fileSeconds(path, root, timings),
      (path) => path
    )

    expect(shards.map((shard) => shard.map((path) => basename(path)).sort())).toEqual([
      ['slow.test.ts'],
      ['a.test.ts', 'b.test.ts', 'c.test.ts']
    ])
  })

  it('adds the per-file cost to a recorded time, and estimates an unrecorded file from its size', () => {
    const {
      root,
      paths: [recorded, unrecorded]
    } = files({ 'recorded.test.ts': 10, 'new.test.ts': 7000 })

    expect(fileSeconds(recorded!, root, { 'src/recorded.test.ts': 4 })).toBe(5.25)
    expect(fileSeconds(unrecorded!, root, {})).toBe(3.25)
  })

  it('places every file once, the same way every time', () => {
    const { root, paths } = files({
      'a.test.ts': 100,
      'b.test.ts': 100,
      'c.test.ts': 100,
      'd.test.ts': 100
    })
    const split = (input: string[]): string[][] =>
      balance(
        input,
        3,
        (path) => fileSeconds(path, root, {}),
        (path) => path
      ).map((shard) => shard.map((path) => basename(path)).sort())

    expect(split([...paths].reverse())).toEqual(split(paths))
    expect(split(paths).flat().sort()).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'])
  })

  it('gives the requested shard its files, from the committed timings', async () => {
    const { root, paths } = files({ 'a.test.ts': 10, 'b.test.ts': 20 })
    const specs = paths.map((moduleId) => ({ moduleId, project: { name: 'product-integration' } }))
    const shardOf = (index: number): Promise<TestSpecification[]> =>
      new DurationSequencer({ config: { root, shard: { index, count: 2 } } } as never).shard(
        specs as unknown as TestSpecification[]
      )

    const all = [...(await shardOf(1)), ...(await shardOf(2))]

    expect(all.map((spec) => basename(spec.moduleId)).sort()).toEqual(['a.test.ts', 'b.test.ts'])
  })

  it('reads no timings from a file that is not there', () => {
    expect(readTimings(join(tmpdir(), 'no-such-vitest-timings.json'))).toEqual({})
  })
})

describe('update-vitest-timings', () => {
  let committed: string
  beforeEach(() => {
    committed = readFileSync(TIMINGS_FILE, 'utf8')
  })
  afterEach(() => {
    writeFileSync(TIMINGS_FILE, committed)
  })

  function results(root: string, shard: string, ran: Array<[string, number]>): void {
    const dir = join(root, 'results', shard)
    mkdirSync(dir, { recursive: true })
    const testResults = ran.map(([name, ms]) => ({
      name: join(root, name),
      startTime: 1000,
      endTime: 1000 + ms
    }))
    writeFileSync(join(dir, 'vitest-results.json'), JSON.stringify({ testResults }))
  }

  it('records every file of every shard, in seconds, keyed by its path', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'vitest-timings-')))
    results(root, 'vitest-results-1', [['src/b.test.ts', 12345]])
    results(root, 'vitest-results-2', [['src/a.test.ts', 870]])

    const run = spawnSync('node', [UPDATE, 'results'], { cwd: root, encoding: 'utf8' })

    expect(run.stdout).toContain('Recorded the run times of 2 test files.')
    expect(run.status).toBe(0)
    expect(readFileSync(TIMINGS_FILE, 'utf8')).toBe(
      '{\n  "src/a.test.ts": 0.9,\n  "src/b.test.ts": 12.3\n}\n'
    )
  })

  it('fails, and keeps the timings, when there are no results', () => {
    const root = mkdtempSync(join(tmpdir(), 'vitest-timings-'))
    mkdirSync(join(root, 'results'))

    const run = spawnSync('node', [UPDATE, 'results'], { cwd: root, encoding: 'utf8' })

    expect(run.stderr).toContain('no vitest results under results')
    expect(run.status).toBe(1)
    expect(readFileSync(TIMINGS_FILE, 'utf8')).toBe(committed)
  })

  it('fails without a directory to read', () => {
    const run = spawnSync('node', [UPDATE], { encoding: 'utf8' })

    expect(run.stderr).toContain('usage: update-vitest-timings.mjs')
    expect(run.status).toBe(1)
  })
})
