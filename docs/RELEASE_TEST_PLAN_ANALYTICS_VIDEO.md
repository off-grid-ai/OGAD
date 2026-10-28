# Release test plan — opt-in analytics + video

Manual checks for `release/analytics-video` across OGAD#215, desktop-pro#125, shared#68, OGAM#739, mobile-pro#94, browser-extension#25, website#93, brand#3.

Order matters. **Pass 0 blocks the release.** Pass 1 is the floor on every platform. Passes 2–5 are per feature. Passes 6–7 are platform-only work that cannot be faked from a Mac.

Ticks: ✅ pass · ❌ fail (file it) · ⬜ not run.

---

## Before you start

| Need | Why |
|---|---|
| A **packaged, signed** desktop build per OS | Dev builds skip analytics and take different permission branches |
| An **old profile** (pre-release install, with chats, documents, models) | Every upgrade check below |
| A **Pro licence** and a **free** account | Video and vault are Pro-gated |
| **Release/TestFlight** mobile builds | Debug builds never create the analytics SDK |
| One **NVIDIA** box (Win or Linux), one **AMD/Intel GPU** Windows box | Engine selection changed on both |
| One **Snapdragon** and one **non-Snapdragon** Android phone | Video runs on CPU on Adreno by design |
| **Firefox** | Extension has no automated Firefox coverage at all |

> Analytics in a release mobile build writes to the **real production PostHog project**. Know which channel you are on before you tick the box.

---

## Pass 0 — Resolve before shipping

These came out of the diff read, not from testing. Ali ruled on each on 2026-10-28; the decision column is his call, not a proposal.

| # | Thing | Decision | Where |
|---|---|---|---|
| 1 | Renderer still says **"Your photos never leave your devices"** while remote video rendering uploads character photos and start images as base64 — to a paired desktop or to **OpenRouter**, a paid third party. | Update the copy so both paths are truthful | desktop video |
| 2 | Save-password offer now sends the **plaintext password into the page's process** (closed shadow root). The test that asserted it never left the worker was rewritten in this diff. | Assess it properly; fix it if it is real, and pin the actual guarantee with a test either way | extension |
| 3 | iOS `NSPhotoLibraryUsageDescription` says "attach images to conversations"; **Animate a photo** now reads the library for video. | Make it accurate; audit the other usage strings too | mobile iOS |
| 4 | New iOS `UIBackgroundModes: [audio]` — Apple rejects this without audible playback. | Justify it or remove it | mobile iOS |
| 5 | Firefox AMO declares `data_collection_permissions: none`; the new README says requests follow Desktop's analytics setting. | Make the declaration match what we actually send | extension |
| 6 | **PostHog Cloud EU (Frankfurt)** is a new named sub-processor in `privacy.md`. | Disclose it publicly. **DPA signature is Ali's to do** | legal |
| 7 | Privacy §4 claims GDPR access/erasure cannot be honoured; §5 cites **EU AI Act Art. 50**. | The policy exists to safeguard us — keep it that way. State anonymity as the reason, don't assert legal conclusions, never promise what the product cannot keep | legal |
| 8 | `writing/architecture-of-trust.md` adds "with four rules:" followed by an **empty list**. | Fix it | website |
| 9 | Site moves from "no telemetry" to "opt-in". | **Ship the site with the apps**, never before | release order |
| 10 | Delete character has **no confirmation** and removes its photos. | Add one | desktop video |
| 11 | Gateway request timeout was removed — a hung desktop now hangs the phone's call. | **The timeout stays gone** — it was cutting off genuinely long responses. Instead the phone must be able to stop a call and come back to a correct state | mobile sync |
| 12 | Android Wan 2.1/2.2 are marked experimental. | Not experimental. Everything works — drop the marking | mobile Android |

---

## Pass 1 — Smoke, on every platform (~10 min each)

Run on **macOS, Windows, Linux, Android, iOS**. If any line fails, stop and fix.

1. Install fresh → app opens → onboarding completes.
2. Send a chat message → reply streams → app still responsive.
3. Open Models → list loads → no empty or error list.
4. Open Settings → every tab opens, no blank panel.
5. Search → type a query → results come back.
6. Restart the app → previous chat and settings are still there.
7. Desktop only: Back / Forward (`Cmd/Ctrl+[` and `]`) move between views and restore scroll.
8. Desktop only: no dead **Memories** nav item or broken deep link (those screens were removed).

---

## Pass 2 — Opt-in analytics

Default is **off**. The point of the feature is that nothing leaves until a human says yes.

### Desktop and mobile, same checks

| Step | Expect |
|---|---|
| Fresh install, watch the network before touching anything | **No traffic to `eu.i.posthog.com`** |
| Onboarding last step (desktop) / Auto Setup (mobile) | Consent checkbox, **unticked** |
| Skip or exit without ticking | Counts as "asked" — no prompt for 30 days |
| Settings → Analytics | Two switches, **Usage data** and **Crash reports**, both off |
| Turn one on | Save succeeds; switch disabled while saving; a failed save reverts it |
| Turn both off | Queue dropped and **anonymous ID reset** |
| Force a failure (fail a model download) | "Help us fix this?" appears, at most once per 30 days |
| "Not now" on that prompt | Silenced 30 days |
| Settings → Analytics → **What we share** | Two lists: share / never share |
| Settings → Analytics → **Report a problem** | Log loads; works with analytics **off**; empty log says so |
| Report a problem → Copy / Send | Desktop: Copy log, `mailto:` to support@getoffgridai.co, folder icon reveals the file. Mobile: share sheet |
| Crash scrubbing — use an account name ≥3 chars and a file path with spaces | Paths → `<file>`, quoted text → `<redacted>`, home dir and account name gone |
| Upgraded install that was never asked, after first reply | One-time "Help us fix what breaks"; "Not now" = gone forever |
| Mobile: Settings → Reset | Consent goes off but the one-time prompt must **not** return |

---

## Pass 3 — Video generation (Pro)

### Free build first
- Chat and Models show the upsell, never an error.
- A **Video** card appears in the Pro catalog.
- Mobile: Gallery → Videos tab stays plain rows; no Studio.

### Desktop, Pro
| Step | Expect |
|---|---|
| Sidebar → Video, first run | 3 example cards + 3 placeholder characters |
| Type a prompt, pick shape and length | Estimate reads "About N min on this Mac/PC/`<paired computer>`" |
| Empty prompt | **Make it** disabled |
| No video model installed | Error grows a "Get the video model" link to Models → Video |
| Drag in a JPEG/PNG | Thumbnail + **mandatory consent checkbox**; Make it stays disabled until ticked |
| Start-image model missing | Dimmed + popover with size + Download; download shows % and bytes; the action **auto-resumes** when it lands |
| Same, device too small | "needs X GB, this Mac has Y GB" — note the copy says "Mac" on Windows too |
| Make it | Making-of page: "N min left" / "Tonight" / "Stopped" / "Ready", live draft frame, per-shot tiles, 5-stage checklist, **Stop** works |
| Let it finish | Desktop notification; Watch page plays with captions; footer "Marked as made with AI." |
| Watch → Save as MP4 | File written; **C2PA "made with AI" claim is signed** (needs `c2patool`) |
| Watch → Delete | Confirm says "removed from your devices" — and it is, on the paired device too |
| Library | Tabs, poster grid, hover preview, overlays (Making · N%, Renders tonight, Storyboard, Stopped) |
| Storyboard editor | Per-shot edits; everything locked while rendering. **Without the start-image model a "continue" shot silently renders as a cut** — confirm or file |
| Characters | Name ≤60 + 1–4 photos; typing a saved name adds a "With `<name>`" chip; **delete removes photos with no confirm** |
| Chat → `generate_video` | In-chat progress names NPU/GPU/CPU; result card offers Continue / New shot / Make it a story |
| Chat → `make_film` with a photo | Consent dialog → character dialog → shape question (**asked once ever**, needs a reset to retest) |
| Settings → Video | Without a pack: "Download a complete video model pack…". With one: backend, shape, voice, size, fps, steps, seed |
| Downgrade the licence with a render queued | Degrades cleanly, no crash |
| Free disk under 3 GB | Queue refuses to start, says why |

### Mobile, Pro
| Step | Expect |
|---|---|
| Gallery → Videos (n) | With Pro, navigates to the Library |
| "One sentence, one film" → arrow | Needs a local video model **or** a paired desktop; without either: alert + "Find my computer" |
| Make it real | Per-shot progress: "Shot 2 of 4", "Adding narration", "Joining the shots" |
| Failure | "Could not finish" + **Try again** |
| Success | "Ready · 4 s · 832×480"; AI label visible on screen **and** in file info |
| Continue from a clip | Needs an init-image model — in practice the paired desktop; may trigger a multi-GB download **on the desktop** |
| Animate a photo | Photo-library access + consent alert |
| Low memory | "Not enough available memory…" + **Run anyway** |
| Second run while one is going | `VIDEO_BUSY` / `IMAGE_BUSY`, not a crash |

---

## Pass 4 — Search and retrieval (desktop)

| Step | Expect |
|---|---|
| Empty query | Newest-first feed, facets by source |
| Time phrases ("last week"), people, to-do due dates | Resolve correctly |
| **Non-Latin search** — CJK, Thai, Khmer, Burmese | Findable. This is new; test it explicitly |
| Command palette | Same engine, same results as the Search screen |
| Models → **Embedding** tab | 6 curated embedders + HF search box (fires per keystroke) |
| Switch embedder | Confirm dialog "Changing it rebuilds saved indexes now." |
| During rebuild | Banner: preparing → rebuilding (done/total) → done; search keeps working off the old index |
| **Cancel** mid-rebuild | Rolls back at the next batch; "Previous embedding model and search index restored." |
| Kill the app mid-rebuild, relaunch | Resumes from the cursor; or auto-rolls back and asks you to pick again |

---

## Pass 5 — Browser extension

Load `dist/chrome` in Chrome/Brave and `dist/firefox` in Firefox (`about:debugging` → Load Temporary Add-on). Min Firefox 128.

| Step | Expect |
|---|---|
| Not paired | Vault offers pairing, not broken data |
| Paired, Desktop closed | Connection failure message + retry |
| Paired, free licence | Feature unavailable, not an error |
| Paired, Pro, vault locked | Unlock screen |
| Sign in on any site | Save offer card with **editable Username and Password** fields + Show/Hide |
| Edit the fields, Save | **What is in the fields is saved**, not what the page submitted |
| Clear the password, Save | Inline "Enter the password to save."; nothing reaches the vault |
| Existing login | Button reads **Update** |
| Navigate to another origin | No offer carried over |
| Side panel → Vault → **Authenticator** | 5th tab; create with Name/Issuer/Account/Setup key (base32 or `otpauth://`) |
| Empty setup key | Rejected |
| Open a saved authenticator | Live rotating TOTP |
| Autofill with it | Fills **only** the one-time-code field; username/email untouched |
| CSV export → import | Round trips |
| Old extension + new Desktop (and the reverse) | Unknown item kinds are skipped, the rest of the list still renders — **no empty vault** |
| Both themes | New fields readable in dark mode |

**Firefox specifically** — the background is an event page, not a service worker, and the offer is held in memory across the submit navigation:
- Submit a login form that **navigates away** → the offer must still appear, with the right username and password.
- Open the Vault from the **sidebar** (Ctrl+Shift+Y), not a side panel.
- `diff <(jq -S . dist/chrome/manifest.json) <(jq -S . dist/firefox/manifest.json)` → only the three known deltas.

No permissions changed this release, so no user has to re-accept anything. Confirm that holds after the build.

---

## Pass 6 — Platform-only checks

Nothing here can be verified from a Mac. Each line names the box it needs.

### macOS
- Image **and** video generation on **macOS 13** and on latest. Intel Mac if you have one — the universal slice is new.
- On macOS 13: Kev models **hidden**, not failing. Same on Intel.
- **Signed + notarized** build: voice (TTS) and semantic search actually start. The unsigned-library fork is darwin-only and never shows in dev.
- Non-English TTS voices on macOS 13.
- DMG filename now carries the arch — release-page assets and auto-update still resolve.
- Video **Share** uses the native sheet.
- Computer Use still asks for and uses Accessibility + Screen Recording (the Swift helper was deleted).
- Parakeet: no symlink in the bundle, or the signature breaks.

### Windows
- **Non-NVIDIA GPU (AMD/Intel)**: transcription on the new Vulkan whisper; chat and image on Vulkan. This was the bf16 crash.
- **No Vulkan driver** at all: falls back to `whisper-cpu`.
- **Clean VM with no VC++ redistributable**: llama, whisper, sd, ffmpeg, kev and the CUDA pack all start.
- **NVIDIA**: image/video (CUDA 12.8) and chat (CUDA 12.4) in the same session.
- NVIDIA first use: CUDA probe runs, reports CUDA, names the GPU.
- Non-NVIDIA: DirectML/WebGPU still work.
- **Upgrade with a performance pack installed** — found in the old Roaming path, not re-downloaded. Fresh install lands in **LocalAppData**.
- **Git Bash on PATH**: pack extraction still works (System32 bsdtar).
- Installer contains `whisper-vulkan`, Parakeet exe + dll, `c2patool.exe`; contains **no** `onnx-cuda/`.
- Old NVIDIA driver: "driver too old", not a failing engine.

### Linux
- Distro **without `libvulkan1`**: GPU engines still start.
- Clean Ubuntu 24.04 `.deb` resolves deps; AppImage on the same box (needs `libfuse2t64`, x64).
- **NVIDIA**: install the pack — the app must **not** relaunch, and search/voice pick up CUDA in the same session.
- AppImage: anything that restarts the app comes back.
- Ubuntu 22.04 smoke.

### Android
- **Android 15 and Android 14** fresh install: generation starts (foreground service type differs by SDK; a failure shows only as "video failed").
- Notification shade: "Generating video", **Stop** aborts and clears. A clip inside a film = **one** notification.
- Android 13+: `POST_NOTIFICATIONS` prompt on render and download start; **denying still renders and downloads**.
- **Screen off** mid-film → come back → progress continued.
- Long film hits the ~6 h/day cap → stops cleanly.
- Save → lands in **Downloads**, visible in Files; a cancelled export leaves no stub.
- **Snapdragon/Adreno**: video and sd.cpp images run on **CPU** by design — check the reported backend and that output is not black.
- Non-Snapdragon: Vulkan path.
- 16 KB-page device (Pixel 8+ / Android 15) loads at all.
- AAB ships `arm64-v8a` + `x86_64` only; 32-bit devices show "not compatible" in Play.
- Release build has **no** "Video diagnostic" dev items.
- Home-swipe during playback does not leave a broken PiP.

### iOS
- **iOS 18 and iOS 26** both: backgrounding mid-render. iOS 26 continues with a system progress item; older stops with "Video generation stopped when the app went into the background."
- TestFlight build **installs at all** (new background-task entitlement; a mis-provisioned profile fails).
- iOS 17 floor — iOS 16 devices are out.
- Film plays when output fps > source fps.
- Auto-lock returns to normal after a render.
- Export uses the **Share** sheet.

### Device gates, both phones
- iPhone sees **Wan 2.1 only**; Wan 2.2 is Android-only.
- Under 11 GB RAM: no video model, "Videos are made on your computer…" + **Find my computer**.
- 11 GB+: the two Light packs (iPhone sees one).
- ~8 GB Android: RealVisXL Lightning Q4 is now admitted — confirm it **completes** rather than being killed.

---

## Pass 7 — Upgrade from an old install

Fresh installs hide every one of these. Use a real pre-release profile with chats, documents and models.

### Desktop
| Step | Expect |
|---|---|
| Launch the upgrade on a large profile (Pro, many observations) | Search works **immediately** — the old index answers while the new one builds |
| Kill the app mid-rebuild, relaunch | Resumes from the cursor |
| Check `userData/lancedb` | **Deleted, silently, with no prompt.** Semantic search returns nothing until the backlog drains, then comes back |
| Attached documents | Re-embed on next use (new embedder, ~470 MB instead of ~90 MB) |
| Profile that had **Pony Diffusion** or the **Lessac** voice selected | Sane fallback, not a blank picker |
| Move models out and back, onto a folder that already holds a copy; cancel mid-move | Restores cleanly. Across drive letters (Win) and mounts (Linux) |
| New-vault creation | **Recovery phrase is actually shown** before unlock |

### Mobile
| Step | Expect |
|---|---|
| Old build with chats, images and custom generation settings → upgrade | No crash on launch, Gallery or Storage. The persisted store grew with **no migration and no version bump** — this is the one most likely to break |
| Upgrade with indexed documents, **do not touch the Embedding tab** | Semantic search still works |
| Then switch embedder and try to break it: kill the app mid-switch, go offline mid-download, pick a non-BERT GGUF | Old model and **old vectors survive** |
| Upgrade with in-flight downloads of each type | Nothing lands under the wrong tab (image or whisper showing under Text) |
| Existing `ggml-*.bin` whisper models | Still found, loadable, deletable |
| Existing SDXL install | Still lists, loads and generates, even though it is no longer offered |
| Several downloads finishing at once | No duplicate or lost rows |

---

## Pass 8 — Website and legal reading

Read the source `preview-ui/*.jsx`, not the generated `_includes` HTML.

**Word for word, before release:** `privacy.md` (new §4 analytics, §5 Video Studio, rewritten §3), `terms.md` (feedback licence, three new prohibited uses, liability sentence).

**Claims must match what the apps actually do:** `page.jsx` (home), `desktop.jsx`, `mobile.jsx`, `pro.jsx`, `mission.jsx`, `vision.jsx`, `ogap.jsx`, `recorder.jsx`, `investors.jsx`, `llms.txt`, the three `guides/`.

**Read in full — they publicly reverse an earlier position:** `writing/7-principles-personal-ai-os.md`, `writing/architecture-of-trust.md`.

**Spot-check 5 of 52:** `articles/` — mechanical find-and-replace of "nothing leaves your device"; watch for sentences that now read awkwardly.

**Read first:** `brand-analytics/brand_tone_voice.md` — it is the rulebook the rest is supposed to follow.

Written promises in the policy that someone must confirm the apps keep: IP discarded at the provider, anonymous ID reset and queued events dropped on opt-out, crash reports scrubbed, 12-month retention configured.
