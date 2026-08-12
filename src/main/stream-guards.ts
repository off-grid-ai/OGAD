// A broken stdout/stderr pipe must never crash the app.
//
// When the main process is launched by a parent that captures its output (an e2e harness, a
// shell pipe) and that parent exits, the next write to the pipe raises EPIPE. From a
// timer-based console.log that EPIPE is emitted as an 'error' on the stdout stream with no
// listener, so it becomes an uncaught exception and Electron shows a fatal "A JavaScript error
// occurred in the main process" dialog. That modal then blocks a clean exit and keeps the
// single-instance lock held (which in turn makes the NEXT launch collide). A console write
// failing is never a reason to take down the app.
//
// Installing an 'error' listener on the stream makes the emit non-fatal (an EventEmitter throws
// on 'error' only when there is NO listener). We swallow the write error — there is nothing
// useful to do about a dead console stream, and by definition we cannot log it.

/** Attach a no-throw error handler to each console stream so a broken pipe (or any write error)
 *  can never surface as an uncaught exception. Returns the count guarded (for tests). */
export function guardConsoleStreams(streams: Array<NodeJS.EventEmitter | undefined>): number {
  let n = 0
  for (const s of streams) {
    if (s && typeof s.on === 'function') {
      s.on('error', () => {
        /* swallow: a dead console stream must not crash the process */
      })
      n++
    }
  }
  return n
}

/** Guard both ends of a proxied stream (upstream response + client response) against a mid-stream
 *  reset. Piping `proxyRes` into `res` only wires the pipe; neither stream gets an 'error' listener,
 *  so if llama-server aborts the connection or the client disconnects mid-stream, the unhandled
 *  'error' event becomes an uncaught exception and crashes the whole main process (an EventEmitter
 *  throws on 'error' only when there is NO listener). We swallow the error and destroy the client
 *  response so its socket is released. This does NOT settle any outer promise — by the time piping
 *  starts the proxy attempt has already resolved, and re-settling here would be a double-settle.
 *  Returns the count guarded (for tests). */
export function guardProxyStreams(
  upstream: (NodeJS.EventEmitter & { destroy?: (err?: Error) => void }) | undefined,
  client: (NodeJS.EventEmitter & { destroy?: (err?: Error) => void }) | undefined
): number {
  let n = 0
  const destroy = (s?: { destroy?: (err?: Error) => void }): void => {
    try {
      s?.destroy?.()
    } catch {
      /* already destroyed */
    }
  }
  if (upstream && typeof upstream.on === 'function') {
    // Upstream (llama-server) reset mid-stream: tear down the client response so its socket frees.
    upstream.on('error', () => destroy(client))
    n++
  }
  if (client && typeof client.on === 'function') {
    // Client disconnected mid-stream: stop reading from llama-server too, else proxyRes.pipe(res)
    // keeps draining the upstream (wasted local inference + a held socket) after the client is gone.
    client.on('error', () => destroy(upstream))
    n++
  }
  return n
}
