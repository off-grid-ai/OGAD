# The proactive assistant - build plan and timeline

Companion to `COMPUTER_USE.md` (the model, incl. the "what we reuse" table) and `ASSISTANT_ARCHITECTURE.md` (the system). This is the execution plan and the source of truth for schedule; adjust the plan here at each checkpoint, do not fork a second plan.

**Assumptions**

- Solo developer, AI authoring the code end to end, working fast.
- **Release-led.** The chat action tool ships first and gets released; every later capability layers on top of that released base. Each release is a real, demoable, shippable increment - not an internal phase.
- **Desktop v1 is macOS + Windows, in scope from day 1.** The shared brain (`@offgrid/use`) and the browser rail are one codebase; the semantic, accessibility, and vision rails each get a per-OS adapter behind the `DeviceController` port. Windows is built for from the start, not ported later.
- **Port, do not reinvent.** Each rail has a permissive-licensed project to port from (see `COMPUTER_USE.md` Section 9). This is what compresses the tail: R3 ports OpenAdapt (record -> deterministic self-healing replay with postconditions), R4 ports nanobrowser + browser-use (CDP) + the UI-TARS SDK (operator + overlay), and the Windows fast-follow ports FlaUI / pywinauto for the UIA primitives.
- **Schedule: a 10-working-day plan**, starting Wednesday, August 13, 2026; first release about day 4. The two days saved versus the from-scratch line come entirely from the ports in R3 and R4. R1 and R2 - the bespoke core (our engine, our reasoning over our memory) - are unchanged and are the floor; no port shortens them. Mobile reuse (Mobilerun and friends) shortens the future mobile project, not desktop v1.
- R1 and R2 are cross-platform (macOS + Windows) from day 1. R3 and R4 land macOS-first, with Windows parity for the two heavy native rails - routines (UI Automation) and vision (SendInput) - as a short fast-follow after day 10.
- **The one thing no port shortens:** the Windows build / sign / notarize + `llama-server` Windows engine setup in R1 is net-new infrastructure. It is the schedule's hard floor and is why R1 stays at four days.
- Checkpoint discipline: a checkpoint is a verifiable, demoable milestone; the next release does not start until it passes.
- **The order follows the model:** the reliable, memory-driven, low-risk layers first; the risky GUI automation and the grounding vision model last. Value and reliability lead; pixels trail.

## Build guidelines (standing, all releases)

Binding on every surface and string (the chat tool, suggestions, approval cards, the recorder UI, notifications):

- **Design** - `off-grid-ai/brand` `DESIGN_PHILOSOPHY.md`: brutalist/terminal, Menlo, emerald-only accent, black/white base, hierarchy by size and weight not color, no gradients, no emojis. All values from `@offgrid/design` tokens; no hardcoded hex. Desktop density per `docs/DESIGN.md`.
- **Copy** - `off-grid-ai/brand` `brand_tone_voice.md` + outcomes-first: lead with what the user gets, mechanism as proof; no em dashes, no curly quotes, no exclamation marks, banned-word list applies.
- **Cross-platform from the seam.** Callers depend on the `DeviceController` port and the shared engine, never on a concrete OS. A per-OS branch belongs inside a rail adapter, not in the brain or the UI. Windows build via electron-builder (code-sign + the `llama-server` Windows engine build) is set up in R1 alongside the mac path.
- **Port from the reuse table** (`COMPUTER_USE.md` Section 9) before writing a rail from scratch; verify the license at the point of adoption. Keep sibling clones of `off-grid-ai/shared` and `off-grid-ai/brand`; re-read the brand before UI-heavy releases.

## Already shipped (the base R1 builds on)

- **Phase 0 - the approval seam.** `actions:proposeApproval` + the risk taxonomy (read / navigate / mutate / irreversible), backward-compatible with pro. TCC usage strings + apple-events entitlement. Landed.
- **Phase 1 - the semantic rail on macOS.** The native actions helper (calendar, reminders, contacts, Messages, Mail, open_url) behind `runNativeAction`, wired into the chat tool loop, mutations gated, shipped in CI, unit-tested through an injected boundary. This is the execution layer R1 turns into a released, cross-platform tool.

## Timeline at a glance (10 working days)

| Release | Days | What ships | Ports from | Platforms |
| --- | --- | --- | --- | --- |
| R1. Chat actions (the tool) | 1 - 4 | Ask in chat, the model calls a gated, verified action tool, it runs on the semantic rail. Lands the minimal `@offgrid/use` spine + `DeviceController` port. | (bespoke) + macos-automator-mcp; Microsoft Graph | macOS (mostly built) + new Windows semantic rail |
| R2. Notices you | 5 - 7 | Reasoning + resolve + gate: it surfaces commitments/gaps and proposes the action, resolved from memory. | (bespoke - our memory) | cross-platform (memory + LLM) |
| R3. Routines | 8 - 9 | Record-by-showing + faithful, self-healing, per-step-verified replay. | **OpenAdapt** (trace + self-heal) | macOS-first; Windows UIA fast-follow |
| R4. Hard cases | 10 | Browser rail (shared) + vision rail + safety pass. | **nanobrowser + browser-use + UI-TARS SDK** | macOS + shared browser on both; Windows vision-input fast-follow |
| Windows heavy-rail parity | fast-follow | UI Automation routines + SendInput vision input | **FlaUI / pywinauto** | Windows |

The split: `shared` holds the durable cross-platform brain (reused by mobile later); this repo holds the rails, the recorder, the reasoning surfaces, and the product integration.

## R1 - chat actions, the tool (Days 1 - 4) - first release

The lead's first piece: talk to the assistant in chat and it calls actions as gated, verified tools. Most of this exists on macOS (Phase 1); R1 turns it into a released, cross-platform foundation. No port shortens R1 - it is our engine plus the net-new Windows setup.

- **Land the minimal `@offgrid/use` spine + the `DeviceController` port.** The chat action tool enqueues a durable Action that flows through validate -> gate (on mutations) -> execute -> verify, rather than calling the rail inline. This is the reliability guarantee, and it is what lets both OSes share one brain from day 1. Grammar-constrained tool schema so the model can only emit a valid Action.
- **The Windows semantic rail** behind the same port: mail and calendar via Microsoft Graph / Outlook, open a URL or app via the Windows shell, reminders via Microsoft To Do. iMessage has no Windows equivalent, so the message action maps to a Windows-appropriate target (Outlook / Teams / a connector) or is macOS-only in R1 - an honest tier difference, not a gap in the design.
- **Windows build + sign + engine setup** (electron-builder target, code-signing, the `llama-server` Windows build), folded in here as the one-time cost and the schedule floor.

**Checkpoint (day 4):** on both macOS and Windows, you ask the assistant in chat, it calls the action tool, and the action runs gated and verified through the semantic rail. Shipped as the first release.

## R2 - notices you: the reasoning + resolve layer (Days 5 - 7)

The magic, and the safest thing to add: memory + LLM + read-only context, no risky automation. It makes the released tool proactive, and it is cross-platform for free (no native rail change). Bespoke - it runs over our Replay + entity spine, so there is nothing to port here.

- **Commitment and gap detection** over the Replay observation + entity spine: detect commitments and events ("flight tonight", "I will send the deck by tonight"), infer their required steps, gap-check state read-only. Output: candidate proposals with a confidence. Pure logic, unit-tested on seeded fixtures.
- **The resolve layer:** retrieval over Replay + conversation + entities + recent files to fill an action's open slots ("the presentation" -> the actual file), scoped by time and entity proximity, returning value + confidence.
- **Surface + gate:** proposals become suggestions; the approval card shows the resolved values with evidence and confidence; low confidence branches to a quick "which one did you mean" pick. Executes through the R1 tool. Trust starts at suggest-only.

**Checkpoint (day 7):** on a seeded demo profile, on both OSes, the assistant surfaces an un-actioned commitment and proposes it; approving "send the deck I promised" resolves the file from context and runs it via the R1 tool, gated. Zero GUI automation.

## R3 - routines: demonstration recorder + faithful replay (Days 8 - 9)

Record-by-showing and reliable replay on well-behaved apps. **Ports OpenAdapt** (MIT): its record -> deterministic, self-healing replay is our design, already built and benchmarked, so R3 is two days of porting and wiring rather than three of inventing. macOS-first; the Windows UI Automation adapter is the fast-follow.

- Recorder: input tap + accessibility tagging of each meaningful action into an anchored trace; Replay frames for context; secure-input hard-skip. macOS: AX + CGEvent.
- Trace + replay from OpenAdapt: each step carries a template crop, an OCR label, geometry, a structural locator, and postconditions; verify-after-each-step; the model touches the script only to repair on drift.
- Review UI: steps in plain language, edit/reorder, mark variable slots (which resolve via R2).
- Store as a routine with a trigger (manual / schedule / event), starting in Suggest.

**Checkpoint (day 9):** on macOS, record a small routine on a native app by showing it once; it replays faithfully with per-step verification, and a marked slot resolves from memory at run time. The Windows UIA + SendInput adapter (ports FlaUI / pywinauto) follows in the fast-follow.

## R4 - hard cases: browser rail + vision rail (Day 10) - full macOS v1

The supervised frontier: reasoned web tasks with no connector, and apps that expose nothing to automate. **Reuse-heavy**, which is why it fits in a day: the browser rail ports nanobrowser (DOM -> indexed elements) + browser-use (raw CDP); the vision rail ports the UI-TARS SDK (operator seam + ScreenMarker overlay) and drops in a ready grounding model. This is the tightest day and the natural place any slip absorbs.

- **Browser rail:** the embedded browser pane (`WebContentsView` + `webContents.debugger` CDP, indexed-snapshot perception, per-site cards, takeover) for reasoned web tasks (check-in, ordering). Electron, so it is cross-platform on both OSes from the start. Zero OS permissions, no new model.
- **Vision rail:** a grounding vision model (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj, installed here) as recovery for a drifted demonstrated step and as the driver for dead-accessibility apps. macOS input via CGEvent; Windows SendInput is in the fast-follow.
- **The WhatsApp file-share recipe** as a worked example of the vision rail on a hard target, sent behind the gate.
- **Safety pass:** injection-resistance review, kill-switch tested end to end, release-readiness check.

**Checkpoint (day 10):** on macOS, a reasoned web check-in runs in-pane with a takeover at login; the WhatsApp file-share task runs supervised end to end; a demonstrated routine recovers from a drifted step via vision; the safety checklist passes. The browser rail already works on Windows; the Windows vision-input path follows in the fast-follow. This is the full macOS v1 plus the cross-platform core.

## Windows heavy-rail parity (fast-follow)

Two adapters trail the 10-day line, both behind the same `DeviceController` port so no caller changes, both ported rather than invented:

- **Routines on Windows:** UI Automation for the accessibility tree + SendInput for synthetic input (ports FlaUI / pywinauto), mirroring the macOS AX + CGEvent recorder/replay.
- **Vision input on Windows:** SendInput for the grounded clicks and keystrokes (the vision model and the browser rail are already shared).

Estimated a couple of days once R3 and R4 have set the shape on macOS. Tracked as the immediate next work after day 10, not a someday item.

## What we port (do not reinvent)

Full table with licenses in `COMPUTER_USE.md` Section 9. Per release: R1 semantic - macos-automator-mcp (MIT) + Microsoft Graph; R3 routines - OpenAdapt (MIT); R4 browser - nanobrowser + browser-use (Apache/MIT); R4 vision - UI-TARS SDK (Apache-2.0) + a GUI-Owl / Qwen3-VL grounding model; Windows UIA - FlaUI / pywinauto (MIT / BSD-3). Mobile (after v1) - Mobilerun (MIT) for Android + iOS actuation, AppAgent (MIT) for learn-by-demo, Appium + WebDriverAgent + UiAutomator2 (Apache-2.0) underneath. All permissive; verify at adoption.

## Dependencies

| What | Needed by | Note |
| --- | --- | --- |
| `desktop-pro` access | R2 | the reasoning engine, resolve layer, approvals + routines UI are pro; stub if access lags |
| Sibling `../shared` + `../brand` clones | now | build requirement (main adopted `@offgrid/sync`) |
| Windows toolchain (electron-builder target, code-sign cert, `llama-server` Windows build) | R1 | one-time; the schedule floor; sets up cross-platform CI and signing |
| OpenAdapt trace/replay port | R3 | the recorder + self-healing replay base |
| Seeded memory fixtures (Replay observations, entities, commitments) | R2 | to test detection + resolution without a live profile |
| nanobrowser + browser-use + UI-TARS SDK ports | R4 | the browser rail serialization + CDP driving + the operator/overlay |
| Vision model install (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj) | R4 | nothing before R4 needs it |
| FlaUI / pywinauto UIA primitives | fast-follow | the Windows analogue of the AX act-primitives |

## Risks

| Risk | Mitigation |
| --- | --- |
| Compressed tail (R3 = 2 days, R4 = 1 day) assumes the ports drop in cleanly | ports are permissive and proven (OpenAdapt benchmarked; nanobrowser/UI-TARS already in production); R4 is the slip-absorber; the released core (R1-R2) is unaffected |
| Windows build / sign / engine setup is net-new and unshortenable | folded into R1 as the schedule floor, before any Windows rail work depends on it |
| Windows parity stretches the tail (two native stacks) | R1 and R2 are cross-platform on the line; the two heavy native rails trail as a scoped fast-follow behind the `DeviceController` port; the browser rail is shared |
| Detection precision - false proposals annoy | confidence bar; suggest-only until trusted; learn from accept/dismiss |
| Confident-but-wrong resolution | the gate shows resolved values; higher confidence bar + reversibility for auto-run |
| GUI automation reliability (the frontier ceiling) | route to cheaper rails first; demonstrated traces over novel automation; recipes for common flows; honest confidence |
| UI drift breaks a replay | OpenAdapt anchoring + postconditions + verify-after-each-step + model repair |
| Local model tool-calling reliability | grammar-constrained tool schema; the durable queue makes a bad turn a no-op; heavy lifting is retrieval, not generation |
| Solo schedule: a blocked day is a lost day | releases are independently valuable; a slip trims scope at the tail (Windows heavy-rail parity, then vision), never the released core |

## Out of scope for v1

The mobile adapter, background / headless autonomous runs, chat-channel control surfaces (the OpenClaw pattern), and store distribution (macOS Developer ID direct; Windows outside the Store). Windows is now in scope for desktop v1 (from day 1) and is no longer deferred.

## After v1 - the mobile adapter (unscheduled, port-heavy)

Mobile follows as an adapter-only project on the same `@offgrid/use` engine, and the actuation layer is ported, not built: Mobilerun (droidrun, MIT) wraps Android + iOS device control; AppAgent (MIT) informs learn-by-demonstration; Appium + WebDriverAgent + UiAutomator2 (Apache-2.0) sit underneath; GUI-Owl is the shared grounding model. Prereqs: OGAM adopts the shared monorepo; iOS stays intents-only (the platform forbids reading/driving other apps, so no vision fallback there).

## Tracking

- Branch: `feat/computer-use`. Small commits per verified unit, merge not squash. PR evidence rules apply (screenshots per surface; video for the recorder, run-view, and web-task demos).
- Checkpoint review against this doc at each release; plan changes are edits here.
