# Design brief - Off Grid AI proactive assistant demo

**For:** whoever is generating the design artifacts (Claude, or a designer).
**Deliverable:** high-fidelity mockups of the "ideal outcome" demo as an **interactive HTML artifact** (desktop), that **looks like the real Off Grid AI Desktop app** - same shell, same components, same feel. Real content throughout, never lorem. Five screens tied into one story (Section 6).
**Most important instruction:** match the actual app in Section 4. The app already exists; do not invent a new visual language. If a screen would not sit comfortably next to the real Models or Chat screen, it is wrong.
**Self-contained:** the app's look and tokens are inlined below; you do not need the repo.

---

## 1. What the product is

Off Grid AI Desktop is a **private, on-device assistant that notices what you need and acts on it.** It already watches your day locally (screen capture -> on-device OCR -> a private memory of what you saw and did). We are adding the ability to **act**. This demo shows that.

Four things make it different, and the design must make all four feel true:
1. **It knows you** - it acts on *your* context ("the deck I promised" resolves to the actual file from memory).
2. **It is proactive** - it surfaces the flight you have not checked in for, the promise you made, the routine you run every morning, before you ask.
3. **It is private** - everything runs on your Mac, nothing leaves the device. Reinforce it quietly (a small "on-device" cue), never a banner.
4. **It is one general engine, not a pile of features.** The flight nudge, the promised deck, a renewal, a reply you owe - all the *same* machinery. There is no "Flights" tab, no per-situation section. These are transient items the assistant generates, here when relevant, gone when handled.

The interaction principle to convey: **it routes to the cheapest reliable path and acts through the app and content you actually mean**, and **always shows what it will do before it does it.**

## 2. Who it is for and the tone

A sharp knowledge worker (beachhead: engineers) who lives in many apps. The feeling: **calm, dense, immediate, trustworthy** - a terminal/developer tool, not a friendly consumer chat app.

## 3. The look (from the real app - copy this exactly)

The app is **monospace, flat, outlined, and quietly technical.** It is NOT razor-sharp brutalism and it is NOT airy editorial SaaS - it sits between: flat surfaces with **1px borders and moderate corner radius (about 6-8px)**, **no drop shadows**, a very subtle **dotted-grid background texture**, and **Menlo monospace for every character on screen**.

- **Typeface:** **Menlo** (or `ui-monospace, "SF Mono", Menlo, monospace`) everywhere - labels, headings, body, numbers. Weights stay light-to-regular. Hierarchy from size, weight, spacing, uppercase - never a second font.
- **Uppercase, letter-spaced labels** for section headers, tabs, and status tags (e.g. `MODELS`, `AVAILABLE TO DOWNLOAD`, `TEXT` / `IMAGE` / `VOICE`, `VISION`). Body and buttons are normal case.
- **Accent: emerald, only emerald.** The single accent - active nav, the one primary action per screen, focus, links, success, status tags. Everything else is a monochrome gray hierarchy. Do not add a second accent or color-code categories.
- **Semantic colors exist only for their exact job:** a muted **amber** for a single caution label (the app uses it for a `CHALLENGER` tag), a **red** only for error/health ("Model stopped"). Used rarely.
- **Exact tokens (dark mode - the primary theme for the demo):** background `#0A0A0A`, surface `#141414`, surface-light `#1E1E1E`, surface-hover `#252525`, border `#1E1E1E`, border-light `#2A2A2A`, text near-white, muted text mid-gray, accent `#34D399`.
- **Exact tokens (light mode - also ship it):** background `#FFFFFF`, surface `#F5F5F5`, surface-light `#EBEBEB`, text `#0A0A0A`, border `#E5E5E5`, accent `#059669`.
- **Component vocabulary (reuse these shapes, do not invent new ones):**
  - **Outlined button** - 1px border, ~6px radius, icon + label, flat (the app's `Import .gguf`, `Download`, `+ New chat`, `Back`). Hover lightens the surface.
  - **Solid emerald button** - the one primary CTA per surface, emerald fill with dark text (the app's `Configure`). Circular emerald send button with an up-arrow in the composer.
  - **Outlined pill toggle** - small, rounded, icon + label, emerald when active (the composer's `All memory`, `Thinking`, `Image`).
  - **Status tag** - tiny uppercase, emerald 1px outline + emerald text + a small icon (the app's `VISION` tag). Use this shape for risk/confidence tags.
  - **Metadata line** - gray, dot-separated: `Qwen · 4B · 3.4GB · Mar 2026`.
  - **Bottom CTA card / toast** - a flat outlined card pinned near the bottom with an icon, a title + one gray subtitle line, a solid emerald action, and an X (the app's "Set up your local AI - Configure"). **This is the exact shape to reuse for a come-up and for a toast.**
- **Density:** comfortable-dense. Rows and cards have real breathing room (this is not a cramped table); 2-column card grids where it fits; sticky headers. Design at 1440px+ wide.
- **Motion:** restrained - 150ms transitions, slide+fade for panels, subtle active-press. Nothing pops in hard.

## 4. The actual app shell (render this frame around every screen)

**Left sidebar** (expanded, about 240-260px; the app can also collapse to an icon-only ~64px rail - show the expanded one):
- Top: the emerald chip logo + wordmark **`Off Grid AI`**, and a small panel-collapse icon.
- A full-width outlined **`< Back`** control.
- The nav list, each row = **monochrome icon + label**, generous row height: **Search, Day, Replay, Reflect, Meetings, Actions, Entities, Projects, Chat, Voice, Vault, Clipboard, Devices, Integrations, Models, Gateway.** For the demo, **add one new item after Actions: `Routines`.**
- **Active item styling (important):** emerald icon + emerald label + a subtle emerald-tinted row background + a thin emerald bar on the row's left edge. Inactive: gray icon, near-black/near-white label.
- A divider, then quiet utility rows: a health line with a red pulse icon (e.g. `Model running`), `Theme: System`, `Settings`, `Mobile app` (with an external-link glyph).

**Main area:** a header row with a small icon, a **title + one gray subtitle** (e.g. Chat shows `Off Grid AI` / `Private, on-device - chat, generate, and build`), and a cluster of square outlined icon-buttons top-right. Below it, the screen's content. A faint dotted-grid texture bleeds in at the top and bottom edges.

Every demo screen must sit inside this shell (sidebar + header), so it reads unmistakably as Off Grid AI.

## 5. Where the assistant lives (real nav, minimal additions)

- **Come-ups live in `Day`** - the ambient home. The proactive items surface as a **"Needs you" section pinned at the top of Day**, above the retrospective day timeline. Ephemeral rows, never tabs. Day *is* the assistant, forward-looking on top.
- **The gate lives inline + in `Actions`** - a come-up expands *in place* into the approval card (fast path); `Actions` (which already exists, with a checkbox icon) is the full queue and audit.
- **`Routines` is the one new tab** - the library of saved automations; recording opens as a modal from it.
- **When you are away:** a toast (the bottom-CTA-card shape) and a menu-bar count.

## 6. The five screens (one day, one story)

Each screen must be **self-understandable** - legible without a caption (the come-up says what it is; the card shows exactly what it will do). Keep the one-line "proves:" note as an annotation.

**Screen 1 - Day, with "Needs you" on top. Proves: proactive, knows you, one general engine.**
The hero, inside the real shell with **Day** active in the sidebar. Header: a calendar icon + `Day` + a gray subtitle + the date. The main column opens with an uppercase gray section label **`NEEDS YOU`**, then a short list of come-ups as flat outlined rows (reuse the bottom-CTA-card shape, one per row). Show a **mix of situations** so the generality is obvious:
- `You fly to SFO tonight, 21:40. Not checked in, no boarding pass found.` -> emerald `Check me in` + quiet `Later`.
- `You told Ali you'd send the Q3 deck by tonight.` with a gray context line `from your 10:15 call` -> `Send it` + `Later`.
- `getoffgridai.co renews tomorrow. The card on file expired.` -> `Update card` + `Dismiss`.
- A detected routine that already ran: `Morning brief - 09:02 · 12 unread, 3 need you` with a two-line synthesis from Mail and Slack.
Below `NEEDS YOU`, an uppercase `EARLIER TODAY` section with a dense retrospective timeline of what you did (a few rows), so it reads as an evolution of the existing Day view. Quiet "on-device" cue somewhere unobtrusive.

**Screen 2 - The approval card, expanded inline from a Day row. Proves: it acts on your real context, shows the evidence and its confidence, and you confirm before it acts.**
The single most important screen, and the one no competitor ships. The user hit `Send it`; the row **expands in place** into a flat outlined card. It shows the **resolved action, each slot with its evidence and a confidence tag** (not a vague action, and not just the value - the *proof* it picked right):
- Title line: **`Send Q3-strategy.pptx to Ali Chherawalla`**.
- **Resolved slots, each a row:** a label, the resolved value as an editable pill, a gray provenance line (the evidence), and a small confidence tag using the status-tag shape:
  - `File` -> `Q3-strategy.pptx` · gray: `you called it "the deck" in your 10:15 call · last edited 20m ago` · emerald tag `HIGH`.
  - `To` -> `Ali Chherawalla <ali@wednesday.is>` · gray: `the "Ali" you promised · only deck shared with him` · emerald tag `HIGH`.
  - `Via` -> `Mail` (the rail it will use).
- A risk tag near the actions in the status-tag shape but amber: `SEND · NEEDS APPROVAL`.
- Actions: solid emerald **`Approve and send`**, quiet outlined **`Edit`**, text **`Dismiss`**.
- Then show the **post-action toast** (bottom-CTA-card shape): `Sent to Ali - Q3-strategy.pptx`. (Annotate: the toast reflects the real send result, never a guess; the full queue lives in `Actions`.)
- **Also design the low-confidence variant of one slot** (a second small card state): instead of a pre-filled value, the slot becomes a picker - `Which deck did you mean?` with two candidate rows, each showing its own evidence (`Q3-strategy.pptx - shared with Ali, edited 20m ago` vs `Q3-final.pptx - edited last week`) and a select control. Low confidence disambiguates *before* the confirm, it never guesses.

**Screen 3 - The reasoned nudge in action (the flight). Proves: it notices what should happen and helps, handing off safely.**
The flight come-up expanded into a short flow. State one: `Check me in` / `Remind me at 20:00` / `Dismiss`. State two: it opened the airline check-in and filled the known fields (confirmation number, name from memory), then **handed off** at the identity/seat step - `Your turn - confirm your seat` (capture paused, shown as a small note). End state toast: `Boarding pass saved`.

**Screen 4 - Record a routine (modal from Routines). Proves: the user can author automations by demonstrating.**
A modal/slide-over in the app's style. State one - **recording:** a calm indicator (a thin emerald border around the app, or a small emerald status pill `Recording routine - do it once, I'll learn it`), NOT a big red dot. State two - **review the captured steps:** an editable list of semantic step cards in plain language (`Open Slack`, `Go to #standup`, `Post: Standup - {date}`), one step showing a **variable slot** as an emerald pill (`{date}`, or `the deck`) that resolves from memory each run. Controls to reorder/delete a step, an inline hint to mark a value as a variable, and a **trigger** row (`Manual` / `Schedule` / `When I ...`). Primary solid emerald `Save routine`.

**Screen 5 - Routines tab. Proves: detected and demonstrated routines live together on one spine.**
`Routines` active in the sidebar. Header: `Routines` + subtitle. A dense list/table: a mix of **detected** (`Morning brief`, auto-found) and **recorded** (`Standup note`, `Send weekly report`). Columns: name, trigger (`09:00 weekdays` / `manual` / `event`), last run, and a trust tag in the status-tag shape (`SUGGEST` / `AUTO`). A run control per row, an outlined `Record routine` button top-right, sticky header.

## 7. Copy voice (every string)

- **Lead with the outcome, in the user's language:** "Send the Q3 deck to Ali", not "Execute mail.send".
- Plain and direct; proof over adjectives.
- **No em dashes** (use " - "), no curly quotes, no exclamation marks, no emojis.
- Banned words: revolutionary, seamless, empower, leverage, robust, comprehensive, crucial, delve, tapestry, testament, foster, showcase, enhance; and AI-slop ("it's not X, it's Y", "serves as").
- A control says exactly what it does; the toast says it happened.
- Real names and content (Ali Chherawalla, `Q3-strategy.pptx`, SFO 21:40, getoffgridai.co).

## 8. Deliverable format

- **One interactive HTML artifact** rendering the real app shell (sidebar + header) with the five screens; the sidebar switches Day / Actions / Routines, numbered steps handle the flight/record sub-states and the low-confidence card variant. Self-contained (inline CSS, monospace stack, no external fonts/CDNs). Designed for 1440px+.
- **Dark mode primary (tokens above); include a working light-mode toggle.** Both properly styled.
- Each screen annotated with its "proves:" line, but the screen must read on its own without it.
- If one artifact is too much, deliver **Screen 1 (Day) and Screen 2 (approval card)** first - they carry the demo.

## 9. Do not

- **Do not invent a new app shell or visual language.** Match Section 4. No "Assistant" tab, no "Flights"/"Bills"/"Travel" tabs - come-ups are transient content in Day.
- **Do not over-round or over-soften into consumer SaaS** (big rounded cards, drop shadows, gradients, pastel fills) - the app is flat, outlined, ~6px radius, monospace.
- **Do not over-sharpen into hard brutalism either** (zero-radius, heavy black rules, cramped rows) - the real app is calmer than that. Match the screenshots' feel.
- Do not use a second accent or color-code categories; emerald only, amber/red only for caution/error.
- Do not use a non-monospace font anywhere.
- Do not design mobile-first; wide desktop only.
- Do not make the assistant a chat-bubble feed; it speaks through the Day rows and approval cards.
- Do not over-explain privacy with a banner; a quiet, constant cue.

The north star: **it looks like it shipped inside Off Grid AI** - monospace, flat, outlined, emerald-on-dark, dotted-grid - and every screen makes it obvious the assistant knows you, acts on your real context, shows the evidence and its confidence, and always confirms before it acts.
