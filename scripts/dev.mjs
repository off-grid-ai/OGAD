import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import console from 'node:console'
import {
  captureWorkspaceInputs,
  workspaceBuildGraph
} from '../../shared/scripts/workspace-build-provenance.mjs'

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

function childGroup(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    detached: process.platform !== 'win32'
  })
  const exited = new Promise((resolveExit) => {
    child.once('error', (error) => {
      console.error('[dev] Could not start child:', error)
      resolveExit(1)
    })
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
  let stopping
  const stop = () => {
    if (stopping) return stopping
    stopping = (async () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore'
        })
        await new Promise((done) => {
          killer.once('exit', done)
          killer.once('error', done)
        })
        return
      }
      const signal = (name) => {
        try {
          process.kill(-child.pid, name)
          return true
        } catch (error) {
          if (error.code === 'ESRCH') return false
          throw error
        }
      }
      if (!signal('SIGTERM')) return
      // The parent can exit before Electron/native descendants. Check the owned group itself.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (!signal(0)) return
        await delay(50)
      }
      signal('SIGKILL')
      await Promise.race([exited, delay(1000)])
    })()
    return stopping
  }
  return { exited, stop }
}

/** Desktop owns process lifecycle; Shared owns input selection, build order and proof. */
export function startDevSupervisor({ desktopRoot, sharedRoot, pollMs = 2000, debounceMs = 1500 }) {
  const cache = join(desktopRoot, 'node_modules/.cache')
  mkdirSync(cache, { recursive: true })
  const lock = join(cache, 'offgrid-dev-supervisor.lock')
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        `Another development supervisor owns ${lock}. Stop it first. If its recorded PID no longer exists, remove this exact stale lock and retry.`
      )
    }
    throw error
  }
  let stopped = false
  let working = false
  let observation
  let changedAt = 0
  let attempted
  let task
  let runtime
  let shutdown
  let updatePromise

  const observe = () => {
    try {
      return {
        key: JSON.stringify(captureWorkspaceInputs(sharedRoot, workspaceBuildGraph(sharedRoot)))
      }
    } catch (error) {
      return { key: `unreadable:${String(error)}`, error }
    }
  }
  const record = () => {
    const next = observe()
    if (next.key !== observation?.key) {
      observation = next
      changedAt = Date.now()
    }
    return next
  }
  const stopRuntime = async () => {
    const owned = runtime
    runtime = undefined
    if (owned) await owned.stop()
  }
  const run = async (script, cwd, timeoutMs) => {
    if (stopped) return false
    const owned = childGroup(process.execPath, [script], cwd)
    task = owned
    let timeout
    const result = await Promise.race([
      owned.exited,
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => {
          console.error(`[dev] Command timed out: ${script}`)
          resolveTimeout(1)
        }, timeoutMs)
      })
    ])
    clearTimeout(timeout)
    await owned.stop()
    if (task === owned) task = undefined
    return result === 0 && !stopped
  }
  const update = async (target) => {
    await stopRuntime()
    if (stopped) return
    if (target.error) {
      console.error(
        '[dev] Shared inputs are unreadable. Waiting for a source change.',
        target.error
      )
      return
    }
    const verify = () =>
      run(join(desktopRoot, 'scripts/verify-shared-consumer-contract.mjs'), desktopRoot, 60000)
    if (!(await verify())) {
      if (stopped) return
      console.warn(
        '[dev] Rebuilding all Shared packages in dependency order. This stops and restarts the app; renderer HMR is unchanged.'
      )
      if (
        !(await run(join(sharedRoot, 'scripts/build-workspaces.mjs'), sharedRoot, 15 * 60 * 1000))
      ) {
        console.error(
          '[dev] Shared build failed. App remains stopped; waiting for a new Shared input change.'
        )
        return
      }
      if (!(await verify())) return
    }
    if (record().key !== target.key || stopped) return
    if (!(await run(join(desktopRoot, 'scripts/stage-native.mjs'), desktopRoot, 120000))) return
    if (record().key !== target.key || stopped) return
    const owned = childGroup(
      process.execPath,
      [join(desktopRoot, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev'],
      desktopRoot
    )
    runtime = owned
    void owned.exited
      .then(async (code) => {
        if (runtime !== owned) return
        runtime = undefined
        await owned.stop()
        if (!stopped)
          console.warn(
            `[dev] App exited (${code}). Waiting for a Shared input change, or restart npm run dev.`
          )
      })
      .catch((error) => console.error('[dev] App cleanup failed:', error))
  }
  const poll = () => {
    if (stopped) return
    record()
    if (working || observation.key === attempted || Date.now() - changedAt < debounceMs) return
    const target = observation
    attempted = target.key
    working = true
    updatePromise = update(target)
      .catch((error) => console.error('[dev] Update failed:', error))
      .finally(() => {
        working = false
        if (!stopped) poll()
      })
  }
  const stop = () => {
    if (shutdown) return shutdown
    stopped = true
    clearInterval(timer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    shutdown = Promise.all([task?.stop(), stopRuntime(), updatePromise]).then(() => {
      unlinkSync(lock)
    })
    return shutdown
  }
  const onSignal = () => {
    void stop().catch((error) => {
      console.error('[dev] Shutdown failed:', error)
      process.exitCode = 1
    })
  }
  const timer = setInterval(poll, pollMs)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  console.warn(
    `[dev] Shared watcher active (${pollMs / 1000}s scan). Renderer HMR stays active; Shared edits stop and restart the app after a verified full build.`
  )
  poll()
  return { stop }
}

function isMainEntry() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch (error) {
    // An imported module can have no filesystem entry (for example, node --eval).
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
}

if (isMainEntry()) {
  const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
  startDevSupervisor({ desktopRoot, sharedRoot: resolve(desktopRoot, '../shared') })
}
