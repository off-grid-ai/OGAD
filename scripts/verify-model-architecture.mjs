#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { temporaryModelArchitectureAllowlist } from './model-architecture-allowlist.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const roots = [path.join(repoRoot, 'src'), path.join(repoRoot, 'pro')]

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return []
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)
      ? [absolute]
      : []
  })
}

const files = roots.flatMap(sourceFiles)
const relative = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const nodeText = (source, node) => node.getText(source).replace(/\s+/g, ' ')
const lineOf = (source, node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
const keyOf = (finding) => `${finding.rule}|${finding.file}|${finding.detail}`
const findings = []
const forbiddenModelOwnerExports = new Set(['createModelWorkspace', 'ModelResidencyManager'])
const forbiddenDownloadOwnerExports = new Set(['ModelDownloadCoordinator', 'ModelDownloadHandle'])

const legacyDownloadQueue = path.join(repoRoot, 'src/main/models/download-queue.ts')
if (fs.existsSync(legacyDownloadQueue)) {
  findings.push({
    rule: 'desktop-model-download-coordinator-is-shared',
    file: relative(legacyDownloadQueue),
    line: 1,
    detail: 'restored app-owned download queue compatibility surface'
  })
}

for (const legacyOwner of [
  'src/main/models/desktop-model-download-service.ts',
  'src/main/composition/model-downloads.ts'
]) {
  if (fs.existsSync(path.join(repoRoot, legacyOwner))) {
    findings.push({
      rule: 'models-facade-owns-download-lifecycle',
      file: legacyOwner,
      line: 1,
      detail: 'app-owned model download coordinator/control plane remains'
    })
  }
}

/**
 * ---- residency-admission-has-one-owner -----------------------------------------------------------
 *
 * THE INVARIANT: every LOCAL model that can stay resident in memory loads through
 * `ModelResidencyManager`. It owns admission, co-residency, eviction, leases, budgeting, overrides
 * and reclaim failures. Platform code performs the native load/unload ONLY as an adapter the manager
 * invokes, and never decides residency policy. Call direction is fixed: app -> `ModelsFacade` ->
 * residency manager -> native adapter.
 *
 * WHY A GATE AND NOT A COMMENT: mobile's `adapters/native/modelLoaders.ts` states this invariant in
 * its header. The claim is TRUE at HEAD - its one caller does go through the manager - and nothing
 * stops the next call site from bypassing it, while the comment keeps reassuring every reader. A
 * true claim with no enforcement decays into a false one silently, and the comment is what makes the
 * decay invisible.
 *
 * HOW IT MATCHES, and why not by receiver name: an earlier scan of ours anchored on `await
 * desktopRag.` and was therefore blind to every injected facade - which is every hexagonal file. So
 * this rule anchors on the ENGINE MODULE, not on a variable: it records the local bindings a file
 * obtains from an engine module - static import, namespace import, or `const { x } = await
 * import(...)`, which is how the real adapter reaches them - and only then looks at member calls on
 * those bindings. Renaming the variable cannot evade it - verified with a probe that renamed both
 * forms (`renamedEngine.unload()`, and `const { imageRuntime: alias } = await import(...)` then
 * `alias.evict()`); both were caught.
 *
 * WHAT THIS GATE CANNOT SEE. A gate that silently misses a class of bypass is as bad as the comment
 * it replaces, so the blind spots are written here rather than discovered later:
 *
 * 1. AN INJECTED PORT. A file handed a `GenerationAdapter` or `DesktopManagedRuntime` as a parameter
 *    and calling `.unload()` on it is indistinguishable from any other object - there is no import
 *    to anchor on. This is the biggest hole and it is unavoidable HERE, because it is also exactly
 *    how the legitimate path works. What narrows it is the import graph: dependency-cruiser decides
 *    which modules may obtain such a port at all.
 * 2. A RE-EXPORT CHAIN. `export { llm } from './llm'` in an intermediate module, imported from
 *    there, is invisible: this rule anchors on the engine specifier and does not resolve re-exports.
 * 3. A COMPUTED MEMBER - `engine[name]()` where `name` is a variable.
 * 4. CROSS-PROCESS. A renderer that invokes an IPC channel which loads in main has no engine import
 *    of its own. The main-side handler is where it is catchable, and `src/main/ipc.ts` is exactly
 *    that case, caught there.
 * 5. ANYTHING OUTSIDE TYPESCRIPT - a spawned binary or shell that loads a model itself.
 * 6. THE THIRD CARVE-OUT IS WHERE THIS GATE IS WEAKEST, and it must be said plainly. A truly
 *    short-lived process that retains no model memory needs no admission - but `src/main/tts.ts`'s
 *    `evict: () => {}` is honest only BECAUSE its ExecuTorch process exits and releases everything,
 *    and that is asserted by a comment this gate cannot verify. A process INTENDED to be short-lived
 *    can survive SIGKILL and still hold model memory, so the carve-out must mean PROVEN exited, not
 *    intended to exit. Proving exit is a runtime fact; this rule sees only the call. Do not widen the
 *    carve-out on the strength of a comment - that is the failure this rule exists to prevent.
 */
const residencyEngineModules = new Map([
  ['./llm', 'llama text engine'],
  ['./imagegen', 'diffusion image engine'],
  ['./tts', 'speech synthesis engine'],
  ['./transcription/select', 'speech-to-text engine'],
  ['./embeddings', 'native embedding worker'],
  ['./sd-server', 'diffusion server process'],
  ['./transcription/whisper-server', 'whisper server process']
])
/** Members that CHANGE residency. Deliberately not `generate`/`chat`: those consume, not admit. */
const residencyLifecycleMembers = new Set([
  'init',
  'initNative',
  'warm',
  'restart',
  'unload',
  'unloadNative',
  'evict',
  'release',
  'stop'
])
/**
 * The only files that may touch a native lifecycle member, each because the manager invokes it or
 * composes what the manager invokes. This list is SHORT by design: if it needs to grow, the call
 * direction is wrong, not the list.
 */
const residencyAdapterFiles = new Set([
  'src/main/model-generation-adapters.ts', // the GenerationAdapter set the manager drives
  'src/main/composition/model-lifecycle.ts', // composes the residency handlers from those adapters
  'src/main/model-runtime-port.ts' // the DesktopManagedRuntime contract itself
])
const engineModuleFor = (specifier) => {
  for (const [suffix, label] of residencyEngineModules) {
    const bare = suffix.replace(/^\.\//, '')
    if (specifier === suffix || specifier.endsWith(`/${bare}`)) return label
  }
  return null
}

function checkResidencyAdmission(fileName, source) {
  if (residencyAdapterFiles.has(fileName)) return
  // An engine module may of course drive its own process.
  if (
    [...residencyEngineModules.keys()].some(
      (suffix) => fileName === `src/main/${suffix.replace(/^\.\//, '')}.ts`
    )
  ) {
    return
  }
  const bindings = new Map()
  const bind = (name, label) => {
    if (name) bindings.set(name, label)
  }
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const label = engineModuleFor(node.moduleSpecifier.text)
      if (label && node.importClause) {
        const named = node.importClause.namedBindings
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) bind(element.name.text, label)
        }
        if (named && ts.isNamespaceImport(named)) bind(named.name.text, label)
        if (node.importClause.name) bind(node.importClause.name.text, label)
      }
    }
    // `const { imageRuntime } = await import('./imagegen')` - how the real adapter reaches engines.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (
        ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializer.arguments[0] &&
        ts.isStringLiteral(initializer.arguments[0])
      ) {
        const label = engineModuleFor(initializer.arguments[0].text)
        if (label) {
          if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              if (ts.isIdentifier(element.name)) bind(element.name.text, label)
            }
          } else if (ts.isIdentifier(node.name)) {
            bind(node.name.text, label)
          }
        }
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  if (bindings.size === 0) return

  const flag = (node, detail) =>
    report('residency-admission-has-one-owner', fileName, source, node, detail)
  const inspect = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        bindings.has(callee.expression.text) &&
        residencyLifecycleMembers.has(callee.name.text)
      ) {
        flag(
          node,
          `native lifecycle call outside the residency adapter: ${callee.expression.text}.${callee.name.text}() on the ${bindings.get(callee.expression.text)}`
        )
      }
      if (
        ts.isIdentifier(callee) &&
        bindings.has(callee.text) &&
        residencyLifecycleMembers.has(callee.text)
      ) {
        flag(
          node,
          `native lifecycle call outside the residency adapter: ${callee.text}() on the ${bindings.get(callee.text)}`
        )
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
}

/** The application root is the only owner allowed to construct the workspace or residency manager. */
function checkModelOwnerConstruction(fileName, source) {
  const inspect = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('@offgrid/models') &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      node.importClause.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text
        if (!element.isTypeOnly && forbiddenModelOwnerExports.has(imported)) {
          report(
            'application-root-owns-model-workspace',
            fileName,
            source,
            element,
            `runtime import of ${imported}`
          )
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const initializer = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (
        ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializer.arguments[0] &&
        ts.isStringLiteral(initializer.arguments[0]) &&
        initializer.arguments[0].text.startsWith('@offgrid/models')
      ) {
        for (const element of node.name.elements) {
          const imported =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : ts.isIdentifier(element.name)
                ? element.name.text
                : ''
          if (forbiddenModelOwnerExports.has(imported)) {
            report(
              'application-root-owns-model-workspace',
              fileName,
              source,
              element,
              `dynamic runtime import of ${imported}`
            )
          }
        }
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
}

function checkDownloadOwnerImports(fileName, source) {
  const inspect = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('@offgrid/models') &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text
        if (forbiddenDownloadOwnerExports.has(imported)) {
          report(
            'models-facade-owns-download-lifecycle',
            fileName,
            source,
            element,
            `import of ${imported}`
          )
        }
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
}

/**
 * ---- models-facade-owns-shared-model-services ---------------------------------------------------
 *
 * THE INVARIANT: an `@offgrid/models` application service whose construction the shared facade
 * layer (`@offgrid/application`) already owns has exactly ONE constructor. Desktop reaches that
 * capability as a command on `ModelsFacade` and never constructs the service a second time.
 *
 * WHAT THIS RULE DOES AND DOES NOT FORBID. It does NOT forbid constructing a shared service at an
 * app composition root - measured, that is the normal legal pattern here: 24 `new X()` sites in
 * `src/**` + `pro/**` construct a runtime import of `@offgrid/models`, 14 of them a `*Service`, and
 * ten of those are legitimate roots (`composition/imagegen.ts`, `composition/mcp.ts`,
 * `composition/tools.ts`, `composition/artifact-verification.ts`, `pro/main/composition/*`, ...).
 * A rule on that SHAPE alone would need a ten-entry-and-growing exemption list, which is the
 * codebase, not an exemption. The hazard is not the construction - it is a SECOND OWNER. So this
 * rule forbids exactly the duplicate: constructing what the facade layer already constructs.
 *
 * THE ESCAPE IT CLOSES. Every other model rule here anchors on an ENGINE MODULE specifier or on a
 * hand-written list of two owner exports, so an app composition root importing and constructing a
 * shared application service looked legitimate to all of them. That is how
 * `ModelMetadataRepairCommandService` came to have two owners with the gate green:
 * `src/main/composition/model-library.ts` constructed it while
 * `@offgrid/application/src/models/download-metadata-repair.ts:15` already did. Found statically
 * here (two constructors of one facade-owned class) and independently found behaviourally (two
 * instances over one `activeProjectorRepairPorts` object, composed at
 * `src/main/models/desktop-model-download-ports.ts` and handed to the root by `models-manager.ts`).
 * This rule catches the CLASS without needing that port analysis, which is what makes it a gate
 * rather than a one-time finding.
 *
 * WHY THE SET IS DERIVED AND NOT LISTED. A hand-list of today's names is precisely how the gate
 * came to miss this: it falls behind the day a fifth service is added, silently. So the forbidden
 * set is derived at gate time from the facade layer's OWN source - every identifier that
 * `@offgrid/application/src/**` constructs and imports from `@offgrid/models`. A fifth facade-owned
 * service is forbidden in app code the moment the facade owns it, with no edit to this file.
 *
 * WHY THE FACADE LAYER AND NOT `@offgrid/models` ITSELF. Deriving from the models package's own
 * internals was measured too: it adds `ArtifactVerificationService` and
 * `ImageGenerationApplicationService`, which two desktop roots construct with no shared owner -
 * two findings that are not duplicate ownership and could only be silenced by an allowlist entry.
 * The facade layer is the layer that OWNS, so it is the only honest derivation source.
 *
 * FAILURE DIRECTION. If the derivation source cannot be read, or derives to nothing, this rule
 * REPORTS instead of passing: a derived set that cannot be derived is a dead gate, and a dead gate
 * that reports success is worse than no gate.
 *
 * WHAT THIS RULE CANNOT SEE. Written here rather than discovered later:
 *
 * 1. AN INJECTED OR FACTORY-PASSED INSTANCE. A file handed an already-constructed service has no
 *    import and no `new` to anchor on. The import graph (dependency-cruiser) is what narrows this.
 * 2. A LOCAL RE-EXPORT BARREL. `export { LocalModelImportService } from '@offgrid/models'` in an
 *    intermediate module, constructed from there: this rule anchors on the package specifier and
 *    does not resolve re-export chains.
 * 3. AN ALIASED LOCAL VALUE or INDIRECT CONSTRUCTION - `const S = Svc; new S()`,
 *    `new registry[name]()`, `Reflect.construct(Svc, ...)`.
 * 4. AN OWNER THAT MOVES DOWN. If the facade layer stops constructing a service because the
 *    construction moved into `@offgrid/models` internals, that name silently LEAVES the derived
 *    set. The derivation follows ownership; it cannot tell a relocation from an abandonment.
 * 5. TYPE-ONLY POSITIONS, deliberately. `ConstructorParameters<typeof ModelLibraryRemovalService>`
 *    is how a root declares its port shape and must stay legal.
 * 6. ANYTHING OUTSIDE TYPESCRIPT, and any CROSS-PROCESS path - a renderer reaching a service only
 *    through IPC is catchable at the main-side handler, not here.
 */
const facadeLayerSourceRoot = path.join(repoRoot, 'node_modules/@offgrid/application/src')
const modelsPackage = '@offgrid/models'

/** Local bindings a file obtains from `@offgrid/models`, mapped to the name it imported. */
function modelsRuntimeBindings(source) {
  const named = new Map()
  const namespaces = new Set()
  const bind = (local, imported) => {
    if (local && imported) named.set(local, imported)
  }
  const collect = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(modelsPackage) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const bindings = node.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly)
            bind(element.name.text, (element.propertyName ?? element.name).text)
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      if (node.importClause.name) bind(node.importClause.name.text, node.importClause.name.text)
    }
    // `const { LocalModelImportService: alias } = await import('@offgrid/models')`
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (
        ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializer.arguments[0] &&
        ts.isStringLiteral(initializer.arguments[0]) &&
        initializer.arguments[0].text.startsWith(modelsPackage)
      ) {
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue
            const imported =
              element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text
            bind(element.name.text, imported)
          }
        } else if (ts.isIdentifier(node.name)) {
          namespaces.add(node.name.text)
        }
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  return { named, namespaces }
}

/** Every `@offgrid/models` export a file constructs, as `{ imported, node }`. */
function constructedModelsExports(source) {
  const { named, namespaces } = modelsRuntimeBindings(source)
  if (named.size === 0 && namespaces.size === 0) return []
  const constructed = []
  const inspect = (node) => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && named.has(callee.text)) {
        constructed.push({ imported: named.get(callee.text), node })
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        constructed.push({ imported: callee.name.text, node })
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
  return constructed
}

function deriveFacadeOwnedModelServices() {
  const owned = new Set()
  if (!fs.existsSync(facadeLayerSourceRoot)) return { owned, failure: 'source root is missing' }
  for (const file of sourceFiles(facadeLayerSourceRoot)) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes(modelsPackage)) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    for (const { imported } of constructedModelsExports(source)) owned.add(imported)
  }
  return {
    owned,
    failure: owned.size === 0 ? 'derived to nothing, so the rule would enforce nothing' : null
  }
}

const facadeOwned = deriveFacadeOwnedModelServices()
if (facadeOwned.failure) {
  findings.push({
    rule: 'models-facade-owns-shared-model-services',
    file: 'scripts/verify-model-architecture.mjs',
    line: 1,
    detail: `cannot derive facade-owned services from @offgrid/application: ${facadeOwned.failure}`
  })
}

function checkFacadeOwnedServiceConstruction(fileName, source) {
  for (const { imported, node } of constructedModelsExports(source)) {
    if (!facadeOwned.owned.has(imported)) continue
    report(
      'models-facade-owns-shared-model-services',
      fileName,
      source,
      node,
      `second owner of ${imported}: @offgrid/application already constructs it, so reach it as a ModelsFacade command`
    )
  }
}

function report(rule, file, source, node, detail) {
  findings.push({ rule, file, line: lineOf(source, node), detail })
}

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const fileName = relative(file)
  const isUi =
    /^src\/(renderer\/src\/(components|hooks|screens)|.*\/(components|hooks|screens))\//.test(
      fileName
    )
  const isAdapter =
    /(^|\/)(adapters?|model-generation-adapters|remote-chat|remote-media-runtime)(\/|\.|$)/.test(
      fileName
    )
  const isRendererProduction =
    fileName.startsWith('src/renderer/src/') || fileName.startsWith('pro/renderer/')

  const modelControlComponents = new Set([
    'src/renderer/src/components/ModelsScreen.tsx',
    'src/renderer/src/components/ModelPicker.tsx',
    'pro/renderer/components/voice/TranscriptionModels.tsx'
  ])
  if (
    fileName === 'src/renderer/src/lib/model-control-client.ts' &&
    (!/\bgetModelControlProjection\b/.test(text) ||
      /\bapi\(\)\.(?:getActiveModel|getActiveModelIds|getActiveModalities|getModelCatalog|getInstalledModels|getComputerUseActiveModels)\b/.test(
        text
      ))
  ) {
    report(
      'desktop-model-control-reads-one-main-snapshot',
      fileName,
      source,
      source,
      'renderer model-control adapter uses split model-state reads'
    )
  }
  if (
    isRendererProduction &&
    fileName !== 'src/renderer/src/lib/model-control-client.ts' &&
    /\b(?:getModelCatalog|getInstalledModels|getActiveModel|getActiveModelIds|getActiveModalities)\s*(?:\?\.)?\s*\(/.test(
      text
    )
  ) {
    report(
      'desktop-model-control-reads-one-main-snapshot',
      fileName,
      source,
      source,
      'renderer reads a split model-state endpoint instead of the coherent projection'
    )
  }
  if (
    isRendererProduction &&
    fileName !== 'src/renderer/src/lib/model-control-client.ts' &&
    /\b(?:window\.)?api\s*(?:\?\.|\.)\s*(?:activateModel|setActiveModalModel|cancelModelDownload)\s*(?:\?\.)?\s*\(/.test(
      text
    )
  ) {
    report(
      'desktop-model-control-command-is-shared',
      fileName,
      source,
      source,
      'renderer calls a raw model mutation endpoint instead of the typed application service'
    )
  }
  if (
    fileName === 'src/main/models-manager.ts' &&
    /\b(?:DesktopModelDownloadService|ModelLibraryDownloadService|DownloadStatusLedger|ModelDownloadQueue|runSequentialArtifactDownload)\b/.test(
      text
    )
  ) {
    report(
      'desktop-model-download-coordinator-is-shared',
      fileName,
      source,
      source,
      'deprecated or app-owned download workflow'
    )
  }
  if (
    fileName === 'src/main/imagegen.ts' &&
    (!/\bdesktopImageRuntimeIdentity\.resolve\b/.test(text) || /\bprimaryFileName\b/.test(text))
  ) {
    report(
      'desktop-image-runtime-identity-has-one-adapter',
      fileName,
      source,
      source,
      'image generation derives a native image identity outside the canonical Desktop adapter'
    )
  }
  if (
    fileName === 'src/main/models-manager.ts' &&
    !/\bdesktopImageRuntimeIdentity\.resolve\b/.test(text)
  ) {
    report(
      'desktop-image-runtime-identity-has-one-adapter',
      fileName,
      source,
      source,
      'model library does not use the canonical Desktop image-runtime identity adapter'
    )
  }
  if (
    fileName.startsWith('src/main/imagegen/') &&
    /\b(?:const|let|var)\s+DEFAULT\w*NEGATIVE\w*\s*=|blurry,\s*low quality,\s*low resolution/i.test(
      text
    )
  ) {
    report(
      'image-negative-prompt-default-is-shared',
      fileName,
      source,
      source,
      'image adapter declares a local negative-prompt default'
    )
  }
  if (fileName === 'src/main/index.ts' && /from\s+['"]\.\/models\/download-queue['"]/.test(text)) {
    report(
      'desktop-model-download-coordinator-is-shared',
      fileName,
      source,
      source,
      'production shutdown uses a second queue owner'
    )
  }
  if (
    modelControlComponents.has(fileName) &&
    (!/\bmodelControlClient\.control\b/.test(text) ||
      /\bdesktopModelControl\b/.test(text) ||
      /\b(?:ModelActivationCommandService|ModelInstallActivationCommandService|primaryFile)\b|\bapi(?:\(\))?\??\.(?:activateModel|downloadModel|cancelModelDownload|unloadRuntime|getActiveModel|getActiveModelIds|getActiveModalities|getInstalledModels)\b/.test(
        text
      ))
  ) {
    report(
      'desktop-model-control-command-is-shared',
      fileName,
      source,
      source,
      'renderer-owned model identity, activation, transfer, unload, or refresh workflow'
    )
  }

  if (
    new Set([
      'pro/main/crm/agent-rank.ts',
      'pro/main/crm/capture-input-budget.ts',
      'pro/main/ingest-helpers.ts'
    ]).has(fileName)
  ) {
    report('desktop-pro-policy-is-shared', fileName, source, source, 'restored:local-policy-module')
  }
  if (
    fileName === 'pro/main/crm/agent.ts' &&
    // Either names the shared service, or calls it through the composition root that constructs it
    // (pro `7493428` moved the ports there to break a cycle). Local policy is still forbidden below.
    (!/\b(?:ProactiveActionApplicationService|proactiveActionApplication)\b/.test(text) ||
      !/\b(?:ProactiveToolCatalogService|proactiveToolCatalog)\b/.test(text) ||
      /\b(?:extractJson|toolScore|isActionTool|jaccard|sameSubject)\b|\bconst\s+(?:prompt|gate)\s*=|Return JSON only/.test(
        text
      ))
  ) {
    report(
      'desktop-proactive-action-policy-is-shared',
      fileName,
      source,
      source,
      'local proactive prompt, profile, parsing, ranking, or missing shared service'
    )
  }
  if (
    fileName === 'pro/main/ingest.ts' &&
    // Same as above: the connector services are constructed in the composition root now.
    (!/\b(?:ConnectorReadApplicationService|connectorReadApplication)\b/.test(text) ||
      !/\b(?:ConnectorDistillApplicationService|connectorDistillApplication)\b/.test(text) ||
      /\b(?:DISTILL_SCHEMA|extractJson|pickReadTool|buildArgs|structuredItems)\b|\bconst\s+prompt\s*=|\b(?:maxTokens|temperature|disableThinking)\s*:/.test(
        text
      ))
  ) {
    report(
      'desktop-connector-ingest-policy-is-shared',
      fileName,
      source,
      source,
      'local ingest prompt, profile, parsing, selection, or missing shared service'
    )
  }
  if (
    /^pro\/main\//.test(fileName) &&
    /\b(?:VISION_IMAGE_TOKEN_ESTIMATE|OBSERVATION_RESERVE_TOKENS|OBSERVATION_OVERHEAD_TOKENS|MAX_MATERIAL_CHARS|MIN_MATERIAL_CHARS)\b\s*=|\bfunction\s+planCaptureInput\b/.test(
      text
    )
  ) {
    report(
      'desktop-capture-input-budget-is-shared',
      fileName,
      source,
      source,
      'local capture input budget policy'
    )
  }

  if (
    fileName === 'src/renderer/src/components/PermissionGate.tsx' &&
    /\b(?:getActiveModel|getModelVisionStatus|downloadModel|checkCaptureVision|VisionIssue)\b|proInvoke\s*\(\s*['"]capture:status['"]/.test(
      text
    )
  ) {
    report(
      'desktop-capture-readiness-is-shared',
      fileName,
      source,
      source,
      'renderer-owned capture readiness or repair policy'
    )
  }
  if (
    fileName === 'src/renderer/src/components/use-capture-readiness.ts' &&
    (!/\bcaptureReadinessClient\b/.test(text) ||
      /\bcaptureReadinessApplication\b|@renderer\/composition\/capture-readiness/.test(text))
  ) {
    report(
      'desktop-capture-readiness-is-shared',
      fileName,
      source,
      source,
      'missing shared capture-readiness application service'
    )
  }

  if (
    fileName === 'src/main/tools/planner-logic.ts' &&
    /\b(?:function\s+(?:shouldPlan|buildPlannerPrompt|parsePlanResult|backfillGoals|resolveContactHandle)|const\s+(?:PLAN_SCHEMA|WEBSITE_HINTS))\b/.test(
      text
    )
  ) {
    report('desktop-tool-planning-is-shared', fileName, source, source, 'local:planner-policy')
  }

  if (fileName === 'src/main/mcp.ts' && /Promise\.race\s*\(|setTimeout\s*\(/.test(text)) {
    report('connector-timeout-policy-is-shared', fileName, source, source, 'local:timeout-race')
  }
  if (
    fileName === 'src/main/mcp.ts' &&
    (!/\bMcpConnectorApplicationService\b/.test(text) ||
      !/connectorApplication\.verifyAndDiscover\s*\(/.test(text) ||
      !/connectorApplication\.discoverInBackground\s*\(/.test(text) ||
      !/connectorApplication\.remove\s*\(/.test(text) ||
      !/removeWithCredentials\s*\(/.test(text) ||
      !/\.transaction\s*\(/.test(text))
  ) {
    report(
      'desktop-mcp-lifecycle-is-shared',
      fileName,
      source,
      source,
      'app-owned connector lifecycle, cleanup, or discovery workflow'
    )
  }

  if (
    fileName === 'src/main/rag/index.ts' &&
    /(?:chunkSize\s*:\s*600|overlap\s*:\s*120|minChunkLength\s*:\s*20|dimension\s*:\s*384)/.test(
      text
    )
  ) {
    report('rag-profile-is-shared', fileName, source, source, 'local:rag-profile-default')
  }

  if (/\bresidencyMode\b/.test(text)) {
    report(
      'runtime-model-has-one-lifecycle-vocabulary',
      fileName,
      source,
      source,
      'deprecated:residencyMode'
    )
  }

  if (
    /^(?:src\/main\/(?:sd-server|transcription\/whisper-server))\.ts$/.test(fileName) &&
    /private idleMs\s*=\s*(?:60_000|5\s*\*\s*60_000)|return JSON\.stringify\(/.test(text)
  ) {
    report(
      'resident-engine-lifecycle-policy-is-shared',
      fileName,
      source,
      source,
      'app-owned resident identity or idle-eviction policy'
    )
  }

  if (
    fileName === 'src/main/llm.ts' &&
    /\b(?:safeTextContext|textRuntimeModeBudget)\b/.test(text)
  ) {
    report(
      'desktop-text-context-policy-is-shared',
      fileName,
      source,
      source,
      'app-owned RAM/context clamp policy'
    )
  }

  if (
    fileName === 'src/main/vision/vision-policy-runner.ts' &&
    /\b(?:priorInvalidAnswer|priorValidationError|allowFallback\s*:\s*false|computerUseEmptyDecisionFeedback)\b/.test(
      text
    )
  ) {
    report(
      'computer-use-request-policy-is-shared',
      fileName,
      source,
      source,
      'app-owned retry, validation, reasoning fallback, or generation profile'
    )
  }
  if (
    fileName === 'src/main/vision/vision-policy-runner.ts' &&
    !/\brunComputerUsePolicy\s*\(/.test(text)
  ) {
    report(
      'computer-use-request-policy-is-shared',
      fileName,
      source,
      source,
      'missing shared policy application service'
    )
  }

  if (
    fileName === 'src/main/vision/vision-task-model-strategy.ts' &&
    /strategyLabel\s*:\s*['"]|role\s*:\s*['"](?:reasoner|grounding_specialist)['"]/.test(text)
  ) {
    report(
      'computer-use-role-routing-is-shared',
      fileName,
      source,
      source,
      'app-owned model role or strategy label'
    )
  }
  if (
    fileName === 'src/main/vision/vision-task-model-strategy.ts' &&
    !/\bresolveComputerUseRoleProjection\s*\(/.test(text)
  ) {
    report(
      'computer-use-role-routing-is-shared',
      fileName,
      source,
      source,
      'missing shared role projection'
    )
  }
  if (
    fileName === 'src/main/vision/vision-task-model-strategy.ts' &&
    (!/\bComputerUseSessionApplicationService\b/.test(text) ||
      /\bresolveComputerUseExecutionPlan\b|\bplan\.(?:mode|source)\b/.test(text))
  ) {
    report(
      'computer-use-session-orchestration-is-shared',
      fileName,
      source,
      source,
      'app-owned Computer Use session strategy branch or missing shared application service'
    )
  }

  if (
    fileName === 'src/main/vision/grounder-loader.ts' &&
    /\b(?:resolveGrounderLoadPlan|runRestoredModelSwap|loadPlan\s*===|previousLocalId\s*=)\b/.test(
      text
    )
  ) {
    report(
      'computer-use-model-swap-transaction-is-shared',
      fileName,
      source,
      source,
      'app-owned specialist swap or restoration transaction'
    )
  }
  if (
    fileName === 'src/main/vision/grounder-loader.ts' &&
    !/\bcreateGrounderApplicationService\s*\(/.test(text)
  ) {
    report(
      'computer-use-model-swap-transaction-is-shared',
      fileName,
      source,
      source,
      'missing shared grounder application service'
    )
  }

  if (
    fileName === 'src/renderer/src/components/SettingsPanel.tsx' &&
    /(?:temperature:\s*0\.7|topP:\s*0\.95|topK:\s*40|repeatPenalty:\s*1\.1)/.test(text)
  ) {
    report(
      'model-configuration-defaults-are-shared',
      fileName,
      source,
      source,
      'local:text-default'
    )
  }

  if (
    /^(?:src\/main\/models\/(?:gguf|download-verify)|src\/main\/models-manager)\.ts$/.test(
      fileName
    ) &&
    /\b(?:GGUF_MAGIC|GGUF_MIN_BYTES|isValidGgufHeader|isValidGgufFile)\b|\.corruption\b|toString\(['"]ascii['"]\)\s*===?\s*['"]GGUF/.test(
      text
    )
  ) {
    report(
      'artifact-verification-policy-is-shared',
      fileName,
      source,
      source,
      'app-owned format, size, or corruption branch'
    )
  }

  if (
    /^(?:src\/main\/tools\/(?:memory-scope|extension-select)|src\/shared\/llm-defaults)\.ts$/.test(
      fileName
    )
  ) {
    report(
      'desktop-tool-policy-is-shared',
      fileName,
      source,
      source,
      `file:${path.basename(fileName)}`
    )
  }

  if (
    fileName === 'src/main/vision/remote-vision-server.ts' &&
    /\b(?:activateRemoteServerConfiguration|deactivateRemoteServerConfiguration|removeRemoteServerConfiguration|upsertRemoteServerConfiguration)\b/.test(
      text
    )
  ) {
    report(
      'remote-server-workflow-is-shared',
      fileName,
      source,
      source,
      'adapter:direct-remote-configuration-mutation'
    )
  }

  checkResidencyAdmission(fileName, source)
  checkModelOwnerConstruction(fileName, source)
  checkDownloadOwnerImports(fileName, source)
  checkFacadeOwnedServiceConstruction(fileName, source)

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (
        isUi &&
        /(llama|litert|whisper|local[-_]?dream|imagegen\/(?:job|runtime)|image[-_]?generation[-_]?(?:service|engine)|providers?\/)/i.test(
          specifier
        )
      ) {
        report('ui-does-not-import-raw-model-engine', fileName, source, node, `import:${specifier}`)
      }
      if (
        !/^(src\/main\/(models-manager|model-services)\.ts)$/.test(fileName) &&
        /(?:^|\/)active-models$/.test(specifier) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          if (/^setActive/.test(element.name.text)) {
            report(
              'active-model-writes-use-canonical-selection-port',
              fileName,
              source,
              element,
              `import:${element.name.text}`
            )
          }
        }
      }
      if (/(?:^|\/)active-models$/.test(specifier)) {
        report(
          'no-active-models-compatibility-facade',
          fileName,
          source,
          node,
          `import:${specifier}`
        )
      }
      if (
        fileName === 'src/main/imagegen.ts' &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          if (
            /^(?:selectInstalledImageModel|enhanceImagePrompt|ImageGenerationJobCoordinator)$/.test(
              element.name.text
            )
          ) {
            report(
              'desktop-image-policy-is-shared',
              fileName,
              source,
              element,
              `import:${element.name.text}`
            )
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const call = nodeText(source, node.expression)
      const rawName = call.split('.').at(-1)
      if (call === 'llm.init' && fileName !== 'src/main/model-generation-adapters.ts') {
        report('native-text-loads-use-shared-residency', fileName, source, node, `call:${call}`)
      }
      if (/^(chat|chatMessages|chatStream|streamChat)$/.test(rawName)) {
        report('no-route-owning-llm-api', fileName, source, node, `call:${rawName}`)
      }
      if (
        /^(generateResponse|generateResponseWithTools|generateWithMaxTokens|generateToolSelection)$/.test(
          rawName
        )
      ) {
        report('generation-callers-use-shared-service', fileName, source, node, `call:${rawName}`)
      }
      if (
        fileName === 'src/main/tools.ts' &&
        /^(?:rankToolSchemas|rankToolSchemasByEmbedding|budgetToolSchemas|nativeToolPlannerUnavailableMessage|llm\.init|llm\.hasVision)$/.test(
          call
        )
      ) {
        report('desktop-tool-policy-is-shared', fileName, source, node, `call:${call}`)
      }
      if (
        isUi &&
        /^(?:window\.api\.)?(?:generateImage|toolChat|ragChat|cancelRag|cancelImageGen)$/.test(call)
      ) {
        report('desktop-ui-uses-one-chat-command-boundary', fileName, source, node, `call:${call}`)
      }
      if (/^(sendWithTools|sendImage)$/.test(rawName)) {
        report('desktop-chat-has-one-send-command', fileName, source, node, `call:${rawName}`)
      }
      if (fileName === 'src/main/ipc.ts' && /^(m\.)?setActive(Model|ModalChoice)$/.test(call)) {
        report(
          'active-model-writes-use-canonical-selection-port',
          fileName,
          source,
          node,
          `call:${call}`
        )
      }
      if (
        fileName === 'src/main/models-manager.ts' &&
        /^(?:getAllActiveModals|setActiveModal|setModal|desktopModelSelectionPersistence\.write)$/.test(
          call
        )
      ) {
        report(
          'models-manager-does-not-own-selection-persistence',
          fileName,
          source,
          node,
          `call:${call}`
        )
      }
      if (
        fileName === 'src/main/models-manager.ts' &&
        /^(?:downloadQueue\.(?:enqueue|has|isAccepting|cancel|shutdown)|downloadLedger\.(?:update|inactiveIds|remove))$/.test(
          call
        )
      ) {
        report('desktop-model-library-workflow-is-shared', fileName, source, node, `call:${call}`)
      }
      if (
        fileName !== 'src/main/model-selection-persistence.ts' &&
        fileName !== 'src/main/model-services.ts' &&
        /^desktopModelSelectionPersistence\.(?:write|projectLegacyModality)$/.test(call)
      ) {
        report(
          'selection-writes-use-canonical-model-service',
          fileName,
          source,
          node,
          `call:${call}`
        )
      }
      if (
        fileName === 'src/main/imagegen.ts' &&
        /^(?:generateDesktopOperation|generateDesktopText|registerDesktopImageProgress|evaluateImageMemory|applyImageLoras|normalizeImageLoras|resolveImageToImageDimensions)$/.test(
          call
        )
      ) {
        report('desktop-image-policy-is-shared', fileName, source, node, `call:${call}`)
      }
      if (
        fileName === 'src/main/model-generation-adapters.ts' &&
        call === 'generateImageNative' &&
        node.arguments[0] &&
        nodeText(source, node.arguments[0]) !== 'operation.executionPlan'
      ) {
        report(
          'desktop-image-adapter-executes-shared-plan',
          fileName,
          source,
          node.arguments[0],
          `argument:${nodeText(source, node.arguments[0])}`
        )
      }
    }

    if (
      ts.isNewExpression(node) &&
      /^(?:ImageGenerationJobCoordinator|ImageGenerationLifecycle)$/.test(
        nodeText(source, node.expression)
      )
    ) {
      report(
        'desktop-image-lifecycle-is-shared',
        fileName,
        source,
        node,
        `new:${nodeText(source, node.expression)}`
      )
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(chat|chatMessages|chatStream|streamChat)$/.test(node.name.getText(source))
    ) {
      report(
        'no-route-owning-llm-api',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(sendWithTools|sendImage)$/.test(node.name.getText(source))
    ) {
      report(
        'desktop-chat-has-one-send-command',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      fileName === 'src/main/imagegen.ts' &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(?:maybeEnhancePrompt|resolveModel)$/.test(node.name.getText(source))
    ) {
      report(
        'desktop-image-policy-is-shared',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      fileName === 'src/main/tools.ts' &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(?:schemas|selectEffectiveSchemas|runToolLoop)$/.test(node.name.getText(source))
    ) {
      report(
        'desktop-tool-policy-is-shared',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      fileName === 'src/main/models-manager.ts' &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(?:publishRefusal|clearDeletedModelSelections|deleteTransferredModel)$/.test(
        node.name.getText(source)
      )
    ) {
      report(
        'desktop-model-library-workflow-is-shared',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      isAdapter &&
      (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node))
    ) {
      const condition = ts.isIfStatement(node)
        ? node.expression
        : ts.isSwitchStatement(node)
          ? node.expression
          : node.condition
      const expression = nodeText(source, condition)
      const consumesSharedDiscoveryPlan =
        /(?:remoteCapabilityDiscoveryPlan|plan\.reasoning|plan\.nativeTools)/.test(expression)
      if (
        !consumesSharedDiscoveryPlan &&
        /(provider|reasoning|thinking|openrouter|gemini|ollama|lm.?studio)/i.test(expression)
      ) {
        report(
          'adapters-do-not-own-provider-or-reasoning-policy',
          fileName,
          source,
          condition,
          `branch:${expression}`
        )
      }
    }

    if (isUi && ts.isStringLiteralLike(node) && node.text.includes('remote-vision:')) {
      report(
        'internal-remote-vision-id-never-reaches-ui',
        fileName,
        source,
        node,
        `literal:${node.text}`
      )
    }
    if (
      /RemoteVision/.test(fileName) &&
      ts.isJsxExpression(node) &&
      node.expression &&
      nodeText(source, node.expression) === 'model.id' &&
      !ts.isJsxAttribute(node.parent)
    ) {
      report('internal-remote-vision-id-never-reaches-ui', fileName, source, node, 'jsx:model.id')
    }

    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      /(DownloadQueue|DownloadCoordinator|DownloadStateMachine|DownloadRegistry)$/.test(
        node.name.text
      )
    ) {
      report(
        'apps-do-not-own-download-state-machines',
        fileName,
        source,
        node.name,
        `class:${node.name.text}`
      )
    }

    if (
      (ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      /^(whisperModel|ttsModel|activeWhisperModel|activeTtsModel|whisper_model|tts_model)$/.test(
        node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
          ? node.name.text
          : ''
      )
    ) {
      report(
        'no-legacy-whisper-or-tts-setting-key',
        fileName,
        source,
        node.name,
        `key:${node.name.text}`
      )
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
}

const allowlist = new Map(temporaryModelArchitectureAllowlist.map((entry) => [entry.key, entry]))
const used = new Set()
const violations = []
for (const finding of findings) {
  const key = keyOf(finding)
  if (allowlist.has(key)) used.add(key)
  else violations.push(finding)
}
const stale = [...allowlist.values()].filter((entry) => !used.has(entry.key))

for (const finding of findings.filter((finding) => allowlist.has(keyOf(finding)))) {
  const debt = allowlist.get(keyOf(finding))
  console.warn(`TEMPORARY ${finding.rule}: ${finding.file}:${finding.line} ${finding.detail}`)
  console.warn(`  owner=${debt.owner}; reason=${debt.reason}; removeWhen=${debt.removeWhen}`)
}
if (violations.length > 0 || stale.length > 0) {
  for (const finding of violations) {
    console.error(`VIOLATION ${finding.rule}: ${finding.file}:${finding.line} ${finding.detail}`)
  }
  for (const entry of stale) console.error(`STALE ALLOWLIST: ${entry.key}`)
  process.exitCode = 1
} else {
  console.log(`Desktop model architecture gate passed (${used.size} temporary item(s)).`)
}
