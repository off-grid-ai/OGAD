# Off Grid AI Desktop — Design

The desktop adaptation of the Off Grid design philosophy. The brand canon is the mobile docs (`../../mobile/docs/design/DESIGN_PHILOSOPHY_SYSTEM.md` + `VISUAL_HIERARCHY_STANDARD.md`); **this doc keeps the same soul and adapts it for a desktop app.** Where this conflicts with the mobile docs on _layout/interaction_, desktop wins; where it conflicts on _brand_ (font, color, voice), the brand wins.

---

## Soul (unchanged from mobile)

**Brutalist, minimal, terminal-inspired.** Functionality over decoration. Clarity, density, respect for attention. Silence over noise. Remove before adding.

- **Typeface: Menlo (monospace) everywhere.** No sans UI font, no mixed families.
- **Single accent: emerald** — `#34D399` (dark) / `#059669` (light). Used _sparingly_ — active states, focus, primary actions, links, success. Everything else is monochrome.
- **Base:** pure black `#0A0A0A` (dark) / white `#FFFFFF` (light). Three surface tiers: `background → surface → surfaceLight`.
- **Hierarchy through size + weight + opacity, never color.** Weights stay light (≤ medium); avoid bold for emphasis.
- **Flat & sharp:** 8px radius, hairline borders, no gradients, no heavy shadows, no emojis, no decorative animation.

---

## What changes for desktop

Desktop is a **wide, mouse-driven, multi-window** canvas. Adapt accordingly:

| Concern    | Mobile                             | **Desktop**                                                                                                               |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Canvas     | one narrow column, vertical scroll | **wide** — multi-column grids, master-detail, side panels, dense tables. Use the width; don't center a phone-width strip. |
| Navigation | bottom tabs                        | **persistent left icon-rail sidebar** (active = emerald).                                                                 |
| Pointer    | touch, ≥44px targets, `hitSlop`    | **mouse** — precise targets fine; **hover is a first-class state** (reveal actions, brighten borders/text on hover).      |
| Density    | compact                            | **denser still** — desktop shows more at once (5-col galleries, 3-col dashboards, long lists).                            |
| Input      | on-screen                          | **keyboard** — shortcuts (space/arrows in Replay, Cmd+[ / Cmd+] nav), Enter-to-submit.                                    |
| Chrome     | full-screen flows                  | **window + menu-bar tray** (pause/recalibrate), title is always "Off Grid AI Desktop".                                    |
| Detail     | push a screen                      | **detail screens / side panels** (e.g. click a connector row → its own detail view).                                      |

---

## Implementation (Tailwind, not RN)

Desktop is React + Tailwind v4. Use utility classes; tokens come from `@offgrid/design` / `main.css`. **Menlo = `font-mono`** (set globally). Prefer the exact emerald tokens; Tailwind `green-500/400` is an accepted stand-in already in the codebase.

```
Base        bg-neutral-950 (#0a0a0a)
Surface     bg-neutral-900/40–60 (cards, panels)
Surface+    bg-neutral-800 (badges, active pills, inputs)
Borders     border-neutral-800 (default) · border-neutral-700 (hover) · border-green-500 (focus/active)
Accent      text-green-500 / bg-green-500 (emerald) — sparingly
Text tiers  text-white → text-neutral-300 → text-neutral-500 → text-neutral-600
Radius      rounded-md (8px) default · rounded-full (pills/tabs/badges)
Font        font-mono everywhere
```

---

## Text hierarchy (5 categories, desktop sizes)

Same 5 roles as mobile, scaled for a monitor:

| Role             | Tailwind                                                                              | Use                                                    |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **TITLE**        | `text-lg tracking-tight text-white`                                                   | one per screen (page title)                            |
| **BODY**         | `text-sm text-neutral-200/300`                                                        | primary content, list items, inputs, buttons           |
| **SUBTITLE**     | `text-sm text-white` / section `<h2>`                                                 | section/card/modal titles                              |
| **DESCRIPTION**  | `text-xs text-neutral-500`                                                            | explanatory text under a title                         |
| **META / LABEL** | `text-[11px]` or `text-[10px]`, labels `uppercase tracking-wide text-neutral-500/600` | timestamps, counts, tags, section markers ("whispers") |

Rules: hierarchy from size+opacity (not color); section labels are tiny, **uppercase**, widely tracked, muted; metadata whispers.

---

## Components (desktop)

- **Sidebar** — left icon rail; active item emerald, hover brightens. Items: Day, Replay, Reflect, Entities, Projects, Actions, Integrations, Chat, Models, Settings.
- **Screen header** — title (TITLE) left, a tab toggle and/or action on the right, hairline `border-b border-neutral-900`, `px-6 py-4`.
- **Cards** — `rounded-md border border-neutral-800 bg-neutral-900/30–40 p-4–5`; hover `border-neutral-700`. No gradients/shadows.
- **Tabs / segmented control** — `rounded-full border border-neutral-800 p-0.5`; active pill `bg-neutral-800 text-green-500`.
- **Buttons** — primary: `bg-green-500 text-neutral-950 hover:bg-green-400`; secondary: `border border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500`; icon-only muted, brighten on hover.
- **Inputs** — `rounded-md border border-neutral-800 bg-neutral-950 text-neutral-200 focus:border-neutral-600`.
- **Lists / rows** — compact, clickable rows with a trailing chevron; hover brightens border; click → detail.
- **Badges/tags** — `rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400`; the entity/source chip uses emerald text.
- **Master-detail** — list/grid → click → dedicated detail view (with a "← back" link). Don't cram a detail into a row.
- **Empty states** — centered muted icon + one terse line.
- **Logos** — real brand marks (Simple Icons), shown bare (no tile/background behind them).

---

## Interaction

- **Hover reveals**: actions fade in (`opacity-0 group-hover:opacity-100`), borders/text brighten. This is the desktop affordance the mobile guide lacks.
- **Focus**: `focus:border-neutral-600` / emerald for active.
- **Loading**: small spinner (`IconLoader2 animate-spin`), muted text. No skeletons, no elaborate animation.
- **Destructive**: red only for delete (`hover:text-red-400`).
- **Live updates**: surfaces refresh on `crm:changed` (capture/sync) — keep old content visible while updating, don't blank-then-flash.

### Motion & micro-interactions (every interaction is smooth)

**Rule: nothing pops. Every state change animates.** Functional motion is required — this is separate from the "no _decorative_ animation" brand rule (no spinning logos, no ambient flourishes). A control that changes, a panel that appears, a value that updates should transition, not snap.

- **Every interactive control** gets `transition-all duration-150` (or `transition-colors`) + `active:scale-95` / `active:scale-[0.99]`. Hover, focus, press, and disabled states are all transitioned.
- **Panels, slide-overs, modals, dropdowns** enter and leave with a fade + slide/scale (120–200ms, ease-out in / ease-in out), never a hard mount/unmount. Prefer a mounted-flag or the library's state hook so exits animate too.
- **Respect `prefers-reduced-motion`** — the global block in `main.css` already neutralizes durations; don't fight it.
- **Gotcha — modals don't animate for free, and never animate `translate`.** The shared shadcn `Dialog` (`ui/dialog.tsx`) ships `animate-in` / `zoom-in-95` classes from **tailwindcss-animate, which this project does NOT include**, so those classes are no-ops. Dialog transitions come from the hand-written `[data-slot='dialog-*'][data-state]` keyframes in `main.css` (`og-dialog-in/out`, `og-overlay-in/out`). Those keyframes animate **only `transform: scale()` + `opacity`** — never `translate`: Tailwind v4 centers the dialog with the separate **`translate` CSS property** (`translate-x/y-[-50%]`), so a keyframe that also does `transform: translate(…)` stacks a second translate during the animation and the modal flies to the top-left then snaps back to center. Any new Radix overlay animates via the same `data-state` hook, scale+opacity only.

---

## Anti-patterns (same as mobile, plus desktop)

❌ Multiple accent colors · gradients · bold-for-emphasis · heavy borders/3D · mixed fonts · emojis in UI · color-coded status · decorative animation.
❌ **Desktop-specific:** centering a phone-width column on a wide screen · ignoring hover · touch-only patterns (oversized targets, no hover) · cramming everything inline instead of using detail panels.

---

## Checklist

- [ ] Menlo (`font-mono`) everywhere; weights light.
- [ ] Emerald is the _only_ accent, used sparingly; rest monochrome.
- [ ] Uses the full width — multi-column / master-detail where it helps.
- [ ] Hierarchy from size + opacity, not color; labels tiny/uppercase/muted.
- [ ] Hover states reveal/brighten; focus is emerald.
- [ ] Cards flat (border + transparent bg), 8px radius, no gradients/shadows.
- [ ] Real logos bare; no emojis.
- [ ] Title says/реflects "Off Grid AI Desktop".
