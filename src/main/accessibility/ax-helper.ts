import fs from 'node:fs'
import path from 'node:path'
import { binRoots, exe } from '../runtime-env'

/** One owner for the shipped native Accessibility helper path. */
export function accessibilityHelperPath(): string | null {
  for (const root of binRoots()) {
    const candidate = path.join(root, exe('text-extractor'))
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // Keep looking through the configured runtime roots.
    }
  }
  return null
}
