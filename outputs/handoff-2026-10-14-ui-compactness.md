# Handoff — UI compactness, webview fix, Replay speed (2026-10-14)

From the "Webview container layout issue" session. Everything below is **committed and pushed**
on `fix/remote-inference-engine-updates`, the branch name in desktop, desktop-pro and the browser
extension. `shared` is on `main` (5b3d19d).

## Read first

- Workspace contract: `/Users/user/wednesday/off-grid-ai/.codex/ENGINEERING_CONTRACT.md`. In short:
  - No sub-agents or worktrees unless the user asks.
  - Make the smallest focused verification; never use mocks or spies.
  - Ask before adding schemas, migrations or new abstractions.
- Release-candidate mode is the user's standing directive (memory `release-candidate-cpto-mode`):
  - Minimal changes, one branch name in every repo.
  - **Finish all edits, then run every suite once**, fix, and re-run what was affected.
  - Don't run tests after each change. Push with `--no-verify` while building.
- Desktop tests need Node 22: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The default Node 26
  breaks better-sqlite3.
- Stage named files only (`git commit -- <paths>`). Other sessions keep work-in-progress in the same
  trees.
- UI rules (memory): Phosphor icons, approved library components only, icon buttons with
  aria-label and tooltip, and thin rows rather than tall cards. Wide collections are tables with a
  column per fact, plus Find and sortable headers.

## Latest state (end of day)

The UI integration session has also handed off. Its work is committed and pushed: OGAD
`4aba9518b`, Pro `7ed8c25`, extension `cc8a5b7`, and both apps are pinned at library **0ad3265**.
**The RC test pass is not finished**: the chat and Pro test groups and the full runs remain. Read
its handoff next: `desktop/outputs/rc-handoff-2026-10-14.md`. Finish that pass before the composer
"+" item below.

## Who else is working (coordinate before editing)

- **"Off Grid UI integration"** (local session): owns library pin bumps (`package.json` and
  lockfiles in desktop and the extension) and is running the **RC test pass**. Its agents are fixing
  about 197 desktop/Pro test failures in the working tree; the uncommitted test files there are
  theirs. It asked everyone else to **pause edits in desktop, Pro and the extension until it says the
  pass is done**.
- **"OGAD library component polish"** (cloud session; you can message it, but it can't message
  back): owns the operator-ui library (`component-library-animations`). Its pin **0ad3265** carries:
  - the click-ripple and card-edge timing fix;
  - the one-row `VoiceCapture`.
  The UI integration session is installing that pin.

## Done today (commit → what)

**desktop-pro**

| Commit | What |
|---|---|
| fc0d51d | Web Use live page stays inside its pane. `renderer/lib/browser-region.ts` tracks the region every frame and releases it when an ancestor clips it. The docked pane counts as on screen only when it is fully visible (`useElementShown`). |
| affe305 | God screen: the Ares and "Needs you" columns collapse. `SideColumn` in `GodTwinScreen.tsx` has a heading-row button, and a slim strip (with the waiting count) when shut. |
| d2246b2 | Compact Pro lists and settings: Day, Actions, Notifications, GodRoutines, Devices, Meetings, settings-sections. |
| ab4c4da | Replay speed. `listReplayFrames` read every frame caption (70k rows) on the main thread every 2s. Now it reads only the requested range (`main/crm/replay.ts`). Plus new index `idx_obs_frames_frame ON observation_frames(frame_id)` (`main/crm/schema.ts`, `CREATE INDEX IF NOT EXISTS`; harmless to older versions). On the user's DB, query time went from 16 ms to 1 ms. |
| dc866d6, 19d7b90 | `components/IconAction.tsx`: swapping glyphs (Play/Pause and so on) cross-fade in one grid cell, so they no longer drift right or down. |
| 45326e1 | Actions: to-dos and approvals are full-width tables (`TodoTable` in `TodoCard.tsx`, `ApprovalsTable` in `ActionsScreen.tsx`, coss Table). Day still uses `TodoCard`; both share the same control pieces. |
| 51865d2 | Entities: every section is one `EntityTable` (Name · Latest · Mentions · Days · Last active). It replaces the card grid; projects keep their tree. |
| 833531f | Actions: Find (`SearchDraftField`) plus sortable headers (`components/SortableHead.tsx`, `useTableSort`). |

**desktop (OGAD)**

| Commit | What |
|---|---|
| 1fd04fba5 | Compact settings. `SettingsRow` gained an `inline` prop (compact control on the label's line). `SettingsSection`, `SettingsCard`, setup, connectors, models and update screens are tighter. One-row sections are folded away. `SettingsPanel.backends` test updated: it no longer clicks the removed sections, and every assertion is kept. |
| d9d0940ad … 1fe1c7c80 | Pro pointer bumps. The pointer is now **833531f**. |

**browser-extension**

| Commit | What |
|---|---|
| 89b20fe | Compact side panel: no headings over a single row; tighter Row, Slider and EmptyNote; one-line add-connector form; vault import/export as rows; retry and unlock beside their message. |

**shared**

- Switched `feature/local-video-generation` → `main` (the user's call) and rebuilt `dist`
  (`npm run build`). That fixed desktop's `chat-stream-state.ts` type error caused by the video
  phases.
- An uncommitted `packages/models/src/hf.ts` draft was moved to `git stash` ("hf.ts image-search
  WIP…"). It looks superseded by main #49. Confirm with the user before dropping it.

## Open / next

1. **Composer "+" on the voice row.** Waiting for the RC pass to finish and pin 0ad3265 to be
   installed. In `src/renderer/src/components/MemoryChat/index.tsx` (around line 4782), voice mode
   renders `ChatVoiceComposer` and leaves the footer's "+" on its own row. Put them on one row.
2. **Nothing above has been checked in the running app by an agent.** The user saw the God
   toggles, the Play/Pause fix and the compact settings live. The webview containment, the
   Actions/Entities tables and the Replay speed-up were not confirmed live. Ask the user, or check
   them.
3. **Entities keyboard test** (`EntitiesScreen.integration.test.tsx`, "opens from the keyboard"):
   the UI integration session's agent is retargeting it to the row `aria-label="Open <name>"`.
   Leave it to them.
4. **Skipped on purpose:**
   - Models list view as the default (about 20 tests and the `desktop-polish` e2e test depend on
     the grid).
   - Devices and Notifications grids: there is no list mode; `fileGrid.ts` says the list view is a
     grid by design.
5. **Possible follow-ups the user hinted at:**
   - Replay's 2-second poll still lists the whole captures folder (about 9.5k files) each tick.
     It's cheap now that captions are bounded, but it could be event-driven.
   - Other long tables (Entities already has Find) may want sorting too.

## Test state (measured today, Node 22)

- **Desktop `npm test`** (product-integration, Pro included): 283 failed / 7,096 passed.
  - **All 283 also fail at HEAD without this session's changes.** This was proven by stashing
    our changes and re-running the 90 failing files: zero new failures.
  - The baseline failing-test list is at
    `/private/tmp/claude-501/-Users-user-wednesday-off-grid-ai-desktop/eb746651-0677-40a2-9163-9f4af5773376/scratchpad/base-tests.txt`
    (scratch; it may be cleaned up).
  - The UI integration session is fixing these.
- **Extension `npm test`:** 5 failed / 2,370 passed (VaultTransfer ×3, ComposerAuthority ×2). They
  fail without our changes too, so they come from the library pin or that session's commit.
  Typecheck is clean.
- **Typecheck:** desktop web, desktop node and Pro were clean after the shared rebuild. They may
  change while library pins are installed.

## Release blockers seen

- The ~283 pre-existing desktop/Pro test failures above (being fixed by the UI integration
  session).
- Library pins move often (ba9a35c → 079bd4f → 0ad3265). `node_modules/@offgrid/operator-ui` is
  empty while an install runs, and builds or tests fail during that window. Wait for
  `pgrep -f "npm install"` to come back empty.
