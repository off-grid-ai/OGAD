# Computer use - replicate the mobile-use stack on desktop

**Status:** direction decided August 11, 2026. Intents + MCP are the primary action paths; the vision-based agent is the fallback. We do not innovate on agent architecture - we study the mobile-use ecosystem and replicate it. The engine is built in the shared repo (`off-grid-ai/shared`) as an `@offgrid/*` package. Model size is not a design constraint - local models keep improving and the vision model ships as a downloadable catalog entry.
**Constraint (standing):** local models only. No hosted APIs. No screenshot ever leaves the device.

---

## 1. The decision

The agent executes actions on the user's Mac - from "create a calendar event Thursday 3pm" to "pick the best photo from the vacation album in the family WhatsApp chat and send it". The decided shape:

1. **Intents + MCP first.** Deterministic action surfaces - MCP connectors, URL schemes, AppleScript/Apple Events, EventKit and friends, Shortcuts - handle everything they can. No pixels, no coordinates.
2. **Vision-based agent as fallback.** When no deterministic surface exists, a multi-agent GUI loop takes over, perceiving through the accessibility tree plus screenshots and acting through synthetic input.
3. **Replicate, do not invent.** The mobile-use ecosystem solved this problem in 2025-26 with measured results (100% on AndroidWorld). We port its architecture to macOS.
4. **Engine in shared.** The agent loop, action schema, router, and verification logic are platform-agnostic and land as a package in `off-grid-ai/shared`, with a desktop adapter in this repo - the same engine + adapter split `@offgrid/clipboard` already uses. A mobile adapter can follow later.

## 2. What we are replicating

Three systems define the mobile-use pattern; their published numbers are the calibration:

| System | What it is | Score | License |
| --- | --- | --- | --- |
| **minitap/mobile-use** | multi-agent framework (LangGraph-style), a11y-tree-primary + vision-selective | **100% AndroidWorld** (116/116; human ~80%) | Apache-2.0 |
| **mobilerun** (ex-droidrun) | Manager/Executor framework over an on-device accessibility portal | 91.4% AndroidWorld | MIT |
| **Alibaba Mobile-Agent-v3 / GUI-Owl-1.5** | 4-role framework + open-weight GUI models (2B-32B, Qwen3-VL base) | 73.3% AndroidWorld; GUI-Owl-1.5 is open SOTA on desktop (56.5 OSWorld) | MIT weights |

The field converged on one architecture, and it matches the decided direction exactly:

- **Route to the cheapest surface.** Deterministic path if one exists (MCP, CLI, deep link/intent) - structured UI action second - vision-grounded action last. The 2026 benchmarks (MobileWorld, PhoneHarness, OSWorld-MCP) all show hybrid routing beating GUI-only.
- **A11y tree is the primary perception, vision is selective.** mobilerun's measurement: the tree is ~2 KB against ~1 MB screenshots - smaller, faster, semantically richer. The decision model receives tree and screenshot together; structure targets, pixels disambiguate.
- **Cognitive separation across small agents.** Role-scoped contexts, most roles on small models, one strong vision model where it counts. minitap's ablation: this separation alone is worth +21 points.
- **Deterministic verification.** Fragile operations (typing) are verified procedures: act, re-read device state, diff. Worth +7 points. A reflector step classifies each transition SUCCESS/FAILURE and feeds replanning. Cycle detection with forced strategy change is worth +9.

### 2.1 The loop (minitap's graph, the richest reference)

| Role | Job | Model class needed |
| --- | --- | --- |
| Planner | decompose the goal into ordered subgoals | small text model |
| Orchestrator | subgoal lifecycle (pending / in-progress / completed / failed), decides what runs next | small text model |
| Contextor | fetch fresh device state before each decision: a11y tree + screenshot + focused app | small text model |
| **Cortex** | the one decision maker: gets tree + screenshot, emits one structured JSON decision; detects action cycles and forces strategy changes | **the strong vision model** |
| Executor | parse the decision into concrete tool calls, deterministically - no free-form reasoning | none (code) |
| Summarizer | compact history so context never overflows | small text model |
| Reflector (Mobile-Agent-v3) | compare intended vs actual state transition, SUCCESS/FAILURE + diagnosis | vision model |
| Notetaker (Mobile-Agent-v3) | persist critical on-screen facts (codes, names) across subgoals | small text model |

The 100% AndroidWorld run mixed models per role and only the Cortex was frontier-grade. That maps directly onto our stack: bundled Gemma runs planner/orchestrator/contextor/summarizer; the downloadable vision model runs Cortex and Reflector.

### 2.2 The action schema

A small closed enum with structured arguments, not an open toolbox. mobilerun ships nine tools: `click, long_press, type, system_button, swipe, open_app, get_state, take_screenshot, complete`. Mobile-Agent-v3's desktop set: `key, type, mouse_move, click, drag, right_click, middle_click, double_click, scroll, wait, terminate`. Element targeting always has a fallback chain: stable ID - text match - coordinates. We adopt the same shape (our chain: AXIdentifier/role+title - text match - coordinates).

## 3. Desktop translation - what maps, what does not

The macOS automation research (unchanged, still the ground truth for the adapter):

| Mobile concept | macOS equivalent |
| --- | --- |
| Accessibility portal APK / UIAutomator2 / ADB | none needed - our app runs on the target machine and IS the portal: `AXUIElement` (read + `AXPress` + set `AXValue`), `CGEvent` post, ScreenCaptureKit capture we already have |
| Android intents / deep links | URL schemes (`open -u`), `open -b <bundle-id>` launch, AppleScript/Apple Events, `shortcuts run` (App Intents), MCP connectors |
| `resource-id` targeting | AXIdentifier / AXRole+AXTitle - text - coordinates |
| One fullscreen app | multi-window, multi-display, z-order: window-scoped capture + per-window AX trees; Retina points-vs-pixels scaling (2x) handled in the adapter |
| Uniformly rich Android a11y trees | uneven: AppKit good, Electron needs `AXManualAccessibility` poked on (Electron 25+), Catalyst varies, canvas apps expose nothing. **The vision fallback carries a larger share of steps on macOS than on Android - which is why the vision model is a first-class component, not an afterthought** |
| Sideloaded accessibility service | TCC permissions: Accessibility (AX + CGEvent), Automation per target app (`com.apple.security.automation.apple-events` entitlement + usage strings in the build), Calendars/Contacts/Photos usage keys, Screen Recording (held). Sequenced behind an explicit onboarding |
| AndroidWorld benchmark | OSWorld-Verified + OSWorld-MCP + macOSWorld for sanity checks. Expect desktop scores 20-30 points below mobile headlines for the same models - desktop is the harder domain |

Known hard target, kept as the acceptance case: WhatsApp Desktop (Catalyst, near-dead AX tree). Route: `whatsapp://send?phone=...` URL scheme to open the chat (intent path), keyboard-first navigation, vision-grounded clicks for the gaps, photo ranking by the vision model, the send click behind the approval gate.

## 4. Models

No size constraint. The vision model is a downloadable catalog entry (our catalog already gates on RAM and ships mmproj projectors), and it is swappable as the space improves - which it does quarterly.

| Model | Sizes | License | Why | Scores |
| --- | --- | --- | --- | --- |
| **GUI-Owl-1.5** (Alibaba) | 2B/4B/8B/32B, Instruct + Thinking | MIT, Qwen3-VL base (llama.cpp-supported) | trained natively for desktop + mobile + browser; best open desktop numbers | family 56.5 OSWorld; 8B-Instruct: 52.3 OSWorld-Verified, 69.0 AndroidWorld |
| **Holo3.1** (H Company) | 0.8B-9B dense, 35B-A3B MoE | Apache-2.0, official Q4 GGUF | built for local: ~140 ms step time, MoE decodes fast | 79.3 AndroidWorld (35B-A3B), 71.0 (4B) |
| UI-TARS-2 lineage | 7B+ | Apache-2.0 stack | single-model alternative if we ever want end-to-end | 47.5 OSWorld |

Working recommendation: **GUI-Owl-1.5-8B-Instruct as the default Cortex/Reflector model** (MIT, best desktop training), 32B for big Macs, Holo3.1 as the speed-focused alternative; bundled Gemma for every other role. Decide in review; the engine treats the model as per-role config (minitap's `llm-config` pattern), so this is not a one-way door.

## 5. Where the code lives

### 5.1 `@offgrid/use` - new package in `off-grid-ai/shared`

Platform-agnostic engine, mirroring the `@offgrid/clipboard` engine + adapter pattern and slotting into the roadmap's syscalls layer next to `@offgrid/skills`:

- the agent graph (planner / orchestrator / contextor / cortex / executor / summarizer / reflector / notetaker) with per-role model config against an OpenAI-compatible endpoint (our gateway)
- the closed action schema + structured decision types
- the router: deterministic surface - structured UI - vision, chosen by the orchestrator
- verification: deterministic post-condition checks, SUCCESS/FAILURE reflection, cycle detection
- risk classification + an approval-callback seam (the host app decides how approval happens)
- a `DeviceController` interface the platform adapters implement: `getState()` (serialized tree + screenshot + focused app), `act(action)`, `openIntent(url)`, `listSemanticSurfaces()`

Tested in the package against a fake `DeviceController` before any surface wires it in (the shared repo's standing rule).

### 5.2 Desktop adapter - this repo

| Seam | Today | Change |
| --- | --- | --- |
| Swift helper | AX read-only (`electron/accessibility/main.swift`); CGEvent tap listens only | add `AXUIElementPerformAction`, set-`AXValue`, `AXManualAccessibility` wake, `CGEvent` post, indexed-element serialization; same `execFile` pattern as `src/main/ocr.ts` |
| Perception | `src/main/vision.ts` capture + Vision-framework OCR | window-scoped capture into `getState()`; OCR emits `{text, bbox}` |
| Semantic surfaces | MCP connectors via `ToolExtension` (`src/main/tools.ts:401`) | add EventKit/Contacts/PhotoKit Swift-helper tools, AppleScript tools, `shortcuts run`, URL-scheme opener |
| Tool dispatch | agentic loop `toolChat`, abort guard already drops unexecuted side effects on cancel | the use-engine runs as a new extension; `ToolResult` side channel (`src/main/tools.ts:50`) extended so state fetches can return images |
| Approvals | `mcp:proposeApproval` hook, name-regex risk | widen to transport-agnostic `actions:proposeApproval` with `{kind, title, risk, args, source}`; engine supplies per-action risk |
| Scheduling | capture at modality-queue tier 3 | agent actions at tier 2 alongside chat, so background capture cannot evict the model mid-task |
| Packaging | Developer ID + hardened runtime | apple-events entitlement + usage-description keys |

Open-core: helper primitives and adapter plumbing in core; the wired agent surface and approvals integration follow the existing pro spine. `pro/` changes land in `desktop-pro` first, submodule bump after.

## 6. Safety

The shipped-product template is Gemini Intelligence's UX, which matches our approvals spine:

- agent acts only on explicit user start; always-visible progress with a hard stop (user input halts execution; the existing abort guard already guarantees a cancelled turn fires no side effects)
- actions classified read / navigate / mutate / irreversible; the last two gate through the approval queue; everything lands in the audit log
- screen content is untrusted input: published studies show 86% attack success from adversarial pop-ups against GUI agents, and prompt-level defenses do not work - the gate and the app allowlist are system-level for that reason
- never see or type credentials: secure-input detection (`IsSecureEventInputEnabled()`) hands password fields to the user

## 7. Phasing

| Phase | Scope | Exit test |
| --- | --- | --- |
| 1. Intents + semantic rail | Swift helper (EventKit, Contacts, PhotoKit), AppleScript tools, `shortcuts run`, URL schemes, widened approval hook with risk classes | "create a calendar event Thursday 3pm" end to end, approval-gated, with the bundled model |
| 2. `@offgrid/use` engine | agent graph + action schema + router + verification in shared, tested against a fake `DeviceController` | engine passes its suite with a scripted fake device |
| 3. Desktop adapter + vision fallback | helper act-primitives, tree serialization, window-scoped capture, GUI-Owl/Holo catalog entries, Cortex on the vision model | a multi-step GUI task on a well-behaved app, verified per step |
| 4. Hard targets | Electron AX wake, WhatsApp flow, per-app recipes where trees are dead | the WhatsApp album task, supervised, send behind approval |

## 8. Open questions

1. Default Cortex model: GUI-Owl-1.5-8B-Instruct (MIT, best desktop) or Holo3.1 (fastest local)? Both ship as catalog entries either way.
2. Package name: `@offgrid/use` proposed (adapters make it computer use on desktop, phone use later on mobile).
3. How much of minitap's graph do we port in v1 - full eight roles, or start with Planner/Cortex/Executor/Reflector and add Orchestrator/Summarizer when task length demands them?
4. Approval UX for multi-step runs: per-risky-step approval, or plan-level approval with a live step view and hold-to-stop?
5. Do we adopt OSWorld-MCP/macOSWorld as a CI-adjacent eval harness from phase 3, so regressions in the loop are measured rather than felt?

## 9. Sources

- minitap/mobile-use: https://github.com/minitap-ai/mobile-use - paper (100% AndroidWorld, ablations): arXiv:2602.07787
- mobilerun (ex-droidrun): https://github.com/droidrun/mobilerun - tree-vs-screenshot payload data: https://www.mobilerun.ai/benchmark
- Mobile-Agent-v3 / GUI-Owl: https://github.com/X-PLUG/MobileAgent - arXiv:2508.15144, v3.5: arXiv:2602.16855 - GUI-Owl-1.5-8B: https://huggingface.co/mPLUG/GUI-Owl-1.5-8B-Instruct
- Holo3.1: https://huggingface.co/blog/Hcompany/holo31
- Hybrid-routing benchmarks: MobileWorld https://github.com/Tongyi-MAI/MobileWorld - PhoneHarness https://phoneharness.github.io/
- Gemini Intelligence safety UX: https://www.engadget.com/2170770/gemini-intelligence-brings-app-automation-to-android/
- UI-TARS: https://github.com/bytedance/UI-TARS - OSWorld: https://os-world.github.io/
- Pop-up injection attacks (86% success): arXiv:2411.02391
- macOS surface: Electron `AXManualAccessibility` https://www.electronjs.org/docs/latest/tutorial/accessibility/ + electron/electron#38102 - secure input TN2150: https://developer.apple.com/library/mac/technotes/tn2150/_index.html - Shortcuts CLI: https://blakecrosley.com/guides/shortcuts - node-mac-permissions: https://github.com/codebytere/node-mac-permissions - WhatsApp Desktop AX findings: https://gist.github.com/hakanensari/99a7ddafbf1b92ce040dc68f43aa25d4
