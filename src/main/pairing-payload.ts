// The QR/code pairing payload the desktop hands a phone so it can run this machine's
// MCP action tools. Small, versioned JSON. The SAME data the manual "enter URL +
// token" flow uses, so QR and code stay interchangeable.
//
// Contract (mirrored by the OGAM mobile parser - keep the two in sync):
//   { t: 'offgrid-mcp-pair', v: 1, url: 'http://<ip>:<port>/mcp', token, name? }
//
// Pure - no electron, unit tested.

/** Discriminator so a scanner can tell our QR from any other. */
export const MCP_PAIR_TYPE = 'offgrid-mcp-pair'
export const MCP_PAIR_VERSION = 1

export interface McpPairingPayload {
  t: typeof MCP_PAIR_TYPE
  v: typeof MCP_PAIR_VERSION
  /** The MCP endpoint on this machine's gateway, e.g. http://192.168.1.18:7878/mcp */
  url: string
  /** The action-tool bearer token. */
  token: string
  /** This desktop's display name, for the phone to label the connection. */
  name?: string
}

/** Build the pairing payload from the live gateway details. */
export function buildPairingPayload(opts: {
  lanIp: string
  port: number
  token: string
  name?: string
}): McpPairingPayload {
  return {
    t: MCP_PAIR_TYPE,
    v: MCP_PAIR_VERSION,
    url: `http://${opts.lanIp}:${opts.port}/mcp`,
    token: opts.token,
    ...(opts.name ? { name: opts.name } : {})
  }
}

/** The string that goes into the QR (and that the phone scans). */
export function encodePairingPayload(payload: McpPairingPayload): string {
  return JSON.stringify(payload)
}
