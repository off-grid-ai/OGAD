# 0.0.40 release — manual test priority list

Execute **top to bottom**. The order is `risk-if-it-fails` x `how-little-automation-backs-it`, so the
things that can ship broken with no safety net come first. Stop and hold the release if any **P0**
expected result is not met.

This is the release-night companion to the full step detail in
[`MANUAL_RELEASE_TESTS_0.0.40.md`](MANUAL_RELEASE_TESTS_0.0.40.md) and the strict automation ledger in
[`P0_P2_INTEGRATION_COVERAGE.md`](P0_P2_INTEGRATION_COVERAGE.md). Where they disagree, the ledger wins.

## How to read the tags

**Priority** — `P0` release blocker, `P1` important (needs a documented decision on failure), `P2` polish.

**Confidence** — what the automated suite actually proves for this behavior:

| Badge        | Meaning                                                                                                                                           | What you're really testing by hand                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `NONE`       | No automated test can reach this.                                                                                                                 | Everything. This is the only proof.                  |
| `LOGIC-ONLY` | Tests catch logic regressions, but run against **source with a fake at the native/packaged/OS boundary** (fake engine, no TCC, no signed bundle). | The native/packaged reality the fake stands in for.  |
| `REAL-SEAM`  | An integration test drives the **real production collaborators in-process** (real SQLite/HTTP/crypto).                                            | Only the device/OS/pixels layer on top. Spot-check.  |
| `PROVEN`     | Ledger-complete: real collaborators through the real application seam, end to end.                                                                | Confirmation only. Trust unless something looks off. |

Rule that overrides the badge: a `LOGIC-ONLY` or `REAL-SEAM` item that involves the **signed artifact,
real permissions, real audio, real display capture, a global hotkey, another app, or an installed
network probe** still requires the manual pass. TTS shipped green-but-broken once because its test used
a fake worker — treat every native item as unproven until you see it on the device.

## Progress summary (fill as you go)

- Tier 0 (blockers, no automation): \_\_ / 3
- Tier 1 (manual-only P0 boundaries): \_\_ / 11
- Tier 2 (P0 native seam, automation can't reach it): \_\_ / 12
- Tier 3 (P0/P1 real-seam, spot-check): \_\_ / 20
- Tier 4 (proven + polish, lowest priority): \_\_ / 8

---

## TIER 0 — Release blockers with ZERO automation behind them (do first)

> If you only had 30 minutes, these are the three. Nothing in the repo proves any of them.

- [ ] **1. `[P0][NONE]` Signed / notarized artifact integrity.** Mount the final Developer ID DMG.
      Run `codesign --verify --deep --strict --verbose=4`, `xcrun stapler validate`,
      `spctl --assess --type execute --verbose=4`. Confirm version `0.0.40`, bundle id
      `co.getoffgridai.desktop.pro`, Team ID `84V6KCAC49`, hardened runtime, both ASAR fuses
      (`EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`).
      **Expected:** signed, notarized, stapled, Gatekeeper-accepted; ASAR roots are only
      `/node_modules`, `/out`, `/package.json`; **no forbidden path** in the bundle
      (`pro/` source, `.offgrid`, `.demo-profile`, `.claude`, `.Codex`, `coverage`,
      `out/packaged-helpers-*`), no nested `.app`.

- [ ] **2. `[P0][NONE]` Packaged app stays locked without a license (final artifact).**
      Fresh profile, no license. Run `node scripts/smoke-license-gate.mjs` against the final app.
      Open every locked route: Day, Reflect, Replay, Meetings, Actions, Entities, Search, Notifications,
      Voice, Vault, Clipboard.
      **Expected:** `window.api.isPro === false`; every route shows its Upgrade screen; no Pro screen,
      capture loop, tray service, global shortcut, or Pro settings section activates. `OFFGRID_PRO=1`
      cannot force entitlement on the packaged app.

- [ ] **3. `[P0][NONE]` Pro entitlement on the final artifact.** Enter an invalid key, then a
      device-limit key, then a valid test key. Relaunch when prompted.
      **Expected:** invalid and exhausted keys show distinct real reasons and stay locked; the valid key
      persists and unlocks real Pro screens only after the required restart.

---

## TIER 1 — Manual-only P0 boundaries (no automated test can faithfully reproduce these)

- [ ] **4. `[P0][NONE]` Install from the detached DMG.** Drag to `/Applications`, eject, open the
      copy. **Expected:** opens with no crash, white screen, damaged-app warning, or dependency dialog;
      nothing loads from the mounted image.

- [ ] **5. `[P0][LOGIC-ONLY→verify on device]` Packaged helpers + System Health.** Settings > Setup &
      health after install; start each runtime once. **Expected:** app finds `llama-server`, ffmpeg,
      Whisper/Parakeet, TTS, image helpers, and all required dylibs; System Health gives a specific
      actionable reason for anything unavailable, never a bare "Down" when stderr has a cause.

- [ ] **6. `[P0][NONE]` macOS permission recovery.** Deny then grant Screen Recording, Accessibility,
      Microphone, Notifications one at a time; use the affected feature each time.
      **Expected:** denial is specific and recoverable; unrelated features keep working; granting causes
      no prompt loop.

- [ ] **7. `[P0][NONE]` Capture-off is absolute (Pro).** Turn capture off, work in another app for
      several minutes, inspect Replay, Search, data counts.
      **Expected:** no new frame, observation, OCR result, entity, or to-do created until you resume.

- [ ] **8. `[P0][NONE]` Sensitive-surface exclusion (Pro).** Capture on; visit an excluded app, an
      auth screen, a private browser window, a password manager (synthetic content).
      **Expected:** none appears in frames, OCR, Replay, Search, entities, or memory; a normal app before
      and after still captures.

- [ ] **9. `[P0][NONE]` Global dictation hotkey against real apps (Pro).** Set Option+Space to Hold,
      Toggle, Both in turn; use in TextEdit and another app; place caret between two strings and dictate.
      **Expected:** each gesture creates exactly one recording lifecycle for its mode; overlay opens and
      closes; transcript inserts once at the caret; prior clipboard restored; Voice record saved.

- [ ] **10. `[P0][NONE]` Real meeting detection (Pro).** Join and leave a real Zoom/Meet/Teams call
      with auto-detect on. **Expected:** starts/prompts per settings; lobby and post-call do not record;
      leaving warns and stops; system audio + mic released.

- [ ] **11. `[P0][NONE]` Vault crypto journey (Pro).** Create a vault with a strong password, lock,
      try a wrong password, unlock; then back up the KDBX and use the recovery-phrase path.
      **Expected:** wrong password exposes nothing; correct password restores; backup opaque outside the
      app; wrong phrase fails, correct phrase restores without data loss.

- [ ] **12. `[P0][NONE]` Upgrade from 0.0.38 (both bundle ids).** From a 0.0.38 Core install
      (`co.getoffgridai.desktop`) and a 0.0.38 Pro install (`co.getoffgridai.desktop.pro`), with
      synthetic chats/knowledge/model selections/settings/Pro stores/entitlement seeded first. Exercise
      the real updater feed AND a manual DMG replacement.
      **Expected:** 0.0.40 opens without onboarding; migrations run once; all data and selections remain;
      gating stays correct; no duplicate or orphaned records.

- [ ] **13. `[P1][NONE]` Product identity.** Finder, Dock, menu bar, window title, About, permission
      prompts, Settings footer. **Expected:** every name is "Off Grid AI Desktop", no legacy name.

- [ ] **14. `[P0][NONE]` Windows 0.0.40 — or explicitly cut it.** On clean Windows: installer
      signature, install/uninstall, first launch, packaged lock, valid entitlement, helper startup,
      update, 0.0.38 upgrade. **Expected:** no SmartScreen/missing-runtime failure; forged license stays
      locked; both journeys work. _If Windows is not shipping tonight, record that decision and skip._

---

## TIER 2 — P0 behaviors with tests, but the native/packaged seam is unproven (fake at boundary)

> Integration tests exist and catch logic regressions. They run against a fake engine / no TCC / no
> signed bundle, so the ledger marks these **partial**. Verify each on the device once.

- [ ] **15. `[P0][LOGIC-ONLY]` Fresh profile is truly empty.** New disposable profile.
      **Expected:** onboarding, no leftover chats/projects/models/captures/entities/credentials/settings.
      _(Ledger #9 "Configure for me" onboarding is PROVEN; the empty-start assertion is real-seam — but
      confirm on device.)_

- [ ] **16. `[P0][LOGIC-ONLY]` "Configure for me" completes on device.** Automatic setup path.
      **Expected:** understandable progress, recommended downloads complete, active choices populated,
      lands on Models with no blank/stuck step.

- [ ] **17. `[P0][LOGIC-ONLY]` Download + activate a real text model, survive relaunch.**
      **Expected:** no false Ready; same model active and answers a new prompt after full quit + reopen.

- [ ] **18. `[P0][LOGIC-ONLY]` Interrupted download recovery + failure containment.** Quit mid-download;
      reopen. Also test offline, truncated GGUF, low-space target. **Expected:** partial resumes or is
      explicitly retryable, never promoted to installed before integrity; failures specific; no phantom
      model or dangling active pointer; app stays open.

- [ ] **19. `[P0][LOGIC-ONLY]` First local message streams and persists.**
      **Expected:** tokens stream into exactly one assistant bubble; final answer persists after switching
      screens and after relaunch.

- [ ] **20. `[P0][LOGIC-ONLY]` Chat engine failure + recovery.** Trigger a safe engine/gateway failure
      mid-turn, restore health, send again. **Expected:** error names the real cause; spinner + Stop
      clear; next turn succeeds without restarting the profile.

- [ ] **21. `[P0][LOGIC-ONLY]` Image generate + cancel on device.** Generate, switch conversation during
      progress, return, stop a second generation. **Expected:** only the owner conversation shows progress;
      exactly one result saved for the first; cancel affects only the second; preceding text survives
      relaunch. Over-budget model refused clearly, no system-wide memory pressure.

- [ ] **22. `[P0][LOGIC-ONLY]` TTS speak on device.** Speak an answer containing Markdown, then Stop /
      navigate away. **Expected:** clean text read without Markdown syntax; all audio stops promptly.
      **⚠ This is the exact behavior that shipped broken with a green test — do not skip.**

- [ ] **23. `[P0][LOGIC-ONLY]` Capture starts after permission grant (Pro).** Enable capture, grant
      Screen Recording, use a synthetic work surface, wait for processing. **Expected:** frames +
      observations begin with no restart loop; capture health truthful.

- [ ] **24. `[P0][LOGIC-ONLY]` OCR to Search (Pro).** Display a unique synthetic phrase in another app,
      allow processing. **Expected:** Search finds the capture/observation and opens the right record.

- [ ] **25. `[P0][LOGIC-ONLY]` Record a meeting manually (Pro).** Start/stop a short synthetic meeting.
      **Expected:** one recording with sane duration; processing yields searchable transcript, summary,
      decisions, to-dos; all survive relaunch.

- [ ] **26. `[P0][LOGIC-ONLY]` Recover from forced quit + engine crash + low disk.** Force-quit during
      non-destructive work after a committed change; crash the text engine while Chat is open; use a
      low-space volume. **Expected:** boots with no white screen / stuck busy; committed data remains; no
      orphaned helpers/ports; engine recovers and next request succeeds; low-space failures contained.
      _(Ledger #145 cold relaunch is PROVEN; the engine-crash + low-disk variants are not.)_

---

## TIER 3 — P0/P1 with real in-process integration coverage (spot-check, don't deep-test)

> These drive real SQLite/HTTP/crypto in-process. Regressions are caught. Run each once to confirm
> the wiring on the installed app; move on if green.

- [ ] **27. `[P0][REAL-SEAM]` Local gateway.** `GET http://127.0.0.1:7878/v1/models` + a streaming
      completion. **Expected:** OpenAI-compatible list; SSE tokens before completion, ends `[DONE]`.
      _(Ledger #79 PROVEN.)_
- [ ] **28. `[P0][REAL-SEAM]` Gateway network boundary.** **Expected:** loopback HTTP succeeds; the
      Mac's non-loopback interface is rejected. _(Real TCP integration.)_
- [ ] **29. `[P0][REAL-SEAM]` Memory scopes.** No memory (conversation only) vs All memory (matching
      stored context + citation); empty store gives a clear empty state, not a crash bubble.
- [ ] **30. `[P0][REAL-SEAM]` Stop safely.** Stop before first token and during streaming.
      **Expected:** pre-token aborts before tools/side effects; partial answer remains; busy clears; next
      prompt works.
- [ ] **31. `[P0][REAL-SEAM]` Conversation + project isolation.** Switch conversation / change project
      while a response runs. **Expected:** progress, results, artifacts, persistence stay with the
      conversation/project captured at send time.
- [ ] **32. `[P0][REAL-SEAM]` Vision input.** Vision model on the synthetic image, then text-only
      model, then a damaged image. **Expected:** vision answer refers to the real attachment; unsupported
      input blocked with a specific reason; conversation stays usable.
- [ ] **33. `[P0][REAL-SEAM]` Project create/restore, knowledge attach/retrieve, deletion scope.**
      **Expected:** project appears once; unique-phrase retrieval works with no cross-project leak;
      deletion removes only project-owned records.
- [ ] **34. `[P0][REAL-SEAM]` Connector lifecycle + write-approval gate.** Add a disposable connector;
      run a read-only tool; request a write, reject once, then approve once; Stop before a proposed write.
      **Expected:** Connected only after real tools load; no external write before approval; Reject does
      nothing; Approve executes once and records status; concurrent clicks cannot duplicate the action.
      **(Manual remote boundary — the external target must actually prove no write occurred.)**
- [ ] **35. `[P0][REAL-SEAM]` Model ports single-owner.** With one app running, attempt a second
      launch. **Expected:** existing app focused or conflict explained; no second server, no `EADDRINUSE`
      cascade, no false corruption message.
- [ ] **36. `[P0][REAL-SEAM]` Unified Search (Pro).** Search a value present across capture, meeting,
      entity, fact, memory, chat, knowledge, connector; toggle source filters + sorting.
      **Expected:** every enabled source with correct facet + deep link; disabled disappear; ordering
      updates with no stale rows.
- [ ] **37. `[P0][REAL-SEAM]` Approval lifecycle (Pro).** Suggest actions, inspect args + provenance,
      reject one with a reason, approve one disposable proposal. **Expected:** Pending/History truthful;
      rejected never executes; approved executes once; status persists; no duplicate on repeated clicks.
- [ ] **38. `[P0][REAL-SEAM]` Clipboard capture + restore (Pro).** Copy a distinctive string
      repeatedly, restore after copying something else; capture a bitmap and a file; restore file to
      Finder and text to TextEdit/Terminal; Cmd+Shift+C popup keyboard restore.
      **Expected:** one refreshed item (not duplicated); exact original restored once; Finder gets a file
      URL, text target gets the path; popup keyboard selection restores once.
- [ ] **39. `[P0][REAL-SEAM]` Vault item round-trip (Pro).** Create/reopen/edit/copy/delete a login,
      app password, API key, secure note, secret file. **Expected:** correct fields persist; copy sends
      only the chosen field; binary attachment intact after lock/unlock. _(Ledger #127 copy-to-clipboard
      PROVEN.)_
- [ ] **40. `[P0][REAL-SEAM]` Clear cache preserves user data.** Seed chats/project/models/settings/Pro
      data; Clear cache; relaunch. **Expected:** ephemeral Electron cache cleared; chats, projects,
      models, settings, license, Vault remain.
- [ ] **41. `[P0][REAL-SEAM]` Delete one category only.** **Expected:** only the selected synthetic
      category disappears; unrelated stores/connectors/credentials/models/files remain.
- [ ] **42. `[P0][REAL-SEAM]` Delete all personal data.** Seed every Core + Pro personal store + a
      disposable connector; Delete all my data; relaunch. **Expected:** all personal data gone; installed
      models + ordinary preferences follow documented retention.
- [ ] **43. `[P0][REAL-SEAM]` Cached entitlement offline (Pro).** Activate online, quit, disconnect,
      reopen; repeat with a fresh unentitled profile. **Expected:** OS-protected encrypted cache follows
      policy; fresh profile stays locked; plaintext/expired cache cannot unlock Pro.
- [ ] **44. `[P0][REAL-SEAM]` Local features offline.** Disconnect network; exercise chat, image, OCR,
      retrieval, and Pro Replay/Search/dictation/clipboard/Vault. **Expected:** local features keep
      working with no unexpected egress; downloads/connectors/license/update fail clearly.
- [ ] **45. `[P1][REAL-SEAM]` Entities + contextual to-dos (Pro).** Synthesis/dedup, entry points +
      corrections + merge, to-do extraction + manual enrichment + lifecycle tabs. **Expected:** each
      entity once with correct type/aliases/evidence; merge retains everything under one survivor; to-dos
      not duplicated on re-view.
- [ ] **46. `[P1][REAL-SEAM]` Settings persistence + residency + storage totals.** Change Core + Pro
      settings, toggle image/STT/TTS residency, check Storage; relaunch. **Expected:** every value
      restores in its owning section; Core shows placeholders not real Pro bodies; Chat residency stays
      required; storage totals reasonably aligned. _(Ledger #129/#130 residency PROVEN.)_

---

## TIER 4 — Ledger-PROVEN + P2 polish (lowest priority; trust unless something looks off)

> The 19 ledger-complete journeys plus low-frequency polish. Confirm quickly or defer if time runs out.

- [ ] **47. `[P1][PROVEN]` Onboarding resumes an interrupted download** (#12). Completed steps stay
      complete; partial resumes or shows Retry; no duplicate download.
- [ ] **48. `[P1][PROVEN]` Delete inactive + active model** (#29/#30). Active selection clears or moves
      to a valid replacement; no missing-file loop.
- [ ] **49. `[P0/P1][PROVEN]` Replay chronology + open selected moment** (#87/#89). Images, labels,
      captions, timestamps, order agree; deep link opens the selected moment; media stays local.
- [ ] **50. `[P2][PROVEN]` Conversation rename + copy reply** (#44/#46). Rename persists; copied text
      exact; no duplicated user turn on regenerate.
- [ ] **51. `[P2][PROVEN]` Project desktop layout** (#59). Dense master-detail; controls adjacent to
      content.
- [ ] **52. `[P1][PROVEN]` Desktop widths + keyboard focus** (#150/#151). Collections gain columns; no
      stretched single rows; focus order logical and visible; dialogs trap + restore.
- [ ] **53. `[P2][REAL-SEAM]` Retention policies (Pro voice + clipboard).** Short retention removes
      expired rows + media; newer items remain.
- [ ] **54. `[P2][REAL-SEAM]` Transient layers + Reduce Motion + external links.** Escape closes only
      the top layer; Reduce Motion keeps content reachable; external links open the exact HTTPS target in
      the system browser without navigating the Electron window.

---

## Sign-off (from the full checklist)

- [ ] Every P0 checked in both locked and entitled states.
- [ ] Every P1/P2 failure has an owner and a documented release decision.
- [ ] All evidence is synthetic-only, no real profile data.
- [ ] Clean shutdown: no leaked app, model server, gateway, recorder, dictation helper, mic
      indicator, capture indicator, or mounted DMG.
- [ ] Release owner authorizes publication.

---

### One honest caveat for the person running this

The automated suite (355 test files, ~144 real integration/db tests, ~95% line coverage) is strong at
**catching logic regressions** and weak at **proving the shipped app**. Every `NONE` and most
`LOGIC-ONLY` items sit exactly where this product has broken before: the signed bundle, real
permissions, real audio, real capture, global hotkeys. The green suite is not evidence for those.
Tiers 0-2 are the release. Tiers 3-4 are confirmation.
