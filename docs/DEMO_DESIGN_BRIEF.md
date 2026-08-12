# Design brief - Off Grid AI proactive assistant demo

**For:** whoever is generating the design artifacts (Claude, or a designer).
**Deliverable:** high-fidelity, on-brand screen mockups of the "ideal outcome" demo, as an **interactive HTML artifact** (desktop, dark mode primary). Real content throughout, never lorem. Five screens tied into one story (Section 5).
**This brief is self-contained** - the brand system is inlined in Section 3, so you do not need the repo. If you do have it, the source of truth is `off-grid-ai/brand` (`DESIGN_PHILOSOPHY.md`, `brand_tone_voice.md`) and `docs/DESIGN.md`.
**Grounding note:** these screens must fit the app we already have (Section 4). Do not invent a new app shell. Use the real left-rail navigation and put each piece where it actually lives.

---

## 1. What the product is

Off Grid AI Desktop is a **private, on-device assistant that notices what you need and acts on it.** It already watches your day locally (screen capture to on-device OCR to a private memory of what you saw and did). We are now adding the ability to **act**. The demo shows the ideal experience of that.

Four things make it different, and the design must make all four feel true:

1. **It knows you.** It acts on *your* context: "send the deck I promised" resolves to the actual file from your memory, not a generic search.
2. **It is proactive.** It surfaces the flight you have not checked in for, the promise you made, the routine you run every morning, before you ask.
3. **It is private.** Everything runs on your Mac. Nothing leaves the device. This is the reason a person would let it watch their day; the design reinforces it quietly (a small "on-device" cue, never a marketing banner).
4. **It is one general engine, not a pile of features.** The flight nudge, the promised deck, a renewal, a reply you owe - all the *same* machinery (notice a situation, infer what it needs, check the state, propose it). There is **no flight feature, no email feature, no bills feature.** So the design must never render a "Flights" tab or a per-situation section. These are transient items the assistant generates, here when relevant and gone when handled.

The one interaction principle to convey: **it routes to the cheapest reliable path and acts through the app and content you actually mean.** "Put on the show we were talking about, in the app you use" - not a robot clicking around.

## 2. Who it is for and the tone

A sharp knowledge worker (our beachhead is engineers) who lives in many apps and loses time to context-switching. The feeling: **calm, dense, immediate, trustworthy.** A terminal-brutalist tool, not a friendly consumer chat app. It earns trust by being clear, getting out of the way, and always showing what it is about to do before it does it.

## 3. The brand system (non-negotiable)

A specific, opinionated look. Do not substitute a generic "clean SaaS" style.

- **Aesthetic:** brutalist / terminal. Flat, sharp, dense. Every element earns its place. No decorative tiles, no 3D, no drop shadows for depth (use a tiered surface system instead), no gradients beyond the brand, **no emojis in the UI**, no rounded-card editorial look.
- **Typeface:** **Menlo** (monospace) everywhere. One family. Weights stay light (200-400). Hierarchy comes from size, weight, and spacing, never from mixing fonts. If Menlo is unavailable, use another monospace (`ui-monospace, "SF Mono", Menlo, monospace`).
- **Accent: emerald, and only emerald.** Dark `#34D399`, light `#059669`. The single accent - active nav, focus, the one primary action per screen, links, success. Everything else is a monochrome hierarchy. **No second accent**, do not color-code information; use position, size, weight. A destructive/error red exists only for that exact purpose, used sparingly.
- **Base:** dark background near-black `#0A0A0A`; light background clean white `#FFFFFF`. Depth from a small tiered surface system (background to surface to nested/input), high contrast both themes. Neutral grays with a very slight emerald bias so they read as chosen, not default.
- **Density:** desktop-first and dense. Multi-column where it fits, tight 4/8/12px spacing (not 16-24px editorial spacing), body ~12-14px, compact line-height, sticky headers/filters. A data-dense terminal app, not a card feed. Design at 1440px+ wide.
- **Motion:** restrained. 150ms transitions, slide+fade for panels/slide-overs, `active:scale` on buttons. Nothing pops in hard.
- **Design both dark and light**, dark primary. Do not naively invert; keep contrast and the accent working in both.

## 4. How it fits the app (where each piece lives)

The app has a **left-rail sidebar** (Menlo labels, an icon each, emerald when active). Real items include: **Day**, Replay, Reflect, Meetings, **Actions**, Entities, Projects, Chat, Integrations, Models, Gateway, Settings (bottom). Render a realistic version of this rail; you do not need every item, but use the real names and keep the terminal-dense feel. The assistant adds almost nothing to it:

- **Come-ups live in `Day`.** `Day` is the ambient home. The assistant's proactive items (nudges, suggestions, the morning brief) surface as a **"Needs you" section pinned at the top of Day**, above the retrospective day timeline. They are **ephemeral rows, never tabs** - here when relevant, gone when done. Do not add an "Assistant" tab; Day *is* the assistant, forward-looking on top, retrospective below.
- **The gate lives in `Actions`, and inline.** When a come-up needs a decision, the fast path is to **expand the row in place** into the approval card (you never leave Day). `Actions` (which already exists) is the full queue and audit of pending and past approvals.
- **`Routines` is the one new tab.** The only genuinely new nav item - a library of the automations you keep (detected + recorded). Recording a routine opens as a **modal / slide-over from Routines**, not a tab.
- **When you are away, it reaches you** via a **toast notification** (time-sensitive ones) and a small **menu-bar count** ("2 need you"). The menu-bar app already exists.

So the whole footprint is: **evolve `Day`, reuse `Actions`, add one `Routines` tab.** Keep it that lean in the mockups.

## 5. The demo story (a day in the life) and the five screens

Design these five screens as one narrative - a single day - so the team feels the loop. Annotate each with its one-line "proves:" caption.

**Screen 1 - Day, with "Needs you" on top. Proves: it is proactive, it knows you, and it is one general engine.**
The hero. The real left rail (Day active), and the main column led by a **"Needs you"** section - a dense, scannable list of come-ups, most urgent first. Show a **mix of different situations** so the generality is obvious at a glance (this is the point - not a flight app):
- **Reasoned nudge:** "You fly to SFO tonight, 21:40. Not checked in, no boarding pass found." - `Check me in` (emerald) / quiet `Later`.
- **Reasoned suggestion:** "You told Ali you'd send the Q3 deck by tonight." with a context line ("from your 10:15 call") - `Send it` / `Later`.
- **Another situation:** "Your getoffgridai.co domain renews tomorrow; the card on file expired." - `Update card` / `Dismiss`.
- **A detected routine that already ran:** "Morning brief - 09:02. 12 unread, 3 need you." with a two-line synthesis from Mail and Slack.
Each is a **tight row** (not a big rounded card), one emerald primary action and a quiet secondary. Below "Needs you", show the existing **day timeline** (a dense retrospective of what you did) so it reads as an evolution of Day, not a new screen. Include an unobtrusive "on-device" cue.

**Screen 2 - The approval card (inline expand of a Day row). Proves: it acts on your real context, and you confirm before it acts.**
The most important screen - the trust moment. The user hit `Send it` on the deck; the row **expands in place** into the approval card showing the **resolved** action:
- Title: **Send `Q3-strategy.pptx` to Ali Chherawalla**
- Resolution shown as evidence: "the deck" resolved to `Q3-strategy.pptx` (last edited 20m ago); "Ali" resolved to Ali Chherawalla (ali@wednesday.is). A small provenance line for *why* it picked them.
- The rail it will use ("via Mail") and a risk tag (a **send** is a gated action).
- Primary emerald **Approve and send**, quiet **Edit** (change the file/recipient), **Dismiss**.
One glance confirms both "it understood me" and "it is safe." Show the post-action toast: "Sent to Ali." (Note in an annotation that the full queue of these lives in the `Actions` tab.)

**Screen 3 - The reasoned nudge in action (the flight). Proves: it notices what should happen and helps, handing off safely.**
The flight come-up expanded into a short flow: state one, `Check me in` / `Remind me at 20:00` / `Dismiss`. State two: it opened the airline check-in, filled the known fields (confirmation number, name from memory), and **handed off at the identity/seat step** ("Your turn - confirm your seat") - the takeover pattern, capture paused, shown clearly. End state: "Boarding pass saved."

**Screen 4 - Record a routine (modal from Routines). Proves: the user can author their own automations by demonstrating.**
A slide-over/modal, two states:
- **Recording:** a calm indicator (a thin emerald border or a small status pill, NOT a big red dot): "Recording routine - do it once, I'll learn it."
- **Review the captured steps:** the demonstrated actions in plain language, editable: "Open Notion", "New page", "Type: Standup - {date}", "...". One step marked as a **variable slot** (`{date}`, or "the deck") filled from memory each run. Controls to reorder, delete, and set a **trigger** (Manual / Schedule / When I ...). Primary **Save routine**.

**Screen 5 - Routines tab. Proves: detected and demonstrated routines live together, on one spine.**
The one new nav item, active in the rail. A dense table: a mix of **detected** ("Morning brief", auto-found) and **recorded** ("Standup note", "Send weekly report"). Columns: name, trigger (09:00 weekdays / manual / event), last run, trust state (**Suggest** / **Auto**). A run button per row, a `Record routine` button top-right, sticky header.

## 6. Copy voice (every string in the mockups)

- **Lead with the outcome, in the user's language.** "Send the Q3 deck to Ali", not "Execute mail.send".
- Plain and direct. Proof over adjectives ("runs on your Mac, nothing leaves the device", not "we value privacy").
- **No em dashes** (use " - "), no curly quotes, no exclamation marks, no emojis.
- Banned words: revolutionary, seamless, empower, leverage, robust, comprehensive, crucial, delve, tapestry, testament, foster, showcase, enhance. And AI-slop phrasing ("it's not X, it's Y", "serves as").
- A control says exactly what it does; the toast says it happened ("Approve and send" then "Sent to Ali").
- Real names and content (Ali Chherawalla, `Q3-strategy.pptx`, SFO 21:40, getoffgridai.co) - it should feel like a real day.

## 7. Deliverable format

- **One interactive HTML artifact** with the five screens, navigable (the real left rail switches Day / Actions / Routines; numbered steps are fine for the flight/record sub-states). Self-contained (inline CSS, no external fonts/CDNs - use the monospace stack). Designed for 1440px+ desktop.
- **Dark mode primary; a light-mode toggle** if feasible, both properly styled.
- Each screen annotated with its "proves:" caption.
- If one artifact is too much, deliver **Screen 1 (Day) and Screen 2 (approval card)** first - those two carry the demo.

## 8. Do not

- Do not invent a new app shell or an "Assistant" tab. Come-ups live in **Day**; the gate in **Actions** + inline; the automations in **Routines**. Use the real left-rail names.
- **Do not create per-situation tabs or sections** (no "Flights", "Bills", "Travel"). Come-ups are transient content from one engine; Screen 1 shows a mix precisely to make that obvious.
- Do not design mobile-first or for narrow viewports. Wide desktop app.
- Do not use the generic AI-design defaults: rounded editorial cards with an accent bar, gradient hero, purple/blue, Inter/Space Grotesk, emoji markers, centered everything, drop-shadow depth.
- Do not add a second accent color or color-code categories.
- Do not make the assistant a chat-bubble feed. It speaks through tight rows and approval cards in a dense tool, not a conversation.
- Do not over-explain privacy with banners; a quiet, constant cue.

The north star: **calm, dense, terminal-brutalist, emerald-on-black; it fits the app we have (Day / Actions / Routines); and every screen makes it obvious the assistant knows you, acts on your real context, and always shows what it will do before it does it.**
