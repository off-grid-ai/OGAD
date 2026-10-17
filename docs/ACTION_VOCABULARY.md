# OGAD Action Vocabulary (v0 draft)

One action language for `web_use` and `computer_use`. The actor model writes it. The harness runs it.

## Model

A computer has two inputs and two outputs.

| Direction | Channel | Model role |
|---|---|---|
| In | Keyboard | Actor writes key actions |
| In | Mouse | Actor writes pointer actions |
| Out | Screen | Screenshot + AX/Playwright labels go to actor and evaluator |
| Out | Audio | Short audio events go to actor and evaluator |

Layers:

1. **Primitives** — keyboard and mouse only. Work in every app on every OS.
2. **Macros** — common tasks built from primitives. The harness runs them faster and more safely.
3. **Waits and reads** — the harness checks them. No LLM call.
4. **User** — only the evaluator ends a task or hands it to the user.

The actor uses a macro when one fits. It uses primitives when none fits.

## Grammar

```
step    := name "(" args? ")"
args    := arg ( "," arg )*
arg     := target | string | int | key
string  := '"' ... '"'          (JSON string escapes)
```

- One action per step. One line. No other text.
- A wait is its own step. After a wait, the evaluator checks progress and the actor picks the next step (maybe another wait).
- Typical length: 5–15 tokens.

### Target `t`

| Form | Example | Use |
|---|---|---|
| Ref | `e42` | AX or Playwright element. **Preferred.** |
| Point | `@412,188` | Grid point, 0–1000 on each axis. Only when no ref exists. |
| Text | `"Sign in"` | Visible text. The harness resolves it to a ref. |

- Points use a 0–1000 grid, not real pixels. The harness maps grid to screen.
- The harness rejects refs that are not in the current snapshot.

### Keys

- Names: `enter` `tab` `esc` `backspace` `delete` `space` `up` `down` `left` `right` `home` `end` `pageup` `pagedown` `f1`–`f12`.
- Combos join with `+`: `cmd+c`, `ctrl+shift+t`, `alt+tab`.
- `cmd` maps to `ctrl` on Windows and Linux.

## 1. Primitives

### Mouse

| Call | Meaning |
|---|---|
| `move(t)` | Move pointer to t (hover) |
| `click(t)` | Left click |
| `dblclick(t)` | Double click |
| `tripleclick(t)` | Triple click (select line) |
| `rightclick(t)` | Right click |
| `middleclick(t)` | Middle click |
| `mousedown(t)` / `mouseup(t)` | Hold / release left button |
| `drag(t1,t2)` | Press at t1, move, release at t2 |
| `scroll(t,dx,dy)` | Wheel at t. Units: grid lines. `dy>0` = down |

### Keyboard

| Call | Meaning |
|---|---|
| `type("text")` | Type at the cursor. Keeps what is already there |
| `type(t,"text")` | Clear t, then write text in t |
| `press(key)` | Press and release one key or combo |
| `keydown(key)` / `keyup(key)` | Hold / release |

## 2. Macros

### Element

| Call | Built from | Meaning |
|---|---|---|
| `focus(t)` | click | Focus t |
| `clear(t)` | focus + select all + backspace | Empty t |
| `select(t,"option")` | click + choose | Choose a dropdown option |
| `check(t)` / `uncheck(t)` | click if needed | Set checkbox or toggle state |
| `set(t,"value")` | per control | Slider, date, color, range |
| `scroll_to(t)` | scroll | Bring t into view |
| `upload(t,"path")` | file chooser | Attach a file |

### Browser

| Call | Meaning |
|---|---|
| `goto("url")` | Open URL in the current tab |
| `back()` / `forward()` / `reload()` | History |
| `scroll_down()` / `scroll_up()` | Scroll the page by 80% of the window height. Web: `window.scrollBy` through `browser_evaluate` |
| `new_tab("url"?)` / `switch_tab(n)` / `close_tab()` | Tabs |
| `frame(t)` / `frame_top()` | Enter / leave iframe |
| `dialog("accept"\|"dismiss","text"?)` | Answer alert, confirm, prompt |

### App and window

| Call | Meaning |
|---|---|
| `open_app("name")` | Launch or bring to front |
| `focus_app("name")` | Bring to front |
| `close_app("name")` | Quit |
| `minimize()` / `maximize()` / `restore()` | Front window state |
| `switch_window("title")` | Front a window by title |
| `move_window(x,y)` / `resize_window(w,h)` | Grid units |

### Clipboard

| Call | Meaning |
|---|---|
| `copy()` / `cut()` / `paste()` | Same as `cmd+c` / `cmd+x` / `cmd+v` |
| `set_clipboard("text")` | Put text on clipboard |

## 3. Waits and reads

The harness runs these. No LLM call until the condition is met or the timeout ends.
Default timeout: 5000 ms. Last argument overrides it: `wait_appears(e9, 10000)`.

### Waits

| Call | Done when |
|---|---|
| `wait(ms)` | Time passed |
| `wait_appears(t)` | t is visible |
| `wait_gone(t)` | t is not visible |
| `wait_text("text")` | Text is on screen |
| `wait_url("part")` | URL contains part |
| `wait_enabled(t)` | t accepts input |
| `wait_idle()` | Screen and network stop changing |
| `wait_window("title")` | Window exists |
| `wait_file("path")` | File exists (downloads) |
| `wait_sound("event")` | Audio event heard |

### Reads

| Call | Returns |
|---|---|
| `find("text")` | Up to 8 lines of the full snapshot that contain the text (contract v1, see below) |
| `read(t)` | Text or value of t |
| `read_table(t)` | Rows of a table or list |
| `exists(t)` | true / false |

## 4. User

The actor never ends a task and never hands over. The evaluator does both: `success`, `fail`,
`takeover` (see [MODEL_CONTRACT.md](MODEL_CONTRACT.md)). The user can take over at any time.

## Results back to the model

The harness returns one line per step to the history:

```
ok
ok wait_appears 820ms
timeout wait_appears "Results" 5000ms
error stale_ref e42
error blocked sensitive_field
```

The next step must react to `timeout` and `error`.

### `find("text")` (contract v1)

Under contract v1 the actor sees only what is on screen (see MODEL_CONTRACT.md, "On-screen AX").
`find` searches the full snapshot. No page action. The harness:

- matches every snapshot line that contains the text, case-insensitive (the accessible name is part of the line);
- reports a line without a ref by its nearest ancestor with a ref, once per ref;
- lists controls first, then other lines, each in page order; at most 8;
- writes `<ref> <role> "<name>"` per match, names cut at 60 characters.

```
find("Order now") -> 2 matches: e275 button "Order Now"; e301 link "Order now"
find("Gift card") -> 11 matches (first 8): e12 link "Gift cards"; …
find("Zzz") -> 0 matches
```

The refs in a find result are valid targets for the next actions, also when the on-screen AX
does not show them, until an action other than `find` runs. The generator writes a `find` step
when the correct target is not on screen and a find on its name returns it; otherwise it writes
`scroll_down()` or `scroll_up()` toward it. Pure function: `findResult` in
`scripts/action-data/contract.mjs`.

## Audio events

The harness turns system audio into short events. Examples:

`sound:notification` `sound:error` `sound:complete` `speech:"your meeting is starting"`

## Not in the vocabulary

- Script-made DOM events (`dispatchEvent`). Many sites ignore them. Use real input.
- Shell commands. Out of scope for the actor.
- Lock, log out, shut down, change system or security settings.

## Map from current OGAD actions

### Web (`SemanticDecision` in `src/main/browser/browser-playwright-policy.ts`)

| Current | New |
|---|---|
| `click` + ref | `click(e42)` |
| `type` + ref + text | `type(e42,"text")` |
| `press_key` + key | `press(enter)` |
| `select_option` + ref + values | `select(e42,"value")` |
| `hover` + ref | `move(e42)` |
| `drag` + start_ref + end_ref | `drag(e1,e2)` |
| `navigate` + url | `goto("url")` |
| `done` + evidence_text | Evaluator `success("answer")` |
| `human_required` | Evaluator `takeover("why")` |
| `fallback` | Removed. The harness picks vision when no ref exists |

### Desktop (`VisionAction` in `src/main/vision/vision-action.ts`)

| Current | New |
|---|---|
| `click` / `double_click` / `right_click` / `middle_click` / `triple_click` | `click` / `dblclick` / `rightclick` / `middleclick` / `tripleclick` |
| `mouse_move` | `move(t)` |
| `drag` / `drag_to` | `drag(t1,t2)` |
| `type` | `type("text")` |
| `hotkey` / `press` | `press(key)` |
| `key_down` / `key_up` | `keydown` / `keyup` |
| `scroll` / `scroll_by` | `scroll(t,dx,dy)` |
| `navigate` | `goto("url")` |
| `wait` | `wait(ms)` |
| `finished` | Evaluator `success("answer")` |
| `call_user` | Evaluator `takeover("why")` |

### New, with no current action

`type(t,"text")` `clear` `check` `uncheck` `set` `scroll_to` `scroll_down` `scroll_up` `upload` `back` `forward` `reload` tabs `frame` `dialog` `open_app` `focus_app` `close_app` window calls clipboard calls all `wait_*` `read*` `exists` audio events.

## Decisions (v0)

1. The actor writes no `phase_id`. The actor gives the action. The harness and evaluator track the plan.
2. One action per step. No chained waits.
3. One `type` name. With a target it replaces the value. Without a target it types at the cursor.
4. History lines are `<step> -> <result>`, for example `type(e4,"Asha Rao") -> the page changed`.
