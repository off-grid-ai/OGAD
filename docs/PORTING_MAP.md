# Porting map - what we port vs what we build (deep prior-art research)

**Status:** August 13, 2026. Answering the lead: "people must have already built stuff like this - what can we port instead of building?" This is the deep sweep across every layer of the assistant, with a blunt verdict per component. Companion to `COMPUTER_USE.md` (Section 9 is the curated shortlist), `ASSISTANT_ARCHITECTURE.md`, and `COMPUTER_USE_PLAN.md`.

## The answer in one paragraph

The lead is right, and the honest split matters: **we port the plumbing and keep the product.** Almost every mechanism we need exists as a permissively licensed open project - a durable-queue pattern, a state machine, constrained decoding, a vector store, a record-and-replay engine, the rails, the grounding models. What does NOT exist off the shelf is the thing that makes this product: a single-process, offline, on-device pipeline that joins actions to a personal screen-memory, gates them behind human approval, and verifies their effect. So the plan is: **assemble the pipeline from small permissive libraries + documented blueprints, and write only the product-defining glue** (the Action contract, the approval policy, the resolve-with-confidence layer, the commitment-gap reasoner, effect-verification, and the DeviceController + rail-selection). That glue is bespoke by nature - no upstream targets a single-process offline device wired to a personal memory - not by choice.

**Verdict legend:** `port-wholesale` (adopt/vendor the code), `port-components` (lift specific modules/algorithms), `port-design` (reimplement its architecture), `inspiration-only` (study, don't copy), `adopt-as-model` (ship the weights), `bespoke` (must build - explained why).

**Method:** five parallel research tracks (durable execution/HITL, agent brain/tool-calling, memory/resolve/proactive, record-replay/routines, rails/grounding-models), licenses verified per project.

---

## 1. The durable action queue + state machine + scheduling + approval gate

The lead's exact example. Finding: **durable execution is heavily built - but every mature engine is a server backed by Postgres/Cassandra/Kafka**, which is a non-starter for a single-process offline app (the same "bundled sidecar" fragility as the llama-server saga). No embeddable engine bundles queue + state machine + approval + verify. So we assemble it.

| Need | Port from | License | Local-first fit | Verdict | What we take |
| --- | --- | --- | --- | --- | --- |
| Action state machine | **XState v5** | MIT | Yes, zero-dep, runs on RN too | **port-wholesale** | Each Action's lifecycle as a persisted statechart; `getPersistedSnapshot()` -> SQLite, rehydrate on launch; same machine on future mobile core |
| (lighter alt) | robot3 | BSD-2 | Yes, 3kb | port-components | If XState feels heavy; you write the serialize/restore glue |
| Durable SQLite queue | **sqliteq** (TS port of **goqite**) | MIT | Yes, better-sqlite3 | **port-wholesale** (transport) | SQS-style leased-message + visibility-timeout + auto-extend + retry loop |
| Scheduling (cron/delay) | plainjob | MIT | Yes, better-sqlite3 | port-components | Cron + delayed jobs; worker-death -> re-queue |
| Idempotent enqueue | better-queue-sqlite | MIT | Yes | port-components | Task-merge/dedup by id |
| Retry-once / resilience | **cockatiel** or **p-retry** | MIT | Yes, zero-dep | **port-wholesale** | Retry-once is a one-line policy; circuit-breaker/timeout free for connector calls |
| Approval gate (HITL) | **LangGraph.js** `interrupt -> resume` | MIT | Yes (checkpoint-sqlite) | port-components | The pause-before-side-effect -> surface proposed Action -> resume-from-checkpoint contract; do it locally against our own UI |
| HITL outcome model | HumanLayer | Apache-2.0 | No (cloud broker) | inspiration-only | The typed approve/deny/respond contract; de-couple request from response |
| Design spec | **DBOS Transact** semantics + **Gunnar Morling's "durable execution on SQLite"** blueprint | MIT / blog | reference | port-design | `(action_id, step)` PK, status per step, replay COMPLETE steps, idempotency key forwarded to side effects; Morling's PoC is near copy-paste |

**Not viable for local-first (server + external DB, or license):** Temporal (MIT, needs Cassandra/Postgres), DBOS-TS (MIT, Postgres-bound - Go build has SQLite, TS not yet), OpenWorkflow (Apache-2.0, in-process TS step-checkpointing - the right shape, but Postgres-only today with SQLite "coming soon", early and fast-moving, and no approval/HITL or risk-aware retry; its step.run ergonomics are a design reference for our engine facade), Restate (**BUSL-1.1** runtime), Inngest (**SSPL** server), Trigger.dev (Postgres+Redis+Docker), Windmill (**AGPL** + Postgres), LittleHorse (**AGPL** + Kafka), Hatchet/Cadence/Resonate (all server). Their *semantics* are the gift; their deployment model is the disqualifier. **Re-evaluate list:** DBOS-TS and OpenWorkflow, if either ships a solid SQLite backend.

**Bespoke (build it, ~a few hundred lines):**
- The orchestration glue that wires queue -> state machine -> approval -> execute -> verify. No library combines all five on-device.
- **Effect-verification** - "did the email actually send / the file actually move" - has **zero prior-art library**; it's inherently per-connector (read-back, re-query). Ours.
- The crash-after-execute-before-record window, closed with idempotency keys on the outbound side effect (every engine concedes this and solves it the same way).
- The checkpointer/queue adapter against our existing better-sqlite3 handle (SSOT: one DB answers "what is this Action's state").

---

## 2. The agent brain: constrained output, reliability, loop, router, tools

Finding: **we already ship the best-fit constrained-decoding engine.** llama.cpp does JSON-schema -> GBNF and `response_format` grammar-constraining today. Most of this track is thin layers on top, in TypeScript.

| Need | Port from | License | Local fit | Verdict | What we take |
| --- | --- | --- | --- | --- | --- |
| Constrain Action shape | **llama.cpp GBNF / `response_format`** (already bundled) | MIT | Yes | **port-wholesale** | Send the Action schema as `json_schema`; the model cannot emit invalid-shaped Action JSON. Gotcha: schema is NOT injected into the prompt - still describe the tool enum in the system prompt |
| Native tool-calling | llama-server `--jinja` lazy grammars | MIT | Yes | port-wholesale | Optional OpenAI-style `tools` mode for models with a good native template; prefer our own single-Action grammar for determinism |
| Weak-model reliability | **Schema-Aligned Parsing (SAP), from BAML** | Apache-2.0 | Yes | **port-components** | The single biggest weak-model jump in the literature (e.g. 19.8% -> 92.4%): coerce sloppy-but-close output to schema post-hoc. Reimplement a focused TS coercer keyed to the Action schema |
| Validate + retry | Instructor-JS pattern | MIT | Yes | port-components | Zod validate -> feed the error back -> re-ask, bounded to N. ~50 lines |
| Wrapper patterns | node-llama-cpp | MIT | Yes | port-components | The ChatWrapper seam (per-model template behind one interface) + optional-param grammar handling |
| Faster CFG engine | llguidance | MIT | Yes (build flag) | reserve | `-DLLAMA_LLGUIDANCE=ON` only if native GBNF coverage/perf bites; adds a build-gate surface, defer |
| Agent loop | LangGraph.js pattern | MIT | Yes | port-components | Checkpointed LLM-node <-> tool-node <-> conditional-edge loop; reimplement, don't take the LangChain dep |
| Router seam | Mastra (Apache core) / VoltAgent (MIT) | Apache/MIT | Yes | port-components | One interface over interchangeable model backends (our DSP rule). VoltAgent is MIT+TS+MCP+Zod - copy concrete code |
| Cheap-first routing | semantic-router concept | MIT (Python) | reimplement | port-components | Embedding-similarity intent classifier as the router's fast lane; skip the LLM when confident. Reimplement in TS over our local-embedding path |
| Connectors / tools | **MCP TypeScript SDK** | MIT/Apache-2.0 | Yes | **port-wholesale** | The whole client/server tool transport; this is our act surface, don't reinvent |

**Model choice (verify per-checkpoint license before bundling):** function-calling-tuned small models - Salesforce xLAM-2, Hammer 2.1, NousResearch Hermes (native XML tool parser in llama-server), MeetKai functionary - picked on the Berkeley Function-Calling Leaderboard, not vibes.

**Inspiration-only (Python, or wrong runtime):** Outlines/outlines-core, guidance, LMQL, jsonformer (Python), XGrammar (MLC not llama.cpp), Agent-S (Python, feeds the vision rail).

**Bespoke:** the Action schema + durable pipeline (the SSOT for "what the agent is doing"); approval-gated execution + the privacy boundary; the router *policy* tuned to our bundled model's real behavior; the SAP coercion rules + retry prompts wired to our Action contract; the engine-health/stderr-classification path (`llama-error.ts` has no upstream equivalent).

---

## 3. Memory + resolve/RAG + commitment/proactive detection

Finding: the vector layer is a clean port; the "memory frameworks" are mostly Python (algorithm inspiration, not code); commitment/proactive detection is **genuinely bespoke** over our Replay spine.

| Need | Port from | License | Local fit | Verdict | What we take |
| --- | --- | --- | --- | --- | --- |
| Vector store | **sqlite-vec** | Apache-2.0 / MIT | Yes, inside better-sqlite3 | **port-wholesale** | Vector KNN in the SAME DB file we already ship - one file, one transaction, one backup, no new process. Highest-value, lowest-risk port |
| Scaling alt | LanceDB (`@lancedb/lancedb`) | Apache-2.0 | Yes, embedded Node | port-wholesale (alt) | Real ANN when the corpus outgrows brute-force KNN (a second store to keep in sync - an SSOT tax) |
| Embeddings | bundled **llama-server `/embedding`** first; **Transformers.js** fallback | MIT / Apache-2.0 | Yes | port-wholesale | Reuse the endpoint we ship; Transformers.js (ONNX MiniLM/bge) if we want embeddings off the LLM's critical path |
| Memory-tier skeleton | **LlamaIndex.TS Memory Blocks** | MIT | Yes, TS-native | port-components | Write-time fact-extraction + short-term -> long-term + read-optimized; the only mature MIT TS-native option |
| Consolidation loop | Mem0 (has a TS SDK) | Apache-2.0 | partial (TS) | port-components | The ADD/UPDATE/DELETE dedup-on-write loop so memory doesn't bloat |
| Hybrid ranking | Orama | Apache-2.0 | Yes, TS | port-components | BM25 + vector fusion - lexical recall matters for OCR'd names/filenames/errors |
| Entity dedup (deterministic) | talisman + fuzzball.js | MIT | Yes, TS | port-components | Phonetics, Jaro-Winkler, blocking - the deterministic side of entity resolution |
| Multi-hop resolve (technique) | HippoRAG Personalized PageRank | MIT (Python) | reimplement | inspiration | PPR over the entity graph for "the deck" -> project -> file, instead of flat top-k |
| Memory linking (technique) | A-MEM Zettelkasten | MIT (Python) | reimplement | inspiration | Atomic note + keywords + auto-link + "evolution" rewrite of neighbors |
| Commitment lifecycle (concept) | Zep/Graphiti bi-temporal facts | Apache-2.0 | concept | inspiration | valid-from/valid-to per fact; new facts invalidate old - the backbone the commitment tracker needs |
| Capture triggers (concept) | Screenpipe | **source-available now (flag)** | concept only | inspiration | Event-driven capture (app-switch/click/pause) + accessibility-first, OCR-fallback. Its current tree is off-limits; take the ideas |
| Commitment detection (technique) | Microsoft WSDM 2019 definition | paper (patented method - note IP) | reimplement | inspiration | "sender-obligated + specific + not-yet-complete" as the LLM extraction rubric; commitment language is domain-independent so a small local model generalizes (~0.75 F1 is the bar) |

**License flags (study only, no code into our permissive pro tier):** Reor, Khoj, OpenRecall (**AGPL**); Screenpipe (**source-available/commercial** post-2026-06); Letta / Zep-platform (server / proprietary).

**Bespoke:** the RESOLVE layer returning `{value, confidence}` for a slot (no library does retrieval + slot-value + calibrated confidence); the entity-resolution pipeline (assembled from primitives, not adopted); and above all **the commitment-gap reasoner** - detecting the *unmet* commitment by joining it against captured observations and entity timelines has no prior art because it's defined entirely over our data model.

---

## 4. Routines: record-and-replay (programming-by-demonstration)

Finding: **OpenAdapt is an almost-exact architectural twin of our routines rail** - MIT, local-first, the same loop (record -> compile to anchored self-healing trace -> zero model calls on healthy runs -> local model only to repair drift -> halt instead of guess -> verify against a system of record). It's Python, so this is a **port-design** (reimplement in TS), not a code lift.

| Need | Port from | License | Verdict | What we take |
| --- | --- | --- | --- | --- |
| Recorder + replay spine | **OpenAdapt / openadapt-flow** | MIT | **port-design** | The compiled-step schema (template crop + OCR label + geometry + structural locator + **postconditions**), the resolution ladder, system-of-record verification (their data: screen-only verify accepted wrong effects 75% of the time -> 12.5% with a system-of-record oracle), halt-on-uncertainty, repair-as-reviewable-diff |
| Self-heal technique | OpenAdapt resolution ladder (+ Healenium DOM tree-similarity, SikuliX OpenCV+Tesseract) | MIT / Apache-2.0 / MIT | port-design | Resolve each step by trying anchors in strict order (structural tree -> local template -> global template -> OCR label -> landmark geometry -> optional local grounding model); healthy runs never leave rung 1; write successful lower-rung resolutions back as a diff |
| Browser recorder | Playwright codegen | Apache-2.0 | port-components | Native TS recorder + its locator-priority heuristic (role -> text/label -> testid -> CSS) as the browser-lane anchor order |
| Browser trace format | Chrome DevTools Recorder `steps[]` | Apache-2.0 | inspiration | Per-step *array of alternative selectors* - a standardized "multiple anchors per step" schema to align to |
| Browser variable slots | browser-use workflow-use | **AGPL (flag)** | inspiration-only | The typed variable-slot idea; do NOT vendor the code, especially into pro |
| Mobile format | Maestro YAML flows | Apache-2.0 | inspiration | Human-readable flow format for the plain-language review surface + resilient text/id/AX matching |
| macOS AX recorder ref | open-record-replay | MIT | inspiration | Clean `events.jsonl` + AX-diff schema, AX-tree-as-primary-anchor |
| Multi-anchor capture | record-and-replay-skill | MIT | port-components | Recording several selectors per action (testId -> role+name -> id -> text -> css) so replay degrades gracefully |

**Bespoke:** memory-resolved variable slots (every project treats variables as literals or LLM-extracted or manual; binding a slot to a memory query at run time is ours); the plain-language review UI (reuse an existing viewer component, don't fork); the TS-native cross-substrate recorder/runtime (OpenAdapt is Python; we need the ladder across macOS AX, browser CDP, later mobile); the local-only postcondition oracle (verify via our memory/observation layer, not the screen).

---

## 5. The rails (actuation) - desktop + mobile

Finding: input is a solved permissive dependency; the browser rail is free via Electron's CDP; the accessibility-tree read is a build-our-own napi-rs (Rust) addon with head-starts; the semantic rail is bespoke OS glue. **Convergent insight:** every rail's agent-facing contract is the same - a serialized element list with stable IDs, act-by-ID (browser-use's numeric index = Playwright's `ref` = Agent-S's ACI = the vision model's box). Design ONE DeviceController vocabulary; the vision rail manufactures the same IDs from pixels when no tree exists.

| Rail | Port from | License | Verdict | What we take |
| --- | --- | --- | --- | --- |
| Desktop spine | **`@ui-tars/sdk`** (UI-TARS-desktop) | Apache-2.0 | port-components | The GUIAgent loop + `Operator` interface + coordinate scaling, in Electron+TS, local-model-ready. **Swap its nut.js operator for `@nut-tree-fork`** |
| Spine design | Agent-S/S2 ACI + a11y/vision fusion; Anthropic computer-use tool-schema + coord-scaling | Apache-2.0 / MIT | port-design | Accessibility-tree + vision fusion (the reliability lever for a weak model); the action vocabulary + normalized-coordinate convention |
| Desktop input | **robotjs** (revived, prebuilds) or **`@nut-tree-fork/nut-js`** | MIT / Apache-2.0 | adopt-as-dependency | Synthetic mouse/keyboard + capture (+ template match on the fork). **Avoid official `@nut-tree/*` - paid EULA** |
| Input (longevity) | enigo via napi-rs | MIT | port-components | Self-owned Rust input layer if we build our own addon |
| Desktop a11y read | **napi-rs addon over `axuielement` (macOS) + `uiautomation` (Windows) crates**; **Terminator** (Windows) + MacosUseSDK head-starts | MIT / Apache-2.0 | port-components / bespoke | No pure-Node lib reads both trees; FlaUI (.NET) / pywinauto (Python) are API references only |
| Browser rail | **nanobrowser** `dom/` module + overlay (starting code) + **browser-use** CDP snapshot/AX-merge/numeric-index (algorithm) + **Stagehand** act/observe/extract + Zod (API) | Apache-2.0 / MIT / MIT | port-components | All over Electron `webContents.debugger` (raw CDP - no Playwright dependency needed) |
| Mobile substrate | **Appium via WebdriverIO** | Apache-2.0 / MIT | adopt-as-dependency | One W3C protocol over iOS (WDA/XCTest) + Android (UiAutomator2), TS client, local, model-independent |
| Android host-free | DroidRun AccessibilityService "Portal" | MIT | port-components | On-device a11y-tree read + gesture dispatch with no host attached |
| Mobile seam | minitap/mobile-use | Apache-2.0 | port-components | Provider-agnostic model layer + multi-transport (ADB/idb/Appium) behind one interface |

**Not viable:** official nut.js (paid EULA), Open Interpreter OS mode (AGPL + abandoned), Skyvern (AGPL, browser-only), Sonic (AGPL), c/ua (Python + VM-first).

**Bespoke:** the semantic rail entirely (AppleScript/JXA, App Intents/Shortcuts, Microsoft Graph, deep links, Android intents - OS SDK glue behind the interface); the unified **DeviceController + rail-selection/fallback policy** (semantic -> browser -> accessibility -> vision - no prior art has all four behind one interface); the macOS-AX + Windows-UIA napi addon; **iOS on-device actuation** (genuinely needs a Mac-signed WDA/XCTest helper reached over USB - a permanent Apple constraint, plan the product around it).

---

## 6. Grounding vision models (the vision rail's model)

Finding: llama.cpp multimodal is real but base-gated (Qwen2-VL / Qwen2.5-VL / Qwen3-VL / InternVL / SmolVLM / Gemma 3 / Pixtral). A grounder is GGUF-runnable iff its base is one of these AND someone converted it.

| Use | Model | Weights license | GGUF today? | Verdict |
| --- | --- | --- | --- | --- |
| **Desktop default** | **UI-TARS-1.5-7B** (Qwen2.5-VL base) | **Apache-2.0** | **Yes, published + mainline** | **adopt-as-model** - the only turnkey pick, no conversion work; ScreenSpot-V2 ~94% |
| Desktop 2nd | Holo1.5-7B (Qwen2.5-VL) | Apache-2.0 (7B only) | convertible | adopt-with-conversion - strong on ScreenSpot-Pro; avoid the 72B (research license) |
| **Mobile best** | **GUI-Owl-1.5-8B/4B** (Qwen3-VL) | **MIT** | needs one-time conversion | adopt-with-conversion - best open mobile grounding, multi-platform; OSWorld-Verified 52.3, AndroidWorld 69.0 |
| Mobile zero-conversion | Qwen3-VL-8B-Instruct | Apache-2.0 | Yes, official GGUF | adopt-as-model - ship day one, prompt/finetune for grounding; also the natural finetune target if we train our own |
| Pure-vision fallback (set-of-marks for a non-grounding LLM) | OmniParser **v3** detector (YOLOv9) + Florence-2 captioner | **MIT** (v3) | ONNX (not llama.cpp) | adopt-components - lets our bundled gemma click via labeled boxes. **Avoid v1/v2 icon_detect (AGPL YOLOv8)** |

**Avoid (license or no GGUF path):** Qwen2.5-VL 3B/72B (research), Holo 72B (research), CogAgent (GLM-4V, non-commercial, no GGUF), Ferret-UI (Apple, non-commercial), SeeClick (Qwen-VL research), Aria-UI (custom MoE, no GGUF), OS-Atlas-4B (InternVL2 base, no safe GGUF), the closed UI-TARS-1.5 flagship.

**Bespoke:** the GGUF + mmproj conversion + a ScreenSpot re-eval after quantization for any grounder beyond the turnkey UI-TARS-1.5-7B / Qwen3-VL (routine, but ours to own).

---

## 7. The whole system, at a glance

**Port these (the plumbing):**

- Queue/state: **XState** + **sqliteq/goqite** + **plainjob** + **cockatiel** + **LangGraph interrupt contract**, spec'd from **DBOS + Morling**.
- Brain: **llama.cpp GBNF** (shipped) + **SAP (BAML)** + **Instructor retry** + **MCP TS SDK** + router seam from **Mastra/VoltAgent**.
- Memory: **sqlite-vec** + **LlamaIndex.TS memory blocks** + **Mem0 loop** + **Orama** hybrid ranking; techniques from **HippoRAG / A-MEM / Graphiti**.
- Routines: **OpenAdapt** design (resolution ladder + postconditions + self-heal), **Playwright/DevTools** for the browser lane.
- Rails: **@ui-tars/sdk** + **robotjs/nut-fork** + **nanobrowser/browser-use/Stagehand** over Electron CDP + **Appium/WebdriverIO** + **DroidRun Portal**; a napi-rs a11y addon over **axuielement/uiautomation** with **Terminator** head-start.
- Models: **UI-TARS-1.5-7B** (desktop), **GUI-Owl-1.5 / Qwen3-VL-8B** (mobile), **OmniParser v3** (fallback).

**Build these (the product - bespoke by nature):**

1. The **Action contract + durable pipeline** (queue -> FSM -> gate -> execute -> verify glue).
2. **Effect-verification** per connector (zero prior art anywhere) - lands in the R1 spine (the machine's verifying state + per-handler verify); R4's router only escalates through it, never rebuilds it.
3. The **resolve layer** returning `{value, confidence}`.
4. The **commitment-gap reasoner** (join a commitment against Replay observations).
5. The unified **DeviceController + rail-selection/fallback** policy.
6. The **macOS-AX + Windows-UIA napi-rs addon**.
7. The **approval-gate UX + privacy boundary** (nothing leaves the device).
8. **iOS on-device actuation** (Mac-signed WDA constraint).

None of the bespoke items is NIH - each is bespoke because no upstream targets a single-process, offline, on-device app wired to a personal screen-memory. That is exactly the product.

## 8. License avoid-list (carry forward)

- **AGPL** (no code into the permissive pro tier): browser-use workflow-use, Skyvern, Open Interpreter OS mode, Windmill, LittleHorse, Reor, Khoj, OpenRecall, Sonic, OmniParser v1/v2 icon_detect (YOLOv8).
- **Source-available / SSPL / BUSL** (avoid depending): Screenpipe (post-2026-06), Inngest server (SSPL), Restate runtime (BUSL-1.1).
- **Paid EULA:** official `@nut-tree/*` nut.js (use `@nut-tree-fork`).
- **Non-commercial model weights** (do not bundle): Qwen2.5-VL 3B/72B, Holo 72B, CogAgent, Ferret-UI, SeeClick, the UI-TARS-1.5 flagship, xLAM/Hammer (verify per checkpoint).
- **Mixed/enterprise:** Mastra (use Apache-2.0 core only), Zep platform, Letta.

Everything in the "port" column is MIT / Apache-2.0 / BSD. Verify each license at the point of adoption; a couple ask for attribution (minitap/mobile-use).
