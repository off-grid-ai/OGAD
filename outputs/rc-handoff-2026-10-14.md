# Release-candidate handoff — Off Grid UI integration (2026-10-14)

Everything below is committed and pushed. Read this first, then `/Users/user/wednesday/off-grid-ai/.codex/ENGINEERING_CONTRACT.md`.

## 1. Where everything is

| Repo | Branch | Head (pushed) |
|---|---|---|
| desktop (OGAD) | `fix/remote-inference-engine-updates` | `4aba9518b` |
| desktop/pro (submodule) | `fix/remote-inference-engine-updates` | `7ed8c25` (OGAD points at it) |
| browser-extension | `fix/remote-inference-engine-updates` | `cc8a5b7` |
| mobile (local checkout) | `main` | `47be49381` (RC mobile work is on `fix/remote-inference-engine-updates` 41313a4, done by the library session) |
| shared (local checkout) | `main` | `5b3d19d` (no shared branch needed; CI falls back to shared main) |

- **UI library:** `@offgrid/operator-ui` = `wednesday-solutions/component-library-animations`, branch `feat/desktop-component-coverage-y9o10z`. Both apps pin **`0ad3265cde228123ab85e037111034795ea8b536`**.
- **User rulings:** one branch name everywhere (`fix/remote-inference-engine-updates`); no worktrees; sub-agents are allowed.

## 2. What this release is

The UI transformation is the release (user ruling). OGAD core, Pro and the extension side panel now render with the library:
- **Look and motion:** skin, alive motion layer and LivingField background; ScreenTransition between screens; NavHighlight in the sidebar.
- **Page structure:** PageHeader, Section, ListRow and DateStepper.
- **Chapter components:** queue, attachments, prompt input, message, file preview, tool timeline (checkpoint rail), voice capture, collections, TableVirtuoso, AI artifact, animate switch/sheet/dialog, dice editable/key-value/tags/sortable, and the Pro presentations.
- **Standing UI rules from the user:** icons over labelled buttons, thin rows / good use of space, alive in orchestrated harmony. These are in `docs/DESIGN_PHILOSOPHY.md` (+ brand repo) and in memory.
- **Recent user-requested Pro changes by the "Webview container layout issue" session** (all committed and pushed):
  - Actions and Entities as full-width tables, with find and sort on Actions.
  - Collapsible God columns.
  - Compact settings.
  - The Web Use pane fix.
  - Replay captions per day, plus a new index `idx_obs_frames_frame` (`CREATE INDEX IF NOT EXISTS`, downgrade-safe).

## 3. Baselines and compatibility

- **Release baselines:**
  - Desktop: newest is **v0.0.55-beta.122** (13 Oct); the older supported release is v0.0.54 stable.
  - Mobile: newest is **v0.0.114-beta.1** (13 Oct); v0.0.111 stable.
  - Extension: never published.
- **Compatibility audit** (the library session, read-only):
  - Gateway routes, SSE, error envelopes, IPC/preload, update channels, DB migrations, extension bridge (BRIDGE_VERSION 1) and sync/pairing wire: all clean.
- **Persistence changes in this RC** (all additive):
  - Queued chat turns save an optional `id`.
  - New plain setting `gatewayApiKeysRequired`.
  - New DB index (above).
  - Downloaded-model kind is now derived on read and never written back.

## 4. User rulings applied (desktop)

1. **Phones losing tools:** fixed. Installed-but-not-loaded chat entries have no `capabilities` key; the loaded model carries llama-server's live tools/vision/reasoning; Decision specialists carry none.
2. **Gateway model switching:** a gateway request naming an installed model switching the saved model is intended, now for chat, image, speech and transcription. It keeps `setRemoteModelSelected`. `/v1/models` lists the active model first with `active: true` and `context_length`.
3. **API keys:** keep auto-enable on first key. The settings copy says phones need the next mobile release; mobile 41313a4 now sends keys over private LAN / Tailscale HTTP.
4. **Specialists:** no desktop change (mobile drops them via its catalog path).
5. **GPU memory:** warning added in Image settings ("Chat and image models stay loaded together on CUDA and share GPU memory…").
6. **Private library in CI:** fine.
   - OGAD CI and release fail fast if `OPERATOR_UI_TOKEN`/`CI_CROSS_REPO_TOKEN` can't read the library.
   - Extension CI now configures the same token before every `npm ci`.
   - **The extension repo needs an `OPERATOR_UI_TOKEN` (or `CI_CROSS_REPO_TOKEN`) secret added. Only the user can do that.**
7. **Extension version:** stays 0.0.1 for now.
8. **Other items:**
   - Locked keychain: served open when keys were never required; 503 "API key storage is locked." when they are.
   - Engine index 404 reads as up to date.
   - Lockfile verified against shared main.
   - Accepted as-is: engine auto-download, no engine rollback, gateway chat queueing.

## 5. Test status (be precise: re-verify, don't trust)

**Measured before the fixes:**
- **desktop `npm test`** (with SQLite built for Node, as CI does): 197 failed / 7220 passed in 73 files. All failures were renderer/Pro UI tests from role and markup changes; main-process tests were clean.
- **DB suite:** 14 failed / 614 passed (9 files, mostly `*.ui.integration.dbtest.tsx` plus `update-check`, which needs the live update feed and is excluded in CI's config).
- **Heavy:** 29 passed; `model-server-chat` hit EADDRINUSE on :8439 (the user's dev app holds that port).

**Fixed and committed since then:**
- **Settings/models group (29 files):** done and verified, 26 pass. The other 3 were load timeouts that pass alone; `integration-tests/manual-model-setup.test.ts` needs SQLite built for Node.
  - **Real regressions fixed:** side panel backdrop click-to-close, image number field clamping, Escape on an open select closing Settings.
  - **Test setup gained:** `motion.create`, `getAnimations`.
  - `SettingsPanel.speech-language`'s obsolete Processing-section lines were rewritten to the new structure.
- **Gateway and compatibility fixes:** done and verified. Their files: `model-switch-ownership` (5/5, three runs), `model-server-api-keys`, `models-list` (21/21), `engine-updates` (7/7), `decision-model-request` (10/10), `hf-image-download-kind`, `downloaded-models`, `ImageSettingsTab.cuda-memory`.
- **Extension:**
  - typecheck, lint, format, Firefox build: pass.
  - unit: 2375/2375 after fixing `ComposerAuthority` and `VaultTransfer` tests (at pin ba9a35c).
  - **Not yet re-run on 0ad3265, and e2e not run.**
- **Mobile:**
  - On the video branch: 8352 JS tests passed; the one failure was a video-branch import cycle (`VIDEO_SETTING_KEYS`), not RC. Android passed, iOS 63/63.
  - The checkout was then switched to `main`, and a full mobile run on main was started; its result wasn't read before handoff. Re-run it.
  - The library session reports mobile RC branch jest green apart from 4 release-script tests that fail only on Linux (BSD `sed -i ''`, `mktemp`).
- **Shared:** typecheck, lint and contracts pass; all workspaces pass (`@offgrid/use` 100/100 under Node 26, the ABI its native module is built for).

**Not finished (agents were stopped mid-pass and their partial work is committed): re-run these first.**
- **Chat/shell group:**
  - `src/renderer/src/components/__tests__/MemoryChat.{chat-lifecycle,voice-turn-modes,image,timeline,render-boundaries,tool-calls,theme,response-limit,clipboard-overlay,queued-actions,generation-details}`
  - `CommandPalette.integration`, `desktop-polish.integration`, `ChatToolRows.test`, `actions/__tests__/ActionGateDock.test`
  - `src/renderer/src/__tests__/App.{shell-navigation,navigation,locked-pro-tabs,license-expiry}`
- **Pro group:**
  - `ComputerUseSettingsSection`, `DevicesScreen.devices`, `VaultScreen.kdbx`, `VaultScreen`, `VaultEntryDetail`, `GodTwinScreen`, `GodCharacterSettings`
  - `ComputerUseSupervisor`, `DayReplay`, `TaskRunDetails.live-activity`, `TaskExecutionPlanView`, `TaskWorkspaceLayout.compact`, `WatchedBrowserPane`
  - `SearchScreen`, `MeetingsScreen`, `LargeCollections`, `EntitiesScreen`, `EntityNavigation`, `ActionsTarget`
  - `RemoteChatPreviews`, `GoogleQuickConnection`, `VoiceScreen`, `ClipboardScreen`, `AmbientSharingControls`, `CaptureSection`
  - Note: Actions/Entities changed again during the pass (tables, find/sort), so their tests need checking against the current code.
- **DB UI tests:** `conversation-rename`, `gateway-api-keys.ui`, `mcp-connector-setup`, `memory-chat-tts.ui`, `remote-settings.ui`, `resource-mode.ui`, `workspace-production-bridge.ui`, `action-lifecycle-renderer`.
- **Then the full runs:**
  - desktop: `npm test`, `test:db`, `test:heavy` (with :8439 free), `test:e2e` (user asked for all tests).
  - extension: unit + e2e on the current pin.
  - desktop build + `typecheck:node/web` + `pro tsc` (all clean at handoff).

**Fix rules (the user's, binding):**
- Classify every failure: (a) intended UI change, so update the query/interaction and keep the same assertion; (b) real regression, so fix the product; (c) environment, only with proof.
- Never skip, delete or weaken a valid test. Remove a test only when evidence proves it obsolete.
- No mocks or spies of our own code; contract-faithful fakes only at uncontrollable boundaries.
- Repeat the affected tests after fixes.

## 6. Remaining release blockers / to-do (in order)

1. Finish the unfinished test groups above and get desktop `npm test`, `test:db` and `test:heavy` green.
2. Run desktop e2e and extension e2e on the current pins; fix.
3. Re-run extension unit tests on pin 0ad3265.
4. Add the `OPERATOR_UI_TOKEN` secret to the extension repo (user action) so its CI can install the library.
5. Read the mobile `main` / RC-branch full results. Mobile's 4 Linux-only release-script tests matter if mobile CI is Linux.
6. Lint: `src/renderer/src/components/MemoryChat/components/MessageMetadata.tsx:58` has an unnecessary optional chain (mine; trivial). `pro/renderer/lib/browser-region.ts:180` has a setState-in-effect lint error (the other session's). `.demo-capture/` lint errors are a git-ignored local folder, so ignore them.
7. **Contract note for the user:** the sweeps added small app-level helpers (`src/renderer/src/components/IconTip.tsx` with `GlyphSwap`, `pro/renderer/components/IconAction.tsx`). The library now ships `operator/icon-action` (`IconAction`, `GlyphSwap`). Swapping to the library versions would remove the app abstractions. Not done (RC scope); the user's call.
8. Report to the user: baselines (section 3), test results with numbers, and remaining blockers.

## 7. How to run tests correctly (gotchas that cost hours)

- **Node:** desktop and extension use Node 22: `PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The default `node` is 26.
- **SQLite ABI:** desktop's `better-sqlite3-multiple-ciphers` is built for Electron (ABI 140). Vitest runs plain Node, so do what CI does:
  - `npm explore better-sqlite3-multiple-ciphers -- npm run build-release`
  - then run the tests;
  - ALWAYS restore after with `npx electron-rebuild -f -w better-sqlite3-multiple-ciphers` (use a shell trap), or the user's dev app breaks.
  - `scripts/test-db.sh` does the swap for the DB suite.
  - Concurrent swappers must serialise (a mkdir lock was used: `.../scratchpad/rc/sqlite-abi.lock`).
- **Port 8439:** the user's running app holds it, and heavy `model-server-chat` needs it free.
- **Library pin bumps:** `npm install` builds the library from git (its `prepare` runs tsc + tailwind), so it needs about 2 GB of free disk. The disk was full once (ENOSPC).
  - After an install, the app's postinstall rebuilds SQLite for Electron again.
  - During an install, imports from `@offgrid/operator-ui` fail for a minute or two. Don't trust test results from that window.
- **Mobile:**
  - `npm ci`, then `cd ios && LANG=en_US.UTF-8 bundle exec pod install`.
  - The bundled CocoaPods (1.15.2) rewrites `Podfile.lock`'s `COCOAPODS:` line: restore it with `git checkout -- ios/Podfile.lock`, then `cp ios/Podfile.lock ios/Pods/Manifest.lock`, or Xcode reports the sandbox out of sync.
- **Never** `pkill -f vitest`: other sessions run vitest too.
- **Staging:** stage named files only (other sessions share these working trees). Push with `--no-verify` (user's standing instruction).

## 8. Coordination

- **"OGAD library component polish"** (cloud Claude session) owns the library.
  - **Reaching it:** `SendMessage` to `OGAD library component polish [6dbe1f]` is one-way; it replies via cross-session messages.
  - **What it does:** announces new pins (bump both apps: verify the commit is on the library branch and descends from the current pin, sed the sha in both `package.json`, `npm install`, typecheck, commit package files) and runs the compatibility audit. The pin history is in git log.
- **"Webview container layout issue"** (local session on this machine) does user-requested UI tweaks in the same trees. **It is PAUSED until told the RC pass is done** (tell it when you're finished or take over coordination). Its next planned item is the composer "+" on the same row as voice capture.
- **Memory** (`~/.claude/projects/-Users-user-wednesday-off-grid-ai-desktop/memory/`):
  - `ui-alive-orchestrated-harmony`
  - `icons-over-labelled-buttons`
  - `compact-space-utilization`
  - `operator-ui-integration`
  - `release-candidate-cpto-mode`
  - `stage-named-files-only`

## 9. Useful paths

- Library clone (read-only reference): `/private/tmp/claude-501/-Users-user-wednesday-off-grid-ai-desktop/82f82337-dd71-4309-9dd0-ca9e85d20969/scratchpad/cla`.
  - Preview chapters: `src/desktop-preview/*.tsx`.
  - Swap plans: `docs/OGAD_CHAPTER_SWAPS.md`, `docs/OGAD_REMAINING_SURFACES.md`.
- Last full-run logs: `/private/tmp/claude-501/-Users-user-wednesday-off-grid-ai-desktop/82f82337-dd71-4309-9dd0-ca9e85d20969/scratchpad/rc/` (`desk-test.log`, `desk-db.log`, `desk-heavy.log`, `ext-*.log`, `mobile-*.log`, `m2-*.log`, `desk-fail-files.txt`, `fix-brief.txt`).
