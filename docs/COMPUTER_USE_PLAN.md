# Computer use - build plan and timeline

Companion to `COMPUTER_USE.md` (the approach). This doc is the execution plan: phases, dated milestones, checkpoints, dependencies, risks. It is the source of truth for schedule - adjust the dates here at the weekly checkpoint, do not fork a second plan.

**Assumptions**

- Solo developer (Siddharth), with AI doing the code authoring end to end. Durations are therefore paced by what does NOT compress: review, on-device verification, TCC permission flows, packaged-build checks, and iteration against real apps and websites. Code-heavy phases are scheduled aggressively; integration-heavy phases keep slack.
- Dates start Wednesday, August 12, 2026 and assume this is the main focus. If a week goes elsewhere, shift the dates here - the phase order and checkpoints do not change.
- Checkpoint discipline from the shared roadmap applies: a checkpoint is a verifiable, demoable milestone; the next phase does not start until it passes.
- **Vision model:** GUI-Owl-1.5-8B-Instruct (MIT) is the working default; Qwen3-VL-8B (Apache-2.0) is the alternate. Both are Qwen3-VL-architecture models, so every line of engine and adapter work is identical for either - the pick is a catalog decision made at install time (phase 4) and is not on the critical path before that. The agent-browser phase needs no new model at all.

## Build guidelines (standing, all phases)

Binding on every UI surface and string this plan produces (pane chrome, run view, approval cards, overlays, onboarding, notifications):

- **Design:** `off-grid-ai/brand` `DESIGN_PHILOSOPHY.md` is the canonical source - brutalist/terminal, Menlo everywhere, emerald as the only accent, black/white base, hierarchy by size and weight not color, no gradients, no emojis. All color/spacing/type values come from `@offgrid/design` tokens (`off-grid-ai/shared`) - no hardcoded hex. Desktop layout density per this repo's `docs/DESIGN.md`.
- **Copy:** `off-grid-ai/brand` `brand_tone_voice.md` plus the outcomes-first rule in the brand README - lead with what the user gets, mechanism as proof; no em dashes, no curly quotes, no exclamation marks, banned-word list applies.
- Keep a local clone of `off-grid-ai/brand` next to the repos and re-read before each UI-heavy phase (3, 4, 5).

## Timeline at a glance

| Phase | Dates | Length | Repo | Checkpoint (demoable) |
| --- | --- | --- | --- | --- |
| 0. Foundations | Aug 12 - Aug 14 | 3 days | this repo + `desktop-pro` | approval seam widened with risk classes; entitlements land; decisions locked |
| 1. Semantic rail | Aug 17 - Aug 26 | 1.5 wk | this repo | "create a calendar event Thursday 3pm" end to end, approval-gated, bundled model |
| 2. `@offgrid/use` engine | Aug 27 - Sep 9 | 2 wk | `shared` | engine suite green against a scripted fake device |
| 3. Agent browser | Sep 10 - Sep 23 | 2 wk | this repo | a multi-step web task in-pane, watched live, per-site cards, login takeover - **shippable v1-with-browser** |
| 4. Desktop adapter + vision | Sep 24 - Oct 13 | 3 wk | this repo + `desktop-pro` | multi-step GUI task on a native app, verified per step, live run view |
| 5. Hard targets + hardening | Oct 14 - Oct 27 | 2 wk | this repo + `desktop-pro` | WhatsApp album task supervised end to end; safety checklist passes |

Eleven weeks total, two shippable cuts inside it: phase 1 alone (semantic actions, Aug 26) and phases 0-3 (everything plus the agent browser, Sep 23). The split to remember: `shared` holds the durable, cross-platform brain (reused later by mobile); this repo holds the hands, the browser pane, and the product integration.

Where the browser phase came from (added August 12): the embedded agent-browser pane is the surface Codex desktop and Claude Desktop both converged on in 2026. It needs zero OS permissions and no new models, and it covers most real-world GUI tasks (anything web), so it jumps ahead of native-GUI control.

## Phase 0 - foundations (Aug 12 - Aug 14)

| Work item | Detail | Verification |
| --- | --- | --- |
| Lock decisions | v1 graph roles (proposed: Planner / Cortex / Executor / Reflector, add Orchestrator + Summarizer when task length demands), package name (`@offgrid/use`), approval UX (proposed: plan-level approval + live step view + per-step gates on irreversible actions) | recorded in `COMPUTER_USE.md` section 8 |
| Widen the approval seam | `mcp:proposeApproval` becomes transport-agnostic `actions:proposeApproval` carrying `{kind, title, detail, risk, args, source}`; per-executor `riskOf(name, args)` replaces the name regex; MCP extension migrates onto it | existing approval tests stay green (`mcp-connector-tool-extension.dbtest.ts`); new tests per risk class; pro executor updated in `desktop-pro`, submodule bumped |
| Packaging groundwork | `com.apple.security.automation.apple-events` entitlement + `NSAppleEventsUsageDescription` + Calendars/Contacts/Photos usage keys in the electron-builder config | local packaged build per `local-build.local.md`; TCC prompts name the app |
| Permission onboarding design | just-in-time grants only (the browser rail needs none; Accessibility/Automation prompt on first native-rail use, deep-linked to the right Settings pane) | design reviewed; no dead-end states |
| Shared repo setup | sibling clone of `off-grid-ai/shared` next to this repo (CLAUDE.md already assumes `../shared`); package name `@offgrid/use` and consumption via `file:../shared/packages/use` are decided (Aug 12) - NOT a vendored copy under `packages/`; a sibling checkout is now a build requirement on this branch | checkout builds |
| Brand setup | sibling clone of `off-grid-ai/brand`; skim `DESIGN_PHILOSOPHY.md` + `brand_tone_voice.md` before any UI work | clone present |

## Phase 1 - semantic rail (Aug 17 - Aug 26)

- **Aug 17 - 19:** `actions` Swift helper skeleton (JSON over stdio, same `execFile` pattern as `src/main/ocr.ts`); EventKit create/read events + reminders; Contacts read. Unit tests on the Node wrapper; helper built alongside the existing Swift helpers.
- **Aug 20 - 21:** AppleScript surfaces - Messages send, Mail compose, Notes create/search, Finder basics; URL-scheme opener; `open -b` app launcher; `shortcuts run` wrapper with timeout guards (a prompting shortcut hangs the CLI - wrap every call). Reference: macos-automator-mcp (MIT) for script bodies and its recipe-KB pattern.
- **Aug 24 - 26:** expose everything as tools through the `ToolExtension` seam with risk classes; approval-gated writes; audit entries; permission onboarding wired. **Morning-briefing skill template** (cron trigger + read-only rails + notification output) as the first proactive workflow. Tests: unit per risk class and arg mapping, integration on a temp profile, e2e smoke asserting the approval queue renders the new action kinds.

**Checkpoint (Aug 26):** calendar event created end to end from chat with the bundled model, gated, audited. Messages send queues for approval and executes on approve. The briefing skill runs on a demo profile.

## Phase 2 - `@offgrid/use` engine in shared (Aug 27 - Sep 9)

All work in `off-grid-ai/shared`; testable with zero macOS dependencies - the phase where AI authoring compresses the most.

- **Aug 27 - 31:** package scaffold; `DeviceController` interface (`getState()`, `act(action)`, `openIntent(url)`, `listSemanticSurfaces()`); closed action schema + structured decision types - **including the browser action set** (navigate, click-ref, type-ref, scroll, back, tab ops) alongside native actions; fake `DeviceController` with scripted scenarios.
- **Sep 1 - 4:** graph v1 - Planner (subgoal decomposition), Cortex (one structured decision per step from indexed snapshot + optional screenshot), Executor (deterministic parse, no free-form reasoning); the router (deterministic surface - agent browser - structured UI - vision).
- **Sep 7 - 9:** Reflector (SUCCESS/FAILURE per transition with diagnosis), deterministic post-validation for typing (act, re-read, diff - minitap's +7 pt mechanism), cycle detection with forced strategy change (+9 pt mechanism); per-role model config against an OpenAI-compatible endpoint (our gateway); risk + approval callback seam; suite hardening; package docs.

**Checkpoint (Sep 9):** suite green on the fake device, including a type-verify scenario (field readback mismatch triggers retry), a loop-escape scenario (repeated state triggers strategy change), and a browser-action scenario against a fake browser controller.

## Phase 3 - agent browser (Sep 10 - Sep 23)

The embedded web rail. Zero OS permissions, no new models - the bundled model works from indexed snapshots. Reference implementations: nanobrowser (Apache-2.0, TS serialization to port), UI-TARS desktop `ui-helper` (Apache-2.0, in-page overlay UX), Claude Desktop browser pane (permission card UX to replicate).

- **Sep 10 - 14:** the pane - `WebContentsView` with tabs and brand-compliant chrome inside the app; `BrowserOperator` over `webContents.debugger` (raw CDP: navigate, `Input.dispatch*` click/type/scroll, `Page.captureScreenshot`); navigation-lifecycle waits; clean persistent profile separate from any user browser.
- **Sep 15 - 17:** perception - indexed DOM/accessibility snapshot (port nanobrowser's serialization over `DOM.getDocument` + `Accessibility.getFullAXTree`); hybrid snapshot/vision strategy behind the operator seam; per-step GBNF grammar constraining actions to element refs that exist on the current page.
- **Sep 18 - 21:** control - per-site permission cards (allow once / always allow / deny; localhost exempt) with a review screen; hard-blocked classes (purchase, account creation, permanent delete, CAPTCHA) and always-confirm protected actions; **takeover mode** (agent input pauses, frame capture stops, human actions recorded into the action log, resume with context); live overlays injected via `executeJavaScript` (status panel, click ripples); step feed in chat.
- **Sep 22 - 23:** e2e with screenshots; session-persistence opt-in per site; checkpoint demo run.

**Checkpoint (Sep 23):** a real multi-step web task (research a product across two sites, fill a form) completes in-pane, watched live, with a per-site card raised on first action and a login handled by takeover. **This cut is shippable: semantic actions + proactive skills + web automation.**

## Phase 4 - desktop adapter + vision fallback (Sep 24 - Oct 13)

Native-app control. Keeps the most slack: Swift interop, a model install, and real-device iteration all live here.

- **Sep 24 - 29:** Swift helper act primitives - `AXUIElementPerformAction`, set-`AXValue`, `AXManualAccessibility` wake, `CGEvent` post; coordinate mapping (AX points vs screenshot pixels, `backingScaleFactor` per display, multi-display origins).
- **Sep 30 - Oct 5:** AX tree serialization (indexed interactive elements + bounding boxes, diffs after actions); window-scoped capture via `src/main/vision.ts`; OCR helper emits `{text, bbox}`; **ScreenMarker port** (UI-TARS trio: animated screen border, content-protected pause/stop widget, pre-action markers - Apache-2.0 files, keep headers).
- **Oct 6 - 8:** model catalog entries (GUI-Owl-1.5-8B-Instruct GGUF + mmproj; Qwen3-VL-8B alternate) - **model install happens here**; Cortex/Reflector wired through the gateway; agent runs at modality-queue tier 2.
- **Oct 9 - 13:** supervised run flow end to end - live step view, hold-to-stop, per-app grants, per-step approvals for irreversible actions; e2e with screenshots; small eval harness (macOSWorld subset) as a sanity gate, not CI-blocking.

**Checkpoint (Oct 13):** a multi-step GUI task on a well-behaved native app (for example: create and reschedule a reminder through the Reminders UI) completes with per-step verification visible in the run view.

## Phase 5 - hard targets + hardening (Oct 14 - Oct 27)

Paced by iteration against real apps, not by code volume.

- **Oct 14 - 16:** Electron AX wake flows; secure-input detection surfaced in System Health; app allowlist setting; global Esc abort with consumed keypress.
- **Oct 19 - 23:** the WhatsApp acceptance case - `whatsapp://` intent open, keyboard-first navigation, vision-grounded clicks for the gaps, photo ranking by the vision model, send behind the gate. Per-app recipe container (skills format) so the flow is data, not code.
- **Oct 26 - 27:** injection-resistance review against the screen-content threat model (browser rail included); kill-switch e2e; release-readiness pass (docs, System Health states, permission recovery).

**Checkpoint (Oct 27):** WhatsApp album task runs supervised end to end on a demo profile; the safety checklist (gates, hard-blocked classes, allowlist, secure input, takeover capture-kill, kill switch, audit) passes.

## Dependencies

| What | Needed by | Note |
| --- | --- | --- |
| Vision model install (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj) | Oct 6 | phases 0-3 do not need it |
| `off-grid-ai/shared` CI for the new package | Aug 27 | one-time setup, ~half a day; push access already held |
| Sibling clones: `../shared`, `../brand` | Aug 12 | build guideline + consumption pattern |
| Dev-machine TCC grants (Accessibility, Automation) with a stable dev signing identity - grants key to code signature | Aug 17 and Sep 24 | per `local-build.local.md`; keep one identity or grants orphan |
| `desktop-pro` changes for the approval executor | Aug 12 - 14 | repo access still pending as of Aug 12 - stub the pro executor if access lags |
| Push access to `off-grid-ai/OGAD` | done (Aug 11) | write access granted and verified |

## Risks

| Risk | Mitigation |
| --- | --- |
| Solo schedule: one blocked day is a lost day, no parallel track | phases are independently valuable (two shippable cuts); a slip moves dates in this doc, never skips a checkpoint |
| AI-authored code lands faster than it is verified | the pace is set by the checkpoints, not by lines written: nothing is "done" until its tests and on-device check pass (repo rule: commit only green units) |
| Web pages vary wildly; snapshot quality drives browser-rail success | port nanobrowser's proven serialization rather than inventing; screenshots as fallback; per-step grammar keeps the model on valid refs |
| macOS AX trees are uneven, vision carries more steps than on mobile | GUI-Owl is desktop-trained; window-scoped capture keeps resolution sane; recipes for the worst apps |
| Desktop agent scores run 20-30 pts below mobile headlines | supervised UX with per-step verify is the product shape, not autonomy claims; the browser rail carries most tasks deterministically |
| App updates break GUI flows (WhatsApp foremost) | flows live in recipe data; the acceptance case is a demo target, not a launch gate |
| TCC dev trap: grants orphan when the signing identity changes | stable dev identity, `tccutil reset` runbook note |
| Model landscape shifts before phase 4 | per-role model config; swapping the Cortex model touches zero engine code |

## Out of scope for v1

Windows adapter, teach-and-repeat recording, background/headless runs, chat-channel clients (WhatsApp/Telegram as control surfaces - the OpenClaw pattern; revisit after v1), Mac App Store distribution (sandbox blocks the Accessibility path - we ship Developer ID).

## After v1 - the mobile adapter (unscheduled)

Desktop ships first; mobile follows as an adapter-only project on the same `@offgrid/use` engine. The engine phase already does the mobile prep that matters - a platform-free `DeviceController` seam, an action schema aligned with the mobile-use frameworks, a suite that runs on a fake device - and the vision model family (GUI-Owl-1.5) is trained for mobile as well as desktop. Prerequisites before scheduling it:

1. OGAM adopts the shared monorepo - it does not consume `@offgrid/*` packages yet; that migration is a standing roadmap item and a prerequisite regardless of computer use.
2. Android portal: an accessibility-service app (the droidrun-portal pattern) for tree reading + input, MediaProjection for screens, Android intents/deep links as the semantic rail.
3. iOS stays intents-only (App Intents / Shortcuts) - the platform does not allow an app to read or drive other apps, so no vision fallback exists there. Set expectations accordingly.

## Tracking

- Branch: `feat/computer-use`. Small commits per verified unit, merge not squash. PR evidence rules apply (screenshots per changed surface; video for the browser pane, run-view, and WhatsApp demos).
- Weekly checkpoint review against this doc; date changes are edits to this doc.
