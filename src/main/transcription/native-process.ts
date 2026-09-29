import { beginRuntimeBackend } from '../runtime-backends'
/** One abortable child-process boundary for native transcription adapters. */
import { execFile, type ExecFileOptionsWithStringEncoding } from 'child_process'

export interface NativeProcessOptions {
  runtimeModel?: string
  timeout: number
  maxBuffer?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export function runNativeTranscriptionProcess(
  file: string,
  args: readonly string[],
  options: NativeProcessOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const execOptions: ExecFileOptionsWithStringEncoding = {
      encoding: 'utf8',
      timeout: options.timeout,
      ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env ? { env: options.env } : {})
    }
    const backendState = options.runtimeModel ? beginRuntimeBackend('transcription', options.runtimeModel) : undefined
    const child = execFile(file, [...args], execOptions, (error, stdout, stderr) => {
      if (error) backendState?.fail(error)
      else backendState?.stop()
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
    child.stdout?.on('data', (chunk) => backendState?.observe(String(chunk), true))
    child.stderr?.on('data', (chunk) => backendState?.observe(String(chunk), true))
  })
}
