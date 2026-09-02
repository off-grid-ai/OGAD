import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeModelDownloadPorts } from '../node-artifact-download-adapter'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

describe('Node model artifact file adapter', () => {
  it('projects filesystem integrity and removes final and resumable artifacts', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-artifact-port-'))
    temporaryDirectories.push(directory)
    const ports = createNodeModelDownloadPorts(directory)
    const destination = ports.files.pathFor('model.gguf')
    const contents = Buffer.from('verified model artifact')
    fs.writeFileSync(destination, contents)
    fs.writeFileSync(`${destination}.part`, Buffer.from('partial model artifact'))
    const readPrefix = ports.files.readPrefix
    const sha256 = ports.files.sha256
    expect(readPrefix).toBeTypeOf('function')
    expect(sha256).toBeTypeOf('function')
    if (!readPrefix || !sha256) throw new Error('Node artifact integrity ports are unavailable')

    await expect(ports.files.exists(destination)).resolves.toBe(true)
    await expect(ports.files.size(destination)).resolves.toBe(contents.length)
    await expect(readPrefix(destination, 8)).resolves.toEqual(contents.subarray(0, 8))
    await expect(sha256(destination)).resolves.toBe(
      createHash('sha256').update(contents).digest('hex')
    )

    await ports.files.remove(destination)
    await expect(ports.files.exists(destination)).resolves.toBe(false)
    await expect(ports.files.exists(`${destination}.part`)).resolves.toBe(false)
    await expect(ports.files.size(destination)).resolves.toBe(0)
  })
})
