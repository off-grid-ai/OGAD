# R2 checklist - full rails in chat, both platforms + Approval UX v2

Execution checklist for R2 of `COMPUTER_USE_PLAN.md`. Same rules as R1: one box = one
commit-sized unit, landed green (`tsc` node+web+pro, `npm test`), tests in the same
commit, port before writing, brand copy rules on every UI string.

## A. Windows chat exposure (~1 day)

- [x] **A1. Per-platform tool specs**: `specsForPlatform(platform)` in the logic file -
  darwin keeps all eight; win32 exposes the engine-routed set the Outlook rail supports
  (calendar_create_event, reminders_create, mail_send, open_url); everything else none.
  A win32 system hint that never mentions iMessage or contacts.
  *Done when:* filtering + hints tested per platform; the extension's schemas/canHandle/
  systemHint follow the platform; registerNativeActionTools registers on win32.
- [x] **A2. The win32 inline runner**: open/navigate on Windows goes through the shell
  (injected opener); every other inline verb refuses honestly. The production boundary
  picks the runner by platform in one place.
  *Done when:* runner tests through the injected opener; unknown verbs refuse.
- [x] **A3. Outlook read-back verifiers**: list scripts for tasks (olFolderTasks 13)
  and calendar range (olFolderCalendar 9, Restrict on [Start]) speaking the same
  {reminders|events:[{title}]} shape as the mac helper, exposed as a RunNative reader
  so `buildRegistry` works unchanged; the runtime picks the reader by platform.
  *Done when:* script content + reader mapping tested; the read-back verifiers pass over
  a scripted PS boundary; unknown verbs refuse.

## B. Approval UX v2 (~1-1.5 days, core + desktop-pro)

- [ ] **B1. Risk-tiered gating policy**: reversible mutations (reminder, calendar)
  auto-run + verified confirmation; sends and irreversible actions keep the gate.
  Policy defined once (engine-side risk + handler declaration), tested per tier.
- [ ] **B2. Undo affordance** for auto-run reversibles (delete the created item), in
  chat next to the confirmation.
- [ ] **B3. Inline approval card in chat**: resolved values + Approve / Edit / Reject
  driven by `resolveActionGate`; the Actions screen stays the unattended queue + audit.
- [ ] **B4. The pro migration** (desktop-pro): pro's approval queue resolves the engine
  gate instead of running its own executor - payload binding + verification hold on
  pro; outcome feedback lands back in the chat turn and on the card.

## C. The browser rail (~1.5-2 days)

- [ ] **C1. CDP snapshot + indexed elements** over `webContents.debugger` (nanobrowser
  dom module as start code, browser-use algorithm).
- [ ] **C2. The watched pane + takeover** (login/identity boundary pauses, user acts).
- [ ] **C3. web_task through the engine** (act/observe/extract API, Zod-validated),
  gated at identity, verified by page-state postconditions.

## D. The vision rail (~1.5-2 days, supervised tier)

- [ ] **D1. UI-TARS-1.5-7B catalog entry** (GGUF + mmproj, Models screen) + OmniParser
  v3 set-of-marks fallback.
- [ ] **D2. The operator spine** (@ui-tars/sdk patterns, nut-tree-fork/robotjs input;
  CGEvent mac / SendInput win) with the overlay, pause-on-input, kill switch.
- [ ] **D3. file_share through the engine** (the WhatsApp recipe) behind the gate.

## E. Safety pass + the release

- [ ] **E1. Injection-resistance review** (screen content is untrusted), kill-switch
  e2e, per-rail verification depth honored.
- [ ] **E2. Release**: one versioned dispatch - signed/notarized .dmg + Windows NSIS
  .exe; release notes honest about the supervised tier and what was human-verified.

## Watch-list

- Vision on a local 7B is best-effort: labeled supervised or not shipped.
- Windows browser/vision needs a human on a real Windows machine before E2.
- B touches the live chat surface: behavior tests per branch; non-action turns stay on
  the plain path untouched.
- Until B4 lands, the Windows PRO path (approval queue -> legacy executor) cannot run
  Outlook actions; free-build Windows uses the engine path and works from A onward.
