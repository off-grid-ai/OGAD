# Functional test strategy — ensure features actually work, across every surface

The unit-coverage ratchet (vitest, ~54%) proves _pure logic_ is exercised. It does NOT prove
_a feature works_ - the boot crash and the "tools don't stream" fork both passed typecheck +
unit tests + build. This doc tracks FUNCTIONAL tests (unit + integration) per product surface,
including the native (Swift) code, so "does capture -> OCR -> memory -> chat actually work" has
an answer that a test enforces. Bring in whatever framework a surface needs.

## Governing rule: test OUR code, not third-party frameworks/engines

We test the code WE own - our decision logic, our wiring, our request/response handling, our
helpers - and the integration seams between them. We do NOT write tests whose pass/fail is
really a test of a third-party framework or engine we merely depend on:

- **Exclude vendored / third-party code entirely** (e.g. `**/.build/checkouts/**`,
  `node_modules`, Apple's `ml-stable-diffusion`, `swift-argument-parser`, `whisper.cpp`,
  `llama.cpp`, the kokoro onnx runtime). Not our code -> not our tests.
- **A thin shim over a framework with no logic of our own is not worth a test** (coreml-sd is
  ~50 lines of `main.swift` around Apple's StableDiffusion - testing it tests Apple's SD).
- **An engine-backed integration test is allowed only when it exercises OUR wiring** - our
  gateway routes (`model-server.ts`), our spawn/parse of a helper WE ship, our pipeline - with
  the engine as a dependency (skip if absent), not as the thing under test. The value is
  "our integration still works," not "does Vision/whisper/kokoro work."

## Consolidated coverage (current)

- **TS (Electron main + preload + renderer + pro), `npm run test:coverage`:** ~78% statements /
  75% branches / 77% functions / 79% lines on the TESTABLE surface (ratchet floor 77/74/76/78,
  climbing toward the 85% goal). ~1200 unit/integration tests.
- **Swift, `npm run test:swift`:** 37 XCTest cases over the text-extractor pure classifiers.
- **DB integration, `npm run test:db`:** 105 cases over core and Pro persistence against real
  temp SQLite. Kept OUT of the default gate because it needs `better-sqlite3` rebuilt for the
  node ABI (the app builds it for Electron's ABI); the script rebuilds + restores. KNOWN GAP:
  wire `test:db` into CI as an isolated step so database coverage is enforced there.
- The default coverage gate EXCLUDES (with a real alternative suite each): vendored/built
  (`packages/**`, `**/dist/**`); native/DB/spawn shells (database.ts, rag/store.ts, imagegen.ts,
  mflux.ts, sd-server.ts, model-server.ts, media-server.ts, whisper/parakeet/whisper-server) -
  their pure logic is extracted + unit-covered, the husks are smoke/e2e/test:db-covered; and big
  e2e-covered UI components (MemoryChat.tsx, VaultScreen.tsx).

## Test types

- **unit (vitest)** - pure TS logic, no I/O. Fast, always-on. The ratchet floor.
- **integration (vitest, real collaborators)** - run the real implementation against a temp
  SQLite DB / temp userData / a spawned native binary / the local engine. `skipIf` the
  dependency (binary/model) is absent, so it runs on a dev Mac + release builds and SKIPS in a
  plain `npm ci` CI rather than failing. This is where "the feature works" is proven.
- **swift unit (XCTest / swift-testing via SwiftPM)** - pure logic inside a Swift package.
- **e2e (Playwright Electron)** - the rendered app tour (e2e/, 27 tests today).
- **gateway smoke (`npm run smoke`)** - the OpenAI `/v1` surface against a running app.

## Surface matrix (status - keep current)

| Surface                                                    | Kind            | How                                                                                                                                                                                                                             | Status                                         |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| RAG/chat pure logic (ranking, prompts, routing, tool loop) | unit            | vitest                                                                                                                                                                                                                          | DONE (growing)                                 |
| Streaming tool loop (C7)                                   | integration-ish | vitest, faked model boundary                                                                                                                                                                                                    | DONE (`tools-stream.test.ts`)                  |
| **Native OCR (Vision, `ocr.swift`)**                       | integration     | vitest spawns the built binary on a rendered fixture                                                                                                                                                                            | **DONE (`ocr-helper.integration.test.ts`)**    |
| Gateway `/v1` (chat stream, embeddings, image)             | smoke           | `npm run smoke` vs running app                                                                                                                                                                                                  | DONE (manual/pre-release)                      |
| STT (whisper-cli / parakeet) + TTS (kokoro)                | integration     | vitest: TTS->STT round-trip via the gateway; skip if gateway down                                                                                                                                                               | **DONE (`audio-engines.integration.test.ts`)** |
| Image gen (sd-cli / mflux)                                 | integration     | vitest: gateway `/v1/images/generations` on the installed model; heavy - local-gated, skip if no image model                                                                                                                    | TODO (local only)                              |
| coreml-sd Swift package                                    | -               | **EXCLUDED - not our code.** ~50-line `main.swift` shim over Apple ml-stable-diffusion; testing it tests Apple's SD, not our logic. Covered indirectly by the gateway image-gen integration test when it is the active runtime. |
| Accessibility watcher (`main.swift`)                       | integration     | needs TCC (accessibility) - local-gated, spawn + assert JSON shape                                                                                                                                                              | TODO (local only)                              |
| text-extractor / inspect_layout `.swift`                   | integration     | spawn on a fixture; assert output shape                                                                                                                                                                                         | TODO                                           |
| Capture -> OCR -> memory ingest seam                       | integration     | vitest: feed a fixture frame through the ingest path into a temp DB                                                                                                                                                             | TODO                                           |
| RAG end-to-end (retrieve -> prompt -> answer)              | integration     | vitest: seed a temp SQLite, run retrieval, assert grounded context                                                                                                                                                              | TODO                                           |
| Vault (kdbx + Argon2)                                      | integration     | vitest vs temp dir                                                                                                                                                                                                              | DONE (`vault-service.test.ts`)                 |
| Renderer surfaces render                                   | e2e             | Playwright tour                                                                                                                                                                                                                 | DONE (27)                                      |
| Pro dictation / clipboard / replay                         | e2e + unit      | Playwright (`pro.spec.ts`) + pro unit                                                                                                                                                                                           | PARTIAL                                        |

## Rules

- An integration test that needs a binary/model MUST `skipIf` it is absent and say so - never
  fail because CI lacks the artifact, never silently pass by mocking the thing under test.
- Prefer a real round-trip (e.g. TTS->STT) over a hand-crafted fixture where it makes the test
  more honest.
- A native helper is tested through the SAME interface the app uses (spawn the compiled binary),
  so the test breaks when the real integration breaks.
- New feature => a functional test for it in the same change (see the top-level testing rule).
