# Computer use - build plan and timeline

Companion to `COMPUTER_USE.md` (the approach). This doc is the execution plan: phases, dated milestones, checkpoints, dependencies, risks. It is the source of truth for schedule - adjust the dates here at the weekly checkpoint, do not fork a second plan.

**Assumptions**

- Solo developer (Siddharth), with AI doing the code authoring end to end. Durations are therefore paced by what does NOT compress: review, on-device verification, TCC permission flows, packaged-build checks, and iteration against real apps. Code-heavy phases are scheduled aggressively; integration-heavy phases keep slack.
- Dates start Wednesday, August 12, 2026 and assume this is the main focus. If a week goes elsewhere, shift the dates here - the phase order and checkpoints do not change.
- Checkpoint discipline from the shared roadmap applies: a checkpoint is a verifiable, demoable milestone; the next phase does not start until it passes.
- **Vision model:** GUI-Owl-1.5-8B-Instruct (MIT) is the working default; Qwen3-VL-8B (Apache-2.0) is the alternate. Both are Qwen3-VL-architecture models, so every line of engine and adapter work is identical for either - the pick is a catalog decision made at install time (phase 3) and is not on the critical path before that.

## Timeline at a glance

| Phase | Dates | Length | Checkpoint (demoable) |
| --- | --- | --- | --- |
| 0. Foundations | Aug 12 - Aug 14 | 3 days | approval seam widened with risk classes; entitlements land; decisions locked |
| 1. Semantic rail | Aug 17 - Aug 26 | 1.5 wk | "create a calendar event Thursday 3pm" end to end, approval-gated, bundled model |
| 2. `@offgrid/use` engine | Aug 27 - Sep 9 | 2 wk | engine suite green against a scripted fake device |
| 3. Desktop adapter + vision | Sep 10 - Sep 29 | 3 wk | multi-step GUI task on a native app, verified per step, live step view |
| 4. Hard targets + hardening | Sep 30 - Oct 14 | 2 wk | WhatsApp album task supervised end to end; safety checklist passes |

Nine weeks total. Phase 1 is independently shippable - calendar, messages, mail, photos, reminders actions with approvals deliver user value on Aug 26 regardless of what follows. Where the compression came from: the engine phase is pure TypeScript against a fake device (ideal AI-authoring territory, 4 wk to 2 wk); the semantic rail is many small similar wrappers (3 wk to 1.5 wk). Phase 3 keeps the most slack because it mixes Swift interop, a model install, and real-device iteration; phase 4 is paced by WhatsApp itself, not by code.

## Phase 0 - foundations (Aug 12 - Aug 14)

| Work item | Detail | Verification |
| --- | --- | --- |
| Lock decisions | v1 graph roles (proposed: Planner / Cortex / Executor / Reflector, add Orchestrator + Summarizer when task length demands), package name (`@offgrid/use`), approval UX (proposed: plan-level approval + live step view + per-step gates on irreversible actions) | recorded in `COMPUTER_USE.md` section 8 |
| Widen the approval seam | `mcp:proposeApproval` becomes transport-agnostic `actions:proposeApproval` carrying `{kind, title, detail, risk, args, source}`; per-executor `riskOf(name, args)` replaces the name regex; MCP extension migrates onto it | existing approval tests stay green (`mcp-connector-tool-extension.dbtest.ts`); new tests per risk class; pro executor updated in `desktop-pro`, submodule bumped |
| Packaging groundwork | `com.apple.security.automation.apple-events` entitlement + `NSAppleEventsUsageDescription` + Calendars/Contacts/Photos usage keys in the electron-builder config | local packaged build per `local-build.local.md`; TCC prompts name the app |
| Permission onboarding design | sequence of grants (Accessibility held check exists, Automation per target, per-framework) behind an explicit "enable computer actions" flow | design reviewed; no dead-end states |

## Phase 1 - semantic rail (Aug 17 - Aug 26)

- **Aug 17 - 19:** `actions` Swift helper skeleton (JSON over stdio, same `execFile` pattern as `src/main/ocr.ts`); EventKit create/read events + reminders; Contacts read. Unit tests on the Node wrapper; helper built alongside the existing Swift helpers.
- **Aug 20 - 21:** AppleScript surfaces - Messages send, Mail compose, Notes create/search, Finder basics; URL-scheme opener; `open -b` app launcher; `shortcuts run` wrapper with timeout guards (a prompting shortcut hangs the CLI - wrap every call).
- **Aug 24 - 26:** expose everything as tools through the `ToolExtension` seam with risk classes; approval-gated writes; audit entries; permission onboarding wired. Tests: unit per risk class and arg mapping, integration on a temp profile, e2e smoke asserting the approval queue renders the new action kinds.

**Checkpoint (Aug 26):** calendar event created end to end from chat with the bundled model, gated, audited. Messages send queues for approval and executes on approve.

## Phase 2 - `@offgrid/use` engine in shared (Aug 27 - Sep 9)

All work in `off-grid-ai/shared`; testable with zero macOS dependencies - the phase where AI authoring compresses the most.

- **Aug 27 - 31:** package scaffold; `DeviceController` interface (`getState()`, `act(action)`, `openIntent(url)`, `listSemanticSurfaces()`); closed action schema + structured decision types; fake `DeviceController` with scripted scenarios.
- **Sep 1 - 4:** graph v1 - Planner (subgoal decomposition), Cortex (one structured decision per step from tree + screenshot), Executor (deterministic parse, no free-form reasoning); the router (deterministic surface - structured UI - vision).
- **Sep 7 - 9:** Reflector (SUCCESS/FAILURE per transition with diagnosis), deterministic post-validation for typing (act, re-read, diff - minitap's +7 pt mechanism), cycle detection with forced strategy change (+9 pt mechanism); per-role model config against an OpenAI-compatible endpoint (our gateway); risk + approval callback seam; suite hardening; package docs.

**Checkpoint (Sep 9):** suite green on the fake device, including a type-verify scenario (field readback mismatch triggers retry) and a loop-escape scenario (repeated state triggers strategy change).

## Phase 3 - desktop adapter + vision fallback (Sep 10 - Sep 29)

Keeps the most slack: Swift interop, a model install, and real-device iteration all live here.

- **Sep 10 - 15:** Swift helper act primitives - `AXUIElementPerformAction`, set-`AXValue`, `AXManualAccessibility` wake, `CGEvent` post; coordinate mapping (AX points vs screenshot pixels, `backingScaleFactor` per display, multi-display origins).
- **Sep 16 - 21:** AX tree serialization (indexed interactive elements + bounding boxes, drop unlabeled wrappers, diffs after actions); window-scoped capture via `src/main/vision.ts`; OCR helper emits `{text, bbox}`.
- **Sep 22 - 24:** model catalog entries (GUI-Owl-1.5-8B-Instruct GGUF + mmproj; Qwen3-VL-8B alternate) - **model install happens here**; Cortex/Reflector wired through the gateway; agent runs at modality-queue tier 2.
- **Sep 25 - 29:** supervised run UI - live step view, hold-to-stop, per-step approvals for irreversible actions; e2e with screenshots; small eval harness (macOSWorld subset) as a sanity gate, not CI-blocking.

**Checkpoint (Sep 29):** a multi-step GUI task on a well-behaved native app (for example: create and reschedule a reminder through the Reminders UI) completes with per-step verification visible in the run view.

## Phase 4 - hard targets + hardening (Sep 30 - Oct 14)

Paced by iteration against real apps, not by code volume.

- **Sep 30 - Oct 2:** Electron AX wake flows; secure-input detection surfaced in System Health; app allowlist setting.
- **Oct 5 - 9:** the WhatsApp acceptance case - `whatsapp://` intent open, keyboard-first navigation, vision-grounded clicks for the gaps, photo ranking by the vision model, send behind the gate. Per-app recipe container (skills format) so the flow is data, not code.
- **Oct 12 - 14:** injection-resistance review against the screen-content threat model; kill-switch e2e; release-readiness pass (docs, System Health states, permission recovery).

**Checkpoint (Oct 14):** WhatsApp album task runs supervised end to end on a demo profile; the safety checklist (gates, allowlist, secure input, kill switch, audit) passes.

## Dependencies

| What | Needed by | Note |
| --- | --- | --- |
| Vision model install (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj) | Sep 22 | nothing earlier depends on it |
| `off-grid-ai/shared` CI for the new package | Aug 27 | one-time setup, ~half a day |
| Dev-machine TCC grants (Accessibility, Automation) with a stable dev signing identity - grants key to code signature | Aug 17 and Sep 10 | per `local-build.local.md`; keep one identity or grants orphan |
| `desktop-pro` changes for the approval executor | Aug 12 - 14 | separate repo commits + submodule bump here |

## Risks

| Risk | Mitigation |
| --- | --- |
| Solo schedule: one blocked day is a lost day, no parallel track | phases are independently valuable; a slip moves dates in this doc, never skips a checkpoint |
| AI-authored code lands faster than it is verified | the pace is set by the checkpoints, not by lines written: nothing is "done" until its tests and on-device check pass (repo rule: commit only green units) |
| macOS AX trees are uneven, vision carries more steps than on mobile | GUI-Owl is desktop-trained; window-scoped capture keeps resolution sane; recipes for the worst apps |
| Desktop agent scores run 20-30 pts below mobile headlines | supervised UX with per-step verify is the product shape, not autonomy claims |
| App updates break GUI flows (WhatsApp foremost) | flows live in recipe data; the acceptance case is a demo target, not a launch gate |
| TCC dev trap: grants orphan when the signing identity changes | stable dev identity, `tccutil reset` runbook note |
| Model landscape shifts before phase 3 | per-role model config; swapping the Cortex model touches zero engine code |

## Out of scope for v1

Windows adapter, mobile adapter, teach-and-repeat recording, background/headless runs, Mac App Store distribution (sandbox blocks the Accessibility path - we ship Developer ID).

## Tracking

- Branch: `feat/computer-use`. Small commits per verified unit, merge not squash. PR evidence rules apply (screenshots per changed surface; video for the run-view and WhatsApp demos).
- Weekly checkpoint review against this doc; date changes are edits to this doc.
