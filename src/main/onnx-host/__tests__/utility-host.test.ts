// Voice and search helpers as separate processes: a helper gets its init message first, answers
// requests, and a crash ends only the helper. After repeated crashes it stays down, saying why,
// until it is cleared. Electron's utilityProcess is the controlled boundary: it is backed by a
// real Node child process, which has the same message, exit and kill behaviour.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { fork } = await import('node:child_process')
  return {
    utilityProcess: {
      fork: (entry: string, args: string[], options: { env?: Record<string, string> }) => {
        const child = fork(entry, args, { env: options.env, stdio: 'inherit' })
        return {
          postMessage: (message: unknown) => child.send(message as object),
          on: (event: string, listener: (...values: unknown[]) => void) =>
            child.on(event, listener),
          once: (event: string, listener: (...values: unknown[]) => void) =>
            child.once(event, listener),
          kill: () => child.kill()
        }
      }
    }
  }
})

import { clearHelperCrashes, forkHelper, helperStoppedReason } from '../utility-host'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-utility-host-'))
const helper = path.join(dir, 'helper.js')
// Echoes what it was initialised with, answers 'ping', and dies with code 3 on 'crash'.
fs.writeFileSync(
  helper,
  `let init = null;
process.on('message', (message) => {
  if (message.type === 'init') { init = message.data; return; }
  if (message === 'crash') process.exit(3);
  process.send({ reply: message, init });
});
`
)

const open: Array<ReturnType<typeof forkHelper>> = []
const start = (serviceName: string): ReturnType<typeof forkHelper> => {
  const handle = forkHelper(helper, { model: 'search' }, { serviceName, label: 'Search', env: {} })
  open.push(handle)
  return handle
}
const exitOf = (handle: ReturnType<typeof forkHelper>): Promise<number> =>
  new Promise((resolve) => handle.on('exit', resolve))

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.terminate()))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('helper processes', () => {
  it('sends the helper its init first, then carries requests both ways', async () => {
    const search = start('offgrid-test-echo')
    const reply = new Promise((resolve) => search.on('message', resolve))
    search.postMessage('ping')
    expect(await reply).toEqual({ reply: 'ping', init: { model: 'search' } })
  })

  it('counts crashes, stays down after three in a minute, and starts again once cleared', async () => {
    const name = 'offgrid-test-crash'
    for (let i = 0; i < 3; i++) {
      const crashing = start(name)
      const exited = exitOf(crashing)
      crashing.postMessage('crash')
      expect(await exited).toBe(3)
      // A request to a helper that has exited goes nowhere instead of throwing.
      crashing.postMessage('ping')
    }
    expect(helperStoppedReason(name)).toBe('the helper exited with code 3')
    expect(() => start(name)).toThrow('Search stopped: the helper exited with code 3')

    clearHelperCrashes(name)
    expect(helperStoppedReason(name)).toBeNull()
    const again = start(name)
    const reply = new Promise((resolve) => again.on('message', resolve))
    again.postMessage('ping')
    expect(await reply).toMatchObject({ reply: 'ping' })
  })

  it('does not count a helper it stopped itself as a crash', async () => {
    const name = 'offgrid-test-terminate'
    for (let i = 0; i < 4; i++) {
      const helperProcess = start(name)
      await helperProcess.terminate()
      // Terminating twice is harmless.
      await helperProcess.terminate()
    }
    expect(helperStoppedReason(name)).toBeNull()
  })
})
