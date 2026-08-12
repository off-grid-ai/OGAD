# The proactive assistant - build plan and timeline

Companion to `COMPUTER_USE.md` (the model). This is the execution plan. It is the source of truth for schedule; adjust dates here at the weekly checkpoint, do not fork a second plan.

**Assumptions**

- Solo developer, AI doing the code authoring end to end. Durations are paced by what does NOT compress: review, on-device verification, TCC flows, and iteration against real apps and memory data.
- Dates start Wednesday, August 12, 2026. Phases 0-1 are already done (see below).
- Checkpoint discipline: a checkpoint is a verifiable, demoable milestone; the next phase does not start until it passes.
- **The order follows the model in `COMPUTER_USE.md`:** the reliable, memory-driven, low-risk layers first; the risky GUI automation and the grounding vision model last. Value and reliability lead; pixels trail.

## Build guidelines (standing, all phases)

Binding on every surface and string (suggestions, approval cards, the recorder UI, notifications):

- **Design** - `off-grid-ai/brand` `DESIGN_PHILOSOPHY.md`: brutalist/terminal, Menlo, emerald-only accent, black/white base, hierarchy by size and weight not color, no gradients, no emojis. All values from `@offgrid/design` tokens; no hardcoded hex. Desktop density per `docs/DESIGN.md`.
- **Copy** - `off-grid-ai/brand` `brand_tone_voice.md` + outcomes-first: lead with what the user gets, mechanism as proof; no em dashes, no curly quotes, no exclamation marks, banned-word list applies.
- Keep sibling clones of `off-grid-ai/shared` and `off-grid-ai/brand`; re-read the brand before UI-heavy phases.

## Timeline at a glance

| Phase | Dates | Repo | Checkpoint (demoable) |
| --- | --- | --- | --- |
| 0. Foundations | done | this repo | approval seam with risk classes; TCC packaging |
| 1. Semantic rail (rail 1) | done | this repo | calendar / reminders / contacts / messages / mail / open_url, gated, shipped |
| 2. Notices you (reasoning + resolve) | Aug 13 - Sep 3 | this repo + `desktop-pro` | it surfaces "you haven't checked in for tonight's flight"; it sends "the deck I promised" resolved from context, gated |
| 3. `@offgrid/use` engine | Sep 4 - Sep 17 | `shared` | router + trace model + verification green on a fake device |
| 4. Demonstration recorder + replay (rail 3) | Sep 18 - Oct 8 | this repo + `desktop-pro` | record a routine by showing it; replay it faithfully on a native app, per-step verified |
| 5. Agent browser (rail 2) | Oct 9 - Oct 22 | this repo | a reasoned web task (open a check-in page, fill known fields) in-pane, watched, login by takeover |
| 6. Vision fallback + hard targets (rail 4) | Oct 23 - Nov 5 | this repo + `desktop-pro` | GUI-Owl/Qwen3-VL catalog entry; the WhatsApp album task supervised; drift recovery on a demonstrated routine |

The split: `shared` holds the durable cross-platform brain (reused by mobile later); this repo holds the rails, the recorder, the reasoning surfaces, and the product integration.

## Phase 0 - foundations (done)

Approval seam (`actions:proposeApproval` + risk taxonomy, backward-compatible with pro), TCC usage strings + apple-events entitlement, `@offgrid/use` package name and `file:../shared/packages/use` consumption decided. Landed on this branch.

## Phase 1 - semantic rail, rail 1 (done)

The native actions helper (calendar create/list, reminders create/list, contacts search, Messages send, Mail send, open_url) behind `runNativeAction`, wired into the chat tool loop macOS-only, mutations gated, shipped in CI, unit-tested through an injected boundary. This is the reliable execution layer the whole assistant routes to first.

## Phase 2 - notices you: the reasoning engine + resolve layer (Aug 13 - Sep 3)

The magic, and the safest thing to build: it needs memory + LLM + read-only connectors, no risky automation. This is where the product becomes an assistant rather than a tool.

- **Aug 13 - 19: commitment/gap detection.** Over the Replay observation + entity spine: detect commitments and events ("flight tonight", "I'll send the deck by tonight"), infer their required steps from the LLM's world knowledge, and gap-check state read-only (a boarding pass in Gmail via connector, an unchecked step). Output: candidate proposals with a confidence. Pure logic pulled out and unit-tested against seeded memory fixtures.
- **Aug 20 - 26: the resolve layer.** RAG over Replay + conversation + entities + recent files to fill an action's open slots ("the presentation" -> the actual file), scoped by temporal and entity proximity, returning value + confidence. Unit-tested with seeded memory.
- **Aug 27 - Sep 3: surface + gate.** Proposals become notifications/suggestions; the approval card shows the RESOLVED values ("Send `Q3.pptx` to Ali"); confidence drives gate vs disambiguate. Executes through rail 1. Trust starts at suggest-only. Tests: detection precision on fixtures, resolution correctness, the gate showing resolved values.

**Checkpoint (Sep 3):** on a seeded demo profile, the assistant surfaces an un-actioned commitment and proposes it; approving "send the deck I promised" resolves the file from context and sends it via rail 1, gated. The reasoning + resolve + gate spine works end to end with zero GUI automation.

## Phase 3 - the `@offgrid/use` engine in shared (Sep 4 - Sep 17)

The reusable brain: the router (cheapest reliable rail first), the routine trace model, slot types, verification, and the risk/approval callback seam - platform-free, tested on a fake `DeviceController`. Mirrors the `@offgrid/clipboard` engine+adapter split; a mobile adapter can follow later.

**Checkpoint (Sep 17):** the engine suite is green on a fake device, including a routed action (semantic vs GUI), a resolved slot, and a verification-retry scenario.

## Phase 4 - demonstration recorder + faithful replay, rail 3 (Sep 18 - Oct 8)

Record-by-showing and reliable replay on well-behaved apps.

- Recorder: CGEvent tap (we ship the listening half) + AX tagging of each meaningful action into an AX-anchored trace; Replay frames for context; secure-input hard-skip.
- Review UI: steps in plain language, edit/reorder, mark variable slots (which resolve via phase 2).
- Replay: deterministic trace execution via the Swift helper's new AX act-primitives (`AXUIElementPerformAction`, set-value); verify-after-each-step; model recovery only when a target is gone.
- Store as a skill with a trigger (manual / schedule / event).

**Checkpoint (Oct 8):** record a small routine on a native app by showing it once; it replays faithfully with per-step verification, and a marked slot resolves from memory at run time.

## Phase 5 - agent browser, rail 2 (Oct 9 - Oct 22)

The embedded browser pane (`WebContentsView` + `webContents.debugger` CDP, indexed-snapshot perception, per-site cards, takeover), for the reasoned novel web tasks (check-in, ordering) where there is no connector. Zero OS permissions, no new model. Reuses nanobrowser serialization and the UI-TARS overlay UX.

**Checkpoint (Oct 22):** a reasoned web task runs in-pane - open an airline check-in page, fill the known fields from resolved context, hand off at login via takeover - watched live, gated at the identity step.

## Phase 6 - vision fallback + hard targets, rail 4 (Oct 23 - Nov 5)

The last resort: dead-AX apps and drift recovery.

- Model catalog entry (GUI-Owl-1.5-8B-Instruct GGUF + mmproj; Qwen3-VL-8B alternate) - the vision-model install happens here.
- Grounding wired as recovery for a demonstrated trace whose AX target drifted, and as the driver for dead-AX apps.
- The WhatsApp acceptance case (`whatsapp://` open + keyboard + vision-grounded clicks + photo ranking + send behind the gate), as a per-app recipe.
- Injection-resistance review, kill-switch e2e, release-readiness pass.

**Checkpoint (Nov 5):** the WhatsApp album task runs supervised end to end; a demonstrated routine recovers from a drifted step via vision; the safety checklist passes.

## Dependencies

| What | Needed by | Note |
| --- | --- | --- |
| `desktop-pro` access | phase 2 | the reasoning engine, resolve layer, and approvals integration are pro; stub if access lags |
| Sibling `../shared` + `../brand` clones | now | build requirement (main adopted `@offgrid/sync`); done this session |
| Seeded memory fixtures (Replay observations, entities, commitments) | phase 2 | needed to test detection + resolution without a live profile; extend the demo seeders |
| Vision model install (GUI-Owl-1.5-8B or Qwen3-VL-8B GGUF + mmproj) | Oct 23 | nothing before phase 6 needs it |
| `desktop-pro` approval-executor migration to `actions:proposeApproval` | phase 2 | the fallback covers it until then |

## Risks

| Risk | Mitigation |
| --- | --- |
| Detection precision - false proposals annoy | confidence bar; suggest-only until trusted; learn from accept/dismiss |
| Confident-but-wrong resolution | the gate shows resolved values; higher confidence bar + reversibility for auto-run |
| GUI automation reliability (the frontier ceiling) | route to cheaper rails first; demonstrated traces over novel automation; recipes for common flows; honest confidence |
| Recorded traces are literal | memory-resolved slots + marked variables; not a raw macro recorder |
| UI drift breaks a replay | AX-anchoring + verify-after-each-step + model recovery |
| Local model tool-calling / reasoning reliability | per-role model config; the reasoning engine is memory+LLM, tunable; the heavy lifting is retrieval, not generation |
| Solo schedule: a blocked day is a lost day | phases are independently valuable; a slip moves dates here, never skips a checkpoint |

## Out of scope for v1

Windows adapter, mobile adapter, background/headless autonomous runs, chat-channel control surfaces (the OpenClaw pattern), Mac App Store distribution (sandbox blocks the AX path - Developer ID only).

## After v1 - the mobile adapter (unscheduled)

Mobile follows as an adapter-only project on the same `@offgrid/use` engine. Prereqs: OGAM adopts the shared monorepo; an Android accessibility-service portal for tree + input; iOS stays intents-only (the platform forbids reading/driving other apps, so no vision fallback there).

## Tracking

- Branch: `feat/computer-use`. Small commits per verified unit, merge not squash. PR evidence rules apply (screenshots per surface; video for the recorder, run-view, and web-task demos).
- Weekly checkpoint review against this doc; date changes are edits here.
