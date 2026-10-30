// The `ui_action` allow-list, collected from source at build time (docs/ANALYTICS.md).
//
// Main sends a click's id only when it is in this list. The list holds string literals from the
// app's own source and nothing else: every `data-action`, every `data-testid` and every fixed
// `aria-label` (also `ariaLabel` props, which become one). A computed label such as
// `Delete ${doc.name}` has a template part, so it is skipped; a label read from a variable has no
// literal at all. So no visible text a person typed, and no name of theirs, can ever be in it.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeUiActionId } from '../../src/shared/analytics'

const ATTRIBUTES = ['data-action', 'data-testid', 'aria-label', 'ariaLabel']
const SOURCE = /\.(tsx|ts|js)$/
const SKIP = /(^|\/)(__tests__|node_modules)(\/|$)|\.(test|spec|dbtest)\.[jt]sx?$|\.d\.ts$/

// `attr="x"`, `attr='x'`, `"attr": "x"` (compiled JSX) and `attr={...}` with its literals.
const ATTRIBUTE = new RegExp(
  `["']?(?:${ATTRIBUTES.join('|')})["']?\\s*(?:=|:)\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|\\{([^{}\\n]*(?:\\{[^{}\\n]*\\}[^{}\\n]*)*)\\})`,
  'g'
)
const LITERAL = /"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`$\\\n]*)`/g

/** The fixed ids in one file's text, normalised. */
export function uiActionIdsInSource(text: string): string[] {
  const ids: string[] = []
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return
    const id = normalizeUiActionId(raw)
    if (id) ids.push(id)
  }
  for (const match of text.matchAll(ATTRIBUTE)) {
    if (match[1] !== undefined || match[2] !== undefined) {
      add(match[1] ?? match[2])
      continue
    }
    // An expression: only its whole string literals. A template literal with a `${}` part never
    // matches LITERAL, so a computed label contributes nothing.
    for (const literal of (match[3] ?? '').matchAll(LITERAL))
      add(literal[1] ?? literal[2] ?? literal[3])
  }
  return ids
}

function walk(root: string, dir: string, files: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    // Tested below the root, so a root inside node_modules (the UI library) is still read.
    if (SKIP.test(path.slice(root.length))) continue
    const stats = statSync(path)
    if (stats.isDirectory()) walk(root, path, files)
    else if (SOURCE.test(entry)) files.push(path)
  }
}

/** Every fixed id under the given source roots, sorted and unique. Missing roots are skipped. */
export function collectUiActionIds(roots: string[]): string[] {
  const files: string[] = []
  for (const root of roots) walk(root, root, files)
  const ids = new Set<string>()
  for (const file of files) {
    for (const id of uiActionIdsInSource(readFileSync(file, 'utf8'))) ids.add(id)
  }
  return [...ids].sort()
}
