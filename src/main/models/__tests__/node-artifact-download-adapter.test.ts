import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../gguf'
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

  it('reports stopped, completed, and missing transfer facts without guessing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-artifact-stop-'))
    temporaryDirectories.push(directory)
    const ports = createNodeModelDownloadPorts(directory)
    const controller = new AbortController()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        const abort = (): void => {
          reject(new DOMException('Aborted', 'AbortError'))
        }
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    )
    try {
      const active = ports.transfers.start({
        id: 'active',
        url: 'https://example.invalid/model.bin',
        destination: ports.files.pathFor('active.bin'),
        resume: false,
        signal: controller.signal,
        onProgress: () => undefined
      })

      await expect(ports.transfers.stop?.({
        transferId: 'active',
        disposition: 'retain-partial'
      })).resolves.toEqual({ outcome: 'stopped' })
      controller.abort()
      await expect(active).rejects.toMatchObject({ name: 'DownloadAbortedError' })
      await expect(ports.transfers.stop?.({
        transferId: 'active',
        disposition: 'retain-partial'
      })).resolves.toEqual({ outcome: 'not-found' })
    } finally {
      fetchSpy.mockRestore()
    }

    await ports.transfers.start({
      id: 'completed',
      url: 'data:application/octet-stream;base64,QUJDRA==',
      destination: ports.files.pathFor('completed.bin'),
      resume: false,
      signal: new AbortController().signal,
      onProgress: () => undefined
    })
    await expect(ports.transfers.stop?.({
      transferId: 'completed',
      disposition: 'delete-partial'
    })).resolves.toEqual({ outcome: 'completed' })
    // A consumed completion is forgotten: the same id does not answer `completed` twice.
    await expect(ports.transfers.stop?.({
      transferId: 'completed',
      disposition: 'delete-partial'
    })).resolves.toEqual({ outcome: 'not-found' })
  })

  /**
   * A fake network that delivers `firstChunk`, then holds the body open until the signal aborts -
   * the shape of a person cancelling while bytes are moving. Only `fetch` is faked; the `.part`
   * lands on the real temp filesystem.
   */
  function fakeStreamingFetch(firstChunk: Buffer): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(firstChunk))
          const abort = (): void => controller.error(new DOMException('Aborted', 'AbortError'))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        }
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
  }

  async function stopMidTransfer(
    directory: string,
    disposition: 'retain-partial' | 'delete-partial'
  ): Promise<string> {
    const ports = createNodeModelDownloadPorts(directory)
    const destination = ports.files.pathFor(`${disposition}.bin`)
    const controller = new AbortController()
    const fetchSpy = fakeStreamingFetch(Buffer.from('partial bytes already on disk'))
    try {
      let progressed!: () => void
      const firstProgress = new Promise<void>((resolve) => {
        progressed = resolve
      })
      const active = ports.transfers.start({
        id: disposition,
        url: 'https://example.invalid/model.bin',
        destination,
        resume: false,
        signal: controller.signal,
        onProgress: () => progressed()
      })
      await firstProgress
      await expect(ports.transfers.stop?.({ transferId: disposition, disposition }))
        .resolves.toEqual({ outcome: 'stopped' })
      controller.abort()
      await expect(active).rejects.toMatchObject({ name: 'DownloadAbortedError' })
    } finally {
      fetchSpy.mockRestore()
    }
    return destination
  }

  it('retain-partial keeps the interrupted .part on disk for a later resume', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-artifact-retain-'))
    temporaryDirectories.push(directory)
    const destination = await stopMidTransfer(directory, 'retain-partial')
    expect(fs.existsSync(`${destination}.part`)).toBe(true)
    expect(fs.readFileSync(`${destination}.part`, 'utf8')).toBe('partial bytes already on disk')
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('delete-partial removes the interrupted .part once the transfer has settled', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-artifact-delete-'))
    temporaryDirectories.push(directory)
    const destination = await stopMidTransfer(directory, 'delete-partial')
    expect(fs.existsSync(`${destination}.part`)).toBe(false)
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('bounds the completed-transfer memory so unconsumed completions do not leak', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-artifact-memory-'))
    temporaryDirectories.push(directory)
    const ports = createNodeModelDownloadPorts(directory)
    const memory = 64
    const ids = Array.from({ length: memory + 1 }, (_value, index) => `completed-${index}`)
    for (const id of ids) {
      await ports.transfers.start({
        id,
        url: 'data:application/octet-stream;base64,QUJDRA==',
        destination: ports.files.pathFor(`${id}.bin`),
        resume: false,
        signal: new AbortController().signal,
        onProgress: () => undefined
      })
    }
    // The oldest unconsumed completion was evicted once the memory overflowed by one...
    await expect(ports.transfers.stop?.({ transferId: `completed-0`, disposition: 'retain-partial' }))
      .resolves.toEqual({ outcome: 'not-found' })
    // ...while every completion still inside the window answers `completed` exactly once.
    await expect(ports.transfers.stop?.({ transferId: `completed-1`, disposition: 'retain-partial' }))
      .resolves.toEqual({ outcome: 'completed' })
    await expect(ports.transfers.stop?.({ transferId: `completed-${memory}`, disposition: 'retain-partial' }))
      .resolves.toEqual({ outcome: 'completed' })
  })
})
