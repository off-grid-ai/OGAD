# Computer use - replicate the mobile-use stack on desktop

**Status:** direction decided August 11, 2026; agent-browser rail and build guidelines added August 12 after the Clawbot / product-UX research. Intents + MCP are the primary action paths; an embedded agent browser handles web tasks; the vision-based agent is the fallback for native apps. We do not innovate on agent architecture - we study the mobile-use ecosystem and replicate it, with the browser UX replicated from Codex desktop and Claude Desktop. The engine is built in the shared repo (`off-grid-ai/shared`) as an `@offgrid/*` package. Model size is not a design constraint - local models keep improving and the vision model ships as a downloadable catalog entry.
**Constraint (standing):** local models only. No hosted APIs. No screenshot ever leaves the device.

---

## 1. The decision

The agent executes actions on the user's Mac - from "create a calendar event Thursday 3pm" to "pick the best photo from the vacation album in the family WhatsApp chat and send it". The decided shape:

1. **Intents + MCP first.** Deterministic action surfaces - MCP connectors, URL schemes, AppleScript/Apple Events, EventKit and friends, Shortcuts - handle everything they can. No pixels, no coordinates.
2. **Agent browser for the web.** An embedded browser pane inside the app (clean profile, separate cookie jar) that the agent drives while the user watches - the surface Codex desktop and Claude Desktop both converged on in 2026. It handles research, forms, portals, and orders, and it needs zero OS permissions, so it ships before any native-GUI control. See 2.3.
3. **Vision-based agent as the native fallback.** When no deterministic surface or web path exists, a multi-agent GUI loop takes over, perceiving through the accessibility tree plus screenshots and acting through synthetic input.
4. **Replicate, do not invent.** The mobile-use ecosystem solved the agent loop (100% on AndroidWorld); Codex and Claude Desktop solved the browser UX; OpenClaw proved the capability composition - and its incident record is our avoid-list (see 2.4). We port, we do not design from scratch.
5. **Engine in shared.** The agent loop, action schema, router, and verification logic are platform-agnostic and land as a package in `off-grid-ai/shared`, with a desktop adapter in this repo - the same engine + adapter split `@offgrid/clipboard` already uses. A mobile adapter can follow later.
6. **The setup bar: none.** The target outcome is OpenClaw-class capability with zero setup. Our structure already delivers it: the model is bundled (no API keys), everything runs in-process (no gateway, no ports, no daemon), and permissions are just-in-time OS prompts, never config files.

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

### 2.3 The agent browser (the web rail) - added August 12

The standalone AI browsers died in 2026 (OpenAI shut down Atlas, Google shut down Project Mariner); what survived at both OpenAI and Anthropic is a **tabbed browser pane embedded in the app**: clean profile, separate cookie jar, the user logs into sites deliberately in-pane, the agent drives the page in a live shared view, per-site permission cards gate actions. Codex desktop ships this in the thread; Claude Desktop ships it as the Browser pane. We adopt it as the preferred rail for every web task:

- **Electron `WebContentsView`, driven in-process via `webContents.debugger`** (raw CDP - no debug port, no new dependencies; browser-use itself moved from Playwright to raw CDP for speed and control).
- **Perception is an indexed DOM/accessibility snapshot** (port of nanobrowser's TypeScript serialization) - multiple-choice element targeting that suits the bundled model - with screenshots as the fallback, per Agent TARS's dom / visual-grounding / hybrid strategy.
- **Zero OS permissions.** The pane is our own surface: no Accessibility grant, no Screen Recording, no TCC prompts at all. This makes it the first GUI capability we can ship.
- **Per-site cards** (allow once / always allow / deny; localhost exempt), **takeover mode** at logins and payments - agent input pauses and frame capture stops while the user types - and opt-in session persistence per site.

### 2.4 What we reuse directly

| Source | License | What we take |
| --- | --- | --- |
| `@ui-tars/sdk` + the UI-TARS desktop app | Apache-2.0 | two-method Operator seam + action parser; the ScreenMarker overlay trio (animated screen border, content-protected pause widget, pre-action click markers); desktopCapturer screenshot scaling; the macOS permission gate |
| nanobrowser | Apache-2.0 | TypeScript DOM-to-indexed-elements serialization for the browser rail |
| `@computer-use/nut-js` (or `@nut-tree-fork/nut-js`) | Apache-2.0 | input synthesis on the native rail, alongside our Swift helper |
| macos-automator-mcp | MIT | wrapped as an intents layer: AppleScript/JXA execution plus its recipe knowledge base |
| bytebot (archived) | Apache-2.0 | takeover-as-recorded-actions (the human demonstration lands in the same action log the agent uses) and the explicit needs_help task state |
| Peekaboo (OpenClaw org) | MIT | reference implementation for the a11y-tree + vision hybrid on the native rail |
| OpenClaw | AGPL (patterns only) | the capability composition and the proactive cron/skills pattern. Equally its incident record as the avoid-list: 30,000+ exposed gateways, sandbox-off default, weak local auth, unvetted skills. We ship none of those surfaces - no gateway, no ports, no BYO keys, skills approval-gated |

Everything adopted as code is Apache-2.0 or MIT - clean for the AGPL core + proprietary pro split (ported files keep their license headers).

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

### 5.3 Build guidelines (brand and design) - binding on all phases

Every computer-use surface (browser pane chrome, run view, approval cards, overlays, onboarding) follows the canonical guidelines:

- **`off-grid-ai/brand`** - `DESIGN_PHILOSOPHY.md` is the cross-platform design source of truth: brutalist/terminal aesthetic, Menlo everywhere, emerald as the only accent (`#34D399` dark / `#059669` light), black/white base, hierarchy through size and weight rather than color, and every color/spacing/type value from `@offgrid/design` tokens - no hardcoded hex. Copy follows `brand_tone_voice.md` plus the outcomes-first rule in the brand README: lead with what the user gets, mechanism as proof.
- **`off-grid-ai/shared`** - `@offgrid/design` is where the tokens live; components inherit light/dark through the token mapping.
- **This repo's `docs/DESIGN.md`** - the desktop-first density rules (multi-column grids, tight 4/8/12 spacing, progressive disclosure, sticky context, micro-interactions).
- The agent's overlay widgets and permission cards are product UI like any other: no emojis, no gradients, no second accent, quiet by default.

## 6. Safety

The shipped-product template is Gemini Intelligence's UX, which matches our approvals spine:

- agent acts only on explicit user start; always-visible progress with a hard stop (user input halts execution; the existing abort guard already guarantees a cancelled turn fires no side effects)
- actions classified read / navigate / mutate / irreversible; the last two gate through the approval queue; everything lands in the audit log
- screen content is untrusted input: published studies show 86% attack success from adversarial pop-ups against GUI agents, and prompt-level defenses do not work - the gate and the app allowlist are system-level for that reason
- never see or type credentials: secure-input detection (`IsSecureEventInputEnabled()`) hands password fields to the user
- **hard-blocked action classes** no permission can unlock (the Claude in Chrome / Gemini precedent): purchases and financial transactions, account creation, permanent deletions, CAPTCHA bypass. Protected actions that always confirm even on always-allowed sites: sends, downloads, sensitive-data entry, authorization grants
- **takeover with a stated guarantee**: at logins and payments the agent pauses and frame capture stops while the user controls the surface; the human's actions during takeover are recorded into the same action log (the bytebot pattern) so the agent resumes with context
- **the agent cannot see or dismiss its own controls**: overlay widgets call `setContentProtection(true)` so they never appear in screenshots; Esc aborts globally and the keypress is consumed so on-screen content cannot dismiss an approval dialog
- **per-surface grants**: allow once / always allow / deny per site on the browser rail (localhost exempt); per-app grants on the native rail

## 7. Phasing

| Phase | Scope | Exit test |
| --- | --- | --- |
| 1. Intents + semantic rail | Swift helper (EventKit, Contacts, PhotoKit), AppleScript tools, `shortcuts run`, URL schemes, widened approval hook with risk classes, morning-briefing skill template | "create a calendar event Thursday 3pm" end to end, approval-gated, with the bundled model |
| 2. `@offgrid/use` engine | agent graph + action schema (including the browser action set) + router + verification in shared, tested against a fake `DeviceController` | engine passes its suite with a scripted fake device |
| 3. Agent browser | `WebContentsView` pane + CDP driver + indexed snapshot + per-site cards + takeover + live overlays | a multi-step web task in-pane, watched live, with a login takeover - shippable on its own |
| 4. Desktop adapter + vision fallback | helper act-primitives, tree serialization, window-scoped capture, GUI-Owl/Qwen3-VL catalog entries, Cortex on the vision model | a multi-step GUI task on a well-behaved app, verified per step |
| 5. Hard targets | Electron AX wake, WhatsApp flow, per-app recipes where trees are dead | the WhatsApp album task, supervised, send behind approval |

## 8. Decisions and open questions

Status as of August 11, 2026 (details live in `COMPUTER_USE_PLAN.md`):

1. **Cortex model - narrowed, decided at install time.** GUI-Owl-1.5-8B-Instruct (working default) or Qwen3-VL-8B. Same Qwen3-VL architecture, so all engine and adapter work is identical for either; the pick is a phase 3 catalog decision and blocks nothing before that.
2. **Package name - proposed, pending lead confirm.** `@offgrid/use`, consumed as `file:../shared/packages/use` from a sibling checkout per the shared README (not a vendored copy under this repo's `packages/`). Confirm both with the lead in phase 0.
3. **v1 graph - decided.** Planner / Cortex / Executor / Reflector; Orchestrator and Summarizer are added when task length demands them.
4. **Approval UX - proposed.** Plan-level approval + live step view + hold-to-stop, with per-step gates on irreversible actions. Validate against real runs in phase 3.
5. **Eval harness - decided.** macOSWorld subset as a non-blocking sanity gate from phase 3.
6. **Sequencing - decided.** Desktop first; mobile follows as an adapter-only project on the same engine (see the plan's "After v1" section; iOS is intents-only by platform rules).
7. **Agent browser rail - decided August 12.** Embedded pane over `WebContentsView` + `webContents.debugger`, indexed-snapshot perception, per-site cards, takeover mode. Ships before the native rail (zero OS permissions, no new models).
8. **Build guidelines - binding.** All UI and copy follow `off-grid-ai/brand` (design philosophy + tone), `@offgrid/design` tokens from `off-grid-ai/shared`, and this repo's `docs/DESIGN.md` (see 5.3).

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
- Agent browser + product UX: Electron debugger API https://www.electronjs.org/docs/latest/api/debugger - Claude Desktop browser pane https://code.claude.com/docs/en/desktop - Claude in Chrome permissions https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide - Codex embedded browser https://chierhu.medium.com/openai-codexs-browser-use-feature-b7dffa761d45 - browser-use's move to raw CDP https://browser-use.com/posts/playwright-to-cdp - nanobrowser https://github.com/nanobrowser/nanobrowser - UI-TARS desktop https://github.com/bytedance/UI-TARS-desktop - bytebot takeover https://github.com/bytebot-ai/bytebot - chrome-devtools-mcp https://github.com/ChromeDevTools/chrome-devtools-mcp - macos-automator-mcp https://github.com/steipete/macos-automator-mcp
- OpenClaw teardown: https://github.com/openclaw/openclaw - Peekaboo https://github.com/openclaw/Peekaboo - exposed-gateway findings https://www.bitsight.com/blog/openclaw-ai-security-risks-exposed-instances - ClawJacked https://www.infosecurity-magazine.com/news/clawjacked-bug-covert-ai-agent/
- Brand and design: https://github.com/off-grid-ai/brand (DESIGN_PHILOSOPHY.md, brand_tone_voice.md, copywriting-rulebook.md) - `@offgrid/design` in https://github.com/off-grid-ai/shared
