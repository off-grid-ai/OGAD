# Accepted flow: Take Over and Continue (Computer Use)

Status: accepted by pm (Wanda). Owner of the rules: `@offgrid/automation` task state and input lease.
Desktop is a thin consumer: it shows the state and forwards the person's choice.

## The flow

1. A person watches a Computer Use task run. The supervisor shows the task is running.
2. The person presses **Take Over**.
3. The agent stops acting at once. The screen says the person has control.
4. The person uses the keyboard and mouse themselves. No agent click, type, or scroll happens.
5. The person presses **Continue**.
6. The agent looks at the screen again first, then carries on the same task from where it is.
7. Nothing the agent decided before the take over is ever acted on after it.

## Acceptance rules

- A1 Agent stop: after Take Over the agent performs no input at all. Any action already in
  flight is dropped, not delivered late.
- A2 Visible ownership: while the person holds control the supervisor states it in plain words,
  for example "You have control of this computer". The Continue choice is offered.
- A3 Same task: Continue carries on the same task and the same goal. It does not start a new
  task, does not reset progress, and does not lose earlier steps.
- A4 Fresh look first: after Continue the agent must take a new screenshot before it may act.
  It must never act on the picture it held before the take over.
- A5 Stale action rejected: an action prepared before the take over is refused after it, even if
  it arrives late. The refusal is silent to the person and the task keeps running.
- A6 Stop still wins: Stop remains final. Continue cannot revive a stopped or failed task.
- A7 One truth: only the shared automation task owns status and control ownership. The desktop
  screen never shows control it does not hold.

## How each rule is proved

- A1, A5: the shared input lease changes owner and its epoch number increases, so any older
  action is rejected. Prove with the automation task tests and a live take over during a click.
- A2: prove by eye on the running supervisor screen.
- A3: prove the task id and goal are unchanged after Continue.
- A4: prove the first thing after Continue is a new screenshot, not an action.
- A6: prove Continue after Stop is refused.

## Out of scope

Pause is a different choice: it parks the agent but does not hand input to the person. This flow
covers Take Over and Continue only.
