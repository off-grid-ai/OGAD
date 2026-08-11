# Computer use - build plan and timeline

Companion to `COMPUTER_USE.md` (the approach). This doc is the execution plan: phases, dated milestones, checkpoints, dependencies, risks. It is the source of truth for schedule - adjust the dates here at the weekly checkpoint, do not fork a second plan.

**Assumptions**

- One engineer focused on this track. With a second engineer, phase 2 runs parallel to phase 1 (different repos, no shared files) and the end date pulls in by ~3 weeks.
- Dates start Wednesday, August 12, 2026.
- Checkpoint discipline from the shared roadmap applies: a checkpoint is a verifiable, demoable milestone; the next phase does not start until it passes.
- **Vision model:** GUI-Owl-1.5-8B-Instruct (MIT) is the working default; Qwen3-VL-8B (Apache-2.0) is the alternate. Both are Qwen3-VL-architecture models, so every line of engine and adapter work is identical for either - the pick is a catalog decision made at install time (phase 3, week 3) and is not on the critical path before that.

## Timeline at a glance

| Phase | Dates | Length | Checkpoint (demoable) |
| --- | --- | --- | --- |
| 0. Foundations | Aug 12 - Aug 19 | 1 wk | approval seam widened with risk classes; entitlements land; decisions locked |
| 1. Semantic rail | Aug 20 - Sep 9 | 3 wk | "create a calendar event Thursday 3pm" end to end, approval-gated, bundled model |
| 2. `@offgrid/use` engine | Sep 10 - Oct 7 | 4 wk | engine suite green against a scripted fake device |
| 3. Desktop adapter + vision | Oct 8 - Nov 4 | 4 wk | multi-step GUI task on a native app, verified per step, live step view |
| 4. Hard targets + hardening | Nov 5 - Dec 2 | 4 wk | WhatsApp album task supervised end to end; safety checklist passes |

Phase 1 is independently shippable - calendar, messages, mail, photos, reminders actions with approvals deliver user value on Sep 9 regardless of what follows.

## Phase 0 - foundations (Aug 12 - Aug 19)

| Work item | Detail | Verification |
| --- | --- | --- |
| Lock decisions | v1 graph roles (proposed: Planner / Cortex / Executor / Reflector, add Orchestrator + Summarizer when task length demands), package name (`@offgrid/use`), approval UX (proposed: plan-level approval + live step view + per-step gates on irreversible actions) | recorded in `COMPUTER_USE.md` section 8 |
| Widen the approval seam | `mcp:proposeApproval` becomes transport-agnostic `actions:proposeApproval` carrying `{kind, title, detail, risk, args, source}`; per-executor `riskOf(name, args)` replaces the name regex; MCP extension migrates onto it | existing approval tests stay green (`mcp-connector-tool-extension.dbtest.ts`); new tests per risk class; pro executor updated in `desktop-pro`, submodule bumped |
| Packaging groundwork | `com.apple.security.automation.apple-events` entitlement + `NSAppleEventsUsageDescription` + Calendars/Contacts/Photos usage keys in the electron-builder config | local packaged build per `local-build.local.md`; TCC prompts name the app |
| Permission onboarding design | sequence of grants (Accessibility held check exists, Automation per target, per-framework) behind an explicit "enable computer actions" flow | design reviewed; no dead-end states |

## Phase 1 - semantic rail (Aug 20 - Sep 9)

- **Week of Aug 20:** `actions` Swift helper skeleton (JSON over stdio, same `execFile` pattern as `src/main/ocr.ts`); EventKit create/read events + reminders; Contacts read. Unit tests on the Node wrapper; helper built alongside the existing Swift helpers.
- **Week of Aug 27:** AppleScript surfaces - Messages send, Mail compose, Notes create/search, Finder basics; URL-scheme opener; `open -b` app launcher; `shortcuts run` wrapper with timeout guards (a prompting shortcut hangs the CLI - wrap every call).
- **Week of Sep 3:** expose everything as tools through the `ToolExtension` seam with risk classes; approval-gated writes; audit entries; permission onboarding wired. Tests: unit per risk class and arg mapping, integration on a temp profile, e2e smoke asserting the approval queue renders the new action kinds.

**Checkpoint (Sep 9):** calendar event created end to end from chat with the bundled model, gated, audited. Messages send queues for approval and executes on approve.

## Phase 2 - `@offgrid/use` engine in shared (Sep 10 - Oct 7)

All work in `off-grid-ai/shared`; testable with zero macOS dependencies.

- **Week of Sep 10:** package scaffold; `DeviceController` interface (`getState()`, `act(action)`, `openIntent(url)`, `listSemanticSurfaces()`); closed action schema + structured decision types; fake `DeviceController` with scripted scenarios.
- **Week of Sep 17:** graph v1 - Planner (subgoal decomposition), Cortex (one structured decision per step from tree + screenshot), Executor (deterministic parse, no free-form reasoning).
- **Week of Sep 24:** Reflector (SUCCESS/FAILURE per transition with diagnosis), deterministic post-validation for typing (act, re-read, diff - minitap's +7 pt mechanism), cycle detection with forced strategy change (+9 pt mechanism); the router (deterministic surface - structured UI - vision).
- **Week of Oct 1:** per-role model config against an OpenAI-compatible endpoint (our gateway); risk + approval callback seam; suite hardening; package docs.

**Checkpoint (Oct 7):** suite green on the fake device, including a type-verify scenario (field readback mismatch triggers retry) and a loop-escape scenario (repeated state triggers strategy change).

## Phase 3 - desktop adapter + vision fallback (Oct 8 - Nov 4)

- **Week of Oct 8:** Swift helper act primitives - `AXUIElementPerformAction`, set-`AXValue`, `AXManualAccessibility` wake, `CGEvent` post; coordinate mapping (AX points vs screenshot pixels, `backingScaleFactor` per display, multi-display origins).
- **Week of Oct 15:** AX tree serialization (indexed interactive elements + bounding boxes, drop unlabeled wrappers, diffs after actions); window-scoped capture via `src/main/vision.ts`; OCR helper emits `{text, bbox}`.
- **Week of Oct 22:** model catalog entries (GUI-Owl-1.5-8B-Instruct GGUF + mmproj; Qwen3-VL-8B alternate) - **model install happens here**; Cortex/Reflector wired through the gateway; agent runs at modality-queue tier 2.
- **Week of Oct 29:** supervised run UI - live step view, hold-to-stop, per-step approvals for irreversible actions; e2e with screenshots; small eval harness (macOSWorld subset) as a sanity gate, not CI-blocking.

**Checkpoint (Nov 4):** a multi-step GUI task on a well-behaved native app (for example: create and reschedule a reminder through the Reminders UI) completes with per-step verification visible in the run view.

## Phase 4 - hard targets + hardening (Nov 5 - Dec 2)

- **Week of Nov 5:** Electron AX wake flows; secure-input detection surfaced in System Health; app allowlist setting.
- **Weeks of Nov 12 + 19:** the WhatsApp acceptance case - `whatsapp://` intent open, keyboard-first navigation, vision-grounded clicks for the gaps, photo ranking by the vision model, send behind the gate. Per-app recipe container (skills format) so the flow is data, not code.
- **Week of Nov 26:** injection-resistance review against the screen-content threat model; kill-switch e2e; release-readiness pass (docs, System Health states, permission recovery).

**Checkpoint (Dec 2):** WhatsApp album task runs supervised end to end on a demo profile; the safety checklist (gates, allowlist, secure input, kill switch, audit) passes.

## Dependencies

| What | Needed by | Owner |
| --- | --- | --- |
| Vision model install (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj) | phase 3, week of Oct 22 | Siddharth - nothing earlier depends on it |
| `off-grid-ai/shared` CI for the new package | phase 2 start | team |
| Dev-machine TCC grants (Accessibility, Automation) with a stable dev signing identity - grants key to code signature | phase 1 and 3 | each dev, per `local-build.local.md` |
| `desktop-pro` changes for the approval executor | phase 0 | same engineer, separate repo commits + submodule bump |

## Risks

| Risk | Mitigation |
| --- | --- |
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
