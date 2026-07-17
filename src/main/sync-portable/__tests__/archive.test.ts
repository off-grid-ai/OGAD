import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopArchivePort } from '../archive'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offgrid-portable-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DesktopArchivePort', () => {
  it('packs, inspects, reads, and allowlist-extracts a real ZIP', async () => {
    const root = await temporaryRoot()
    const port = new DesktopArchivePort(root)
    const stage = await port.stageDir()
    await port.writeText(port.join(stage, 'manifest.json'), '{"schemaVersion":1}')
    await port.writeText(port.join(stage, 'files', 'note.txt'), 'private workspace data')

    const archive = await port.pack(stage, 'off-grid-ai-workspace.zip')
    const entries = await port.listEntries(archive)
    expect(entries.find(({ key }) => key === 'files/note.txt')).toMatchObject({
      type: 'file',
      size: 22
    })
    expect(await port.readEntryText(archive, 'manifest.json', 128)).toBe('{"schemaVersion":1}')
    await expect(port.readEntryText(archive, 'manifest.json', 4)).rejects.toThrow('too large')

    const extraction = await port.stageDir()
    await port.extractEntries(archive, extraction, ['files/note.txt'])
    expect(await readFile(path.join(extraction, 'files', 'note.txt'), 'utf8')).toBe(
      'private workspace data'
    )
    await expect(readFile(path.join(extraction, 'manifest.json'))).rejects.toThrow()
  })

  it('rejects unsafe entries before extraction and detects Unix symbolic links', async () => {
    const root = await temporaryRoot()
    const port = new DesktopArchivePort(root)
    const zip = new JSZip()
    zip.file('../escape.txt', 'nope')
    zip.file('link', 'target', { createFolders: false, unixPermissions: 0o120777 })
    const archive = path.join(root, 'hostile.zip')
    await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))

    await expect(port.listEntries(archive)).rejects.toThrow()
  })

  it('refuses cleanup and writes outside its owned temporary roots', async () => {
    const root = await temporaryRoot()
    const outside = path.join(root, 'keep.txt')
    const port = new DesktopArchivePort(root)
    await writeFile(outside, 'keep')

    await expect(port.removeDir(root)).rejects.toThrow('portable workspace storage')
    await expect(port.removeFile(outside)).rejects.toThrow('portable workspace storage')
    await expect(port.copyInto(outside, path.join(root, 'copied.txt'))).rejects.toThrow(
      'portable workspace storage'
    )
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it('rejects corrupt and truncated central directories without hanging later reads', async () => {
    const root = await temporaryRoot()
    const port = new DesktopArchivePort(root)
    const corrupt = path.join(root, 'corrupt.zip')
    await writeFile(corrupt, Buffer.from('not a zip archive'))
    await expect(port.listEntries(corrupt)).rejects.toThrow()

    const valid = await new JSZip()
      .file('manifest.json', '{}')
      .generateAsync({ type: 'nodebuffer' })
    const truncated = path.join(root, 'truncated.zip')
    await writeFile(truncated, valid.subarray(0, valid.length - 12))
    await expect(port.listEntries(truncated)).rejects.toThrow()
    await expect(port.readEntryText(truncated, 'manifest.json', 100)).rejects.toThrow()
  })
})
