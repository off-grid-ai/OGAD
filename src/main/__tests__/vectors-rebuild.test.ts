import { afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'og-vector-rebuild-'))
process.env.OFFGRID_VECTOR_REBUILD_TEST_DIR = profile
vi.mock('electron', () => ({ app: { getPath: () => process.env.OFFGRID_VECTOR_REBUILD_TEST_DIR } }))
import {
  abortVectorRebuild,
  addChunks,
  beginVectorRebuild,
  commitVectorRebuild,
  finishVectorRebuild,
  searchVectors
} from '../vectors'

afterAll(() => {
  fs.rmSync(profile, { recursive: true, force: true })
  delete process.env.OFFGRID_VECTOR_REBUILD_TEST_DIR
})

function row(key: string, vector: number[]): Parameters<typeof addChunks>[0][number] {
  return { key, kind: 'memory', refId: 1, vector, text: key, surface: '', url: '', ts: 1 }
}

it('keeps old search vectors until commit and restores them after an aborted rebuild', async () => {
  await addChunks([row('old', [1, 0])])
  await beginVectorRebuild()
  await addChunks([row('new', [0, 1])])
  expect((await searchVectors([1, 0], 1))[0]?.key).toBe('old')
  await abortVectorRebuild()
  expect((await searchVectors([1, 0], 1))[0]?.key).toBe('old')

  await beginVectorRebuild()
  await addChunks([row('new', [0, 1])])
  await commitVectorRebuild()
  expect((await searchVectors([0, 1], 1))[0]?.key).toBe('new')
  await abortVectorRebuild()
  expect((await searchVectors([1, 0], 1))[0]?.key).toBe('old')

  await beginVectorRebuild()
  await addChunks([row('new', [0, 1])])
  await commitVectorRebuild()
  await finishVectorRebuild()
  expect((await searchVectors([0, 1], 1))[0]?.key).toBe('new')
})
