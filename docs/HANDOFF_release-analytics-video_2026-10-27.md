# Handoff: release/analytics-video (2026-10-27)

> **If you are picking this up.** Read this file first, then `git log --oneline origin/main..HEAD`
> in each repo. Repos: `/Users/user/wednesday/off-grid-ai/{desktop,shared,mobile}`;
> `desktop/pro` and `mobile/pro` are submodules (`desktop-pro`, `mobile-pro`), each its own git
> repo on the same branch name. Standing rules are in `desktop/CLAUDE.md`, `AGENTS.md` and
> `.codex/ENGINEERING_CONTRACT.md`; the working rules are the `oga-cpto` skill.
>
> **The one task that blocks the release** is the `./pro` coverage floor (see "What is left").
> Everything else here is either done or waiting on a device/licence.
>
> **Do not push.** All work is local and unpushed by design.

Branch `release/analytics-video`, same name in `desktop`, `desktop-pro`, `shared`, `mobile`, `mobile-pro`.
Session took over mid-release from another account. **Nothing is pushed.** All commits are local.

## State now

| Repo | PR | CI | Blocker |
|---|---|---|---|
| OGAD (desktop) | [#215](https://github.com/off-grid-ai/OGAD/pull/215) | green | none |
| shared | [#68](https://github.com/off-grid-ai/shared/pull/68) | green, mergeable | none |
| desktop-pro | [#125](https://github.com/off-grid-ai/desktop-pro/pull/125) | mergeable, no CI | Actions spending-limit block, not code |
| OGAM (mobile) | [#739](https://github.com/off-grid-ai/OGAM/pull/739) | **red** | `./pro` coverage floor only |

Merge order is **shared → desktop-pro → OGAD**, on Ali's word.

Mobile CI runs 840 suites, 8538 tests, **zero failures**. It exits 1 solely on the `./pro`
coverage group: branches 68.19% against a 75% floor, functions 74.77% against 75%. Cause is
~10 `pro` submodule bumps for video that brought untested code. Main was green at the same floor
before them. The rule here is add tests, never lower the floor.

## What this release is for

Not "video plus analytics". Three streams that all key off the phone↔computer mesh:

- **Video (#164)** — video promoted to the 8th modality, treated like text and image everywhere:
  same catalog format, same Fast/Balanced/Best picks, same fastest-settings, same analytics events,
  same sync transfers. Plus Studio, stories, characters, c2patool AI labelling.
- **One retrieval engine (#201)** — memory, search, meetings and to-dos stop keeping separate
  vector stores. LanceDB and the old `memories` vectors retired. GPU faults stop being lied about.
- **Opt-in analytics (#213)** — reads as a privacy audit. Half the commits are scrubbing (file
  names, home folder, account name, document extensions, throttled counters) and correcting copy
  that had been overclaiming.
- **`POST /v1/search`** — newest thread: the phone searches the paired computer, Pro-gated.

Every device does what it can locally. The mesh is a fallback and an amplifier, not the brain —
see the commit "Video in a chat with no video model: use a paired computer that makes videos, else
offer Find my computer".

## Commits made in this session

**mobile**
- `9de12b317` Search a paired computer from the phone's chat search
- `0a3fac569` The chat list hands paired-computer search to its own component
- `364369cf2` Android builds 64-bit only
- `26689db87` Bump pro: Pro tools and Sync name the same computers
- `c1bf8ca89` PR screenshots: one row per computer, the same on Pro tools and Sync

**mobile-pro**
- `64f6a555` Pro tools reads the shared device roster, as Sync does

**desktop**
- `9cd104ea6` Collapse the two macOS stable-diffusion build scripts into one

## Ghost desktop rows — fixed

**Symptom.** Pro tools → Desktop tools listed one Mac three times: two rows reading "Off Grid AI
Desktop" and one "OGAD: Mac (Debug)", each with its own switch, only one able to connect.

**Evidence, from the user's own iPhone** (`Documents/offgrid-debug.log`):

```
pairings=3 ids=390c4cb0,26a04bd1,1c07d6e3 withSecret=3
registry=5 ids=1c07d6e3,02c6cc42,9d25c24e,49b88421,a64e0d73
reconnect to Off Grid AI Desktop (390c4cb0…) at 192.168.1.34:37878 failed
reconnect to Off Grid AI Desktop (26a04bd1…) at 192.168.1.34:37879 failed
```

Same Mac, same IP, consecutive ports, three sync identities. A desktop's identity is a random
per-install fingerprint persisted under `userData` (`desktop/pro/main/licensing/device-fingerprint.ts`),
so a reinstall or a second channel mints a new one and leaves the old credential on the phone.

**Root cause.** `CompanionToolsSection` built its own device list from raw `knownDevices`, which is
the saved pairing credentials. The Sync screen was always correct because it reads the shared
projection.

**Fix — one line** in `mobile-pro/ui/CompanionToolsSection.tsx`:

```
- const knownDevices = useSyncStore(state => state.knownDevices);
+ const allDevices = useSyncStore(state => selectSyncControlCenter(state).allDevices);
```

`shared/packages/sync/src/control-center.ts:82` already declares the registry the "Sole device-roster
authority", and exposes `allDevices` for "which devices exist". The same file warns: *"a list
assembled per surface is a list each surface can assemble differently"*. That was the bug.

**A wrong turn, recorded so nobody repeats it.** I first built a second rule —
`registryBackedPairings.ts` plus a prune in `entitlementReconciliationLifecycle` and a filter in
`savedRoster`. It worked and verified green on device, but it duplicated a decision shared already
owned. Ali called it (SSOT/SRP/DRY). All of it is deleted and the detour is gone from the unpushed
history. The cheap check I skipped: read the surface that already worked before writing a new rule.

**Decided:** a computer off the licence simply disappears from the list. No "lost its seat" row.

**Verified live** on Mac's iPhone, against the shipped implementation, machine-checked on the
accessibility tree:

```
Desktop tools ROW COUNT: 1
  row id: companion-tools-1c07d6e3391ec9fbad52bbb422532299   name: OGAD: Mac (Debug)
  390c4cb0 present: False     26a04bd1 present: False
sync-paired rows: 1 → 1c07d6e3391ec9fbad52bbb422532299
```

Both surfaces name the same computer, and both derive from `selectSyncControlCenter`
(`SyncScreen/index.tsx:152`), so it is shared authority rather than two lists that happen to agree.
Screenshots: `mobile/docs/pr-screenshots/release-analytics-video/ios/ghost-rows/`.

Note: Sync also shows "OnePlus Nord 5" under AVAILABLE. That is discovered-but-unpaired, carries a
Pair button, not a `sync-paired-` row. Not a divergence.

## Android 64-bit only

`android/gradle.properties` listed four ABIs — the React Native template default, never a choice.
Now `arm64-v8a,x86_64`.

Every Android build was failing on `:app:buildCMakeDebug[armeabi-v7a]`: the vendored Vulkan backend
streams a `vk::Buffer` to an ostream, which is a pointer on 64-bit but a `uint64_t` with no
`operator<<` on 32-bit. Upstream code, pristine (`leejet/stable-diffusion.cpp @ 3f8527a4`,
`leejet/ggml @ 89c4413f`).

**This does not drop ggml-vulkan.** Vulkan compiles and runs on `arm64-v8a` — measured, object on
disk. Only the 32-bit variant failed. Play has required 64-bit since 2019, and a 32-bit process has
~3 GB of usable address space, so it could never load the models this app is for.

Pipeline checked before changing it: `uat.sh:192` ships an **AAB** (Play splits per device);
`uat.sh:195` builds one **universal APK** for GitHub, which only gets smaller; `Fastfile:144` uses
`gradle(task: "bundle")`; `build.gradle` has no `splits`, no `abiFilters`, and a flat
`versionCode`. Nothing reads a per-ABI artifact.

Full error record: scratchpad `armeabi-v7a-ggml-vulkan-failure.md`.

## Desktop follow-ups from #215 — all three done

1. **build-native-engines** triggered: [run 40482040996](https://github.com/off-grid-ai/OGAD/actions/runs/40482040996).
   ⚠️ Its `publish` job commits archive pins and **pushes to `release/analytics-video`**. Pull before pushing.
2. **Two macOS sd scripts collapsed.** Both built the same revision (`sd.ref`/`sd.commit` agree).
   `build-sd-mac.sh` deleted; `build-sd-macos.sh` survives as the union on the stricter release
   behaviour. `release.yml:149` updated; `build-native-engines.yml` already used that name.
3. **#215 body refreshed** — the "Supersedes (kept open)" table listed 8 PRs that are all CLOSED.

## What is left

- **`./pro` coverage.** Branches 68.19 → 75, functions 74.77 → 75. Seven modules carry most of it
  and have no direct tests: `gossipedRouteReconnect` (17.5%), `toolGrantResolve` (23%),
  `toolGrant`, `announcedMeshRoute` (47%), `embeddingModelTransferAdapter` (34%),
  `imageModelReceiveAdapter`, `imageModelTransferAdapter`. `mcpToolGrantService` has 2 tests and
  sits at 32%. Four are mesh modules, so the `licensedMesh` harness reaches them cheaply.
- **Android live verification.** Blocked: that phone's pairing was **remotely revoked** at
  09:17:38Z and its Pro credential cleared, so it has `pairings=0`. Needs its licence seat back.
  Not caused by the fix — the revocation ran under the pre-fix binary and was `direction:"remote"`.
- **`companionToolsSection.test.tsx` still mocks our own store.** Ali has asked for the mock to go.
- **`ChatsListScreen` lint warning**: 360 lines against a 350 max. It was 346 before this feature,
  so any feature tips it. Clearing it means cutting pre-existing code.
- **Screenshots are not light mode** (rule 14). Taken as the phone was configured.

## Gotchas worth keeping

- **Licence seats churn.** Adding a device to a full licence evicts the longest-away seat. The
  registry went 5 → 4 → 3 → 2 in six seconds at 09:17 and took the Android phone off. Expect this
  when pairing during a test run.
- **Hermes / retired worktrees.** iOS builds failed on
  `mobile-release/node_modules/hermes-compiler/…: No such file or directory`. `pod install` did not
  fix it: CocoaPods had the absolute path **cached** in
  `~/Library/Caches/CocoaPods/Pods/Specs/External/hermes-engine/*.podspec.json`. Delete that entry
  and `ios/Pods/Local Podspecs/hermes-engine.podspec.json`, then reinstall. The cache outlives the
  worktree, so this will bite any machine that had one.
- **`pod install` needs `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`** or it dies on a CocoaPods
  `ASCII-8BIT` error. Unrelated to this project.
- **`scripts/ios-device.sh` matches `hardwareProperties.udid`**, not the CoreDevice identifier. For
  Mac's iPhone pass `00008150-000225103CD8C01C`, not `4CF4A291-…`, or it falsely reports
  "tunnel will not come up".
- **Device builds bundle JS at build time** (`FORCE_BUNDLING=1`). Metro does not serve them, so a
  JS edit needs a rebuild.
- **WebDriverAgent**: never pass `bundleId` in session capabilities — it relaunches the app and
  kills the runner. Launch separately with `devicectl … --terminate-existing`, attach with bare
  capabilities. Use `POST /wda/tap` with coordinates; `/element/{id}/click` returns 400.
  `idevicescreenshot` is useless on iOS 17+; `GET /session/{sid}/screenshot` works. Poll for
  `Off Grid AI PRO` before tapping — the Pro section mounts after licence validation.
- **Settings path to Pro tools**: Settings → "Off Grid AI PRO" → `pro-included-McpServers`. There is
  no "Pro tools" row.
- **Other sessions are live in these repos.** `git status` showed test files this session never
  touched. Stage only named files; never `git add -u`/`-A`.
