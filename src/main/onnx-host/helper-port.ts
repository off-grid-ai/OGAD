// The child side of a helper process (utility-host.ts): the first message carries the init data,
// every later message is a request. Replies go back through the same port.

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export interface HelperPort<Request> {
  post(message: unknown): void
  onRequest(listener: (request: Request) => void): void
}

/** Resolves once the host has sent the init data. Throws outside a utility process. */
export function connectHelper<Init, Request>(): Promise<{ init: Init; port: HelperPort<Request> }> {
  const parent = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (!parent) throw new Error('This helper must be started as an Electron utility process.')
  return new Promise((resolve) => {
    let init: Init | undefined
    const queued: Request[] = []
    let listener: ((request: Request) => void) | null = null
    parent.on('message', ({ data }) => {
      const message = data as { type?: string; data?: Init }
      if (init === undefined && message.type === 'init') {
        init = message.data as Init
        resolve({
          init,
          port: {
            post: (reply) => parent.postMessage(reply),
            onRequest: (next) => {
              listener = next
              for (const request of queued.splice(0)) next(request)
            }
          }
        })
        return
      }
      if (listener) listener(data as Request)
      else queued.push(data as Request)
    })
  })
}
