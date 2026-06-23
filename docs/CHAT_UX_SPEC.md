# Off Grid Desktop — Conversational UX Spec

> **This is one application of the app-wide design philosophy in
> `docs/DESIGN_PHILOSOPHY.md` (read that first — it is binding for the whole app).**
> This doc applies that philosophy to the chat/conversational surface specifically.

The north star for the chat surface. Decided 2026-06-23. Pairs with `docs/DESIGN.md` (brand).

## 1. Vision

**One conversation. The model orchestrates everything.** A person should be able to
just talk — and at the right moment the assistant answers in text, **generates an
image**, **builds an artifact** (web page, chart, diagram, SVG), or **asks a clarifying
question** — without the user ever choosing a "mode." It should feel like a real,
fluid conversation that happens to be multimodal. Breathtaking, smooth, effortless.

Three words that govern every decision: **Smooth. Easy. Inevitable.** (The right thing
appears at the right time, and nothing feels like a tool you have to operate.)

## 2. Principles

1. **No modes, no toggles.** One composer. The model decides the output type. The user
   never picks "ask vs image vs artifact."
2. **The model picks the modality at the right point.** It emits a typed block and the
   UI renders it seamlessly inline:
   - `\`\`\`image` → on-device generation, rendered as it completes
   - `\`\`\`html` / `\`\`\`svg` / `\`\`\`mermaid` → artifact in the side canvas
   - `\`\`\`ask` (JSON) → inline clickable multiple-choice
   - otherwise → streamed text
3. **Everything streams.** Text types in; images show a tasteful generating state then
   resolve; artifacts build live in the canvas. Never a frozen "thinking" wall.
4. **Easy by default.** Minimal chrome. Sensible defaults (no required settings to send).
   Advanced controls (image params, model picker) are tucked away, never in the way.
5. **Calm motion.** Animate only `transform`/`opacity`; honor `prefers-reduced-motion`.
   Micro 100–150ms · hover/spring 200–300ms · reveal 300–500ms. Motion clarifies, never
   decorates.
6. **Reuse, never build.** Every element comes from the approved libraries — see §5.

## 3. Anatomy

- **Shell:** icon rail · conversation list (search + Today/Yesterday/This week/Older) ·
  conversation pane · artifact side-panel (right ~44%, opens when an artifact exists).
- **Composer (one, unified):** auto-growing input; `+` menu (attach files, image options,
  project, tools); attachment chips (paste-large → "PASTED" chip; files → text/audio/video
  processed on-device); `/` slash-menu for skills; mic; circular ↑ send.
- **Message:** markdown; inline image; inline artifact "Open canvas" affordance; inline
  clarifying-question buttons; hover actions — **copy · resend (user) · regenerate ·
  speak (assistant)**.
- **Artifact canvas:** docked right panel, Preview / Code toggle, Download. Builds live.

## 4. The "right point" intelligence (how it stays smooth)

The system prompt teaches the model to choose the modality and emit the typed block; the
renderer detects it and renders the right surface with the right motion. The user types
one thing; the experience adapts. Clarifying questions are used **sparingly** — only when
a choice materially changes the answer — so the conversation never feels like a form.

## 5. Components & brand (binding)

- **Approved libraries ONLY** (no custom components): **shadcn/ui** (foundation),
  **Aceternity** (effects), **Magic UI** (text/buttons), **Motion Primitives** (transitions).
  Pull via `npx shadcn add` / `@aceternity` / `@magicui`; pick from
  `component-library-animations/skills/component-library-index.md`.
- **Brand stays Off Grid:** Menlo mono, emerald (`#34D399`/`#059669`), flat/brutalist,
  dense. shadcn semantic tokens are mapped to `--og-*` in `main.css @theme`, so library
  components inherit the brand with zero per-component styling.
- **Code standard (standards-kit):** cyclomatic complexity < 8; PascalCase UI/Types,
  camelCase logic; strict import order; no console.log / magic numbers / unused imports.

## 6. Definition of done (chat screen)

- [ ] One composer, no mode toggle; send works with text and/or attachments.
- [ ] Model generates images **and** artifacts **and** clarifying questions inline, chosen
      automatically, each rendered with calm motion.
- [ ] Responses **stream** (text, and artifacts build live in the canvas).
- [ ] Composer/messages/menus use approved-library components, themed to Off Grid.
- [ ] Conversation list searchable + grouped; artifact canvas docks right.
- [ ] Verified on screen (not just typecheck) — feels smooth, easy, breathtaking.
