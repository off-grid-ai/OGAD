/**
 * Tests run our own code for real; only the device boundary is faked.
 *
 * The rule: a test file may not `vi.mock` / `vi.doMock` a module of ours, nor `vi.spyOn` one.
 * "Ours" is any relative path, `@offgrid/…` (core, pro, the shared packages), `@renderer/…`, `@/…`
 * and a `src/…` path. Everything else is the boundary and may be faked: electron, Node builtins
 * (fs, child_process, os, http), the network (a local server or the global fetch), the clock,
 * browser globals, and third-party native libraries (onnx, transformers, kokoro). Those are
 * packages or globals, so they never match the rule.
 *
 * Files written before the rule are listed in a baseline JSON with how many mocks of ours they
 * still hold. A file outside the list may hold none; a listed file may never gain one; a file down
 * to zero must leave the list. So the list only shrinks. Core and pro each keep their own baseline
 * and run `checkMockBaseline` from their own test.
 */
import fs from 'node:fs'
import path from 'node:path'

/** A module specifier that names our own code (see the header). */
export function isOurs(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('@offgrid/') ||
    specifier.startsWith('@renderer/') ||
    specifier.startsWith('@/') ||
    /(^|\/)src\//.test(specifier)
  )
}

/** Each mock or spy of our code in one test file's source, as `mock <specifier>` / `spyOn <target>`. */
export function mocksOfOurs(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(
    /vi\.(?:mock|doMock)\(\s*(?:import\(\s*)?(['"`])([^'"`]+)\1/g
  )) {
    if (isOurs(match[2]!)) found.push(`mock ${match[2]}`)
  }
  // Names bound to our modules: import x / import { a, b } / import * as x / await import(...).
  const bound = new Set<string>()
  for (const match of source.matchAll(/import\s+([^'";]+?)\s+from\s+(['"])([^'"]+)\2/g)) {
    if (!isOurs(match[3]!) || /^type\s/.test(match[1]!)) continue
    for (const name of match[1]!.replace(/[{}*]/g, ' ').split(/[\s,]+/)) {
      if (name && name !== 'as' && name !== 'type') bound.add(name)
    }
  }
  for (const match of source.matchAll(
    /(?:const|let|var)\s+([^=]+?)\s*=\s*(?:await\s+import|require)\(\s*(['"])([^'"]+)\2\s*\)/g
  )) {
    if (!isOurs(match[3]!)) continue
    for (const name of match[1]!.replace(/[{}]/g, ' ').split(/[\s,:]+/)) if (name) bound.add(name)
  }
  for (const match of source.matchAll(/vi\.spyOn\(\s*([^,]+),/g)) {
    const target = match[1]!.trim()
    const inline = /(?:import|require)\(\s*(['"])([^'"]+)\1\s*\)/.exec(target)
    const root = target.replace(/^\(+/, '').split(/[.([\s]/)[0]!
    if ((inline && isOurs(inline[2]!)) || bound.has(root)) found.push(`spyOn ${target}`)
  }
  return found
}

function testFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full)
    return /\.(test|dbtest)\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

/** Mocks of ours per test file under `dirs`, keyed by path relative to `root`. */
export function scanMocks(
  root: string,
  dirs: string[],
  skip: string[] = []
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of dirs.flatMap((dir) => testFiles(path.join(root, dir)))) {
    const relative = path.relative(root, file)
    if (skip.includes(relative)) continue
    const count = mocksOfOurs(fs.readFileSync(file, 'utf8')).length
    if (count) counts[relative] = count
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Compare a scan with the baseline file; return each problem. With UPDATE_MOCK_BASELINE=1 the
 * baseline is rewritten from the scan first (run it after fixing files, never to add one).
 */
export function checkMockBaseline(baselineFile: string, now: Record<string, number>): string[] {
  if (process.env.UPDATE_MOCK_BASELINE) {
    fs.writeFileSync(baselineFile, `${JSON.stringify(now, null, 2)}\n`)
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as Record<string, number>
  const name = path.basename(baselineFile)
  const problems: string[] = []
  for (const [file, count] of Object.entries(now)) {
    if (!(file in baseline))
      problems.push(`${file}: mocks our code (${count}); fake only the device boundary`)
    else if (count > baseline[file]!)
      problems.push(`${file}: ${count} mocks of our code, up from ${baseline[file]}`)
  }
  for (const [file, count] of Object.entries(baseline)) {
    if (!(file in now)) problems.push(`${file}: no longer mocks our code; remove it from ${name}`)
    else if (now[file]! < count)
      problems.push(`${file}: down to ${now[file]} from ${count}; lower it in ${name}`)
  }
  return problems
}
