# P0-P2 integration coverage

Living status for the 155 release journeys in
[`RELEASE_TEST_CHECKLIST.csv`](RELEASE_TEST_CHECKLIST.csv). This file is intentionally
conservative: a unit test, source-reading assertion, rendered shell without the real behavior, or
manual claim does not count as complete integration coverage.

## Strict status - 2026-07-20

- Counting rule:
  - Complete means the decisive production collaborators run through the real application seam.
  - A packaged or native-sensitive behavior needs an exact packaged/native proof.
  - A test that replaces Off Grid code, preload/IPC ownership, persistence, or the decisive runtime
    is partial. Partial does not count as done.
  - A fake at a genuinely uncontrollable remote or OS boundary may support a seam test, but it does
    not by itself prove the complete release journey.
- Status snapshot:
  - P0: 74 total.
  - P0 complete: 4.
  - P0 partial: 68.
  - P0 open: 2.
  - P0 left: 70.
  - P1: 71 total.
  - P1 complete: 12.
  - P1 partial: 59.
  - P1 open: 0.
  - P1 left: 59.
  - P2: 10 total.
  - P2 complete: 3.
  - P2 partial: 7.
  - P2 open: 0.
  - P2 left: 7.
  - Overall: 155 total.
  - Overall complete: 19.
  - Overall partial: 134.
  - Overall open: 2.
  - Overall left: 136.
- Complete P0 journeys:
  - #9 - Fresh onboarding completes.
  - #79 - Gateway models endpoint.
  - #87 - Replay timeline renders.
  - #145 - Cold relaunch after forced quit.
- Complete P1 journeys:
  - #8 - Product identity is consistent.
  - #12 - Onboarding resumes an interrupted model download.
  - #29 - Delete an inactive model.
  - #30 - Delete the active model.
  - #89 - Replay opens the selected captured moment.
  - #118 - Duplicate clipboard changes do not reorder the selected item.
  - #119 - Clipboard captures native image bytes.
  - #127 - Vault copy reaches the real OS clipboard.
  - #129 - Runtime residency settings survive relaunch.
  - #130 - Runtime residency controls use the real settings owner.
  - #150 - Desktop collections respond at real Electron widths.
  - #151 - Desktop keyboard focus is visible and ordered.
- Complete P2 journeys:
  - #44 - Rename conversation.
  - #46 - Copy assistant reply.
  - #59 - Project desktop layout.
- Partial P0 journeys left:
  - #3, #4, #5, #6, #7, #10, #13, #15, #17, #25, #26, #27, #28, #32, #33, #34,
    #38, #39, #41, #42, #43, #48, #51, #52, #53, #56, #61, #62, #63, #68, #69, #71,
    #73, #74, #75, #76, #80, #83, #84, #85, #86, #90, #94, #95, #96, #97, #99, #100,
    #106, #112, #116, #117, #121, #122, #125, #126, #128, #132, #134, #135, #136, #137,
    #138, #140, #144, #147, #148, #155.
- Partial P1 journeys left:
  - #11, #14, #16, #18, #19, #20, #21, #22, #23, #24, #35, #36, #37, #40, #45, #47,
    #49, #54, #57, #58, #60, #64, #65, #66, #67, #70, #72, #77, #78, #81, #82, #88,
    #91, #92, #93, #98, #101, #102, #103, #105, #107, #108, #109, #110, #111, #113,
    #114, #115, #120, #123, #131, #133, #139, #141, #142, #143, #146, #149, #154.
- Partial P2 journeys left:
  - #31, #50, #55, #104, #124, #152, #153.
- Open journeys:
  - #1 - Locked Core-state install against the final Developer ID-signed and notarized artifact.
  - #2 - Pro entitlement/activation against that same final production artifact.
- Corrective note:
  - The prior `153 covered / 2 left` snapshot overcounted rendered tests, source guards, direct
    database tests, and fake-boundary integrations as full release journeys.
  - The detailed evidence below is retained as a useful test inventory, but every item not named in
    the complete lists above is strictly partial until its missing production seam is added.
  - TTS exposed this defect: the former download-to-speech test used a fake worker and could not
    catch packaged module or ONNX model-loading failures.
- Current local TTS correction:
  - `/Applications/Off Grid AI Desktop.app` is version 0.0.40 with bundle id
    `co.getoffgridai.desktop.pro`.
  - The installed exact artifact imports `kokoro-js` from its integrity-checked ASAR, materializes
    the ONNX model into a writable cache, and synthesized 100,844 bytes of non-zero PCM16 mono
    24 kHz audio in the headless package probe.
  - Installed ASAR SHA-256:
    `041f576bdeb82b0332ede5346b1f3353831edcf1fb1035952caf50b8baf179e0`.
  - The application now persists redacted main-process business/runtime diagnostics at
    `~/Library/Application Support/Off Grid AI Desktop/logs/off-grid-ai-desktop.log`.
- New exact-gate classification notes:
  - #5 remains partial. The copied-DMG helper probe now executes every exact packaged native helper
    and rejects missing binaries, loader errors, and build-host dependencies, but it does not open
    the installed app's System Health surface and reconcile that UI with the same helper run.
  - #20 and #105 remain partial. The release workflow performs real non-zero Kokoro synthesis from
    the exact packaged ASAR worker, while the rendered integration joins Speak, production TTS IPC,
    the persisted voice, synthesis, WAV validation, and browser playback with only the heavyweight
    ONNX worker controlled. The multimodal runtime integration now also joins a real chat answer,
    unexpected native LLM crash, failed TTS subprocess, immediate speech retry, one replacement LLM
    process, recovered chat, and a second valid WAV. No single test yet joins model download,
    selection, packaged worker loading, rendered Speak, and audible hardware output.
  - #69 remains partial. The real LLM service now refuses image input without a projector, and Pro
    capture layout learning skips that optional vision work while OCR continues. The rendered chat
    guard still substitutes the preload/API seam, so the full user journey is not yet proven.
  - #34, #43, #52, and #53 now share a composed production-seam proof in
    `memory-rag-chat-lifecycle.integration.dbtest.ts`. It creates projects through IPC, indexes real
    files, embeds captured memory, persists current and sibling chats, invokes scoped chat over the
    real LLM transport, enforces the `includeMemory` policy, deletes and reindexes sources, closes
    and reopens SQLite, and proves old, current-chat, and cross-project context never leaks back in.
    These journeys remain partial because the rendered controls and installed-app relaunch are not
    part of this integration test.

## High-leverage integration wave 4 - 5 of 5 complete

- Status:
  - Commissioned journeys: 5 total.
  - Commissioned journeys complete: 5.
  - Commissioned journeys left: 0.
- Complete - every model from download to real consumption:
  - `fresh-setup-first-use.integration.dbtest.ts` now derives the five required modality kinds from
    the production catalog, interrupts every representative download after durable partial bytes,
    reloads the module graph, and range-resumes text, vision, image, transcription, and voice.
  - Every model is activated through the generic production model-manager seam and consumed by its
    real owner: text and image-bearing chat through `LLMService`, PNG generation through imagegen and
    the modality queue, transcription through the selected STT service, and speech through TTS.
  - The journey closes and reopens its disposable SQLite profile, reloads all modules, consumes all
    five modalities again without another remote request, and verifies their persisted selections.
  - Only HTTP delivery and the native llama.cpp, stable-diffusion.cpp, whisper.cpp, and Kokoro
    processes are controlled boundaries. No Off Grid service, store, router, or runtime owner is
    mocked.
- Complete - active-service privacy deletion with no late-write resurrection:
  - `capture-deletion-race.integration.dbtest.ts` starts the real focus scheduler, native capture
    wrapper, extractor, local-model client, CRM repositories, privacy registry, SQLite profile, and
    capture filesystem, then invokes the production full-delete path while distillation is active.
  - Core now owns an owner-keyed suspend, drain, delete, and reverse-resume protocol. Pro supplies
    the capture lifecycle through the composition root, closes admission synchronously, waits for
    the admitted tick, erases its late output, restores only its own pause, and stays empty after
    profile relaunch.
  - Electron/TCC, focused-window discovery, LanceDB, and llama-server are the only controlled
    boundaries. No Off Grid module is mocked.
- Complete - concurrent workload ownership, cancellation, crash recovery, and clean relaunch:
  - `concurrent-workload-recovery.integration.dbtest.ts` starts four production catalog downloads
    against controlled HTTP streams: three active transfers and one queued transfer.
  - The production shutdown registry closes queue admission, interrupts and settles every owned
    promise, preserves resumable partial files, and never starts the queued transfer. A cloned crash
    profile then reloads the real registry and SQLite chat state, resumes with HTTP Range to the
    exact GGUF bytes, and accepts new persisted work after relaunch.
  - HTTP streams and Electron host-path/encryption APIs are the only controlled boundaries. The
    model manager, queue, shutdown registry, catalog, filesystem, and SQLite repositories stay real.
- Complete - mid-operation permission revocation and recovery:
  - `capture-disabled.integration.test.ts` admits a production scheduler tick, revokes Screen
    Recording while focused-window discovery is unresolved, and proves the denied screenshot is
    dropped with actionable production health state and no additional native work.
  - Restoring only the TCC boundary lets the same interval and real SQLite `SettingsStore` capture
    again without restarting the app or scheduler.
  - Electron/TCC and `get-windows` are the only controlled boundaries. No Off Grid module is mocked.
- Complete - atomic cross-store recovery from disk and database failures:
  - `meeting-atomic-recovery.integration.dbtest.ts` exercises production meeting persistence and
    recovery over real SQLite, files, CRM observations/actions, and the local-model HTTP client.
  - Partial `ENOSPC` writes leave no final media or database row. A complete atomic media write
    followed by SQLite insert failure remains recoverable, is adopted and enriched exactly once on
    relaunch, and stays idempotent across a second relaunch.
  - Electron, native media executables, the local model process, and the injected filesystem
    capacity failure are the only controlled boundaries. No Off Grid service is mocked.
- Verification:
  - All five commissioned journey cases passed in focused runs.
  - Download queue and application-shutdown checks: 9 tests passed.
  - Capture lifecycle and projection checks: 7 tests passed.
  - Adjacent meeting persistence and entity-context checks: 3 tests passed.
  - Node and web TypeScript: passed.
  - Scoped ESLint completed with zero errors; Prettier and diff checks passed.
  - No Playwright or Electron E2E test was added or run.

## High-leverage integration wave 3 - 5 of 5 complete

- Capture privacy, memory, Replay, search, and lifecycle recovery:
  - `capture-privacy-lifecycle.integration.dbtest.ts` joins production capture policy, OCR and
    extraction, observations, frames, entities, universal search, Replay, lock/sleep coordination,
    category deletion, and encrypted-profile reopen.
  - Capture-category deletion now invokes feature-owned projection cleaners, removes screen-owned
    observations, frames, entity links, actions, and index receipts, and preserves shared entities
    and multi-source actions.
- Multimodal import, scoped RAG, deletion, and reopen:
  - `multimodal-rag-lifecycle.integration.dbtest.ts` imports real text, PDF, DOCX, audio, video, and
    image fixtures through production extraction, SQLite, project scoping, citations, conversation
    persistence, source deletion, failure rollback, and profile reopen.
  - Interrupted embedding now rolls back its document row and chunks instead of leaving ghost
    knowledge records.
- Local-first no-egress sessions across Core and Pro:
  - `image-runtime-reliability.integration.dbtest.ts` proves local RAG, chat, image generation,
    vision, and artifact persistence issue no external requests while a loopback model engine is
    active.
  - Pro `local-first-pro-session.integration.dbtest.ts` proves Replay, CRM ingestion, dictation
    memory, entities, actions, and the encrypted KDBX vault remain local in the same session.
- Generated-image and artifact lifecycle:
  - `image-runtime-reliability.integration.dbtest.ts` now generates a real PNG through the native
    executable boundary, scopes it, catalogs it as an image artifact, exports exact bytes, reloads
    its modules, and deletes the artifact, PNG, and metadata without deleting the exported copy.
  - Generated-image scope and export ownership now live in the image service. Export rejects
    renderer-supplied source paths outside the image library, metadata/export writes are atomic,
    and deletion no longer orphans scope sidecars.
- Universal retrieval, typed navigation, and mutation invalidation:
  - Pro `universal-search.dbtest.ts` seeds capture, connector, meeting, entity, fact, memory, chat,
    and knowledge sources, then drives every returned kind through the shared typed renderer
    navigation adapter.
  - The journey renames, hides, and deletes the production sources and proves keyword, facets, and
    the deliberately stale semantic cache return no ghost results. Hidden-entity facts are filtered,
    fact keys retain fact identity, and deleting an observation removes its orphan raw frames.
- Verification status:
  - Commissioned journeys: 5 total.
  - Commissioned journeys complete: 5.
  - Commissioned journeys left: 0.
  - No Playwright or Electron E2E tests were added or run for this wave.
  - The strict 155-journey release counts above remain unchanged because these composed seams do
    not replace signed-package, rendered-control, physical-device, or audible-output evidence where
    those terminal artifacts are required.

## High-leverage integration wave 2 - 5 of 5 complete

- Connector approval and revocation lifecycle:
  - `connector-approval-lifecycle.dbtest.ts` joins encrypted connector credentials, real stdio MCP
    discovery, read execution, write rejection, exactly-once approval execution, audit history,
    connector deletion, secret deletion, and database reopen.
  - It exposed and fixed approvals carrying only a display name while execution required a numeric
    connector identity. New approvals persist `connector_id`; legacy references resolve through the
    connector repository and deleted connectors fail closed.
- Complete voice conversation lifecycle:
  - `memory-chat-tts.ui.integration.dbtest.ts` now drives rendered voice mode through controlled
    microphone/MediaRecorder boundaries, production transcription IPC and Whisper selection,
    production RAG chat IPC and LLM transport, real SQLite message persistence, production TTS IPC,
    worker failure, visible recovery, playback, pause, remount, and text fallback.
  - It exposed and fixed swallowed speech failures. `VoiceBubble` now presents an actionable alert
    and clears it before retry.
- Fresh setup through first use:
  - `fresh-setup-first-use.integration.dbtest.ts` starts with no profile, runs the production setup
    planner and model manager, interrupts and range-resumes chat, transcription, and voice model
    downloads, activates all three, consumes each through its production runtime owner, reloads the
    profile, and proves selection persistence with no redownload.
  - It exposed and fixed fresh-profile performance settings being lost before the models directory
    existed.
- Meeting intelligence lifecycle:
  - `meeting-persistence.dbtest.ts` now joins real media persistence, ffmpeg/Whisper selection,
    local summary transport, entity-backed observation and evidence, meeting-sourced contextual
    actions, database reopen, and deletion of meeting-owned actions, observations, frames, and
    media while preserving the shared entity.
- Complete Core and Pro personal-data erasure:
  - Core and Pro delete-all integrations exercise real connector, secret, knowledge, encrypted
    vault, filesystem, registry, SQLite close/reopen, and retained-model/settings behavior.
  - They exposed and fixed `vault.kdbx` and `vault.recovery` surviving Delete All while decrypted
    vault state remained live in memory. Root files and pre-delete handle cleanup are now first-class
    personal-store registry capabilities.
- Boundary note:
  - These are integration tests, not Playwright E2E tests. Remote providers, microphone/speaker,
    heavyweight native runtimes, and network delivery are controlled only at their external
    boundaries. The strict release counts above remain conservative where a signed installed app,
    physical hardware, or audible output is still required.

## Prior evidence inventory

The sections below describe the previously accumulated evidence. Their old `Covered` headings are
historical labels, not strict completion claims. Use the strict snapshot above for release status.

## Previously claimed P0 evidence

- #3 - Fresh profile is truly fresh. `fresh-profile.dbtest.ts` opens a brand-new disposable profile
  through the production repositories and proves chats, projects, memories, entities, summaries,
  identity, master memory, and dashboard counts are empty before any seeder runs. First-run
  onboarding and the packaged preload boundary remain manual.
- #4 - Core and Pro artifact separation. `release-packaging.integration.test.ts` builds both
  resolved source graphs with sourcemaps and proves Core contains no `pro/` implementation while
  retaining the locked shell and entitlement gates; Pro excludes the stub and includes both real
  activation entry points.
- #5 - Packaged helper binaries exist. `packaged-helpers.integration.test.ts` runs real
  `electron-vite` and `electron-builder` with the production packaging config, then proves the
  artifact contains hydrated executable llama, ffmpeg, and Whisper helpers at the runtime-resolved
  paths plus every staged dylib as an exact-name regular file. `probe-packaged-helpers.mjs` now runs
  llama-server, ffmpeg, Whisper, and both image helpers from the copied DMG app and rejects missing
  dependencies. The installed System Health UI is not yet reconciled with that same execution.
- #6 - Packaged llama dependency closure. `release-packaging.integration.test.ts` invokes the exact
  repository `scripts/build-llama.sh` against a disposable CI-shaped output and proves transitive
  `@rpath` closure, non-symlink staging, exact deployment-target comparison, and rejection of both
  `/opt/homebrew` and `/usr/local` dependencies.
- #7 - Upgrade preserves user data. Pro `upgrade-profile.dbtest.ts` loads a fixture pinned to the
  previous release's Core and Pro schemas, forces the current Pro migration to fail with SQLite
  `FULL`, proves the transaction leaves chats, Pro observations, and encrypted entitlement intact,
  then reopens the same profile, completes current migrations and owners, and relaunches again.
  Chats, memory, projects, knowledge, settings, Pro data, entitlement, model selections, and new
  post-upgrade writes all remain intact. Signed installer replacement remains a separate device
  check.
- #9 - Fresh onboarding completes. `e2e/smoke.spec.ts` drives the real onboarding flow and lands on
  Models.
- #10 - Configure for me completes. `model-server-chat.integration.test.ts` runs production
  auto-configuration against a temp profile, real catalog/model manager and filesystem, proving
  the conservative chat, transcription and voice baseline downloads, activates, and reaches the
  terminal done state through only download/native-process boundaries.
- #13 - System Health is truthful. `HealthPanel.integration.test.tsx` mounts the real panel through
  the production system-status IPC, setup, LLM, helper-resolution, and TCC owners on a disposable
  profile. It proves running and unavailable helpers, denied then granted permissions, and a real
  spawned engine stderr classified as `unknown model architecture: gemma4` render the matching
  actionable states. Comparing every row with the signed installed artifact remains manual.
- #15 - Required macOS permissions granted. `permission-recovery.test.ts`,
  `media-permission.test.ts`, Pro notification tests, the live capture scheduler journey, and the
  connected dictation overlay prove explicit Screen Recording and Accessibility requests,
  non-prompting health polls, media admission, live recovery, and native notification `.show()`.
  Granting all four TCC permissions in the signed app and checking relaunch prompts remains manual.
- #17 - Text model downloads. `model-download-matrix.integration.test.ts` streams deterministic
  GGUF bytes through the production manager's HTTP boundary, verifies observable progress and
  atomic promotion, then activates the installed catalog model through the real selection owner.
- #25 - Interrupted download recovers. `model-integrity.integration.test.ts` interrupts a real
  streamed partial, reloads the manager, resumes with the correct HTTP range, verifies exact final
  bytes and installation, then reloads again to prove completed state stays cleared.
- #26 - Truncated GGUF is rejected. `model-integrity.integration.test.ts` drives the real model
  manager against a temp filesystem, with only HTTP delivery faked, and proves truncated downloads
  and local imports are rejected before promotion, installation, copying, or registration.
- #27 - Disk write failure does not crash. The same real model-manager integration injects
  `ENOSPC` only at the OS write boundary and proves the error is contained, no partial model is
  installed, failed status is recorded, and an existing installed model remains readable.
- #28 - Active text model survives relaunch. `model-integrity.integration.test.ts` installs and
  activates a real catalog text fixture through the production model manager, reloads every module,
  and proves the same installed model remains the active chat selection.
  `model-switch-ownership.integration.test.ts` additionally imports and activates two real local
  GGUF fixtures, starts the production native-process and SSE path, changes selection while Model A
  is streaming, proves that admitted turn completes on A, then proves the next turn starts Model B.
- #32 - First local message replies. `MemoryChat.chat-lifecycle.test.tsx` sends through the real
  rendered composer, routes a streamed token through production ownership, resolves the local-model
  boundary, and proves one assistant bubble with the exact answer is persisted once.
  `workspace-production-bridge.ui.integration.dbtest.tsx` removes the substituted Off Grid preload
  API: the rendered composer uses the production preload mapping and IPC registrations, streams from
  only a controlled native-model socket, and persists the exact visible user and assistant turns in
  real SQLite.
- #33 - No memory scope works. The same rendered integration keeps No memory visibly selected,
  sends a turn through the production chat path with retrieval disabled and no project scope, then
  renders the conversation-only answer normally.
- #34 - All memory scope works. `rag-empty-memory.dbtest.ts` seeds a synthetic capture into real
  SQLite/FTS storage, invokes the production `rag:chat` IPC handler in All memory mode, and proves
  the local-model prompt, answer, streamed retrieval count, and returned `[S1]` citation all carry
  the exact matching source. `memory-rag-chat-lifecycle.integration.dbtest.ts` additionally proves
  captured memory enters and leaves project-scoped retrieval through the persisted project policy.
- #38 - Stop before first token. `MemoryChat.chat-lifecycle.test.tsx` holds the real rendered turn
  at the preload persistence boundary, clicks Stop during the pre-stream window, proves the model
  transport never starts, and immediately completes a second turn normally.
- #39 - Stop during streaming. The same integration routes a live token through production stream
  ownership, clicks Stop, verifies cancellation uses that stream ID, and proves the partial answer
  remains visible and persisted while the busy state clears.
- #41 - Conversation switch isolation. The same integration starts and streams conversation A,
  switches the rendered screen to B, proves B receives none of A's partial or completed state, then
  reopens A and retrieves its correctly persisted result.
- #42 - Project switch isolation. The same integration sends from Project Alpha, changes the real
  project selector to Project Beta while the model boundary is pending, and proves the result and
  parsed HTML artifact retain the Alpha project and conversation captured at send time.
- #43 - Chat survives relaunch. `chat-relaunch.dbtest.ts` creates a conversation and ordered user
  and assistant messages with exact scope, attachment, and finish context through the production
  repository, closes the real SQLite profile, reopens it, and verifies the conversation, message
  count, order, content, and context. The composed memory/RAG lifecycle also reloads the application
  modules and runs another scoped chat against the reopened profile.
  `workspace-production-bridge.ui.integration.dbtest.tsx` closes and reopens that real database,
  then renders the production Projects and Chat surfaces through production preload/IPC. The project,
  chat count, ordered messages, and project-scoped artifact all reappear visibly from durable state.
- #48 - Error clears busy state. `MemoryChat.chat-lifecycle.test.tsx` rejects a live turn at the
  native-model boundary, proves the rendered error is useful and Stop clears, then sends and renders
  a successful second turn through the same production composer.
- #52 - Attach a knowledge document. `rag-store-integration.dbtest.ts` drives a real Markdown file
  through production extraction/chunking, real SQLite persistence and retrieval, and prompt
  formatting, with only the local embedding-model boundary deterministic. The composed lifecycle
  adds the production attach-dialog IPC, delete, changed-file reindex, and post-reopen retrieval.
- #53 - Project retrieval is grounded. `rag-store-integration.dbtest.ts` indexes real Markdown
  files into two projects through the production RAG service and SQLite store, then proves selected
  project and enabled-document filters exclude obsolete and cross-project facts from retrieval and
  prompt context. The composed lifecycle extends this through production chat prompt assembly and
  proves sibling chat inclusion plus current-chat and cross-project exclusion before and after
  reopen.
- #51 - Create a project. `src/main/__tests__/rag-store-integration.dbtest.ts` exercises the real
  project store against temp SQLite and verifies the round trip.
- #56 - Delete project cascades. `src/main/__tests__/project-delete-cascade.dbtest.ts` uses the real
  project, conversation, message, artifact, document, and chunk paths and proves no orphans remain.
- #61 - Text prompt generates an image. `MemoryChat.image.test.tsx` drives the real rendered image
  composer through its preload boundary, holds the native image job pending, emits live production
  progress, then proves exactly one generated image reaches the conversation.
- #62 - Image cancellation is scoped. The same rendered integration starts an image job in one
  conversation, switches conversations, and proves progress and Stop stay with the owning
  conversation; stopping it calls the native cancellation boundary exactly once.
- #63 - Image cancellation keeps text. `e2e/chat-memory.spec.ts` drives a real tool turn through a
  fake native llama socket, renders and clicks the tool-owned image Stop action during pre-spawn
  memory reclamation, proves the shared lifecycle prevents `sd-cli` from starting, then fully
  relaunches Electron on the same real SQLite profile and restores the assistant text.
- #68 - Vision answers about attachment. The rendered composer processes a ready image attachment,
  sends its persisted path and the exact typed question through the production vision path, and
  renders the returned answer.
- #69 - Text-only model guards image input. The same integration proves an unavailable vision
  capability produces a visible explanation before image processing or model delivery, then
  completes a text-only turn normally. Real active-model and projector files now drive the LLM
  service guard for chat and streaming, and Pro layout learning skips optional vision work for a
  text-only selection. The rendered test still substitutes the preload/API seam.
- #71 - Connector can be added. `integration-tests/mcp-connector-setup.dbtest.ts` drives the real
  Integrations screen through a native IPC boundary adapter into production connector persistence,
  encrypted SQLite, MCP discovery, and a real stdio child, proving connected appears only after
  discovery and exactly one row with `read_status` survives database reopen.
- #73 - Connector tool executes. The real connector extension executes a read-only tool through
  its remote boundary and returns the result; `tools-loop.dbtest.ts` proves extension output flows
  through the production tool loop into the final answer.
- #74 - Write tool requires approval. `mcp-connector-tool-extension.dbtest.ts` uses real connector
  state and the production extension to prove a write is queued at the approval boundary before
  the remote call can execute.
- #75 - Stop prevents connector side effect. `tools-loop.dbtest.ts` aborts after the streamed tool
  call but before extension execution and proves the side-effect implementation is never invoked;
  the dispatch guard ensures connector tools use that same abstraction.
- #76 - Expired connector becomes error. The connector integration injects an authorization
  failure only at the remote boundary and proves the real SQLite connector changes to an error
  state with an actionable detail while healthy tools remain available.
- #79 - Gateway models endpoint. `e2e/smoke.spec.ts` starts the real Electron gateway, seeds an
  active model only inside the disposable profile, calls `/v1/models` over HTTP, and verifies
  modality metadata in both supported response shapes.
- #80 - Gateway chat streaming. `model-server-chat.integration.test.ts` sends an
  OpenAI-compatible streaming request through the real HTTP gateway to a loopback llama-server
  boundary and proves the first SSE token arrives before upstream completion, later chunks retain
  their content, and the stream terminates with `[DONE]`.
- #83 - Screen capture permission path. `capture-disabled.integration.test.ts` keeps the real
  production capture interval, focus extractor, settings store, and filesystem writer connected
  while only the Electron/TCC boundary changes from denied to granted; the next eligible tick writes
  a frame without restarting the loop or app.
- #84 - Capture disabled means no capture. `capture-disabled.integration.test.ts` backs the real
  capture state machine with the production settings store and proves the persisted privacy pause
  survives hydration, prevents OS capture work across ticks, and resumes only after user action.
- #85 - OCR creates searchable memory. `capture-exclusion.dbtest.ts` drives a normal surface through
  screenshot, OCR, the real extractor, model transport, and SQLite persistence, then queries the
  production observation search and retrieves the derived memory; only OS capture/OCR and the
  native model socket are controlled boundaries.
- #86 - Sensitive or excluded apps are omitted. `capture-exclusion.dbtest.ts` drives the production
  extractor and real SQLite persistence, with only screenshot/OCR and the model socket at their
  external boundaries, and proves configured apps, authentication surfaces, private browser
  windows, and password-manager URLs stop before capture while a normal app still persists.
- #87 - Replay timeline renders. `e2e/pro.spec.ts` uses production Pro seeding to write real PNG and
  SQLite capture data, independently verifies filesystem chronology matches IPC order, then drives
  the real Replay UI through every frame and proves image, app, caption, full timestamp, scrubber
  time, and position remain usable and ordered.
- #90 - Unified search finds each source. `pro/main/__tests__/universal-search.dbtest.ts` writes
  captured and connector-derived observations plus meeting, entity, fact, memory, chat, and
  knowledge records through their production SQLite owners, then proves one production search
  returns every source with its real facet and deep-link identifier.
- #94 - Delete all removes capture corpus. `pro/main/__tests__/personal-data.dbtest.ts`
  registers the real Pro personal-data owner, runs the real delete-all path, and verifies the
  observations corpus is gone.
- #95 - Meeting detection is truthful. `meeting-lifecycle.integration.test.ts` drives the production
  classifier and controller with only active-window/native-recording boundaries controlled. It
  proves supported presence starts once, explicit lobby/post-call states do not record, leaving
  warns then stops, and the capture resource is released.
- #106 - Mic and TTS stop cleanly. `MemoryChat.chat-lifecycle.test.tsx` proves canceled synthesis
  cannot start late and unmount pauses active audio; `DictationOverlay.integration.test.tsx` proves
  unmount stops the recorder, microphone track and audio context and removes every event listener.
- #96 - Manual meeting recording. `MeetingsScreen.integration.test.tsx` renders the real screen and
  recorder hook, clicks Record then Stop, and proves exactly one sane-duration completed meeting is
  visible with capture inactive.
- #97 - Meeting transcript and summary. Pro `meeting-persistence.dbtest.ts` sends synthetic WAV
  bytes through production ffmpeg and Whisper selection, persists the exact transcript, sends it to
  the local summary boundary, verifies the returned recap retains the named owner, deadline, and
  next step, folds both into memory, and restores the completed meeting after relaunch.
- #99 - Global dictation hotkey. Pro `dictation-paste-failure.ui.integration.dbtest.ts` connects the
  production shortcut controller, overlay, recorder, STT, IPC, and database; it proves one
  Option+Space toggle lifecycle, correct rebind/unregister behavior, and complete resource teardown.
- #100 - Dictation pastes at cursor. The same connected journey captures the target app, sends the
  exact transcript once through the native paste boundary, preserves it in the saved recording,
  and restores the prior clipboard. Real TextEdit caret placement remains a signed-device check.
- #112 - Approval queue gates actions. `approvals.integration.test.ts` exercises real proposal,
  decision, execution, failure, and audit persistence against SQLite.
- #116 - CRM processing tolerates schema upgrades. `crm-schema-upgrade.dbtest.ts` creates a real
  legacy SQLite schema, drives the production observation funnel, verifies additive migration and
  row preservation, then reopens the database and proves processing remains idempotent.
- #117 - Clipboard records text. Pro `clipboard-popup-journey.dbtest.ts` changes a controlled native
  clipboard boundary after capture starts, then waits for the production poller, Electron adapter,
  encrypted SQLite store, and IPC list to expose that exact text. Manual verification still owns
  the signed-app macOS pasteboard boundary.
- #121 - Clipboard restore text. Pro `clipboard-popup-journey.dbtest.ts` inserts through the
  production store, overwrites the controlled native clipboard, restores through production IPC
  and the Electron adapter, and verifies the original text returns. Pasting into another signed app
  remains manual.
- #122 - Clipboard restore file. Pro `clipboard-popup-journey.dbtest.ts` inserts real file bytes
  through the production store, restores over production IPC, verifies byte-exact reconstruction in
  the disposable profile, and proves the macOS pasteboard writer receives the reconstructed path.
  Finder and Terminal paste behavior remain native manual checks.
- #125 - Create and unlock vault. `vault-service.test.ts` uses real KDBX4, Argon2id, WASM crypto,
  and a real temp directory; correct and incorrect passwords are covered.
- #126 - Vault item types round-trip. `vault-service.test.ts` covers real encrypted CRUD and binary
  attachment persistence across lock and unlock.
- #128 - Vault recovery and backup. `vault-service.test.ts` and `vault-recovery.test.ts` exercise
  real KDBX export bytes, recovery setup, wrong phrases, and recovery to a new password.
- #132 - Settings survive relaunch. Existing journeys 129 and 131 cover model residency and
  resource settings across relaunch. Core and Pro `settings-persistence.dbtest.ts` tests add the
  other owning stores: they change software-update, capture-privacy, identity, and proactive
  delivery settings over real encrypted SQLite, close the database, reload every Off Grid module,
  rehydrate each owner, and verify every value restores.
- #134 - Clear cache preserves user data. `cache-cleanup.integration.test.ts` and the rendered
  Storage journey exercise the production control through IPC and prove its allowlist can reach
  only Electron's `cache` data type. Chats, projects, models, vault, settings, entitlement, and
  unknown app files are unreachable by construction; success and failure states are both visible.
- #135 - Delete category is scoped. The real SQLite/filesystem integration deletes the Chats
  category through `clearCategory` and proves memory, projects, connectors, encrypted tokens,
  models, and unrelated personal files remain.
- #136 - Delete all is complete. Core and Pro DB integration tests seed projects, chats, memory,
  knowledge, connectors, encrypted tokens, profile data, every registered Pro table, and every
  personal-data directory. They run the real delete-all registry, close and reopen the encrypted
  database, and verify personal data stays gone while models and ordinary preferences survive.
- #137 - Core locked Pro tabs. `App.locked-pro-tabs.integration.test.tsx` renders the real free App
  from the production Pro catalog, opens all 11 locked routes, verifies the single UpgradeScreen and
  canonical purchase URL, and proves renderer registries plus Pro approval/action IPC remain inert.
  Launching the exact packaged Core artifact remains manual.
- #138 - Pro license activates. `licensing.integration.test.ts` activates through the production
  IPC/service against a remote license boundary, proves the cached key is encrypted, reloads every
  module, and verifies the synchronous entitlement gate still unlocks Pro. The rendered Upgrade
  screen proves the user sees activation and the required restart action.
  `service-activation.integration.dbtest.ts` now continues that same persisted entitlement through
  the production Core loader and actual Pro `activateMain`: an unentitled boot starts nothing, the
  entitled relaunch migrates Pro SQLite and starts owned services once, application shutdown removes
  shortcut/tray/service resources, and a cleared-license relaunch stays locked.
- #140 - Offline entitlement behavior. The licensing integration activates a lifetime entitlement,
  reloads with its network boundary unavailable, and proves the OS-protected encrypted cache remains
  entitled while a fresh profile, a forged plaintext cache, and an expired entitlement stay locked.
- #144 - Local use works offline. A shared offline boundary rejects and records every outbound
  request while preserving real loopback transports. Connected Core and Pro integrations prove
  local chat, image generation, Vision OCR, replay, SQLite/FTS search, dictation, and KDBX/Argon2
  vault operations remain usable with zero unexpected egress; the real model manager also proves a
  network-only download fails clearly and retries without corrupting installed state.
- #145 - Cold relaunch after forced quit. `e2e/chat-memory.spec.ts` kills the real Electron main
  process during non-destructive chat activity, waits for process exit, reopens the same profile,
  and verifies clean boot, preload availability, usable input, and durable committed chat data.
- #147 - Engine restart recovers. `image-runtime-reliability.integration.dbtest.ts` crashes the
  native llama executable boundary while a real gateway request waits, proves the production service
  marks it down, runs a failing then successful TTS subprocess without wedging speech, starts exactly
  one replacement LLM, returns the recovered chat response, and synthesizes that recovered answer to
  a valid WAV. Teardown verifies the gateway/model ports rebind and every owned child process exits.
- #148 - Low disk space is handled. Model and artifact integrations constrain only disposable OS
  write boundaries, force mid-stream `ENOSPC`, and prove the active partial is removed, resumable
  network partials are retained, artifact JSON uses atomic promotion, and existing model and
  artifact bytes remain readable.
- #155 - No private data in release evidence. Both Core and Pro screenshot harnesses now consume
  `release-evidence-profile.mjs`, which rejects non-temporary profiles, strips hostile inherited
  profile/seed variables, and enables only the synthetic seeders. The integration probe proves a
  real user-data path cannot be selected; the defect where Core's tour opened the default profile
  is fixed.

## Previously claimed P1 evidence

- #8 - Window identity and product name. `product-identity.test.ts` locks package, builder, local
  Core/Pro build, renderer document, and runtime bootstrap names to `Off Grid AI Desktop`;
  `e2e/tour.spec.ts` launches the built Electron app and verifies both its visible window title and
  Electron runtime name match that canonical product identity.
- #11 - Manual setup path works. `manual-model-setup.test.ts` drives PermissionGate into manual
  model selection, downloads through the production manager and real catalog, verifies only the
  chosen GGUF is fetched and promoted, activates it through the real selection owner, and proves
  the rendered Models card reaches Active while every unchosen model remains absent.
- #12 - Onboarding resumes after relaunch. The production Electron journey uses a fresh Core
  profile across three full process launches, proves the saved step and all six capability labels
  restore, completion clears progress, and an interrupted registry plus `.part` file returns as a
  failed transfer with the exact Retry UI without losing partial bytes.
- #14 - Chat engine stderr is surfaced. The same integration starts a native child that reports an
  incompatible `gemma4` architecture and exits, then proves System Health returns the classified
  engine-too-old reason rather than a generic down message.
- #16 - Denied permission is recoverable. `permission-recovery.test.ts` and
  `MemoryChat.microphone-permission.integration.test.tsx` drive the production permission owners
  from denied to the correct System Settings target and prove the rendered microphone path stays
  usable for retry without reloading the app.
- #18 - Vision model downloads. `model-download-matrix.integration.test.ts` proves a real catalog
  vision model remains unavailable until both weights and projector finish, then activates the exact
  primary/projector pair persisted by the production manager.
- #19 - Speech model downloads. The same matrix downloads every Parakeet file, activates it through
  the manager, and runs the production transcription selector against only a native executable fake
  to return synthetic dictation text.
- #20 - TTS model downloads. `model-download-tts.integration.dbtest.ts` downloads all voice files,
  activates SQLite-backed speech residency, and drives production synthesis to a valid WAV through
  only the heavyweight worker boundary. The release gate separately synthesizes non-zero PCM from
  the exact packaged ASAR worker, but it does not consume the model through the download journey.
- #21 - Image model downloads. The model matrix holds a multi-file catalog image runtime unavailable
  until its full file set lands, then proves the production image status and active selection agree.
- #22 - Multiple downloads queue. Production download ownership enforces three active transfers,
  exposes FIFO queued state, rejects duplicate queued IDs, cancels queued work, and drains four real
  transfer promises without dropping or prematurely resolving any model.
- #23 - Delete does not cancel another download. The matrix holds one real HTTP download pending,
  deletes a different installed model through the production manager, then completes and installs
  the untouched in-flight model.
- #24 - Offline download fails clearly. `model-integrity.integration.test.ts` drives the real model
  manager through an offline fetch failure, verifies a clear network-unavailable error and clean
  filesystem state, preserves an existing installed model, then retries successfully with the same
  manager and exact GGUF bytes.
- #29 - Active modal models survive relaunch. `model-integrity.integration.test.ts` installs and
  activates real image, STT, and TTS catalog fixtures, reloads every manager module, and proves each
  persisted modality restores its own selection without crossing into another modality.
- #30 - Deleting an active model clears selection. `model-integrity.integration.test.ts` activates
  installed text, vision, image, speech, and transcription fixtures through the production model
  manager, deletes each one, and proves all runtime and persisted selections remain cleared after a
  fresh module load.
- #35 - Empty memory degrades safely. `rag-empty-memory.dbtest.ts` invokes the real `rag:chat` IPC
  handler on an empty SQLite/RAG corpus, verifies a normal answer, empty context and zero retrieval
  counts, then completes an immediate second turn to prove the queue and controller were released.
- #36 - Thinking streams separately. `MemoryChat.chat-lifecycle.test.tsx` drives a real rendered
  turn through the production thinking-stream parser and proves reasoning renders in its own block
  while the final answer remains separate.
- #37 - Plain reply hides think markers. The same rendered production path proves a plain reply
  exposes no parser markers or literal think tags while preserving the final response.
- #40 - Queued message order. `MemoryChat.chat-lifecycle.test.tsx` sends a second message through
  the real composer while the first model-boundary promise is pending, then proves production queue
  draining preserves user/assistant order without collision, duplication, or loss.
- #45 - Delete conversation cascades. `conversation-delete-cascade.dbtest.ts` proves real messages
  and artifacts do not survive conversation deletion.
- #47 - Regenerate reply. `MemoryChat.chat-lifecycle.test.tsx` invokes the rendered Regenerate
  action, replaces the old assistant answer from the same user context, and proves both the visible
  and persisted transcripts contain one user turn and the new answer without duplication.
- #49 - Long answer respects configured cap. The production stream adapters preserve native finish
  reasons, normalize only the configured token-cap cutoff, render the visible limit, and persist and
  restore that exact cutoff contract after conversation reload.
- #54 - New chat inherits its project. `MemoryChat.project-inheritance.test.tsx` drives the real
  composer from a project target across the preload boundary and proves both conversation creation
  and RAG retrieval receive the same project ID; reopening a saved conversation restores that scope.
- #57 - Text artifact saves and reopens. `artifact-persistence.integration.test.ts` saves exact
  text, title, conversation, and project scope through the production artifact service, reloads its
  modules, and proves the persisted artifact reopens without content or ownership drift.
- #58 - Image artifact saves and reopens. The same integration writes a real PNG to the disposable
  user-data tree, persists its metadata through the production artifact service, reloads the service,
  and proves both its source association and exact image bytes remain available.
- #60 - Unsupported document fails clearly. The production picker excludes unsupported types;
  `rag-store-integration.dbtest.ts` drives a corrupt PDF through the real parser, RAG service, and
  SQLite store and proves extraction fails clearly before documents, chunks, or embeddings exist.
- #64 - Image settings apply. `MemoryChat.image.test.tsx` drives the real image composer through
  per-model size, steps, and guidance overrides plus seed and negative prompt, proves the exact
  payload across remount, and restores generation metadata from persisted conversation context.
- #65 - Image runtime eviction recovers. `image-runtime-reliability.integration.dbtest.ts` starts
  the real chat service against a native executable boundary, generates an image through the real
  modality queue to evict it, then proves a second native chat process starts and answers the next
  message without an application restart.
- #66 - Image RAM guard is safe. `image-runtime-reliability.integration.dbtest.ts` proves an
  over-budget request stops before native execution, while the rendered integration exposes one
  explicit `Run anyway` recovery that retries the identical request and scope with the unsafe
  override and no duplicate turn.
- #67 - Generated image opens. `MemoryChat.image.test.tsx` opens the generated output in the shared
  lightbox, exports the exact production path and filename through the native save boundary, and
  closes the preview without duplicating the artifact.
- #70 - Damaged image fails safely. `files-image-upload.dbtest.ts` real-decodes image bytes with
  Sharp and proves invalid content never persists. The rendered composer shows the specific error
  on the attachment and successfully completes the next text turn.
- #72 - Connector tools load. `mcp-connector-tool-extension.dbtest.ts` discovers schemas through
  the production extension and real connector database, preserving enabled/disabled state while
  controlling only the remote MCP transport.
- #77 - Dead connector does not hang all tools. `mcp-timeout.dbtest.ts` runs the default production
  extension over real SQLite connectors and the real eight-second timeout; a non-responsive MCP
  process becomes an error while the healthy connector schema still returns.
- #78 - Connector delete removes secrets. `connector-delete-secrets.dbtest.ts` deletes through the
  production connector repository, reopens the encrypted database, and proves all owned OAuth,
  PKCE, client-registration, and env secrets are gone while unrelated secrets remain readable.
- #81 - Gateway image route. `model-server-image.integration.dbtest.ts` sends a real HTTP request
  through the production gateway, image orchestrator, modality queue, SQLite residency owner,
  argument builder, and generated-image filesystem. Only the native `sd-cli` executable is faked;
  the test verifies its PNG reaches the OpenAI-compatible response and disk, plus the missing-runtime
  path returns a stable `not_installed` envelope.
- #82 - Gateway failure envelope. `model-server-chat.integration.test.ts` sends malformed input
  through the real HTTP gateway, proves it receives the stable OpenAI-style JSON error contract
  without reaching the native model boundary, then calls the gateway again to verify it stays healthy.
- #88 - Replay playback uses media server. `media-server.integration.test.ts` runs the real
  loopback server over temp PNG, MP4, WAV, and byte ranges, while rendered Replay follows its
  emitted URL, fetches the exact bytes, advances playback, and shares the same media lifecycle with
  Meetings and Voice.
- #89 - Replay navigation preserves target. `e2e/pro.spec.ts` derives a query from an actual
  interior capture, opens its visible Search result through the production Pro router, and proves
  Replay lands on that exact image, app, timestamp, caption, and timeline position rather than the
  beginning of the session.
- #91 - Search filters and sort apply. The universal-search DB integration proves production source,
  recency, and match filtering over fresh results; `SearchScreen.integration.test.tsx` drives the
  rendered filter and sort controls and verifies visible ordering changes without stale rows.
- #92 - Day briefing renders. `DayReplay.integration.test.tsx` backs the rendered Day view with real
  SQLite and filesystem owners plus the real LLM service over a native-engine HTTP boundary, then
  proves priorities, meetings, suggestions, journal, time spent, and timeline all render.
- #93 - Day links open correct records. The rendered Day integration follows typed production
  targets to an exact action backed by real SQLite, entity ID, external calendar URL, Replay block
  timestamp, and meeting; stale action or meeting targets fail closed instead of selecting an
  unrelated record.
- #98 - Meeting survives relaunch. `meeting-persistence.dbtest.ts` saves synthetic meeting media,
  transcript, and local-model summary through production filesystem/SQLite owners, closes the DB,
  resets modules, and proves the exact audio metadata, transcript, and summary restore.
- #101 - Dictation paste failure is visible.
  `dictation-paste-failure.ui.integration.dbtest.ts` connects the real rendered overlay, voice
  bridge, IPC, controller, decode/transcription/storage path, and paste sink against denied
  focus/paste platform boundaries, proving the transcript remains on the clipboard and the exact
  actionable error stays visible after the controller broadcasts idle.
- #102 - Dictation engine selection. `voice-journeys.dbtest.ts` persists Whisper and Parakeet
  choices through generic dictation settings and runs both real CLI implementations against native
  executable boundaries without caller-side engine branching.
- #103 - Import media for transcription. The same real IPC/filesystem/SQLite integration imports
  synthetic media into a completed recording, while `VoiceScreen.integration.test.tsx` proves the
  rendered drop gesture refreshes into a searchable transcript card.
- #105 - Speak assistant reply. `memory-chat-tts.ui.integration.dbtest.ts` clicks the real rendered
  Speak action and runs production TTS IPC, the persisted SQLite voice setting, synthesis service,
  subprocess protocol, WAV validation, and browser Audio. Only the heavyweight ONNX worker and
  browser media boundary are controlled. It proves playback, visible Stop state, actionable worker
  failure, and stale-cancellation isolation. The release workflow separately requires non-zero PCM
  from the exact packaged worker before publishing. The multimodal runtime integration additionally
  proves a worker failure releases the busy guard immediately, the retry returns RIFF audio, and
  speech remains usable after the chat engine crashes and recovers.
- #107 - Entities are synthesized. `entity-action-journeys.dbtest.ts` records person, project, and
  company mentions through production observation and entity owners. The composed
  `entity-context-pipeline.integration.dbtest.ts` then runs the real screen extractor, dictation
  memory sink, meeting processor, and SQLite owners against one profile, proving their Maya and
  Starling evidence converges on two guarded canonical entities without source-specific copies.
- #108 - Self mentions are filtered. The same real-DB integration stores the user's name and aliases,
  passes mixed mentions through production identity filtering, and proves only the external person
  becomes an entity.
- #109 - Entity detail opens. `EntityNavigation.integration.test.tsx` drives the real Search result
  gesture into the real Entities screen and proves the selected ID's type, narrative, handle, and
  both evidence rows remain consistent across entry points.
- #110 - Entity merge preserves evidence. `resolve.integration.test.ts` exercises real entity,
  aliases, observations, relationships, action reassignment, split, and merge persistence.
  `entity-context-pipeline.integration.dbtest.ts` additionally proves a post-ingest rename updates
  every linked action's canonical name in the same correction transaction and survives relaunch
  without rewriting immutable source evidence.
- #111 - Action items are extracted. `entity-action-journeys.dbtest.ts` sends a synthetic commitment
  through the production extractor over a loopback native-model boundary. The composed
  `entity-context-pipeline.integration.dbtest.ts` proves screen, voice, and manual producers create
  three separately sourced contextual actions, all linked to the same canonical entity with their
  exact evidence intact after correction and relaunch.
- #113 - Action status survives persistence. `approval-relaunch.dbtest.ts` approves, rejects, and
  dismisses separate synthetic items through production encrypted SQLite and a real stdio MCP
  child, closes and reopens the profile, proves every status remains, and verifies stale or
  concurrent decisions cannot duplicate external execution or learning feedback.
- #114 - Notifications open their target. Production notifications preserve typed approval,
  action, and calendar targets across native and rendered delivery, wait for Pro routing readiness,
  dedupe live and persisted copies, focus the primary window, and fail closed when a target is stale
  instead of selecting an unrelated record.
- #115 - Reflect uses real time ranges. `reflect.integration.test.ts` verifies real observation
  windows, dwell caps, category rollups, context switches, and seven-day aggregation.
- #118 - Clipboard deduplicates repeated copy. `clipboard-store.integration.test.ts` exercises the
  real store and proves timestamp bump-to-top without duplicate rows or lost tags.
- #119 - Clipboard records images and files. Pro `clipboard-popup-journey.dbtest.ts` drives real
  temporary-file bytes and deterministic image bytes through the production poller, Electron
  adapter, encrypted SQLite store, and IPC list. The existing native tour additionally captures a
  real file URL and pixel bitmap and verifies exact bitmap dimensions.
- #120 - Clipboard live refresh keeps valid selection.
  `ClipboardScreen.integration.test.tsx` renders the real screen and proves selection is retained
  while the item exists, then moves to a valid remaining item after deletion.
- #123 - Clipboard popup hotkey. Pro `clipboard-popup-journey.dbtest.ts` registers the production
  `CommandOrControl+Shift+C` shortcut, waits for renderer readiness, reuses the popup, and preserves
  failed selection; rendered popup integration proves search, arrows, Enter restore, reopen reset,
  and visible retry without mocking clipboard logic.
- #129 - Runtime residency toggles persist. `e2e/settings-residency.spec.ts` changes image, STT,
  and TTS through the real Settings controls, verifies production IPC, fully relaunches Electron,
  and verifies all values reload. The SQLite and runtime-manager integrations prove that same map
  controls persistence and re-warm behavior.
- #127 - Vault copy actions. `e2e/pro.spec.ts` creates a real encrypted KDBX entry through
  production IPC and verifies username, revealed password, and URL copy into the OS clipboard.
- #130 - Chat residency stays required. `e2e/settings-residency.spec.ts` verifies the production
  switch stays checked and disabled before and after relaunch, while the real SQLite integration
  proves an on-demand write is normalized back to `resident`.
- #131 - Resource mode applies. `resource-mode.integration.test.ts` drives all three presets through
  the real LLM settings owner, disk persistence, fresh-service launch arguments, recommendation,
  and setup planner with only host RAM controlled; the Electron tour proves selection stays
  responsive and the sizing guards enforce memory clamps.
- #133 - Storage usage is truthful. `storage-usage.integration.dbtest.ts` writes exact synthetic
  model, capture, meeting, image, artifact, and thumbnail byte counts to a temp profile, then proves
  production storage owners and the rendered Storage/Data Privacy panels report their real totals,
  categories, models, and orphaned partials.
- #139 - Invalid or exhausted license fails clearly. `licensing.integration.test.ts` drives invalid
  and device-limit responses through the production service and proves entitlement remains false;
  `UpgradeScreen.license.test.tsx` verifies distinct actionable messages remain on the locked screen.
- #141 - Core and Pro override behavior. The licensing integration applies both development
  overrides through the production bootstrap seam and proves neither mutates the encrypted persisted
  entitlement; a core build remains incapable of force-loading Pro implementation code.
- #142 - Manual update check. `update-check.integration.dbtest.ts` drives the rendered Settings
  action through production updater IPC, real encrypted update preferences, and deterministic
  updater events, proving current `0.0.103`, available `0.0.104`, and offline error states all leave
  Checking, preserve the stable channel, and never call install without approval.
- #143 - Update channel persists. `src/main/__tests__/settings-persistence.dbtest.ts` changes the
  channel through the production update IPC handler, closes the encrypted database, reloads every
  Off Grid module, and verifies the fresh update-preferences handler restores the beta channel.
- #146 - Model ports are single-owner. `model-port-ownership.integration.test.ts` starts a real
  foreign parent with the only fake native llama process on production port 8439, then proves the
  production contender preserves that live owner, starts no second engine, reports its own Chat
  health as Down rather than borrowing the other process's readiness, and exposes the actionable
  `port_in_use` reason while the first engine remains responsive.
- #149 - Large seeded collections stay usable. Core Electron and Pro rendered integrations drive
  120 models, 120 persisted chats, 120 entities, 300 clipboard items, and 120 observations through
  their production owners, proving filters, scrolling, dense master-detail layouts, and bounded
  result surfaces remain usable at desktop scale.
- #150 - Window resize preserves desktop layout. `e2e/desktop-polish.spec.ts` resizes the real
  Electron viewport from 1280 to 1800 pixels and proves the production Models collection expands
  from three to four computed columns while its search/filter context remains reachable.
- #151 - Keyboard focus is visible. `e2e/desktop-polish.spec.ts` tabs through the real sidebar,
  Models form controls, model actions, primary Download action, and command-palette focus trap,
  proving logical order and the settled theme-aware two-pixel focus treatment at each surface.
- #154 - External links use the system browser. `e2e/tour.spec.ts` drives the real locked-Pro
  surface through Electron preload and IPC, proves purchase and Mobile links reach
  `shell.openExternal` with their production URLs, and verifies the Electron page never navigates.

## Previously claimed P2 evidence

- #44 - Rename conversation. `e2e/chat-actions.spec.ts` drives the real Electron UI through rename,
  production preload/IPC and SQLite, verifies the old title disappears, navigates to another
  conversation and back, then fully relaunches on the same profile and restores the new title.
- #50 - Keyboard and navigation shortcuts. `App.navigation.integration.test.tsx` drives the real
  shell through Project Beta to Integrations, then proves Cmd+[ and Cmd+] restore both routes and
  the selected project instead of losing screen state.
- #46 - Copy assistant reply. `e2e/chat-actions.spec.ts` clicks Copy on a rendered assistant reply,
  crosses production IPC, verifies visible success feedback, and reads the exact expected message
  from the real macOS clipboard.
- #55 - Edit project. `rag-ipc-project-create.dbtest.ts` changes every editable field through the
  production project IPC handlers and real SQLite store, reloads the modules, and proves the updated
  project is returned with its exact name, description, prompt, icon, and memory setting.
- #59 - Project list uses desktop layout. `e2e/projects-layout.spec.ts` seeds 12 projects and eight
  chats through production IPC, then measures the real Electron master-detail geometry, scroll
  reachability, adjacent detail controls, and a three-plus-column chat grid at desktop width.
- #31 - Models use desktop density. `e2e/desktop-polish.spec.ts` resizes the real Electron window
  from 1280 to 1800 pixels and proves the production model collection forms three then four computed
  columns while its controls remain reachable.
- #104 - Voice retention settings apply. `voice-journeys.dbtest.ts` persists a seven-day retention
  setting, completes a new import, and proves expired SQLite rows and media are deleted while the
  fresh recording and file remain.
- #152 - Escape closes transient UI. Rendered integrations prove Models detail and nested shared
  modals close only the top layer, preserve the underlying filter/workspace state, and restore
  focus; the Electron journey confirms Escape returns to the intact collection.
- #153 - Reduced motion remains usable. The Electron journey emulates macOS reduced motion, proves
  production transition duration collapses to a near-zero value, and still opens and closes the
  model detail layer normally.
- #124 - Clipboard retention applies. `clipboard-store.integration.test.ts` exercises the real
  retention-days and max-items policies against SQLite while preserving newer rows.

## Previously identified package/install gaps

- #1 - Final production artifact installs cleanly and remains locked when unentitled.
  - Local 0.0.40 ad-hoc app: installed-copy launch and forged-license harness passed.
  - Left: repeat against the Developer ID-signed and notarized release artifact.
- #2 - The same final production artifact activates Pro with a valid entitlement.
  - Local 0.0.40 Pro-capable app: packaged UI and locked-state gates passed; valid-license activation
    is part of the immediate manual pass.
  - Left: repeat the valid-license journey against the signed/notarized release artifact.

## Previous implementation order

- Run #1 and #2 as locked and entitled states against the one signed, notarized production DMG on
  the release Mac. The release
  workflow now blocks publication until Developer ID, pinned Team ID, hardened runtime, nested
  signatures, notarization staple, Gatekeeper, ZIP/DMG contents, update metadata, installed UI, and
  packaged license gates all pass.
- Complete the signed-device permission, global-hotkey, TextEdit paste, full-volume, and installer
  replacement confirmations recorded beside their integration-covered journeys.
- Record the final release-artifact hashes, signed-device evidence, updater upgrade results, and
  every manual P0/P1/P2 result in `MANUAL_RELEASE_TESTS_0.0.40.md`.
