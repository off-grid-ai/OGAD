// @vitest-environment node

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/offgrid-llm-eviction-test', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { LLMService } from '../llm'

describe('LLM eviction for image generation', () => {
  it('refuses image admission while the chat port has a live owner', async () => {
    const svc = new LLMService()
    vi.spyOn(svc, 'unload').mockResolvedValue({ outcome: 'already-dead', portFree: false })
    await expect(Promise.resolve(svc.runtime.evict())).rejects.toThrow('port is still occupied')
  })

  it('waits for the server to close and keeps respawn blocked until release', async () => {
    const svc = new LLMService()
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: ReturnType<typeof vi.fn>
    }
    child.exitCode = null
    child.signalCode = null
    child.kill = vi.fn(() => true)

    const internals = svc as unknown as {
      server: ChildProcess | null
      paused: boolean
      reapOrphansOnPort: () => { liveOwners: never[] }
    }
    internals.server = child as unknown as ChildProcess
    internals.reapOrphansOnPort = () => ({ liveOwners: [] })

    let done = false
    const evict = Promise.resolve(svc.runtime.evict()).then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(done).toBe(false)
    expect(internals.paused).toBe(true)

    child.signalCode = 'SIGTERM'
    child.emit('close', null, 'SIGTERM')
    await evict
    expect(done).toBe(true)
    expect(internals.paused).toBe(true)
    svc.runtime.release()
    expect(internals.paused).toBe(false)
  })
})
