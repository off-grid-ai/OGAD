# Off Grid AI — Windows Test: Exact Models & Test Data

Companion to [WINDOWS_TEST_PLAN.md](WINDOWS_TEST_PLAN.md). This tells the tester **exactly
which models to download** for each suite (by the name shown in the app), how big they are,
and what test inputs to use. Model names below match the **Models** screen catalog verbatim.

> **How you download:** Sidebar → **Models**. The screen groups models by kind
> (text / vision / image / voice / transcription). Find the exact **name** below, click its
> **Download**, wait for it to finish and show as installed/active. Everything is on-device,
> so each model is a one-time download.

---

## 0. First, check your RAM — it decides which sizes you can run

Press **Win + Pause** (or Task Manager → Performance) to see installed RAM, then use the
smallest option that fits. Bigger = better quality but slower / needs more RAM.

| Your RAM | Use the "Light" picks below | Can also try "Standard" picks               |
| -------- | --------------------------- | ------------------------------------------- |
| 8 GB     | ✅ required                 | ⚠️ only the ~4GB image model, one at a time |
| 16 GB    | ✅                          | ✅                                          |
| 24 GB+   | ✅                          | ✅ (plus the large models if you want)      |

**Only ONE large model loads at a time.** Chat and image generation can't both be resident —
the app swaps them automatically, so don't be alarmed if starting an image generation pauses
chat briefly.

---

## 1. Minimal download set (do this for the critical path A→D + core suites)

Download these **five** models first. Total ≈ **6.9 GB**.

| Suite               | Kind          | Model name (in app)         | Size                       | Min RAM |
| ------------------- | ------------- | --------------------------- | -------------------------- | ------- |
| C — Chat            | text          | **Qwen 3.5 0.8B**           | 0.53 GB                    | 3 GB    |
| C — Chat (vision)   | vision        | **Qwen3-VL 2B**             | 1.9 GB (incl. vision file) | 6 GB    |
| E — Image gen       | image         | **SDXL Lightning (4-step)** | 4.1 GB                     | 8 GB    |
| F — Voice (speak)   | voice         | **Kokoro TTS 82M**          | ~0.1 GB                    | 3 GB    |
| F — Voice (dictate) | transcription | **Whisper Base**            | 0.15 GB                    | 3 GB    |

That set lets you run every core suite. Everything below is optional depth.

---

## 2. Per-suite model picks (with alternatives)

### Suite C — Chat (text)

| Role                         | Model name        | HF repo                     | Size    | Notes                                                                  |
| ---------------------------- | ----------------- | --------------------------- | ------- | ---------------------------------------------------------------------- |
| **Light (start here)**       | **Qwen 3.5 0.8B** | `unsloth/Qwen3.5-0.8B-GGUF` | 0.53 GB | Tiny + fast; best first smoke test — proves `llama-server.exe` runs.   |
| Standard                     | Qwen 3.5 4B       | `unsloth/Qwen3.5-4B-GGUF`   | 2.7 GB  | Better answers; use if you have ≥8 GB.                                 |
| Reasoning check (TC-CHAT-03) | Qwen 3.5 2B or 4B | —                           | —       | These support "thinking" mode; use one of them for the reasoning test. |

### Suite C — Chat with images (vision) → also used by TC-CHAT-04 & TC-PROJ-04

| Role                   | Model name      | HF repo                                | Size   | Notes                                                                     |
| ---------------------- | --------------- | -------------------------------------- | ------ | ------------------------------------------------------------------------- |
| **Light (start here)** | **Qwen3-VL 2B** | `unsloth/Qwen3-VL-2B-Instruct-GGUF`    | 1.9 GB | Downloads the vision add-on automatically. Lightest capable vision model. |
| Alternative light      | SmolVLM2 2.2B   | `ggml-org/SmolVLM2-2.2B-Instruct-GGUF` | 2.0 GB | Equivalent; use if Qwen3-VL misbehaves.                                   |
| Standard               | Gemma 4 E4B     | `unsloth/gemma-4-E4B-it-GGUF`          | 6.0 GB | Higher quality vision + thinking; needs more RAM.                         |

> A "vision" model is what lets chat **see attached images**. Without one, TC-CHAT-04 and the
> image parts of Projects can't work — that's expected, not a bug.

### Suite E — Image generation

| Role                    | Model name                       | HF repo                      | Size          | Notes                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------- | ---------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start here**          | **SDXL Lightning (4-step)**      | `mzwing/SDXL-Lightning-GGUF` | 4.1 GB        | Single file, "Recommended" — simplest path to prove `sd-cli.exe` + its DLLs load on Windows. **Do this one first.**                                                                                                             |
| Fastest drafts          | SDXL Turbo (fast drafts)         | `OlegSkutte/sdxl-turbo-GGUF` | 4.1 GB        | 1–4 step quick drafts.                                                                                                                                                                                                          |
| **Advanced (test 2nd)** | Z-Image Turbo (2026)             | `leejet/Z-Image-Turbo-GGUF`  | ~6.7 GB total | Flagship, but uses a **multi-file** pipeline (downloads a text-encoder + VAE too). Because it's a more complex spawn, test it **after** SDXL Lightning succeeds — if Lightning works and Z-Image doesn't, note that difference. |
| img2img (TC-IMG-03)     | SDXL Lightning or any SDXL above | —                            | —             | The SDXL models support image-to-image; Z-Image is txt2img only.                                                                                                                                                                |

> **Image gen is the #1 Windows risk area.** If generation fails, grab the console text
> (per the test plan) — a `.dll` / library error here is exactly what we're hunting for.

### Suite F — Voice

| Role                         | Model name               | HF repo                                  | Size    | Notes                                                                  |
| ---------------------------- | ------------------------ | ---------------------------------------- | ------- | ---------------------------------------------------------------------- |
| **Text-to-speech (speak)**   | **Kokoro TTS 82M**       | `onnx-community/Kokoro-82M-v1.0-ONNX`    | ~0.1 GB | Default voice; used by TC-VOICE-01 / 03.                               |
| TTS alternative              | Piper – Lessac (English) | `rhasspy/piper-voices`                   | 0.06 GB | Use only if Kokoro fails.                                              |
| **Speech-to-text (dictate)** | **Whisper Base**         | `ggerganov/whisper.cpp` (base)           | 0.15 GB | Default for TC-VOICE-02 / 03. Proves `whisper-cli.exe` + `ffmpeg.exe`. |
| STT lightest                 | Whisper Tiny             | `ggerganov/whisper.cpp` (tiny)           | 0.08 GB | Fastest, lower accuracy — fine for a functional test.                  |
| STT best                     | Whisper Large v3 Turbo   | `ggerganov/whisper.cpp` (large-v3-turbo) | 1.6 GB  | Only if you want to check accuracy on ≥6 GB RAM.                       |

### Suites G/H/J/K (Projects, Artifacts, Tools, Settings)

No extra models needed — they reuse the **text** model from Suite C (and the **vision** model
for image documents in TC-PROJ-04). Web search (TC-TOOL-02) needs internet but no model.

---

## 3. Test input files to prepare (create these before you start)

Put these in a folder like `C:\OffGridTest\` so they're easy to find in file pickers.

| File                      | For test                | How to make it                                                                                        |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `budget.txt`              | TC-PROJ-02              | A plain text file containing exactly: `The Q3 project budget is $5,000 and the deadline is March 14.` |
| `budget.pdf`              | TC-PROJ-02 (alt)        | Same text saved/printed as a PDF (to test PDF extraction too).                                        |
| `photo.jpg`               | TC-CHAT-04 / TC-PROJ-04 | Any clear photo — e.g. a picture of a **dog on grass**, or a screenshot with visible text.            |
| `sign.png`                | TC-PROJ-04              | An image containing readable text (a sign, a slide) — checks the model reads text from images.        |
| short `speech.wav`/`.mp3` | TC-PROJ-04 (audio)      | Record ~10 s of you saying a sentence, or grab any short clip.                                        |

For the doc-grounding test (TC-PROJ-02), the expected AI answer to _"What is the budget?"_ is
**"$5,000"** with a cited source — that specific number is why we plant it in the file.

---

## 4. Suite I (Integrations / MCP) — exact connector to add

This tests the Windows-sensitive `npx` launch path. Use the official **filesystem** reference
server — it's public and needs no login (first launch downloads the package, so keep internet
on for this test).

**TC-INT-02 — add this stdio connector:**

- Sidebar → **Integrations** → add connector → choose the **command** option.
- **Name:** `Filesystem`
- **command:** `npx`
- **args:** `-y @modelcontextprotocol/server-filesystem C:\OffGridTest`
- Save → **Connect**.
- **Expected:** shows **Connected** (the app spawned `npx` → `npx.cmd` under the hood).
- **Watch for:** a spawn / "command not found" error in the PowerShell console — capture it
  exactly; that's the specific Windows behavior we're verifying.

**TC-INT-03 — use it in chat:**

- In a chat (with a text model loaded), ask: `List the files in C:\OffGridTest using your tools.`
- **Expected:** the AI calls the filesystem tool and lists `budget.txt`, `photo.jpg`, etc.

> Requires **Node.js installed** on the test machine for `npx` to exist. If Node isn't
> installed, note that and skip TC-INT-02/03 (or install Node first) — it's a prerequisite of
> the connector, not an app bug.

**TC-INT-01 (HTTP connector)** — if you weren't given a real HTTP MCP endpoint, just verify
the **URL** form opens and accepts input (`https://mcp.example.com/endpoint`) and that a bad
URL fails gracefully. Don't file "couldn't connect" as a bug without a real endpoint.

---

## 5. Download-order cheat sheet

1. **Qwen 3.5 0.8B** (text) → immediately do Suite C chat + Suite D gateway.
2. **SDXL Lightning** (image) → Suite E.
3. **Whisper Base** + **Kokoro TTS 82M** (voice) → Suite F.
4. **Qwen3-VL 2B** (vision) → TC-CHAT-04, TC-PROJ-04.
5. (Optional) **Z-Image Turbo** → advanced image test.

If a download itself fails or hangs, that's a **Suite B (Models)** bug — report it with the
model name and console output, and move on to whatever you _can_ test.
