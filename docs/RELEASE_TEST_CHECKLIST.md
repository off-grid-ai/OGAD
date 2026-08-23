<!-- Manual on-device test checklist for the feat/consolidation-and-coverage branch.
     Lists every RUNTIME-AFFECTING change so it can be verified on a real Mac.
     Pure test-only additions are NOT listed here (they change no app behavior).
     Updated as consolidation lands. Date started: 2026-07-09. -->

> This is the historical checklist for one quality-hardening branch. The canonical,
> reusable desktop release matrix is [`RELEASE_TEST_CHECKLIST.csv`](RELEASE_TEST_CHECKLIST.csv).

# Release Test Checklist — `feat/consolidation-and-coverage`

Everything here is behavior that a person should exercise on-device. Build + unit tests
already pass; this is the class of thing our gates do NOT catch (the original streaming bug
passed typecheck/tests/build but was broken at runtime).

**Pre-flight:** model ports are single-owner. Stop any running `npm run dev` first, then
`npm run dev` (or a packaged build). Confirm System Health shows the chat model up.

---

## 1. Chat stop button (commit `feat(chat): stop button…`)

Highest-value manual check - this was the original bug.

- [ ] Ask a question with **All memory** + **Thinking** on. A red **stop** button appears next to Send **immediately** (during "Searching your memory…", before any tokens).
- [ ] Click stop during that pre-stream phase → generation aborts, no error bubble, no half-written answer.
- [ ] Ask again; let it start streaming tokens; click stop mid-stream → partial answer is kept, stream ends cleanly.
- [ ] Turn **Tools** on (composer `+` menu), ask something → stop appears and aborts the tools run too.
- [ ] Queue a second message while one is generating, then stop → queued message is dropped, UI returns to idle.
- [ ] Image mode: start a generation, click **Stop** → image job cancels, no error bubble.

## 2. ctxSize default (commit `refactor(config)…`, P0.3)

- [ ] Fresh profile / Settings → Model: context-window default now reads **16384** (was 32768 in UI while backend ran 16384).
- [ ] "Reset to defaults" sets context to 16384 and inference still runs (no engine restart failure).

## 3. Engine ports (commit `refactor(config)…`, F1)

Values are unchanged (8439/7878/7879) - this only de-duplicated the literals. Confirm no regression:

- [ ] App launches; chat model comes up (llama-server on **:8439**).
- [ ] Gateway reachable on **:7878** (Gateway screen / `curl 127.0.0.1:7878/v1/models`).
- [ ] Media playback (replay video) works (media server on **:7879**).

## 4. Type-boundary fixes (commit `fix(types)…`, P0.1/P0.2)

- [ ] Create a **project**, start a chat inside it, reload → the chat stays associated with the project (project_id no longer lost).
- [ ] Generate/save a **text** and an **image** artifact from chat → both save and reopen (saveArtifact union fix).

---

## 5. Consolidation refactors (behavior-preserving — smoke only)

Each is a DRY/SOLID dedup meant to change NO behavior. Listed so you can spot-check the paths they touched.

- **Transcription engine selection** (B3/C1 — `select.ts` dispatcher, `bin-resolution.ts`). Fallback order is unchanged (pickTranscription is byte-identical). Verify: with a Parakeet model active, dictation/file transcription routes to Parakeet; with a whisper ggml model active, whisper runs; STT resident mode still upgrades to the warm whisper-server and degrades to one-shot when the server binary is absent.
- **Gateway proxy retry** (D6 — `retryWithDeadline` extracted, used in `proxyToLlama` + `callLlamaJson`). Semantics preserved, control flow is new. Verify: fire a chat/vision request through the gateway while llama-server is briefly restarting (e.g. right after an image-gen reload) - it should wait and replay within the window, not 502 immediately; a genuine HTTP/parse error still fails fast without retrying.
- **Relative timestamps** (D3 — `timeAgo` shared in `src/renderer/src/lib/time.ts`). Output format unchanged. Verify: chat list and Projects list relative times read the same as before ("just now", "5m ago", "3h ago", "2d ago", then a short date).
- **Pro CRM helpers** (D1 extractJson + D4 today/hasColumn/notify, in the `pro` repo). Behavior-preserving per every call site; agent reported NO runtime-visible change. Low-risk, but if you exercise CRM/meetings/dictation LLM-extraction flows, confirm they still parse results and notifications still fire (skills notification body still truncates at 240 chars; proactive unchanged).

### Logic extraction (pure decision logic pulled out of I/O shells — behavior verbatim)

These moved pure logic into testable modules; the shell just imports and calls it. Smoke the paths:

- **Gateway request handling** (`model-server/*`): image generation with a size/aspect param, a vision request with a remote-URL image (still inlined to the model), async requests (`?async=true` -> 202 + poll), and an error response (e.g. no model installed -> correct error envelope). Chat message sanitization for Gemma still consolidates system messages.
- **LLM streaming** (`llm/sse-stream`, the highest-value path - this is the original-bug area): a chat with Thinking on streams token-by-token AND shows the reasoning bubble; content and reasoning stay separated; stop mid-stream keeps the partial. Payload shape unchanged (images, thinking flag).
- **Search ranking** (`search-ranking`): memory search returns sensibly ordered results (recency + relevance), citations resolve.
- **Model catalog + setup** (`models/*`): Models screen still lists imported-local + HuggingFace-downloaded + catalog models (all three, same order); "Configure for me" recommends the same models per RAM tier; delete/orphan cleanup still protects active + local + downloaded files.
- **Image generation** (`imagegen/*`): generate an image on each runtime you have (sd-cli standard, Z-Image if present, Core ML if present) - same output/quality; the RAM guard still refuses an over-budget model with the same message; progress bar advances (sampling -> decoding); LoRA-on-quantized still refused; img2img still works. sd-server resident fast-path unchanged.

### NOT landed (recorded honestly)

- **D8 (pro clipboard TypeIcon dedup)** - the agent's work was lost (worktree auto-pruned before commit). No regression: the existing duplicated icon code remains and behaves as before. Re-do later; nothing to test.
- **D3 notification copy** - deliberately NOT applied. Notification timestamps keep their existing verbose format ("3 minutes ago"); the compact-format change was dropped to avoid a silent UX change.
