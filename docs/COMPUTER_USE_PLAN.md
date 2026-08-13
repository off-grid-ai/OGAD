# The proactive assistant - build plan and timeline

Companion to `COMPUTER_USE.md` (the product model), `ASSISTANT_ARCHITECTURE.md` (the system design), and `PORTING_MAP.md` (the port-vs-bespoke research).

> **This is the doc to build from.** Work release by release, top to bottom: a release is not done until its checkpoint passes, and the next release does not start until it does. The other three docs are references - *why* we build it (COMPUTER_USE), *how* the system is designed (ASSISTANT_ARCHITECTURE), and *what to port* (PORTING_MAP). This one is the what-to-do-next and in-what-order, and the single source of truth for schedule. Adjust the plan here at each checkpoint; never fork a second plan. Start at R1.

**Assumptions**

- Solo developer, AI authoring the code end to end, working fast.
- **Release-led.** The chat action tool ships first and gets released; every later capability layers on top of that released base. Each release is a real, demoable, shippable increment.
- **Desktop v1 is macOS + Windows, in scope from day 1.** The shared brain (`@offgrid/use`) and the browser rail are one codebase; the semantic, accessibility, and vision rails each get a per-OS adapter behind the `DeviceController` port.
- **Port the plumbing, build the product.** Everything is on-device and offline - no server, no Postgres, no network for the core loop. Each release names the specific projects it ports (all MIT / Apache-2.0 / BSD, all in-process); the full component-by-component map with licenses is `PORTING_MAP.md`. What stays bespoke is bespoke by nature (the Action contract, effect-verification, the resolve+confidence layer, the commitment-gap reasoner, the DeviceController), not by choice.
- **Schedule: a 10-working-day plan**, starting Wednesday, August 13, 2026; first release about day 4. R1 and R2 are cross-platform from day 1. R3 and R4 land macOS-first, with Windows parity for the two heavy native rails (routines, vision) as a short fast-follow after day 10.
- **The one thing no port shortens:** the Windows build / sign / notarize + `llama-server` Windows engine setup in R1 is net-new infrastructure and is the schedule floor.
- Checkpoint discipline: a checkpoint is a verifiable, demoable milestone; the next release does not start until it passes.
- **Order:** the reliable, memory-driven, low-risk layers first; the risky GUI automation and the grounding vision model last.

## Build guidelines (standing, all releases)

- **Design** - `off-grid-ai/brand` `DESIGN_PHILOSOPHY.md`: brutalist/terminal, Menlo, emerald-only accent, black/white base, hierarchy by size and weight not color, no gradients, no emojis. All values from `@offgrid/design` tokens. Desktop density per `docs/DESIGN.md`.
- **Copy** - `off-grid-ai/brand` `brand_tone_voice.md` + outcomes-first: no em dashes, no curly quotes, no exclamation marks, banned-word list applies.
- **Cross-platform from the seam.** Callers depend on the `DeviceController` port and the shared engine, never on a concrete OS. Windows build via electron-builder (code-sign + the `llama-server` Windows engine build) is set up in R1.
- **Port before writing.** Check `PORTING_MAP.md` / `COMPUTER_USE.md` Section 9 before building a rail or a spine piece from scratch; verify the license at the point of adoption; honor the AGPL / source-available avoid-list.

## Already shipped (the base R1 builds on)

- **Phase 0 - the approval seam.** `actions:proposeApproval` + the risk taxonomy (read / navigate / mutate / irreversible), backward-compatible with pro. TCC usage strings + apple-events entitlement. Landed.
- **Phase 1 - the semantic rail on macOS.** The native actions helper (calendar, reminders, contacts, Messages, Mail, open_url) behind `runNativeAction`, wired into the chat tool loop, mutations gated, shipped in CI, unit-tested. This is the execution layer R1 turns into a released, cross-platform tool.

## Timeline at a glance (10 working days)

| Release | Days | What ships | Ports (all in-process, offline) | Platforms |
| --- | --- | --- | --- | --- |
| R1. Chat actions (the tool) | 1 - 4 | Chat calls a gated, verified action tool; lands the durable spine + `DeviceController` port | **Spine:** XState + sqliteq/goqite + cockatiel + LangGraph interrupt pattern (spec: DBOS + Morling). **Emit:** llama.cpp GBNF + SAP + Instructor. **Tools:** MCP TS SDK. **Semantic:** macos-automator-mcp + MS Graph | macOS (mostly built) + new Windows semantic rail |
| R2. Notices you | 5 - 7 | Reasoning + resolve + gate; surfaces commitments, resolves from memory | sqlite-vec + LlamaIndex.TS memory blocks + Mem0 loop + Orama; embeddings via bundled llama-server; techniques: HippoRAG PPR, Zep bi-temporal | cross-platform (memory + LLM) |
| R3. Routines | 8 - 9 | Record-by-showing + self-healing, per-step-verified replay | OpenAdapt design (resolution ladder + postconditions); Playwright codegen (browser recorder) | macOS-first; Windows UIA fast-follow |
| R4. Hard cases | 10 | Browser rail + vision rail + safety pass | nanobrowser + browser-use + Stagehand (over Electron CDP); @ui-tars/sdk; robotjs/nut-fork; UI-TARS-1.5-7B; OmniParser v3 fallback | macOS + shared browser on both; Windows vision-input fast-follow |
| Windows heavy-rail parity | fast-follow | UI Automation routines + SendInput vision input | napi-rs over `uiautomation` crate + Terminator head-start | Windows |

The split: `shared` holds the durable cross-platform brain (reused by mobile later); this repo holds the rails, the recorder, the reasoning surfaces, and the product integration.

## R1 - chat actions, the tool (Days 1 - 4) - first release

Talk to the assistant in chat and it calls actions as gated, verified tools. Most of this exists on macOS (Phase 1); R1 turns it into a released, cross-platform foundation on a durable spine.

- **Land the durable spine (assemble, do not invent).** The chat action tool enqueues a durable Action that flows through validate -> gate -> execute -> verify. Assembled from: **XState** (the Action state machine, snapshot to SQLite), **sqliteq / goqite** (the durable queue, a table in our better-sqlite3 DB), **cockatiel / p-retry** (retry-once), and the **LangGraph.js `interrupt -> resume` pattern** for the approval pause (a library pattern, not a server). Design spec from **DBOS** semantics + **Gunnar Morling's SQLite durable-execution blueprint**. All in-process, no server.
- **Reliable Action emission.** Constrain the model's output with **llama.cpp GBNF / `response_format`** (already bundled), coerce near-misses with a **SAP** parser (ported from BAML), and **Instructor**-style validate-and-retry on the residue.
- **Connectors via the MCP TypeScript SDK** (port-wholesale) - the act surface.
- **The Windows semantic rail** behind the same port: mail/calendar via **Microsoft Graph**, open via the Windows shell, reminders via Microsoft To Do; macOS keeps **macos-automator-mcp**. iMessage maps to a Windows-appropriate target or is macOS-only in R1.
- **Windows build + sign + engine setup** (electron-builder, code-signing, the `llama-server` Windows build) - the one-time cost and the schedule floor.
- **Build (bespoke):** the Action schema, the pipeline glue that wires the four spine libraries together, the approval UX, the payload-binding.

**Checkpoint (day 4):** on both macOS and Windows, a chat ask calls the action tool and the action runs gated and verified through the semantic rail. Shipped as the first release.

## R2 - notices you: the reasoning + resolve layer (Days 5 - 7)

The magic, and the safest thing to add: memory + LLM + read-only context, no risky automation. Cross-platform for free.

- **Memory + retrieval (port).** Vector search via **sqlite-vec** (lives inside the better-sqlite3 DB we already ship - one file, one backup, no new process); the memory tier from **LlamaIndex.TS memory blocks**; dedup-on-write from **Mem0's** loop; hybrid (BM25 + vector) ranking from **Orama** for OCR'd names/filenames. Embeddings from the **bundled llama-server `/embedding`** (Transformers.js as fallback).
- **Techniques to reimplement (inspiration):** **HippoRAG's Personalized PageRank** over the entity graph for multi-hop resolve, **Zep/Graphiti bi-temporal facts** for the commitment lifecycle, and the **Microsoft WSDM 2019 commitment definition** ("sender-obligated + specific + not-yet-complete") as the LLM extraction rubric.
- **Build (bespoke):** the resolve layer returning `{value, confidence}`, the entity-resolution pipeline (talisman/fuzzball + LLM adjudication), and the **commitment-gap reasoner** - detecting the unmet promise by joining it against Replay observations (no prior art, defined over our spine).
- **Surface + gate:** proposals become suggestions; the approval card shows resolved values with evidence and confidence; low confidence -> disambiguate. Executes through the R1 tool. Suggest-only to start.

**Checkpoint (day 7):** on a seeded profile, on both OSes, the assistant surfaces an un-actioned commitment; approving "send the deck I promised" resolves the file from context and runs it via the R1 tool, gated. Zero GUI automation.

## R3 - routines: demonstration recorder + faithful replay (Days 8 - 9)

Record-by-showing and reliable replay. **Ports OpenAdapt by design** - its record -> deterministic self-healing replay is our design, already built and benchmarked, so this is two days of porting and wiring, not three of inventing. macOS-first; the Windows UI Automation adapter is the fast-follow.

- **Port (design):** the OpenAdapt compiled-step schema (template crop + OCR label + geometry + structural locator + **postconditions**) and its **resolution ladder** (structural tree -> local template -> global template -> OCR label -> landmark geometry -> optional local grounding model); healthy runs never leave rung 1 and make zero model calls; a successful lower rung is written back as a reviewable diff. Browser-lane recorder from **Playwright codegen**.
- **Build (bespoke):** memory-resolved variable slots (bind a slot to a memory query at run time), the plain-language review UI (reuse an existing viewer component), and the local-only postcondition oracle (verify via our memory layer, not the screen).

**Checkpoint (day 9):** on macOS, record a routine by showing it once; it replays with per-step verification, and a marked slot resolves from memory. The Windows UIA + SendInput adapter follows in the fast-follow.

## R4 - hard cases: browser rail + vision rail (Day 10) - full macOS v1

The supervised frontier. **Reuse-heavy**, which is why it fits in a day.

- **Browser rail (port):** **nanobrowser's** TS `dom/` module + overlay as starting code, **browser-use's** CDP snapshot + AX-merge + numeric-index as the algorithm, **Stagehand's** act/observe/extract + Zod as the API - all over Electron's native `webContents.debugger` (raw CDP, no Playwright dependency). Cross-platform on both OSes from the start.
- **Vision rail (port + model):** the desktop spine from **@ui-tars/sdk** (swap its nut.js operator for **`@nut-tree-fork`**), input via **robotjs / nut-fork**, and the grounding model **UI-TARS-1.5-7B** (Apache-2.0, GGUF + mmproj already published and mainline-runnable). **OmniParser v3** (MIT detector) as the set-of-marks fallback that lets the bundled gemma click without a grounder.
- **Build (bespoke):** the **DeviceController + rail-selection/fallback** policy (semantic -> browser -> accessibility -> vision), the WhatsApp file-share recipe, and the safety pass (injection review, kill-switch, release-readiness).

**Checkpoint (day 10):** on macOS, a web check-in runs in-pane with a takeover at login; the WhatsApp file-share runs supervised; a demonstrated routine recovers from a drifted step via vision; the safety checklist passes. Full macOS v1 plus the cross-platform core.

## Windows heavy-rail parity (fast-follow)

Two adapters trail the 10-day line, both behind the same `DeviceController` port so no caller changes:

- **Routines on Windows:** a **napi-rs addon over the `uiautomation` (leexgone) crate** for the tree + SendInput for input, with **Terminator (MIT)** as a Windows head-start; FlaUI / pywinauto are API references.
- **Vision input on Windows:** SendInput for the grounded clicks/keystrokes (the vision model and browser rail are already shared).

Estimated a couple of days once R3/R4 set the shape on macOS.

## The macOS accessibility read (build, with a head-start)

No pure-Node library reads the macOS AX tree; the accessibility rail's read side is a **napi-rs addon over the `axuielement` Rust crate** (MIT/Apache), with **MacosUseSDK** as a head-start. This lands with R3 (routines) on macOS and is the mac twin of the Windows `uiautomation` addon.

## Mobile (after v1, port-heavy)

An adapter-only project on the same `@offgrid/use` engine: **Appium via WebdriverIO** (the cross-platform actuation substrate), **DroidRun's AccessibilityService Portal** (host-free Android), **minitap/mobile-use's** multi-transport seam, and **GUI-Owl-1.5 / Qwen3-VL** as the mobile grounding model. iOS stays intents-only (Apple forbids driving other apps; on-device actuation needs a Mac-signed WDA).

## Dependencies

| What | Needed by | Note |
| --- | --- | --- |
| `desktop-pro` access | R2 | the reasoning engine, resolve layer, approvals + routines UI are pro |
| Sibling `../shared` + `../brand` clones | now | build requirement |
| Windows toolchain (electron-builder, code-sign cert, `llama-server` Windows build) | R1 | one-time; the schedule floor |
| Spine libraries (XState, sqliteq/goqite, cockatiel, MCP SDK) + SAP port | R1 | small, vendor/adapt |
| sqlite-vec + LlamaIndex.TS memory blocks | R2 | the memory/retrieval layer |
| OpenAdapt trace/replay port | R3 | the recorder + self-healing replay base |
| axuielement (macOS) napi addon | R3 | the mac AX read |
| nanobrowser + browser-use + @ui-tars/sdk ports | R4 | browser rail + vision spine |
| UI-TARS-1.5-7B GGUF + mmproj | R4 | the grounding model |
| `uiautomation` crate napi addon + Terminator | fast-follow | Windows AX read |

## Risks

| Risk | Mitigation |
| --- | --- |
| Compressed tail (R3 = 2 days, R4 = 1 day) assumes ports drop in cleanly | ports are permissive and proven (OpenAdapt benchmarked; nanobrowser/UI-TARS in production); R4 is the slip-absorber; the released core (R1-R2) is unaffected |
| Windows build / sign / engine setup is net-new and unshortenable | folded into R1 as a one-time cost, before any Windows rail work depends on it |
| Spine assembly (four libs + glue) is more moving parts than one lib | each piece is small, MIT, in-process; the glue is spec'd from DBOS/Morling, not invented; covered by tests per branch |
| Windows parity stretches the tail | R1/R2 cross-platform on the line; the two heavy native rails trail as a scoped fast-follow behind the port; the browser rail is shared |
| Detection precision / confident-but-wrong resolution | confidence bar; suggest-only until trusted; the gate shows resolved values; reversibility for auto-run |
| GUI automation reliability | cheaper rails first; demonstrated traces over novel automation; OpenAdapt self-heal; honest confidence |
| Local model tool-calling reliability | grammar-constrained + SAP + retry; the durable queue makes a bad turn a no-op |
| Solo schedule: a blocked day is a lost day | releases are independently valuable; a slip trims scope at the tail, never the released core |

## Out of scope for v1

The mobile adapter, background / headless autonomous runs, chat-channel control surfaces, and store distribution (macOS Developer ID direct; Windows outside the Store). Windows is in scope for desktop v1 from day 1.

## Tracking

- Branch: `feat/computer-use`. Small commits per verified unit, merge not squash. PR evidence rules apply (screenshots per surface; video for the recorder, run-view, and web-task demos).
- Checkpoint review against this doc at each release; plan changes are edits here.
