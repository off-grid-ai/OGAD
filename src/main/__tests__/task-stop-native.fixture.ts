// Real action engine, browser host, Stop control and SQLite task history.
// Only the external model server is synthetic; stop while its plan request is in flight.
import { app } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getActionsRuntime } from '../actions/use-runtime'
import { controlVisionTask } from '../vision/vision-controller'
import { getTaskRun } from '../tasks/task-history'
import { getTaskRetryAvailability } from '../tasks/task-retry'
import { setRemoteVisionServerSettings } from '../vision/remote-vision-server'
import { disposeBrowserHost } from '../browser/browser-host'
import { getDB } from '../database'

void app.whenReady().then(async () => {
  let started!: () => void
  const planning = new Promise<void>((resolve) => {
    started = resolve
  })
  const server = createServer((req, res) => {
    req.resume()
    if (req.method === 'POST') {
      started()
      return
    }
    if (req.url?.includes('models')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'synthetic' }] }))
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<label>Email<input></label>')
    }
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    setRemoteVisionServerSettings({
      provider: 'lmstudio',
      name: 'Synthetic local model',
      model: 'synthetic',
      endpoint
    })
    const runtime = getActionsRuntime()
    const proposed = await runtime.propose(
      {
        type: 'web_use',
        intent: 'Fill the synthetic form',
        args: { goal: 'Fill the synthetic form', url: endpoint },
        risk: 'mutate'
      },
      { source: 'chat' }
    )
    assert.ok(proposed.accepted)
    if (!proposed.accepted) throw new Error('Task was not accepted')
    // Let the startup drain finish, then deliver the normal worker wake-up.
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime.kick()
    await Promise.race([
      planning,
      runtime.waitForOutcome(proposed.id, 8000).then((outcome) => {
        throw new Error(JSON.stringify({ outcome, task: getTaskRun(proposed.id) }))
      })
    ])
    assert.equal(controlVisionTask('stop', proposed.id), true)
    assert.equal(getTaskRun(proposed.id)?.status, 'stopped')
    assert.ok(await runtime.waitForOutcome(proposed.id, 5000))
    assert.equal(
      getTaskRun(proposed.id)?.status,
      'stopped',
      'Late action completion must preserve Stop'
    )
    assert.equal(getTaskRetryAvailability(proposed.id).available, true)
    console.log('TASK_STOP_NATIVE_PASSED')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    disposeBrowserHost()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    getDB().close()
    app.exit(process.exitCode ? 1 : 0)
  }
})
