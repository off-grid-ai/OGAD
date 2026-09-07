import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accessibilityHelperPath } from '../accessibility/ax-helper'

const execFileAsync = promisify(execFile)

export type FocusedInputState = 'safe' | 'secure' | 'unknown'

export interface FocusedInputTarget {
  state: FocusedInputState
}

interface FocusedInputInspectorDeps {
  platform: NodeJS.Platform
  helper: () => string | null
  run: (helper: string, args: readonly string[]) => Promise<string>
}

const liveDeps: FocusedInputInspectorDeps = {
  platform: process.platform,
  helper: accessibilityHelperPath,
  async run(helper, args) {
    const { stdout } = await execFileAsync(helper, [...args], {
      timeout: 2_000,
      maxBuffer: 16 * 1024
    })
    return stdout
  }
}

/** Read only the focused field's safety classification. The helper never emits its value. */
export async function inspectFocusedInput(
  deps: FocusedInputInspectorDeps = liveDeps
): Promise<FocusedInputTarget> {
  if (deps.platform !== 'darwin') return { state: 'unknown' }
  const helper = deps.helper()
  if (!helper) return { state: 'unknown' }
  try {
    const parsed = JSON.parse(await deps.run(helper, ['--focused-element'])) as {
      state?: unknown
    }
    return parsed.state === 'safe' || parsed.state === 'secure'
      ? { state: parsed.state }
      : { state: 'unknown' }
  } catch {
    return { state: 'unknown' }
  }
}
