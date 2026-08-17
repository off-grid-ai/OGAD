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

- [ ] **T1a. The element contract + parser (pure).** Define `AxElement` (role, label,
  value, frame x/y/w/h, actionable, enabled) and parse the helper's structured
  output into `AxElement[]`; a `formatAxElementsForModel` that numbers them like the
  browser collector. Fail-closed on malformed lines. Unit-tested against sample
  output - the parser is the contract the Swift helper must honour.
- [ ] **T1b. The picking loop (pure).** `runAxTask(goal, deps)` - snapshot the
  elements, the model picks `{action: click|type|press|done|give_up, index, text}`
  (grammar-constrained, fail-closed parse), act via the injected actuator. Reuse the
  `web-task-agent` shape verbatim (step budget, re-observe on unparsed, done/give_up).
  Injected boundaries: the reader, the model, the actuator. Unit-tested control flow.
- [ ] **T1c. The Swift helper: structured-elements mode.** Extend
  `scripts/text-extractor` with an `--elements <app>` mode that walks the AX tree and
  emits one line per interactive element: role, label/title, AXPosition+AXSize frame,
  whether it exposes `AXPress`, enabled, value. (The walker + permission plumbing
  already exist; this adds a structured emitter beside the text one.) Rebuild via
  `scripts/text-extractor.sh`; gate on the same signing/deploy-target checks as the
  other helpers. Cannot be verified headless - real-machine pass.
- [ ] **T1d. The AX reader + host (shell).** A main-process reader that runs the
  helper `--elements` mode -> `AxElement[]`, and the host that drives `runAxTask`:
  the reader, the local model as the picker, and actuation via AXPress (native) or a
  click at the element frame (the nut.js path already wired). Excluded from coverage
  like the other rail hosts.
- [ ] **T1e. Engine wiring + the router.** Register the `accessibility` rail; a
  `computer_task` tries the accessibility rail FIRST and falls to vision when the AX
  tree is too thin (few/no actionable elements) or the loop gives up. The cheapest-
  first decision (AX vs vision) is a pure, tested function. `device.execute` gains the
  `accessibility` branch.
- [ ] **T1f. Verify + evidence.** Real-machine pass: "open the DM with X in Slack",
  "click Send", a native file dialog navigated by AX. The grounder must NOT load for
  these. Screenshots + the step feed in the PR.

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
