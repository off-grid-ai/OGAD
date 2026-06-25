# Off Grid AI Desktop — dev.to article brief (SHARED)

You are writing SEO how-to articles for **dev.to** that drive traffic to the GitHub repo
for **Off Grid AI Desktop**. This brief is the single source of truth for product facts,
the proven article skeleton, and the voice rules. Follow it exactly.

The article skeleton below is reverse-engineered from a set of dev.to posts that pulled
2,000–8,000 views each (the same app re-targeted at many keyword variations: "run LLMs
locally", "Gemma", "Qwen", "LM Studio", "Ollama", "Stable Diffusion", "AI images"). We are
replicating that proven mechanism for the desktop app, on **both macOS and Windows**.

---

## THE PRODUCT (facts — do not invent beyond these)

- **Name:** always **"Off Grid AI Desktop"**. Never "Off Grid Desktop", "My Memories", etc.
- **What it is:** a free, open-source, **local-first** desktop app (Electron) for macOS and
  Windows. Everything runs **on-device**. No cloud, no account, no telemetry, no API keys.
  Your data never leaves your machine.
- **Repo / primary CTA link:** https://github.com/off-grid-ai/desktop
- **License:** AGPL-3.0 (open source).
- **One-liner:** a private layer that **sees** your work (screen capture → OCR → memory),
  **remembers** it, helps you **reflect**, and **acts** with your approval — plus a full
  local AI studio (chat, image generation, voice) like a private LM Studio / ChatGPT.

### Core (free) features — the menu to pull from per article
- **Local LLM chat** — bundled `llama.cpp` server runs local models (Gemma, Qwen, etc.).
  Temperature + context-window controls. Like ChatGPT/Claude but on-device.
- **Models browser** — built-in Hugging Face browser + download manager; pick and run any
  compatible GGUF model.
- **On-device image generation** — `stable-diffusion.cpp`. Models: **SDXL**,
  **SDXL-Lightning** (few-step, fast), **SD 1.5 / 2.1**, and **Z-Image-Turbo** (2026
  flagship, ~8-step). txt2img + img2img, live per-step preview, progress + ETA, cancel,
  lightbox, an artifacts gallery, and style presets (Sketch / Cinematic / Anime / …).
- **Voice in (STT)** — bundled **whisper.cpp**: mic → text in the composer.
- **Voice out (TTS)** — **Kokoro-82M** (open-weight, multilingual) per-message Speak +
  auto-speak voice mode.
- **Meeting recorder** — records Google Meet / Zoom (screen video + system audio + mic),
  transcribes locally with whisper, LLM title/summary/people, explicit start/stop +
  recording indicator (consent). Folds the summary into memory.
- **Screen capture → memory** — explicit opt-in, per device, with a visible recording
  indicator: screen frame → OCR → local LLM distills observations + entities. The unique
  "sees your work" primitive.
- **Day** — a persisted journal of your day, in time blocks.
- **Entities** — a private "CRM for everything": people, projects, companies, concepts,
  with merge/hide/hierarchy and synthesis summaries.
- **Replay** — a scrubbable "movie of your day".
- **Reflect** — mind-share / focus / context-switching trends over Day and Week.
- **Actions** — action items detected from your communication (reviewable, never auto-sent).
- **Projects + RAG + chat** — upload docs (txt/md/PDF/DOCX/image/audio/video) → on-device
  embeddings + local vector store → chat with cited sources; toggle to include captured
  memory. A private "chat with your documents".
- **Canvas / artifacts** — the model's HTML / SVG / Mermaid / React blocks render live in a
  sandboxed iframe (no network/file access). Code/Preview toggle + download.
- **Tool-calling** — agentic loop with built-in local tools (calculator, datetime).
- **MCP connectors** — connect tools like **Notion, Linear, Jira/Confluence** locally;
  the local model reasons over the data; actions are approval-gated (an approval queue +
  audit log). Connectors fetch, the on-device model reasons.

### Stack / hardware facts (true, defensible — safe to cite)
- Electron + React; bundled `llama-server` (port 8439), `whisper.cpp`, `ffmpeg`, `sharp`,
  `stable-diffusion.cpp`. `better-sqlite3` for storage; on-device embeddings + local vector
  store for RAG.
- **macOS:** Apple Silicon (M1/M2/M3/M4). GPU acceleration via **Metal**; unified memory.
- **Windows:** GPU acceleration via **CUDA** (NVIDIA) or **Vulkan**; CPU fallback works too.
- Local models are quantized GGUF (e.g. q8_0 / Q4_K) so they fit in consumer RAM/VRAM.

### Accuracy guardrails (HARD — do not break)
- Only describe the features listed above. Do NOT invent features, screens, or settings.
- Do NOT fabricate benchmark numbers for our app (e.g. "3x faster", "120 tokens/sec on an
  M3"). You MAY cite publicly true hardware facts (Apple Neural Engine TOPS, model
  parameter counts, RAM/VRAM requirements, quantization sizes). If you don't have a real
  number, describe the behavior qualitatively instead of inventing a figure.
- Do NOT mention Pro / paid tiers / pricing. These articles are about the free, open core.
- The local multimodal gateway (OpenAI-compatible API at http://127.0.0.1:7878/v1) IS
  shipped and may be presented as available. Only the "use it from other PAIRED DEVICES
  over the mesh" part is future/roadmap.

---

## THE PROVEN ARTICLE SKELETON (follow this order)

1. **dev.to frontmatter** (exact format):
   ```
   ---
   title: <the article title>
   published: false
   description: <one sentence, ~150 chars, benefit + "on-device / no cloud">
   tags: <up to 4, comma-separated, no #, e.g. ai, privacy, macos, llm>
   cover_image:
   ---
   ```
2. **Opening hook (3 sentences).** Sentence 1: a concrete, surprising hardware fact
   (real). Sentence 2: that power sits idle while you pay a monthly subscription to run
   everything on someone else's server. Sentence 3: "Off Grid AI Desktop is a free,
   open-source app that runs [the thing] directly on your Mac/PC." No greeting, no warmup.
3. **Primary CTA line, immediately after the hook:**
   `**[GitHub →](https://github.com/off-grid-ai/desktop)**` (and optionally a one-line
   "free, open-source, runs offline").
4. **What You Need** — hardware in tiers (Minimum / Recommended): chip, RAM/VRAM, OS
   version, free disk. Be OS-correct for the article's target OS.
5. **What Off Grid AI Desktop Can Do** — the relevant capabilities as a tight list, each
   one a benefit not a feature dump. Place 3–5 GIF placeholders here (see GIF convention).
6. **Which Models to Use** (for model/LLM/image articles) — a small table mapping
   device tier → recommended model → what to expect (qualitative). For non-model articles,
   replace with a topic-appropriate "How it works" section.
7. **How Hardware Acceleration Works** — Metal/unified-memory (Mac) or CUDA/Vulkan/CPU
   (Windows); quantization; why on-device is viable now.
8. **One practical tips/optimization section** — e.g. memory/context management, picking
   quantization, keeping it fast. Real, defensible guidance only.
9. **Privacy: stronger than [cloud competitor]** — short, concrete comparison. On-device,
   no telemetry, AGPL/open-source, no account.
10. **Getting Started** — a numbered list (5 steps): clone/download from GitHub, install,
    run, pick a model / enable the feature, go. Include the repo link again.
11. **What's Coming** — 2–4 bullets of honest roadmap (cross-device sync, more models,
    unified search, prospective "Day"). Keep it grounded.
12. **FAQ** — 4–6 Q&As (`### Q: ...` then answer). Cover: is it really free, does it work
    offline, which models, RAM needed, Windows vs Mac, is my data private.
13. **Closing CTA** — one line + the GitHub link. No "in conclusion", no summary.

Length: 900–1,500 words. Use subheadings every 2–3 paragraphs. Tables and short lists are
good. Include 1–2 small fenced code/command blocks where natural (install/run).

### GIF convention
The author will record GIFs later. Mark each spot with an HTML comment on its own line:
`<!-- GIF: short description of what the GIF should show -->`
Place 3–5 across the article (in "What it can do" and "Getting Started").

---

## VOICE & ANTI-SLOP RULES (from write-as-mac — enforce before finishing)

Mechanics:
- Short, declarative sentences. Most under 14 words. Stack short, then land one longer.
- Conclusion first: claim, then proof, then implication.
- Second person ("you") throughout. "You" should outnumber "we" at least 2:1.
- Benefits over features (Bly): "nobody buys drill bits, they buy holes." Translate every
  feature into what the reader gets.
- Be specific. Real numbers and names beat adjectives. No empty superlatives.

HARD FAILS — fix every one before output:
- **Em dashes: ZERO.** Use commas, periods, parentheses, or rewrite. (ASCII hyphen "-" in
  compound words is fine; the — character is banned.)
- **Exclamation marks: none.**
- **Curly quotes / smart apostrophes: none.** Straight ASCII only ( " and ' ).
- **No AI tells:** no rule-of-three stacking, no "not just X but Y" / "it's not X, it's Y",
  no "-ing" tail clauses doing analysis ("...empowering you to..."), no "serves as /
  stands as / represents" (say *is*), no throat-clearing intros, no "in short / overall"
  summaries, no sycophancy.
- **Banned vocabulary:** delve, crucial, pivotal, vital, meticulous, intricate, tapestry,
  testament, landscape, underscore, leverage, robust, comprehensive, showcase, highlight
  (verb), foster, cultivate, align/resonate, valuable insights, seamless(ly), effortless,
  unleash, unlock (verb), empower, supercharge, game-changer, cutting-edge, reimagine,
  holistic, synergy, best-in-class.
- Don't be boring. Interesting means specific and useful, not clever.

Output: write the complete article as a single Markdown file, frontmatter first. No preamble,
no notes to me — just the publishable article.
