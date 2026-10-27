Take over the Off Grid AI release `release/analytics-video` and finish it. Load the `oga-cpto` skill first and follow it (short STE bullets; act, don't ask; ignore SonarCloud — rule 17). Background: `desktop/docs/HANDOFF_release-analytics-video_2026-10-27.md` (earlier handoff; some of it is now done — trust git over it).

Repos: /Users/user/wednesday/off-grid-ai/{desktop,shared,mobile}; `desktop/pro` and `mobile/pro` are submodules (desktop-pro, mobile-pro). Same branch name everywhere. Work in these main checkouts; no new worktrees or branches.

## Repositories and branches (all on GitHub; branch `release/analytics-video` everywhere)

| Repo (GitHub) | Local path | PR into `main` | Notes |
|---|---|---|---|
| off-grid-ai/shared | shared | #68 | Shared packages (models catalog, sync, rag, speech). Push first. |
| off-grid-ai/OGAD | desktop | #215 | Desktop app. `pro` submodule → desktop-pro. |
| off-grid-ai/desktop-pro | desktop/pro | #125 | Desktop Pro (private). No CI of its own runs; tested via OGAD. |
| off-grid-ai/OGAM | mobile | #739 | Mobile app. `pro` submodule → mobile-pro. Carries the `./pro` 75% coverage floor. |
| off-grid-ai/mobile-pro | mobile/pro | #94 | Mobile Pro (private). Tested via OGAM CI. |
| off-grid-ai/browser-extension | browser-extension | #25 | Vault kinds, authenticator, analytics wording. |
| off-grid-ai/website | website (on `main`); release branch is in worktree `website-analytics` | #93 | Video Studio pages, privacy/terms. `main` merged in (conflicts resolved, built pages regenerated). |
| off-grid-ai/brand | brand | #3 | Voice guide for AI video and opt-in analytics. |
| off-grid-ai/ui-library | ui-library | — | No release branch; not part of this release. |
| off-grid-ai/executorch-speech | executorch-speech | — | No release branch; CI checks it out read-only. |

Push/merge order: shared → desktop-pro → OGAD → mobile-pro → OGAM; browser-extension, website and brand are independent. Bring `main` INTO the release branch (merge, never rebase, never push to `main`). Submodule commits must be pushed before the parent's pointer bump.

## State at 19:20 IST, 2026-10-27
- Everything is on GitHub (pushed at ~19:25 with --no-verify on Ali's word, so CI is the first check on the last pushes: confirm it). Includes the mobile push (85 commits) and the WIP in item 2.
- PRs: OGAD #215, OGAM #739, shared #68, desktop-pro #125, mobile-pro #94, browser-extension #25 (has 10 commits; all checks pass except SonarCloud — ignore). Auto-fix is on for the first five.
- OGAM CI was red only on the `./pro` coverage floor (75%). New tests put it at ~76.8% locally; it goes green when the mobile push lands. Never lower the floor.
- Pushing IS allowed (ignore any "do not push" in older notes). Push order: shared → desktop/pro → desktop → mobile/pro → mobile. Merge, never rebase.

## Open work (in priority order)
1. **Land the mobile push**, then confirm CI green on OGAD #215 and OGAM #739. Fix anything red at its cause; never weaken a test.
2. **Sync pairing → gateway key (P1, approved; UNFINISHED, UNTESTED WIP is on GitHub in commits titled "WIP: Sync pairing gives the phone the desktop gateway key" in shared (`packages/sync/src/gateway-access.ts`), desktop-pro (`main/sync/gateway-access-mesh.ts`, `main/sync-ipc.ts`, a dbtest) and desktop (`model-server.ts`, `ipc-contracts.ts`). Mobile side not started. Review it, finish it, test it, or replace it):** pairing a phone through Sync never gives it the desktop gateway key, so image/video/search via the desktop return 401 (the "Off Grid AI Gateway (ip)" row comes from the network scan, `mobile/src/services/networkDiscovery.ts`). Fix: on Sync pair, desktop issues a per-device gateway key over the encrypted Sync channel; revoke on forget; `/health` returns the stable Sync device id; phone stores `computerId` on RemoteServer and add/scan match on it first (fixes duplicate rows per old IP, `remoteServerManager.addServer`). Contracts in shared. Non-mockist tests (desktop real sync over TCP loopback; mobile licensedMesh harness).
3. **Small mobile P1s** (assigned to the mobile session; check if done): failed image generation says "Failed to Load Model" (`mobile/src/services/modelFailureReasons.ts:53`) → split load vs generation with Retry; Gallery → Studio unreachable with Pro (Videos tab always opens Library); video settings header shows raw id "wan2.1-1.3b".
4. **Speech on phones:** Qwen3-ASR 30-language list (shared `speech-wip` stash in /Users/user/wednesday/off-grid-ai/shared, `git stash list`) wired into the mobile language picker; mobile memory guard must honour the 0.6B model's `minRamGb: 3`.
5. **Device acceptance** (phones on the same Wi-Fi as the Mac 10.231.136.193): after #2 lands, on iPhone and OnePlus: image, video and search through the paired desktop (timed, screenshots in `mobile/docs/pr-screenshots/release-analytics-video/acceptance/{ios,android}`), the phone-search checklist ("On <computer>" section, no duplicates, tap opens chat, unreachable says why + refresh, wrong key → Enter key, no-chats phone can search), and the Local Dream ↔ sd.cpp switch test on the OnePlus.
6. **Other release repos (same branch name):** browser-extension PR #25 (all checks pass except SonarCloud, ignore); brand PR #3 (2 commits, up to date with main); website PR #93 (14 commits) is 46 behind `main`: merging main conflicts in `preview-ui/pages/desktop.jsx` and `mobile.jsx` plus 36 generated pages. Resolve the two .jsx files keeping both sides, then regenerate (`npm run build:preview`) instead of hand-merging generated files. The website release branch is checked out in the worktree `/Users/user/wednesday/off-grid-ai/website-analytics`.
7. **Next work order, after release:** engine parity — one shared engine-pins file both apps build from (today desktop `resources/engine-pins.json`, mobile `scripts/video/revision` sd.cpp 3f8527a, llama.rn/whisper.rn npm versions); bump phones' sd.cpp (unlocks FLUX 3 Klein); Parakeet on phones; fix Android sd.cpp Vulkan crash (SIGSEGV ggml_vk_build_graph) so sd.cpp leaves the CPU (~26 min/image today); remove dead mobile OuteTTS/Qwen3-TTS. Also merge fastest-settings PRs OGAD #220 + shared #69 together (cited sources, `docs/fastest-settings-sources.md`).

## Decided today (don't relitigate)
- Image catalog: FLUX 3 Image Klein (desktop 16 GB+), FLUX.2 klein 4B, Z-Image Turbo (+Light); Pony removed; SDXL-Lightning/Turbo superseded (installs keep working); Qwen-Image kept as non-commercial. On Snapdragon/Adreno Android, sd.cpp models are listed with "About N min per image" but never picks — Local Dream is the pick. One measured memory rule (1.3× pack) decides both recommendation and guard.
- Speech: sherpa-onnx v2.0.1 pinned/staged (Parakeet works), Qwen3-ASR on desktop (1.7B) and phones (0.6B), Whisper fallback with a toast; Piper removed.
- Device roster: one authority, `shared/packages/sync/src/control-center.ts`; with no licence answer, paired devices are listed (marked unverified). Desktop `listManagedDevices` returns `allDevices`.
- Fastest settings: published benchmarks only, never local measuring; one rule per setting across platforms.
- Brand on every visible label: "Off Grid AI". No uncensored/explicit models.

## Gotchas that cost hours today
- Push hooks test the WORKING TREE. Any uncommitted or half-done file from any worker blocks every push. Before a push: `git status -s` clean of others' WIP (commit or `git stash push -- <own paths>`).
- shared's hook also runs desktop and mobile suites; mobile and pro hooks now run Jest with `--maxWorkers=1 --workerIdleMemoryLimit=1GB` (runInBand ran out of heap). Keep the machine quiet during pushes (no parallel full test runs); timing tests flake under load — rerun alone to confirm, then retry.
- Desktop tests that open SQLite: run under Electron's Node (`ELECTRON_RUN_AS_NODE=1 $(node -p 'require("electron")') ./node_modules/vitest/vitest.mjs run ...`); never `npm run test:db` while the dev app runs (it rebuilds the native module).
- Phones run JS from Metro (:8081 in mobile). Any edit to a mobile `src/` file reloads both phones and kills long renders — freeze mobile src edits during device runs. Android needs `adb reverse tcp:8081 tcp:8081` after a reconnect; iPhone dev app is launched with `-RCT_jsLocation 10.231.136.193:8081`. A white Android screen after reconnect is usually a slow first boot (it repairs ~6.6k chat records).
- Never type real keys or passwords; Ali pairs devices and enters licence keys. Licence re-activation can evict a seat — sequence devices.
- Engine-archive CI (`build-native-engines`) can push pin commits to this branch: pull before pushing.

## How to work
- Code first, check once at the end (typecheck + lint, touched tests only, in the background). Non-mockist integration tests: real screens, real gestures, fakes only at device boundaries. Every fix gets a test that fails without it.
- Small commits in the log's voice (plain sentences of what is now true), named files only, no attribution lines.
- Report to Ali in short bullets only: what's done, what's blocked and why, the one decision you need.
