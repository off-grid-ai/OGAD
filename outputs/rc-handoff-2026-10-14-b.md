# RC handoff, part 2 (2026-10-14, afternoon)

This follows `outputs/rc-handoff-2026-10-14.md`. Read that first: its rules and test-running traps (§5, §7) still apply. This session consolidated the three earlier chats and was stopped on request partway through the test pass.

## Where everything is (all pushed)

| Repo | Branch | Head |
|---|---|---|
| desktop (OGAD) | `fix/remote-inference-engine-updates` | `cc1069b58`, pointing at Pro `032333d` |
| desktop/pro | `fix/remote-inference-engine-updates` | `032333d` |
| browser-extension | `fix/remote-inference-engine-updates` | `1927464` (version 0.0.2) |
| mobile | `fix/remote-inference-engine-updates` (local checkout now on it, not `main`) | `41313a47b` |
| shared | `main` | `5b3d19d` (built output is current) |

PRs:
- [OGAD#195](https://github.com/off-grid-ai/OGAD/pull/195)
- [desktop-pro#103](https://github.com/off-grid-ai/desktop-pro/pull/103)
- [OGAM#717](https://github.com/off-grid-ai/OGAM/pull/717)
- [browser-extension#15](https://github.com/off-grid-ai/browser-extension/pull/15), new; its body lists the upgrade findings.

## Baselines (verified with `gh release list`)

- **Desktop:** v0.0.55-beta.122 (13 Oct) is the newest release. v0.0.54 stable is still supported.
- **Mobile:** v0.0.114-beta.1 (13 Oct) is the newest release. v0.0.111 stable is still supported.
- **Extension:** **0.0.1 is now published on the Chrome Web Store.**
  - Chrome's update endpoint reports 0.0.1.
  - It was built from `38e25c1`, per `dist/packages/candidate-source.txt` and the 8 Oct zip.

## Done this session

- **Extension upgrade path from published 0.0.1 checked:**
  - Manifest permissions are unchanged, so Chrome won't disable the extension on update.
  - Pairing keys stay in the same IndexedDB store (`offgrid-bridge` v1).
  - The chat library key is kept.
  - Bridge methods: the RC Desktop handles every method 0.0.1 calls, and the RC extension's methods equal Desktop beta.122's.
  - Known resets, by design:
    - The 0.0.1 read-aloud voice, speed and auto-read prefs, which moved to Desktop.
    - Deletes queued but not yet sent are not replayed (`daa8e3d`).
  - v0.0.54 stable has no extension bridge, so pairing needs the 0.0.55 betas or later. This is pre-existing and documented in `docs/RELEASE.md`.
- **Extension version bumped to 0.0.2** (`1927464`). The Web Store rejects an upload that doesn't raise the version.
- **Extension on the current head:** unit 2375/2375, typecheck, lint, format:check, Chrome build and Firefox build all pass.
- **Desktop `npm test` re-measured from `4aba9518b`:** 47 failed / 7453 passed in 12 files, plus 2 unhandled errors. Fixes so far:
  - **Pro + polish (5 files): 39/39 pass.** Pro `032333d` + desktop `49bb2872b`.
    - 3 needed query or fixture updates for the new UI.
    - 2 obsolete tests were removed, with evidence in the commit message: the old vault sidebar lock label and the task-title "See more". The UI each one tested was deliberately removed in `4b96f0b` and `afd086c`.
    - The Replay test's fixture lacked a capture `ts`. All production writers set it; this is not a regression.
  - **Chat (5 MemoryChat files): 53/53 pass.** `49bb2872b`, test-only changes, all (a) intended UI changes, every assertion kept.
    - The voice-replay test is (c): jsdom's zero-size boxes make `react-resizable-panels` swallow pointerdown on select options. That test now picks the voice from the keyboard.
  - **Shell/navigation: partly fixed** (`cc1069b58`). `App.navigation` + `CommandPalette` went from 9 passed / 28 failed to **24 passed / 13 failed**.
    - Fixed:
      - A fake-timer/jsdom rAF cascade (c) that broke about 17 tests in run order.
      - The `mcpList` fake now returns an array, matching `src/main/mcp-ipc.ts`. Both `connectors is not iterable` errors are gone.
      - Project view tabs are now radios (a).
    - **Still failing (13):**
      - Entities/Models/Notifications routed tabs (6). They are now `Segmented` radios, so the test's `aria-current="page"` check needs deciding: does the radio still expose current-page state, or should `aria-checked` assert the same outcome?
      - "routes permission recovery…": no "Screen Recording" heading.
      - "shows Tasks only on Chat routes…": the task panel doesn't return after Search → chat. There is also an unhandled `sources.map` of undefined at `pro/renderer/screens/SearchScreen.tsx:181`. Likely another harness fake returning undefined; check main's real return type first.
      - CommandPalette (5): the palette doesn't close after navigating, and "Found multiple elements" on the nested routes. Not investigated.

## Uncommitted when stopped

- Nothing of this session's. `browser-extension/e2e/screenshots/*.png` churn is from an earlier e2e run and was left alone.

## Not run yet

- **Desktop:**
  - The full `npm test` again, after the navigation group is finished.
  - `test:db`, `test:heavy`, `test:e2e`, `typecheck`, `lint`, `depcruise`.
- **Extension:** e2e. Its stub gateway binds **:7878**, which your running dev Desktop holds.
- **Mobile:**
  - `npm ci` was stopped partway when the session ended (`node_modules` was missing before). Re-run `npm ci` from scratch; the JS suite never ran.
  - Re-run `npx jest`, then `npm run test:android` / `test:ios` (see the iOS Pods note in part 1, §7).

**Port note:** extension e2e (:7878), desktop heavy (:8439) and desktop e2e all need the dev Desktop app quit. Batch them and ask the user once.

## Release blockers / decisions

1. Finish the 13 navigation/CommandPalette tests above, then get the desktop full suite green: unit, DB, heavy, e2e, lint and typecheck.
2. Extension e2e, and the `OPERATOR_UI_TOKEN` (or `CI_CROSS_REPO_TOKEN`) secret on the extension repo. Only the user can add the secret.
3. Mobile JS and native suites on the RC branch.
4. **Debug logging in shipped chat code:** about 86 `console.log('MemoryChat …')` calls across `src/renderer/src/components/MemoryChat/` (`index.tsx` has 44, plus MessageActions, MessageContext and others).
   - Added in `4ee39d701` (25 Sep), so v0.0.55-beta.122 already ships them. Not new in this RC.
   - Cheap to remove, but check whether any test counts on them first. The user decides whether that's in RC scope.
5. Carried over from part 1: lint items (`MessageMetadata.tsx` optional chain, `pro/renderer/lib/browser-region.ts` setState-in-effect), and the IconAction library-swap question for the user.
6. Tell the paused "Webview container layout issue" session when the RC pass is done.
