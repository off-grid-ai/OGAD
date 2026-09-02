# Gaps backlog

Honest log of gaps, regressions, and "not fully done" items. Each entry: what, evidence,
how to reproduce, and the fix direction. Close with evidence; never hide.

---

## OPEN

### MOD-001 (P0) - Shared model consolidation needs final live and release proof

**Code and wired evidence (2026-09-01):** the Shared image application, Desktop model-library
transactions, and Mobile transcription and residency workflows now own the portable decisions.
Desktop keeps filesystem, Electron, process, and native-engine ports. Mobile keeps React Native,
filesystem, Whisper, and platform-engine ports. A source scan found no test replacement for
`@offgrid/models`; both apps load the real local Shared package.

The follow-up sweep passed the full `@offgrid/models` package gate: build, type declarations,
architecture, and 371 tests. The Desktop model architecture gate passed with zero temporary items.
Fourteen focused Desktop image and model-library files passed 130 tests. Four focused database files
passed four tests through the Electron-ABI database runner. One first attempt collided with another
test process on port 8439; the affected first-use journey passed alone after the port was released.
Both Mobile model architecture gates passed. The focused Mobile transcription, download, and
residency group passed 331 tests, and its one batch-timeout case passed alone in 2.8 seconds with
open-handle detection.

**Focused live-defect follow-up (2026-09-01):** Shared download hydration now leaves recovered
interrupted work idle and retryable unless a verified native transfer still owns it. Shared voice
readiness reports the requested modality instead of a false text-model failure. Direct Desktop image
generation keeps the safe memory refusal and carries explicit `Run anyway` approval into Shared
residency admission. The related focused Shared and Desktop tests passed, and Desktop node typecheck
passed. These checks close the concrete code defects found during the development run. They do not
replace the packaged and physical-device evidence below.

**QA/platform-integration and docs sweep (2026-09-01):** Shared models typecheck and architecture
passed. Desktop node typecheck, web typecheck, and model architecture passed with zero temporary
items. The combined boundary scan found one Computer Use role-projection owner in Shared policy and
one Desktop application adapter that supplies runtime facts. The image memory override remains an
explicit request fact; download restart ownership remains in the Shared coordinator. No Desktop or
Electron import crosses into the Shared model package. The Desktop Models guide was corrected to
state the current interrupted-download recovery rule and on-demand Kokoro speech preparation. This
is integration and documentation evidence only. The complete release proof remains open.

**Open release evidence:** run the complete Shared, Desktop, Mobile, and Pro command matrices on one
candidate head. Then verify local and remote text, vision, image, transcription, speech, download,
repair, transfer, load, force-load, co-residency, eviction, unload, eject, Stop, Resend, Edit, and
Regenerate in the packaged Desktop app and on physical iOS and Android devices. Reproduce the earlier
iPhone Resend freeze with native logs. Verify that the selected model shown in the UI is the exact
route that executes. Do not close this entry from focused tests or static gates.

Some older Mobile unit tests replace Mobile services above the native boundary. They are not valid
end-to-end evidence under the current testing standard. The release decision must use the rendered,
cross-service, native, and live journeys.

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

### CU-013 (P1) - Computer Use and Web Use have different visual workflow owners

**Evidence (2026-08-26):** Web Use runs `runVisionTaskGraph` through `browser-visual-task.ts`.
Desktop Computer Use still runs the older `runVisionTask` loop through `vision-host.ts`. The old loop
adds a model answer to `policyHistory` before it knows whether actuation succeeds. A rejected action,
handoff, rethink, or terminal decision can therefore remain in the next model request as a prior
validated decision. The graph commits that history only after successful actuation and discards it
for rejected or non-action decisions.

The standalone `vision-agent.test.ts` command does not finish and had to be stopped after 30 seconds.
Scoped ESLint also reports a hard error in `vision-policy-runner.ts`, plus size and complexity
warnings in both workflow owners. The superseded semantic `web-task-agent.ts` runtime and its tests
have been removed; Web Use now has one production workflow owner.

**Impact:** the same valid model response can produce different history and recovery behavior on the
desktop and browser surfaces. Two owners can drift on Stop, evidence, milestone, and action-commit
rules.

**Fix direction:** route both surfaces through one workflow owner with injected capture and action
boundaries. Commit model history only after successful action execution. Remove superseded runtime
loops when the shared path is wired. Make the focused desktop test finish, then clear the scoped lint
gate and rerun both surface journeys.

### CU-015 (P0) - Selectable remote vision paths violate the local-only contract

**Evidence (2026-08-26):** the standing product constraint says local models only and nothing leaves
the device. The current model UI can select OpenRouter or a custom remote server.
`vision-policy-runner.ts` then sends the base64 screenshot and full task context to that server.
Only OpenRouter receives an explicit `reasoning_effort`; Ollama, LM Studio, OGAD, and custom
OpenAI-compatible endpoints do not get a transport-level thinking control. The application does not
prove that every selectable remote model is thinking-enabled.

**Impact:** a cloud endpoint can receive private screen evidence and task context without a product
exception to the local-only rule. Other remote paths can also run the required contract without a
verified thinking mode.

**Fix direction:** remove network model-server selection from Computer Use and Web Use, or make a
documented product decision that changes the local-only constraint. Any approved exception needs an
explicit per-server privacy boundary, clear local-network versus cloud disclosure, user opt-in, and
a capability gate that rejects a model unless the required visual, structured-output, and thinking
features are verified.

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

### DEF-004 (P1) - Oversized capture analysis stays pending and retries forever

**Evidence (2026-08-09):** the live macOS database showed 115 frames as `pending` under the stable
`capture-model-unavailable` code. Every row carried the same model-runtime response: the analysis
request exceeded the model context window. The backlog was not a burst of current capture failures:
114 rows dated to Aug 3, while the last 30 minutes contained 57 observed frames, 12 intentional
skips, and one pending frame. Pending accessibility text ranged from 1,442 to 71,633 characters, and
the same rows had accumulated between 3 and 202 transient retries.

**Impact:** capture remains available and the images stay saved, but Replay never receives
observations for these frames. The UI reports only a growing pending count while the processor spends
time repeating requests that cannot fit the selected model. A model shown as `ready` therefore
coexists with a six-day queue that has no visible reason or recovery path.

**Owning seams:** capture input construction owns a model-aware text/image token budget;
`capture-retry-policy.ts` owns the retry ceiling and backoff; frame persistence owns a durable blocked
reason; Capture & processing owns the user-facing backlog explanation and recovery action.

**Acceptance criteria:** fit capture input within the active model's context budget using a
deterministic, privacy-preserving reduction strategy; bound and back off repeated context-overflow
attempts; retain the captured frame when analysis cannot proceed; distinguish actively queued work
from work blocked by model capacity; and show the exact next action without exposing captured text.
Changing models or increasing context, then retrying, must drain the blocked backlog and update Replay
and queue counts through the normal database and IPC owners.

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

---

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

---

### SYN-002 (P1) - Deliveries outlive the device, and inflate every count the user reads

2,246 of the delivery rows on this Mac point at a `device_id` that is not in `sync_paired_devices`
at all. They can never succeed, and they are counted:

| device_id                          | in paired table | rows                                                                   |
| ---------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `6e1c3b7150fb1f088b52a4c2e99eda78` | no              | 2,077 (1,559 skipped · 367 failed · 150 queued · 95 sent · 2 rejected) |
| `8Lj2tUzzpBQ1zJEPHGfrSw`           | no              | 119 (78 sent · 18 dismissed · 16 rejected · 5 skipped · 2 queued)      |

A device is forgotten and its deliveries stay. So "158 queued" and the failure total describe work
aimed at machines this Mac no longer has any relationship with, and no retry can ever clear them.
The delivery is parented by a device, so forgetting the device must settle its deliveries - the same
lifecycle rule as everywhere else in this document.

**Second, smaller finding.** Those two ids are not the same SHAPE. A device id here is 32 hex chars
and a membership id is 11; `8Lj2tUzzpBQ1zJEPHGfrSw` is 22 base64url chars, which decodes to 16 bytes -
the same width a device id encodes as hex, but not equal to any id this Mac holds. So the column has
carried more than one id encoding over its life. Worth confirming before any migration keys on the
column, because a comparison between the two forms silently fails.

**This also corrects two entries in the previous session's handoff.**

1. `service.listPaired()` does NOT return 1. It reads `sync_paired_devices`, which holds all three
   devices. `pro:sync:share-file` resolves destinations from it, so destinations were never narrowed
   to the offline Windows machine. The "all 1 paired device" count came from the RENDERER being
   handed `saved` instead of the whole mesh, and that is already fixed on this branch.
2. The failures are not one offline machine. They are spread: Windows 1,928 · iPhone 480 ·
   a forgotten device 367. And the phones do receive - iPhone 103 sent, Nord 12 sent.

---

### SYN-003 (P2) - A knowledge-document test outlives its own temp directory

`pro/main/sync/__tests__/knowledge-document-sync-service.test.ts` fails in a full-directory run with
`ENOENT: mkdir '/var/.../offgrid-knowledge-sync-XXXX/stage'`, and passes on its own. ENOENT on mkdir
means the PARENT is gone, so the root the test made has already been removed while the service is still
working in it - async work started by a test and not awaited by it, cleaned up underneath.

Not a collision with its sibling: `knowledge-document-transfer.test.ts` shares the `offgrid-knowledge-`
prefix but removes only its own root, by path.

Two tests in the same directory therefore pass or fail depending on timing, which makes the suite a
weak signal exactly where it should be strongest. The fix is for the test to await what it started, or
for the service to expose a settled point to wait on.

Found while landing the peer-link adoption. Not caused by it: nothing in that change touches
knowledge-document sync, and the service under test builds no orchestrator.

---

## RESOLVED

### DEF-009 (P2) - ModelPicker uses the main-owned Computer Use projection - RESOLVED 2026-09-01

The renderer no longer resolves the Computer Use model. `getComputerUseActiveModelProjection()`
uses the main-process strategy, active Chat route, remote route, and selected specialist identity.
`desktopModelServices.modelControlSnapshot()` includes that projection. `ModelPicker` renders the
projection and sends selection commands through the model-control application boundary. It does not
match `id`, `primaryFile`, or `computerUseStrategy` to infer the active Computer Use route.

**Closure evidence:** the focused main integration proves the `Text + Specialist` projection uses
the exact reasoner and grounding specialist that the task strategy executes. The focused renderer
integration proves `ModelPicker` renders those main-owned roles and local/remote facts from the
model-control snapshot. Both files passed 10/10 tests. Desktop node typecheck passed in the same
round before this backlog reconciliation.

---

### MOD-003 (P1) - Local model registry failures are typed and atomic - RESOLVED 2026-09-01

Shared remains the local import, transfer-registration, and removal transaction owner. Desktop now
supplies one `LocalModelRegistry` filesystem adapter. A missing file is the only empty state;
unreadable, malformed, and invalid registries return typed failures. Writes use a mode-0600 temporary
file and atomic rename, so a failed save keeps the prior registry. Shared converts adapter failures
to failed command results and removes newly copied import bytes instead of reporting success.

**Closure evidence:** focused Shared tests prove typed import, transfer, and removal failures. Real
Desktop filesystem tests prove absent/corrupt distinction, atomic replacement, prior-state
preservation, and the full import boundary against damaged JSON. Focused checks passed 7/7. Desktop
node and web type checks passed.

---

### MOD-005 (P2) - Orphan cleanup reports partial failures - RESOLVED 2026-09-01

The Desktop cleanup adapter now returns each failed filename, its retained bytes, and the boundary
error. `success` is false when any file remains. Storage refreshes its authoritative scan and shows
the failed names and retained size. A missing file remains safe through forced idempotent removal.

**Closure evidence:** a real models-directory integration test removes one orphan, forces an
`EACCES` boundary failure for the second, and proves the second file remains visible. The Storage
integration proves the user sees the failed filename and retained bytes. Focused checks passed 9/9.

---

### MOD-007 (P2) - Download recovery persistence has visible health - RESOLVED 2026-09-01

`DownloadRecoveryStore` is the single Desktop persistence adapter for Shared's download
coordinator. Missing recovery data is healthy and empty. Damaged/read-failed data stays degraded and
is not overwritten. Writes use a mode-0600 temporary file and atomic rename; a transient write
failure keeps the prior valid snapshot while live downloads continue. Diagnostics and the Storage
health projection state the restart-resume risk.

**Closure evidence:** real filesystem tests prove damaged-state reporting and last-valid-snapshot
preservation across failed atomic promotion. The Storage integration proves the non-blocking health
message is visible. Focused checks passed 10/10. Desktop node and web type checks passed.

---

### AUT-003 (P1) - Approval intake load failure leaves Review in Chat with no result - RESOLVED 2026-09-01

Approval intake now uses one closed `idle | loading | ready | error` state contract. The Pro
approval store stays authoritative. A rejected, unavailable, or missing read shows the typed
reason, preserves the approval, and offers Retry or Close. The renderer does not create a
substitute record. Both the event path and direct Chat target use the same loader.

**Closure evidence:** `MemoryChat.approval-intake.integration.test.tsx` drives the real Chat listener
through a failed Pro IPC boundary, verifies the visible failure and unchanged approval message,
retries, and opens the original intake. The focused renderer/preload files passed 24/24 tests.
Desktop node and web type checks passed.

---

### CU-016 (P1) - Computer Use settings show defaults when the authoritative read fails - RESOLVED 2026-09-01

Shared defines the Computer Use settings port result. Main is the only read/write owner and returns
authoritative settings or a typed unavailable result. The Pro renderer shows loading or a retryable
failure instead of defaults, blocks writes until a successful read, and sends only the changed
field. Main merges that patch with the latest persisted object. A save failure keeps the last
authoritative projection and shows the reason.

**Closure evidence:** `ComputerUseSettingsSection.integration.test.tsx` proves load, field-only
patch, read failure, retry, and save rollback behavior. `computer-use-settings.integration.dbtest.ts`
proves the real SQLite owner preserves untouched fields. The focused renderer/preload files passed
24/24 tests; the focused DB file passed 5/5. Desktop node and web type checks passed.

---

### MOD-004 (P1) - Model finalization reports active-projector repair failure - RESOLVED 2026-09-01

Desktop now has one fallible `finalizeInstalledModelArtifacts` command. Download and transfer
registration both use it. A projector persistence or reload failure becomes the typed
`ActiveModelProjectorFinalizationError`; the Shared download coordinator records a failed,
recoverable terminal state instead of completed. Transfer registration returns the same actionable
failure result. Retrying is idempotent because verified artifacts remain ready and the finalizer
runs again.

**Closure evidence:** real filesystem and HTTP-boundary integration tests force the active selection
file to reject the projector update, assert that download and transfer registration report failure,
restore the file, retry, and assert that the projector is persisted. The four focused files passed
15/15 tests. The Desktop model architecture gate passed.

---

### MOD-006 (P2) - One Desktop image-runtime identity adapter - RESOLVED 2026-09-01

`desktopImageRuntimeIdentity` is now the only Desktop adapter that maps Shared's canonical image
model ID and artifact-role facts to the native image runtime identity. Image generation and model
removal consume that port. Shared remains the only catalog and primary-artifact policy owner;
Desktop keeps only the one-way native filename projection.

**Closure evidence:** focused tests prove that a Shared catalog ID maps to its primary artifact and
that unknown native identities remain unchanged. Image generation no longer imports or calls
`primaryFileName`. The four focused files passed 15/15 tests. The Desktop model architecture gate
passed.

---

### IMG-001 (P1) - Generated image persistence failures are explicit - RESOLVED 2026-09-01

Direct, RAG, and tool-owned image paths now preserve the generated artifact while projecting a
visible `created but not saved` warning onto the image when its durable Chat message or sidecar
acknowledgement fails. Each failure is logged with the conversation, turn, artifact path, and sync
identity. Tool-owned image rows also change from completed to failed, so `Work done` cannot describe
an image that did not reach its Chat record. SQLite remains the Chat-message owner; the image job
remains the artifact owner.

**Closure evidence:** the real `MemoryChat` component test forces the assistant image-message write
to fail, proves the artifact stays visible, proves the warning has alert semantics, and proves the
sidecar acknowledgement does not run without a durable message. The complete focused image file
passed 24/24. The image lifecycle and cancellation files passed 38/38 before this additional case,
and the cancellation/relaunch E2E passed 1/1.

---

### AUT-002 (P1) - Chat action approval results are durable and failure-isolated - RESOLVED 2026-09-01

`@offgrid/use` now owns an append-once terminal Chat-action journal in the same injected SQL driver
as its queue. The engine writes the terminal record before it removes the queue item and exposes
only a read-only outcome reader. A stop after the journal write leaves a saved terminal machine
snapshot; restart clears the stale lease, completes queue cleanup, and does not execute the external
effect again.

Desktop converts the engine record into the stable core-to-Pro `ChatActionResult` contract. A Pro
observer exception is contained and logged after the action result has committed, so it cannot
reject the completed wait or invite a retry. Pro startup reads the authoritative terminal journal
and projects matching `approved` rows to `executed` or `failed`. Reconciliation calls only
`recordExecution`; it never calls an executor, and its status claim makes replay idempotent.

**Closure evidence:**

- `@offgrid/use` typecheck and ESM/CJS/DTS build passed; all 101 package tests passed.
- The shared crash-window test proved one external effect, one persisted terminal fact, and no
  second execution after simulated restart cleanup.
- Desktop Node typecheck passed.
- The real-database Desktop runtime file passed 7/7, including a throwing Pro observer while the
  action still returned `done` and remained queryable from the engine journal.
- The Pro approval lifecycle passed 25/25, including restart reconciliation, zero connector calls,
  idempotent replay, and the exact `proposed -> approved -> executed` audit sequence.
- Focused Desktop and Shared diff checks passed. No broad suite, production build, or package build
  beyond the required `@offgrid/use` package build was run for this closure.

### MOD-002 (P1) - Desktop navigation fixtures use the model-control port - RESOLVED 2026-09-01

`src/renderer/src/__tests__/App.navigation.integration.test.tsx` now supplies one factual
`getModelControlSnapshot` at the Electron boundary. The model, installed IDs, active IDs, active
routes, and available kinds come from that snapshot. The obsolete `getModelCatalog`,
`getInstalledModels`, and `getActiveModelIds` fixtures were removed from these journeys. The active
model assertion is scoped to the visible Model settings dialog, so the catalog card cannot satisfy
it accidentally.

The focused renderer integration file passes all 27 tests. Prettier and `git diff --check` pass for
the changed test and this backlog entry.

---

### CU-014 (P1) - A DOM heuristic could reject a valid visual model action - RESOLVED 2026-08-26

`BrowserDriver.pageState()` now reads only the committed URL and document lifecycle state. It no
longer scans body text or visible DOM elements. `browser-vision-screen.ts` no longer uses text or
element counts to override an approved visual action. It asks for a fresh screenshot only when the
URL changed or the document started loading after capture. Pixel evidence, coordinate validation,
credential safety, and actual execution errors remain at their owning boundaries.

The canvas-only regression passes a committed page through readiness, executes the exact approved
click through the real `BrowserDriver`, and proves that the readiness probe contains no
`querySelectorAll` or `innerText` rule. Four focused files and 58 tests pass. Scoped lint for the
changed browser files has zero errors, the node typecheck passes, and the diff check passes.

### CU-012 (P0) - Live guidance can sync private text without redaction

**Resolved (2026-08-25):** exact guidance and attachment content now stay in the active task's
memory-only queue. Task history and Personal Mesh receive only safe `GUIDANCE ACCEPTED` and
`GUIDANCE APPLIED` lifecycle markers. The task-history write boundary also replaces legacy
`USER GUIDANCE` rows, and startup migration removes old private values from SQLite. Focused unit,
real SQLite migration, Web Use, Vision, AX, and renderer tests prove the original value is absent.

### CU-005 (P1) - The Tasks surface had no maintainable component boundary - RESOLVED 2026-08-25

`WatchedBrowserPane.tsx` is now a 240-line composition owner. History, selected-record detail, live
task state, execution plans, guidance, browser chrome, controls, layout, and selection each have a
focused component or hook under `components/browser/tasks`. The largest file in that surface is 286
lines. Scoped ESLint reports no issue in the task-workspace files. The 70-test focused journey,
typecheck, production build, and real Electron harness passed after the split.

### CU-011 (P1) - Keyboard resizing was announced but did not resize - RESOLVED 2026-08-25

Both task separators now support bounded Arrow Left and Arrow Right changes, announce current values,
and keep their device-local layout. The real Electron harness focuses `Resize Chat and task`, sends
eight Arrow Left events, and asserts a visible width change. The production run changed the Chat width
from 651.56 px to 400.96 px and captured `08-task-keyboard-resized.png`. Focused renderer tests also
cover both directions and bounds.

### CU-006 (P0) - Vision typing had no structural credential boundary - RESOLVED 2026-08-25

The screenshot-only vision executor now checks the focused macOS Accessibility element before any
`typeText` call. The native helper reports only `safe`, `secure`, or `unknown`; it never reads or
returns the field value. A secure target, or content identified from password, PIN, OTP, token, API
key, payment-card, or credential goal context, stops before actuation and asks: `Enter the private
value, then resume`. The handoff does not include the value. Normal text remains available when the
focused editable element is verified safe.

The handoff observation clears the parsed action and does not write the typed value to progress,
task details, SQLite, or sync. The state-sync outbound projector now applies the same step-detail
sanitizer again before encryption. Focused actuation and agent integration tests prove that private
typing never reaches the actuator or durable task projection, while verified ordinary typing still
works. The real SQLite typed-secret test and state-sync wire test cover both durable exits. The
shipped macOS helper was rebuilt with the focused-element inspector.

### CU-001 (P1) - Web Use history collapsed runs by Chat - RESOLVED 2026-08-25

The task projection now keeps one history row per `taskId` while `journeyId` owns the shared browser
workspace. The rendered same-Chat journey test proves both runs remain present and selectable.

### CU-003 (P1) - Esc availability copy contradicted the host - RESOLVED 2026-08-25

The host notice now owns Esc availability on both the floating supervisor and docked task surface.
When registration fails, both surfaces say to use the visible task controls and do not claim Esc
works. Rendered registration-success and registration-failure tests passed in the focused run.

### CU-007 (P1) - Remote synced tasks exposed dead local controls - RESOLVED 2026-08-25

The dock now derives local Computer Use ownership from the live vision task and local Web Use
ownership from its browser session. Remote rows identify the execution device and expose no local
Stop, Pause, or Take Over buttons. Local control failures produce a visible alert. The remote/local
renderer contracts and the 15-test real state-sync suite passed.

### CU-008 (P1) - Task record, live task, and Chat context were ambiguous - RESOLVED 2026-08-25

The two panes now identify `Task record` and `Live task` explicitly, so inspecting historical
evidence cannot be mistaken for controlling that run. Task details include `Return to originating
Chat` from `journeyId`. The renderer contract proves the navigation intent, and the real Electron
harness proves Tasks and the native browser region hide outside Chat and restore when Chat returns.

### CU-010 (P1) - Structured and legacy traces rendered twice - RESOLVED 2026-08-25

Structured Computer Use details now replace the legacy step list. Legacy text renders only when no
structured detail exists. The rendered acceptance case proves the legacy duplicate is absent while
the safe decision, model evidence, mapped action, result, and return-to-Chat action remain available.

### CU-002 (P1) - Hidden model reasoning reached task traces - RESOLVED 2026-08-25

The task-detail sanitizer now removes tagged reasoning and UI-TARS `Thought:` prefaces from both
model output and persisted model input. The focused sanitizer tests include both forms and passed on
2026-08-25. User-visible decision summaries remain separate from the hidden model reasoning.

### DEF-007 (P0) - Secure notes are masked until deliberate reveal/copy - CLOSED 2026-08-09

The Vault service now treats a Secure Note body as secret data: list, add, and update return only its
redacted public projection, while the explicit unlocked `get` operation is the sole read path for the
body. The renderer fetches that value only after the labelled `Reveal` action, shares the existing
secret-field Reveal/Hide/Copy interaction, requires reveal before editing, and clears the revealed
value on Hide, entry change, navigation, lock, window close, and relaunch. KDBX remains the durable
encrypted owner; no renderer-only masking or second secret store was introduced.

**Closure evidence:** `e2e/app159-vault-secret-protection.spec.ts` passed both real Electron journeys
(2/2, 22.9 seconds) through rendered entry creation, default masking, scoped reveal/hide, exact real
OS clipboard copies, locked production-IPC denial, unlock, navigation, and a full Electron relaunch.
The test also proved the KDBX bytes contain none of the fixture plaintext and that the public list
projection omits the secure-note body. Focused vault service and renderer contracts passed 45/45,
including redacted list/add/update and explicit-get behavior. Root and Pro typechecks, the desktop
production build, scoped ESLint, scoped Prettier, and root/Pro diff checks passed; ESLint reported no
errors and 26 pre-existing complexity/file-size/style warnings. A leak scan found no fixture secret
in `test-results`.

The four settled screenshots were inspected in light and dark mode: login/API-key secrets are masked
after unlock, the Secure Note shows a masked Notes row with a deliberate Reveal action, and the same
note is masked again after full relaunch. No plaintext secret is visible, clipped, or stored in the
captured evidence.

### Data-layer / presentation-layer drift sweep (2026-07-09) - CLOSED

Class: the UI kept its own copy of authoritative data instead of binding to the owning source
(hygiene §A). Every TIER-1 item is fixed, behavior-neutral where required, and regression-tested;
the coverage floor held (~97/92/96/98) throughout.

- **T1a. Image composer `imgModel` shadowed the active model** → FIXED. The dropdown's `onChange`
  now writes through the single owner (`MemoryChat.tsx:553` `setActiveModalModel('image', value)`)
  and the composer reads the active value from `imageGenStatus().active` (no latch). Terminal-artifact
  render test: `MemoryChat.image.test.tsx` asserts a dropdown change routes through
  `setActiveModalModel` and reaches the `generateImage` payload.
- **T1b. `imgSteps`/`imgSize` re-seed stomp** → FIXED. Per-model overrides resolved by the pure
  `resolveImageParams`/`setOverride` (`lib/image-params.ts`), persisted via
  `saveSetting('imageParams', …)`; a model change never clobbers a typed value. Render test asserts
  the payload carries the user's steps (10), not the model default (28).
- **T1c. `imgSeed`/`imgNegative`/`imgStrength`/`imgStyle` not persisted** → FIXED. Persisted +
  reloaded through the data layer (`MemoryChat.tsx:314-317, 332-335`). (`imgInit` stays transient -
  a per-turn init-image path, correctly not persisted.)
- **T1d. Image params had no persisted owner** → FIXED (subsumed by T1a–T1c). Image-gen params now
  have a single persisted owner (the settings store); the composer binds to it and writes through.
  A separate Settings > Image editor is optional UX, not a drift bug - descoped, not a gap.
- **T1e. KV cache / FlashAttn / ctxSize two-writer clobber via the mode preset** → FIXED.
  `applyModePreset` (`llm/settings-math.ts`) MERGES - it only fills fields the user has NOT pinned;
  the pinned set (`userExplicit`) is persisted (`llm.ts:194`) and restored on boot (`:125-126`), and
  boot loads the stored `kvCacheType`/`flashAttn` DIRECTLY (never re-derived from the mode), so the
  every-restart re-clobber path is closed too. Tests: `llm/__tests__/settings-merge.test.ts` +
  `kv-launch-roundtrip.test.ts` (persist → restart → launch-args round-trip).
- **T1f. Thinking/reasoning not persisted** → FIXED. Reasoning rides the persisted context blob via
  `buildAssistantContext`/`readReasoning` (`lib/message-persistence.ts`) and is restored on remap.
  Real DB round-trip test: `lib/__tests__/message-persistence.test.ts`.

### TIER 2 (minor / adjacent) - dispositioned

- **Preload `setLlmSettings` type omitted kvCacheType/flashAttn/gpuLayers/threads/batchSize/mode** →
  FIXED (`src/preload/index.ts:244` - the type now carries every field the handler accepts;
  runtime was always passing the whole object, this closes the type-check blind spot).
- **Settings identity fields saved on `blur` only (edit lost if closed without blurring)** → FIXED -
  now also commits on Enter (`Settings.tsx:472-473`), the standard keyboard commit, calling the same
  `saveIdentity`.
- **`ctxSize` halved + persisted by crash recovery (`llm.ts:479-483`)** → BY DESIGN, not a bug. This
  is the deliberate post-crash safety fallback (a too-large KV cache froze macOS on 16GB); it
  intentionally persists a smaller, safe context after a detected crash. Left as-is.
- **VoiceScreen residency toggle fire-and-forget; ActionsScreen prop-resync** → minor UI polish, NOT
  the data-layer drift class (no authoritative copy that diverges). Deferred as cosmetic; would need
  on-device screenshot verification if ever pursued.

### TIER 3 (ephemeral view prefs) - BY DESIGN

ReplayScreen `speed`/`asideW`, ReflectScreen day/week `mode` reset on remount. No authoritative owner
to diverge from - explicitly not the drift class. Persisting them is optional UX, not a gap.

### Reference pattern (correct write-through / refetch-bound)

SettingsPanel (LLM inference controls), ModelPicker (per-modality active model), Projects, Connectors,
ChatDetail, DayView (persisted layout with get + write-back - the good reference), MeetingsScreen,
ReflectScreen, composer chat-prefs (noMemory/tools/connectors/thinking/voice).

### Agentic `generate_image` tool errored (stale keep-alive socket in the tool loop) - CLOSED

**Root cause (verified with in-process DIAG):** the tool loop makes back-to-back requests to
llama-server. Round 0 (`generate_image`) succeeded; round 1's `streamChat` died with `read
ECONNRESET`. Node's global HTTP agent pooled the round-0 socket; llama-server closes its socket after
each response, so the pooled socket was half-closed and round 1's write reset. (The earlier
"modality queue evicts llm mid-loop" hypothesis was DISPROVED - DIAG confirmed the engine stayed
alive; pause was never called.)

**Fix:** every `http.request` to the model uses a fresh connection (`agent: false` +
`Connection: close`); the SSE transport is now one shared `streamCompletion` (`llm/stream.ts`) used
by both `chatStream` and `streamChat`. Regression guards: `__tests__/llm-http-no-keepalive.test.ts`
(reads the source, asserts no keep-alive pool) + `llm/__tests__/stream.test.ts` (a real local SSE
server exercises content/reasoning/tool-calls/abort/timeout). The double intent-decision that could
route "draw …" away from the tool was also closed (`shouldAutoRouteImage` suppresses the renderer
auto-route when the agentic path owns the turn; `image-intent.test.ts` + `MemoryChat.image.test.tsx`
assert tools-ON → `toolChat`, not a direct `generateImage`).

## Deferred from PR #60 review (CodeRabbit)

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

## Deferred from desktop-pro PR #32 review (Gitar)

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

## e2e gate: graduate from advisory → blocking

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

### RESOLVED: a licensed installation this device never paired with became a repair row that could not repair

Fixed in `@offgrid/sync`. Three parts: a row with no local pairing now reports `hasCredential: false`
rather than leaving it absent, so the repair asks for the code instead of promising a reconnection with
nothing to reconnect with; a device with an eviction in flight no longer also gets a saved row; and the
saved pass no longer deletes devices from the discovered map, which is what hid `Pair again` after a
failed eviction. Covered by two new tests in `shared/packages/sync/test/control-center.test.mjs`.

Desktop needed no change of its own: its eviction store already tolerates an empty local side
(`prepareEviction` uses `active?.membershipId ?? ''`) and `runEviction` already surfaces failures. The
mobile host had neither and was fixed there.

Original report follows.

`projectSyncControlCenter` builds its `saved` list by walking the licence registry's installations and
treating a local pairing as enrichment. That is correct for the roster - the licence IS the authority on
which devices belong to the mesh - but it means an installation with NO matching local pairing still
produces a row, and that row lands in `needs_repair` (`control-center.ts`: `!paired || repairIds.has(...)`).

Two consequences, one of them user-visible and already seen on device:

1. **A repair that cannot succeed.** The row offers `membershipRepair.kind === 'reconnect'` -
   "Trying the saved pairing again may be enough" - when there is no saved pairing to try. This is the
   ghost row seen after reinstalling a phone: the phone re-registers under a new sync device id, its old
   installation stays on the licence, and the stale one renders as a device asking to be reconnected.
   The wording is `reconnect` rather than `pair` only because `hasCredential` is absent and absent is
   deliberately read as present (see the comment at the `credentialLost` line) so that a host which does
   not report the field is not accused of having lost every pairing.

2. **It can steal the discovered record from another row.** The `saved` pass calls
   `discoveredById.delete(deviceId)`, so a stale installation consumes the discovery entry before the
   membership-revocation pass looks for it. `revocationPeerDiscovered` is then false and
   `actions.pairAgain` is hidden - meaning a failed eviction cannot be recovered from even while the
   other device is sitting on the network. Demonstrated: with the licence listing the device and a
   `stage: 'failed'` revocation present, `pairAgain` projects as `{visible: false, enabled: false}`.

Note this does NOT arise from a normal eviction. `PersonalMeshDeviceEvictionCoordinator.evict()`
deregisters the installation before it ever contacts the peer, so the seat is released immediately and
the evicted device correctly appears once, in `available`. The trigger is a genuinely stale installation.

Candidate fixes, both deliberately not taken yet:

- Do not emit a `saved` row for an installation with no local pairing (narrow; may hide a real device
  whose pairing this side genuinely lost).
- Have the desktop and mobile hosts report `hasCredential` so the repair correctly says "Pair" and asks
  for the code (touches both hosts, and is the more honest fix).

The test asserts only the revocation row's own retry semantics and states in a comment that the
`saved` count is deliberately unasserted, so this defect is recorded rather than blessed.

### Worth a look: the eviction confirmation promises the peer's licence is cleared

`projectMembershipEvictionConfirmation` adds "Off Grid AI will also remove its saved licence" whenever
the device is connected. That sentence is only earned if the eviction actually reaches the peer, and the
`stage: 'failed'` path exists precisely because it may not. Not a defect in itself - the copy is gated on
an authenticated session, which is the strongest reachability fact available - but the promise is made
before delivery is confirmed, and a failed eviction leaves the user believing something that did not
happen. Flagged for a copy decision, not changed.

### Needs a decision: the Entity Graph screen is gone from the pro renderer, its IPC is not

`entity-graph-renderer.integration.dbtest.ts` asks for `proView('graph', ...)` and gets nothing back:
the route does not exist. The router now knows day, replay, reflect, devices, actions, meetings,
entities, memories, search, notifications, clipboard, voice and vault - no graph. Nothing under
`pro/renderer/` imports `react-force-graph-3d` or calls `getEntityGraph` any more.

Core still carries the whole surface, though: `getEntityGraph` and `rebuildEntityGraph` are in
`src/main/ipc.ts`, `src/main/database.ts` and the preload contract. A feature that was retired on
purpose would normally have taken its IPC with it, which is why this is written down rather than
resolved by deleting the test.

Two readings, and they want opposite actions:

- The graph was deliberately retired and folded into Entities. Then the test should go, and so should
  the three IPC handlers and the preload entries, or they are dead surface area a renderer can still call.
- The screen was lost in a refactor. Then the test is correctly failing and the screen needs restoring.

The test is left red on purpose. Deleting it would remove the only thing still asserting that the graph
services work end to end, and would make the second reading invisible.

### RESOLVED (2 of 3): the pro-tier Devices e2e specs

`e2e/devices-sync.spec.ts` is new on this branch and its `Devices surface — pro tier` describe was red in
BOTH environments, hidden because the desktop CI `E2E (Playwright, xvfb)` step is `continue-on-error`.

**Fixed - `renders the real Devices screen with live sync status`.** It asserted the text `LAN + nearby ready`
and a heading `Personal mesh`. Neither string exists anywhere in `src/`, `pro/` or `shared/packages/`: the
first was never shipped, and the second is now `Licensed devices`. The screen reports itself per ROUTE - one
chip reading `LAN: ready`, or `LAN: <listen>/<advertise>/<browse>` when it is not (`syncRouteDisplay` +
`DevicesScreen.tsx`) - so the spec now asserts that, plus the nearby counter. The screen underneath was fine
the whole time; the spec was failing on its own stale copy.

**Fixed - `sync settings ... expose a toggle per replicated category`.** Passes with the above; it was
inheriting a broken screen state from the spec before it, not failing on its own account.

**Still red - `pairs a real peer and converges projects and chats`.** Two problems, one down:

- The harness constructed `ClipboardSyncCoordinator` without the `deliveryPersistence` its options require, so
  the spec died inside its own setup (`Cannot read properties of undefined (reading 'load')` from
  `loadPendingDeliveries`) before reaching the app. The synthetic peer now has an in-memory delivery store
  beside its history store. FIXED.
- What remains is not a harness defect: pairing now requires an **8-character code** shown on the other
  device ("Enter the 8-character pairing code shown on the other device"), and the synthetic peer neither
  mints one nor presents one the app will accept. `PairingCodeService` lives in
  `shared/packages/sync/src/pairing-code.ts`; wiring it into the synthetic peer is the same job as the
  standing "make pairing work in the test harness" item, so it is tracked there rather than bodged here.

Verified headless: 5 of 6 in that file pass; the pairing one is the single remaining failure.

### The desktop `ci` check hides three advisory steps

`Lint`, `Heavy integration (build/native/port)` and `E2E (Playwright, xvfb)` are all
`continue-on-error: true` in `.github/workflows/ci.yml`, so a green `ci` says nothing about them. On the
last successful run: heavy integration reported **12 failed / 15 passed**, all in macOS packaging and
real-engine files that cannot pass on a Linux runner (`packaged-helpers`, `release-packaging`,
`whisper-cli-build`, `model-server-chat`, `HealthPanel`), and the e2e step failed the macOS-only pro
surfaces (clipboard restore, Vault clipboard copy, dictation) plus `resilience-single-instance`.

The Linux-impossible ones are a platform mismatch rather than rot - but they are being run and reported
as failures on every push, which trains everyone to ignore the step. They should either be excluded by
platform (like `vitest.db.ci.config.ts` does, with the reason recorded per file) or moved to a macOS
runner, so that what remains inside an advisory step is only ever a real signal.

### P1 - the desktop always reports its platform as `macos`, so a Windows node lies about itself

`pro/main/sync/sync-store.ts:318` builds the LOCAL device identity with `platform: 'macos'` hardcoded,
unconditionally, on every OS. Nothing misdetects Windows - the local device never reports its OS at all.
The same literal is hardcoded in three more places: `pro/main/sync/model-transfer-service.ts:105` and
`:414`, and `pro/main/sync/keygen-personal-mesh-registry.ts:163-164`.

**Observed on the lab mesh (2026-08-06).** The Windows 11 ARM guest on .64, renamed
`OGAD x.x.x.64 (Win)`, appears in the macOS node's own LICENSED DEVICES list as `macOS`, and the Android
lists TWO macOS devices when the LAN has exactly one Mac. `DevicePlatform` in
`shared/packages/sync/src/types/index.ts:2` already allows `"windows"`, so this is a missing
`process.platform` map (`darwin`->macos, `win32`->windows, `linux`->linux), not a missing type.

**Why P1 and not a labelling nit - `platform` gates two real decisions:**

- `shared/packages/sync/src/multi-transport.ts:29` treats `platform === "ios" || "macos"` as
  Apple-proximity-capable, so the mesh will attempt an APPLE-ONLY transport route to a Windows box.
- `shared/packages/sync/src/transfer/model.ts:96-104` (`platformTransferBlocker`) refuses a model whose
  `origin` platform differs from `receiverPlatform`, which exists precisely to stop an unrunnable
  transfer. A Windows receiver claiming `macos` DEFEATS that guard: a macOS-only GGUF is allowed to
  transfer to a machine that cannot load it. `model-transfer-service.ts:414` pins
  `receiverPlatform: 'macos'` too, so both sides of that comparison are wrong together.

Not fixed here: this is product code under `pro/`, and this sweep is not authorised to change `src/`.
A fix needs a single platform helper used by all four sites, plus a test that a non-darwin
`process.platform` yields a non-`macos` identity - otherwise the next hardcode reintroduces it.

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

### P1 - the device cap REFUSES at 5 instead of reclaiming, and the seat it counts is the pairing target's own

Observed 2026-08-06, driving the real lab mesh. After activating the Mac's Pro licence
(`08634d13-641c-455d-957b-ad1834c5fb50`, policy `ec95153c`, `maxMachines: null`) on the Android, the
Android's Devices screen reports:

    5 of 5 devices saved
    All slots are in use. Forget a saved device before pairing another.
    0 connected

and pairing with the macOS node on .64 is refused outright. Three separate defects are tangled here.

**1. It refuses where it is documented to reclaim.** The stated behaviour is that a 6th device is
admitted by reclaiming the least attributable seat, never by refusing. This is a flat refusal at 5, with
the remedy pushed onto the user ("Forget a saved device"). Nothing was reclaimed.

**2. The counter and the list disagree, so the remedy is impossible.** The screen says `5 of 5 devices
saved` but renders only TWO saved rows (`fa4d14a6…`, `c375a25b…`). The other three seats are invisible,
so a user told to "forget a saved device before pairing another" cannot forget them - there is no row to
act on. The cap is counting LICENCE MACHINES (Keygen reports exactly 5 on that licence) while the list
renders only locally-saved sync pairings. Two different populations behind one number.

**3. Worst: the target's own seat blocks pairing with the target.** The device being paired with -
the .64 Mac, fingerprint `d0e933934ac1be2b3ecf50ce0d7fbc85` - is ITSELF one of the 5 machines on that
licence. So the Android is refused a pairing with a device that already holds a seat on the Android's own
licence. A seat held by the pairing target cannot sensibly count against admitting that same target;
the cap check needs to exclude the counterparty (and ideally any machine already in the mesh) before
declaring the mesh full.

**Related, same session:** the licence swap silently dropped the working iPhone<->Android pairing. The
iPhone (`9d25c24e…`) is not among the machines on this licence - it is still on the previous one
(`c88a9e27…`) - and its row on the Android reverted from `Connected - LAN` to an unpaired
`sync-pair-9d25c24e…`. A licence change invalidating existing trust may be intended, but it happens with
no warning and no explanation on either screen.

Evidence: Keygen machine roster for the licence (5: one android `6e1c3b71…`, four macos incl.
`fa4d14a6…` which is really the Windows guest per the platform P1 above), against the Android's two
rendered rows.

---

## Sync never re-connects a saved device after the session drops (only after a NEW discovery)

**Status:** open. Found 2026-08-07 while building the four-device e2e flow suite.

**Symptom, seen on two screens at once.** The iPhone `17 pro max` and the Mac `OGAD x.x.x.25 (MacOS)`
are paired, both hold the credential, and each can see the other. The link drops (a phone restart is one
way in). Neither side ever comes back on its own. The Mac sits on `Last connected just now` /
`The device could not be reached.` with a `Reconnect` button, and the iPhone sits on `macos - Nearby`
with its own `Reconnect`. Tapping Reconnect works instantly - so the credential, the address and the
transport are all fine. The only thing missing is anything that decides to retry.

**Cause.** Auto-reconnect is edge-triggered on discovery and nothing else. `Orchestrator.handleFound`
(`shared/packages/sync/src/orchestrator.ts:223`) is the only automatic caller of `engine.reconnect()`,
and it is wired to `discovery.onDeviceFound` (`orchestrator.ts:81`). Two consequences:

1. A peer that is ALREADY in the discovery set produces no new `found` event, so `handleFound` never
   runs again for it. The device is visible and saved and still never retried.
2. A dropped session is a dead end. `onDisconnected` reaches production at
   `desktop/pro/main/sync-ipc.ts:342`, where it only calls `chatStream?.onDisconnected(deviceId)`.
   The orchestrator is never told, so nothing schedules a reconnect.

The state machine heals on the RISING edge of discovery and never on the FALLING edge of a session.
`orchestrator.ts:174` shows the intent was already understood - "until now the user was the retry
mechanism" - but that was fixed for a STALE ADDRESS (`connectSaved`), not for a lost session.

**Why it looks like one bad pair.** It is not. The other four links in the mesh simply have not dropped.
Any link that drops stays dropped in exactly the same way.

**Fix shape.** Make healing level-triggered: on `onDisconnected`, hand the device back to the
orchestrator so a saved peer with a held credential is retried on a backoff for as long as discovery
still sees it. `connectSaved` already does the hard part (re-resolve a stale address, then reconnect);
what is missing is a caller on session loss. Guard with the existing `connecting` set so a flapping link
cannot stack retries.

**Consequence for the e2e suite.** Flow 2 ("reconnect a dropped saved device with the held credential,
no code") passes only because the flow TAPS Reconnect. The unattended behaviour a user actually relies
on - it comes back by itself - is untested and currently absent. Worth its own flow once fixed.

---

## Disconnecting a device leaves BOTH sides saying "Needs repair", and it never clears

**Status:** open. Found 2026-08-07 driving the four-device e2e suite.

**Symptom.** Press the `x` (disconnect) on a connected peer - a deliberate, non-destructive action that
is supposed to close the session and keep the credential. Both devices then show the other as
`Needs repair`, with the description "The other device did not recognise this one." Nothing failed to
recognise anything: the user pressed disconnect. Both sides still hold their credentials
(`sync-paired-<id>`, offering repair rather than pair), so the accusation is not even true.

Observed on OnePlus Nord 5 <-> 17 pro max. After the disconnect, BOTH rows read `Needs repair`.

**It does not heal.** The peer was made discoverable again and a full rescan run; 90 seconds later
both rows still read `Needs repair`. Only a manual repair tap clears it.

**Cause.** `needs_repair` has exactly one source - `syncRuntimeCallbacks.ts:185`:

    onPairingFailed: (remote, error) => {
      if (remote && error === 'unknown_device') {
        pairingSecretStore.markNeedsRepair(remote)

So a single `unknown_device` answer is taken as fact. `pairingSecretStore.markNeedsRepair` documents
the very false positive this hits - "a peer that is restarting, or whose pairing store has not
finished loading, answers exactly the same way" - and keeps the secret for that reason, but the STATE
is still set from one unanswered handshake, and nothing later re-tests it.

`control-center.ts:298` then makes it stick to the top of the priority list: `needs_repair` beats
`available`, so the row keeps the warning even once the peer is discovered again and reachable.

**Why it matters.** This is the ordinary path - disconnect and reconnect later is what the control is
FOR. A user who uses it once is left with two devices showing a red warning triangle and an
instruction to repair a pairing that was never broken.

**Fixed, in part (2026-08-07).** A disconnect the user asked for no longer enters this path.
`onDisconnected` already consulted `manuallyDisconnected` to present the row as
available-and-disconnected; a handshake refusal arriving afterwards overwrote that. `onPairingFailed`
now consults the same set and leaves the pairing alone. That is the whole of the reported symptom.

**Still open: one `unknown_device` is still taken as a verdict when the disconnect was NOT deliberate.**
Requiring two consecutive refusals was tried and reverted, because nothing retries after a refusal: a
pairing failure is not a disconnect, so no heal is scheduled, the second answer never arrives, and a
peer that has genuinely forgotten this device would sit silent instead of asking for a repair. Trading
a false accusation for silence is the worse bug, and `syncPersistence.integration.test.ts`
("repairs one-sided trust") catches exactly that.

So corroboration needs a RETRY before it can be safe: on the first refusal, re-attempt the reconnect
with the held credential and decide on the second answer. The orchestrator already knows how to retry
on a backoff (`connectSaved`, added the same day for dropped sessions); what is missing is entering it
from a refused handshake rather than only from a lost session.

---

## macOS: a CONNECTED device offers no actions at all

**Status:** open. Found 2026-08-07 while driving the model-transfer flow by hand.

**Symptom.** On the Mac's Devices screen, every connected peer card carries ZERO controls. Enumerated
live from the DOM:

    CARD: 17 pro max            ->  buttons: NONE
    CARD: OnePlus Nord 5        ->  buttons: NONE
    CARD: OGAD x.x.x.26 (Win)   ->  buttons: NONE
    CARD: Off Grid AI Desktop   ->  buttons: Pair        (unpaired - this one has a control)
    CARD: OGAD x.x.x.25 (MacOS) ->  buttons: NONE

So on macOS a user cannot send a model, disconnect, forget or rename a device they are connected to.
The only cards with controls are the ones NOT connected: unpaired shows `Pair`, saved-but-away shows
`Reconnect` / `Evict`. Being connected removes every action.

Both phones offer all four on every row - `sync-rename-<id>`, `sync-disconnect-<id>`,
`sync-send-model-<id>`, `sync-forget-<id>` - so this is a desktop gap, not a product decision.

**Consequence.** Flow 12 (send a model, with progress on both sides) cannot be driven from the Mac at
all. Model transfer desktop -> phone is unreachable through the UI.

---

## macOS: the "N/5 licensed devices" chip is a button that goes nowhere

**Status:** open. Found 2026-08-07, same session.

`4/5 licensed devices` on the Devices header is a real `<button>`, so it invites a click. Clicking it
leaves the screen unchanged - no panel, no navigation, no roster. A user looking for which devices are
on their licence (the thing they need before evicting one to free a seat) finds a control that does
nothing.

Either it lists the licensed installations, or it is not a button.

---

## Harness: there is NO passive way to observe an iPhone through WDA

**Status:** open, harness limitation. Learned the hard way 2026-08-07, twice in one session.

Every read of the iOS app goes through a WebDriverAgent session, and creating one is not an
observation - it changes the device:

- `session(bundleId)` LAUNCHES/ACTIVATES that bundle, terminating whatever it was doing. This killed a
  706 MB model transfer that was mid-receive: the snapshot tool called it "read-only by design" while
  relaunching the app it was recording.
- `session()` with no bundle id was the attempted fix. It does not launch the app under test, but it
  still appears to deactivate the FOREGROUND app - a read taken while the user had the app open
  returned the SpringBoard home screen instead.

So `passive: true` on the iOS surface is weaker than its name promises: it will not relaunch the app,
but it cannot be trusted not to disturb what the user is doing.

**Rules that follow, until something better exists:**

1. Never read an iPhone while a person is driving it or a transfer is in flight. Ask them for a
   screenshot instead - it is the only genuinely zero-cost observation.
2. Automated iOS flows are fine, because there the harness IS the driver and nothing else is going on.
3. Android does not have this problem to the same degree: `adb shell uiautomator dump` reads the tree
   without touching the app, and only `session()`'s `monkey` launch foregrounds it, which `passive`
   now skips.

**Worth investigating:** whether an iOS read can be taken outside WDA entirely - the app could expose
its own state over a dev-only local endpoint, which the harness reads without going near the UI. That
would make observation free on every platform and is probably the right long-term answer for a suite
that has to watch journeys it is not driving.

---

## Model transfer: the sender says "sent", the receiver says "could not receive"

**Status:** partially fixed 2026-08-07. Found by looking at both screens during a real macOS -> iOS send.

**Symptom.** The Mac reported the model sent successfully. The iPhone reported the same transfer as
"could not receive / interrupted". Both screens were honest about their own side, and the user has no
way to know which to believe.

**Cause.** The sender decided completion from its own loop:

    await this.sendPackage({ ... })
    modelTransferJobs.update(job.id, { phase: 'completed' })   // unconditional

`advanceJob` already receives the receiver's status and maps `failed` onto the job - but the loop runs
afterwards and overwrote it. The reason completion lives in the loop is sound (a per-file `completed`
would end a two-file vision package after its primary), but it made the sender's "I pushed the bytes"
outrank the receiver's "they did not arrive".

**Fixed:** the loop no longer marks a job completed if it is already `failed`.

**Still open, and bigger:** "completed" on the sender still means _bytes pushed_, not _peer verified_.
The picker promises otherwise - "the receiving device verifies the complete model before it appears in
Models" - so the sender should wait for a receiver-side completion signal, and show something like
"sent, awaiting verification" until it arrives. Guarding against an already-failed job closes the
contradiction we saw; it does not make the sender's success mean what the copy says.

---

## A model package that fails midway leaves a working-looking text model

**Status:** open. Same session, same transfer.

A vision package is two files sent in order: `Qwen3.5-0.8B-Q4_K_M.gguf` (508 MB) then
`mmproj-Qwen3.5-0.8B-BF16.gguf` (198 MB). The transfer interrupted between them. The result on the
receiver:

- the primary is on disk, complete, and registered as a MODEL
- the projector never arrived, so nothing links one
- the model therefore presents as a plain text model, 508 MB, and loads happily
- Activity, on another screen, says the transfer failed

So a failed vision transfer silently produces a model that works and cannot see, and the only hint is
a failure notice somewhere else. A user who does not cross-check believes they have the model.

Package install needs to be atomic, or explicitly incomplete: either resume the missing file, or
present the model as needing repair (the vision-repair path already exists for a missing projector and
would fit exactly), or discard the partial package. What it must not do is register half a package as
a whole model of a different kind.

**Related and also open:** whether the interrupted projector left a partial file behind. That is flow
15 ("a failed receive discards the partial file"), still unverified.

---

## macOS Activity reports FILES, so a half-sent package reads as success

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

---

## MTP is a mobile feature, and it should be a `@offgrid/models` one

**Status:** open. Filed 2026-08-12. Deliberately NOT in the current PR - it is a package extraction,
not a fix, and folding it in would bloat a release branch that is about sync feedback.

**The gap.** MTP support exists on mobile and does not exist on desktop. Both apps consume the same
model layer, so a capability that lives in one app's screens is a rule with one home and two
audiences - the shape this repo keeps finding at the root of its bugs.

**Why it is a shared-package problem, not a desktop one.** Copying the mobile implementation across
would make it a rule with TWO homes, which is worse than having it once. The model layer is the owner:
whether a model needs MTP, which artefacts it implies, and how a device advertises support are all
properties of the MODEL, and every surface should be asking `@offgrid/models` rather than each app
deciding for itself. Desktop then gets it by consuming the package, and so does any future surface.

**Fix shape.**

1. Move the MTP capability rule into `shared/packages/models` - one definition of what MTP is and which
   models require it, keyed off the catalog entry, with no app-specific branching inside it.
2. Mobile stops deciding and starts asking. Its current behaviour is the reference for what the rule
   must produce, so it is the regression check that the extraction changed nothing.
3. Desktop consumes the same rule. No `if (platform)` in either app: a platform that cannot serve MTP
   reports that through the same interface, it does not get a special case at the call site.

**Watch for:** the mobile implementation almost certainly carries assumptions that are really about the
phone runtime rather than about MTP. Those belong on the platform adapter, not in the shared rule - and
the tell is any code in the extracted package that names a platform.

---

## Every non-image attachment syncs to desktop as "text" and previews blank

**Verdict:** fix-the-guard — the kinds exist, the write path never uses them.

Reproduced on hardware 16 Aug 2026: a message sent from iPhone with three attachments (a camera
photo, a library screenshot and `mobile.pdf`). On desktop the PDF arrives as a chip reading

```
mobile.pdf   text
```

and opening it shows an empty viewer with only Download and Close - nothing renders. Android shows
the same message correctly, because it has its own renderer.

The attachment type already names the kinds:

```ts
kind: 'text' | 'pdf' | 'docx' | 'image' | 'audio' | 'video'
```

but the write path in `src/renderer/src/components/MemoryChat.tsx` (~2940) only ever chooses between
two of them:

```ts
if (isImage) { kind: 'image', code: a.path }
else if (a.text) { kind: 'text', code: a.text }
```

A PDF has no image path, so it falls through to `text` and renders `a.text` - which for a binary
document is empty. Hence a labelled-but-blank preview rather than an error.

**This is not PDF-specific.** Any non-image attachment takes the same branch. It was predicted from
the v0.0.103 diff for VOICE NOTES - "Mac classifies any non-image as kind: 'text', so a .wav arrives
as a paperclip chip labelled text, and clicking it opens a blank viewer" - and never reproduced until
now. A PDF and a voice note are the same bug.

**Why it matters:** the attachment did sync. The bytes are there (Download works). What is broken is
the classification and therefore the rendering, so the user sees a file they cannot open and
concludes the transfer failed.

**Fix:** classify by MIME/extension into the kinds the union already declares, carry `path` for
binary kinds rather than `text`, and render a PDF/document viewer for them. `src/main/mime.ts`
already exists and is the obvious source of truth.

---

## Model transfer can use more of a fast local network

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

---

## Desktop voice modes need the final physical audio pass

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

---

## Personal Mesh visibility and Google OAuth need installed passes

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

---

## Remote task approval and live-frame sync need lifecycle closure

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

---

## Release 107 exact-operation Sync needs final Desktop owner and restart proof

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

---

## Release 107 Computer Use PiP needs final installed visual proof

**Status:** Code and Wired gates pass; Built and Live verified gates are open. Filed 2026-08-29.

Release 107 uses the task pane as the Computer Use interface. The hidden native window exists only
to provide the exact ScreenCaptureKit exclusion ID. Its creation path does not show the PiP. The task
pane has no Open PiP action, and the in-app floating task view selects only Web Use.

Keep this gap open until the final Desktop build passes and one installed macOS Computer Use journey
confirms that no Computer Use PiP appears before, during, or after the task. Also confirm that the
task pane still shows the live frame, current step, controls, guidance, and terminal replay.

---

## Release 107 QR panel and sidebar parity need final Desktop proof

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

---

## PR #84 Dependency Cruiser reported a Playwright task cycle

**Status:** resolved by the type-contract split below on 2026-08-30; final build and live verification
are pending.

Dependency Cruiser failed on this import path:

```text
browser-playwright-task-support.ts
  -> browser-playwright-task.ts
  -> browser-playwright-task-support.ts
```

The support module imported task input and result types from the task implementation. The task
implementation imported the support functions. `browser-playwright-task-contract.ts` now owns the
task input, result, and semantic observation contracts. The task implementation keeps type re-exports
for existing consumers. The support and semantic evidence modules import the type-only contract
directly. Runtime behavior did not change.

Local evidence on commit `bcb86a09675cca8a60da68ff2afb571510454b9f` plus this directed fix:

1. Focused Dependency Cruiser: 107 modules and 206 dependencies, 0 violations.
2. Full Dependency Cruiser: 1,011 modules and 2,808 dependencies, 0 errors. The two existing orphan
   warnings remain for `computer-use-frame-pointer.ts` and `MessageNudge.tsx`.
3. Node and web TypeScript checks: pass.
4. Web Use lifecycle and semantic evidence tests: 2 files, 7 tests, all pass.

---

## Tool-owned image generation has no Run anyway when memory admission fails

**Status:** open, found 2026-09-02 by the chat-memory E2E on a loaded Mac.

When a Chat turn asks a tool to generate an image and the shared residency rule refuses the image
model for lack of free memory, the turn renders "Work failed 1 step" and stops. The direct image
path offers "Run anyway" on the failed message (`MemoryChat.tsx`, `imageMemoryRetry`); the
tool-owned path does not, so a person has no way forward except freeing memory or picking a smaller
model elsewhere. One owner for the override affordance is needed so both paths behave the same.

Evidence: desktop E2E runs 6 and 7 on 2026-09-02, `imagegen:generate` failed with
`OFFGRID_IMAGE_MEMORY_LIMIT` and the page showed only the failed step. The journey now skips with the
host's free-memory figure when admission would fail (`e2e/helpers/memory.ts`), so the fail-closed
behaviour is not reported as a regression while this gap is open.

## rag:chat swallows generation failures into a fake answer (open, 2026-09-02)

`src/main/ipc.ts` memory-RAG branch catches every error and returns "Sorry, I could not generate a
response right now." as if the model had said it. Only the context-overflow case is rethrown now so
the shared session can compact and continue. Every other failure still reaches the user as a bubble
that looks like an answer, is persisted as one, and never reaches the shared failure path. Fix:
rethrow; let the renderer's existing error path render and persist it as an error.

## Chat transcript: one turn's tool work renders as N "Work done" headers (open, 2026-09-02)

Live, a turn's steps sit under one "Working" header. Once persisted, every tool round is its own
"Work done · 1 step" card with a "Thought process" row between - a 12-step task reads as 12 cards.
The coalescing rule (`MemoryChat.tsx` ~5721) only merges ADJACENT tool rows, so a reasoning-only
assistant row between two tool rows splits the run. Fix: group a turn's rows (tool rows and
prose-less assistant rows) into one timeline, thought processes as steps inside it.

## Chat transcript: two "Thought process" looks, two gaps (open, 2026-09-02)

The thought-process toggle renders with a framed surface in one place and bare in another, and the
vertical gap between rows differs. Keep the bare look and the smaller gap everywhere.

## Task PiP: drag works only from the top half of the header (open, 2026-09-02)

Holding the lower part of the PiP header does not start a drag. The drag handle region must be the
whole header.

## Stopped task: no acknowledgement in chat; panel says "Could not stop this task on this device." (open, 2026-09-02)

The user stopped a web-use task; the task record went STOPPED but the live panel reports it could
not stop, and the chat turn shows no "stopped" marker. Stop must be acknowledged on both surfaces.
