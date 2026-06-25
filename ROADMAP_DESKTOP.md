# Off Grid Desktop — Roadmap

The desktop product view of the plan. The shared, package-oriented plan lives in `../shared/ROADMAP.md`; this is the same arc re-cut around the **desktop app**, with honest current status. Sources folded in: `shared/ROADMAP.md`, root `CLAUDE.md`, `website/vision.md`.

**North star:** a private, **local-first** layer for knowledge workers that **sees** your work, **remembers** it, helps you **reflect**, and **acts** on your behalf *with approval* — data stays on the device, intelligence runs on-device. Mission: *democratize intelligence for knowledge workers* (the broader vision: a proactive, private Personal AI OS for everyone — `website/vision.md`).

Legend: ✅ done · 🟡 partial / in progress · ⬜ not started

---

## Phase 0 — Foundation ✅
- ✅ App shell, Off Grid design (Menlo / black / emerald), unified `userData` path, dock + tray icons
- ✅ Bundled local runtimes: `llama-server` (gemma-4 vision), `whisper.cpp`, `ffmpeg`, `sharp`
- ✅ Local LLM plumbing: grammar-constrained JSON, `enable_thinking:false`, single-flight init, port 8439
- 🟡 Full design pass on every screen (ongoing polish)

## Phase 1 — Capture spine ✅
- ✅ Focus loop via `get-windows` (no fragile per-helper TCC)
- ✅ Active-screen capture, **multi-monitor correct** (display under the focused window)
- ✅ Window-bounds crop → OCR → gemma distill → observations + entities
- ✅ Capture v2: vision-learned content-region sub-crop, daily re-learn, tray "recalibrate current app"
- ✅ Blank/locked-screen frames skipped; consumption vs work/communication classification
- ✅ Menu-bar tray (pause/recalibrate)

## Phase 2 — See & Remember surfaces 🟡
- ✅ **Day** — persisted journal (keep-old-while-updating) + time blocks
- ✅ **Entities** — CRM-for-everything (merge/hide/reassign/hierarchy, synthesis summaries)
- ✅ **Replay** — "movie of your day" (scrub/play/speed, busiest-day default, blanks filtered)
- ✅ **Reflect** — mind-share, balance, context-switching, Day + Week trends
- ✅ **Actions** — action items detected from communication (reviewable, never auto-sent)
- ⬜ Unified **search** across everything
- ⬜ Replay polish (filmstrip, jump-to-entity, collapse gaps)

## Phase 3 — Meeting recorder 🟡 (building now)
- 🟡 **Meeting recorder** — **Google Meet + Zoom** for now (user has access to those two). Records **screen video + system/speaker audio (Electron loopback) + mic**, mixed into one webm; transcribes locally with bundled whisper; LLM title/summary/people; folds a summary into memory (surface=Meeting) so it hits Day/Reflect. Explicit start/stop + recording indicator (consent). FIRST CUT: `main/meetings.ts` + `MeetingsScreen.tsx` + `setDisplayMediaRequestHandler` loopback. Next: auto-arm on detecting a Meet/Zoom window, diarization, align transcript to the frame timeline, Teams later.
- ⬜ Encryption at rest for the memory DB

## Parked: remaining connectors (later)
3 connectors verified (Notion, Linear, Jira/Confluence). Parked for now, revisit after meetings:
- **Per-connector arg/prereq generalization** — generalize the cloudId resolver to any required id (teamId/workspaceId/orgId) so Vercel/Asana-style `list_*` tools work (Vercel `list_projects` needs `teamId`; partial code in `ingest.ts`).
- **Verify/finish**: Sentry, Vercel, Attio, ClickUp, Trello, GitHub (PAT), GitLab — onboard one-at-a-time with the disabled-by-default rule.
- **Slack** — skipped (bot must be invited per-channel; capture covers it). Adapter built but parked.
- **Google (Gmail/Cal/Drive)** — needs a GCP OAuth client (Testing mode); parked until the client exists. Capture covers it meanwhile.

## Phase 4 — The "Act" pillar ⬜ (foundation-first) ← NEXT
**Foundation (build first — everything authorized hangs off these):**
- ✅ **Identity anchor** — who the user is (name + email); Settings → "You"; `isMe()` for ownership (`main/identity.ts`)
- ✅ **Secure secret storage** — Electron `safeStorage`/Keychain; encrypted at rest, values never reach the renderer (`main/secrets.ts`)
- 🟡 **Consent / permission model** — per-connector enable/disable + the local-processing guarantee (connectors fetch, local model reasons). Full per-source consent UI + revoke still to deepen
- ✅ **Approval queue + audit log** — proposed → approve/reject → execute → logged; nothing acts without a logged approval (`crm/approvals.ts`, Approvals screen)

**Sources & connectors (MCP):**
- ✅ **Integrations / Connectors page** — add/enable/test MCP connectors (stdio + HTTP), discover tools, status (`main/mcp.ts` via `@modelcontextprotocol/sdk`, `ConnectorsScreen.tsx`). Approved tool calls execute through `callConnectorTool`
- ⬜ **Connector auth rule** — MCP connectors only for clean local-friendly auth: **DCR-OAuth** (Notion✓, Linear, Atlassian, Sentry…) or **token** (Slack, Airtable, Postgres…). **No central OAuth client.**
- ⬜ **Google (Gmail/Calendar) via SCREEN CAPTURE, not an OAuth client** (decided June 2026, fully-offline). Google MCP has no DCR → would need a registered GCP client = anti-offline; rejected. We already OCR Gmail/Calendar on screen — zero setup, nothing leaves the device.
- ⬜ **Capture ↔ connector intelligence (source-of-truth priority).** Be smart: capture is the universal SIGNAL of interest ("you're on a Notion page / a Linear issue / company XYZ"); when a connector exists for what you're looking at, **pull the authoritative data from the connector (source of truth) instead of leaning on OCR/AX.** Connector data **takes priority** over captured/OCR data in synthesis + dedup, and lets us **throttle/skip OCR** for those apps (cheaper, cleaner). Capture tells us *what you care about*; the connector gives the *correct* version.
- ⬜ **Cross-source synthesis** — join email ↔ calendar event ↔ person ↔ project ↔ ticket into one entity, across capture + connectors
- ⬜ **File system access (local file catalogue + auto-retrieval).** Index opt-in, **scoped folders** on-device — file metadata (path / name / type / size / mtime) + content embeddings into the RAG store (Phase 5) — so Off Grid knows *what files exist* and *what's in them*. Then **fetch the right file at the right time instead of making the user attach it**: capture/context signals *what you're working on* → the catalogue surfaces or auto-attaches the relevant document (meeting prep pulls the deck; a chat about project X pulls its docs; "the contract we discussed" resolves to the file). Local-only, per-folder enable/revoke under the consent model, incremental re-index via an fs watcher. The local-first peer of the source-of-truth-priority rule above: **capture tells us what you care about; the file system gives the actual document — no manual attach.**

**Skills & action:**
- ⬜ **Skills framework** (`@offgrid/skills`) — trigger → action, on-device, model-driven
- 🟡 **Intent → tool bridge** — action-item *detection* shipped (`crm/actions.ts`); next: propose a connector tool call (args from context) → approval queue
- ⬜ **Day flips from retrospective → prospective** (KEY shift, user-confirmed June 2026). Today "Day" = what happened / what you did (a rear-view mirror). Once Calendar + tasks + email flow, Day gains an **"Ahead"** half = *what your day SHOULD look like*:
  - meetings as the skeleton (Calendar) → **prep per meeting** (past conversations + open items + docs about the attendees, from memory/connectors)
  - **priorities** — action items + connector to-dos slotted into the day
  - **protected deep-work blocks** + **overcommitment nudges**, informed by the Reflect/attention signal
  - The "Behind" half (current Day) stays as the feedback loop that makes "Ahead" smarter.
  This is the tool→assistant pivot and the vision.md promise ("your devices already know your day; the briefing is ready, you didn't ask for it").
- ⬜ **Proactive delivery** — morning briefing, meeting prep ~20 min before, right person/right time (notifications), tuned by Reflect. Needs the connectors flowing (Phase 4 sources).

## Phase 5 — Intelligence depth 🟡
- ✅ **Projects + RAG + chat** over all memory + ingested docs — file upload (txt/md/PDF/DOCX/image/audio/video) → MiniLM embeddings + better-sqlite3 vector store; cited sources; "include captured memory" toggle spans uploads + everything captured (`@offgrid/rag`, `rag/index.ts`, `ProjectsScreen.tsx`)
- ⬜ Unified search
- ✅ **Models** — HF browser / provider abstraction / download manager (`@offgrid/models`, `ModelsScreen.tsx`)
- ⬜ **Expose a local model server** — surface the on-device runtimes (the bundled `llama-server` on 8439, whisper, embeddings) as a **local, OpenAI-compatible API endpoint** so other apps on the machine — and, over the mesh, other paired devices — can use Off Grid AI Desktop as their private inference backend. Off Grid Desktop becomes the household's on-device model server (no cloud, no API keys). Auth-gated + opt-in (off by default); ties into the consent model and the cross-device mesh (Phase 6).

### Phase 5b — The Off Grid chat as a local AI Studio (in progress, June 2026)
The Off Grid chat (`MemoryChat.tsx`) is becoming a full local-first studio — like Claude/LM Studio/Ollama, but everything on-device. Brand: brutalist/terminal (Menlo, emerald, flat). Done + planned:
- ✅ **Chat redesign** — brutalist composer, clickable example prompts, mode segmented control; light + dark.
- ✅ **On-device image generation** — `stable-diffusion.cpp` (`sd-cli`, Metal) in `resources/bin/sd`; txt2img + img2img; per-model size/steps/seed/negative-prompt; **live per-step preview + progress bar + ETA + Stop/cancel**; **lightbox** (zoom/download/delete); **artifacts gallery** of every generated image (`main/imagegen.ts`, `MemoryChat.tsx`).
- ✅ **Image models** — SDXL, **SDXL-Lightning** (few-step, default-fast), SD 1.5/2.1; per-model step/cfg/sampler auto-tuning; catalog curated toward latest models.
- ✅ **Crash/freeze fix (Apple Silicon)** — unified-memory overflow froze the machine when LLM + image model were both resident; now **free the LLM before image gen** + `--diffusion-fa` + memory guard + thread cap.
- ✅ **STT (voice input)** — mic → bundled whisper → text in the composer.
- ✅ **TTS (voice output)** — **Kokoro-82M** (open-weight, multilingual) via `kokoro-js`; per-message Speak + auto-speak voice mode (`main/tts.ts`).
- ✅ **Add chat to a project** — header picker scopes a chat to a project's KB (+ inline project create); Projects tab lists a project's chats (Claude-style, no composer there) and opens them in the chat (`App.tsx` `chatTarget`).
- 🟡 **Z-Image-Turbo (2026 flagship image model)** — Alibaba Tongyi, Apache-2.0, ~8-step turbo, 1024px, bilingual text. 3-file stack (diffusion + Qwen3-4B `--llm` encoder + FLUX `--vae`), `--offload-to-cpu`; wired in `imagegen.ts`, set as default. (verified sd.cpp supports it; verifying first generation)
- ⏸️ **Multi-runtime image fleet — MLX/mflux runtime (BUILT then PARKED 2026-06-23)** — second image runtime alongside `sd-cli`, the path that makes LoRA actually work (sd.cpp can't merge LoRA into our quantized models). Fully built + verified working (env, routing, catalog, download, UI all done) but **parked on a product-size decision**: every non-gated on-device MLX LoRA model is too large to ship — Z-Image ~13GB (8-bit) / ~33GB (bf16); FLUX.1-schnell 4-bit ~9.9GB (`madroid/flux.1-schnell-mflux-4bit`, non-gated, real LoRA ecosystem). User judged ~10GB+ too much for the LoRA payoff. **Result: on-device LoRA is shelved.** Dormant plumbing kept (`src/main/mflux.ts` + the `generateImage`/`ipc` branches, inert with `MFLUX_MODELS=[]` and no catalog entry); bundled env + caches deleted (~16GB reclaimed). Re-enable: repopulate `MFLUX_MODELS`, restore a `runtime:'mflux'` catalog entry, rerun `scripts/build-mflux-env.sh`. Plan: `~/.claude/plans/fuzzy-crunching-spark.md`.
  - ✅ **Phase 0** — fully-offline bundled Python/MLX env via `scripts/build-mflux-env.sh` (relocatable python-build-standalone 3.11 + `mflux 0.18.0` + `mlx 0.31.2`, ~961MB, gitignored at `resources/bin/mflux/`). Verified: relocatable `python3 -m mflux.models.flux.cli.flux_generate` works; import OK.
  - ✅ **Phase 1** — `src/main/mflux.ts` runtime module (binRoots resolution, `mfluxAvailable()`, `MFLUX_MODELS`, `buildMfluxArgs`, tqdm progress parse, `runMflux`, cancel). Typechecks clean.
  - ✅ **Phase 2** — `generateImage()` routes `mlx/*` models to `runMflux` (reuses single-flight + `llm.pause()`); `listImageModels`/`imageGenStatus` surface MLX models; LoRA names resolved to paths/HF-repos.
  - ✅ **Phase 3** — `runtime?: 'sd-cli'|'mflux'` on `ModelEntry`; **Z-Image-Turbo (MLX · LoRA)** catalog entry; `models:download` for `runtime:'mflux'` pre-fetches via bundled python (`snapshot_download`) with progress; `models:installed` checks the HF cache (`isMfluxModelCached`).
  - ✅ **Phase 4** — model picker lists MLX models; LoRA picker is runtime-aware (SDXL examples hidden for MLX; shows "drop Z-Image/FLUX .safetensors or HF repo" hint). Typechecks clean.
  - 🟡 **Findings / decisions (2026-06-23):** **FLUX.1-schnell is GATED** (HF login required) incl. its MLX mirrors → dropped from defaults (offline ethos); parked behind a future opt-in HF-token setting. **Z-Image-Turbo (`Tongyi-MAI/Z-Image-Turbo`) is non-gated** and is the shippable MLX model. **DOWNSIDE: the full bf16 MLX repo is ~15GB+** (mflux quantizes at load) vs the 6.7GB sd-cli GGUF. ⬜ Mitigate by pointing `--model` at a **pre-quantized non-gated mlx-community Z-Image repo** (`--base-model z-image-turbo`) to cut the download to ~6GB.
  - ⬜ **Phase 5 (packaging)** — codesign/notarize the bundled Python env (the main risk). ⬜ Verify the on-device Z-Image-MLX + LoRA render once the download completes.
- ⬜ **Other runtimes** — broaden coverage later (SD3.5/Qwen via sd-cli; DiffusionKit) and route each model to its fastest runtime.
- 🟡 **LoRA support (plumbing done, BLOCKED on f16 model)** — full pipeline built: `models/loras/` folder + `listLoras()`, `<lora:NAME:weight>` injection + `--lora-model-dir`, in-app download of 5 curated SDXL example LoRAs (`downloadLora`), UI picker (toggle chips + weight + "Add LoRA…"). **Tested 2026-06-23: the LoRA file loads & applies, but the render then ABORTS** — stable-diffusion.cpp can only merge a LoRA into **full-precision (f16/f32)** weights; our shipped checkpoints are all **quantized (q8_0/Q4_K)**, so the merge fails on every backend (Metal: `unsupported op CPY/ADD`; CPU: `GGML_ASSERT src1->type==F32`). Added a guard in `imagegen.ts` that throws a clear message instead of crashing when a LoRA is requested on a quantized model.
  - ⬜ **Unblock:** ship a non-quantized **f16 SDXL-Lightning** (~12GB vs 4GB q8) as an opt-in "LoRA-capable" model; then the existing plumbing works as-is. Or wait for sd.cpp to support quantized-base LoRA merge.
- ✅ **Canvas / artifacts runtime** — the model's **HTML / SVG / Mermaid / React-JSX** blocks render live in a **sandboxed iframe** (`sandbox="allow-scripts"`, no network/file access); Code/Preview toggle + download; runtimes (React UMD, Babel, Mermaid) bundled offline in `resources/artifacts` (`main/artifacts.ts`, `ArtifactCanvas.tsx`). Next: HTML presentations (reveal.js), open-in-browser, and a **Qwen-Coder** model for higher-quality codegen.
- 🟡 **Tool-calling loop + connectors in chat** — agentic loop done for **built-in local tools** (calculator, datetime), isolated + opt-in via the composer "+" menu; the model calls them mid-chat with results shown inline (`main/tools.ts`). Next: web search, read-URL, KB search, and **MCP connectors** in the picker.
- ✅ **Composer redesign** — Claude/ChatGPT-style: "+" menu (add image / generate / add-to-project / tools), Gemini-style **image style presets** (Sketch/Cinematic/Anime/…), centered welcome + example chips.
- ⬜ **Thinking controls** — toggle `enable_thinking` on the local reasoning model + collapsible reasoning blocks in messages.
- ⬜ **Project cross-chat memory** — chats live *inside* a project; a chat can **reference information from other chats in the same project** (project-scoped retrieval across its conversations), while "All memory" remains available.
- ✅ **Model-settings control in chat** — **temperature** (per-request) + **context window** (re-spawns `llama-server` with new `--ctx-size`), persisted, surfaced in a chat-header settings popover (`llm.ts` getSettings/setSettings). Next: top_p / max-tokens.

## Phase 6 — Cross-device (Personal AI OS) 🟡
- ✅ Engine exists: `@offgrid/sync` + `@offgrid/memory` (pairing, anti-entropy op-log)
- ⬜ Carry the new memory (observations/actions/entities/reflect) across the mesh
- ⬜ Embed sync + memory + clipboard into Desktop; desktop↔desktop converge; universal clipboard
- ⬜ **One brain across devices** — laptop (work) + phone (life) unify into a single working model, syncing over the home network, no cloud relay (`vision.md`)

## Phase 7 — Org / B2B distribution ⬜
- ⬜ Team/org identity + roles; **scoped-sharing model** (share *intelligence*, never raw frames); right-person-right-time distribution across a team. The layer neither screenpipe nor Littlebird has

## Phase 8 — Productization ⬜
- ⬜ Onboarding permission ladder (screen → Google OAuth → MCP) — *deferred, not now*
- ⬜ Settings consolidation; ✅ theme toggle wiring
- ⬜ Packaging: signed/notarized DMG + auto-update
- ⬜ Licensing: AGPL + CLA + open-core; device cap (2 free / 3+ paid) — *deferred, not now*

---

## Parked (explicitly deferred — not now, per product call June 2026)
- **Storage & retention** (cleanup/budget/auto-prune). Revisit when running all-day for weeks becomes the norm.
- **Continuous ScreenCaptureKit → H.264 video** (smooth DVR vs current PNG frames). Current per-tick screenshots are good enough for now.

## Engineering track (parallel)
Desktop implements capture/reflect/act **inline** today. For mobile reuse, extract into `@offgrid/*` packages (`capture`, `memory`, `skills`, `models`, `imagegen`, `ui`) once proven in-app. **Mobile is built last.**

## Status (June 2026)
Phases 0–2 largely done — the full **see → remember → reflect → act(detect)** loop runs on one machine. Frontier: **Phase 4 (authorized sources + approved actions)**, starting with the **foundation** (identity → secrets → consent → approval queue), then **Gmail/Calendar via MCP**.

## Later phase — UI standardization audit (design philosophy)

**Decided 2026-06-23.** Off Grid Desktop adopts the Wednesday Solutions standards-kit: **no custom UI components** — every element comes from the approved libraries (**shadcn/ui** foundation, **Aceternity** effects, **Magic UI** text/buttons, **Motion Primitives** transitions). Branding stays Off Grid (Menlo mono, emerald, brutalist); shadcn semantic tokens are mapped to `--og-*` in `main.css` `@theme` so library components inherit the brand automatically.

- [ ] Audit every screen/component and replace hand-rolled markup with approved-library components (start: MemoryChat composer/messages, then Settings, Onboarding, Day/Replay/Reflect/Actions/Connectors/Meetings/Models/Entities screens).
- [ ] Pull primitives via `npx shadcn add` (+ `@aceternity`/`@magicui` registries); pick from `component-library-animations/skills/component-library-index.md`.
- [ ] Enforce standards-kit code rules (cyclomatic complexity < 8, PascalCase UI / camelCase logic, strict import order, no console.log/magic numbers, animate only transform/opacity, `prefers-reduced-motion`).
