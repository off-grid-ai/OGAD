import { WebSocket } from 'ws'
import { runBounded } from './playwright-boundary-wait'

export interface CdpCommand {
  id: number
  sessionId?: string
  method: string
  params: Record<string, unknown>
}

export interface CdpEvent {
  method?: string
  params?: unknown
  sessionId?: string
  id?: number
  result?: unknown
  error?: { message: string }
}

export function parseCdpCommand(value: unknown): CdpCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed CDP command.')
  }
  const command = value as Record<string, unknown>
  if (!Number.isSafeInteger(command.id) || Number(command.id) < 0) {
    throw new Error('CDP command requires a non-negative integer id.')
  }
  if (typeof command.method !== 'string' || !command.method.trim()) {
    throw new Error('CDP command requires a method.')
  }
  if (command.sessionId !== undefined && typeof command.sessionId !== 'string') {
    throw new Error('CDP session id must be a string.')
  }
  if (
    command.params !== undefined &&
    (typeof command.params !== 'object' || command.params === null || Array.isArray(command.params))
  ) {
    throw new Error('CDP command params must be an object.')
  }
  return {
    id: Number(command.id),
    method: command.method,
    sessionId: command.sessionId as string | undefined,
    params: (command.params as Record<string, unknown> | undefined) ?? {}
  }
}

export function safeTargetUrl(value: unknown): string {
  const url = typeof value === 'string' ? value : 'about:blank'
  if (url === 'about:blank') return url
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Web Use targets accept only HTTP or HTTPS URLs.')
  }
  return parsed.toString()
}

export async function sendCdpEvent(
  socket: WebSocket,
  message: CdpEvent,
  timeoutMs: number
): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('Playwright relay socket is not open.')
  await runBounded({
    label: 'Playwright relay send',
    timeoutMs,
    run: () =>
      new Promise<void>((resolve, reject) =>
        socket.send(JSON.stringify(message), (error) => (error ? reject(error) : resolve()))
      )
  })
}

export async function closeRelaySocket(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  try {
    await runBounded({
      label: 'Playwright relay socket close',
      timeoutMs,
      run: () =>
        new Promise<void>((resolve) => {
          socket.once('close', resolve)
          socket.close(1000, 'Web Use session ended')
        })
    })
  } catch (error) {
    socket.terminate()
    throw error
  }
}

export function asBoundaryError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
