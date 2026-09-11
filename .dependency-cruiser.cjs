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
    {
      name: 'models-facade-owns-download-control-plane',
      comment:
        'Desktop supplies download I/O ports to the Models facade. Production modules must not depend on the deleted app-owned coordinator or service.',
      severity: 'error',
      from: { path: '^(src|pro)/', pathNot: '\\.(test|spec|dbtest)\\.[jt]sx?$|/__tests__/' },
      to: {
        path: '^src/main/(?:composition/model-downloads|models/desktop-model-download-service)\\.ts$'
      }
    },
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
          '(^pro/|loadProFeaturesMain|loadProFeaturesRenderer|main\\.tsx|bootstrap/proStub|\\.(test|spec)\\.[tj]sx?$|/__tests__/)'
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
      name: 'presentation-not-to-raw-rag-use-or-automation',
      comment:
        'Presentation reads RAG, Use, and Automation through @offgrid/application facades. Shared domain packages are composition and platform-adapter dependencies, not renderer dependencies.',
      severity: 'error',
      from: { path: '^(src/renderer/|pro/renderer/)' },
      to: { path: '^\\.\\./shared/packages/(rag|use|automation)/' }
    },
    {
      name: 'presentation-not-to-raw-speech',
      comment:
        'Presentation reads Speech through @offgrid/application. Renderer composition adapters may depend on the raw platform contract.',
      severity: 'error',
      from: {
        path: '^(src/renderer/src/|pro/renderer/)',
        pathNot: '(__tests__/|\\.(test|spec)\\.[tj]sx?$)|^src/renderer/src/composition/'
      },
      to: { path: '^\\.\\./shared/packages/speech/' }
    },
    {
      name: 'presentation-not-to-raw-models',
      comment:
        'Presentation reads Models through @offgrid/application. Renderer composition and platform adapters may depend on the raw domain contract.',
      severity: 'error',
      from: {
        path: '^(src/renderer/src/|pro/renderer/)',
        pathNot:
          '(__tests__/|\\.(test|spec)\\.[tj]sx?$)|^src/renderer/src/composition/|^src/renderer/src/lib/(capture-readiness-ports|desktop-chat-generation-adapter|desktop-chat-session-repository)\\.ts$'
      },
      to: { path: '^\\.\\./shared/packages/models/' }
    },
    {
      name: 'presentation-not-to-raw-sync',
      comment:
        'Presentation reads Sync through @offgrid/application. The renderer Sync state adapter is the only raw domain seam.',
      severity: 'error',
      from: {
        path: '^(src/renderer/src/|pro/renderer/)',
        pathNot:
          '(__tests__/|\\.(test|spec)\\.[tj]sx?$)|^src/renderer/src/composition/|^pro/renderer/sync-state\\.ts$'
      },
      to: { path: '^\\.\\./shared/packages/sync/' }
    },
    {
      name: 'main-not-to-renderer',
      comment:
        'The other half of renderer-not-to-main: main must not import renderer modules either. Main ' +
        'has no window, no DOM and no React runtime, so such an import either drags presentation into ' +
        'the main bundle or is a decision that belongs in shared. Both directions of the process ' +
        'boundary are now gated; only the preload IPC bridge crosses it.',
      severity: 'error',
      from: { path: '^(src|pro)/main/', pathNot: '\\.(test|spec)\\.[tj]sx?$|/__tests__/' },
      to: { path: '^(src|pro)/renderer/' }
    },
    {
      name: 'no-shared-package-source-bypass',
      comment:
        'A shared package is consumed through its declared entry points, never by reaching into its ' +
        'source. A relative path or tsconfig alias into `shared/packages/<pkg>/src` bypasses the ' +
        "package's public API, its build, and every boundary rule expressed in terms of it.",
      severity: 'error',
      from: { path: '^(src|pro)/' },
      to: { path: '^\\.\\./shared/packages/[^/]+/src/' }
    },
    {
      name: 'main-not-to-presentation-logic',
      comment:
        'Zone rule: main is not presentation. @offgrid/ui is a headless settings/control-plane store ' +
        'for React and RN views, and @offgrid/design is the token set those views render with; a main ' +
        'process that reads either is either doing UI work or borrowing a helper that belongs in a ' +
        'domain package. NO EXEMPTIONS: the two this rule shipped with are closed (desktop 52073686), ' +
        'and both closures were better than a relocation - the transfer rate is now derived by the ' +
        'surface that renders it, and the vision overlay colours are named for what they do, because ' +
        'that screenshot goes to a model rather than to a person and nobody in that flow has a theme ' +
        'opinion. Do not add an entry here; fix the caller.',
      severity: 'error',
      from: { path: '^src/main/', pathNot: '\\.(test|spec)\\.[tj]sx?$|/__tests__/' },
      to: { path: '^\\.\\./shared/packages/(ui|design)/' }
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
    exclude: {
      path: 'node_modules|e2e/|(^|/)(__tests__|__mocks__)/|\\.(test|spec|dbtest)\\.[jt]sx?$'
    },
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
