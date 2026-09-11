/**
 * Port reservation for the suites that boot the REAL gateway.
 *
 * Three suites used to carry their own `freePort()` copy: bind an ephemeral port on `127.0.0.1`,
 * close it, hand the number back. Under vitest's parallel workers that is a TOCTOU race with a
 * sharper edge than it looks: the gateway binds `GATEWAY_BIND_HOST` (`0.0.0.0`), and on darwin a
 * loopback probe CANNOT see a wildcard holder — `isPortFree(p, '127.0.0.1')` returns true while
 * `listen(p, '0.0.0.0')` fails EADDRINUSE. A sibling worker's gateway is exactly such a holder, so
 * the released number came back "free" and the next bind died.
 *
 * So probe on the host the gateway actually binds, and never release the reservation before the
 * caller is ready: `reserve()` keeps the socket open, `release()` hands the port over.
 */
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { GATEWAY_BIND_HOST } from '../../../shared/ports'

export interface PortReservation {
  port: number
  release: () => Promise<void>
}

/** Hold a port on the gateway's bind host until `release()`. */
export async function reserveGatewayPort(): Promise<PortReservation> {
  const holder = net.createServer()
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject)
    holder.listen(0, GATEWAY_BIND_HOST, resolve)
  })
  const port = (holder.address() as AddressInfo).port
  return {
    port,
    release: () =>
      new Promise<void>((resolve, reject) => {
        holder.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

/** Reserve a port, release it, and hand the number to a caller that binds immediately. */
export async function freeGatewayPort(): Promise<number> {
  const reservation = await reserveGatewayPort()
  await reservation.release()
  return reservation.port
}
