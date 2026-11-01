// The Decision runtime always starts at port 8459 and takes the first free one after it. Two test
// files that start Decision servers at once can pick the same port; one file's server then answers
// the other's requests. Files that start them take this machine-wide lock for each test, so they
// take turns. The lock is a listening socket: the OS frees it when its holder exits, so a crashed
// worker never leaves it behind and a reused pid never keeps it held.
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** Far from the product's ports (8439-8489), so only test files ever hold it. */
const LOCK_PORT = 47459

function listen(): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.listen({ port: LOCK_PORT, host: '127.0.0.1', exclusive: true }, () =>
      resolve(server.unref())
    )
  })
}

/** Wait for the Decision port range, then hold it; returns the release. */
export async function holdDecisionPorts(): Promise<() => void> {
  for (;;) {
    const server = await listen()
    if (server) return () => server.close()
    await delay(50)
  }
}
