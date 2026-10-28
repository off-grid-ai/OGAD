// Gradual-increment free-port fallback for the loopback services (llama-server, gateway, media).
// The ports in shared/ports.ts are PREFERRED, not mandatory: if another app owns one (LM Studio on
// :8439, a second Off Grid AI Desktop instance, anything else), we must not fight over it or dead-end — we scan
// upward (+1, +2, …) for the first free port and bind there. The candidate math is pure (unit-
// tested); the socket probe is injected so selection is testable without real sockets.

import net from 'node:net'

/** Ordered ports to try: `preferred`, then +1, +2, … Pure. Clamped to the valid TCP range. */
export function portCandidates(preferred: number, maxTries = 20): number[] {
  const out: number[] = []
  for (let i = 0; i < Math.max(1, maxTries); i++) {
    const p = preferred + i
    if (p > 65535) break
    out.push(p)
  }
  return out
}

/** True if `port` can be bound on `host` right now (nothing else is listening). Real socket probe:
 *  bind, then release. Resolves false on EADDRINUSE / any bind error. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    try {
      srv.listen(port, host)
    } catch {
      resolve(false)
    }
  })
}

/** The port a service prefers. `override` (an env var) moves it only in an unpackaged build, so dev
 *  and e2e lanes running side by side can each take their own; a packaged app keeps `fixed`. Pure. */
export function preferredPort(
  fixed: number,
  override: string | undefined,
  packaged: boolean
): number {
  const port = Number(override)
  return !packaged && Number.isInteger(port) && port > 0 && port <= 65535 ? port : fixed
}

/** True if `port` is free on every one of `hosts`. A server listening on every interface (0.0.0.0)
 *  can still bind a port that another process holds on 127.0.0.1 alone, and then loopback clients
 *  reach that other process instead: so a port counts as free only when loopback is free too. */
export async function isPortFreeOnAll(port: number, hosts: readonly string[]): Promise<boolean> {
  for (const host of hosts) if (!(await isPortFree(port, host))) return false
  return true
}

/**
 * The first free port at or after `preferred`, scanning upward in single steps. Returns null if none
 * in the window is free (caller decides whether to surface a conflict). `isFree` is injected so the
 * increment/selection logic is unit-tested without opening sockets.
 */
export async function pickFreePort(
  preferred: number,
  isFree: (port: number) => Promise<boolean> = (p) => isPortFree(p),
  maxTries = 20
): Promise<number | null> {
  for (const port of portCandidates(preferred, maxTries)) {
    if (await isFree(port)) {
      return port
    }
  }
  return null
}
