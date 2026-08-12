# Design brief - Off Grid AI proactive assistant demo

**For:** whoever is generating the design artifacts (Claude, or a designer).
**Deliverable:** high-fidelity, on-brand screen mockups of the "ideal outcome" demo, as an **interactive HTML artifact** (desktop, dark mode primary). Real content throughout, never lorem. Five screens tied into one story (Section 4).
**This brief is self-contained** - the brand system is inlined in Section 3, so you do not need the repo. If you do have it, the source of truth is `off-grid-ai/brand` (`DESIGN_PHILOSOPHY.md`, `brand_tone_voice.md`) and `docs/DESIGN.md`.

---

## 1. What the product is

Off Grid AI Desktop is a **private, on-device assistant that notices what you need and acts on it.** It already watches your day locally (screen capture to on-device OCR to a private memory of what you saw and did). We are now adding the ability to **act**. The demo shows the ideal experience of that.

Three things make it different, and the design must make all three feel true:

1. **It knows you.** It acts on *your* context: "send the deck I promised" resolves to the actual file from your memory, not a generic search.
2. **It is proactive.** It surfaces the flight you have not checked in for, the promise you made, the routine you run every morning, before you ask.
3. **It is private.** Everything runs on your Mac. Nothing leaves the device. This is the reason a person would let it watch their day, and the design should quietly reinforce it (a small "on-device" / "private" cue, never a marketing banner).

The one interaction principle to convey: **it routes to the cheapest reliable path and acts through the app and content you actually mean.** "Put on the show we were talking about, in the app you use" - not a robot clicking around.

## 2. Who it is for and the tone

A sharp knowledge worker (our beachhead is engineers) who lives in many apps and loses time to context-switching. The feeling: **calm, dense, immediate, trustworthy.** It is a terminal-brutalist tool, not a friendly consumer chat app. It earns trust by being clear and getting out of the way, and by always showing what it is about to do before it does it.

## 3. The brand system (non-negotiable)

This is a specific, opinionated look. Do not substitute a generic "clean SaaS" style.

- **Aesthetic:** brutalist / terminal. Flat, sharp, dense. Every element earns its place. No decorative tiles, no 3D, no drop shadows for depth (use a tiered surface system instead), no gradients beyond the brand, **no emojis in the UI**, no rounded-card editorial look.
- **Typeface:** **Menlo** (monospace) everywhere. One family. Weights stay light (200-400). Hierarchy comes from size, weight, and spacing, never from mixing fonts. If Menlo is unavailable in the artifact, use another monospace (e.g. `ui-monospace, "SF Mono", Menlo, monospace`).
- **Accent: emerald, and only emerald.** Dark mode `#34D399`, light mode `#059669`. The single accent - active states, focus, the one primary action per screen, links, success. Everything else is a monochrome hierarchy. **Do not introduce a second accent** and do not color-code information; use position, size, and weight. Semantic colors exist only for their exact purpose (a destructive/error red, used sparingly).
- **Base:** dark mode background near-black `#0A0A0A`; light mode clean white `#FFFFFF`. Build depth with a small tiered surface system (background to surface to nested/input), high contrast in both themes. Neutral grays for surfaces, borders, and text tiers - pick grays with a very slight emerald bias so they read as chosen, not default.
- **Density:** desktop-first and dense. Multi-column where it fits, tight 4/8/12px spacing (not 16-24px editorial spacing), body text ~12-14px, compact line-height, sticky headers/filters. This is a data-dense terminal app, not a spacious card feed. Design at 1440px+ wide.
- **Motion:** restrained. State changes animate (150ms transitions, slide+fade for panels, `active:scale` on buttons). Nothing pops in hard. Motion and restraint do the work gradients usually do elsewhere.
- **Design both dark and light**, dark primary. Do not naively invert; keep contrast and the accent working in both.

## 4. The demo story (a day in the life) and the five screens

Design these five screens. They form one narrative - a single day - so the team feels the whole loop. Annotate each with a one-line caption of what it proves.

**Screen 1 - The assistant surface (home). Proves: it is proactive and knows you.**
The main view. A dense, scannable list of what needs the user, most important first. Include, as real content:
- A **morning brief** that already ran (a detected routine): "Morning brief - 9:02. 12 unread, 3 need you." with a two-line synthesis pulling from Mail and Slack.
- A **reasoned suggestion**: "You told Ali you'd send the Q3 deck by tonight." with a subtle context line ("mentioned in your 10:15 call").
- A **reasoned nudge**: "You fly to SFO tonight, 21:40. Not checked in yet."
Each item is a tight row (not a big rounded card), with a primary action in emerald and a quiet secondary. A left rail or top bar for navigation (Assistant / Routines / Memory / Connectors / Settings), Menlo throughout, an unobtrusive "on-device" indicator. This is the hero screen.

**Screen 2 - The approval card with resolved values. Proves: it acts on your real context, and you confirm before it acts.**
The single most important screen - the trust moment. The user tapped "send the deck." The card shows the **resolved** action, not a vague one:
- Title: **Send `Q3-strategy.pptx` to Ali Chherawalla**
- The resolution shown as evidence: "the deck" resolved to `Q3-strategy.pptx` (last edited 20m ago); "Ali" resolved to Ali Chherawalla (ali@wednesday.is). Show *why* it picked them (a small provenance line).
- The rail it will use ("via Mail"), and a risk tag (this is a **send** - a gated action).
- Primary emerald **Approve and send**, a quiet **Edit** (to change the resolved file/recipient), and **Dismiss**.
Design it so one glance confirms both "it understood me" and "it is safe." This is where private + proactive + accurate all pay off.

**Screen 3 - The reasoned nudge in action (the flight). Proves: it notices what should happen and helps.**
The flight nudge expanded into a small flow: "You fly to SFO tonight, 21:40. No boarding pass found, not checked in." with **Check me in** (emerald), **Remind me at 8pm**, **Dismiss**. Then a second state: it opened the airline check-in, filled the known fields (confirmation number, name from memory), and **handed off at the identity/seat step** ("Your turn - confirm your seat") - the takeover pattern, capture paused, shown clearly. End state: "Boarding pass saved."

**Screen 4 - Record a routine (teach by showing). Proves: the user can author their own automations by demonstrating.**
Two states side by side or as a short flow:
- **Recording:** a clear, calm recording indicator (a thin emerald border or a small status pill - NOT a big red dot), "Recording routine - do it once, I'll learn it."
- **Review the captured steps:** the demonstrated actions in plain language, as an editable list: "Open Notion", "New page", "Type: Standup - {date}", "..." One step is marked as a **variable slot** ({date}, or "the deck") that will be filled from memory each run. Controls to reorder, delete, and set a **trigger** (Manual / Schedule / When I ...). A primary **Save routine**.

**Screen 5 - Routines library. Proves: detected and demonstrated routines live together, on one spine.**
A dense table/list of routines: a mix of **detected** ("Morning brief", auto-found) and **recorded** ("Standup note", "Send weekly report"). Columns: name, trigger (9:00 weekdays / manual / event), last run, and a trust state (**Suggest** / **Auto**). A run button per row. Sticky header. This is the "it is a platform that accretes capabilities" screen.

## 5. Copy voice (applies to every string in the mockups)

- **Lead with the outcome, in the user's language.** "Send the Q3 deck to Ali" not "Execute mail.send action".
- Plain and direct. Proof over adjectives ("runs on your Mac, nothing leaves the device", not "we value privacy").
- **No em dashes** (use " - "), no curly quotes, no exclamation marks, no emojis.
- Banned words: revolutionary, seamless, empower, leverage, robust, comprehensive, crucial, delve, tapestry, testament, foster, showcase, enhance. And AI-slop phrasing ("it's not X, it's Y", "serves as").
- A control says exactly what it does; the toast after says it happened ("Approve and send" then "Sent to Ali").
- Real names and content (Ali Chherawalla, `Q3-strategy.pptx`, SFO 21:40) - it should feel like a real day.

## 6. Deliverable format

- **One interactive HTML artifact** containing the five screens, navigable (a simple top nav or numbered steps to move between them). Self-contained (inline CSS, no external fonts/CDNs - use the monospace stack above). Responsive down gracefully but designed for 1440px+ desktop.
- **Dark mode primary; include a light-mode toggle** if feasible, both properly styled.
- Each screen annotated with its one-line "proves:" caption so the team reads the story.
- If a single artifact is too much, deliver Screen 1 (home) and Screen 2 (approval card) first - those two carry the demo.

## 7. Do not

- Do not design mobile-first or for narrow viewports. This is a wide desktop app.
- Do not use the generic AI-design defaults: rounded editorial cards with an accent bar, gradient hero, purple/blue, Inter/Space Grotesk, emoji section markers, everything centered, drop-shadow depth. Those read as templated and off-brand.
- Do not add a second accent color or color-code categories.
- Do not invent a friendly mascot or conversational chat-bubble UI as the primary surface - this is a dense tool, and the assistant speaks through tight rows and approval cards, not a chat feed.
- Do not over-explain privacy with banners; show it as a quiet, constant cue.

The north star for the whole artifact: **calm, dense, terminal-brutalist, emerald-on-black, and every screen makes it obvious the assistant knows you, acts on your real context, and always shows what it will do before it does it.**
