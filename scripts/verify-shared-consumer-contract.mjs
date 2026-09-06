/**
 * Desktop's stale-shared-artifact gate.
 *
 * Desktop consumes `@offgrid/*` as `file:` dependencies, so it compiles against whatever
 * `dist/` happens to be on disk. When a shared package is edited and NOT rebuilt - or rebuilt
 * out of dependency order, so a package's `dist` predates the package it depends on - desktop
 * typechecks against declarations that no longer describe the runtime it will actually load.
 * The failures that produces are the worst kind to debug: a startup stage reports degraded, a
 * facade method is missing at runtime while the editor insists it exists, or a dead comparison
 * against a removed union member silently pins a projection to one branch.
 *
 * This gate answers two questions per package, before any of that can happen:
 *   1. Does the ordered Shared build's content proof match inputs, dependencies and artifacts?
 *   2. Does `dist/` still export the contract desktop's production code is built on?
 *
 * The symbol lists are deliberately the load-bearing ones - the seams desktop cannot start
 * without - not an exhaustive mirror of shared's API. A symbol earns a place here by having
 * broken desktop when it went missing.
 */
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import console from 'node:console'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyWorkspaceProof } from '../../shared/scripts/workspace-build-provenance.mjs'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sharedPackages = path.resolve(desktopRoot, '../shared/packages')

/**
 * `runtime` must be reachable as a real ESM export (the check imports the module, so a
 * declaration that lies about the runtime is caught). `declarations` only need to appear in the
 * emitted `.d.ts`, because types have no runtime identity.
 */
const contract = [
  {
    package: 'application',
    runtime: [
      'createOffGridApplication',
      'parseModelControlIntent',
      'modelsFailureMessage',
      'projectCaptureReadiness',
      'observeApplicationFailures',
      'OFFGRID_SYNC_PORT'
    ],
    declarations: [
      'ModelControlIntent',
      'ModelControlProjection',
      'ModelControlOutcome',
      'ModelsControlPlatformPort',
      'ModelsDownloadPorts',
      'ModelsEvent',
      'ModelsFacade',
      'AutomationFacade',
      'CaptureReadinessProjection',
      'ApplicationStatus'
    ]
  },
  {
    package: 'models',
    runtime: [
      'runtimeModelRouteId',
      'decodeModelRouteId',
      'mergeCatalog',
      'captureInteractionReportIntervalMs'
    ],
    declarations: [
      'ModelWorkspacePorts',
      'ModelInventoryAdapter',
      'GenerationAdapter',
      'ModelLifecycleApplicationPorts',
      'GuidedSetupPorts'
    ]
  },
  {
    package: 'automation',
    runtime: ['AutomationApplication', 'resolveComputerUseContextTokens'],
    declarations: ['AutomationApplicationPorts']
  },
  { package: 'rag', runtime: [], declarations: ['VectorStore'] },
  { package: 'speech', runtime: ['transcriptionLanguages'], declarations: [] },
  { package: 'ui', runtime: ['projectProgress'], declarations: [] }
]

/**
 * Shape facts, not just names. Each one is a contract desktop reads a DECISION from, where a
 * silent change compiles and then behaves wrongly - exactly what happened when
 * `startupPhase` compared `applicationStatus` to `'started'`, a member `ApplicationStatus`
 * has never had, and pinned the startup projection to `pending` forever.
 */
const shapeAssertions = [
  {
    package: 'application',
    description: "ApplicationStatus still declares the 'running' state startup readiness gates on",
    holds: (declarations) => /type ApplicationStatus =[^\n;]*'running'/.test(declarations)
  },
  {
    package: 'application',
    description:
      'ModelsFacade still keeps download hydration private (desktop must never build against it)',
    holds: (declarations) => !/\bhydrateDownloads\b/.test(declarations)
  }
]

const failures = []

try {
  verifyWorkspaceProof(path.dirname(sharedPackages), {
    directory: desktopRoot,
    packages: contract.map((entry) => `@offgrid/${entry.package}`)
  })
} catch (error) {
  failures.push(
    `Shared artifact provenance failed: ${error instanceof Error ? error.message : String(error)}`
  )
}

for (const entry of contract) {
  const packageRoot = path.join(sharedPackages, entry.package)
  // Shared packages do not agree on an ESM entry filename (`index.mjs` in some, `index.js` in
  // others), so ask the manifest rather than guessing - a wrong guess would report a healthy
  // package as missing and teach everyone to ignore this gate.
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    failures.push(`@offgrid/${entry.package}: package.json is missing or unreadable`)
    continue
  }
  const esmEntry = manifest.exports?.['.']?.import ?? manifest.module
  const typesEntry = manifest.exports?.['.']?.types ?? manifest.types
  if (typeof esmEntry !== 'string' || typeof typesEntry !== 'string') {
    failures.push(`@offgrid/${entry.package}: package.json declares no ESM entry or types entry`)
    continue
  }
  const runtimeEntry = path.resolve(packageRoot, esmEntry)
  const declarationEntry = path.resolve(packageRoot, typesEntry)
  const commonJsEntry = manifest.exports?.['.']?.require ?? manifest.main
  const builtEntries = [runtimeEntry, declarationEntry]
  if (typeof commonJsEntry === 'string') {
    builtEntries.push(path.resolve(packageRoot, commonJsEntry))
  }

  try {
    await Promise.all(builtEntries.map((builtEntry) => access(builtEntry, constants.R_OK)))
  } catch {
    failures.push(`@offgrid/${entry.package}: dist is missing - run \`npm run build\` in shared/`)
    continue
  }

  const declarations = await readFile(declarationEntry, 'utf8')
  // A fresh query string defeats the ESM module cache, so a rebuild between runs is seen.
  const runtime = await import(`${pathToFileURL(runtimeEntry).href}?contract-check=${Date.now()}`)

  const missingRuntime = entry.runtime.filter((name) => !(name in runtime))
  const missingDeclarations = entry.declarations.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(declarations)
  )
  if (missingRuntime.length > 0) {
    failures.push(
      `@offgrid/${entry.package}: missing runtime exports - ${missingRuntime.join(', ')}`
    )
  }
  if (missingDeclarations.length > 0) {
    failures.push(
      `@offgrid/${entry.package}: missing declarations - ${missingDeclarations.join(', ')}`
    )
  }

  for (const assertion of shapeAssertions.filter((item) => item.package === entry.package)) {
    if (!assertion.holds(declarations)) {
      failures.push(`@offgrid/${entry.package}: ${assertion.description}`)
    }
  }
}

if (failures.length > 0) {
  console.error('Shared consumer contract failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('\nRebuild shared in dependency order: `npm run build` in shared/.')
  process.exitCode = 1
} else {
  console.log(`Shared consumer contract passed (${contract.length} packages).`)
}
