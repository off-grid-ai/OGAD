import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { GATEWAY_HOST, GATEWAY_PORT, LLAMA_SERVER_PORT, MEDIA_PORT } from '../../src/shared/ports'

/**
 * Precondition guard for specs that assert against the FIXED engine ports.
 *
 * Those ports are single-owner. When a dev has the real app (or `npm run dev`) running, it
 * owns 7878/7879/8439, and specs probing them talk to the WRONG process:
 *
 *   - smoke.spec.ts asserts llama-server is unreachable on a fresh profile, but a running
 *     app's llama-server answers on 8439, so the assertion inverts
 *   - smoke.spec.ts polls the gateway for its own fixture model, but 7878 belongs to the
 *     other app, which never serves that fixture
 *   - resilience-single-instance.spec.ts waits for the ports to close after teardown, and the
 *     other app's ports never close
 *
 * All three produced false failures that read exactly like product regressions. The app also
 * auto-falls-back to a free port when a fixed one is held, so the e2e instance may not even
 * be on the port the spec is probing.
 *
 * These specs FAIL before launching, naming the process that holds the port. They used to
 * skip, and a skipped spec reads as green: on a box where another app held a port, a run
 * "passed" without testing anything. A failure that names the owner is one you can act on.
 */

const ENGINE_PORTS: { port: number; what: string }[] = [
  { port: GATEWAY_PORT, what: 'gateway' },
  { port: MEDIA_PORT, what: 'media server' },
  { port: LLAMA_SERVER_PORT, what: 'llama-server' }
]

/**
 * True when something is LISTENING on the port. A raw TCP connect, not an HTTP probe: a
 * server answering 404 is still an owner, and an HTTP error would misreport it as free.
 */
export const portIsBusy = async (port: number, timeoutMs = 400): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: GATEWAY_HOST })
    const finish = (busy: boolean): void => {
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })

/** Which canonical engine ports are already owned, as human-readable labels. */
export const busyEnginePorts = async (): Promise<string[]> => {
  const checks = await Promise.all(
    ENGINE_PORTS.map(async ({ port, what }) =>
      (await portIsBusy(port)) ? `${what} :${port}` : null
    )
  )
  return checks.filter((entry): entry is string => entry !== null)
}

/** The process listening on a port, as "name (pid N)", when the OS can say. */
export const portOwner = (port: number): string => {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
    encoding: 'utf8'
  })
  const lines = (lsof.stdout ?? '').split('\n')
  const pid = lines.find((line) => line.startsWith('p'))?.slice(1)
  const name = lines.find((line) => line.startsWith('c'))?.slice(1)
  return pid ? `${name ?? 'unknown'} (pid ${pid})` : 'an unknown process'
}

/**
 * Throws when a fixed engine port is already owned, naming the port and its owner. Call BEFORE
 * launching the Electron app.
 */
export const assertEnginePortsFree = async (): Promise<void> => {
  const owned = await Promise.all(
    ENGINE_PORTS.map(async ({ port, what }) =>
      (await portIsBusy(port)) ? `${what} :${port} is held by ${portOwner(port)}` : null
    )
  )
  const busy = owned.filter((entry): entry is string => entry !== null)
  if (busy.length === 0) return
  throw new Error(
    `Engine ports are already owned: ${busy.join('; ')}. Quit that process (Off Grid AI Desktop, npm run dev, another e2e lane) and re-run. These specs assert against the fixed ports and cannot share them.`
  )
}
