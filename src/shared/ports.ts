// Canonical engine ports - single source of truth for the loopback services.
// Change a port here and every site follows; do not re-hardcode these literals.
//
//   LLAMA_SERVER_PORT - bundled llama-server (chat/vision/embeddings upstream)
//   GATEWAY_HOST      - how a client ADDRESSES the gateway (URLs, docs, CSP origin)
//   GATEWAY_BIND_HOST - what the gateway LISTENS on. Not the same question: you cannot
//                       fetch http://0.0.0.0:7878, so the two must stay separate.
//   GATEWAY_PORT      - OpenAI-compatible gateway (proxies to llama-server)
//   MEDIA_PORT        - loopback media server (meeting recordings, uploads)
//
// Pure constants, no imports, so both the main process and the renderer can
// import this without pulling in Electron/Node.

export const LLAMA_SERVER_PORT = 8439
export const GATEWAY_HOST = '127.0.0.1'

/**
 * Every interface, so a phone on the same LAN can reach this Mac's models: Off Grid Mobile
 * scans the subnet for :7878 and a loopback-only listener is invisible to it. That path
 * worked until the gateway was bound to loopback, and this restores it.
 *
 * The gateway is UNAUTHENTICATED, so anything that can route to this machine can use the
 * models and POST /mcp. The route-level localhost guards (settings mutations) are what keep
 * the sensitive surfaces closed; they do not depend on the bind address.
 */
export const GATEWAY_BIND_HOST = '0.0.0.0'
export const GATEWAY_PORT = 7878
export const MEDIA_PORT = 7879
