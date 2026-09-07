// The QR/code pairing payload the desktop hands a phone so it can run this machine's MCP action
// tools is owned by @offgrid/sync (`tool-grant-contract`): the discriminator, the version, the
// payload shape, the URL rule and the JSON encoding all live there, next to the parser the phone
// and the mesh grant path use. Desktop keeps no copy of those rules - a second copy is how the QR
// and the scanner drift apart.
//
// This module is the Desktop main-process path for that contract. It re-exports, it does not wrap:
// there is no Desktop-side build, encode or validation step layered on top.

export {
  MCP_PAIR_TYPE,
  MCP_PAIR_VERSION,
  MCP_MIN_TOKEN_LENGTH,
  buildLocalMcpUrl,
  buildMcpPairingPayload,
  encodeMcpPairingPayload,
  parseMcpPairingPayload,
  validateMcpPairing
} from '@offgrid/sync'
export type { McpPairing, McpPairingPayload } from '@offgrid/sync'
