# Release audit, 2026-10-12: all findings

One list from the three audits: this session (the only one that changes code), the OGAD/desktop-pro/shared delta session and the OGAM delta session. Fixes go on `feat/browser-thin-client` in each checkout, one PR per repo.

How each finding is known:
- **Confirmed**: this session reproduced it or traced it in code and data.
- **Test proves it**: a failing or passing test shows it.
- **From code**: the auditor read the code; nothing ran.
- **Unverified**: reported by an auditor and not yet checked.

## Desktop (OGAD + Pro)

| # | Finding | How known | Proposed fix | Needs your decision |
|---|---|---|---|---|
| D1 | `extension-conversation-search.dbtest.ts` expects listed chats to have no `turnCount`; #186 added one, so main's DB job will fail | Fixed, merged in OGAD #187 | Assert the count | |
| D2 | Fastest settings overwrite the backend, residency and Computer Use screenshot size for existing users who never edited chat settings (`best-settings.ts` ~L169, `llm.hasPersistedSettings`) | Test proves it (`best-settings-existing-install.integration.dbtest.ts`, untracked, written by the delta session) | Fixed, merged in OGAD #187: a chat model on disk marks an existing install | |
| D3 | Model scan: the old models folder, kept as a scan folder, is scanned without its own `downloaded-models.json`. Package companions (the Wan `umt5` encoder) and `decision-eval/*.gguf` show as chat models, and UI-Mate shows the raw `model-package-v1:` id | Confirmed against your profile | Each folder uses its own records when scanned | Yes: changes how metadata is read |
| D4 | "Kev 4B (not downloaded)" in the Decision picker | Not traced | | |
| D5 | Network pairing: the dialog says "on this computer", shows no peer IP and has no rate limit; 100.64/10 admits any carrier-grade NAT address | From code | Show the IP, rate-limit requests, narrow the address check; consider off by default | Default on or off |
| D6 | A paired browser can `list` and `get` every vault item, now including cards, CVV and TOTP (#98 widened this) | Confirmed | Bind `get` to an origin or kind, or confirm on Desktop | Yes |
| D7 | Plain browser chat's "read-only" tools include `read_url` and `web_search` (`tool-origin.ts:12-14`), so injected page text can read Gmail and then send it out through a URL | Confirmed in code | No outbound fetch in plain chat when connector or memory reads are offered | |
| D8 | A paired browser can rewrite Desktop's system prompt (`bridge-settings.ts:292`), which persists into Desktop chats that have acting tools | Confirmed in code | Make it read-only over the bridge, or confirm on Desktop | |
| D9 | The gateway binds `0.0.0.0` with `ACAO *` and Private-Network allowed; `/v1/models/pull` has no auth (already in the released build) | Confirmed in code | Allow only loopback or paired callers for the mutating endpoints | |
| D10 | `docs/research/assets/microsoft-registration-*.png` in the public repo show the admin account plus the tenant, object and client IDs | Confirmed (viewed) | Remove the images, and purge them from history if needed | |
| D11 | Microsoft says consent for a new multi-tenant app needs a verified publisher (shown in the same screenshot); Google restricted scopes need verification | Confirmed (screenshot); account status unknown | Resolved: you confirmed both apps are verified and in production | Done |
| D12 | Engine bump to llama b11532 and prism, against the "no runtime updates" rule; Windows and Linux are unverified | From code | Keep or revert | Yes |
| D13 | Core imports the private `@offgrid/operator-ui` in 7 renderer files, so a public clone can't build | From code | Fallback or move it to Pro | |
| D14 | Downgrade after a model Move: older builds show no models, since the metadata JSONs are deleted from the old folder | From code | Keep the small metadata JSONs, or document it | |
| D15 | The old Kev checkpoint is deleted after Kev 1.0 downloads (`models-manager.ts:986`) | From code | Keep it until the next stable | |
| D16 | Vault items in folders are invisible to older builds: folders are KDBX subgroups (`vault-fields.ts:256-263`), and released `eb75a37` lists and finds entries only in the default group. That includes LastPass-imported folders | Confirmed in code (delta session) | Keep foldered items readable by older builds, or document that rollback isn't supported | |
| D16b | Downgrade privacy: the new note kind is stored with Type 'note', but `eb75a37` hides the body only for 'secure-note', so an older build's list view shows the full text of notes saved by the new build | Confirmed in code (delta session) | Keep the stored type 'secure-note' | |
| D17 | "Gemma Loading model…" | Probably real loading (engine started 1:20) | Check once | |
| D18 | An artifact-only "Build and Release" run, 38221847879, is holding the `release` concurrency group | From the repo | Cancelled by you, 2026-10-12 | Done |
| D19 | "Move" loses the active chat model when its file is a symlink or hard link (as when sharing with LM Studio or Ollama). `model-storage-move.ts:58-68` skips linked files, but `active-model.json` is still copied, and reads switch to the destination only. Chat then finds no model | Test proves it (`model-storage-move-linked-active-model.test.ts`, untracked, written by the delta session) | Refuse or warn when a linked file is involved and offer Leave; or recreate the links; or keep the source as a scan folder | Pick a fix |
| D20 | A silently hung engine now blocks for 10 minutes before the next engine is tried (`startup-timeout.ts`, `c4a6272d6` today; it was 60s, and 180s for CUDA). Two hung engines mean 20+ minutes on "Loading model…" | Confirmed in code | Keep 10 minutes only while there's evidence of loading (slow or removable volume, growing RSS); show elapsed time and "Try another engine" | |
| D21 | Pro model transfers land in the old folder after a Move until restart (`pro/main/sync-ipc.ts:1001-1004` captures `modelsDir` once at startup) | From code | Fixed, merged in desktop-pro #99 (getter) | |
| D22 | A pre-catalog Kev base (9.34 GB) is downloaded again after a Move (`models-manager.ts:413-416` looks relative to `modelsDir`) | From code | Fixed, merged in OGAD #187 (the profile location is checked too; the new test fails without the fix) | |
| D23 | Voice turn mode now defaults to 'silence' for users who never saved a choice (it was 'tap') | From code | Release note, or keep 'tap' for existing installs | Intended? |
| D24 | Compaction estimates tokens as characters ÷ 4 (`tools.ts:911,1316`, `conversation-compaction.ts:77-109`). Japanese measures 1.74 characters per token on Gemma, so CJK chats overflow before compaction runs. Hindi on Gemma measures 4.19 (fine); Qwen not measured | Measured with the engine's `/tokenize` | Count with `/tokenize`, or use a ratio per script | |
| D26 | Page text could end the untrusted `<page>` fence early: '<' was escaped only for a page tag with its '>', so an unfinished `</page` or one cut by the length cap passed | Test proves it (`page-fence-boundary.test.ts`, delta session) | Fixed on feat/browser-thin-client: escape every '<' that starts a page tag | |
| D27 | (test: `browser-agent-page-injection.dbtest.ts`, red by design, proves (a)) A paired browser can send email or iMessage, or create and delete items, with no confirmation on Desktop. (b) `tools.run` (`bridge-electron.ts:454-466`, `acting: true`) runs `mail_send` directly, and `bridge-service.test.ts:409` asserts it. The extension never calls `tools.run`, so this only serves a paired peer, LAN included. (a) In Agent mode, injected page text can ask the model to send. #182 chose no extra confirmation | Confirmed in code and test | (b) FIXED on feat/browser-thin-client (`91a5bf9fe`): `tools.list` and `tools.run` are read-only. (a) Approval gate for bridge-originated send, create and delete, at least when page text is in the prompt | (a) yes: reverses #182's choice |
| D25 | `docs/OFF_GRID_WORK_LOG_AUDIT_2026-10-06.md` rows 3, 15, 16, 17 and 19 still say "not yet merged"; they merged on 2026-10-10 (OGAM #701, mobile-pro #86), and the row 17 follow-up was fixed in `1e99a2ad1` | Confirmed | Fixed, merged in OGAD #187 | |

Verified passing (delta session): the Mac engines match the pinned refs (llama `6184e92` is identical to b11532; prism `2459f68`). All 13 Windows and Linux engine archive SHA-256s match the upstream release digests. The new catalog downloads (the Qwen and Gemma MTP companions and the Kev 1.0 adapter) match their pinned size and SHA. `verify:catalog` passes: 28 chat models, no projector drift. So D12 narrows to the engines never having been run on Windows or Linux.

## Browser extension

| # | Finding | How known | Proposed fix |
|---|---|---|---|
| E1 | The menu's "Summarize this page" is sent twice: `usePendingPrompt` reads the stored prompt, waits, then removes it. Two starts lead to "already running", and every Retry then says "changed in Desktop" | Fixed, merged in browser-extension #12: a submit runs one at a time, starters disabled while sending (repeat clicks on a starter did the same) | |
| E2 | Retry on a turn whose start was refused says "This chat changed in Desktop" | Moot with E1 fixed (only a refused duplicate reached it) | |
| E3 | The e2e stub differs from real Desktop: it returns TOTP from `reveal`, sends full transcripts and only supports Stop | Confirmed | Contract test against the real handlers |
| E4 | Firefox never run at runtime; the build passes | Confirmed | Needs Firefox installed |
| E5 | Raw error codes in the Models and voice screens; `tool_unavailable` has no copy | Confirmed | Map them in the copy table |

## Shared

| # | Finding | How known | Proposed fix |
|---|---|---|---|
| S1 | `packages/models` has no CI; #47 was tested only locally (43/43 pass) | Confirmed | Add it to shared CI |
| S2 | Local `../shared/packages/sync/dist` was built Sep 15, so local Desktop tests run old sync code | From the repo | Rebuild before local runs |

## Mobile (OGAM + mobile-pro)

| # | Finding | How known | Proposed fix |
|---|---|---|---|
| M1 | Don't promote `v0.0.112-beta.1`: it's 64 commits behind main, so no #701 fixes and no worklets packaging fix | Confirmed | Cut a new beta from main |
| M2 | `promote.sh:129` pushes the release commit to main and fails whenever main is ahead | Confirmed | Push the tag only; check that the beta is an ancestor of main |
| M3 | The shared SHA isn't pinned or recorded; CI checks out Pro and shared by branch name (`ci.yml:66,75,116,125`) | Confirmed | Pin both; record them in the tag |
| M4 | `uat.sh` doesn't check the branch or that HEAD equals origin/main | From code | Require it |
| M5 | Home, ProjectChats and ProjectDetail delete chats without image cleanup | From code (auditor confirmed) | Use `deleteChatImages` |
| M6 | Gallery delete silently fails for synced images in `shared_files/` | From code (auditor confirmed) | Allow and handle the shared paths |
| M7 | A LAN `http://` server with a saved key now always fails its check, and its models vanish from the picker | Test documents it as intended | Try without the key over private HTTP |
| M8 | Ollama native chat never sends the key; a Desktop address saved with `/v1` builds `/v1/v1/...` | From code | |
| M9 | The thinking preview mangles code (it reuses the speech cleanup) | Reproduced by the auditor | Use a separate plain-text formatter |
| M10 | Stop doesn't stop the Mac on any released Desktop | From code plus tests | Release Desktop with `f315a6ea1` |
| M11 | MCP: on upgrade the tool owner is picked by whichever server answers first; a brief gap in a tool list loses the user's choice; no test reloads the saved store | From code | |
| M12 | `markdown-it` 13 (ReDoS) on model output; `decode-uri-component` 0.2.2 | npm audit | Upgrade or override |
| M13 | Hosted release workflows dead since Feb; no curated release notes | From the repo | Repair or delete; write notes |
| M14 | Android mic "Don't ask again" is forgotten after a relaunch (`micPermission.ts:20` keeps it in memory), so the mic button looks usable until the first tap fails | Confirmed in code | Save the denial; clear it on Granted |
| M15 | `PRO_PAY_PAGE_URL` is `offgridmobileai.co/pay` and relies on a 301 to `getoffgridai.co/pay` | Confirmed (curl) | Point it at `https://getoffgridai.co/pay/` |
| M16 | Speak can show for a voice whose files are gone (Pro `39622b55` `canSpeak`) | From code | Check the files exist, or fail clearly with a re-download |
| M17 | No rendered test checks the prices on ProDetail, ProAha or ProUpsell | Gap in tests | Add one; pricing copy still needs your sign-off |
| M18 | Untested: the saved voice at start, Speak after unload, the gallery synced-copy repoint, LWW deletes kept, the dev gate on the demo seed, lazy payload readback | Gap in tests | Add tests |
| M19 | The voice-transcript test passes even if every transcript is dropped; hold-to-talk after a chat switch is untested | Gap in tests | Also assert it lands in the chat it was spoken in |
| M20 | The demo seed (~19 KB PDF) is bundled in release builds, though nothing can reach it | From code | `require()` inside the `__DEV__` branch |
| M21 | On Desktop 0.0.54, the next phone image after Stop waits behind the old job or fails with "already generating" (extends M10) | From code | Phone copy "Desktop is still finishing the last image", or ship Desktop `f315a6ea1` |
| M22 | Deleting a chat can hang up to about 60 seconds with no feedback (`remoteMediaRuntime.ts:41-55,150-166`) | From code | Remove from the UI at once and cancel in the background, or show "Stopping…" |
| M23 | Desktop's "not enough memory" override prompt is lost in the async path (`remoteMediaRuntime.ts:189` throws a plain message) | Confirmed in code | Send polled errors through the memory-limit parser |
| M24 | Blank Gallery tiles are back since revert `222ae4253` (no existence check, no `onError`) | From code | Placeholder with Remove, or hide records whose file is missing |
| M25 | Web search on a Brave challenge page (HTTP 200) says "No results found" (`tools/handlers.ts:69`) | From code | Detect challenge pages |
| M26 | Removing one paired Desktop turns off web_use and computer_use everywhere (`mcpStore.ts:142-151`) | From code | Drop them only when no route remains |
| M27 | Blank model names: a sideloaded "-Q4_K_M.gguf" (`importLocalModel.ts:72`); a Desktop name of ".gguf"; `storage.ts:138` repoId for ids without "/" | From code | Fall back to the filename or id |
| M28 | The helmet icon dropped its filled/outline on-off cue (`ChatInput/index.tsx:521`), which leaves colour alone for colour-blind users | From code | Restore a weight or fill change |
| M29 | Test gaps: LM Studio 401, Ollama key over HTTPS, server-list key check, failed key read, empty download, .webp delete; a failed partial-file delete is only logged | Gap in tests | OGAM session writing the tests (user approved) |
| M30 | `useImageModels.branches.test.ts:280` passes by accident, so `a0dc4baa0` is untested | Gap in tests | OGAM session fixing it |
| M31 | Untested: projector stays repairable, GGUF catalog name, Desktop names without a path, MCP "Waiting for you to sign in", offline device state | Gap in tests | OGAM session writing the tests |
| M32 | Device checks needed: the signed Android launch (worklets), screen reader, theme and tool colours, the thinking clamp, Stop against Desktop 0.0.54, phone 0.0.112 paired with Desktop 0.0.54, older OS versions | Needs a device | Manual |
| M33 (ignored for this release, per you) | The ambient recorder exists only on the unmerged `release/0.0.112-beta` branches (OGAM: main@0.0.111 plus the ambient merge, bumped to 0.0.114, 1,483 files differ; mobile-pro: 3 commits not on main, including the Mac-offload companion over Tailscale). It isn't in any release | From the repo | Decide: merge it properly through a PR to main, or park it |
| M34 (ignored for this release, per you) | OGAM `dev` is stale (808 commits not on main, last updated 2026-09-10), but the backmerge workflow still opens branches | From the repo | Decide: retire it or reconcile it |
| M35 (ignored for this release, per you) | Mobile has never been tested against shared #47, which rewrote `toolLimitFinalAnswerInstruction` (used at `generationToolLoop.ts:30-37`) | From code | Run the mobile suite against shared `8f5013c` before the next cut |
| M36 (ignored for this release, per you) | Whether TestFlight accepted beta.1 (build 1791224063) is unknown | Not checkable from the repo | You check in App Store Connect |
| M37 (ignored for this release, per you) | Stale local Android release APK and AAB (Oct 9) with beta.1's versionCode | From the repo | Don't upload; let the next `uat.sh` rebuild |

Mobile checks that passed (OGAM session): voice and mic 38/38, Pro audio 350/350, mobile sync 974 (1 skipped), shared sync 626/626, pricing and settings 25/25. The sync wire protocol is unchanged since Desktop 0.0.54, no old prices remain, dev features are gated behind `__DEV__`, and the support email is consistent.

## Not proven by anything automated (needs your go-ahead: e2e or live)
1. A real browser paired with a real Desktop (Brave here), after a Desktop restart and an extension rebuild.
2. The packaged macOS app (`OFFGRID_E2E_TARGET=packaged`), Windows, and Linux with the new engines.
3. Upgrading a copied 0.0.54 profile.
4. Real sign-in from accounts that aren't test users.
5. MTP with real models.

## Verified passing today
- Pro full suite: 3,376 tests in 302 files (Electron's Node).
- Shared models: 43/43.
- Extension main CI on #11: green, e2e included. Firefox build OK.
- OGAD CI on 49b613d49 (#185): fully green (delta session). OGAD on bd4dbe0bd: running.
- Delta session: 18 focused files (238 tests) and 5 DB files (57 tests) pass.
- OGAM session: MCP 124/124, image/delete 54/54, remote/UI 476/476; mobile CI on 3118e75 green.
