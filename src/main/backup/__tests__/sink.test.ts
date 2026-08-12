import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Handing the finished backup to the user, and taking one back from them.
 *
 * The dialog is the OS - it cannot run in-process, so it is the one thing faked here. Everything either
 * side of it is real, and the part worth protecting is what happens to the TEMPORARY archive: it holds a
 * copy of the user's whole library, so it must be deleted whether the save succeeded, was cancelled, or
 * failed. A backup left in /tmp is the user's data sitting somewhere they did not choose and will never
 * look.
 */

const electron = vi.hoisted(() => ({
  focused: null as unknown,
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => electron.focused },
  dialog: {
    showSaveDialog: electron.showSaveDialog,
    showOpenDialog: electron.showOpenDialog
  }
}))

describe('delivering and collecting a backup file', () => {
  let workspace: string
  let archiveDir: string
  let archive: string

  beforeEach(async () => {
    vi.clearAllMocks()
    electron.focused = null
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'offgrid-sink-test-'))
    // The shape pack() produces: the archive alone inside its own temp directory.
    archiveDir = path.join(workspace, 'offgrid-backup-archive-abc')
    await fs.promises.mkdir(archiveDir, { recursive: true })
    archive = path.join(archiveDir, 'Off Grid Backup.zip')
    await fs.promises.writeFile(archive, 'zip bytes')
  })

  afterEach(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true })
  })

  const sink = async (): Promise<InstanceType<typeof import('../sink').DesktopBackupSink>> => {
    const { DesktopBackupSink } = await import('../sink')
    return new DesktopBackupSink()
  }

  describe('saving it where the user asked', () => {
    it('copies the archive to the chosen path and reports where it went', async () => {
      const chosen = path.join(workspace, 'Desktop', 'My Backup.zip')
      await fs.promises.mkdir(path.dirname(chosen), { recursive: true })
      electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })

      const delivery = await (await sink()).deliverFile(archive, 'Off Grid Backup.zip')

      expect(delivery).toEqual({ canceled: false, path: chosen })
      expect(await fs.promises.readFile(chosen, 'utf8')).toBe('zip bytes')
    })

    it('offers a .zip filter and the suggested name, so the user is not typing an extension', async () => {
      electron.showSaveDialog.mockResolvedValue({ canceled: true })

      await (await sink()).deliverFile(archive, 'Off Grid Backup 2026-01-01.zip')

      expect(electron.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Export Off Grid backup',
          defaultPath: 'Off Grid Backup 2026-01-01.zip',
          filters: [{ name: 'Off Grid backup', extensions: ['zip'] }]
        })
      )
    })

    it('attaches the dialog to the window the user is looking at, when there is one', async () => {
      const owner = { id: 1 }
      electron.focused = owner
      electron.showSaveDialog.mockResolvedValue({ canceled: true })

      await (await sink()).deliverFile(archive, 'backup.zip')

      // Sheet-attached rather than a floating dialog: on macOS an unparented save dialog can appear behind
      // the window, which reads as the app having hung.
      expect(electron.showSaveDialog).toHaveBeenCalledWith(owner, expect.any(Object))
    })

    it('falls back to an unparented dialog when no window is focused', async () => {
      electron.showSaveDialog.mockResolvedValue({ canceled: true })

      await (await sink()).deliverFile(archive, 'backup.zip')

      // A menu-bar-only moment, or a backup triggered with every window closed. Passing a null owner to
      // Electron throws, so the one-argument form is used instead of the export failing.
      expect(electron.showSaveDialog).toHaveBeenCalledWith(expect.any(Object))
      expect(electron.showSaveDialog.mock.calls[0]).toHaveLength(1)
    })

    it('reports a cancelled save without writing anything', async () => {
      electron.showSaveDialog.mockResolvedValue({ canceled: true })

      const delivery = await (await sink()).deliverFile(archive, 'backup.zip')

      expect(delivery).toEqual({ canceled: true })
    })

    it('treats a dialog that returns no path as a cancellation', async () => {
      // Electron can answer canceled: false with no filePath. Copying to undefined would throw a confusing
      // error at the user instead of quietly doing nothing.
      electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' })

      const delivery = await (await sink()).deliverFile(archive, 'backup.zip')

      expect(delivery).toEqual({ canceled: true })
    })

    it('deletes the temporary archive after a successful save', async () => {
      const chosen = path.join(workspace, 'saved.zip')
      electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })

      await (await sink()).deliverFile(archive, 'backup.zip')

      // The temp copy is the user's whole library. Once it has been handed over, keeping it is a duplicate
      // of everything they own in a directory they never chose.
      expect(fs.existsSync(archive)).toBe(false)
      expect(fs.existsSync(archiveDir)).toBe(false)
    })

    it('deletes the temporary archive after a CANCELLED save too', async () => {
      electron.showSaveDialog.mockResolvedValue({ canceled: true })

      await (await sink()).deliverFile(archive, 'backup.zip')

      // Cancelling is the most likely path of all - the user changes their mind at the dialog. Cleaning up
      // only on success would leave a copy behind every single time.
      expect(fs.existsSync(archive)).toBe(false)
      expect(fs.existsSync(archiveDir)).toBe(false)
    })

    it('deletes the temporary archive even when the copy fails', async () => {
      electron.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: path.join(workspace, 'no-such-directory', 'saved.zip')
      })

      await expect((await sink()).deliverFile(archive, 'backup.zip')).rejects.toThrow()

      // A read-only volume, a full disk, a path that vanished. The export fails - which the user must be
      // told - but their data does not stay behind in temp.
      expect(fs.existsSync(archive)).toBe(false)
    })

    it('leaves the containing directory alone if something else is in it', async () => {
      const neighbour = path.join(archiveDir, 'another-file.txt')
      await fs.promises.writeFile(neighbour, 'not mine to delete')
      electron.showSaveDialog.mockResolvedValue({ canceled: true })

      await (await sink()).deliverFile(archive, 'backup.zip')

      // rmdir refuses a non-empty directory and the failure is ignored on purpose: removing the archive is
      // this method's business, and removing somebody else's file is not.
      expect(fs.existsSync(archive)).toBe(false)
      expect(fs.existsSync(neighbour)).toBe(true)
    })
  })

  describe('collecting one to import', () => {
    it('returns the file the user picked', async () => {
      electron.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/Users/someone/Downloads/backup.zip']
      })

      await expect((await sink()).pickFile()).resolves.toBe('/Users/someone/Downloads/backup.zip')
      expect(electron.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Import Off Grid backup',
          properties: ['openFile'],
          filters: [{ name: 'Off Grid backup', extensions: ['zip'] }]
        })
      )
    })

    it('returns nothing when the user cancels', async () => {
      electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

      await expect((await sink()).pickFile()).resolves.toBeNull()
    })

    it('returns nothing when the dialog answers with no files at all', async () => {
      // canceled: false with an empty list. Reading [0] blind would hand an undefined path onward and fail
      // later, somewhere less obvious than here.
      electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] })

      await expect((await sink()).pickFile()).resolves.toBeNull()
    })

    it('takes only the first file when a picker offers several', async () => {
      electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a.zip', '/b.zip'] })

      // One backup is restored at a time; importing two at once has no defined meaning.
      await expect((await sink()).pickFile()).resolves.toBe('/a.zip')
    })

    it('attaches the picker to the focused window when there is one', async () => {
      const owner = { id: 2 }
      electron.focused = owner
      electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

      await (await sink()).pickFile()

      expect(electron.showOpenDialog).toHaveBeenCalledWith(owner, expect.any(Object))
    })
  })
})
