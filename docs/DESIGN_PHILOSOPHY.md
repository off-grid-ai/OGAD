# Off Grid AI Desktop — Design Philosophy (whole app)

The binding design philosophy for **every screen** of Off Grid AI Desktop — chat, Day,
Replay, Reflect, Actions, Connectors, Meetings, Models, Entities, Settings, Onboarding,
and everything built hereafter. Decided 2026-06-23. Pairs with `docs/DESIGN.md` (brand
canon) and the memory `ui-component-standard`.

> This is not a chat-only spec. It governs the entire application. New surfaces and
> refactors of existing ones must follow it.

## 1. North star

**Smooth. Easy. Inevitable.** Every surface should feel effortless and alive — the right
thing appears at the right moment, nothing feels like a tool you must operate. The product
should feel breathtaking through restraint and motion, not clutter. It is private,
on-device, and fast — the UI should feel that way too: calm, dense, immediate.

## 2. Components — reuse, never build (binding)

- **Use ONLY the approved libraries.** No custom UI components, anywhere:
  - **shadcn/ui** — foundation (buttons, inputs, dialogs, menus, tabs, tooltips, …)
  - **Aceternity UI** — high-end effects
  - **Magic UI** — text & button animations
  - **Motion Primitives** — advanced transitions
- **Pull, don't write:** `npx shadcn add <name>` / `@aceternity/<name>` / `@magicui/<name>`.
  Choose from the catalog index `component-library-animations/skills/component-library-index.md`
  (the repo's component files are demo stubs — pull the real one from the registry).
- `components.json` is configured with the `@aceternity` + `@magicui` registries + shadcn.

## 3. Brand — Off Grid identity (binding)

- **Typeface:** Menlo (monospace), everywhere. Terminal/brutalist.
- **Accent:** emerald — `#34D399` (dark) / `#059669` (light). The only accent.
- **Base:** black / `#0A0A0A` + white; neutral grays. Flat, sharp, dense. No gradients
  beyond brand, no decorative tiles, no emojis in UI.
- **Theme-aware tokens:** shadcn semantic tokens (`--color-primary`, `--muted`, `--border`,
  `--ring`, …) are mapped to the `--og-*` tokens in `src/renderer/src/assets/main.css`
  `@theme`. Result: any approved-library component inherits the brand with **zero
  per-component styling**, and flips light/dark automatically. Always rely on this mapping
  rather than hardcoding colors.

## 4. Motion (binding)

- Animate **only** `transform` and `opacity`. Never layout-thrashing properties.
- Timings: micro 100–150ms · hover/spring 200–300ms · reveal 300–500ms.
- Always honor `prefers-reduced-motion`.
- Motion clarifies state and guides attention — it never decorates.

## 5. Interaction principles (app-wide)

- **No needless modes/toggles.** Infer intent; expose advanced controls only when wanted,
  tucked away.
- **Stream everything** that takes time; never a frozen "thinking" wall — use tasteful
  in-progress states (skeletons, shimmer, progress).
- **Sensible defaults.** Nothing should require configuration before it works.
- **Desktop-first density.** Multi-column, side panels, hover affordances, dense lists —
  never mobile-first.

## 6. Code standard (standards-kit, binding)

- Cyclomatic complexity **< 8**.
- **PascalCase** for UI/Types, **camelCase** for logic.
- Strict import ordering; no `console.log`, magic numbers, or unused imports.
- Accessibility: `aria-label` on icon buttons, `alt` on images, 4.5:1 contrast.

## 7. Applications of this philosophy

- **Chat / conversational surface:** `docs/CHAT_UX_SPEC.md` — one conversation where the
  model generates images, artifacts, and clarifying questions inline at the right point.
- **Every other screen:** the **UI standardization audit** in `ROADMAP_DESKTOP.md` tracks
  bringing the whole app to this philosophy, screen by screen.
