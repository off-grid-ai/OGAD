// Decide the chat (llama-server) health status shown in System Health. Kept pure
// + Electron-free so it's unit-testable (see __tests__/chat-health.test.ts).
//
// The motivating bug: while a model loads (several seconds at -ngl 99),
// llama-server's /health returns HTTP 503 ("loading model"), so the HTTP probe
// reports not-healthy AND the server isn't "ready" yet — and the old logic fell
// straight to "down: server is not running". Users opened Settings mid-load and
// saw a scary red "Down" on a server that was simply warming up. This distinguishes
// "alive but loading" (starting) from "genuinely not running" (down).

export type ChatHealthStatus = 'ready' | 'starting' | 'idle' | 'down' | 'not_installed'

export interface ChatHealthInputs {
  /** /health answered 200 (model loaded, accepting requests). */
  healthy: boolean
  /** The server process is alive but hasn't finished loading the model yet, OR
   *  /health answered 503 "loading". This is the normal warm-up window. */
  loading: boolean
  /** A chat model exists on disk. */
  modelsExist: boolean
  /** Name of the active model (shown as detail when ready). */
  activeModel?: string | null
  /** Human reason the server failed or stopped unexpectedly, if any. Without one, a stopped
   *  server is simply not loaded yet: it loads on first use. */
  lastError?: string | null
}

export function decideChatStatus(i: ChatHealthInputs): {
  status: ChatHealthStatus
  detail?: string
} {
  if (i.healthy) return { status: 'ready', detail: i.activeModel ?? undefined }
  if (!i.modelsExist) return { status: 'not_installed', detail: 'No model installed' }
  // Alive-but-loading must be checked BEFORE "down" — otherwise the warm-up
  // window reads as a failure.
  if (i.loading) return { status: 'starting', detail: 'Loading model…' }
  if (i.lastError) return { status: 'down', detail: i.lastError }
  return { status: 'idle', detail: 'Loads when you first chat' }
}
