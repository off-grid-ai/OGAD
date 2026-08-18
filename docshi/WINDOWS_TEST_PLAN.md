# Off Grid AI — Windows Test Plan (Core)

**For the tester:** You don't need to know this product beforehand. This doc tells you what
each feature is, exactly what to click, and what _should_ happen. Your job is to run each
test case on Windows and record **Pass / Fail / Blocked**, and file any problem using the
[bug format](#3-how-to-report-a-bug) below.

Local setup is already done, so there are no install-from-source instructions here — you're
testing the **packaged Windows build** (the `.exe` installer produced by CI, or a local
build you were given).

---

## 1. What this app is (30-second orientation)

Off Grid AI is a desktop app that runs AI models **entirely on your own computer** — no
internet account, no cloud. Think "a private ChatGPT that lives on this PC." It can:

- **Chat** with an AI (text, and images you attach)
- **Generate images** from a text prompt
- **Voice**: turn speech into text and text into speech
- **Projects**: upload your documents and ask questions about them
- **Gateway**: expose a local web API other programs can call
- **Integrations (MCP)**: plug in external tool servers
- **Artifacts**: the AI can render mini web pages / diagrams live

Everything happens locally, so the **first time you use a feature you usually have to
download a model** for it. That's expected.

### The window layout

- A **left sidebar** with these items: **Projects, Chat, Integrations, Models, Gateway,
  Settings**. (You navigate by clicking these.)
- Some sidebar items may show a **lock icon or an "Upgrade / Pro" screen** when clicked
  (e.g. Day, Replay, Reflect, Meetings, Actions). **These are "Pro" features and are OUT
  OF SCOPE — skip them.** Only test the items listed above.
- The app should work **fully offline**. The _only_ feature that intentionally uses the
  internet is downloading models and "web search" in chat.

---

## 2. Before you start — record your environment

Fill this once and put it at the top of every bug report:

```
Build / installer file name + version : __________  (e.g. off-grid-ai-0.0.25-setup.exe)
Windows version                        : __________  (Win + R → "winver")
CPU model                              : __________
RAM (GB)                               : __________
GPU (if any)                           : __________
```

### How to capture logs (do this — most bugs are useless without logs)

The packaged app hides its internal logs by default. To see them, **launch it from a
terminal so its output prints there:**

1. Open **PowerShell**.
2. Run the app's executable directly, e.g.:
   ```powershell
   & "$env:LOCALAPPDATA\Programs\off-grid-ai\off-grid-ai.exe"
   ```
   (If it installed elsewhere, right-click the desktop shortcut → _Open file location_ to
   find the `.exe`, then run that path.)
3. Leave this PowerShell window open — **error messages and `[llama-server]` / `[OCR]` /
   `[update]` lines print here.** Copy/paste relevant lines into your bug report.

**Where app data lives** (models, database, generated images) — useful to attach or clear:

```
%APPDATA%\Off Grid AI      (try this first)
%APPDATA%\off-grid-ai      (fallback)
```

Open by pasting that into the File Explorer address bar.

---

## 3. How to report a bug

For **every** failure, copy this template into your tracker (Jira/GitHub/Sheet) and fill it:

```
BUG ID        : WIN-001
Test case     : TC-CHAT-02
Title         : One-line summary (e.g. "Chat produces no response, DLL error in console")
Severity      : Blocker / High / Medium / Low   (see rubric below)
Reproducible  : Always / Sometimes (X of Y tries) / Once
Environment   : <paste your environment block from section 2>

Steps to reproduce:
  1.
  2.
  3.

Expected result :
Actual result   :

Console / logs  : <paste the relevant lines from the PowerShell window>
Screenshot/video: <attach>
Notes           : anything else (e.g. "worked after restarting app")
```

### Severity rubric

| Severity    | Use when…                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| **Blocker** | The app won't install/launch, or a whole feature is completely unusable and has no workaround.         |
| **High**    | A core feature fails or gives wrong results, but other features work.                                  |
| **Medium**  | Feature works but is broken in a noticeable way (bad layout, slow, confusing error, minor data issue). |
| **Low**     | Cosmetic: typo, misalignment, wrong icon, polish.                                                      |

### Special things to flag loudly (Windows-specific red flags)

If you see any of these, note it prominently — they're the failures we most expect:

- A popup or console error mentioning **`.dll`**, **"VCRUNTIME"**, **"MSVCP"**, **"was not
  found"**, or **"is not a valid Win32 application"** → a bundled AI binary failed to load.
- **SmartScreen / "Windows protected your PC"** warning during install → expected (build is
  unsigned) — just note it happened; click _More info → Run anyway_ to continue.
- A feature spins forever / never responds → capture the console and say which feature.
- After closing the app, a leftover **`llama-server.exe`** in Task Manager (see TC-STAB-02).

---

## 4. Test suites

Run in this order — later tests depend on earlier ones. **P0 = critical path**, do these
first; if a P0 fails, note it and continue where possible.

Legend for the **Result** you record: ✅ Pass · ❌ Fail · ⛔ Blocked (couldn't run because
something earlier failed) · ⏭️ Skipped.

---

### Suite A — Install & first launch `P0`

**What it proves:** the installer works and the app opens on Windows.

**TC-INSTALL-01 — Install the app**

1. Double-click the `-setup.exe` installer.
2. If **"Windows protected your PC" (SmartScreen)** appears → click _More info_ → _Run
   anyway_. (Note in your report that it appeared — expected for now.)
3. Complete the installer.

- **Expected:** Installs without error; a desktop shortcut named **Off Grid AI** is created.

**TC-INSTALL-02 — First launch & onboarding**

1. Launch the app (ideally from PowerShell per section 2 so you capture logs).
2. Observe the first-run **onboarding** screen(s); click the **Continue / Next** button
   through to the end.

- **Expected:** A welcome/onboarding screen appears, then you land on the main app on the
  **Models** screen. No crash, no blank white window.

**TC-INSTALL-03 — Window & navigation**

1. Click each sidebar item that is in scope: **Projects, Chat, Integrations, Models,
   Gateway, Settings.**

- **Expected:** Each opens its screen without crashing. (Locked/Pro tabs showing an upgrade
  screen are fine — skip them.)

---

### Suite B — Models (download a model) `P0`

**What it proves:** the app can download an AI model — nothing else works without one.

**TC-MODEL-01 — Browse the catalog**

1. Sidebar → **Models**.
2. Look at the recommended models list (grouped by size, e.g. "Fits in …").

- **Expected:** A list of models renders. No blank screen or error.

**TC-MODEL-02 — Download a small text model**

1. In **Models**, pick a **small** recommended chat/text model (smallest available, so the
   download is quick).
2. Click its **Download** button. Watch the progress bar.

- **Expected:** Download progresses to 100% and the model shows as installed/active. A
  **Cancel** control is available during download.
- **Watch for:** stuck at 0%, network error, or the file downloads but never becomes
  "ready."

**TC-MODEL-03 — Hugging Face search (uses internet)**

1. In **Models**, use the search to look up a model by name (e.g. type "qwen").

- **Expected:** Search returns results you could download.

---

### Suite C — Chat `P0`

**What it proves:** the core AI text engine (`llama-server.exe`) runs on Windows. This is
the single most important suite.

**TC-CHAT-01 — Send a text message**

1. Sidebar → **Chat**. Start a new chat.
2. Type `Hello, who are you?` and send.

- **Expected:** The AI replies with text that **streams in word-by-word**. Reply is coherent.
- **Watch for (Windows red flag):** no reply at all + a `.dll` / "llama-server" error in the
  PowerShell console = the AI binary failed to load. **Report as Blocker.**

**TC-CHAT-02 — Multi-turn conversation**

1. After the reply, send a follow-up like `Summarize that in one sentence.`

- **Expected:** The AI responds in context (remembers the previous message).

**TC-CHAT-03 — Reasoning / "thinking" mode**

1. If there's a **reasoning / thinking** toggle for the chat, enable it and ask a
   reasoning question (e.g. `If a train travels 60km in 45 minutes, what is its speed?`).

- **Expected:** You may see a separate "thinking" section, then a final answer. Answer is
  correct (80 km/h).

**TC-CHAT-04 — Vision (attach an image)** — _requires a vision-capable model_

1. Download a **vision** model from Models if prompted (one that supports images).
2. In a chat, attach an image file (e.g. a photo or screenshot) and ask
   `What's in this image?`.

- **Expected:** The AI describes the image contents.
- **Watch for:** attach button does nothing, or the model errors on the image.

**TC-CHAT-05 — Per-chat settings**

1. Open the chat's settings (temperature, context window) and change the context window.

- **Expected:** Setting saves; chat continues to work afterward (the model restarts quietly).

---

### Suite D — Gateway (local API) `P0`

**What it proves:** the local OpenAI-compatible web API works — a key selling point.

**TC-GW-01 — Gateway screen**

1. Sidebar → **Gateway**.

- **Expected:** Shows a **Base URL** (e.g. `http://127.0.0.1:7878/v1`) and a list of
  **Endpoints**.

**TC-GW-02 — Call the API from PowerShell**

1. With a chat model downloaded and the app open, run in PowerShell:
   ```powershell
   curl.exe http://127.0.0.1:7878/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"local","messages":[{"role":"user","content":"Hello!"}]}'
   ```

- **Expected:** A JSON response containing the AI's reply text.
- **Watch for:** "connection refused" (server not listening) or an empty/error JSON.

**TC-GW-03 — Models endpoint**

1. Run: `curl.exe http://127.0.0.1:7878/v1/models`

- **Expected:** JSON listing your installed model(s).

---

### Suite E — Image generation

**What it proves:** `sd-cli.exe` (the image engine) runs on Windows. **This is a known
Windows risk area** — test carefully and capture the console.

**TC-IMG-01 — Download an image model**

1. Sidebar → **Models**. Find an **image generation** model (e.g. an SDXL/Z-Image entry)
   and download it.

- **Expected:** Downloads and shows as installed.

**TC-IMG-02 — Generate an image**

1. Open the image-generation UI, enter a prompt like `a red bicycle on a beach, sunset`.
2. Start generation.

- **Expected:** You see a **live step-by-step preview** as the image forms, a progress/ETA,
  and a final PNG. The image roughly matches the prompt.
- **Watch for (Windows red flag):** generation fails immediately with a **`.dll` error** in
  the console (the SD engine couldn't load its libraries). **Report with the exact console
  text — this is a specific thing we're checking.**

**TC-IMG-03 — Image-to-image** _(if the UI offers it)_

1. Provide a starting image + a prompt and generate.

- **Expected:** Output is a variation based on the input image.

---

### Suite F — Voice

**What it proves:** speech-to-text (`whisper-cli.exe` + `ffmpeg.exe`) and text-to-speech
(Kokoro) work on Windows.

**TC-VOICE-01 — Text-to-speech (speak)**

1. Find the **speak / play audio** control on an AI message (or the voice settings), and
   trigger it. Download the voice model if prompted.

- **Expected:** You **hear** the text spoken aloud through your speakers.
- **Watch for:** no audio, or a console error about the TTS worker.

**TC-VOICE-02 — Speech-to-text (transcribe)**

1. Use the **microphone / voice input** to dictate a message (say a sentence).

- **Expected:** Your speech is transcribed into text in the message box.
- **Watch for:** Windows may ask for **microphone permission** — allow it. No transcript, or
  an `ffmpeg`/`whisper` error in console = fail.

**TC-VOICE-03 — Hands-free voice mode** _(if present)_

1. Enter the hands-free voice mode and have a short spoken back-and-forth.

- **Expected:** You speak → it transcribes → AI replies → reply is spoken aloud.

---

### Suite G — Projects (chat over your documents / RAG)

**What it proves:** document upload + "answer using my files" works.

**TC-PROJ-01 — Create a project**

1. Sidebar → **Projects** → create one (name it, e.g. "Test Project").

- **Expected:** Project is created and opens.

**TC-PROJ-02 — Upload a document & ask about it**

1. In the project's **Knowledge base**, upload a **PDF or .txt/.docx** file that contains
   some specific fact (e.g. a document that says "The budget is $5,000").
2. Wait for it to finish processing.
3. Start a chat in that project and ask a question only answerable from the doc
   (e.g. `What is the budget?`).

- **Expected:** The AI answers using the document ($5,000) and shows a **cited source**.
- **Watch for:** upload fails, processing hangs, or the AI ignores the document.

**TC-PROJ-03 — Per-project instructions**

1. Set a project instruction (e.g. "Always answer in French").
2. Ask a question in that project.

- **Expected:** The AI follows the instruction.

**TC-PROJ-04 — Audio/image document** _(depends on voice/vision models)_

1. Upload an **image** (with visible text or clear objects) and/or a short **audio** file.
2. Ask about its contents.

- **Expected:** Image is described / audio is transcribed and usable in answers.

---

### Suite H — Artifacts / canvas

**What it proves:** the AI can render live mini-webpages/diagrams (pure UI, should be
reliable on Windows).

**TC-ART-01 — Render an artifact**

1. In Chat, ask: `Make a simple HTML page with a button that shows an alert when clicked.`

- **Expected:** A rendered **Preview** appears in a canvas, with a **Code / Preview** toggle
  and a **Download** option. Clicking the button in the preview shows the alert.

**TC-ART-02 — Mermaid diagram**

1. Ask: `Draw a flowchart of making tea, as a mermaid diagram.`

- **Expected:** A diagram renders in the canvas.

---

### Suite I — Integrations (MCP connectors)

**What it proves:** external tool servers can be added and used. **stdio connectors that
launch `npx` are a Windows-sensitive area** — test TC-INT-02.

**TC-INT-01 — Add an HTTP connector**

1. Sidebar → **Integrations** → add a connector using the **URL** option
   (`https://mcp.example.com/endpoint` field). Use any test MCP endpoint you were given, or
   just verify the _form_ opens and accepts input if you have no endpoint.

- **Expected:** Connector saves; **Connect** attempts a connection.

**TC-INT-02 — Add a stdio connector (`npx`)** — _Windows red flag area_

1. Add a connector using the **command** option: command = `npx`, args = an MCP server
   package you were given (or a known one).
2. Enable / connect it.

- **Expected:** The connector shows as **Connected** (the app launched `npx` under the
  hood).
- **Watch for:** "command not found" / spawn errors in the console — capture them exactly.

**TC-INT-03 — Use a connector in chat**

1. With a connector connected, ask the AI something that would use its tool.

- **Expected:** The AI calls the tool and uses the result in its answer.

---

### Suite J — Tools in chat

**TC-TOOL-01 — Calculator / datetime**

1. Ask: `What is 1234 * 5678?` and `What is today's date and time?`

- **Expected:** Correct math (7,006,652) and a correct current date/time.

**TC-TOOL-02 — Web search** _(uses internet)_

1. Ask something requiring fresh info, e.g. `Search the web for the latest news about NASA.`

- **Expected:** The AI performs a search and summarizes results.

---

### Suite K — Settings, persistence & theming

**TC-SET-01 — Theme toggle**

1. Sidebar → **Settings**. Toggle between light and dark theme.

- **Expected:** The whole app switches theme cleanly (no unreadable text, no broken layout —
  check the starry background is visible in both).

**TC-SET-02 — Data persists across restart** _(also tests encryption-at-rest)_

1. Have at least one chat with history.
2. **Fully quit** the app, then reopen it.

- **Expected:** Your previous chats/projects are **still there**. Downloaded models are still
  installed.
- **Watch for:** database errors on startup in the console, or everything wiped.

---

### Suite L — Stability & cleanup

**TC-STAB-01 — Long session**

1. Use chat + image gen + voice over ~15–20 minutes.

- **Expected:** No crash, no runaway memory. Note if the app becomes sluggish.

**TC-STAB-02 — No orphaned processes after quit** — _Windows-specific check_

1. Quit the app fully.
2. Open **Task Manager → Details** and search for **`llama-server.exe`** (and
   `sd-cli.exe`, `whisper-cli.exe`).

- **Expected:** **None** of these are still running after the app is closed.
- **Watch for:** a leftover `llama-server.exe` — report it (it would block the next launch).

**TC-STAB-03 — Relaunch after quit**

1. Reopen the app and send a chat message.

- **Expected:** Works first try (no "port in use" / model won't load error from a leftover
  process).

---

### Suite M — Auto-update _(likely N/A right now — confirm and note)_

**TC-UPD-01 — Update check**

1. Watch the console at startup for `[update]` lines.

- **Expected for this branch:** it's fine if updates **don't** work yet — the Windows update
  feed isn't published. **Just record what you see** (e.g. `[update] check failed` or
  nothing). Don't file this as a bug unless the app _crashes_ over it.

---

## 5. Quick summary sheet (fill and return)

| Suite                      | Result (✅/❌/⛔/⏭️) | Bug IDs filed |
| -------------------------- | -------------------- | ------------- |
| A — Install & launch       |                      |               |
| B — Models                 |                      |               |
| C — Chat                   |                      |               |
| D — Gateway                |                      |               |
| E — Image generation       |                      |               |
| F — Voice                  |                      |               |
| G — Projects / RAG         |                      |               |
| H — Artifacts              |                      |               |
| I — Integrations (MCP)     |                      |               |
| J — Tools in chat          |                      |               |
| K — Settings & persistence |                      |               |
| L — Stability & cleanup    |                      |               |
| M — Auto-update            |                      |               |

**Overall verdict:** Core app is ☐ usable / ☐ usable with issues / ☐ blocked on Windows.

> Priority order if you're short on time: **A → B → C → D** (install, model, chat, gateway)
> are the critical path. If those pass, the app fundamentally works on Windows; the rest
> tells us how complete it is.
