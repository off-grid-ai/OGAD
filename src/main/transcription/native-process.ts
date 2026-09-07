/** One abortable child-process boundary for native transcription adapters. */
import { execFile, type ExecFileOptionsWithStringEncoding } from 'child_process'

export interface NativeProcessOptions {
  timeout: number
  maxBuffer?: number
  signal?: AbortSignal
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
      ...(options.signal ? { signal: options.signal } : {})
    }
    execFile(file, [...args], execOptions, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}
