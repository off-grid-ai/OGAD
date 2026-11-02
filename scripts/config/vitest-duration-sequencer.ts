import { existsSync, readFileSync, statSync } from 'fs'
import { relative, resolve, sep } from 'path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// CI runs the product suite in shards (`--shard=i/n`). Vitest's own split gives each shard the same
// NUMBER of files, but a few files take a minute or more while most take well under a second, so
// shards came out uneven. Here each file gets its recorded test time from vitest-timings.json
// (refresh it with scripts/update-vitest-timings.mjs) plus the import and setup every file pays, or,
// for a file with no record yet, an estimate from its size. The longest files are placed first,
// each on the shard with the least time so far. The order within a shard is still Vitest's own.

export const TIMINGS_FILE = resolve(__dirname, 'vitest-timings.json')
// Measured on the hosted runner: import, setup and environment came to about 1.25 s per file
// (1,160 s over 930 files), on top of the time its tests take.
const PER_FILE_SECONDS = 1.25
// A file with no recorded time: the recorded files averaged 1 s of tests per 3.5 KB of source.
const BYTES_PER_SECOND = 3500

export type Timings = Record<string, number>

export function readTimings(file: string = TIMINGS_FILE): Timings {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Timings) : {}
}

export function fileSeconds(path: string, root: string, timings: Timings): number {
  const recorded = timings[relative(root, path).split(sep).join('/')]
  return PER_FILE_SECONDS + (recorded ?? statSync(path).size / BYTES_PER_SECOND)
}

/** Split the files into `count` lists of about equal total time. Same input, same split. */
export function balance<T>(
  files: T[],
  count: number,
  seconds: (file: T) => number,
  key: (file: T) => string
): T[][] {
  const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] as T[] }))
  const timed = files
    .map((file) => ({ file, seconds: seconds(file), key: key(file) }))
    .sort((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : 1))
  for (const { file, seconds: cost } of timed) {
    const lightest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min))
    lightest.files.push(file)
    lightest.seconds += cost
  }
  return shards.map((shard) => shard.files)
}

export class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const root = this.ctx.config.root
    const timings = readTimings()
    const key = (spec: TestSpecification): string => `${spec.project.name}:${spec.moduleId}`
    return (
      balance(files, count, (spec) => fileSeconds(spec.moduleId, root, timings), key)[index - 1] ??
      []
    )
  }
}
