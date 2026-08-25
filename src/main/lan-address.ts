// Pick a LAN IPv4 another device (the paired phone) can use to reach this machine.
// The gateway binds 0.0.0.0, so it listens on every interface; this just chooses the
// address to advertise in the pairing QR/code. Loopback, internal, and link-local are
// skipped; common private ranges are preferred. Pure (interfaces injectable) so it is
// unit tested.
import os from 'os'

function privateRank(ip: string): number {
  if (ip.startsWith('192.168.')) {
    return 0
  }
  if (ip.startsWith('10.')) {
    return 1
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return 2
  }
  return 3 // routable / other - usable but least preferred
}

/** Every usable LAN IPv4 on this host, best candidate first. */
export function lanAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const found: string[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) {
        continue
      }
      if (info.address.startsWith('169.254.')) {
        continue // link-local (self-assigned) - not reachable from the phone
      }
      found.push(info.address)
    }
  }
  return found.sort((a, b) => privateRank(a) - privateRank(b))
}

/** The single best LAN IPv4 to advertise, or null if the host has none. */
export function primaryLanAddress(
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>
): string | null {
  return lanAddresses(interfaces)[0] ?? null
}
