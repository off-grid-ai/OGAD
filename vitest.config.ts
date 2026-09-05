import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { availableParallelism } from 'os'
import { defineConfig } from 'vitest/config'
import { createProductTestFiles, createVitestProjects } from './src/main/__tests__/vitest-projects'
import { databaseProjectOptions } from './vitest.db.config'

// The pro/ submodule is present in the working tree when you have access, absent
// otherwise (and in a fork CI without the cross-repo token). Only enforce the
// pro-specific threshold group when pro is actually checked out, so a core-only
// run measures + gates core alone instead of erroring on an empty pro/** glob.
const hasPro = existsSync(resolve(__dirname, 'pro/tsconfig.json'))
// Set by CI and the pre-push hook, which may fold optional e2e evidence into this unified
// product + database report before gating. See resolveCoverageThresholds below.
const usesAggregateCoverageGate = process.env.OFFGRID_AGGREGATE_COVERAGE === '1'
// The pro test globs are gated the same way the pro thresholds already are:
// a core-only checkout can carry stray pro/ files (this repo tracks a handful
// of pro test files with no implementations beside them), and collecting
// orphan tests fails the suite for everyone without desktop-pro access.
const productTestFiles = createProductTestFiles(hasPro)
const commonExcludes = ['e2e/**', 'node_modules/**', 'out/**']
const configuredProjects = createVitestProjects(productTestFiles, commonExcludes)
const productProject = configuredProjects[0]!
const nonConsumerProjects = configuredProjects.slice(1)
const desktopWorkerCount = Math.max(1, Math.min(8, availableParallelism() - 2))
const databaseWorkerCount = Math.max(1, Math.min(4, availableParallelism() - 2))

// These journeys own a fixed model port, a long-running transfer, or a background
// capture lifecycle. They must not compete with another DB worker. All other DB
// journeys use process-isolated temporary profiles and can run in parallel safely.
export const DATABASE_EXCLUSIVE_TESTS = [
  'integration-tests/memory-chat-tts.ui.integration.dbtest.ts',
  'integration-tests/workspace-production-bridge.ui.integration.dbtest.tsx',
  'src/main/__tests__/active-text-model-transport.integration.dbtest.ts',
  'src/main/__tests__/fresh-setup-first-use.integration.dbtest.ts',
  'src/main/__tests__/image-runtime-reliability.integration.dbtest.ts',
  'src/main/__tests__/memory-rag-chat-lifecycle.integration.dbtest.ts',
  'src/main/__tests__/model-server-image.integration.dbtest.ts',
  'src/main/__tests__/multimodal-rag-lifecycle.integration.dbtest.ts',
  'src/main/__tests__/rag-empty-memory.dbtest.ts',
  'src/main/__tests__/tools-loop.dbtest.ts',
  'src/main/__tests__/tools-search.dbtest.ts',
  'src/main/__tests__/tools-vision.dbtest.ts',
  'pro/main/__tests__/capture-backlog-deletion-race.integration.dbtest.ts',
  'pro/main/__tests__/capture-deletion-race.integration.dbtest.ts',
  'pro/main/__tests__/manual-todo-journey.integration.dbtest.ts',
  'pro/main/__tests__/meeting-chat.integration.dbtest.ts',
  'pro/main/__tests__/meeting-persistence.dbtest.ts',
  'pro/main/__tests__/model-transfer-service.integration.dbtest.ts',
  'pro/main/__tests__/replay-chat.integration.dbtest.ts',
  'pro/main/__tests__/sync-service.integration.dbtest.ts'
]

/**
 * The one workspace coverage gate — READ, never redeclared.
 *
 * coverage-gate.json beside this file is the single machine-readable owner of the four numbers.
 * Every runner that measures this repository reads that one file: vitest here (one combined
 * product + database report) and scripts/coverage-all.sh, which turns the
 * same object into the merged new-code run's `--min-*` flags. There is no second, softer floor
 * anywhere, no per-package group, and no copy of the numbers to drift out of step.
 *
 * All four metrics use a 65% minimum, as requested by the maintainer.
 * Change coverage-gate.json to update the minimum for every runner.
 */
export interface CoverageGate {
  statements: number
  branches: number
  functions: number
  lines: number
}

export const WORKSPACE_COVERAGE_GATE: CoverageGate = JSON.parse(
  readFileSync(resolve(__dirname, 'coverage-gate.json'), 'utf-8')
) as CoverageGate

/**
 * WHICH report this run's gate is applied to — never WHETHER the gate exists.
 *
 * A direct run applies the gate to Vitest's one product + database report. Under the aggregate
 * run (scripts/coverage-all.sh and CI), optional e2e evidence can still be folded in and new-code
 * coverage is calculated afterwards. Enforcement moves downstream in that mode, using the same
 * WORKSPACE_COVERAGE_GATE numbers.
 */
export function resolveCoverageThresholds(
  mergesWithComplementaryReports: boolean
): CoverageGate | undefined {
  return mergesWithComplementaryReports ? undefined : WORKSPACE_COVERAGE_GATE
}

// Unit + integration tests (fast, deterministic). The Playwright Electron E2E lives
// in e2e/ and runs via `npm run test:e2e`, NOT here.
//
// Coverage (npm run test:coverage) gates the TESTABLE surface: the pure, Electron-free
// decision logic the codebase deliberately extracts so it can be exercised in-process
// (see CLAUDE.md "pull the pure part out"). Electron/DB/native-bound shells are excluded
// because they can't be unit-tested directly — cover the logic you pulled out of them.
// WORKSPACE_COVERAGE_GATE above is the floor, enforced here and on pre-push, and `include`
// means a new pure module with no test drags the number down, so untested logic cannot
// sneak in.
export default defineConfig({
  // Renderer path aliases, mirrored 1:1 from tsconfig.web.json `paths`. Without these
  // a .tsx render test cannot import any renderer module (electron-vite provides them
  // in the app build, but vitest has no tsconfig-paths plugin), so the *.test.tsx glob
  // above is inert until they exist. Additive only — no gate/threshold/include change.
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@offgrid/core': resolve(__dirname, 'src'),
      '@offgrid/pro/renderer': resolve(__dirname, 'src/bootstrap/proStub.ts'),
      // `loadProFeaturesMain` dynamically imports `@offgrid/pro/main`, which the production build
      // (electron.vite.config.ts) resolves to the real `pro/main/index.ts` when the submodule is
      // present and to the stub when it is not. This alias mirrors that exactly. Without it the
      // import threw ERR_MODULE_NOT_FOUND under test, which `loadProFeaturesMainNow` reports as a
      // pro activation failure whenever pro is enabled - so every entitlement-gain test logged a
      // failure that no production build can produce. A real module when we have it, per the
      // testing doctrine; the stub only where production would also have the stub.
      '@offgrid/pro/main': hasPro
        ? resolve(__dirname, 'pro/main/index.ts')
        : resolve(__dirname, 'src/bootstrap/proStub.ts'),
      '@offgrid/pro': resolve(__dirname, 'src/bootstrap/proStub.ts'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    // jsdom intentionally omits layout observers that real Chromium provides. Keep
    // those browser boundaries in one renderer harness so Radix-backed components
    // exercise the real product tree without every suite redefining the platform.
    setupFiles: ['src/renderer/src/__tests__/browser-boundaries.setup.ts'],
    // jsdom render tests (userEvent + waitFor over real DOM) and DB/crypto integration
    // tests legitimately exceed the 5s default under CI/parallel load — this was
    // intermittently failing the pre-push gate. 15s is generous headroom without
    // masking a real hang (a genuinely stuck test still fails).
    testTimeout: 15000,
    // .ts = pure/main unit + integration tests (node env, the default). .tsx = renderer
    // component render tests, which opt into jsdom per-file via `// @vitest-environment jsdom`
    // so the default suite stays node-fast. (React render harness: jsdom + @testing-library/react.)
    // Two integration suites intentionally own the production llama port (:8439):
    // the gateway's real upstream seam and System Health's real managed-engine seam.
    // Keep them in one sequential project so ownership can never overlap across
    // Vitest workers. Packaging tests invoke electron-vite, which materializes one
    // temporary config
    // beside electron.vite.config.ts and needs the same CPU/memory as the application
    // build. Run them in a second project only after ordinary product tests finish;
    // otherwise coverage workers can starve the build past its timeout even when the
    // cross-process filesystem lock prevents config-file races.
    projects: [
      {
        ...productProject,
        test: { ...productProject.test, maxWorkers: desktopWorkerCount }
      },
      {
        extends: true,
        ...databaseProjectOptions,
        test: {
          ...databaseProjectOptions.test,
          exclude: [...databaseProjectOptions.test.exclude, ...DATABASE_EXCLUSIVE_TESTS],
          fileParallelism: true,
          maxWorkers: databaseWorkerCount,
          sequence: { groupOrder: 1 }
        }
      },
      {
        extends: true,
        ...databaseProjectOptions,
        test: {
          ...databaseProjectOptions.test,
          name: 'database-exclusive-integration',
          include: DATABASE_EXCLUSIVE_TESTS,
          sequence: { groupOrder: 2 }
        }
      },
      ...nonConsumerProjects
    ],
    coverage: {
      provider: 'v8',
      // Write the report even when a test FAILS. Without this, one flaky pro
      // test (the sandbox-only sync/ambient timing flakes) suppresses the whole
      // coverage report, leaving a stale coverage-final.json on disk - so the
      // new-code gate then measures thoroughly-tested files as 0% and blocks a
      // green branch. A failing test's own coverage is unaffected; every OTHER
      // test's coverage is still collected and written. The failing TEST still
      // fails the run; this only decouples "a test flaked" from "the coverage
      // report is missing". Mirrors vitest.db.config.ts.
      reportOnFailure: true,
      // One workspace include (core + Pro, production TypeScript + rendered TSX) keeps every
      // consumer-owned module visible even when no test imports it: since vitest 4 `include`
      // alone decides the report's file set (the former `all: true` is the only behaviour), so an
      // untested file matching it is reported at 0% rather than silently dropped. Render tests and
      // e2e coverage contribute to the same report instead of leaving Pro UI as an unmeasured
      // blind spot.
      include: ['src/**/*.ts', 'src/**/*.tsx', 'pro/**/*.ts', 'pro/**/*.tsx'],
      // text-summary is the console line, json-summary powers the README badges.
      reporter: ['text-summary', 'json-summary', 'json'],
      // Excludes: (a) vendored/built code (not ours) and (b) native/DB/spawn/IPC-wiring
      // shells the default vitest runner CANNOT cover in-process - each covered by a real
      // alternative suite (test:db / smoke / e2e), not left untested. See
      // docs/FUNCTIONAL_TEST_STRATEGY.md.
      exclude: [
        '**/*.test.ts',
        '**/*.dbtest.ts',
        '**/__tests__/**',
        '**/*.d.ts',
        // Vendored / built - not our source (its own package builds + tests it).
        '**/dist/**',
        'packages/**',
        // Native-DB-bound: covered by the 103 tests in *.dbtest.ts via `npm run test:db`
        // (rebuilds better-sqlite3 for the node ABI); can't load the native module here.
        'src/main/database.ts',
        'src/main/rag/store.ts',
        // The actions runtime composition: Electron + app-DB wiring over tested,
        // injectable modules; covered by use-runtime.integration.dbtest.ts (real DB,
        // helper boundary mocked). Its pure seam (pickByPlatform) IS measured here.
        'src/main/actions/use-runtime.ts',
        // The rail hosts: the browser's WebContentsView + CDP debugger, and the
        // vision rail's screen capture + actuation + overlay, over the unit-
        // tested collector/driver/loop/guard/executor. A real display drives
        // them - the e2e tour and the real-machine pass, not this runner.
        'src/main/browser/browser-host.ts',
        'src/main/vision/vision-host.ts',
        // The floating supervisor NSPanel: BrowserWindow glue over the tested feed.
        'src/main/vision/supervisor-window.ts',
        // On-demand grounder swap: reloads llama-server with UI-TARS and back,
        // needs the multi-GB models on disk. Its decision (isGrounderActive) is
        // measured; the reload orchestration is exercised by the A/B run.
        'src/main/vision/grounder-loader.ts',
        // The accessibility rail's live host: get-windows I/O + the Swift helper
        // spawn + synthetic input + the Accessibility grant, over the unit-tested
        // parser/router/loop/target-picker. Driven on a real Mac (the T1f pass).
        'src/main/accessibility/ax-host.ts',
        // The shared synthetic-input adapter is measured here through its injected
        // NutApi boundary. Only loadActuation performs the optional native require;
        // the complete adapter contract runs without a display in the unit suite.
        // powershell.exe-spawning I/O shell (Windows-only twin of native-helper's
        // spawn side); its parsing is the shared parseHelperResponse, which is
        // covered. Exercised on a real Windows machine per WINDOWS_TEST_PLAN.md.
        'src/main/actions/win-powershell.ts',
        // SQLite settings shell; prompt registry and filling remain measured.
        'src/main/prompt-store.ts',
        // SQLite settings shell; policy is measured in runtime-residency-logic.ts.
        'src/main/runtime-residency.ts',
        // Native / subprocess-spawning I/O shells. Their PURE logic was extracted into
        // sibling modules that ARE covered (imagegen/*, models/*, transcription/classify,
        // model-server/*); these husks spawn binaries / bind sockets - exercised via
        // `npm run smoke` + e2e, not unit tests. Mirrors the excluded model-server.ts.
        'src/main/mflux.ts',
        'src/main/model-server.ts',
        // Cross-platform orphan-port reaper: execSync(netstat/lsof/tasklist/ps) + process.kill
        // — an OS-boundary shell, verified by the real macOS/Windows run, not in-process.
        'src/main/kill-orphan-port.ts',
        'src/main/media-server.ts',
        'src/main/transcription/whisper-cli.ts',
        'src/main/transcription/parakeet-cli.ts',
        'src/main/transcription/whisper-server.ts',
        'src/main/coreml-image.ts',
        // Entry/wiring that isn't logic (index barrels re-export; bootstrap boots Electron).
        'src/main/index.ts',
        // src/preload/** WAS excluded here as "wiring, exercised via e2e". It is unit-tested now
        // (src/preload/__tests__/preload-bridge.test.ts sweeps all 152 exposed methods and proves each one
        // reaches main), so excluding it would hide the one file whose failure mode - a method that forwards
        // nothing - is invisible to types and shows up only as a dead button in front of a user.
        // CORE native/IPC-wiring/entry shells (recon-classified): pure logic already
        // extracted to measured siblings (ipc-query-logic, search-ranking, model-sizing,
        // models/*, llm/*, licensing/*-logic, files-classify, tts-logic, etc.). These husks
        // register ipcMain handlers, spawn binaries, bind sockets, or call native/OS/network
        // APIs - not unit-coverable in-process; exercised via e2e / smoke / test:db.
        'src/main/ipc.ts', // ~100 ipcMain.handle registrations (logic → ipc-query-logic.ts)
        'src/main/tts-ipc.ts', // TTS handler wiring; real renderer → SQLite → worker seam runs in test:db
        'src/main/rag-ipc.ts',
        'src/main/mcp-ipc.ts',
        'src/main/license-ipc.ts',
        'src/main/llm.ts', // spawns llama-server; pure bits in llm/* (tested)
        'src/main/mcp.ts',
        // Connector DB/network orchestration; pure schema/result rules are measured separately.
        'src/main/tools/mcpConnectorToolExtension.ts',
        'src/main/updater.ts',
        'src/main/dev-seed.ts',
        'src/main/vision.ts',
        'src/main/ocr.ts',
        'src/main/embeddings.ts',
        // permissions.ts is no longer excluded: it is unit-tested now, including the multicast probe's four
        // outcomes (delivered, refused, socket error, silent) - the socket-error case is the one that would
        // otherwise be an uncaught exception in main during setup, so it is worth measuring rather than
        // trusting to a run on real hardware.
        'src/main/rag/extractors.ts',
        'src/main/rag/index.ts', // orchestrator; buildProjectPrompt extracted → rag/prompt.ts
        'src/main/licensing/license-service.ts', // Keychain/IPC shell; isProActive → license-service logic exports (tested)
        'src/main/licensing/keygen-client.ts', // fetch shell; parsers extracted+tested
        'src/main/licensing/keygen-config.ts', // constants only
        'src/main/bootstrap/loadProFeaturesMain.ts', // dynamic-import loader; proEnabled() tested
        'src/main/search.ts', // DB orchestrator; ranking in search-ranking.ts (tested)
        'src/main/models-manager.ts', // catalog/install/activate IO; logic in models/* (tested)
        'src/main/skills.ts', // fs CRUD shell; parsers → skills-parse.ts (tested)
        'src/main/tools.ts', // agentic loop (tools-stream.test.ts) + parsers (tools-parsers.ts)
        'src/main/files.ts', // upload IO; classifyUpload → files-classify.ts (tested)
        'src/main/tts.ts', // engine spawn; chooseVoice/parseServeLine → tts-logic.ts (tested)
        'src/main/vectors.ts', // LanceDB shell; predicates → vectors-predicates.ts (tested)
        'src/main/data-privacy.ts',
        'src/main/artifacts.ts',
        'src/main/secrets.ts',
        'src/main/vision.ts',
        // Renderer .ts that are pure IPC passthrough (no logic) or React hooks (e2e-covered).
        'src/renderer/src/lib/voiceApi.ts',
        'src/renderer/src/useMeetingRecorder.ts',
        // loadProFeaturesRenderer.ts is no longer in this list: it decides which half of the app switches on
        // at launch, which is a decision rather than passthrough, and it now has its own tests covering all
        // three outcomes and every way each fails.
        'src/bootstrap/proStub.ts',
        // PRO renderer IPC-passthrough API wrappers (no logic — mirror the core voiceApi rule).
        'pro/renderer/api.ts',
        'pro/renderer/vaultApi.ts',
        'pro/renderer/components/voice/voiceApi.ts',
        // PRO native/IPC-wiring/entry shells: the same class as core's excluded shells -
        // IPC registration, native ScreenCaptureKit/meeting bridges, OS text injection,
        // screen-capture watcher, network clients, the dev seeder, window/overlay glue.
        // Their pure logic lives in sibling modules that ARE measured (crm/*, dictation/*,
        // vault/*, lib/*, clipboard-*.ts). Exercised via e2e/integration, not unit.
        'pro/main/index.ts',
        'pro/main/**/*-ipc.ts',
        'pro/main/**/ipc.ts',
        'pro/main/meeting-native.ts',
        'pro/main/meeting-detect.ts',
        'pro/main/meeting-controller.ts',
        'pro/main/meeting-service.ts',
        'pro/main/meetings.ts',
        'pro/main/text-injection.ts',
        'pro/main/console.ts',
        'pro/main/google-rest.ts',
        // Core settings composition; IdentityService rules are measured in identity.ts.
        'pro/main/identity-store.ts',
        'pro/main/dev-seed.ts',
        'pro/main/services.ts',
        'pro/main/dictation/overlay.ts',
        'pro/main/dictation/controller.ts',
        // Recon-confirmed pro shells (logic already extracted+tested in siblings, or pure
        // native/window glue): clipboard.ts = BrowserWindow popup + ipcMain + globalShortcut
        // (logic in clipboard-store/search/file-write, tested); focus.ts = setInterval + native
        // activeWindow poll; hotkey/toggle.ts = globalShortcut register/unregister wrapper.
        'pro/main/clipboard.ts',
        'pro/main/focus.ts',
        'pro/main/dictation/hotkey/toggle.ts',
        'pro/main/crm/notify.ts' // pure Electron Notification shell (isSupported/new Notification/show) — no branchable logic
      ],
      thresholds: resolveCoverageThresholds(usesAggregateCoverageGate)
    }
  }
})
