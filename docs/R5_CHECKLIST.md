# R5 - model-agnostic computer use (the tiered rail)

Goal: **computer use works on most chat models.** The vision grounder (R2, UI-TARS)
becomes a last-resort fallback; the user's normal model drives the common case via
the accessibility tree, and a small detector covers the dead-AX tail. Router order:
semantic -> browser -> **accessibility** -> set-of-marks -> vision.

Scope now: **Tier 1 (AX driving rail) + Tier 2 (set-of-marks).** Tier 3 (the
grounder's separate loader + pluggable formats) is deferred.

Build rule (as everywhere): pure logic in Electron-free modules, unit-tested; the
native helper + the on-screen actuation are the injected boundaries, verified on a
real machine. Reuse the browser rail's loop - do not fork a parallel one.

## Tier 1 - the accessibility driving rail

- [x] **T1a. The element contract + parser (pure).** `AxElement` (role, label, value,
  frame -> center cx/cy, actionable, enabled) + `parseAxElements` + a
  `formatAxElementsForModel` that numbers them like the browser collector. Fail-closed
  on malformed lines. `ax-elements.ts` (+ 7 tests).
- [x] **T1b. The picking loop (pure).** `runElementTask(goal, deps)` - snapshot,
  model picks `{action: click|press|type|key|done|give_up, index, text, keys}`
  (grammar-constrained, fail-closed), act via the injected actuator. Same shape as the
  web-task loop; SHARED with the set-of-marks tier. `ax-agent.ts` (+ 16 tests).
- [x] **T1c. The Swift helper: structured-elements mode.** `--elements <app>` walks the
  AX tree and emits one JSON object per interactive element (role, label, value,
  frame, AXPress, enabled). Hardened for real apps: triggers the Chromium/Electron web
  tree (AXManualAccessibility + AXEnhancedUserInterface), retries until it populates,
  resolves the app to a foreground process. `--apps` lists candidates (NSWorkspace, no
  SR grant). Built + minos-gated via `scripts/build-text-extractor.sh` (pinned 13.0).
- [x] **T1d. The AX reader + host (shell).** `ax-host.ts`: resolve the target app
  (ax-target.ts, pure + tested), read via the helper, activate it so clicks land, and
  drive `runElementTask` with the local model + the shared nut.js actuation. Reuses the
  vision guard (Esc) + controller (overlay Stop). Excluded from coverage like the other
  rail hosts. Target-picker: `ax-target.ts` (+ 7 tests).
- [x] **T1e. Engine wiring + the router.** `computer_task` tries the accessibility rail
  FIRST and falls to vision when the AX tree is too thin (`ax-router.axRailViable`, 7
  tests) or the goal names no running app. The tiering is a pure, tested function
  (`ax-rail.ts`, 5 tests); `use-runtime` wires the live hosts into the 'vision' branch.
- [ ] **T1f. Verify + evidence.** Real-machine pass: "open the DM with X in Slack",
  "click Send", a native file dialog navigated by AX. The grounder must NOT load for
  these. Screenshots + the step feed in the PR. (Helper verified: Slack 90 elements,
  Chrome 231 - the live end-to-end drive is the remaining hands-on step.)

## Tier 2 - set-of-marks (the dead-AX tail)

- [ ] **T2a. The marks model.** A small OmniParser-class detector (icon/text element
  detection -> boxes). Catalog + a detection-model runtime (ONNX-class) separate from
  llama.cpp. Sized so it is NOT a 7B grounder.
- [ ] **T2b. The marks composition (pure).** Detector boxes -> numbered overlay ->
  `AxElement[]`-shaped list (a box is just an element with no AX role) so tier-1's
  loop and formatter are reused unchanged; the general VISION model picks the number.
- [ ] **T2c. Router fallthrough.** When AX yields too few actionable elements, fall to
  set-of-marks before vision. One decision function, tested.
- [ ] **T2d. Verify.** A Catalyst / WhatsApp-class app driven by a general vision
  model via numbered marks, on a real machine.

## Deferred (not R5)

- Tier 3 hardening: the grounder's separate on-demand loader (image-gen eviction
  pattern) + per-model grounding-format adapters (UI-TARS / Aguvis / OS-Atlas).
- Windows: the UIA reader as tier-1's Windows twin (mirrors T1c/T1d via UIAutomation).

## Watch-list

- The AX driving rail is an architecture change: AX becomes a first-class hands, not
  just eyes (see the R5 note in COMPUTER_USE_PLAN.md / ASSISTANT_ARCHITECTURE.md).
- Reuse the browser-rail loop for T1b/T2b - a second copy is a defect.
- Never run the push gate while a dev app is live (the DB-ABI swap in `test:db`
  breaks the running app - learned the hard way during R2 testing).
