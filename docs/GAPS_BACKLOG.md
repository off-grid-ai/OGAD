# Gaps backlog

Honest log of gaps, regressions, and "not fully done" items. Each entry: what, evidence,
how to reproduce, and the fix direction. Close with evidence; never hide. This file only
holds open work: remove an entry once it is resolved (the record lives in git history).

Mobile-owned gaps live in the mobile repo's `docs/GAPS_BACKLOG.md`.

---

## OPEN

### REL-DRAFTS-20261022 (P2) - Three abandoned draft releases are still on OGAD

**Status:** open. Drafts `v0.0.55-beta.129`, `.130` and `.131` (2026-10-21) are still listed as Draft. The user
said "can delete please" on 2026-10-21. The session asked for a direct confirmation, and none came.

**Required change:** delete the three drafts. Keep `v0.0.55-beta.132` (published 2026-10-21 from `60fcd25d4`).

### ENGINE-NIGHTLY-20261022 (P1) - The nightly engine update has never run

**Evidence (2026-10-22):** `.github/workflows/update-engines.yml` is on `main` with `cron: '30 1 * * *'` and is
enabled, but `gh workflow view update-engines.yml` reports 0 runs. The 01:30 UTC run after the #209 merge did
not fire. The job also needs `vars.ENGINE_UPDATE_ENABLED != 'false'`.

**Required change:** trigger one `workflow_dispatch` run and find out why the schedule did not fire.

**Acceptance:** a scheduled run appears, builds, and opens its PR or reports that nothing changed.

### CUDA-LIVE-20261022 (P1) - The 2026-10-21-v1 CUDA packs are not checked on a real NVIDIA GPU

**Status:** open. The packs are on R2 and pinned in `resources/performance-packs.json`. The engine lists on
runtime.getoffgridai.co carry llama.cpp b11791, sd.cpp master-982 and whisper.cpp v1.9.5. The Runpod session ran
a model with CUDA, but not with the new packs.

**Acceptance:** an installed Linux or Windows build with an NVIDIA GPU downloads the new pack, then runs chat,
image and transcription on CUDA.

### WAKE-LIVE-20261022 (P2) - Overnight wake is not checked on real machines

**Status:** open. The code is on `main`. Nobody has checked the real wake prompt: the macOS `pmset` password
prompt, the Windows scheduled task, and the Linux timer.

**Acceptance:** one overnight capture wakes the machine on each platform.

### REC-F6-001 (P1) - Desktop recovery backlog items need final review

**Check 2026-10-22:** item 4 has `bc6b8a97e` (router offers image tools for "draw a dog"); item 6 has model transfer code (`a9fe7150b`, `1ffe96553`). Item 5: `App.tsx` still shows a spinning loader while Pro loads. The other items are unclassified.

**Status:** open; reported during the cumulative F6 manual pass on 2026-09-11. These items are
observations and possible earlier product work. They are not approved implementation scope and have
not yet been classified against the pre-migration baseline.

Review these items together at the end of the current manual pass so none are lost:

1. **Chat typing speed:** typing in the Desktop chat composer is slow. The user reports that an
   earlier change fixed this, but that change does not appear to be integrated into the cumulative
   F6 state. Reproduce and measure input latency before classifying or recovering the earlier work.
2. **Connector-backed chat queries:** review the earlier work that made enabled connectors available
   to chat queries. Prove the missing user outcome on the baseline and distinguish useful connector
   query support from Shared-model migration or migration-regression work.
3. **Multiple Google accounts:** review the earlier support for adding more than one Google account
   through the connector integration. Verify account identity, separate credentials, selection,
   reconnect, and query routing without exposing one account's data or token to another account.
4. **Image intent from normal chat:** a prompt such as "Draw a dog" does not start image generation
   unless the user first selects Image mode. Review whether the normal chat planner should route a
   clear image request to image generation while keeping Image mode as an explicit direct control.
5. **Startup loader:** Desktop startup shows a spinning loader instead of the intended three-dot
   loader. Restore the standard startup indicator and verify the loading, ready, and failure states.
6. **Two-way model transfer:** sending a model must work in both directions: Desktop to Mobile and
   Mobile to Desktop. Verify discovery, transfer progress, completion, cancellation, failure,
   retry, and that the received model is usable after each app restarts.

**Evidence required to close:** classify each item through the chronological recovery audit; obtain
approval before changing code; then run the accepted real Desktop journey. For typing, record input
latency before and after. For connector queries and multiple Google accounts, use real connector and
provider boundaries with redacted evidence. For model transfer, run the same accepted journey in
both directions with real Desktop and Mobile devices.

### CU-004 (P1) - The current vision-first paths lack complete live control proof

**Earlier Web Use evidence (2026-08-25):** `scripts/qa-agentic-studio.mjs` ran a deterministic Web
Use task through production Electron, SQLite, IPC, CDP, and `WebContentsView`. Inspected captures
proved task history, the execution plan, route ownership, resize, settings, local evidence, pointer
display, takeover, resume, failure, and dark-page composition. That run used the earlier semantic
decision fixture. It does not close the current strict screenshot, judge, and action pipeline.

**Current code evidence (2026-08-26):** the pipeline sweep passed 15 focused files and 200 tests.
They cover the strict model contract, Web Use graph, page-only capture, proportional mapping, browser
actuation, task ownership, live evidence, run-bound model identity, Chat Stop, and the immersive
first-start layout. Its node typecheck passed. The later CU-014 gate passes four files and 58 tests.
The current expanded run has 202 passing tests and one unrelated Chat-planner UI failure. This is not
live Electron or real-device evidence.

**Remaining evidence:** run the current strict visual-decision fixture through the real Electron
Web Use journey and inspect its light/dark screenshots. Also run one safe Computer Use task on a real
Mac. Prove that screenshots, mapped pointer, fresh evidence, milestone progress, and the active model
are factual. For Computer Use, prove that Pause, Resume, Take Over, Stop, Chat Stop, and Esc stop or
park the real native actuator as shown.

### SYN-004 (P1) - Late-pair full graph is not verified between the real Desktop and Mobile apps

**Evidence (2026-08-13):** the production send paths now backfill state records, generated images,
message attachments, and knowledge documents when a device pairs after the data exists. Shared tests
prove byte-bounded anti-entropy. Desktop tests use the real service, SQLite, and temporary files.
Mobile tests use two real sync engines and prove exact file bytes and durable controls. These tests do
not start both actual apps and verify final receiver materialization and UI in one journey.

**Evidence required to close:** create a project, settings, chat text, enhanced prompt, reasoning,
completed tool, generated image, attachment, and knowledge document on device A before device B is
paired. Pair the real apps through the production connect path. Verify every record, relationship,
and byte on B, restart B, and verify that the same graph returns without duplicate transfers or
detached files. Run Desktop-to-Mobile and Mobile-to-Desktop on physical macOS, iOS, and Android.

### DEF-001 (P1) - Replay capture control reports a state that is not factual

**Evidence (2026-08-08):** macOS Settings reported `Screen access: denied` and `Permission
required` while Replay simultaneously showed the recording indicator and `Pause capture`. The
button was disabled, but its label still claimed capture was active. The current renderer derives
the verb from `paused` before it considers permission or scheduler state, so a disabled false claim
is still visible.

**Owning seams:** `pro/main/focus.ts` owns pause reasons, scheduler state, and the native capture
gate; `pro/main/capture-ipc.ts` owns the read-only renderer contract;
`pro/renderer/use-capture-control.ts` owns the shared projection used by
`CaptureToggle.tsx`/Replay and `settings-sections.tsx`; `pro/main/services.ts` must consume the same
projection for the tray. There must be one capture state machine, not independent interpretations of
`running`, `paused`, and permission. Work in progress in these seams is not closure evidence.

**Acceptance criteria:**

- Replay, Capture & processing, and the tray render the same authoritative state: capturing,
  user-paused, temporarily paused (batch/system/privacy), permission required, checking permission,
  or scheduler stopped.
- Only `capturing` offers `Pause capture`; only an explicit user pause offers `Resume capture`.
  Permission-required and checking states never show either verb. A temporary pause identifies its
  owner and cannot be cleared by a conflicting user control. `Restart capture` is offered only for a
  granted-but-stopped scheduler and never clears a privacy or batch pause.
- When Screen Recording is unavailable, Replay shows what is blocked plus actions to open the
  relevant permission surface and recheck. Historical Replay remains usable.
- A state change from Replay, Settings, tray, reprocess, sleep/wake, privacy deletion, or TCC is
  reflected on every mounted surface without reload and without contradictory intermediate copy.

**Evidence required to close:** a real renderer-to-main integration journey covering the complete
state/action matrix through production IPC (only macOS/TCC may be faked); the same journey proving
all mounted surfaces update from one event; packaged-mac screenshots for capturing, user-paused,
permission-required, temporary-pause, and stopped states; and an on-device grant/revoke/relaunch run
showing Replay never claims capture is active while TCC blocks it.

**QA/platform sweep (2026-08-08) - remains OPEN:** the code now has a single main-process runtime
projection for permission, scheduler, pause owner, and allowed controls. Replay, Capture &
processing, and the tray consume that projection. Focused state/action tests, rendered Replay and
Settings tests, and a real App-shell permission route pass; the former source-reading parity check
was removed. The production build, signature verification, scoped lint, and both core/pro typechecks
also passed. A fresh synthetic-profile real-app E2E verified the current native projection in Replay
and produced the UI screenshots, but the cached packaged-app licence was stale, so the packaged
bundle itself could not activate Pro for that visual run. Closure evidence is still missing: no one
journey mounts Replay and Settings while driving the real main IPC and tray through the complete
capturing/user/batch/system/privacy/TCC matrix, and no on-device TCC grant/revoke/relaunch run was
produced. The repository-wide run passed all 433 files and 4,096 tests (one skipped), but the command
still exited nonzero because two unrelated sync tests leaked asynchronous filesystem work/file
handles after teardown. Those pre-existing sync owners remain out of this capture-fix scope, but the
repository test gate is not clean until the unhandled errors are fixed.

### DEF-002 (P1) - Permission status and recovery are not independently discoverable

**Evidence (2026-08-08):** after onboarding, the user could not intentionally open a Permissions
surface to audit or repair access. Permission rows exist inside Settings > Setup & health > System
health, but they are buried among runtime components and have no per-permission recovery actions.
The richer permission cards and `Check permissions again` action live in the first-run setup overlay,
which is not a durable navigation destination. Replay also does not explain its missing permission or
route directly to recovery.

**Owning seams:** core `src/main/permissions.ts` and `src/main/system-status-ipc.ts` own native
permission status/actions and the IPC contract; core Settings owns the durable navigation surface;
Pro Replay/Capture only adds capability context and links into that owner. Reuse the existing
`PermissionGate` card behavior or extract it behind the existing shared component boundary - do not
create a second TCC reader or writable permission store in Pro.

**Acceptance criteria:**

- Settings > Setup & health ends with a plainly named, always-reachable System permissions section
  showing Accessibility, Screen Recording, Microphone, and Local Network independently, including
  what each grant enables.
- Each row distinguishes granted, denied, not determined, status unavailable, and restart required;
  supplies the correct request/open-System-Settings action; and can recheck without restarting the
  whole setup journey. Development builds explain that macOS may list the app as Electron.
- Replay and every permission-dependent surface show a concise permission-required state with a
  direct route to the relevant row. Back returns to the originating surface and unrelated features
  remain usable.
- The status shown in Permissions, System health, Capture & processing, Replay, and setup is a
  one-way projection of one native contract. A failed or inconclusive Local Network probe is not
  mislabeled as a user denial.

**Evidence required to close:** real Settings navigation tests (normal shell and Replay deep-link),
including Back/history and absence of a duplicate first-run-only hierarchy; production-contract
tests for every status/action; packaged-mac fresh-profile and existing-profile runs that grant,
revoke, toggle, recheck, and relaunch each relevant permission; light/dark screenshots at the target
desktop size; and a development build proving the Electron-name guidance and Local Network recovery.

**QA/platform sweep (2026-08-08) - remains OPEN:** the requested durable placement is wired at the
end of Settings > Setup & health, and Replay/Capture & processing can route directly to that section.
Onboarding and Settings reuse the same permission controller instead of adding a second TCC reader.
The focused onboarding/Settings tests and a real App navigation test pass. A fresh synthetic-profile
real-app E2E verified the three current native grants and recheck action in this section and produced
a light-mode screenshot. The current panel still shows only Accessibility, Screen Recording, and
Local Network; Microphone is absent. The shared contract is four booleans, so the renderer cannot
distinguish denied, not determined, status unavailable, or an inconclusive Local Network probe as
required. Back to the originating Replay surface and every native status/action are not yet covered,
and the stale packaged E2E licence prevented a packaged Pro visual run. No packaged
fresh/existing-profile grant/revoke/relaunch run or dark-mode visual evidence was produced. Scoped
lint is now clean.

### DEF-003 (P1) - Capture exposes raw JSON parser failures and strands failed frames

**Check 2026-10-22:** code largely fixed (`8b50d85`; `pro/renderer/CaptureFailureRecovery.tsx` shows the failed count and Retry; invalid output is terminal with a safe message). Still owed: the synthetic-frame E2E seam, packaged screenshots, and diagnostic history kept after recovery.

**Evidence (2026-08-08):** Capture & processing displayed `Last frame failure: Expected ',' or ']'
after array element in JSON at position 446 (line 11 column 2)`, with 14 failed frames. The model
response parser wraps malformed structured output as `capture-model-output-invalid`, but frame
persistence stores the underlying parser message, `capturePipelineStats()` drops the stable error
code, and the renderer prints the raw message. The only broad recovery is `Re-process today`; the
alert itself does not explain impact or recovery.

**Owning seams:** `pro/main/crm/extract.ts` owns structured model-output validation;
`capture-retry-policy.ts` owns retry versus terminal disposition; `capture-frames.ts` owns durable
error code, safe user message, diagnostic detail, and retry state; Capture & processing owns the
projection and recovery intent. Parser internals belong in local diagnostics, not visible copy.

**Acceptance criteria:**

- Malformed model output is recorded under the stable `capture-model-output-invalid` code and shown
  as a safe explanation such as "This frame could not be analyzed"; raw parser text and model output
  remain only in local logs/diagnostics and never leak captured content into the UI.
- The retry policy explicitly handles invalid structured output with a bounded retry/backoff policy.
  Exhaustion leaves the frame durably failed without blocking capture or the rest of a batch.
- The visible failure states the impact, identifies the affected frame/count, and offers an
  appropriate retry/reprocess action. A successful retry clears the active alert and updates pending,
  failed, and observed counts truthfully while retaining diagnostic history.
- Reprocessing a day is resilient to one bad frame, reports updated/skipped/failed outcomes, restores
  live capture according to its pre-run user/privacy state, and never presents the batch pause as a
  user pause.

**Evidence required to close:** an integration journey through the real parser, retry policy, SQLite
frame store, IPC, and rendered Capture section using a controllable malformed response only at the
model-runtime boundary; proof of bounded retry, terminal exhaustion, successful later reprocess, and
non-blocking batch continuation; assertions that raw parser/model content is absent from the rendered
UI; packaged-mac screenshots before and after recovery; and logs correlating the stable code to the
affected frame without recording private frame content.

**QA/platform sweep (2026-08-08) - remains OPEN:** malformed output is now persisted under
`capture-model-output-invalid`, legacy raw parser text is sanitized before renderer projection, an
automatic three-attempt budget is exercised through the real fake-model HTTP boundary and SQLite,
and a later manual reprocess can recover the frame while the next frame in the batch continues.
However, invalid-output retries have no explicit backoff, successful recovery clears the row's
diagnostic fields instead of retaining diagnostic history, and the rendered alert is still only
`Last frame failure: <safe message>`; it does not identify the affected frame/count or place a
recovery action with that failure. The tests do not yet carry one malformed frame through parser,
store, IPC, rendered recovery action, successful retry, and truthful count/alert clearing in a
single journey. No packaged before/after screenshots or privacy-safe correlation-log evidence was
produced.

**Recovery verification contract (2026-08-09) - pending product gates:** the acceptance journey
starts with a frame that became durably failed through the real capture-frame service and a
malformed response from the controllable model-runtime boundary. Opening Capture & processing must
then show the authoritative failed count, the safe impact statement, and a retry action beside the
failure. Invoking it must show scanning/progress, expose the batch-owned capture pause without a
user Resume action, and remain observable after navigating away and back. After the model boundary
returns valid structured output, a real IPC refresh must show the count at zero and remove both the
active warning and retry action. A second journey starts with two failed frames and lets only one
recover; its outcome must say one recovered and one still failed, keep the retry action available,
and never render the raw parser text or captured content.

The current real-app Playwright harness cannot create that starting state through a supported
product boundary. `OFFGRID_SEED_PRO` inserts already-observed Replay rows, there is no capture-now or
synthetic-frame ingress, and relying on host Screen Recording permission and capture-loop timing is
not deterministic. Although `OFFGRID_BIN_DIR` can provide a fake llama executable, directly editing
SQLite would bypass the capture-frame owner and prove only a staged renderer state. The missing E2E
seam is an isolated-profile fixture/service that submits a synthetic image and accessibility text
through the real capture-frame/domain owner; the fake model HTTP process remains the only controlled
boundary and must be switchable from malformed to valid output during the run. No Playwright spec
should claim end-to-end coverage until that seam exists. Packaged macOS evidence still requires
before/progress/after screenshots plus privacy-safe logs correlated by stable error code and frame
identifier only.

### DEF-005 (P1) - Settings Pro previews are dead ends and omit Proactive delivery

**Evidence (2026-08-09):** APP-105's real Electron free-profile journey opened all 12 locked
sidebar destinations and verified that each reaches its matching upgrade screen. Settings does not
provide the same journey. `ProPlaceholder` deliberately renders a non-interactive `motion.div`
with no button, link, navigation intent, or keyboard affordance
(`src/renderer/src/components/SettingsCard.tsx:147-193`). The visible `Device sync`, `You`, and
`What Off Grid AI has learned` cards therefore show a Pro badge and description but cannot explain how
to unlock the feature or take the user to the existing purchase/activation journey. The same run
also found that `Proactive delivery` has canonical placeholder copy in
`proSettingsCatalog.ts:61-70`, but Settings filters that slot out unconditionally at
`Settings.tsx:190-192`, so a free user never sees it.

**Impact:** the sidebar teaches a consistent locked-feature pattern while Settings breaks it with
controls that look like cards but are inert. A user exploring personalization, sync, or learned
preferences reaches a dead end instead of the upgrade path. The hidden Proactive delivery entry
also makes the free Settings catalogue incomplete and lets the declared slot list drift from what
the product renders.

**Owning seams:** `PRO_SETTINGS_SLOTS` is the single source of truth for Settings Pro section
identity, order, availability, and free preview copy. `Settings` owns projecting every applicable
slot. `ProPlaceholder` owns the shared locked-card interaction and accessibility contract. The
existing `UpgradeScreen`/purchase flow owns upgrade and activation; do not create a second Settings-
specific purchase implementation or duplicate the slot copy in a new route map.

**Acceptance criteria:**

- Every applicable free Settings Pro slot, including Proactive delivery, is rendered exactly once
  from `PRO_SETTINGS_SLOTS`; the visible catalogue and the declared catalogue cannot drift.
- Each locked Settings card is a real keyboard- and pointer-accessible control with an unambiguous
  accessible name and visible focus state. Activating it opens the matching upgrade explanation and
  the canonical purchase/license activation actions rather than silently expanding an empty detail.
- The destination has a durable route/deep link, and Back/Cmd+[ returns to the same Settings scroll
  position. Directly opening that route on a free profile shows the same locked explanation; an
  entitled profile resolves the same identity to the real registered Settings section.
- One catalogue owner supplies the title, description, order, platform state, and destination
  identity. Removing or consolidating a feature requires updating that owner, not adding another
  filter or parallel mapping.
- Opening every locked Settings preview leaves Pro services and durable Pro data uninitialized until
  entitlement is actually granted, preserving APP-105's free/Pro isolation guarantee.

**Evidence required to close:** extend `e2e/app105-free-pro-isolation.spec.ts` so a fresh free
profile activates every Settings Pro preview through rendered pointer and keyboard actions, asserts
the exact URL/heading/upgrade CTA, exercises direct deep links and Back/Cmd+[, and repeats the
protected IPC/filesystem isolation checks after visiting them. Add an entitled-profile comparison
showing the same slot identities resolve to their registered sections. Capture settled light/dark
screenshots at the target desktop size and inspect them for focus visibility, clipping, hierarchy,
and absence of duplicate upgrade surfaces. The current APP-105 evidence (3/3 focused tests, clean
typecheck/build, and inspected free upgrade/Settings screenshots) covers every reachable surface but
cannot close this gap because the Settings previews have no activation path and Proactive delivery
is absent.

### DEF-006 (P1) - Screen Recording recovery returns to a blank, stale Settings scroll position

**Evidence (2026-08-09):** APP-120's real Electron journey followed the shipped route from
Capture & processing > `Review permissions` into the nested Settings permissions section, then
clicked `Enable Screen Recording`. After the native boundary opened System Settings and the app
projected `Restart required`, the `Relaunch Off Grid AI Desktop` control remained mounted and a DOM
visibility assertion passed (`e2e/app120-app122-capture-privacy.spec.ts:178-197`), but the settled
2048x1152 screenshot showed only the Settings header, an almost entirely blank canvas, and a scroll
thumb stranded near the bottom. The System permissions content and relaunch action were outside the
viewport, so the rendered recovery path was not usable without hunting through the stale scroll.

The current reveal coordinator is a one-shot, fixed 350 ms `scrollIntoView` keyed to section
selection (`src/renderer/src/components/Settings.tsx:74-86`). It does not re-anchor when permission
state or the expanded card's measured height changes. Settings also introduces its own scrolling
container (`Settings.tsx:123-129`) inside the App content host's `overflow-y-auto`
(`src/renderer/src/App.tsx:1090-1092`), leaving two ancestors able to preserve or mutate scroll
position while `SettingsCard` animates from zero to auto height (`SettingsCard.tsx:127-138`). A DOM
`visible` result therefore does not guarantee that the recovery action is in the user's viewport.

**Impact:** Screen Recording is required for Replay and local vision capture. At the exact point a
denied user returns from macOS and must relaunch to apply the grant, Off Grid AI appears empty and hides
the only next action off-screen. This makes a recoverable permission state look like an application
failure and can leave capture permanently blocked for a user who does not discover the stale scroll
position.

**Owning seams:** App/Settings navigation owns the `/settings/permissions` destination and return
history; Settings owns one authoritative scroll viewport and selected-section reveal; SettingsCard
owns expansion layout completion. `usePermissionController` continues to own permission and
restart-required state only - it must not gain DOM scrolling logic. Establish one scroll owner and a
layout-aware reveal/focus contract instead of adding another timeout or per-button scroll repair.

**Acceptance criteria:**

- `Review permissions` opens `/settings/permissions`, expands Setup & health, and places the Screen
  Recording card fully inside the Settings viewport after the accordion layout has settled.
- After `Enable Screen Recording` opens System Settings and Off Grid AI becomes active again, every
  status transition (permission needed, checking, restart required, granted, or error) preserves a
  useful anchored viewport. `Relaunch Off Grid AI Desktop` is immediately visible, focused or
  predictably reachable, and clickable without manual scrolling; the canvas never becomes blank.
- There is one vertical scroll owner for Settings detail content. Section reveal waits for observable
  route/layout readiness rather than an arbitrary delay and does not scroll an outer App container.
- Directly opening `/settings/permissions`, resizing the desktop window, switching themes, checking
  permissions again, and using Back/Cmd+[ all retain a coherent section header, permission context,
  and recovery action without jumps or stale deep scroll.
- Relaunch still follows the production shutdown/replacement path. A successful grant does not
  implicitly opt the user into capture; APP-120's explicit Resume requirement and APP-122's privacy
  gates remain unchanged.

**Evidence required to close:** extend `e2e/app120-app122-capture-privacy.spec.ts` to assert the
Screen Recording card and relaunch control are inside the actual Settings scroll viewport before
any Playwright action can auto-scroll them, then activate the visible relaunch control and complete
the granted-but-user-paused recovery journey. Cover direct deep-link and Capture-origin navigation,
Back/Cmd+[, a shorter desktop viewport, and the permission-needed/restart-required/granted/error
layout transitions using the native boundary only. Capture and inspect settled light/dark
before-open, return/relaunch, and post-relaunch screenshots. A packaged macOS run must repeat the
real TCC grant/return/relaunch flow and show that no nested scroll ancestor retains a stale offset.
DOM visibility alone is not closure evidence.

### DEF-008 (P1) - Catalog model downloads have a checksum gate but no trusted checksums

**Check 2026-10-22:** still open. `download-verify.ts` skips the check when there is no hash. `catalog-speech.ts` has 0 digests; `catalog-chat.ts` has 17 for 47 sizes. Nothing fails the build on a missing digest.

**Evidence (2026-08-09):** APP-025 passed its full rendered journey after the download boundary first
served a corrupt payload with a bad GGUF header: production kept the `.part`, showed the integrity
failure, resumed through the visible Storage retry, promoted the real model and projector, activated
the model, generated correct replies, and repeated the reply after a full relaunch. This proves the
current byte-count/header gate and recovery path. It does not prove content integrity when corruption
preserves the expected size and the leading `GGUF` magic.

The downloader already calls `sha256IntegrityError()` before promotion
(`src/main/models-manager.ts:294-304`), and `ModelFile` already has a `sha256` field. However, the
catalog entries used by APP-025 - and currently the catalog generally - provide sizes and roles but no
trusted SHA-256 values (`packages/models/src/catalog.ts:58-80`). `sha256IntegrityError()` explicitly
returns success when the expected hash is absent (`src/main/models/download-verify.ts:42-64`). A
same-length modified model with an intact header can therefore be promoted as installed and offered
for activation.

**Impact:** a CDN, mirror, proxy, disk, or interrupted-resume corruption that happens to preserve
length and header can become an installed model. It may fail later, produce unreliable output, or
make the model server appear broken with no trustworthy way to distinguish bad weights from a runtime
defect. APP-025's green result must be described as structural-integrity and recovery proof, not full
cryptographic download verification.

**Owning seams:** `@offgrid/models` owns immutable model-file identity and trusted digest metadata;
the desktop downloader owns streaming verification and atomic promotion; the Models/Storage UI owns
the actionable failure/retry projection. Do not fetch a mutable checksum from the same untrusted
response being verified or maintain a second desktop-only catalog.

**Acceptance criteria:**

- Every immutable catalog file that is downloaded directly, including primary weights and companion
  projectors/tokenizers, carries a trusted lowercase SHA-256 sourced from the upstream immutable LFS
  object/release and reviewed with the catalog entry.
- Download completion streams the staged file through SHA-256 before rename. Missing or malformed
  digest metadata fails catalog validation/build rather than silently disabling verification.
- A matching-size file with a valid GGUF header but one changed byte remains a failed `.part`, is
  never listed as installed/active, and presents a privacy-safe checksum error with Retry.
- Retry replaces or resumes bytes according to the server response, verifies every file in the model
  package, atomically promotes the package, and still supports the APP-025 activate/chat/relaunch
  journey. No corrupt primary or companion file survives as a usable partial model.

**Evidence required to close:** extend APP-025's real Electron boundary so the first response has the
correct length and GGUF magic but a wrong digest, then prove the rendered checksum failure, absence
from installed/active state, successful retry of the real primary and projector, real-model reply,
and relaunch persistence. Add catalog validation that rejects a downloadable immutable file without
a digest and focused downloader tests for match, mismatch, malformed metadata, and multi-file atomic
promotion.

### BLK-001 (release verification) - APP-106 is green, but its provider trace was not retained

**Initial evidence (2026-08-09, superseded):** APP-106 used the real entitlement provider with a
private `0600` licence fixture, a stable persisted `device-fingerprint`, no `OFFGRID_PRO` override,
no licence cache, and no licensing mock. The first rendered activation returned
`registration_failed`: validation accepted the credential, but no `license.json` was created and the
journey did not reach `Restart now`. Because that run retained no privacy-safe provider evidence, it
could not distinguish provider policy/capacity from a client response-contract mismatch.

The client now accepts a successful create/update without a parseable machine document only after an
authoritative roster read confirms the exact stable fingerprint. A missing/malformed roster fails
closed, committed-but-unverifiable mutations surface `rollback_incomplete`, and focused provider
contracts prove a retry of the same fingerprint is idempotent rather than spending another seat. The
subsequent authorized real-provider run completed the full rendered activation/restart journey, so
the original functional blocker is no longer present. What remains OPEN is the explicitly required
diagnostic artifact: that green run did not preserve its sanitized stage/status attachment.

**Owning seams:** the Keygen product/policy and licence-fixture administrator owns confirming that the
fixture may create or reclaim this stable installation. The desktop licensing owner owns a
privacy-safe diagnostic correlation from validate through machine registration and the mapping to
`registration_failed`. APP-106 owns the release proof only; it must continue using the real service
and must not replace this failure with a successful fake.

**Acceptance criteria:**

- The dedicated real licence can validate and register the stable APP-106 fingerprint without
  consuming a new seat on every rerun; any stale fixture installation is deliberately reclaimed or
  removed outside the test.
- A privacy-safe provider trace identifies validation code, registration HTTP/result category,
  policy/capacity disposition, and correlation identifier without logging the licence key or raw
  sensitive response.
- The rendered flow reaches `Activated. Restart to finish unlocking Pro.`, creates an OS-protected
  `license.json`, restarts through `Restart now`, and returns with `isPro: true`.
- The project and chat created before activation remain visible after restart, and Licensed devices
  shows this installation once as `macOS · This device`; teardown leaves no Electron/model process.

**Evidence required to close:** a green APP-106 focused run against the real entitlement service,
with redacted service-side evidence that registration succeeded for the stable fingerprint, plus its
post-restart project/chat and licensed-device screenshots. A mocked Keygen response, `OFFGRID_PRO=1`,
or a preseeded `license.json` cannot close this blocker because each bypasses the failed boundary.

**QA/platform sweep (2026-08-09) - functional journey passes; evidence gap remains OPEN:** the one
authorized real-key rerun passed 1/1 in 27.1 seconds with no licensing mock, `OFFGRID_PRO`, or seeded
`license.json`. The rendered flow activated Pro, used `Restart now`, preserved the existing project
and chat, and returned to the authoritative Licensed devices roster with one stable local row marked
`Off Grid AI Desktop`, `macOS · This device`, and `LOCAL`. The inspected project and roster
screenshots contain no licence credential, and teardown left no Electron test process. Focused
provider contracts passed 49/49; Pro typecheck, scoped lint/Prettier, shared Sync build, and the
desktop production build passed. The broader dirty-branch suite passed 450/452, with two unrelated
membership-revocation/reconnect failures.

The new evidence collector allowlists only provider stage, HTTP status, duration, and bounded
timeout/network outcomes; it never retains the licence key, request path, raw response, fingerprint,
or exception detail. However, the explicit line-reporter run did not materialize its text attachment,
so the exact stage/status sequence and provider correlation are not recoverable from this run. The
authoritative post-restart roster proves the user-visible activation outcome, but it does not satisfy
the separately stated diagnostic-trace evidence requirement. Do not rerun the real activation merely
to manufacture that artifact; close BLK-001 only when a future authorized run preserves the sanitized
trace, or explicitly disposition that trace requirement as a separate non-release diagnostic gap.

### AUT-001 (test evidence) - APP-142 proves recorder lifecycle, not finalized meeting persistence

**Evidence (2026-08-09):** APP-142 is green through the rendered Meetings UI and production
controller/services/IPC. It proves no recorder exists before consent, one click starts one native
child, both local and global recording indicators are visible, Stop sends `SIGINT`, controller/UI
return to idle, and the child exits. The native boundary emits a valid `screen.mov`, so production
finalization code is entered. However, the spec ends after idle/process assertions
(`e2e/app142-meeting-consent-lifecycle.spec.ts:172-187`). It never asserts that finalization created
exactly one meeting record, that the recording is visible/usable, or that either survives relaunch.

This does not identify a product defect and does not invalidate APP-142's explicit-consent,
visible-indicator, singular-recorder, or resource-release evidence. It does mean the spec header's
claim that the “finalization pipeline” is covered must not be interpreted as persisted user-outcome
proof.

**Owning seams:** APP-142 owns the rendered evidence; the production meeting service/store owns the
finalized record and media; the Meetings screen owns discoverability and playback/export. The native
recorder remains the only controlled boundary.

**Acceptance criteria:** after rendered Stop, wait for the real finalization owner and assert exactly
one completed meeting appears with truthful duration/state; open the item and prove its generated
media is usable; fully relaunch Electron and prove the same single meeting remains discoverable and
usable. Assert no duplicate record and no recorder/transcription child survives. If persistence is
deliberately outside APP-142's requirement, narrow its documentation so it claims recorder lifecycle
only and assign the finalization outcome to a separately identified case.

### SYN-001 (P2) - The offline-chat gateway journey cannot reach its own server

`src/main/__tests__/image-runtime-reliability.integration.dbtest.ts > multimodal runtime reliability >
keeps local chat usable when external network reachability is unavailable` fails with
`ECONNREFUSED 127.0.0.1:<gatewayPort>`, thrown in 2ms.

Not contention with a neighbouring file: it fails when that file runs alone. The log shows the SAME
port serving `GET /v1` and `POST /v1/chat/completions` successfully during an earlier test in the
file, so the listener existed and was torn down between tests. The test then calls
`startModelServer(gatewayPort)` again and the connect is refused, which says that call does not
restore a listener once one has been closed on that port.

So the journey under test - chat still answers with no internet - is never exercised at all. It fails
before the first request. The other six tests in the file pass, including the image-library one.

**Fix shape.** Give the model server one owner of "is there a listener on this port", and make
`startModelServer` either return the running one or genuinely bind a new one. Today the second call
appears to no-op against a closed server, which is the same two-answers-for-one-fact shape as the
rest of this document: a port is either serving or it is not, and only the server can say which.

Found while landing the generated-image sync fixes; NOT caused by them (they cannot close a socket),
though that was argued from the failure mechanism rather than proved against the base commit.

### Deferred from PR #60 review (CodeRabbit)

- **bench-capture.mjs — `downscale()` failure aborts the whole run.** A corrupt/unreadable frame
  throws out of the batch/single loops instead of being skipped. Dev-only benchmark tool (not
  shipped), so fail-fast is acceptable; wrap `downscale()` to skip a bad frame if it becomes a
  nuisance. (PR #60, scripts/bench-capture.mjs:212)
- **Transcription provenance label on a cross-family engine fallback.** `getActiveTranscriptionInfo`
  pairs the resolved effective engine with the pre-fallback active model id, so a rare
  parakeet→whisper fallback would label "Whisper · <parakeet model>". The common fallback
  (whisper-resident→whisper) keeps the model name valid; the cross-family case is rare. Fix:
  reflect the actually-run model when `effectiveEngine !== engineForActiveModel`. (PR #60,
  src/main/transcription/select.ts:153)

### Deferred from desktop-pro PR #32 review (Gitar)

- **Transcript provenance shows the selected model even after a cross-family engine fallback.**
  Same root as PR #60's select.ts:153 item. Fixing naively (label built-in when effectiveEngine
  != declared) would regress the common whisper-resident→whisper case (same family, model still
  valid); needs an engine-FAMILY concept. (MeetingsScreen.tsx:87 / select.ts)
- **Reprocess deletes observation-derived actions without regenerating from the corrected summary.**
  Deletion is the explicitly-requested "replace stale misattributed actions" behavior (Task 2);
  entities ARE regenerated. Regenerating actions from the corrected summary is a follow-up.
  (reprocess.ts:245)
- **Failed re-transcribe error persists in the main-owned job status until the next run.** Scoped
  to its meeting (derived by meetingId), so it only re-shows on re-selecting that same meeting -
  accurate but sticky; could clear on ack/navigate. (MeetingsScreen.tsx:178)
- **Re-transcribe on a 2nd meeting while one runs silently no-ops.** Global single-flight is
  intentional (one local whisper); UX follow-up = disable the button / show "another run active"
  when busy for a different meeting. (MeetingsScreen.tsx:160)

### e2e gate: graduate from advisory → blocking

**Check 2026-10-22:** lint and heavy integration are now blocking (`06cefbf60`). Only the E2E step (`ci.yml`, `continue-on-error: true`, gated on `vars.OFFGRID_CI_E2E`) is still advisory.

The Playwright e2e is wired into CI (own `e2e` job) and pre-push, but **advisory** (non-blocking)
for now.

**RESOLVED — item (1) was a misdiagnosis.** This doc previously claimed `meeting-transcription`
and `settings-residency` "need a real model/engine and fail on the fresh e2e profile", and the fix
was to add `test.skip(!HAVE_MODEL, …)` guards. That was wrong, and acting on it would have skipped
two specs that should run. Neither needed a model. They had stale selectors that could never match:

- `settings-residency` clicked a `/Model memory/` **button** — it is an `<h4>` — and never opened
  the `Capture & processing` section that contains the residency controls; 2 of its 4 switch names
  were also stale (`Chat model residency` vs the rendered `Chat and capture model residency`).
- `meeting-transcription` matched an onboarding CTA of `Start using Off Grid AI Desktop` while the
  button renders `Start using Off Grid AI`, so it never left onboarding, then looked for `Meetings`
  exact where a locked-Pro item computes `Meetings Pro`.
- Both Settings tests in `tour.spec.ts` clicked a second section while the first was open —
  sections are single-open, so the target was exit-animating out ("element detached").

All fixed; selectors are now derived from source (`RESIDENCY_ROWS`, `navButton`) so a rename fails
a test instead of orphaning it. Full suite on a real display: **73 passed, 0 failed.** The lesson:
an advisory gate let 7 specs fail on main while CI stayed green — advisory gates rot silently.

**Still blocking (item 2): headless-Electron flakiness in CI.** A clean CI run was 49 passed /
6 skipped / 15 failed, dominated by `electronApplication.waitForEvent('window')` timeouts +
"page/context closed" under xvfb. Done so far: `--no-sandbox` (set), `retries: 2` in CI
(`playwright.config.ts`), and fixed-port specs self-skip rather than fail against a foreign
engine (`e2e/helpers/ports.ts`). Likely still needed: GPU flags (`--disable-gpu` /
`--use-gl=swiftshader`) in the Electron launch args.

Flip the CI `e2e` step and the pre-push e2e to blocking once a few consecutive runs are green.
Do not flip while the runner still drops instances — a gate that gets reverted loses the signal
again. No product regressions are known.

### Known residual flake: `pro.spec.ts` clipboard quick-open (focus-dependent)

`Clipboard quick-open renders populated content on the first native hotkey press` drives a REAL
global hotkey through `osascript` → System Events, which delivers the keystroke to whatever app is
**frontmost**. It was therefore order-dependent: it passed in a full-suite run (an earlier spec left
the window focused) and failed **3/3 when `pro.spec.ts` ran alone** — the keystroke went to the
terminal. Pre-existing, reproduced on `main` @ 556d435; not a product bug.

Mitigated, not solved: the spec now calls `app.focus({steal: true})` and polls `isFocused()` before
sending the keystroke, which takes isolation from 3/3 failing to roughly 1-in-3. The residual cause
is that `isFocused()` reporting true still does not guarantee System Events targets our app (macOS
Accessibility/automation timing). With `retries: 2` in CI the practical failure rate is low, but
this spec should not be trusted as a hard gate until the hotkey is driven deterministically —
options: assert the global-shortcut registration before pressing, or expose a test-only IPC that
triggers the same handler and keep the native-key path as a separate, quarantined check.

### Worth a look: the eviction confirmation promises the peer's licence is cleared

`projectMembershipEvictionConfirmation` adds "Off Grid AI will also remove its saved licence" whenever
the device is connected. That sentence is only earned if the eviction actually reaches the peer, and the
`stage: 'failed'` path exists precisely because it may not. Not a defect in itself - the copy is gated on
an authenticated session, which is the strongest reachability fact available - but the promise is made
before delivery is confirmed, and a failed eviction leaves the user believing something that did not
happen. Flagged for a copy decision, not changed.

### P2 - a long-running desktop instance can end up with NO sockets at all, mesh included

Observed on .64 (packaged v0.0.42) on 2026-08-06. The app had been up since 09:36 and was licensed
(`[Pro] license loaded - entitled=true`), and `pro:sync:status` was answering IPC on a 2s poll - yet the
process held **zero TCP and zero UDP sockets**. Confirmed three independent ways, all agreeing:
`sudo lsof -nP -iTCP -sTCP:LISTEN`, `netstat -an -p tcp`, and `sudo lsof -nP -p <pid>` for each of the
four app pids. Machine-wide there was only sshd:22 and a launchd 127.0.0.1:8021.

Not just the mesh: `llama-server` (127.0.0.1:8439) and the gateway (7878/7879) were absent too, and the
app's own sidebar read `Model stopped`. A restart restored everything at once - mesh listener on an
ephemeral wildcard port, 8439, 7878, 7879 - and the sidebar went to `Model running`.

**Why this is worth a gate, not just a restart.** `pro:sync:status` reported `serviceState: 'running'`
throughout. The LAN route is `required: true` in the MultiTransportBridge, so a listen failure at startup
would have rethrown out of `service.start(0)` and aborted `setupSyncIPC` before that handler was ever
registered - meaning the socket was NOT lost at startup, it went away later while the service went on
claiming to be up. From the phones' side this is indistinguishable from the Mac being switched off: both
phones simply showed it Offline, for days (`last seen 03/08/2026`).

Cause not established - this box is also running a VMware Fusion Windows guest, so resource pressure or a
sleep/wake cycle are both plausible and neither is proven. What IS actionable regardless: the status a
peer reports should be derived from the listener actually being bound, so `serviceState: 'running'` cannot
outlive the socket. A liveness check that re-binds or reports unhealthy would have surfaced this in
seconds instead of days.

### macOS Activity reports FILES, so a half-sent package reads as success

**Check 2026-10-22:** the package state is tracked (`model-package-transfer.ts`), but Activity is still built from per-file `transferActivity` in `DevicesScreen.tsx`.

**Status:** open. Verified on screen and against the engine log, 2026-08-07.

A model package is several files. A vision model is two: the GGUF and its mmproj. Activity lists a row
per FILE and has no notion of the package, so a transfer that dies between files reads as a success.

Observed after a macOS -> iOS send of `unsloth/Qwen3.5-0.8B-GGUF` (`kind="vision" files=2`):

    Activity:  0 active - 0 queued - 0 failed
               Qwen3.5-0.8B-Q4_K_M.gguf    COMPLETED
               (no row for mmproj-Qwen3.5-0.8B-BF16.gguf at all)

The engine knew better. From the same session's log:

    13:06:39 INFO  pro:sync:send-model started
    13:07:28 ERROR request.failed error="device disconnected during transfer"
               at FileTransferManager.failOutgoing
               at SyncEngine._removeSession

So the send failed, the first file had already completed, the second never started, and Activity shows
one COMPLETED row and ZERO failures. The user is told the model went.

Meanwhile the receiver reports "could not receive / interrupted" AND registers the completed primary as
a plain 508 MB text model - see the half-package entry above. Between them, the two devices give three
different answers and none of them is "this vision model did not fully arrive".

**The missing file is missing from Failed too.** Confirmed on screen: the mmproj is not under Completed,
not under Failed, not queued. Nowhere. Transfer rows are created when a file STARTS, and the session
died before file 2 began - so the one file the user needed to know about is the only one the UI cannot
show. Absence is indistinguishable from "there was never a second file".

**Fix shape.** Two parts, and the first is the one that makes the failure visible at all:

1. **Enqueue every file of a package up front**, as `queued`, before any bytes move. Then a file that
   never starts is a visible unsent row rather than nothing, and it lands under Failed when the package
   fails. This alone would have shown the truth on this transfer.
2. **Make the package a first-class row**: N files, progress across the set, one status for the whole
   thing, with the per-file view underneath. The headline status has to be the package's, because that
   is the unit the user asked for.

Independently: `0 failed` next to a logged `request.failed` is its own bug - the failed job is not
reaching Activity even for the file that DID have a row.

### Model transfer can use more of a fast local network

**Status:** open, non-blocking for the current release. Filed 2026-08-21.

The current release removes the JavaScript checksum bottleneck, receives complete authenticated
frames on iOS, and keeps a bounded encrypted send window full. The real desktop-to-iPhone test then
reached about 6.5 MB/s on a 5 GHz connection while a second desktop-to-Android transfer used the same
uplink. The Mac had negotiated a 195 Mb/s Wi-Fi link at -68 dBm, so this test does not establish the
maximum rate of either device or the new transport.

Follow up with an isolated physical-device benchmark on a strong 5 GHz or 6 GHz link. Measure one
desktop-to-phone transfer at a time, separate checksum preparation from wire time, and compare both
directions. Also persist verified file checksums so a repeat send does not hash the same multi-GB
model again after an app restart. Keep the 4 MiB authenticated frame format and bounded memory.

### Desktop voice modes need the final physical audio pass

**Status:** automation-backed; manual device verification is open. Filed 2026-08-24.

The rendered Chat journey now proves Manual start/stop and cancellation, Auto end-on-silence,
Hands-free speech detection, the generation and playback lock, the two-second speaker-drain wait,
automatic rearming, pause, and the transition back to text mode. The global dictation reducer also
proves Hold, Toggle, and Both, including auto-repeat protection. The focused suites pass 41 tests.

The remaining boundary is the installed macOS app with real hardware and models. On the release Mac:

1. Select a Whisper model and a Parakeet model in turn. Confirm Chat reports and uses the selected
   transcription model without changing the chat model.
2. Speak one turn in Manual, Auto, and Hands-free. Confirm Auto does not cut off a normal pause and
   Hands-free does not record its own Kokoro reply.
3. Interrupt and pause Hands-free, switch to text during an active recording, deny and restore
   microphone permission, and cancel during transcription. Confirm the mic indicator and audio output
   stop and no discarded transcript appears.
4. In TextEdit and one other app, verify the Pro Voice Hold, Toggle, and Both gestures and confirm one
   transcript is pasted for each completed turn.

Close this gap only with the exact packaged build, an audible reply, the real macOS microphone
indicator, and a saved diagnostic excerpt that identifies the active speech-to-text model.

### Personal Mesh visibility and Google OAuth need installed passes

**Status:** automation-backed; manual macOS and provider verification is open. Filed 2026-08-24.

The release tests prove the Personal Mesh lifecycle through the Shared contract, the Electron bridge,
and the macOS helper. They also prove that a failed advertising stop keeps the last true state and
that a later stop can retry. Complete rows PR-14 through PR-16 in
`docs/RELEASE_READINESS_CHECKLIST_0.0.40.csv` on the exact
release Mac with a second physical device. Confirm Hidden at cold launch, separate Discoverable and
Find nearby controls, an active encrypted session during visibility changes, a private IP or machine
name endpoint, one custom Sync port on every device, and failed-stop recovery through a diagnostic
helper.

The Google connector UI and credential paths have automated coverage, but the real provider boundary
still needs one installed pass. Complete row PR-13 with a real test account and a Web application OAuth
client. Confirm both APIs are enabled, the account has consent or test-user approval, the exact local
callback completes, Gmail and Google Calendar connect, and both connection tests succeed. Relaunch,
reconnect, and confirm that the protected credentials still work.

Close this gap only with the device names, OS versions, exact build commits, Google project test
status, redacted provider evidence, and completed checklist rows. Do not put client secrets, tokens,
mail, calendar records, or other private data in release evidence.

### Remote task approval and live-frame sync need lifecycle closure

**Status:** code resolved 2026-08-28; physical cross-device verification pending.

The Release 107 implementation now has one Desktop-owned task state machine for Web Use and Computer
Use. Commits `4fe7f3a4`, `78658e16`, `f2a13c2`, `aefe8fe`, `922eb382`, `62c350a`, and `d69e3ff4`
provide the following closure:

1. `takeover` is canonical at the shared and Desktop runtime ports. Pause, Resume, Stop, and Take Over
   are covered for both task kinds.
2. Chat tasks start directly. Task approvals no longer enter the general synced ActionApproval path.
   Desktop Actions keep their Desktop-owned approval, then create one execution chat.
3. Each control intent has a correlation id. The Desktop runtime publishes the authoritative applied
   or rejected result. Subscriber UIs do not infer state transitions.
4. Live-frame persistence keeps one current winner instead of appending every frame. Terminal tasks
   evict their cached frame.
5. An inbound task must match authenticated execution-device provenance before it is rendered or
   controlled.
6. Each paired Mobile has a persisted, default-on remote-task permission on this Desktop. An explicit
   off value rejects execution. Both task schemas expose the optional `execution_device` routing field,
   and the Desktop strips that field before the task extension runs.

Local evidence: Desktop and Desktop Pro typecheck pass; permission and routing tests pass 107/107;
the public MCP client/server integration passes 3/3; remote-task DB journeys pass 9/9; the production
Electron build passes. Keep this entry open only for the final two-Desktop physical journey on the
release build: default routing, exact named routing, permission off, live frame, all four controls,
offline recovery, and terminal cleanup.

### Release 107 exact-operation Sync needs final Desktop owner and restart proof

**Status:** Code and Shared build evidence exist; Desktop Built and Live verified gates are open.
Filed 2026-08-29.

Shared now persists durable per-entity and per-device watermarks. It also uses exact operation IDs
for delivery acknowledgement, deduplication, and applied-winner checkpoints. A watermark is only an
anti-entropy position. It is not proof that one operation arrived, because destination-gated delivery
can leave a valid hole below that position.

Desktop loads the full operation log through `loadOps()`. No Desktop production caller uses the
Shared compaction helpers. The Shared focused checkpoint set passed 29/29, and the Shared Sync
typecheck and package build passed.

Keep this gap open until these gates pass on the final tree:

1. The exact winning operation is checkpointed only after each external file or meeting owner has
   completed its durable write.
2. Missing bytes, missing dependencies, and failed puts remain retryable.
3. The Desktop exact-operation external-owner tests pass.
4. One final Desktop production build passes after the last related change.
5. Two clean Desktop restarts show no runtime symbol mismatch, no per-record
   `record_already_present` flood, no active compaction, and no 550-record loop.
6. One Desktop change reaches the iPhone once, and one iPhone change reaches Desktop once.

Two earlier clean restarts are retained evidence. They do not close this gap because the related
exact-operation code changed later.

### Release 107 Computer Use PiP needs final installed visual proof

**Status:** Code and Wired gates pass; Built and Live verified gates are open. Filed 2026-08-29.

Release 107 uses the task pane as the Computer Use interface. The hidden native window exists only
to provide the exact ScreenCaptureKit exclusion ID. Its creation path does not show the PiP. The task
pane has no Open PiP action, and the in-app floating task view selects only Web Use.

Keep this gap open until the final Desktop build passes and one installed macOS Computer Use journey
confirms that no Computer Use PiP appears before, during, or after the task. Also confirm that the
task pane still shows the live frame, current step, controls, guidance, and terminal replay.

### Release 107 QR panel and sidebar parity need final Desktop proof

**Status:** Shared QR Code and Built gates pass. Desktop code is still being finalized. Desktop Built
and Live verified gates are open. Filed 2026-08-30.

The Shared versioned QR codec and private-route projector are complete. The Sync ESM, CJS, and DTS
builds pass. Focused QR, real-handshake, and runtime checks pass 21/21. The final QR suite passes
11/11. Sync typecheck, focused ESLint, and diff check pass.

The Desktop end state is:

1. Show QR Code opens the existing Devices side panel. The QR code is hidden before that action.
2. Generate new code and Show QR Code use labeled icons. The QR code has the Off Grid AI logo at its
   center and keeps a copyable-code fallback.
3. The payload identifies this Desktop and includes only private routes that this host can prove.
4. One sidebar model owns Discover, Work, Private Data, System, and the footer destinations.
5. Collapsed and expanded widths keep the same section state, item order, active route, notification
   badge, and footer actions. Hover and keyboard focus change width without changing the item set.

Keep this gap open until focused Desktop tests pass, the final production build passes, and an
installed macOS check proves the QR panel and both sidebar widths. The QR check must use an iPhone to
scan and pair the exact Desktop. Android is not required to close the Desktop visual proof.

### MODEL-DISCOVERY-20261013 (P2) - The API does not list every downloaded speech and transcription model

**Status (checked 2026-10-22):** resident image engines and image/text/vision discovery shipped in `1ec5d3acd`.
`src/main/model-server.ts` still reports only the active speech and transcription pick.

**Required change:** list every downloaded speech and transcription model through its existing runtime routing.
Check that an arbitrary Hugging Face image pack is complete before offering it for image generation.
