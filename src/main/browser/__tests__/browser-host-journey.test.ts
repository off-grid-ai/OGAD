import { describe, expect, it, vi } from 'vitest'
import { VisionGuard } from '../../vision/vision-guard'
import { BrowserJourneyRunOwners } from '../browser-run-owners'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { handle: () => undefined, on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { journeyRunsInSandbox, releaseJourneyRun } = await import('../browser-host')

describe('the send, pay and delete gate reads the pages a task drives', () => {
  it('skips the question only when every page is in a sandbox profile', () => {
    expect(journeyRunsInSandbox([{ chrome: { profileId: 'mail' } }])).toBe(true)
    expect(
      journeyRunsInSandbox([{ chrome: { profileId: 'mail' } }, { chrome: { profileId: 'mail' } }])
    ).toBe(true)
  })

  it('asks on a page in the person own partition, whatever the request named', () => {
    expect(journeyRunsInSandbox([{ chrome: {} }])).toBe(false)
    expect(journeyRunsInSandbox([{ chrome: { profileId: 'mail' } }, { chrome: {} }])).toBe(false)
    expect(journeyRunsInSandbox([{ chrome: { profileId: 'not-a-profile' } }])).toBe(false)
    expect(journeyRunsInSandbox([])).toBe(false)
  })
})

describe('a finished run clears its journey secrets only while it owns the journey', () => {
  const guard = (taskId: string): VisionGuard => new VisionGuard({ taskId, kind: 'web_use' })

  it('clears the journey state of the current run', () => {
    const owners = new BrowserJourneyRunOwners()
    const { owner } = owners.replace('chat-1', 'task-1', guard('task-1'))
    const clear = vi.fn()
    releaseJourneyRun(owners, owner, clear)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(owners.isCurrent(owner)).toBe(false)
  })

  it('leaves the newer run state alone when this run was replaced', () => {
    const owners = new BrowserJourneyRunOwners()
    const old = owners.replace('chat-1', 'task-old', guard('task-old')).owner
    const newer = owners.replace('chat-1', 'task-new', guard('task-new')).owner
    const clear = vi.fn()
    releaseJourneyRun(owners, old, clear)
    expect(clear).not.toHaveBeenCalled()
    expect(owners.isCurrent(newer)).toBe(true)
  })
})
