import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BundleError } from '@offgrid/sync/portable'
import { DesktopBackupArchive } from '../archive'

/**
 * Writing a backup to a zip, and reading somebody else's zip back.
 *
 * Everything here is real: real directories, real JSZip, real checksums. The whole job of this class is
 * filesystem behaviour - what it refuses to read, where it agrees to write, what it cleans up when
 * something fails - so faking the filesystem would leave nothing worth asserting.
 *
 * The unpack half is the part that matters most. An archive is untrusted input: an entry name is a path
 * chosen by whoever built the file, and writing it blindly is how a zip escapes its extraction directory.
 */

describe('the backup archive, against a real filesystem', () => {
  let workspace: string
  let userData: string
  let archive: DesktopBackupArchive

  beforeEach(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'offgrid-archive-test-'))
    userData = path.join(workspace, 'userData')
    await fs.promises.mkdir(userData, { recursive: true })
    archive = new DesktopBackupArchive({ tempDir: workspace, userDataDir: userData })
  })

  afterEach(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true })
  })

  const file = async (absPath: string, contents: string): Promise<string> => {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
    await fs.promises.writeFile(absPath, contents)
    return absPath
  }

  describe('staging', () => {
    it('hands out a fresh empty directory each time', async () => {
      const first = await archive.stageDir()
      const second = await archive.stageDir()

      expect(first).not.toBe(second)
      expect(fs.statSync(first).isDirectory()).toBe(true)
      expect(await fs.promises.readdir(first)).toEqual([])
      // Under the configured temp dir, not the OS default - so a test (or a user with a custom location)
      // is not writing into /tmp behind its own back.
      expect(first.startsWith(workspace)).toBe(true)
    })

    it('writes text through directories that do not exist yet, and reads it back', async () => {
      const target = path.join(await archive.stageDir(), 'nested', 'deeper', 'backup.json')

      await archive.writeText(target, '{"surface":"offgrid-desktop"}')

      expect(await archive.readText(target)).toBe('{"surface":"offgrid-desktop"}')
    })

    it('joins paths for callers that should not know the platform separator', () => {
      expect(archive.join('a', 'b', 'c.txt')).toBe(path.join('a', 'b', 'c.txt'))
    })
  })

  describe('copying a document into the bundle', () => {
    it('copies the file and creates the directories on the way', async () => {
      const source = await file(path.join(workspace, 'src', 'Contract.pdf'), 'contract bytes')
      const destination = path.join(await archive.stageDir(), 'files', 'documents', 'p1', '0-a.pdf')

      await archive.copyInto(source, destination)

      expect(await fs.promises.readFile(destination, 'utf8')).toBe('contract bytes')
    })

    it('is content-addressed enough to be safe to repeat', async () => {
      const source = await file(path.join(workspace, 'src', 'Contract.pdf'), 'contract bytes')
      const destination = path.join(await archive.stageDir(), 'files', 'a.pdf')
      await archive.copyInto(source, destination)

      // The same file arriving twice is normal - two projects can reference one document. It must not
      // fail, and it must not rewrite: a size AND checksum match means the work is already done.
      await expect(archive.copyInto(source, destination)).resolves.toBeUndefined()
      expect(await fs.promises.readFile(destination, 'utf8')).toBe('contract bytes')
    })

    it('refuses to overwrite a different file that already sits at the destination', async () => {
      const source = await file(path.join(workspace, 'src', 'Contract.pdf'), 'the real contract')
      const destination = await file(path.join(workspace, 'stage', 'files', 'a.pdf'), 'something else')

      // Same path, different content. Overwriting would destroy a file the user already had; the size
      // check alone would not catch a same-length substitution, which is why the checksum is compared.
      await expect(archive.copyInto(source, destination)).rejects.toThrow(BundleError)
      await expect(archive.copyInto(source, destination)).rejects.toThrow(
        'A different file already exists at a backup restore path.'
      )
      expect(await fs.promises.readFile(destination, 'utf8')).toBe('something else')
    })

    it('notices a same-size file whose contents differ', async () => {
      const source = await file(path.join(workspace, 'src', 'a.bin'), 'AAAA')
      const destination = await file(path.join(workspace, 'stage', 'a.bin'), 'BBBB')

      await expect(archive.copyInto(source, destination)).rejects.toThrow(BundleError)
    })

    it('will not read a directory as a document', async () => {
      const source = path.join(workspace, 'src', 'a-directory')
      await fs.promises.mkdir(source, { recursive: true })

      await expect(
        archive.copyInto(source, path.join(await archive.stageDir(), 'files', 'x'))
      ).rejects.toThrow('A backup source is not a regular file.')
    })

    it('will not follow a symlink out of the backup', async () => {
      const secret = await file(path.join(workspace, 'secret.txt'), 'not yours')
      const link = path.join(workspace, 'src', 'link.pdf')
      await fs.promises.mkdir(path.dirname(link), { recursive: true })
      await fs.promises.symlink(secret, link)

      // lstat, not stat: following the link would put a file the user never chose into their backup, and
      // a backup is a thing they hand to somebody else.
      await expect(
        archive.copyInto(link, path.join(await archive.stageDir(), 'files', 'x'))
      ).rejects.toThrow('A backup source is not a regular file.')
    })

    it('surfaces a missing source rather than treating it as nothing to do', async () => {
      await expect(
        archive.copyInto(
          path.join(workspace, 'src', 'gone.pdf'),
          path.join(await archive.stageDir(), 'files', 'x')
        )
      ).rejects.toThrow()
    })
  })

  describe('packing the staged tree', () => {
    it('produces a real zip holding every staged file, nested paths included', async () => {
      const stage = await archive.stageDir()
      await archive.writeText(path.join(stage, 'backup.json'), '{"surface":"offgrid-desktop"}')
      await archive.writeText(path.join(stage, 'files', 'documents', 'p1', '0-a.txt'), 'alpha')

      const output = await archive.pack(stage, 'Off Grid Backup.zip')

      expect(path.basename(output)).toBe('Off Grid Backup.zip')
      const zip = await JSZip.loadAsync(await fs.promises.readFile(output))
      // Forward slashes regardless of platform - a zip written with backslashes is unreadable as a tree
      // on anything but Windows.
      // Files only: JSZip synthesises an entry for each intermediate directory, which unpack skips.
      const packed = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort()
      expect(packed).toEqual(['backup.json', 'files/documents/p1/0-a.txt'])
      expect(await zip.file('files/documents/p1/0-a.txt')!.async('string')).toBe('alpha')
    })

    it('removes the staged copy afterwards, so a backup does not leave the data lying around twice', async () => {
      const stage = await archive.stageDir()
      await archive.writeText(path.join(stage, 'backup.json'), '{}')

      await archive.pack(stage, 'backup.zip')

      expect(fs.existsSync(stage)).toBe(false)
    })

    it('removes the staged copy even when packing fails', async () => {
      const stage = await archive.stageDir()
      const link = path.join(stage, 'files', 'link.txt')
      await fs.promises.mkdir(path.dirname(link), { recursive: true })
      await fs.promises.symlink(await file(path.join(workspace, 'outside.txt'), 'x'), link)

      // The staged tree holds the user's documents. Leaving it behind on failure is a copy of their data
      // in a temp directory that nothing will ever clean up.
      await expect(archive.pack(stage, 'backup.zip')).rejects.toThrow(
        'Backup folders cannot contain symbolic links.'
      )
      expect(fs.existsSync(stage)).toBe(false)
    })

    it('packs an empty stage into a valid, empty archive', async () => {
      const output = await archive.pack(await archive.stageDir(), 'backup.zip')

      const zip = await JSZip.loadAsync(await fs.promises.readFile(output))
      expect(Object.values(zip.files).filter((entry) => !entry.dir)).toEqual([])
    })
  })

  describe('unpacking an archive somebody else may have written', () => {
    const zipWith = async (
      entries: Record<string, string>,
      options: { withDirectory?: string } = {}
    ): Promise<string> => {
      const zip = new JSZip()
      for (const [name, contents] of Object.entries(entries)) zip.file(name, contents)
      if (options.withDirectory) zip.folder(options.withDirectory)
      const output = path.join(workspace, `in-${Object.keys(entries).length}-${Math.abs(hash(entries))}.zip`)
      await fs.promises.writeFile(
        output,
        await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      )
      return output
    }
    // Deterministic name per fixture, so two archives in one test cannot collide. Not security, just
    // uniqueness - Math.random would make a failure hard to reproduce.
    const hash = (value: unknown): number =>
      [...JSON.stringify(value)].reduce((total, ch) => (total * 31 + ch.charCodeAt(0)) | 0, 7)

    it('extracts the manifest and the files into a fresh directory', async () => {
      const input = await zipWith({
        'backup.json': '{"surface":"offgrid-desktop"}',
        'files/documents/p1/0-a.txt': 'alpha'
      })

      const output = await archive.unpack(input)

      expect(await fs.promises.readFile(path.join(output, 'backup.json'), 'utf8')).toBe(
        '{"surface":"offgrid-desktop"}'
      )
      expect(
        await fs.promises.readFile(path.join(output, 'files', 'documents', 'p1', '0-a.txt'), 'utf8')
      ).toBe('alpha')
    })

    it('refuses an entry whose name would escape the extraction directory, and leaves nothing behind', async () => {
      const input = await zipWith({
        'backup.json': '{}',
        'files/../../../../etc/cron.d/evil': 'pwned'
      })

      // This is the whole reason unpack checks names: JSZip will happily hand over an entry called
      // '../../..', and path.join would resolve it straight out of the output directory.
      await expect(archive.unpack(input)).rejects.toThrow(
        'This backup contains an unsafe archive path.'
      )
      expect(fs.existsSync(path.join(workspace, 'etc'))).toBe(false)
      // The half-written output is removed too, so a refused restore does not leave a partial tree that a
      // later run might mistake for a good one.
      const leftovers = (await fs.promises.readdir(workspace)).filter((name) =>
        name.startsWith('offgrid-backup-unpack-')
      )
      expect(leftovers).toEqual([])
    })

    it('refuses a top-level file that is not the manifest', async () => {
      const input = await zipWith({ 'backup.json': '{}', 'README.txt': 'hello' })

      // Only backup.json is allowed outside files/. Anything else means the archive is not what it says
      // it is, and admitting unknown top-level entries is how an unexpected path slips through.
      await expect(archive.unpack(input)).rejects.toThrow(
        'This backup contains an unsafe archive path.'
      )
    })

    it('ignores directory entries instead of trying to write them as files', async () => {
      const input = await zipWith({ 'backup.json': '{}' }, { withDirectory: 'files/documents/p1' })

      const output = await archive.unpack(input)

      expect(fs.existsSync(path.join(output, 'backup.json'))).toBe(true)
    })

    it('will not unpack something that is not a regular file', async () => {
      const directory = path.join(workspace, 'not-an-archive')
      await fs.promises.mkdir(directory, { recursive: true })

      await expect(archive.unpack(directory)).rejects.toThrow(
        'A backup source is not a regular file.'
      )
    })

    it('rejects a file that is not a zip at all', async () => {
      const notAZip = await file(path.join(workspace, 'notes.txt'), 'this is not a zip')

      await expect(archive.unpack(notAZip)).rejects.toThrow()
    })

    it('round-trips: what pack writes, unpack reads', async () => {
      const stage = await archive.stageDir()
      await archive.writeText(path.join(stage, 'backup.json'), '{"surface":"offgrid-desktop"}')
      await archive.writeText(path.join(stage, 'files', 'documents', 'p1', '0-a.txt'), 'alpha')

      const output = await archive.unpack(await archive.pack(stage, 'backup.zip'))

      expect(await archive.readText(path.join(output, 'backup.json'))).toBe(
        '{"surface":"offgrid-desktop"}'
      )
      expect(
        await archive.readText(path.join(output, 'files', 'documents', 'p1', '0-a.txt'))
      ).toBe('alpha')
    })
  })

  describe('deciding where a restored file lands', () => {
    it('puts it under the user data directory, never where the key asks', () => {
      const restored = archive.restorePathFor('files/documents/p1/0-abc-Contract.pdf')

      expect(restored).toBe(
        path.join(userData, 'restored-backups', 'files', 'documents', 'p1', '0-abc-Contract.pdf')
      )
    })

    it('refuses a key that is not safe, before any path is built from it', () => {
      for (const key of ['files/../../etc/passwd', '/etc/passwd', 'documents/a.pdf', '']) {
        expect(() => archive.restorePathFor(key)).toThrow(
          'This backup contains an unsafe file path.'
        )
      }
    })
  })
})
