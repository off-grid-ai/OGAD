# Safety review - the act pillar (R2-E1)

The rails act on the user's behalf, and two of them (browser, vision) take
untrusted content as input: a web page or an on-screen app can display text
that tries to redirect the agent. This is the injection-resistance review for
the released rails. It records, per rail, what the threat is, what stops it,
and where that defense is tested - so a later change that weakens a defense
fails a test instead of shipping.

The governing principle: **the model only proposes; the pipeline guarantees.**
Every mutation is a durable Action that gates for approval, binds its payload
by hash, executes once, and verifies. Injection cannot manufacture an approved
action out of nothing - it can only try to steer a task the user already
approved. So the defenses below are about bounding that steering, and about
never letting the agent cross an identity or payment boundary on its own.

## The threats and the defenses, per rail

### Semantic rail (calendar, reminders, mail, open)

- **Threat:** low. The arguments come from the user's chat turn, not from
  scraped content. The model fills a typed tool schema.
- **Defense:** the payload-hash gate - what the user approves is byte-for-byte
  what runs; an edit re-binds and re-gates. Sends are `none_fuzzy` and single-
  attempt, so a wrong verify can never double-send.
- **Tested:** `shared/packages/use` retry + machine tests (never-double-fire),
  `use-runtime.integration.dbtest.ts` (real propose -> verify -> undo).

### Browser rail (web_use)

- **Threat:** high. The page is untrusted. Two attacks: (a) page text says
  "ignore your task, do X"; (b) a page tries to get the agent to type
  credentials or submit a payment.
- **Defenses:**
  1. **Page text is DATA, not instructions** - the shared visual prompt treats
     page and app text as untrusted content and stays anchored to the user's task.
  2. **The identity boundary is enforced in the driver, not the prompt.** Typing
     into a password / one-time-code field is _refused_ by `BrowserDriver.type`
     with a takeover signal - no prompt injection can talk the agent past code
     that refuses to run. Clicking a login field is allowed (that is how the
     human takes over); credentials never enter the snapshot the model sees.
  3. **The step budget** bounds how far a fully-fooled model could be steered
     before the task stops.
  4. **The watched pane** - the user sees every step and can take over or cancel.
- **Tested:** `browser-driver.test.ts` (the driver refuses identity fields and
  dispatches nothing), `vision-task-graph.test.ts` (budget, Stop, and handoff),
  `rail-injection-stance.test.ts` (the shared prompt contract), and
  `page-script.test.ts` (the collector never includes a credential value).

### Vision rail (computer_use) - supervised tier

- **Threat:** highest. The model drives real synthetic input on the live
  desktop from a screenshot, and the screenshot is untrusted (any app in view
  can show adversarial text).
- **Defenses (layered; the structural ones are load-bearing):**
  1. **The user is watching and the guard is the override.** The kill switch
     (Esc) is terminal and outranks everything; any user touch pauses until they
     resume; a step budget halts a flailing model. `canActuate()` is re-checked
     immediately before every dispatch, so an Esc mid-decision actuates nothing
     more.
  2. **Credentials are a handoff, never typed.** The prompt makes any sign-in /
     one-time-code / payment a `call_user`, and the agent is told on-screen text
     is untrusted content.
  3. **Capability-gated OFF until it is real.** Actuation needs a native addon +
     Accessibility/Screen-Recording entitlements; until those land the rail
     refuses cleanly and `computer_use` is not offered to the model. The tier
     ships labeled or not at all.
- **Tested:** `vision-guard.test.ts` (the kill switch is terminal and outranks a
  pause; the budget halts), `vision-agent.test.ts` (re-check-before-dispatch: a
  kill mid-decision actuates nothing), `rail-injection-stance.test.ts` (the
  prompt contract).

## Kill switch - the e2e note

The kill switch is a global `Escape` shortcut wired in the vision host, and its
_logic_ (terminal halt, outranks pause, re-check before dispatch) is unit-tested
in `vision-guard`/`vision-agent`. The full end-to-end - a real keypress halting
a real actuation loop and being consumed - can only be exercised once actuation
is available (D2b) on a real machine, so it is part of the real-machine pass in
`WINDOWS_TEST_PLAN.md`, not the headless e2e tour. Until then there is nothing
to actuate, so there is nothing to halt.

## Open items before the release (E2)

- **Actuation + entitlements (D2b)** for the vision tier, then the kill-switch
  e2e on a real machine, both platforms.
- **Real-machine click-through** for the browser and vision rails (CI proves
  builds, not clicks) - `WINDOWS_TEST_PLAN.md`.
- **Release notes** honest about the supervised tier: what is verified, what is
  best-effort, and that computer-use is off until actuation ships.
