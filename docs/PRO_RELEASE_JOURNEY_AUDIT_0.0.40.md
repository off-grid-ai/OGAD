# Pro release journey audit - 0.0.40

This audit covers every row in `RELEASE_TEST_CHECKLIST.csv` explicitly marked Pro-only,
Pro-artifact, or Pro-use, plus the manual checklist's Pro-labelled shared permission and audio
rows: #15, #16, #105, and #106. Shared `Both` journeys are outside this document so Core and Pro
audits do not count the same row twice.

The status follows the no-mockist rule in `P0_P2_INTEGRATION_COVERAGE.md`:

- `COMPLETE` means the decisive production collaborators run through the real application seam.
- `PARTIAL` means useful evidence exists, but a production, packaged, native, external, rendered,
  or relaunch seam is still missing.
- `OPEN` means no release-grade journey exists.
- A controlled fake is acceptable only at an OS, native model, or remote service boundary.
- A manual release-device check can still remain after automated status is `COMPLETE`.

## Status snapshot

- P0: 25 total, 1 complete, 23 partial, 1 open.
- P1: 27 total, 4 complete, 23 partial, 0 open.
- P2: 2 total, 0 complete, 2 partial, 0 open.
- P3: 0 journeys exist in the CSV.
- Overall: 54 total, 5 complete, 48 partial, 1 open.

## P0 journeys

- **#2 - Pro DMG installs cleanly - OPEN - Low confidence.**
  - Evidence: adjacent lock and entitlement seams in `scripts/smoke-license-gate.mjs`,
    `pro/main/__tests__/licensing.integration.test.ts`, and
    `pro/renderer/__tests__/UpgradeScreen.license.test.tsx`.
  - Gap: install, launch, lock, activate, restart, and reopen the exact Developer ID-signed,
    notarized, stapled production artifact with a real test entitlement.

- **#15 - Required macOS permissions granted - PARTIAL - Medium confidence.**
  - Evidence: `integration-tests/permission-recovery.test.ts`,
    `src/main/__tests__/media-permission.test.ts`,
    `pro/main/__tests__/capture-disabled.integration.test.ts`, and
    `pro/main/__tests__/dictation-paste-failure.ui.integration.dbtest.ts`.
  - Gap: real signed-app TCC grants for Screen Recording, Accessibility, Microphone, and
    Notifications, including truthful health and repeated-prompt checks.

- **#83 - Screen capture permission path - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/capture-disabled.integration.test.ts` keeps the production
    scheduler, settings, and filesystem writer real while controlling the TCC boundary.
  - Gap: grant Screen Recording to the installed app and prove frames begin without a restart.

- **#84 - Capture disabled means no capture - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/capture-disabled.integration.test.ts` and
    `pro/main/__tests__/capture-policy.integration.test.ts`.
  - Gap: several minutes of real foreground activity with capture disabled, checking Replay,
    Search, observations, entities, and to-dos stay unchanged.

- **#85 - OCR creates searchable memory - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/capture-exclusion.dbtest.ts` runs the real extractor, model
    transport, SQLite store, and search while controlling screenshot, OCR, and model boundaries.
  - Gap: real display capture and OCR of a unique phrase in another application through the
    installed Pro app.

- **#86 - Sensitive or excluded apps are omitted - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/capture-exclusion.dbtest.ts` and
    `pro/main/__tests__/capture-policy.integration.test.ts`.
  - Gap: real authentication, private-browser, password-manager, and configured-app surfaces under
    macOS capture.

- **#87 - Replay timeline renders - COMPLETE - High confidence.**
  - Evidence: `e2e/pro.spec.ts` drives production Pro seeding, real PNG and SQLite data,
    chronology, timestamps, scrubber state, and every frame.
  - Manual boundary: inspect pixels and local media behavior in the installed artifact.

- **#90 - Unified search finds each source - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/universal-search.dbtest.ts` queries production owners for
    capture, meeting, entity, fact, memory, chat, knowledge, and connector data.
  - Gap: one joined rendered and IPC journey over those same stored records.

- **#94 - Delete all removes capture corpus - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/personal-data.dbtest.ts` and
    `pro/main/__tests__/personal-data-tables.test.ts`.
  - Gap: invoke the rendered Delete all control, relaunch, and verify Replay, Search, Day,
    Entities, and files are empty.

- **#95 - Meeting detection is truthful - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/meeting-lifecycle.integration.test.ts` keeps the production
    classifier and controller real while controlling active-window and native-recorder boundaries.
  - Gap: real Zoom, Meet, or Teams presence, lobby and post-call discrimination, system audio,
    microphone capture, and OS resource release.

- **#96 - Manual meeting recording - PARTIAL - Medium confidence.**
  - Evidence: `pro/renderer/screens/__tests__/MeetingsScreen.integration.test.tsx` runs the
    production screen, hook, and controller with recorder and Electron bridge boundary adapters.
  - Gap: actual native recording, duration, media playback, and resource teardown.

- **#97 - Meeting transcript and summary - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/meeting-persistence.dbtest.ts` runs the real filesystem,
    ffmpeg and Whisper selection, LLM protocol, CRM folding, SQLite, and relaunch while controlling
    native executables and the model socket.
  - Gap: real recorded audio, real native STT and model output, and rendered decisions and to-dos.

- **#99 - Global dictation hotkey - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/dictation-paste-failure.ui.integration.dbtest.ts` and
    `pro/main/dictation/hotkey/__tests__/push-to-talk-parse.test.ts`.
  - Gap: actual Option+Space Hold, Toggle, and Both gestures from another app with Accessibility
    and Microphone grants.

- **#100 - Dictation pastes at cursor - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/dictation-paste-failure.ui.integration.dbtest.ts` and
    `pro/main/dictation/sinks/__tests__/paste-at-cursor.test.ts`.
  - Gap: exact TextEdit caret insertion, surrounding-text preservation, one paste, and clipboard
    restoration through macOS.

- **#106 - Mic and TTS stop cleanly - PARTIAL - Medium confidence.**
  - Evidence: `src/renderer/src/components/__tests__/MemoryChat.chat-lifecycle.test.tsx` and
    `src/renderer/src/components/__tests__/DictationOverlay.integration.test.tsx`.
  - Gap: actual mic indicator, audio output, helper processes, global shortcut, recorder, and
    quit-time teardown.

- **#112 - Approval queue gates actions - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/crm/__tests__/approvals.integration.test.ts` and
    `pro/main/__tests__/approval-relaunch.dbtest.ts`.
  - Gap: rendered provenance and arguments, rejection reason, and one disposable external write
    proving no pre-approval or duplicate execution.

- **#116 - CRM processing tolerates schema upgrades - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/crm-schema-upgrade.dbtest.ts` and
    `pro/main/__tests__/fixtures/v0.0.39-beta.66-profile.sql`.
  - Gap: upgrade a backed-up full prior installed profile through the packaged app and verify every
    Pro store continues processing.

- **#117 - Clipboard records text - PARTIAL - Medium confidence.**
  - Evidence: `e2e/pro.spec.ts` crosses Electron's real OS clipboard, production poller, encrypted
    store, and IPC.
  - Gap: the final installed entitled artifact and a foreground external application as the source.

- **#121 - Clipboard restore text - PARTIAL - Medium confidence.**
  - Evidence: `e2e/pro.spec.ts` overwrites then restores real OS clipboard text.
  - Gap: paste into another real app and confirm the exact content appears once.

- **#122 - Clipboard restore file - PARTIAL - Medium confidence.**
  - Evidence: `e2e/pro.spec.ts` verifies path text, native file URL, and image bytes.
  - Gap: paste the restored item into Finder and a text target on the release device.

- **#125 - Create and unlock vault - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/vault/__tests__/vault-service.test.ts` uses real KDBX4, Argon2id, WASM
    crypto, and filesystem storage.
  - Gap: rendered installed-app create, lock, wrong-password, and unlock journey.

- **#126 - Vault item types round-trip - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/vault/__tests__/vault-service.test.ts` covers encrypted CRUD and binary
    attachments across lock and unlock.
  - Gap: UI create, edit, reopen, and delete for every advertised type, including field and
    attachment presentation.

- **#128 - Vault recovery and backup - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/vault/__tests__/vault-service.test.ts` and
    `pro/main/vault/__tests__/vault-recovery.test.ts`.
  - Gap: rendered backup and recovery in the installed app, including file handling, wrong phrase,
    new password, and item preservation.

- **#138 - Pro license activates - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/licensing.integration.test.ts` and
    `pro/renderer/__tests__/UpgradeScreen.license.test.tsx`.
  - Gap: real license service, real key, encrypted OS cache, required restart, and real Pro service
    and screen activation in the signed artifact.

- **#140 - Offline entitlement behavior - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/licensing.integration.test.ts` covers valid, empty, forged,
    expired, and offline cache decisions at the service and IPC seams.
  - Gap: actual safeStorage and keychain behavior plus offline relaunch of installed Pro after
    online activation, repeated with fresh, forged, and expired profiles.

## P1 journeys

- **#16 - Denied permission is recoverable - PARTIAL - Medium confidence.**
  - Evidence: `integration-tests/permission-recovery.test.ts`,
    `pro/main/__tests__/dictation-paste-failure.ui.integration.dbtest.ts`, and
    `src/renderer/src/components/__tests__/DictationOverlay.integration.test.tsx`.
  - Gap: deny and recover each real macOS permission through System Settings.

- **#19 - Speech model downloads - PARTIAL - Medium confidence.**
  - Evidence: `src/main/models/__tests__/model-download-matrix.integration.test.ts` and
    `pro/main/__tests__/voice-journeys.dbtest.ts`.
  - Gap: real download bytes, installed native Whisper or Parakeet execution, selection UI,
    dictation, and relaunch joined in one package journey.

- **#20 - TTS model downloads - PARTIAL - Medium confidence.**
  - Evidence: `src/main/__tests__/model-download-tts.integration.dbtest.ts`,
    `src/main/__tests__/probe-packaged-tts.integration.test.ts`,
    `scripts/probe-packaged-tts.mjs`, and `e2e/tts-speak.spec.ts`.
  - Gap: one joined download, activation, rendered Speak, exact packaged worker, and audible-output
    journey.

- **#88 - Replay playback uses media server - PARTIAL - Medium confidence.**
  - Evidence: `src/main/__tests__/media-server.integration.test.ts`,
    `pro/main/crm/__tests__/replay.integration.test.ts`, and adjacent `e2e/pro.spec.ts` evidence.
  - Gap: installed Replay scrub and play across real captured moments with the port 7879 media
    lifecycle.

- **#89 - Replay navigation preserves target - COMPLETE - High confidence.**
  - Evidence: `e2e/pro.spec.ts` derives a real interior capture search result and verifies its exact
    image, app, timestamp, caption, and timeline position.

- **#91 - Search filters and sort apply - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/universal-search.dbtest.ts` and
    `pro/renderer/screens/__tests__/SearchScreen.integration.test.tsx`.
  - Gap: one joined production IPC and rendered journey with live data and stale-request races.

- **#92 - Day briefing renders - PARTIAL - Medium confidence.**
  - Evidence: `pro/renderer/screens/__tests__/DayReplay.integration.test.tsx` and
    `pro/main/crm/__tests__/day.integration.test.ts`.
  - Gap: installed-app visual and date-range checks against real synthetic capture and meeting data.

- **#93 - Day links open correct records - PARTIAL - Medium confidence.**
  - Evidence: `pro/renderer/screens/__tests__/DayReplay.integration.test.tsx`,
    `pro/renderer/screens/__tests__/ActionsTarget.integration.test.tsx`, and
    `pro/renderer/screens/__tests__/MeetingsScreen.integration.test.tsx`.
  - Gap: actual router, preload, and IPC navigation from Day into each target in one Electron
    journey.

- **#98 - Meeting survives relaunch - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/meeting-persistence.dbtest.ts` closes and reopens the database and
    restores media metadata, transcript, and summary.
  - Gap: full Electron quit and reopen plus rendered access to native-captured media.

- **#101 - Dictation paste failure is visible - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/dictation-paste-failure.ui.integration.dbtest.ts` and
    `src/renderer/src/components/__tests__/DictationOverlay.integration.test.tsx`.
  - Gap: real Accessibility denial, clipboard preservation, retry, and overlay cleanup.

- **#102 - Dictation engine selection - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/voice-journeys.dbtest.ts` and
    `pro/renderer/screens/__tests__/VoiceScreen.integration.test.tsx`.
  - Gap: actual installed Whisper and Parakeet helpers, UI-reported engine, and real audio.

- **#103 - Import media for transcription - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/voice-journeys.dbtest.ts` and
    `pro/renderer/screens/__tests__/VoiceScreen.integration.test.tsx`.
  - Gap: native file picker or drop, real supported media, installed executables, and searchable
    transcript.

- **#105 - Speak assistant reply - PARTIAL - Medium confidence.**
  - Evidence: `e2e/tts-speak.spec.ts`,
    `src/main/__tests__/probe-packaged-tts.integration.test.ts`, and
    `scripts/probe-packaged-tts.mjs`.
  - Gap: the UI journey replaces ONNX while the exact package probe does not click Speak. A joined
    rendered and packaged audible journey remains.

- **#107 - Entities are synthesized - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/entity-action-journeys.dbtest.ts` runs production observation,
    resolution, alias, and record owners over real SQLite.
  - Gap: one entity synthesized and extended across capture, meeting, chat, and connector sources,
    including related entities and a cross-source summary.

- **#108 - Self mentions are filtered - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/entity-action-journeys.dbtest.ts`,
    `pro/main/__tests__/identity.test.ts`, and `pro/main/crm/__tests__/noise.test.ts`.
  - Gap: real multi-source ingestion using the user's persisted identity and aliases.

- **#109 - Entity detail opens - PARTIAL - Low confidence.**
  - Evidence: `pro/renderer/screens/__tests__/EntityNavigation.integration.test.tsx` runs real
    screens, but its search and entity API data are synthetic.
  - Gap: real SQLite, IPC, Search, Day, chat, to-do, and list entry points into the same record.

- **#110 - Entity merge preserves evidence - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/crm/__tests__/resolve.integration.test.ts` covers merge, repointing,
    corrections, and rollback over real SQLite.
  - Gap: rendered merge and correction flow, relaunch, and every linked record surface.

- **#111 - Action items are extracted - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/entity-action-journeys.dbtest.ts` and
    `pro/main/crm/__tests__/actions.integration.test.ts`.
  - Gap: real capture or meeting source, rendered Actions result, duplicate suppression, and
    contextual entity, due-date, and priority verification.

- **#113 - Action status survives relaunch - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/approval-relaunch.dbtest.ts` and
    `pro/main/crm/__tests__/actions-status.integration.test.ts`.
  - Gap: rendered Open, Waiting, Done, and Dismissed tabs, Undo, counts, filters, and full Electron
    relaunch.

- **#114 - Notifications open their target - PARTIAL - Medium confidence.**
  - Evidence: `pro/shared/__tests__/notification-target.test.ts`,
    `pro/renderer/screens/__tests__/ActionsTarget.integration.test.tsx`, and
    `src/renderer/src/__tests__/App.navigation.integration.test.tsx`.
  - Gap: real native Notification click and focus for meeting prep, approval, and to-do, including
    real permission state.

- **#115 - Reflect uses real time ranges - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/crm/__tests__/reflect.integration.test.ts` covers production observation
    windows, dwell caps, rollups, context switches, and seven-day aggregation.
  - Gap: rendered daily and weekly range selection reconciled visually with Day and source records.

- **#118 - Clipboard deduplicates repeated copy - COMPLETE - High confidence.**
  - Evidence: `pro/main/__tests__/clipboard-store.integration.test.ts` exercises real SQLite
    deduplication, timestamp bump, ordering, and tag preservation.

- **#119 - Clipboard records images and files - COMPLETE - High confidence.**
  - Evidence: `e2e/pro.spec.ts` crosses Electron's real OS clipboard for native file URLs and pixel
    images, restores bitmap bytes, and checks exact dimensions.

- **#120 - Clipboard live refresh keeps valid selection - PARTIAL - Low confidence.**
  - Evidence: `pro/renderer/screens/__tests__/ClipboardScreen.integration.test.tsx` runs the real
    screen, but the clipboard bridge and item source are synthetic.
  - Gap: real production poller, store, and IPC events arriving during user selection.

- **#123 - Clipboard popup hotkey - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/clipboard-popup-journey.dbtest.ts` and
    `pro/renderer/screens/__tests__/ClipboardPopup.integration.test.tsx`.
  - Gap: actual Cmd+Shift+C global shortcut from another app, real focus, keyboard restore, and
    visible failure and retry.

- **#127 - Vault copy actions - COMPLETE - High confidence.**
  - Evidence: `e2e/pro.spec.ts` creates a real encrypted KDBX item through production IPC and
    verifies username, revealed password, and URL on the real OS clipboard.

- **#139 - Invalid or exhausted license fails clearly - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/licensing.integration.test.ts` and
    `pro/renderer/__tests__/UpgradeScreen.license.test.tsx`.
  - Gap: real invalid and device-limit responses in the final packaged app.

## P2 journeys

- **#104 - Voice retention settings apply - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/voice-journeys.dbtest.ts` and
    `pro/renderer/screens/__tests__/VoiceScreen.integration.test.tsx`.
  - Gap: joined rendered setting, production IPC and store, relaunch, and cleanup over installed-app
    media.

- **#124 - Clipboard retention applies - PARTIAL - Medium confidence.**
  - Evidence: `pro/main/__tests__/clipboard-store.integration.test.ts` exercises the real age and
    item-count policies over SQLite.
  - Gap: rendered retention setting through production IPC against real history and relaunch.

## P3 status

- No P3 journey exists in `RELEASE_TEST_CHECKLIST.csv`.
- This is a coverage-model gap, not proof that the product has no P3 behavior.

## Missing or under-specified Pro journeys

- **P0 - Entitlement activation isolation.** The manual checklist requires proof that capture,
  clipboard polling, meeting detection, tray service, and the dictation shortcut do not start before
  entitlement. CSV #2 says only that the package remains locked, while #4 covers artifact
  separation. Add a distinct service-activation and privacy journey. Existing seam evidence:
  `pro/main/__tests__/service-activation.integration.dbtest.ts`.

- **P1 - Manual to-do creation and enrichment.** The manual checklist includes `Jot a to-do`,
  immediate persistence, local enrichment, spinner termination, entity and date inference, and
  relaunch. Evidence exists in `pro/main/crm/__tests__/actions.integration.test.ts` and
  `pro/main/crm/__tests__/manual-todo.test.ts`, but no CSV row owns this journey.

- **P1 - Contextual to-do lifecycle.** CSV #113 covers persistence, but not the full Open, Waiting,
  Done, and Dismissed tabs, Undo, entity filtering, stale-target behavior, and source evidence.

- **P1 - Entity identification, extension, and correction guardrails.** CSV #107 through #110 do
  not define one complete journey for rename, retype, photo, hide and unhide, observation
  reassignment or split, alias removal, rollback, and cross-source extension. Strong DB seam evidence
  exists in `pro/main/crm/__tests__/resolve.integration.test.ts`, but the rendered journey is absent.

- **P1 - Capture layout capability routing.** CSV #69 describes chat attachments, not background
  capture layout learning. Pro commit `3b67b2b` and Core commit `35a212b` prove only the real
  active-model and projector seam. They do not complete a capture journey.

- **P0 - Clean shutdown.** The manual checklist requires no lingering capture, model, audio,
  meeting, shortcut, clipboard, or media-server processes after a normal quit. CSV #145 proves cold
  relaunch after a forced quit, which is a different behavior.

- **P1 - Native notification admission and first-click routing.** The behavior is split across
  #15, #16, and #114 instead of one explicit Pro journey.

- **P3 - Lower-frequency Pro behavior.** The requested P0 through P3 model has no P3 rows.

## Documentation inconsistencies

- `P0_P2_INTEGRATION_COVERAGE.md` names nonexistent
  `pro/main/__tests__/personal-data.integration.test.ts` for #94. The actual test is
  `pro/main/__tests__/personal-data.dbtest.ts`.
- CSV #2 and #138 say `Pro artifact only`, while `MANUAL_RELEASE_TESTS_0.0.40.md` says production is
  one Pro-capable artifact that starts locked and local Core and Pro DMGs are diagnostic variants.
  The release vocabulary should be reconciled.
- The manual guide's `Automation-backed` label is an aggregate label. It must not be read as
  `COMPLETE`; the strict ledger keeps 48 of these 54 Pro journeys partial.
