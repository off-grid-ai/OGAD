/** File routes identify views within one trusted document. */
export function fullscreenOriginAllowed(
  rendererUrl: string,
  documentUrl: string,
  currentUrl: string,
  requestingUrl: string
): boolean {
  try {
    const expected = new URL(rendererUrl)
    const document = new URL(documentUrl)
    const current = new URL(currentUrl)
    const requester = new URL(requestingUrl)
    for (const url of [expected, document, current, requester]) url.hash = ''
    return expected.protocol === 'file:'
      ? document.href === expected.href && requester.href === current.href
      : requester.origin === expected.origin
  } catch {
    return false
  }
}
