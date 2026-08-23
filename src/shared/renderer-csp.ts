import { GATEWAY_HOST, GATEWAY_PORT, MEDIA_PORT } from './ports'

export function createRendererContentSecurityPolicy(styleNonce: string): string {
  const gatewayOrigin = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`
  const mediaOrigin = `http://127.0.0.1:${MEDIA_PORT}`
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${styleNonce}'`,
    `style-src 'self' 'nonce-${styleNonce}'`,
    `img-src 'self' data: blob: ogcapture: ${mediaOrigin} https://cdn.simpleicons.org`,
    `media-src 'self' data: blob: ogcapture: ${mediaOrigin}`,
    // mediaOrigin is a FRAME source as well as an image one: a PDF attachment is rendered by
    // Chromium's built-in viewer in an iframe, and it is served by the same loopback media server
    // that already serves images from the same admitted roots. Without it the frame is blocked and
    // draws blank - which reads exactly like a broken file rather than a blocked one.
    `frame-src 'self' ogartifact: ${mediaOrigin} ${gatewayOrigin} http://localhost:${GATEWAY_PORT}`,
    `connect-src 'self' ${gatewayOrigin} ${mediaOrigin}`
  ].join('; ')
}
