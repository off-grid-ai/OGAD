import { resolve } from 'path'
import { existsSync } from 'fs'
import { defineConfig } from 'vitest/config'

// The pro/ submodule is present in the working tree when you have access, absent
// otherwise (and in a fork CI without the cross-repo token). Only enforce the
// pro-specific threshold group when pro is actually checked out, so a core-only
// run measures + gates core alone instead of erroring on an empty pro/** glob.
const hasPro = existsSync(resolve(__dirname, 'pro/tsconfig.json'))

// Unit + integration tests (fast, deterministic). The Playwright Electron E2E lives
// in e2e/ and runs via `npm run test:e2e`, NOT here.
//
// Coverage (npm run test:coverage) gates the TESTABLE surface: the pure, Electron-free
// decision logic the codebase deliberately extracts so it can be exercised in-process
// (see CLAUDE.md "pull the pure part out"). Electron/DB/native-bound shells are excluded
// because they can't be unit-tested directly — cover the logic you pulled out of them.
// The 85% floor is enforced here and on pre-push. `all: true` means a new pure module
// with no test drags the number down, so untested logic cannot sneak in.
export default defineConfig({
  // Renderer path aliases, mirrored 1:1 from tsconfig.web.json `paths`. Without these
  // a .tsx render test cannot import any renderer module (electron-vite provides them
  // in the app build, but vitest has no tsconfig-paths plugin), so the *.test.tsx glob
  // above is inert until they exist. Additive only — no gate/threshold/include change.
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(__dirname, 'src/renderer/src') },
      { find: '@offgrid/core', replacement: resolve(__dirname, 'src') },
      {
        find: /^@offgrid\/pro(?:\/.*)?$/,
        replacement: resolve(__dirname, 'src/bootstrap/proStub.ts')
      },
      { find: '@', replacement: resolve(__dirname, 'src/renderer/src') }
    ]
  },
  test: {
    // jsdom render tests (userEvent + waitFor over real DOM) and DB/crypto integration
    // tests legitimately exceed the 5s default under CI/parallel load — this was
    // intermittently failing the pre-push gate. 15s is generous headroom without
    // masking a real hang (a genuinely stuck test still fails).
    testTimeout: 15000,
    // .ts = pure/main unit + integration tests (node env, the default). .tsx = renderer
    // component render tests, which opt into jsdom per-file via `// @vitest-environment jsdom`
    // so the default suite stays node-fast. (React render harness: jsdom + @testing-library/react.)
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'pro/**/*.test.ts', 'pro/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**', 'out/**'],
    coverage: {
      provider: 'v8',
      // all:true + an `include` of the LOGIC surface (.ts, both core src AND the pro
      // submodule) => every logic file is in the denominator whether or not a test imports
      // it, so untested modules show as 0% and are VISIBLE (previously all:false hid them -
      // pro/main had ~72 .ts files but only the imported ones counted, flattering the %).
      // Mirrors mobile's collectCoverageFrom(src + pro). UI (.tsx) is deliberately NOT here:
      // desktop covers rendered components via the Playwright e2e tour, not unit tests.
      all: true,
      include: ['src/**/*.ts', 'pro/**/*.ts'],
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
        // SQLite settings shell; prompt registry and filling remain measured.
        'src/main/prompt-store.ts',
        // SQLite settings shell; policy is measured in runtime-residency-logic.ts.
        'src/main/runtime-residency.ts',
        // Native / subprocess-spawning I/O shells. Their PURE logic was extracted into
        // sibling modules that ARE covered (imagegen/*, models/*, transcription/classify,
        // model-server/*); these husks spawn binaries / bind sockets - exercised via
        // `npm run smoke` + e2e, not unit tests. Mirrors the excluded model-server.ts.
        'src/main/imagegen.ts',
        'src/main/mflux.ts',
        'src/main/sd-server.ts',
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
        'src/preload/**',
        // CORE native/IPC-wiring/entry shells (recon-classified): pure logic already
        // extracted to measured siblings (ipc-query-logic, search-ranking, model-sizing,
        // models/*, llm/*, licensing/*-logic, files-classify, tts-logic, etc.). These husks
        // register ipcMain handlers, spawn binaries, bind sockets, or call native/OS/network
        // APIs - not unit-coverable in-process; exercised via e2e / smoke / test:db.
        'src/main/ipc.ts', // ~100 ipcMain.handle registrations (logic → ipc-query-logic.ts)
        'src/main/rag-ipc.ts',
        'src/main/mcp-ipc.ts',
        'src/main/license-ipc.ts',
        'src/main/llm.ts', // spawns llama-server; pure bits in llm/* (tested)
        'src/main/mcp.ts',
        'src/main/mcp-oauth.ts',
        'src/main/mcp-server.ts', // MCP tool registration; parseDataUrl extracted+tested
        // Connector DB/network orchestration; pure schema/result rules are measured separately.
        'src/main/tools/mcpConnectorToolExtension.ts',
        'src/main/updater.ts',
        'src/main/dev-seed.ts',
        'src/main/vision.ts',
        'src/main/ocr.ts',
        'src/main/embeddings.ts',
        'src/main/permissions.ts',
        'src/main/rag/extractors.ts',
        'src/main/rag/index.ts', // orchestrator; buildProjectPrompt extracted → rag/prompt.ts
        'src/main/licensing/license-service.ts', // Keychain/IPC shell; isProActive → license-service logic exports (tested)
        'src/main/licensing/keygen-client.ts', // fetch shell; parsers extracted+tested
        'src/main/licensing/keygen-config.ts', // constants only
        'src/main/bootstrap/loadProFeaturesMain.ts', // dynamic-import loader; proEnabled() tested
        'src/main/search.ts', // DB orchestrator; ranking in search-ranking.ts (tested)
        'src/main/setup.ts', // model-recommendation orchestrator; fusion via tested model-sizing
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
        'src/renderer/src/bootstrap/loadProFeaturesRenderer.ts',
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
        'pro/main/watcher.ts',
        'pro/main/text-injection.ts',
        'pro/main/scraper.ts',
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
        'pro/main/crm/notify.ts', // pure Electron Notification shell (isSupported/new Notification/show) — no branchable logic

        // Renderer .tsx COMPONENTS are rendered-behavior surface, covered by the Playwright
        // e2e tour (npm run test:e2e) + targeted render tests (MemoryChat.image.test.tsx),
        // NOT unit coverage — their pure logic is extracted to measured .ts (lib/*, image-params,
        // message-persistence, chat-labels, image-intent). The coverage `include` is .ts-only by
        // design; this also drops any .tsx a render test transitively imports from the denominator
        // (a render test asserts the terminal artifact, it is not a unit-coverage vehicle).
        'src/renderer/src/**/*.tsx',
        'pro/renderer/**/*.tsx'
      ],
      thresholds: {
        // RATCHET FLOOR on the HONEST TESTABLE surface. The denominator is corrected two ways
        // vs the old flattering "77%": (1) `all:true` + the .ts include measures ALL owned logic,
        // not just files a test imported; (2) the exclude list carves out native/IPC/spawn/entry
        // SHELLS (pure logic extracted to measured siblings) + e2e-covered .tsx components — so
        // what's counted is the code that CAN be unit-tested. The coverage-campaign brought this
        // from a real ~29% baseline to measured global ~97/92/95/98 (core 97/94/96/98, pro
        // 97/91/95/98). Floors set just under measured so pre-push blocks REGRESSIONS; they only
        // ever rise, never lower to pass. Comfortably past the 85 goal.
        statements: 95,
        branches: 90,
        functions: 93,
        lines: 96,
        // pro/** carved into its own group (mobile pattern) so pro is separately regression-
        // guarded, not averaged into core. Just under pro's measured 96.9/91.0/94.8/98.3.
        // Only applied when pro is checked out (see hasPro) so a core-only CI run doesn't
        // error on an empty glob.
        ...(hasPro ? { 'pro/**': { statements: 95, branches: 89, functions: 93, lines: 97 } } : {})
      }
    }
  }
})
