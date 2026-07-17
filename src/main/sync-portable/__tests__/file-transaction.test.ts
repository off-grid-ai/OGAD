import { createHash } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileTransaction } from '../file-transaction'

const roots: string[] = []
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

async function paths(): Promise<{ root: string; staged: string; destination: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offgrid-file-transaction-'))
  roots.push(root)
  return { root, staged: path.join(root, 'staged'), destination: path.join(root, 'destination') }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileTransaction collision policies', () => {
  it('reuses only byte-identical files under keep-existing', async () => {
    const files = await paths()
    await writeFile(files.staged, 'same')
    await writeFile(files.destination, 'same')
    const transaction = await FileTransaction.create(
      [
        {
          key: 'file',
          stagedPath: files.staged,
          destinationPath: files.destination,
          size: 4,
          sha256: hash('same')
        }
      ],
      'keep-existing'
    )
    transaction.apply()
    expect(transaction.paths().get('file')).toBe(files.destination)
    expect(await readFile(files.destination, 'utf8')).toBe('same')

    await writeFile(files.destination, 'different')
    await expect(
      FileTransaction.create(
        [
          {
            key: 'file',
            stagedPath: files.staged,
            destinationPath: files.destination,
            size: 4,
            sha256: hash('same')
          }
        ],
        'keep-existing'
      )
    ).rejects.toThrow('conflicts')
  })

  it('duplicates without overwriting and restores replacements on rollback', async () => {
    const duplicate = await paths()
    await writeFile(duplicate.staged, 'new')
    await writeFile(duplicate.destination, 'old')
    const duplicateTransaction = await FileTransaction.create(
      [
        {
          key: 'file',
          stagedPath: duplicate.staged,
          destinationPath: duplicate.destination,
          size: 3,
          sha256: hash('new')
        }
      ],
      'duplicate'
    )
    duplicateTransaction.apply()
    expect(duplicateTransaction.paths().get('file')).not.toBe(duplicate.destination)
    expect(await readFile(duplicate.destination, 'utf8')).toBe('old')

    const replacement = await paths()
    await writeFile(replacement.staged, 'new')
    await writeFile(replacement.destination, 'old')
    const replacementTransaction = await FileTransaction.create(
      [
        {
          key: 'file',
          stagedPath: replacement.staged,
          destinationPath: replacement.destination,
          size: 3,
          sha256: hash('new')
        }
      ],
      'replace-existing'
    )
    replacementTransaction.apply()
    expect(() => replacementTransaction.rollback(new Error('database failed'))).toThrow(
      'database failed'
    )
    expect(await readFile(replacement.destination, 'utf8')).toBe('old')
    expect(await readFile(replacement.staged, 'utf8')).toBe('new')
  })

  it('rejects collisions before changing either file', async () => {
    const files = await paths()
    await writeFile(files.staged, 'new')
    await writeFile(files.destination, 'old')
    await expect(
      FileTransaction.create(
        [
          {
            key: 'file',
            stagedPath: files.staged,
            destinationPath: files.destination,
            size: 3,
            sha256: hash('new')
          }
        ],
        'reject'
      )
    ).rejects.toThrow('already exists')
    expect(await readFile(files.destination, 'utf8')).toBe('old')
    expect(await readFile(files.staged, 'utf8')).toBe('new')
  })
})
