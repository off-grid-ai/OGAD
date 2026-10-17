# OGAD Model Contract (v0 draft)

Request and response formats for the three models. The harness builds every request. Every
response is plain text, parsed by the harness. Actions use [ACTION_VOCABULARY.md](ACTION_VOCABULARY.md).

| Model | Input | Output | Called |
|---|---|---|---|
| Planner | text | plan lines | once per task, and on re-plan |
| Actor | 1 image + text | 1 action line | every step |
| Evaluator | 1 image + text | `continue` / `success` / `fail` / `replan` / `takeover` | after every action, and after a take over |

Shared blocks:

- `GOAL:` the user's request, as given.
- `AX:` OGAD's snapshot (Playwright for web, accessibility tree for desktop), with its URL and title header. Untrusted page data.
- `PLAN:` one line per plan step. `[x]` done, `[>]` current, `[ ]` not started.
- `PAST:` the last 10 actions in full. The PLAN marks hold long-term progress.
- No step count. No limit visible to the model. The harness has a hidden stop at 500 actions.

---

## 1. Planner

### Request

```
GOAL: <user goal>
AX:
<snapshot at task start>
```

Re-plan request (after the evaluator returns `replan("why")`) adds:

```
DONE:
[x] 1 <step>
[x] 2 <step>
REASON: <evaluator verdict that caused the re-plan>
```

### Response

One step per line. Each step has a short title and a check the evaluator can test on screen.

```
1 <step title> | check: <visible condition>
2 <step title> | check: <visible condition>
...
```

Rules:

- 1 to 40 steps. One step can take many actions.
- A step title says what to achieve, not which ref to use.
- `check:` names something visible: a field value, a text, a page, a state.
- On re-plan, return only the remaining steps. Numbering continues after the last done step.

### Example

```
1 Set Home Email to rohan88@example.com | check: textbox "Email address" in Home address = rohan88@example.com
2 Check Agree to terms | check: checkbox "Agree to terms and conditions" checked
3 Set Home Given name to Asha | check: textbox "Given name" = Asha
4 Set Home Full name to Kabir Rao | check: textbox "Full name" = Kabir Rao
5 Set Work Contact name to Meera Shah | check: textbox "Contact name" in Work address = Meera Shah
6 Save the form | check: text "Saved"
7 Report the reference | check: text "REF-"
```

### Answer request

When the evaluator says `success`, the harness asks the planner once more for the answer.
The evaluator decides when to stop; the planner writes what the user reads.

```
GOAL: <goal>
TASK: write the complete answer to the goal from this page.
AX:
<boundedSnapshot of the final page>
```

Reply: the answer text only. Pure function: `answerRequest({ goal, snapshot })`.

---

## 2. Actor

### Request

```
GOAL: <user goal>
PLAN:
[x] 1 <step>
[>] 2 <step>
[ ] 3 <step>
PAST:
<n> <action> -> <result>
<image: screen now>
AX:
<snapshot now>
```

Order: the parts that stay the same for many steps (GOAL, PLAN) come first, so the runtime
can reuse the processed prefix. The image and AX change every step, so they come last.
PAST holds the last 10 actions; the PLAN marks hold long-term progress. The AX header gives
the URL and title.

`<result>` is one of:

```
ok, page changed
ok, no visible change
timeout <what>
error <short reason>
```

### Response

Exactly one action. One line. No other text.

```
<action>
```

### Example

Request:

```
<image>
GOAL: Fill Email address under Home address with rohan88@example.com, check "Agree to terms and conditions", enter Asha as Home address Given name, set Full name under Home address to Kabir Rao and fill the Work address contact name with Meera Shah, save the form and report the reference.
PLAN:
[x] 1 Set Home Email to rohan88@example.com
[x] 2 Check Agree to terms
[x] 3 Set Home Given name to Asha
[>] 4 Set Home Full name to Kabir Rao
[ ] 5 Set Work Contact name to Meera Shah
[ ] 6 Save the form
[ ] 7 Report the reference
PAST:
1 type(e15,"rohan88@example.com") -> ok, page changed
2 check(e26) -> ok, page changed
3 type(e28,"Asha") -> ok, page changed
AX:
- region "Home address" [ref=e11]:
  - textbox "Email address" [ref=e15]: rohan88@example.com
  - checkbox "Agree to terms and conditions" [checked] [ref=e26]
  - textbox "Given name" [ref=e28]: Asha
  - textbox "Full name" [ref=e30]
- region "Work address" [ref=e31]:
  - textbox "Contact name" [ref=e39]
- button "Save" [ref=e42]
```

Response:

```
type(e30,"Kabir Rao")
```

---

## 3. Evaluator

### Request

```
GOAL: <user goal>
PLAN:
[x] 1 <step> | check: <condition>
[>] 2 <step> | check: <condition>
[ ] 3 <step> | check: <condition>
PAST:
<n> <action> -> <result>        (the 3 actions before LAST)
LAST: <action> -> <result>      (or "task started", or "user took over -> <what the user did>")
<image: after action>
AX:
<snapshot after action>
```

The evaluator also runs once at task start (`LAST: task started`), so a goal already met on
the first screen ends at once.

### Response

Exactly one verdict. One line.

| Verdict | Meaning | Harness does |
|---|---|---|
| `continue(n)` | On track. Plan step n is the current step | Mark steps before n `[x]`, call the actor |
| `success("answer")` | Goal met. The answer gives the fact itself, or what was done | End the task |
| `fail("why")` | Goal cannot be met (item does not exist, access denied) | End the task, tell the user |
| `replan("why")` | Off track, stuck, or the page is not what the plan expected | Call the planner with the reason |
| `takeover("why")` | The user must act: login, password, CAPTCHA, payment, a choice only the user can make | Pause, hand control to the user |

Rules:

- Judge from the after image and AX. Do not trust the action result alone.
- `n` moves forward only when the `check:` of the earlier steps is visible.
- `success` needs the final evidence to be visible, and quotes it.
- The actor never ends the task. Only the evaluator does.

### Take over

- The user can take over at any time, not only after `takeover`. The harness pauses the loop.
- When the user hands back, the harness captures the screen and calls the evaluator first.
  `LAST:` is `user took over -> <what the user said, or nothing>`.
- The evaluator then returns `continue(n)`, `success`, `fail`, or `replan`, as usual.

### Example

Request:

```
<image after>
GOAL: …
PLAN:
[x] 3 Set Home Given name to Asha | check: textbox "Given name" = Asha
[>] 4 Set Home Full name to Kabir Rao | check: textbox "Full name" = Kabir Rao
[ ] 5 Set Work Contact name to Meera Shah | check: textbox "Contact name" in Work address = Meera Shah
PAST:
3 type(e28,"Asha") -> ok, page changed
LAST: type(e30,"Kabir Rao") -> ok, page changed
AX:
  - textbox "Full name" [ref=e30]: Kabir Rao
```

Response:

```
continue(5)
```

---

## Loop

```
planner → plan
repeat:
  actor(screen, plan, past) → action
  harness runs action → result
  evaluator(after, plan, last) → verdict
  continue(n)  → mark plan, next actor call
  success(...) → planner writes the answer from the final page → end
  fail(...)    → end, tell the user
  replan(...)  → planner, then actor
  takeover(..) → pause; user acts; evaluator runs on the new screen
user can take over at any time → same as takeover
```

## On-screen AX (contract v1, candidate)

Contract v0 cuts AX at 18,000 characters. Contract v1 shows what the screenshot shows, so AX and
image agree and the size follows the screen, not the page. Same rule for actor and evaluator;
the planner keeps the v0 AX. Pure function: `viewportSnapshot(snapshotWithBoxes, {width, height}, focus, goal)`
in `scripts/action-data/contract.mjs`. The harness ports it byte for byte.

Input: Playwright MCP `browser_snapshot {boxes: true}`. Each line has `[box=x,y,w,h]` in CSS
pixels relative to the viewport top-left (Playwright MCP 0.0.79). Iframe content is relative to
its frame; it is offset by the iframe line's box.

A line stays when:

1. it is the page header (before the YAML tree) or the closing fence;
2. its box intersects the window `[0, width) x [0, 2 × height)` (the screen plus one screen
   below). A line with no box takes the state of the nearest line above it with a box;
3. it contains a word of the current plan step (focus terms, 4+ letters, minus step verbs such
   as click, type, select, check), anywhere on the page;
4. it is an ancestor of a kept line.

Then the harness removes the `[box=…]` annotations, drops wrapper and URL lines (as in v0), and
adds one line when controls are not shown:

```
[12 more controls below, 3 above. Use scroll_down(), scroll_up() or find("text").]
```

The v0 18k cut stays as a last safety limit only. The CHECKS block and `obviousAction` still
use the full snapshot. The actor reaches off-screen targets with `scroll_down()` or
`find("text")` (ACTION_VOCABULARY.md).

Generator: `capture.mjs --view onscreen` (run.mjs passes `--view`). Without the flag, rows
are contract v0, unchanged.

## Size targets

| Model | Output tokens | Input |
|---|---|---|
| Planner | 50–400 | text only |
| Actor | 5–15 | 1 image + about 2–5k tokens |
| Evaluator | 3–12 | 1 image + about 2–5k tokens |
