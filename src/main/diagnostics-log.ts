import path from 'node:path'
import { dataDir } from './runtime-env'
import { createDiagnosticWriter, type DiagnosticWriterStats } from './diagnostics-writer'

export type DiagnosticLevel = 'info' | 'warn' | 'error'
export type DiagnosticValue = string | number | boolean | null | undefined
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export interface IpcHandlerRegistrar {
  handle(channel: string, listener: IpcHandler): void
}

const MAX_LOG_BYTES = 5 * 1024 * 1024
// Diagnostics are worth less than the application they observe: past these bounds the OLDEST
// records go and the log says how many.
const MAX_BUFFERED_RECORDS = 5_000
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const MAX_VALUE_CHARS = 1_500
const SECRET_VALUE =
  /((?:authorization|password|passwd|token|secret|api[-_ ]?key|cookie)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi
const BEARER_VALUE = /(bearer\s+)[a-z0-9._~+/=-]+/gi

function redact(value: string): string {
  return value.replace(SECRET_VALUE, '$1[redacted]').replace(BEARER_VALUE, '$1[redacted]')
}

function cleanValue(value: DiagnosticValue): string | null {
  if (value === undefined) return null
  if (value === null) return 'null'
  if (typeof value !== 'string') return String(value)
  return JSON.stringify(
    redact(value)
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, MAX_VALUE_CHARS)
  )
}

/** One readable, grep-friendly line. Callers pass operational metadata only, never user content. */
export function formatDiagnosticLog(
  timestamp: string,
  level: DiagnosticLevel,
  component: string,
  event: string,
  fields: Record<string, DiagnosticValue> = {}
): string {
  const details = Object.entries(fields)
    .map(([key, value]) => {
      const clean = cleanValue(value)
      return clean === null ? null : `${key}=${clean}`
    })
    .filter((value): value is string => value !== null)
    .join(' ')
  return `${timestamp} ${level.toUpperCase()} [${component}] ${event}${details ? ` ${details}` : ''}`
}

export function diagnosticLogPath(): string {
  return (
    process.env.OFFGRID_DIAGNOSTIC_LOG || path.join(dataDir(), 'logs', 'off-grid-ai-desktop.log')
  )
}

/**
 * The single buffering and flushing owner for this log.
 *
 * A write failure is reported on the process stream directly. Routing it back through
 * `writeDiagnosticLog` would ask the failing writer to record its own failure.
 */
const writer = createDiagnosticWriter({
  resolvePath: diagnosticLogPath,
  maxLogBytes: MAX_LOG_BYTES,
  maxBufferedRecords: MAX_BUFFERED_RECORDS,
  maxBufferedBytes: MAX_BUFFERED_BYTES,
  reportFailure: (message) => {
    process.stderr.write(
      `${formatDiagnosticLog(new Date().toISOString(), 'error', 'diagnostics', 'write.failed', {
        error: message
      })}\n`
    )
  }
})

/** What this log has buffered, dropped and failed to write. Observable, not hidden. */
export function diagnosticWriterStats(): DiagnosticWriterStats {
  return writer.stats()
}

/** Drain buffered diagnostics on a controlled shutdown. Bounded: quit is never held hostage. */
export function flushDiagnosticLog(timeoutMs?: number): Promise<void> {
  return writer.flush(timeoutMs)
}

function consoleValue(value: unknown): string {
  if (value instanceof Error) return redact(value.stack || value.message)
  if (typeof value === 'string') return redact(value)
  if (value === null || value === undefined || typeof value !== 'object') return String(value)
  try {
    return redact(
      JSON.stringify(value, (key, item: unknown) =>
        /authorization|password|passwd|token|secret|api[-_ ]?key|cookie/i.test(key)
          ? '[redacted]'
          : item
      )
    )
  } catch {
    return `[${Object.prototype.toString.call(value)}]`
  }
}

export function formatConsoleMessage(values: unknown[]): string {
  return values
    .map(consoleValue)
    .join(' ')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, MAX_VALUE_CHARS)
}

/** Set to `1` to print every diagnostic line, including the per-request IPC trace. */
export const VERBOSE_DIAGNOSTICS_ENV = 'OFFGRID_DIAGNOSTIC_VERBOSE'

function verboseDiagnosticsEnabled(): boolean {
  return process.env[VERBOSE_DIAGNOSTICS_ENV] === '1'
}

/**
 * Whether this line is ALSO printed to the process stream.
 *
 * `process.stdout.write` and `process.stderr.write` are synchronous on a pipe, and the IPC tracer
 * emits an `info` line when a request starts and another when it completes - so mirroring `info`
 * put two blocking writes on Electron's main thread for every IPC request the renderer made. That
 * is the thread serving the renderer, doing terminal I/O, per keystroke-driven request.
 *
 * `info` is the only high-frequency level, so `info` is the level that stops printing. `warn` and
 * `error` are rare by construction and worth an operator seeing immediately, and a developer who
 * wants the whole stream sets the env var. Nothing is lost either way: every level, including the
 * per-request trace, still goes to the private rotating log.
 */
function mirrorsToProcessStream(level: DiagnosticLevel): boolean {
  return level !== 'info' || verboseDiagnosticsEnabled()
}

/**
 * Persist a diagnostic event, and print it only when printing is worth a blocking write.
 *
 * The bounded writer is unchanged: buffering limits, oldest-first overflow with its dropped-record
 * count, rotation at 5 MB, the single in-flight write with one coalesced batch behind it, and the
 * bounded flush on quit all still apply to every line.
 */
export function writeDiagnosticLog(
  component: string,
  event: string,
  fields: Record<string, DiagnosticValue> = {},
  level: DiagnosticLevel = 'info'
): void {
  const line = formatDiagnosticLog(new Date().toISOString(), level, component, event, fields)
  writer.append(line)
  if (!mirrorsToProcessStream(level)) return
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(`${line}\n`)
}

let consoleCaptureInstalled = false
const tracedIpcRegistrars = new WeakSet<object>()
let ipcRequestSequence = 0

function ipcErrorFields(error: unknown): Record<string, DiagnosticValue> {
  const normalized = error instanceof Error ? error : new Error(String(error))
  const candidateCode =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return {
    errorName: normalized.name,
    error: normalized.message,
    errorCode:
      typeof candidateCode === 'string' || typeof candidateCode === 'number'
        ? candidateCode
        : undefined
  }
}

/** Trace every request-response IPC lifecycle without persisting arguments or results. */
export function installIpcDiagnostics(registrar: IpcHandlerRegistrar): void {
  if (tracedIpcRegistrars.has(registrar)) return
  tracedIpcRegistrars.add(registrar)

  const register = registrar.handle.bind(registrar)
  Object.defineProperty(registrar, 'handle', {
    configurable: true,
    writable: true,
    value(channel: string, listener: IpcHandler): void {
      register(channel, async (event: unknown, ...args: unknown[]) => {
        const requestId = `ipc-${process.pid}-${++ipcRequestSequence}`
        const startedAt = Date.now()
        writeDiagnosticLog('ipc', 'request.started', {
          requestId,
          channel,
          argumentCount: args.length
        })
        try {
          const result = await listener(event, ...args)
          writeDiagnosticLog('ipc', 'request.completed', {
            requestId,
            channel,
            durationMs: Date.now() - startedAt
          })
          return result
        } catch (error) {
          writeDiagnosticLog(
            'ipc',
            'request.failed',
            {
              requestId,
              channel,
              durationMs: Date.now() - startedAt,
              ...ipcErrorFields(error)
            },
            'error'
          )
          throw error
        }
      })
    }
  })

  writeDiagnosticLog('ipc', 'tracing.installed')
}

/**
 * Capture every existing main-process console event in the private rotating log.
 *
 * UNCHANGED, and depended on: `console.error`, `console.warn` and the rest on desktop main still
 * reach the bounded log, and still print exactly as they did, because the original method is called
 * first and the capture only appends beside it. What changed above is the diagnostic MIRROR - lines
 * this module generates - not the app's own console calls. A caller that uses `console.error` as
 * its bounded diagnostic channel keeps both properties.
 */
export function installDiagnosticConsoleCapture(): void {
  if (consoleCaptureInstalled) return
  consoleCaptureInstalled = true
  const methods: Array<{
    name: 'log' | 'info' | 'debug' | 'warn' | 'error'
    level: DiagnosticLevel
  }> = [
    { name: 'log', level: 'info' },
    { name: 'info', level: 'info' },
    { name: 'debug', level: 'info' },
    { name: 'warn', level: 'warn' },
    { name: 'error', level: 'error' }
  ]
  for (const { name, level } of methods) {
    const original = console[name].bind(console)
    console[name] = (...values: unknown[]): void => {
      original(...values)
      writer.append(
        formatDiagnosticLog(new Date().toISOString(), level, 'app', 'console', {
          message: formatConsoleMessage(values)
        })
      )
    }
  }
  writeDiagnosticLog('diagnostics', 'capture.installed', { logPath: diagnosticLogPath() })
}
