// Architecture-boundary + hygiene gate (hygiene §A separation-of-concerns + §H
// open-core). dependency-cruiser walks the IMPORT GRAPH and fails the build on a
// forbidden edge. Runs FREE + local (no hosted service), so it enforces structure
// on core here without exposing anything. (Duplication / smells / coverage are
// SonarCloud's axis — content, not edges.)
//
// Deliberately AGGRESSIVE: broken imports, phantom/dev deps, circular deps, dead
// modules, and the layer/open-core boundaries all gate. All error-level rules are
// verified clean on the current tree (0 errors); no-orphans is warn (surfaces dead
// code without blocking). Run: `npm run depcruise`.
module.exports = {
  forbidden: [
    // --- structural bug-catchers ------------------------------------------------
    {
      name: 'not-to-unresolvable',
      comment: 'A broken/typo/moved import must fail the build, not surface at runtime.',
      severity: 'error',
      from: { path: '^src/' },
      // Electron provides `original-fs` at runtime. It is not a resolvable npm package, and the
      // two importers are packaging tests that must exercise Electron's unpatched filesystem.
      to: { couldNotResolve: true, pathNot: '^original-fs$' }
    },
    {
      name: 'no-circular',
      comment:
        'Circular imports make load order fragile and break tree-shaking. Extract the shared piece.',
      severity: 'error',
      from: {},
      to: { circular: true }
    },
    {
      name: 'not-to-dev-dep',
      comment:
        'Shipping code must not import a devDependency — it would be missing in the packaged app.',
      severity: 'error',
      from: { path: '^src', pathNot: '\\.(test|spec)\\.(ts|tsx)$|__tests__|\\.config\\.' },
      to: {
        dependencyTypes: ['npm-dev'],
        pathNot: 'node_modules/(vitest|@vitest|@testing-library)'
      }
    },
    {
      name: 'no-non-package-json',
      comment:
        'A dependency not declared in package.json (a phantom dep) — install it or fix the import.',
      severity: 'error',
      from: { path: '^src' },
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] }
    },
    {
      name: 'no-deprecated-core',
      comment: 'Deprecated Node core module.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|_linklist|constants)$' }
    },
    {
      name: 'no-orphans',
      comment: 'Dead module — nothing imports it. Delete it or wire it up.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot:
          '\\.d\\.ts$|\\.(test|spec)\\.(ts|tsx)$|__tests__|(^|/)(tsconfig|vitest|eslint|playwright)\\.|\\.config\\.|bootstrap/proStub|main\\.tsx$|src/preload/'
      },
      to: {}
    },
    // --- the boundary rules (hygiene §A / §H) -----------------------------------
    {
      name: 'open-core-boundary',
      comment:
        'Open core (§H): core (public, AGPL) must NEVER import pro source. Only the loader seams cross ' +
        'the boundary. A stray core->pro import ships paid source in the public repo.',
      severity: 'error',
      from: {
        pathNot:
          '(loadProFeaturesMain|loadProFeaturesRenderer|main\\.tsx|bootstrap/proStub|\\.(test|spec)\\.[tj]sx?$|/__tests__/)'
      },
      to: { path: 'bootstrap/proStub\\.ts$|(^|/)pro/(main|renderer)/' }
    },
    {
      name: 'pure-stays-pure',
      comment:
        'Isolate pure logic from I/O (§A). These extracted decision modules are unit-tested BECAUSE they ' +
        'import no Electron/DB/network; an accidental IO import breaks testability AND silently grows the ' +
        'coverage-excluded shell while coverage still looks green.',
      severity: 'error',
      from: {
        path: 'src/main/(search-ranking|ipc-query-logic|model-sizing|files-classify|tts-logic|vectors-predicates|skills-parse|tools-parsers|mime|models/gguf)\\.ts$'
      },
      to: {
        path: '(^|/)node_modules/electron|src/main/(database|vectors|llm|mcp|embeddings|search)\\.ts$'
      }
    },
    {
      name: 'renderer-not-to-main',
      comment:
        'The renderer talks to main ONLY through the preload IPC bridge, never by importing main modules. (Renderer *tests* may import main modules to exercise a seam end-to-end — the boundary this rule protects is production renderer code.)',
      severity: 'error',
      from: { path: '^src/renderer', pathNot: '\\.(test|spec)\\.[tj]sx?$|/__tests__/' },
      to: { path: '^src/main' }
    },
    {
      name: 'not-to-test',
      comment:
        'Production code must not import test files (they would ship, dragging fixtures in).',
      severity: 'error',
      from: { pathNot: '\\.(test|spec)\\.(ts|tsx)$|__tests__' },
      to: { path: '\\.(test|spec)\\.(ts|tsx)$|__tests__/' }
    }
  ],
  options: {
    // Pro is a sibling checkout in CI. Inspect the core -> Pro edge, but do not
    // traverse the private graph and apply open-core rules inside Pro itself.
    doNotFollow: { path: 'node_modules|^pro/' },
    tsConfig: { fileName: 'tsconfig.web.json' },
    exclude: { path: 'node_modules|e2e/' },
    tsPreCompilationDeps: true,
    // Follow package "exports" subpaths (e.g. @modelcontextprotocol/sdk/client/*.js)
    // so real imports resolve and not-to-unresolvable doesn't false-positive on them.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types']
    }
  }
}
