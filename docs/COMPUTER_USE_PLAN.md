# The proactive assistant - build plan and timeline

Companion to `COMPUTER_USE.md` (the product model), `ASSISTANT_ARCHITECTURE.md` (the system design), and `PORTING_MAP.md` (the port-vs-bespoke research).

> **This is the doc to build from.** Work release by release, top to bottom: a release is not done until its checkpoint passes, and the next release does not start until it does. The other three docs are references. Adjust the plan here at each checkpoint; never fork a second plan.

**Re-cut (August 14, 2026 - the lead's steer + R1 field feedback).** The release after R1 is **all four rails, chat-driven, on both platforms**, plus the approval UX rebuild the R1 pro-path test demanded. The reasoning engine (proactive) and routines move after it. R1 itself is done: 17/19 checklist boxes, both PRs open and green (OGAD #81, shared #4).

**Standing assumptions**

- Solo developer, AI authoring the code end to end.
- Release-led: each release is a real, demoable, shippable increment. Desktop = macOS + Windows.
- **Port the plumbing, build the product** - each release names its ports (all MIT / Apache-2.0 / BSD, all in-process); the full map is `PORTING_MAP.md`.
- **Offline scope, stated precisely.** The brain runs with zero network on every platform. An action whose effect lives on an external service needs that service reachable at execution time - so the rails prefer local apps whose writes land locally and sync later (EventKit / Mail on macOS, local Outlook on Windows), and online-only actions are labeled honestly.
- **Reliability rules the router must honor** (architecture doc, Section 4): effect-verification lives in the engine; a cross-rail escalation is a re-fire under the same retry policy - a non-retryable action never escalates. The DeviceController routing is a thin layer over these.
- Checkpoint discipline: a checkpoint is a verifiable, demoable milestone.

## Build guidelines (standing, all releases)

- **Design** - `off-grid-ai/brand` `DESIGN_PHILOSOPHY.md`: brutalist/terminal, Menlo, emerald-only accent, black/white base, hierarchy by size and weight not color, no gradients, no emojis. All values from `@offgrid/design` tokens. Desktop density per `docs/DESIGN.md`.
- **Copy** - `off-grid-ai/brand` `brand_tone_voice.md` + outcomes-first: no em dashes, no curly quotes, no exclamation marks, banned-word list applies.
- **Cross-platform from the seam.** Callers depend on the `DeviceController` port and the shared engine, never on a concrete OS.
- **Port before writing.** Check `PORTING_MAP.md` / `COMPUTER_USE.md` Section 9 first; verify the license at the point of adoption; honor the AGPL / source-available avoid-list.

## Releases

| Release | What ships | Status |
| --- | --- | --- |
| **R1. Chat actions on the durable engine** | The semantic rail in chat on macOS (reminders, calendar, messages, mail, open, lookups) through the `@offgrid/use` engine: durable queue, payload-hash gate, retry-once-with-verify, read-back verification, effect journal. Windows toolchain green (installer artifact); the Windows semantic rail (local Outlook COM) built behind the port. | **Done.** PRs: OGAD #81, shared #4. Record: `R1_CHECKLIST.md` |
| **R2. Full rails in chat, both platforms + Approval UX v2** | Windows chat exposure; the browser rail (watched web tasks, takeover at login); the vision rail (supervised GUI actions, UI-TARS-1.5-7B); the approval experience rebuilt (inline in chat, outcome feedback, risk-tiered auto-run); the safety pass. ~5-6 working days. | **next** |
| **R3. Notices you** (was R2) | Reasoning + resolve + gate: commitment/gap detection over Replay, memory-resolved slots with confidence, the proactive Day surface. Cross-platform (memory + LLM). Pro-side code lands in desktop-pro (access in place). ~3 days. | after R2 |
| **R4. Routines** (was R3) | Record-by-showing + self-healing, per-step-verified replay (OpenAdapt design). macOS-first; the Windows UIA adapter as the fast-follow (napi-rs over the `uiautomation` crate + SendInput, Terminator head-start). ~2-3 days + fast-follow. | after R3 |

The split: `shared` holds the durable cross-platform brain (`@offgrid/use`, reused by mobile later); this repo holds the rails, surfaces, and product integration; pro business logic lands in `desktop-pro`.

## R1 - chat actions on the durable engine (DONE)

Shipped scope, guarantees, and evidence live in `R1_CHECKLIST.md` and the PR bodies. Merge order: **shared #4 before OGAD #81** (main's CI resolves `@offgrid/use` from shared main). The release DISPATCH waits for R2 per the re-cut - one versioned release ships both.

**R1 field verdicts driving R2** (from the pro-path smoke test):

- Approving a card gives no completion feedback - the chat message says "pending" forever and nothing reports the run. (The engine path already reports verified outcomes; the legacy pro path is the old system.)
- Reversible simple actions (a reminder) should not need a human gate at all.
- Chat-originated approvals belong INLINE in the conversation, not on a separate screen; the Actions screen's job is unattended actions (proactive, scheduled) plus the audit log.

## R2 - full rails in chat, both platforms + Approval UX v2 (~5-6 days)

Everything chat-drivable on both OSes, honestly tiered, with an approval experience that reads like a conversation instead of a queue.

### A. Windows chat exposure (~1 day)

- Per-platform tool specs: win32 exposes the engine-routed set the Outlook rail supports (calendar_create_event, reminders_create, mail_send, open_url); reads stay macOS-only until the Outlook read verbs land.
- A win32 inline runner for open/navigate; the engine path handles mutations end to end (the rail shipped in R1).
- Outlook read-back verifiers (list verbs mirroring the mac ones) so Windows gets verified outcomes too.

### B. Approval UX v2 (~1-1.5 days, core + desktop-pro)

- **Inline approval card in chat**: resolved values + Approve / Edit / Reject in the conversation flow, driven by the engine gate (`resolveActionGate`). The Actions screen remains the queue for unattended actions plus the audit log.
- **Outcome feedback everywhere**: approve -> the engine executes -> the verified result lands back in the chat turn and on the card ("Created - verified", or the honest failure). This is the pro approval-executor migration: pro's queue resolves the engine gate instead of running its own executor, so payload binding and verification hold on the pro path too.
- **Risk-tiered gating** (decision 8.3's lean, now policy): reads/navigate free; reversible mutations (reminder, calendar) auto-run with a verified confirmation and an Undo affordance; sends and irreversible actions keep the gate.

### C. The browser rail (~1.5-2 days) - cross-platform on arrival

- Embedded pane over Electron's `webContents.debugger` (raw CDP): **nanobrowser's** TS dom module + overlay as starting code, **browser-use's** snapshot + AX-merge + numeric-index as the algorithm, **Stagehand's** act/observe/extract + Zod as the API.
- Chat-drivable web tasks (check-in, ordering) - watched live, takeover at any login/identity step, gated at the identity boundary.

### D. The vision rail (~1.5-2 days) - the supervised tier, labeled so

- **UI-TARS-1.5-7B** catalog entry (Apache-2.0, GGUF + mmproj published; a ~5GB download via the Models screen); **OmniParser v3** (MIT) set-of-marks fallback for the bundled model.
- The operator spine from **@ui-tars/sdk** (nut.js swapped for **@nut-tree-fork**/robotjs); mac input via CGEvent, Windows via SendInput.
- Supervised UX: the ScreenMarker-style overlay, pause-on-user-input, the kill switch (Esc halts with the keypress consumed).
- The WhatsApp file-share recipe as the showcase (behind the gate).

### E. Safety pass + the release

- Injection-resistance review (screen content is untrusted input), kill-switch e2e, per-rail verification depth honored, release-readiness checklist.
- **Checkpoint / release dispatch:** on macOS AND Windows - a semantic action, a watched web task with takeover, and a supervised vision action all run from chat, gated by tier, with verified outcomes reported inline. One versioned release: the signed/notarized .dmg + the Windows NSIS .exe (unsigned until the cert - decision open with the lead).

**R2 risks:** the vision tier on a 7B local grounder is best-effort - ship it labeled supervised or not at all; Windows browser/vision needs a human on a real Windows machine (CI proves builds, not clicks); the model download adds a Models-screen surface; Approval UX v2 touches the live chat surface (the R1 lesson stands - behavior tests per branch, the plain path untouched for non-action turns).

## R3 - notices you (was R2, ~3 days)

Scope unchanged: commitment and gap detection over the Replay observation + entity spine; the resolve layer (RAG over memory returning value + confidence); proposals surfacing on the Day feed and executing through the same engine and inline approval UX. Ports: sqlite-vec (inside the app DB), LlamaIndex.TS memory blocks, Mem0's dedup loop, Orama hybrid ranking; techniques: HippoRAG PageRank, bi-temporal facts, the WSDM commitment rubric. Pro-side code (reasoning, resolve policy, feed UI) lands in desktop-pro. Checkpoint: on a seeded profile, on both OSes, an un-actioned commitment surfaces and "send the deck I promised" resolves from context and runs, gated by tier.

## R4 - routines (was R3, ~2-3 days + the Windows fast-follow)

Record-by-showing + faithful replay per the OpenAdapt design (compiled-step schema, resolution ladder, postconditions, repair-as-diff); Playwright codegen for the browser lane; memory-resolved variable slots; the plain-language review UI. macOS AX-as-eyes with actuation capped at press/set-value; the Windows UIA adapter (reader + SendInput) as the fast-follow. Checkpoint: record a routine once; it replays per-step-verified with a slot resolved from memory at run time.

## Dependencies

| What | Needed by | Note |
| --- | --- | --- |
| shared #4 merged before OGAD #81 | now | main's CI resolves `@offgrid/use` from shared main |
| Windows signing cert | R2 release | wiring exists (WIN_CSC_LINK secrets); publishes unsigned until then |
| A human on a real Windows machine | R2 | browser/vision click-through + the model-load smoke (`WINDOWS_TEST_PLAN.md`) |
| UI-TARS-1.5-7B GGUF + mmproj catalog entry | R2-D | the vision model install |
| desktop-pro access | R2-B, R3 | in place (cloned at pro/) |
| Seeded memory fixtures | R3 | detection + resolution tests without a live profile |
| OpenAdapt trace/replay port + the `axuielement` napi addon | R4 | the recorder + the mac AX read |

## Risks

| Risk | Mitigation |
| --- | --- |
| Vision reliability (the frontier ceiling) on a local 7B | supervised tier, labeled; cheapest-rail-first routing; set-of-marks fallback; the gate on everything consequential |
| Approval UX v2 touches the live chat surface | behavior tests per branch; the plain path stays untouched for non-action turns |
| The Windows human-testing gap | recorded dependency; release notes honest about machine-verified vs human-verified |
| Solo schedule | releases independently valuable; scope trims at the tail (the vision showcase, Windows polish), never the shipped core |

## Out of scope (unchanged)

The mobile adapter (post-v1: Appium/WebdriverIO + DroidRun Portal + GUI-Owl-1.5/Qwen3-VL), background/headless autonomous runs, store distribution.

## Tracking

- R1 record: `R1_CHECKLIST.md`. R2 gets its own checklist when it starts.
- Small commits per verified unit, merge not squash. PR evidence rules apply.
- Checkpoint review against this doc at each release; plan changes are edits here.
