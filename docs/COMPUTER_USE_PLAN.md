# The proactive assistant - build plan and timeline

Companion to `COMPUTER_USE.md` (the model) and `ASSISTANT_ARCHITECTURE.md` (the system). This is the execution plan and the source of truth for schedule; adjust the plan here at each checkpoint, do not fork a second plan.

**Assumptions**

- Solo developer, AI authoring the code end to end, working fast.
- **Release-led.** The chat action tool ships first and gets released; every later capability layers on top of that released base. Each release is a real, demoable, shippable increment - not an internal phase.
- **Desktop v1 is macOS + Windows, in scope from day 1.** The shared brain (`@offgrid/use`) and the browser rail are one codebase; the semantic, accessibility, and vision rails each get a per-OS adapter behind the `DeviceController` port. Windows is built for from the start, not ported later.
- **Schedule:** first release about day 4; full cross-platform v1 about 15 working days (roughly 3 weeks), starting Wednesday, August 13, 2026. The extra week over a mac-only line is Windows parity on the native rails plus a one-time Windows build / sign / engine setup.
- **The lever:** to hold about 12 days, ship R1 and R2 on both OSes and let Windows parity for the heavier rails (R3, R4) trail macOS by one release. The chat tool - the first thing released - is cross-platform from day 1 regardless.
- Checkpoint discipline: a checkpoint is a verifiable, demoable milestone; the next release does not start until it passes.
- **The order follows the model:** the reliable, memory-driven, low-risk layers first; the risky GUI automation and the grounding vision model last. Value and reliability lead; pixels trail.

## Build guidelines (standing, all releases)

Binding on every surface and string (the chat tool, suggestions, approval cards, the recorder UI, notifications):

- **Design** - `off-grid-ai/brand` `DESIGN_PHILOSOPHY.md`: brutalist/terminal, Menlo, emerald-only accent, black/white base, hierarchy by size and weight not color, no gradients, no emojis. All values from `@offgrid/design` tokens; no hardcoded hex. Desktop density per `docs/DESIGN.md`.
- **Copy** - `off-grid-ai/brand` `brand_tone_voice.md` + outcomes-first: lead with what the user gets, mechanism as proof; no em dashes, no curly quotes, no exclamation marks, banned-word list applies.
- **Cross-platform from the seam.** Callers depend on the `DeviceController` port and the shared engine, never on a concrete OS. A per-OS branch belongs inside a rail adapter, not in the brain or the UI. Windows build via electron-builder (code-sign + the `llama-server` Windows engine build) is set up in R1 alongside the mac path.
- Keep sibling clones of `off-grid-ai/shared` and `off-grid-ai/brand`; re-read the brand before UI-heavy releases.

## Already shipped (the base R1 builds on)

- **Phase 0 - the approval seam.** `actions:proposeApproval` + the risk taxonomy (read / navigate / mutate / irreversible), backward-compatible with pro. TCC usage strings + apple-events entitlement. Landed.
- **Phase 1 - the semantic rail on macOS.** The native actions helper (calendar, reminders, contacts, Messages, Mail, open_url) behind `runNativeAction`, wired into the chat tool loop, mutations gated, shipped in CI, unit-tested through an injected boundary. This is the execution layer R1 turns into a released, cross-platform tool.

## Timeline at a glance

| Release | Days | What ships | Platforms | Checkpoint (demoable) |
| --- | --- | --- | --- | --- |
| R1. Chat actions (the tool) | 1 - 4 | Ask in chat, the model calls a gated, verified action tool, it runs on the semantic rail. Lands the minimal `@offgrid/use` spine + `DeviceController` port. | macOS (mostly built) + new Windows semantic rail | On both OSes, a chat ask calls the tool and the action runs, gated and verified. First release. |
| R2. Notices you | 5 - 7 | Reasoning + resolve + gate: it surfaces commitments/gaps and proposes the action, resolved from memory. Same tool, now proactive. | cross-platform (memory + LLM) | It surfaces an un-actioned commitment; approving resolves the target from memory and runs it via the R1 tool. |
| R3. Routines | 8 - 11 | Record-by-showing + faithful replay, per-step verified. | macOS AX + Windows UI Automation | Record a routine by showing it once; it replays with per-step verify; a slot resolves from memory. |
| R4. Hard cases | 12 - 15 | Browser rail (shared) + vision rail + safety pass. | macOS + Windows | A web check-in with takeover; the WhatsApp file-share supervised; drift recovery via vision; safety checklist. Full cross-platform v1. |

The split: `shared` holds the durable cross-platform brain (reused by mobile later); this repo holds the rails, the recorder, the reasoning surfaces, and the product integration.

## R1 - chat actions, the tool (Days 1 - 4) - first release

The lead's first piece: talk to the assistant in chat and it calls actions as gated, verified tools. Most of this exists on macOS (Phase 1); R1 turns it into a released, cross-platform foundation.

- **Land the minimal `@offgrid/use` spine + the `DeviceController` port.** The chat action tool enqueues a durable Action that flows through validate -> gate (on mutations) -> execute -> verify, rather than calling the rail inline. This is the reliability guarantee, and it is what lets both OSes share one brain from day 1. Grammar-constrained tool schema so the model can only emit a valid Action.
- **The Windows semantic rail** behind the same port: mail and calendar via Microsoft Graph / Outlook, open a URL or app via the Windows shell, reminders via Microsoft To Do. iMessage has no Windows equivalent, so the message action maps to a Windows-appropriate target (Outlook / Teams / a connector) or is macOS-only in R1 - an honest tier difference, not a gap in the design.
- **Windows build + sign + engine setup** (electron-builder target, code-signing, the `llama-server` Windows build), folded in here as the one-time cost.

**Checkpoint (day 4):** on both macOS and Windows, you ask the assistant in chat, it calls the action tool, and the action runs gated and verified through the semantic rail. Shipped as the first release.

## R2 - notices you: the reasoning + resolve layer (Days 5 - 7)

The magic, and the safest thing to add: memory + LLM + read-only context, no risky automation. It makes the released tool proactive.

- **Commitment and gap detection** over the Replay observation + entity spine: detect commitments and events ("flight tonight", "I will send the deck by tonight"), infer their required steps, gap-check state read-only. Output: candidate proposals with a confidence. Pure logic, unit-tested on seeded fixtures.
- **The resolve layer:** retrieval over Replay + conversation + entities + recent files to fill an action's open slots ("the presentation" -> the actual file), scoped by time and entity proximity, returning value + confidence.
- **Surface + gate:** proposals become suggestions; the approval card shows the resolved values with evidence and confidence; low confidence branches to a quick "which one did you mean" pick. Executes through the R1 tool. Trust starts at suggest-only.

**Checkpoint (day 7):** on a seeded demo profile, on both OSes, the assistant surfaces an un-actioned commitment and proposes it; approving "send the deck I promised" resolves the file from context and runs it via the R1 tool, gated. Zero GUI automation.

## R3 - routines: demonstration recorder + faithful replay (Days 8 - 11)

Record-by-showing and reliable replay on well-behaved apps. This is the heaviest cross-platform lift: two native automation stacks.

- Recorder: input tap + accessibility tagging of each meaningful action into an anchored trace; Replay frames for context; secure-input hard-skip. macOS: AX + CGEvent. Windows: UI Automation + SendInput.
- Review UI: steps in plain language, edit/reorder, mark variable slots (which resolve via R2).
- Replay: deterministic trace execution via the platform act-primitives; verify-after-each-step; model recovery only when a target is gone.
- Store as a routine with a trigger (manual / schedule / event), starting in Suggest.

**Checkpoint (day 11):** record a small routine on a native app by showing it once; it replays faithfully with per-step verification, and a marked slot resolves from memory at run time. Under the 12-day lever, this checkpoint is macOS-first with Windows parity trailing into R4.

## R4 - hard cases: browser rail + vision rail (Days 12 - 15) - full cross-platform v1

The supervised frontier: reasoned web tasks with no connector, and apps that expose nothing to automate.

- **Browser rail:** the embedded browser pane (`WebContentsView` + `webContents.debugger` CDP, indexed-snapshot perception, per-site cards, takeover) for reasoned web tasks (check-in, ordering). Electron, so shared across both OSes. Zero OS permissions, no new model.
- **Vision rail:** a grounding vision model (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj, installed here) as recovery for a drifted demonstrated step and as the driver for dead-accessibility apps. Input via CGEvent (mac) / SendInput (Windows).
- **The WhatsApp file-share recipe** as a worked example of the vision rail on a hard target, sent behind the gate.
- **Safety pass:** injection-resistance review, kill-switch tested end to end, release-readiness check.

**Checkpoint (day 15):** a reasoned web check-in runs in-pane with a takeover at login; the WhatsApp file-share task runs supervised end to end; a demonstrated routine recovers from a drifted step via vision; the safety checklist passes. Full cross-platform desktop v1.

## Windows parity note

- **Semantic rail** differs by OS: Graph / Outlook / Windows shell / To Do on Windows vs EventKit / AppleScript on macOS. iMessage is macOS-only.
- **Browser rail** is shared (Electron), the cheapest parity win.
- **Accessibility rail** needs a Windows implementation: UI Automation + SendInput vs AX + CGEvent.
- **Vision rail** is largely shared except input injection (SendInput vs CGEvent).
- **One-time setup:** the Windows build, code-signing, and `llama-server` engine build land in R1.

## Dependencies

| What | Needed by | Note |
| --- | --- | --- |
| `desktop-pro` access | R2 | the reasoning engine, resolve layer, approvals + routines UI are pro; stub if access lags |
| Sibling `../shared` + `../brand` clones | now | build requirement (main adopted `@offgrid/sync`) |
| Windows toolchain (electron-builder target, code-sign cert, `llama-server` Windows build) | R1 | one-time; sets up cross-platform CI and signing |
| Seeded memory fixtures (Replay observations, entities, commitments) | R2 | to test detection + resolution without a live profile |
| Windows UI Automation act-primitives | R3 | the Windows analogue of the AX act-primitives |
| Vision model install (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj) | R4 | nothing before R4 needs it |

## Risks

| Risk | Mitigation |
| --- | --- |
| Windows parity stretches the tail (two native stacks) | the `DeviceController` port + shared brain keep it to adapters; browser rail is shared; the trailing-Windows lever protects the schedule; cheapest reliable rail first |
| Windows build / sign / engine setup is net-new | folded into R1 as a one-time cost, before any Windows rail work depends on it |
| Detection precision - false proposals annoy | confidence bar; suggest-only until trusted; learn from accept/dismiss |
| Confident-but-wrong resolution | the gate shows resolved values; higher confidence bar + reversibility for auto-run |
| GUI automation reliability (the frontier ceiling) | route to cheaper rails first; demonstrated traces over novel automation; recipes for common flows; honest confidence |
| UI drift breaks a replay | anchoring + verify-after-each-step + model recovery |
| Local model tool-calling reliability | grammar-constrained tool schema; the durable queue makes a bad turn a no-op; heavy lifting is retrieval, not generation |
| Solo schedule: a blocked day is a lost day | releases are independently valuable; a slip trims scope at the tail (Windows parity, then vision), never the released core |

## Out of scope for v1

The mobile adapter, background / headless autonomous runs, chat-channel control surfaces (the OpenClaw pattern), and store distribution (macOS Developer ID direct; Windows outside the Store). Windows is now in scope for desktop v1 (from day 1) and is no longer deferred.

## After v1 - the mobile adapter (unscheduled)

Mobile follows as an adapter-only project on the same `@offgrid/use` engine. Prereqs: OGAM adopts the shared monorepo; an Android accessibility-service portal for tree + input; iOS stays intents-only (the platform forbids reading/driving other apps, so no vision fallback there).

## Tracking

- Branch: `feat/computer-use`. Small commits per verified unit, merge not squash. PR evidence rules apply (screenshots per surface; video for the recorder, run-view, and web-task demos).
- Checkpoint review against this doc at each release; plan changes are edits here.
