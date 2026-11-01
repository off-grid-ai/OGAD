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
 * One form is wiring, not a fake, and is allowed: `vi.mock('<ours>', () => import('<real path>'))`,
 * which points an alias the test config stubs (the free build's `@offgrid/pro/*`) at the real code.
 *
 * The same rule holds for data: a test may not write rows straight into the app's tables
 * (`INSERT INTO`); data enters through the product's own write paths. Every file inside a test
 * folder (harnesses, fixtures, setup files) is held to both rules, not only `*.test.*` files.
 *
 * Files written before the rule are listed in a baseline JSON with how many mocks of ours they
 * still hold. A file outside the list may hold none; a listed file may never gain one; a file down
 * to zero must leave the list. So the list only shrinks. Core and pro each keep their own baseline
 * and run `checkMockBaseline` from their own test.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * The boundary allow-list: modules of ours that are a real boundary for ONE test file, and why.
 * Keep it short; every entry is reviewed like code.
 */
export const BOUNDARY_ALLOW: Readonly<
  Record<string, { modules?: readonly string[]; tables?: readonly string[]; why: string }>
> = {
  'src/renderer/src/bootstrap/__tests__/loadProFeaturesRenderer.test.ts': {
    modules: ['@offgrid/pro/renderer'],
    why: 'The open-core plugin boundary. To the core loader, the private Pro package is an optional, separately built module that may be absent, broken or partial; this test proves the loader survives each.'
  },
  'src/main/__tests__/ai-request-log-retention.dbtest.ts': {
    tables: ['ai_request_logs'],
    why: 'Retention limits need rows the write path cannot produce in a test (thousands of rows, rows days old, 100 MB entries); the rows are the input of the pruning algorithm, compared with a reference.'
  },
  'e2e/entities-evidence.spec.ts': {
    tables: ['entities'],
    why: "Capture history as Pro's capture and analysis pipeline writes it (people found in what was seen, with their observations); the spec reads it in the app."
  },
  'e2e/entities-merge-restore-delete.spec.ts': {
    tables: ['entities'],
    why: "Capture history as Pro's capture and analysis pipeline writes it (people found in what was seen, with their observations); the spec reads it in the app."
  },
  'e2e/tidy-up-0054.spec.ts': {
    tables: ['action_items', 'observations'],
    why: 'What release 0.0.54 left (to-dos with its accepted_at column, a meeting it saved twice); the spec proves the current app tidies it.'
  },
  'e2e/upgrade-0054-profile.spec.ts': {
    tables: ['app_settings'],
    why: 'A profile as release 0.0.54 left it; the spec proves the current app upgrades it.'
  },
  'src/main/__tests__/use-storage.integration.dbtest.ts': {
    tables: ['app_settings'],
    why: "The action engine's own fresh database, holding a table the engine must coexist with; no app write path owns that database."
  },
  'src/main/__tests__/knowledge-document-sync-owner.integration.dbtest.ts': {
    tables: ['rag_documents'],
    why: 'A knowledge-base row in the schema older releases wrote (no sync id); the test proves the upgrade gives it one.'
  },
  'src/main/__tests__/task-history.integration.dbtest.ts': {
    tables: ['task_run_history'],
    why: 'Task rows older releases wrote (their kind and status words, their schema, their uncleaned titles), which no current write path produces; the tests prove the current store reads or skips them.'
  },
  'src/main/__tests__/rag-message-uuid.dbtest.ts': {
    tables: ['rag_conversations', 'rag_messages'],
    why: 'A database from before messages had ids, and a duplicate id the writer can never produce; the tests prove the upgrade backfills ids and the schema refuses duplicates.'
  },
  'src/renderer/src/lib/__tests__/chat-selected-version.test.ts': {
    tables: ['rag_messages'],
    why: 'A message in the format older releases wrote (versions as a list inside the row), which no current write path produces; the test proves the upgrade reads it.'
  }
}

/** Tables written by Pro's capture and analysis pipeline, which open-core tests cannot import.
 *  Core tests seed them only through harness/capture-fixtures.ts, which mirrors Pro's writers and
 *  is checked against them by a Pro contract test. */
export const CAPTURE_TABLES: readonly string[] = [
  'observations',
  'observation_fts',
  'observation_frames',
  'observation_entities',
  'frames',
  'meetings',
  'action_items',
  'entity_edges',
  'entity_facts'
]
export const CAPTURE_FIXTURE_BUILDER = 'src/main/__tests__/harness/capture-fixtures.ts'

/**
 * Tables core has no write path for, which any core test may seed, and why. Every other table is
 * written through the app's own code in tests. Tables a test creates itself (`test_*`) are not
 * product data.
 */
export const BOUNDARY_TABLES: Readonly<Record<string, string>> = Object.fromEntries(
  ['conversations', 'messages', 'memories'].map((table) => [
    table,
    'Written only by older releases; the current app reads, migrates and purges them.'
  ])
)

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
export function mocksOfOurs(
  source: string,
  allowed: readonly string[] = [],
  allowedTables: readonly string[] = []
): string[] {
  const found: string[] = []
  for (const match of source.matchAll(
    /vi\.(?:mock|doMock)\(\s*(?:import\(\s*)?(['"`])([^'"`]+)\1\)?(\s*,\s*(?:async\s*)?\(\)\s*=>\s*import\()?/g
  )) {
    if (isOurs(match[2]!) && !match[3] && !allowed.includes(match[2]!))
      found.push(`mock ${match[2]}`)
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
  // A row written straight into a table tests a guess of the schema, not the product: data
  // enters through the app's own write paths.
  // A trigger's body is schema (it keeps an index in step), not data a test seeds.
  const seeding = source.replace(/CREATE\s+TRIGGER[\s\S]*?\bEND\b/gi, '')
  for (const match of seeding.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_]\w*)/g)) {
    const table = match[1]!
    if (table.startsWith('test_') || table in BOUNDARY_TABLES || allowedTables.includes(table))
      continue
    found.push(`insert ${table}`)
  }
  return found
}

/** Test files anywhere, and every source file inside a test folder (harnesses, fixtures, setup). */
function testFiles(dir: string, inTestFolder = false): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules'
        ? []
        : testFiles(full, inTestFolder || entry.name === '__tests__')
    if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) return []
    return inTestFolder || /\.(test|dbtest|spec)\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

/** Mocks of ours per test file under `dirs`, keyed by path relative to `root`. */
export function scanMocks(
  root: string,
  dirs: string[],
  skip: string[] = [],
  extraFiles: string[] = []
): Record<string, number> {
  const counts: Record<string, number> = {}
  const files = [
    ...dirs.flatMap((dir) => testFiles(path.join(root, dir))),
    ...extraFiles.map((file) => path.join(root, file)).filter((file) => fs.existsSync(file))
  ]
  for (const file of [...new Set(files)]) {
    const relative = path.relative(root, file)
    if (skip.includes(relative)) continue
    const allow = BOUNDARY_ALLOW[relative]
    const count = mocksOfOurs(fs.readFileSync(file, 'utf8'), allow?.modules ?? [], [
      ...(allow?.tables ?? []),
      ...(relative === CAPTURE_FIXTURE_BUILDER ? CAPTURE_TABLES : [])
    ]).length
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
