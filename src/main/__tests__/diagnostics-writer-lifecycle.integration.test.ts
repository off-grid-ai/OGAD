/**
 * Real diagnostic-file lifecycle through the production writer. The temporary filesystem is the
 * real Node boundary: no Off Grid module or storage behavior is replaced.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDiagnosticWriter } from '../diagnostics-writer'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-diagnostics-writer-'))

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('diagnostic writer file lifecycle', () => {
  it('keeps writes private, rotates a full log, and follows a changed destination', async () => {
    let destination = path.join(root, 'first', 'desktop.log')
    const failures: string[] = []
    const writer = createDiagnosticWriter({
      resolvePath: () => destination,
      maxLogBytes: 5,
      maxBufferedRecords: 10,
      maxBufferedBytes: 1_000,
      reportFailure: (message) => failures.push(message)
    })

    writer.append('first record')
    await writer.flush()
    expect(fs.readFileSync(destination, 'utf8')).toBe('first record\n')
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600)

    writer.append('second record')
    await writer.flush()
    expect(fs.readFileSync(`${destination}.previous`, 'utf8')).toBe('first record\n')
    expect(fs.readFileSync(destination, 'utf8')).toBe('second record\n')

    destination = path.join(root, 'second', 'desktop.log')
    writer.append('new destination')
    await writer.close()
    await writer.close()
    writer.append('ignored after close')

    expect(fs.readFileSync(destination, 'utf8')).toBe('new destination\n')
    expect(writer.stats()).toEqual({
      bufferedRecords: 0,
      bufferedBytes: 0,
      droppedRecords: 0,
      writeFailures: 0
    })
    expect(failures).toEqual([])
  })
})
