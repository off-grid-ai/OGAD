# Off Grid AI Desktop 0.0.40 manual release tests

Use this checklist first on the canonical local Apple-silicon package installed at
`~/Applications/Off Grid AI Desktop.app`, then repeat the trust and release-device checks on the
single final Developer ID-signed and notarized artifact. The production artifact is Pro-capable
but stays locked until entitlement; the local builder's separate Core and Pro DMGs are diagnostic
variants, not two release artifacts. This checklist turns
the release journeys in [`RELEASE_TEST_CHECKLIST.csv`](RELEASE_TEST_CHECKLIST.csv) and the current
coverage status in [`P0_P2_INTEGRATION_COVERAGE.md`](P0_P2_INTEGRATION_COVERAGE.md) into a practical
device pass.

For a shareable execution sheet, import
[`RELEASE_READINESS_CHECKLIST_0.0.40.csv`](RELEASE_READINESS_CHECKLIST_0.0.40.csv) into Google
Sheets. It contains 210 Core and Pro journeys: the canonical 155 product journeys plus 55
manually-audited native, security, release, and omitted-surface cases. Every row includes exact
steps and expected results, strict automation status and evidence, remaining manual boundaries,
calibrated regression confidence, and blank tester/result/evidence/defect columns for the release
team.

Automation-backed items still need manual execution when the remaining risk is macOS permissions,
Gatekeeper, installation, a global hotkey, another application, real audio, real display capture,
or visual quality. Do not replace a failed manual check with a green unit or integration test.

## Run record

- Tester:
- Date and time:
- Mac model and RAM:
- macOS version:
- Architecture: Apple silicon
- Display setup and scaling:
- Local app path and `app.asar` SHA-256:
- Final macOS DMG filename and SHA-256:
- Final Windows installer filename and SHA-256:
- Previous Core version used for upgrade:
- Previous Pro version used for upgrade:
- Locked-state result: Pass / Fail / Blocked
- Entitled-state result: Pass / Fail / Blocked
- Windows result: Pass / Fail / Blocked / Not shipping
- Upgrade result: Pass / Fail / Blocked
- Issue links:
- Evidence folder:

## Labels

- **P0** - Release blocker. Stop the pass, preserve evidence, and fix or explicitly block release.
- **P1** - Important release behavior. A failure needs triage and a documented release decision.
- **P2** - Polish or lower-frequency behavior. Record a defect and assess user impact.
- **Core** - Run with the production-capable app unentitled, or against the local Core diagnostic
  variant when explicitly stated.
- **Pro** - Run the same production-capable app with a valid entitlement, or against the local Pro
  diagnostic variant when explicitly stated.
- **Both** - Run in both locked and entitled states unless the step explicitly says once is enough.
- **Manual-only** - The important boundary cannot be faithfully automated in the normal test
  environment.
- **Automation-backed** - Repository integration or E2E coverage exists. The manual pass checks the
  installed artifact, operating system boundary, or pixels.

## Stop conditions

Stop and mark the build failed if any of these occurs:

- A P0 expected outcome is not met.
- The app crashes, opens a white or empty window, or cannot reopen after a normal quit.
- The packaged app activates a Pro implementation before entitlement or becomes entitled through
  `OFFGRID_PRO=1`.
- A write connector runs before approval, or Stop still permits an external side effect.
- Capture continues after it is disabled or records an excluded sensitive surface.
- A delete operation removes data outside the selected scope.
- A final release artifact is not Developer ID-signed, notarized, stapled, and accepted by
  Gatekeeper.
- The installed bundle contains private data, a top-level `pro/` source tree, an agent worktree,
  `.offgrid`, `.demo-profile`, `.claude`, `.Codex`, `coverage`, or test packaging output such as
  `out/packaged-helpers-*`.

## Prerequisites and safety

- [ ] **[P0][Both][Manual-only] Distinguish local testing from release approval.**
  - Use the local ad-hoc package for the immediate product pass. Use the exact signed macOS DMG and
    Windows installer intended for publication for final trust and release approval.
  - Expected: each filename and SHA-256 matches its handoff; no local ad-hoc result is recorded as
    Developer ID, notarization, Gatekeeper, or Windows evidence.

- [ ] **[P0][Both][Manual-only] Protect existing data.**
  - Fully quit Off Grid AI Desktop.
  - Back up `~/Library/Application Support/Off Grid AI Desktop` before any upgrade test.
  - Use a separate macOS test account or a disposable synthetic profile for destructive checks.
  - Expected: no real chats, captures, credentials, meetings, clipboard data, or vault data are used
    in screenshots, recordings, logs, or deletion tests.

- [ ] **[P0][Both][Manual-only] Prepare the release Mac.**
  - Have administrator access, at least 20 GB of free space, working audio input and output, and a
    display that can grant Screen Recording permission.
  - Quit other Off Grid AI Desktop instances and verify ports `7878`, `7879`, and `8439` are free.
  - Expected: no competing app or local model process can affect the pass.

- [ ] **[P1][Both][Manual-only] Prepare reversible fixtures.**
  - A small supported text model, vision model, image model, STT model, and TTS model.
  - A Markdown or text document containing a unique synthetic phrase.
  - A synthetic PNG, a damaged image, a short synthetic WAV or video, and a disposable file.
  - A disposable read/write connector target and a Pro test license with known device availability.
  - A previous 0.0.38 installation for the upgrade pass.
  - Expected: every test can be repeated without exposing or changing real user data.

## 1. Artifact, signature, installation, and gating

- [ ] **[P0][Both][Automation-backed + manual device] Inspect the final macOS DMG before installation.**
  - Mount the DMG read-only and confirm there is exactly one top-level `.app` plus the Applications
    shortcut.
  - Run strict deep code-sign verification, notarization staple validation, and Gatekeeper
    assessment against the mounted app.
  - Run `/usr/bin/codesign --verify --deep --strict --verbose=4 <app>`,
    `/usr/bin/xcrun stapler validate <app>`, and
    `/usr/sbin/spctl --assess --type execute --verbose=4 <app>`.
  - Confirm version `0.0.40`, bundle identifier `co.getoffgridai.desktop.pro`, hardened runtime,
    Off Grid Apple Team ID `84V6KCAC49`, and both ASAR fuses:
    `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`.
  - Confirm the only ASAR roots are `/node_modules`, `/out`, and `/package.json`; the only `/out`
    children are `main`, `preload`, and `renderer`; and there is no nested `.app` or case-normalized
    private/test segment such as `.offgrid`, `.demo-profile`, `.claude`, `.Codex`, `coverage`, or
    `out/packaged-helpers-*`.
  - Expected: the final artifact is Developer ID-signed, notarized, stapled, Gatekeeper-accepted,
    contains no forbidden paths, and has no nested packaged application.

- [ ] **[P0][Both][Automation-backed + manual device] Install from the detached DMG.**
  - Drag the app to `/Applications`, eject the DMG, and open the copy in `/Applications`.
  - Expected: the app opens without a crash, white screen, damaged-app warning, or dependency
    dialog. Nothing is loaded from the detached image.

- [ ] **[P0][Both][Automation-backed + manual device] Verify packaged helpers and System Health.**
  - Open Settings > Setup & health after install.
  - Start each installed runtime once.
  - Expected: the app finds `llama-server`, ffmpeg, Whisper or Parakeet, TTS, image helpers, and all
    required dylibs. System Health reports a specific actionable reason for any unavailable runtime,
    never only a generic Down state when stderr has a cause.

- [ ] **[P0][Core][Automation-backed + manual device] Prove the installed app stays locked.**
  - Start with a fresh profile and no license.
  - Run `node scripts/smoke-license-gate.mjs "/Applications/Off Grid AI Desktop.app/Contents/MacOS/Off Grid AI Desktop"` against the final app. For the local handoff, use the executable named
    `Off Grid AI Desktop Local` under the app's `Contents/MacOS` directory.
  - Open every locked route: Day, Reflect, Replay, Meetings, Actions, Entities, Search,
    Notifications, Voice, Vault, and Clipboard.
  - Expected: the runner reports `window.api.isPro === false`; every route shows its matching Upgrade
    screen; no real Pro screen, capture loop, tray service, global shortcut, or Pro settings section
    activates.

- [ ] **[P0][Pro][Automation-backed + manual device] Verify the unentitled package starts locked.**
  - Open the production-capable package on a fresh profile without an override or cached license.
  - Expected: the app opens normally, Core surfaces work, Pro routes remain locked, and no capture,
    clipboard watcher, meeting detector, or dictation shortcut starts before entitlement.

- [ ] **[P1][Both][Manual-only] Verify product identity.**
  - Inspect Finder, Dock, menu bar, window title, About, permission prompts, and Settings footer.
  - Expected: every visible product name is **Off Grid AI Desktop** with no legacy name.

- [ ] **[P0][Both][Manual-only] Verify the Windows package if Windows 0.0.40 will ship.**
  - On a clean supported Windows machine, verify installer signature, install/uninstall, first
    launch, packaged license lock, valid entitlement, helper startup, update, and 0.0.38 upgrade.
  - Expected: no SmartScreen or missing-runtime failure; the forged license/override stays locked;
    both locked and entitled journeys work; update and uninstall leave the documented user data.

## 2. Clean profile and onboarding

- [ ] **[P0][Both][Automation-backed + manual device] Confirm the profile is truly fresh.**
  - Launch with a new disposable profile.
  - Expected: onboarding appears with no chats, projects, models, captures, entities, credentials,
    clipboard history, meetings, or settings from another profile.

- [ ] **[P0][Both][Automation-backed + manual device] Complete Configure for me.**
  - Follow onboarding and choose the automatic setup path.
  - Expected: progress remains understandable, recommended downloads complete, active choices are
    populated, and the app lands on Models without a blank or stuck step.

- [ ] **[P1][Both][Automation-backed] Complete manual setup.**
  - On another fresh profile, choose models manually and complete onboarding.
  - Expected: only selected models download and the resulting shell is usable.

- [ ] **[P1][Both][Automation-backed] Resume interrupted onboarding.**
  - Quit midway through a model download or setup step and reopen.
  - Expected: completed steps remain complete; the partial download resumes or shows Retry; no
    duplicate download begins.

- [ ] **[P0][Pro][Manual-only] Exercise macOS permission recovery.**
  - Deny Screen Recording, Accessibility, Microphone, and Notifications one at a time.
  - Use the affected feature, follow the Settings route, grant permission, and return.
  - Expected: denial is specific and recoverable; unrelated features remain usable; granting does
    not create repeated prompt loops. Relaunch only when macOS requires it.

## 3. Models, downloads, and runtime ownership

- [ ] **[P0][Both][Automation-backed + manual device] Download and activate a text model.**
  - Download a small supported model, watch progress, activate it, quit fully, and reopen.
  - Expected: no false Ready state appears; the same model remains active and answers a new prompt.

- [ ] **[P1][Both][Automation-backed + manual device] Download each installed modality.**
  - Download and activate one vision model with projector, image model, STT model, and TTS model.
  - Expected: every required file or extraction step completes before Ready; each modality restores
    its own selection after relaunch and never overwrites another modality.

- [ ] **[P1][Both][Automation-backed] Exercise the queue and delete isolation.**
  - Start more downloads than the visible concurrency limit, then delete a different installed
    model while one download runs.
  - Expected: running and queued counts remain truthful; the queue drains; deleting one model does
    not cancel another download.

- [ ] **[P0][Both][Automation-backed + manual device] Recover an interrupted download.**
  - Quit during a download and reopen.
  - Expected: the partial resumes from the correct point or becomes explicitly retryable. It is
    never promoted to installed before integrity checks pass.

- [ ] **[P0][Both][Automation-backed + manual-only boundary] Contain download failures.**
  - Test offline download, truncated GGUF, and a safe disposable low-space or unwritable target.
  - Expected: each failure is specific; no phantom installed model or dangling active pointer is
    created; the app stays open and existing models remain readable.

- [ ] **[P1][Both][Automation-backed] Delete an active model.**
  - Activate then delete one model for each available modality.
  - Expected: the active selection clears or moves to a valid replacement; no missing-file loop or
    cross-modality selection remains.

- [ ] **[P0][Both][Automation-backed] Verify model ports have one owner.**
  - With one installed app running, attempt a second launch.
  - Expected: the existing app is focused or the conflict is explained; there is no second model
    server, `EADDRINUSE` cascade, or false model-corruption message.

## 4. Chat, conversations, image, vision, and speech

- [ ] **[P0][Both][Automation-backed + manual device] Send the first local message.**
  - Create a chat and send a distinctive prompt.
  - Expected: tokens stream into exactly one assistant bubble; the final answer persists after
    switching screens and after relaunch.

- [ ] **[P0][Both][Automation-backed] Verify memory scopes.**
  - Send one prompt with No memory.
  - Add synthetic memory, then send a related prompt with All memory.
  - Expected: No memory uses conversation context only; All memory uses the matching stored context
    and shows the expected citation or source. A truly empty memory store gives a clear empty state,
    not a generic crash bubble.

- [ ] **[P1][Both][Automation-backed] Verify thinking presentation.**
  - Send a reasoning prompt with Thinking enabled, then a plain prompt with it disabled.
  - Expected: reasoning and final answer are visually separate when enabled; no literal think tags
    or parser markers appear when disabled.

- [ ] **[P0][Both][Automation-backed] Stop safely.**
  - Stop once before the first token and once during streaming.
  - Expected: pre-token work aborts before tools or side effects; a partial streamed answer remains;
    the busy state clears; the next prompt succeeds.

- [ ] **[P0][Both][Automation-backed] Verify conversation and project isolation.**
  - Start a response in conversation A and switch to B.
  - Start a project-scoped response and change the selected project while it runs.
  - Expected: progress, results, artifacts, and persistence remain with the conversation and project
    captured at send time.

- [ ] **[P1][Both][Automation-backed] Exercise conversation actions.**
  - Rename, copy a reply, regenerate, and delete a chat containing messages and an artifact.
  - Expected: rename persists; copied text is exact; regenerate does not duplicate the user turn;
    delete removes chat-owned records and sidebar state.

- [ ] **[P0][Both][Automation-backed] Recover from a chat engine failure.**
  - Trigger a safe model or gateway failure during a turn, restore health, and send again.
  - Expected: the error names the real cause; spinner and Stop clear; the next turn succeeds without
    restarting the whole profile.

- [ ] **[P0][Both][Automation-backed + manual device] Generate and cancel an image.**
  - Generate an image, switch conversations during progress, return, and stop a second generation.
  - Expected: only the owner conversation shows progress; exactly one result is saved for the first
    generation; cancellation affects only the second and preserves any preceding text after relaunch.

- [ ] **[P1][Both][Automation-backed + manual visual] Verify image controls and memory handoff.**
  - Change size, steps, guidance, and seed; open the result in the existing lightbox; then send a
    normal chat prompt.
  - Expected: output metadata and dimensions match settings; lightbox close/save work; chat reloads
    after the image runtime is evicted. An over-budget model is refused clearly instead of causing
    system-wide memory pressure.

- [ ] **[P0][Both][Automation-backed] Verify vision input.**
  - Ask a vision model about the synthetic image, then repeat with a text-only model and with a
    damaged image.
  - Expected: the vision answer refers to the actual attachment and prompt; unsupported input is
    blocked with a specific explanation; the conversation remains usable.

- [ ] **[P1][Both][Automation-backed + manual audio] Speak an assistant reply.**
  - Use Speak on an answer containing Markdown, then Stop or navigate away.
  - Expected: local TTS reads clean text without Markdown syntax and all audio stops promptly.

## 5. Projects, knowledge, and artifacts

- [ ] **[P0][Both][Automation-backed] Create and restore a project.**
  - Create a named project, navigate away, quit, and reopen.
  - Expected: the project appears once with the same metadata.

- [ ] **[P0][Both][Automation-backed] Attach and retrieve knowledge.**
  - Add the synthetic document, wait for indexing, and ask a project chat about its unique phrase.
  - Expected: the document appears once; the answer uses its content; an unrelated project and a
    disabled document do not leak into retrieval.

- [ ] **[P1][Both][Automation-backed] Verify project inheritance and editing.**
  - Create a chat from inside the project, edit project metadata, and reopen both.
  - Expected: the chat retains project and knowledge scope; updated values appear in every project
    surface.

- [ ] **[P1][Both][Automation-backed] Reopen text and image artifacts.**
  - Save one text artifact and one image artifact from chat, reopen them, and relaunch.
  - Expected: exact content renders and remains associated with its source conversation and project.

- [ ] **[P0][Both][Automation-backed] Verify project deletion scope.**
  - Delete a synthetic project containing chats, documents, chunks, and artifacts.
  - Expected: project-owned records disappear without orphaned cards, badges, files, or artifacts;
    unrelated projects remain.

- [ ] **[P1][Both][Automation-backed] Reject an unsupported document.**
  - Attach a damaged or unsupported file.
  - Expected: a specific error appears and no half-indexed document remains.

## 6. Integrations, tools, approvals, and gateway

- [ ] **[P0][Both][Automation-backed + manual remote boundary] Add a connector.**
  - Add a disposable connector and complete discovery.
  - Expected: one connector appears as Connected only after real tools load; enabled states survive
    relaunch.

- [ ] **[P0][Both][Automation-backed + manual remote boundary] Run a read-only tool.**
  - Ask chat to use a reversible read-only tool.
  - Expected: the real result appears and the final answer uses it.

- [ ] **[P0][Both][Automation-backed + manual remote boundary] Gate every write.**
  - Ask for a disposable write action, reject it once, then repeat and approve once.
  - Expected: no external write occurs before approval; Reject does nothing; Approve executes once
    and records status.

- [ ] **[P0][Both][Automation-backed + manual remote boundary] Stop before side effect.**
  - Start a turn likely to propose a write and click Stop before approval or execution.
  - Expected: the external target proves that no write occurred.

- [ ] **[P0][Both][Automation-backed] Recover expired and dead connectors.**
  - Revoke one token and configure one unreachable endpoint alongside a healthy connector.
  - Expected: revoked state becomes Error or Reconnect with detail; the dead endpoint times out;
    healthy tools remain usable. Delete the failed connector and confirm its credential no longer
    works after relaunch.

- [ ] **[P0][Both][Automation-backed + manual HTTP] Verify the local gateway.**
  - Call `GET http://127.0.0.1:7878/v1/models` and a streaming chat completion.
  - Expected: the model list is OpenAI-compatible; SSE tokens arrive before completion and end with
    `[DONE]`.

- [ ] **[P1][Both][Automation-backed + manual HTTP] Verify gateway error and image routes.**
  - Send invalid input, send a request without a suitable model, and send one valid image request.
  - Expected: failures use a stable non-HTML error envelope; the app stays healthy; the valid image
    request returns a usable result.

## 7. Pro capture, Replay, Search, Day, and Reflect

- [ ] **[P0][Pro][Automation-backed + manual device] Start capture after permission grant.**
  - Enable capture, grant Screen Recording permission, use a normal synthetic work surface, and wait
    for processing.
  - Expected: frames and observations begin without a restart loop; capture health is truthful.

- [ ] **[P0][Pro][Automation-backed + manual privacy] Prove capture-off is absolute.**
  - Turn capture off, work in another app for several minutes, and inspect Replay, Search, and data
    counts.
  - Expected: no new frame, observation, OCR result, entity, or contextual to-do is created until the
    user resumes capture.

- [ ] **[P0][Pro][Automation-backed + manual privacy] Exclude sensitive surfaces.**
  - With capture on, visit a configured excluded app, an authentication screen, a private browser
    window, and a password-manager page using synthetic content.
  - Expected: none appears in frames, OCR, Replay, Search, entities, or derived memory. A normal app
    before and after still captures.

- [ ] **[P0][Pro][Automation-backed + manual device] Verify OCR to search.**
  - Display a unique synthetic phrase in another app and allow processing.
  - Expected: Search finds the corresponding capture or derived observation and opens the correct
    record.

- [ ] **[P0][Pro][Automation-backed + manual visual] Verify Replay chronology.**
  - Open Replay, traverse every test frame, scrub, and follow a result from Search or Day.
  - Expected: images, app labels, captions, timestamps, frame count, and order agree; deep links open
    the selected moment rather than a timeline boundary; media requests remain local.

- [ ] **[P0][Pro][Automation-backed] Verify unified Search.**
  - Search a unique value represented in capture, meeting, entity, fact, memory, chat, knowledge,
    and connector fixtures; change source filters and Relevant, Recent, and Match sorting.
  - Expected: every enabled source appears with the correct facet and deep link; disabled sources
    disappear; ordering updates without stale rows.

- [ ] **[P1][Pro][Automation-backed + manual visual] Verify Day and Reflect.**
  - Open Day and daily/weekly Reflect on synthetic data.
  - Expected: briefing, priorities, meetings, suggestions, journal, timeline, time totals, labels,
    and source breakdowns match the selected date range. Links open the intended meeting, entity,
    action, and Replay moment.

## 8. Pro entities and contextual to-dos

- [ ] **[P1][Pro][Automation-backed] Synthesize entities from real product paths.**
  - Process synthetic capture, meeting, chat, and connector records about one person, company, and
    project.
  - Expected: each entity appears once with the correct type, aliases, supporting observations,
    related entities, and cross-source summary. Self references do not create a duplicate person for
    the user.

- [ ] **[P1][Pro][Automation-backed + manual visual] Verify entity entry points and corrections.**
  - Open the same entity from Search, Day, chat context, a to-do chip, and the Entities list.
  - Rename, retype, add or remove a photo, hide/unhide, reassign one observation, and merge a
    duplicate synthetic entity.
  - Expected: every entry point reaches the same record; corrections persist; merge retains aliases,
    evidence, facts, relationships, and linked to-dos under one survivor.

- [ ] **[P1][Pro][Automation-backed] Extract a contextual to-do.**
  - Create a synthetic observation or meeting containing a clear commitment, owner, and due date.
  - Expected: exactly one imperative to-do appears in Actions > To do with source evidence, correct
    entity, due date, and priority. Re-viewing the same content does not duplicate it.

- [ ] **[P1][Pro][Automation-backed] Add and enrich a manual to-do.**
  - Use the `Jot a to-do` field with a line that implies a person and date.
  - Expected: the item appears immediately; local enrichment finishes without an endless spinner;
    inferred priority, due date, and entity are reasonable; relaunch preserves the result.

- [ ] **[P1][Pro][Automation-backed + manual visual] Verify to-do lifecycle and context.**
  - Exercise Open, Waiting, Done, and Dismissed tabs.
  - Complete an open item, use Undo, dismiss another, and open its entity chip.
  - Expected: counts and tabs update; Undo restores the item; statuses survive relaunch; entity
    filtering shows only that entity's to-dos; stale links fail closed instead of selecting another
    record.

- [ ] **[P0][Pro][Automation-backed + manual remote boundary] Verify approval lifecycle.**
  - Use Suggest actions, inspect arguments and provenance, reject one proposal with a reason, and
    approve one disposable proposal.
  - Expected: Pending and History are truthful; rejected actions never execute; approved actions
    execute once; result and status persist; concurrent or repeated clicks cannot duplicate the
    external action.

- [ ] **[P1][Pro][Automation-backed + manual device] Verify proactive navigation.**
  - Trigger synthetic meeting-prep, approval, and to-do notifications and click each.
  - Expected: exactly one notification per event; the primary window focuses; the intended record
    opens; a deleted target shows a missing state instead of an unrelated selection.

## 9. Pro meetings and voice dictation

- [ ] **[P0][Pro][Automation-backed + manual device] Verify meeting detection.**
  - Join and leave a supported synthetic Zoom, Meet, or Teams call with auto-detect enabled.
  - Expected: a real call starts or prompts according to settings; lobby and post-call states do not
    record; leaving warns and stops; system audio and microphone resources are released.

- [ ] **[P0][Pro][Automation-backed + manual audio] Record a meeting manually.**
  - Start and stop a short synthetic meeting from Meetings.
  - Expected: one recording with a sane duration appears; processing yields a searchable transcript,
    summary, decisions, and contextual to-dos; all remain after relaunch.

- [ ] **[P0][Pro][Automation-backed + manual native boundary] Verify Option+Space modes.**
  - Set Hold, Toggle, and Both in turn. Use Option+Space in TextEdit and another app.
  - Expected: each gesture creates exactly one recording lifecycle according to the selected mode;
    the overlay appears and closes; the transcript is saved.

- [ ] **[P0][Pro][Automation-backed + manual native boundary] Paste dictation at the cursor.**
  - Place the caret between two distinctive strings in TextEdit and dictate a short phrase.
  - Expected: the transcript is inserted exactly once at the caret; surrounding text remains; the
    saved Voice record contains the same transcript; the prior clipboard is restored.

- [ ] **[P1][Pro][Automation-backed + manual permission] Recover dictation paste failure.**
  - Remove Accessibility permission, dictate, then restore permission and retry.
  - Expected: transcription is retained; a clear permission error appears; retry pastes once; no
    stuck overlay, mic, or hotkey remains.

- [ ] **[P1][Pro][Automation-backed + manual audio] Verify engine selection and media import.**
  - Dictate with installed Whisper and Parakeet choices, then import a supported audio or video file.
  - Expected: the selected engine runs; each transcript is searchable; the UI reports the actual
    engine; import completes once without caller-side behavior differences.

- [ ] **[P0][Pro][Automation-backed + manual device] Stop native audio cleanly.**
  - Stop dictation, stop TTS, navigate away during recording, and quit after completion.
  - Expected: microphone indicator and playback stop promptly; no helper process, recorder, audio
    context, listener, or global shortcut leaks.

- [ ] **[P2][Pro][Automation-backed] Verify voice retention.**
  - Set a short retention policy against old synthetic records.
  - Expected: expired rows and media are removed; newer recordings and files remain.

## 10. Pro clipboard and Vault

- [ ] **[P0][Pro][Automation-backed + manual OS boundary] Capture and restore text.**
  - Copy a distinctive string in another app, copy it repeatedly, select it in Clipboard, and
    restore it after copying something else.
  - Expected: one searchable item is refreshed rather than duplicated; selection remains valid as
    new events arrive; paste yields the exact original text once.

- [ ] **[P1][Pro][Automation-backed + manual OS boundary] Capture images and files.**
  - Copy a synthetic bitmap and a disposable file.
  - Expected: each appears once with the correct type and usable preview or path.

- [ ] **[P0][Pro][Automation-backed + manual OS boundary] Restore files to Finder and text apps.**
  - Restore the historical file, paste in Finder, then restore again and paste in Terminal or
    TextEdit.
  - Expected: Finder receives a file URL; the text target receives the path; an image file also
    retains usable pixel data for image targets.

- [ ] **[P1][Pro][Automation-backed + manual global shortcut] Verify Cmd+Shift+C popup.**
  - Open the popup from another app, search, move with arrow keys, restore with Enter, reopen, and
    try one unavailable item.
  - Expected: the compact popup focuses, keyboard selection restores once, reopen resets coherently,
    and failure remains visible with Retry rather than closing silently.

- [ ] **[P2][Pro][Automation-backed] Verify clipboard retention.**
  - Apply short days and max-items limits to synthetic history.
  - Expected: expired or excess history disappears while newer tagged items remain.

- [ ] **[P0][Pro][Automation-backed + manual crypto journey] Create, lock, and unlock Vault.**
  - Create a synthetic vault with a strong test password, lock it, try a wrong password, then unlock
    correctly.
  - Expected: wrong password exposes no items; correct password restores the encrypted vault.

- [ ] **[P0][Pro][Automation-backed + manual visual] Round-trip Vault item types.**
  - Create, reopen, edit, copy, and delete a login, app password, API key, secure note, and disposable
    secret file.
  - Expected: the correct fields persist; copy sends only the chosen field; binary attachment
    remains intact after lock and unlock.

- [ ] **[P0][Pro][Automation-backed + manual recovery] Verify backup and recovery.**
  - Back up the synthetic KDBX fixture and use the documented recovery phrase path to set a new
    password.
  - Expected: the backup remains opaque outside the app; a wrong phrase fails; the correct phrase
    restores access without losing items.

## 11. Settings, privacy, licensing, updates, and upgrade

- [ ] **[P1][Both][Automation-backed] Verify model memory settings.**
  - Toggle image, STT, and TTS residency; inspect Chat; choose each resource preset; relaunch.
  - Expected: toggles persist and affect loading; Chat remains checked, disabled, and marked required;
    presets update limits without freezing the UI.

- [ ] **[P0][Both][Automation-backed] Verify general settings persist.**
  - Change several Core settings and, in Pro, Capture, You, Proactive delivery, learned preferences,
    and plan settings. Quit fully and reopen.
  - Expected: every value restores in the section that owns it; Core shows placeholders rather than
    real Pro section bodies.

- [ ] **[P1][Both][Automation-backed + manual filesystem] Verify Storage totals.**
  - Compare reported models, capture, meetings, images, artifacts, and partial downloads with the
    disposable profile on disk.
  - Expected: totals and category sizes are reasonably aligned and no unknown private path is counted
    as user data.

- [ ] **[P0][Both][Automation-backed] Clear cache without deleting user data.**
  - Create chats, a project, models, settings, and Pro synthetic data; use Clear cache; relaunch.
  - Expected: ephemeral Electron cache is cleared while chats, projects, models, settings, license,
    and Vault remain.

- [ ] **[P0][Both][Automation-backed] Delete one category only.**
  - Delete a selected synthetic category from Data & privacy.
  - Expected: only that category disappears; unrelated stores, connectors, credentials, models, and
    files remain.

- [ ] **[P0][Both][Automation-backed] Delete all personal data.**
  - Seed every Core and Pro personal store with synthetic data, connect a disposable connector, then
    run Delete all my data and relaunch.
  - Expected: chats, projects, memory, knowledge, captures, frames, entities, to-dos, approvals,
    meetings, Voice, clipboard history, Vault data, connector credentials, and personal files are
    gone. Installed models and ordinary non-personal preferences follow the documented retention
    policy.

- [ ] **[P0][Pro][Automation-backed + manual license boundary] Activate Pro.**
  - Enter an invalid key, a device-limit key, then a valid test key. Relaunch when prompted.
  - Expected: invalid and exhausted keys show distinct real reasons and stay locked; the valid key
    persists and unlocks real Pro screens only after the required restart.

- [ ] **[P0][Pro][Automation-backed + manual offline boundary] Verify cached entitlement offline.**
  - Activate online, quit, disconnect network, and reopen. Repeat with a new unentitled profile.
  - Expected: the OS-protected encrypted cache written after online verification follows policy;
    the fresh profile stays locked; a plaintext or expired cache cannot unlock Pro.

- [ ] **[P1][Both][Automation-backed + manual packaged app] Check updates and channel.**
  - With automatic updates on, check Stable and verify an available update downloads in the
    background and installs after a graceful quit.
  - Turn automatic updates off, toggle nightly or beta, relaunch, and verify manual Check,
    Download, and Restart to update. Repeat the check while offline.
  - Expected: Checking always clears; channel and automatic-update preference persist; offline
    error is useful; automatic mode installs on graceful quit; manual mode waits for the explicit
    download and restart actions.

- [ ] **[P0][Both][Automation-backed + manual installer] Upgrade from 0.0.38.**
  - Run once from a 0.0.38 Core install (`co.getoffgridai.desktop`) and once from a 0.0.38 Pro
    install (`co.getoffgridai.desktop.pro`). Create synthetic chats, project knowledge, active
    model selections, settings, and all available Pro stores and entitlement before upgrading.
  - Exercise the real updater ZIP/feed/download/restart path as well as a manual DMG replacement.
  - Expected: 0.0.40 opens without onboarding; migrations run once; all data and selections remain;
    locked and entitled gating remain correct; TCC permissions behave predictably; no duplicate or
    orphaned records appear.

## 12. Failure recovery, offline behavior, and desktop quality

- [ ] **[P0][Both][Automation-backed + manual offline boundary] Use local features offline.**
  - Install required models, disconnect network, then exercise chat, image, local OCR, project
    retrieval, and in Pro Replay, Search, dictation, clipboard, and Vault.
  - Expected: local features keep working with no unexpected egress; downloads, connectors, license
    activation, and update checks fail clearly.

- [ ] **[P0][Both][Automation-backed + manual device] Recover from a forced quit.**
  - Force quit during non-destructive work after a committed chat or project change, then reopen.
  - Expected: the app boots without a white screen or permanently busy state; committed data remains;
    native helpers and ports are not orphaned.

- [ ] **[P0][Both][Automation-backed + manual device] Recover the engine.**
  - Stop or crash the local text engine while Chat is open, inspect System Health, then restore it.
  - Expected: requests wait or fail with the classified reason; after health returns, the next request
    succeeds without corrupting the model or conversation.

- [ ] **[P0][Both][Automation-backed + manual filesystem] Handle low disk space.**
  - Use a safe disposable low-space volume for a download and artifact write.
  - Expected: failures are contained and explained; no partial becomes Ready; existing data stays
    readable; the app remains responsive.

- [ ] **[P1][Both][Automation-backed + manual visual] Exercise large collections.**
  - Use synthetic data to populate at least 120 models, 120 chats, 120 entities, 300 clipboard items,
    and 120 observations where applicable.
  - Expected: search, filters, scroll, selection, and detail panels remain responsive; result surfaces
    are bounded; controls remain adjacent to their content.

- [ ] **[P1][Both][Automation-backed + manual visual] Resize across desktop widths.**
  - Resize from a normal laptop window to a wide desktop window.
  - Expected: collections gain columns or retain a dense master-detail layout; sticky context remains;
    there are no stretched single rows with controls marooned at the far edge.

- [ ] **[P1][Both][Automation-backed + manual accessibility] Verify keyboard focus.**
  - Tab through sidebar navigation, forms, model actions, dialogs, and primary actions.
  - Expected: order is logical, focus is visible, dialogs trap and restore focus, and disabled controls
    are skipped.

- [ ] **[P2][Both][Automation-backed + manual accessibility] Verify transient layers.**
  - Open a menu, modal, image lightbox, and slide-over; press Escape in nested states.
  - Expected: only the top layer closes; underlying filters, selection, and work remain intact.

- [ ] **[P2][Both][Automation-backed + manual accessibility] Verify Reduce Motion.**
  - Enable Reduce Motion in macOS and exercise panels, modals, and details.
  - Expected: content remains reachable; transitions collapse appropriately; no state mounts blank or
    becomes unclickable.

- [ ] **[P1][Both][Automation-backed + manual OS boundary] Verify external links.**
  - Open purchase, help, mobile, and project links.
  - Expected: the exact HTTPS target opens in the system browser and the Electron window does not
    navigate away.

## 13. Final evidence and sign-off

- [ ] **[P0][Both][Manual-only] Review screenshots, video, and logs.**
  - Inspect every file before publishing it.
  - Expected: evidence shows the claimed screen and successful state; it contains synthetic data only,
    no private profile paths, credentials, personal conversations, or real captures.

- [ ] **[P0][Both][Manual-only] Confirm clean shutdown.**
  - Quit the app normally after Core and Pro passes.
  - Expected: no Off Grid AI Desktop app, model server, gateway, meeting recorder, dictation helper,
    microphone use, capture indicator, or mounted DMG remains.

- [ ] **[P0][Both][Manual-only] Record the final decision.**
  - Attach hashes, macOS version, screenshots, video for native interactions, failing logs, and issue
    links to the release record.
  - Expected: every P0 is checked in both applicable entitlement states; every P1/P2 failure has an
    owner and release decision; locked, entitled, Windows, and upgrade results at the top are
    complete.

## Final approval

- [ ] Single macOS 0.0.40 signed/notarized install pass approved while locked.
- [ ] The same macOS 0.0.40 install pass approved with valid Pro entitlement.
- [ ] Both Core and Pro 0.0.38 to 0.0.40 upgrade origins approved.
- [ ] Windows 0.0.40 install and upgrade pass approved, or Windows explicitly removed from release.
- [ ] Core open-source boundary and packaged entitlement gate approved.
- [ ] Pro license, permission, capture privacy, and action approval gates approved.
- [ ] Synthetic-only release evidence approved.
- [ ] Release owner authorizes publication.
