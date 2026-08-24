type CancelPendingAuthorization = (error: Error) => void

interface PendingAuthorization {
  token: symbol
  cancel: CancelPendingAuthorization
}

const pendingByConnector = new Map<number, PendingAuthorization>()

/**
 * Register one pending browser authorization for a connector. A new attempt replaces and cancels
 * an older attempt for the same connector. The returned function clears only this registration.
 */
export function beginOAuthAuthorization(
  connectorId: number,
  cancel: CancelPendingAuthorization
): () => void {
  pendingByConnector
    .get(connectorId)
    ?.cancel(new Error('Authorization superseded by a newer request'))

  const token = Symbol(`connector:${connectorId}:oauth`)
  pendingByConnector.set(connectorId, { token, cancel })

  return () => {
    if (pendingByConnector.get(connectorId)?.token === token) {
      pendingByConnector.delete(connectorId)
    }
  }
}

/** Cancel the pending browser authorization for one connector, if it has one. */
export function cancelOAuthAuthorization(connectorId: number): boolean {
  const pending = pendingByConnector.get(connectorId)
  if (!pending) return false
  pendingByConnector.delete(connectorId)
  pending.cancel(new Error('Authorization cancelled'))
  return true
}
