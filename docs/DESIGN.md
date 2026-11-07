# Off Grid AI Desktop — Design

Read [`brand/DESIGN_PHILOSOPHY.md`](https://github.com/off-grid-ai/brand/blob/main/DESIGN_PHILOSOPHY.md) before any Desktop UI change.
It is the one design philosophy for every Off Grid AI surface: the disposition, type, accent,
depth, tokens, hierarchy, motion and the Desktop profile. When this document and brand disagree,
brand wins. This document gives only how Desktop builds that: implementation, layout and
interaction mechanics.

---

## What changes for desktop

Desktop is a wide, mouse-driven, multi-window canvas.

| Concern    | **Desktop**                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------- |
| Canvas     | Wide: multi-column grids, master-detail, side panels, dense tables. Use the width.          |
| Navigation | Persistent left icon rail; the active item glows emerald.                                   |
| Pointer    | Hover is first-class: surfaces catch the pointer's light, borders brighten, actions reveal. |
| Density    | Dense within groups, generous between them.                                                 |
| Input      | Keyboard shortcuts everywhere repeated (Cmd+K, Cmd+[ / ]), Enter to submit.                 |
| Chrome     | Window plus menu-bar tray; the title is always "Off Grid AI Desktop".                       |
| Detail     | Detail screens and side panels, never a detail crammed into a row.                          |

---

## Implementation

Desktop is React + Tailwind v4. The look comes from `@offgrid/operator-ui` in three layers,
wired once in the renderer (see the library's `docs/HOST_INTEGRATION.md`):

1. **Skin** — `@offgrid/operator-ui/ogad/skin.css` re-renders the existing utility vocabulary
   below. Write the classes as listed; the skin supplies the new look.
2. **Primitives** — `src/renderer/src/components/ui/*` re-export
   `@offgrid/operator-ui/ogad/ui/*`. Same APIs, premium visuals.
3. **Motion** — `@offgrid/operator-ui/alive.css` plus `AliveProvider` (and `LivingField` for the
   background) give every primitive and surface its reactions.

Tokens come from `@offgrid/design` (`../shared/packages/design`), the one source Desktop and
Mobile share.

```
Base        bg-neutral-950            translucent base over the living background
Surface     bg-neutral-900/40–60      glass layer, hairline edge, faint top highlight
Surface+    bg-neutral-800            active pills, badges, inputs (a slightly brighter layer)
Borders     border-neutral-800        hairline · hover border-neutral-700 · focus border-green-500 (glows)
Accent      text-green-500 / bg-green-500   emerald; bg fills glow
Text tiers  text-white → text-neutral-300 → text-neutral-500 → text-neutral-600
Radius      rounded-md · rounded-lg / rounded-2xl for cards · rounded-full pills
Font        body is Geist; `uppercase`, `tabular-nums`, code, kbd, pre and time are Geist Mono
Controls    32px default height, hairline borders
```

Never hard-code hex or shadows in components; the skin and tokens own them.

---

## Text hierarchy

| Role             | Tailwind                                                          | Use                               |
| ---------------- | ----------------------------------------------------------------- | --------------------------------- |
| **TITLE**        | `text-lg tracking-tight text-white` (large, light)                | one per screen                    |
| **BODY**         | `text-sm text-neutral-200/300`                                    | content, list items, controls     |
| **SUBTITLE**     | `text-sm text-white` / section `<h2>`                             | section, card and dialog titles   |
| **DESCRIPTION**  | `text-xs text-neutral-500`                                        | explanation under a title         |
| **META / LABEL** | `text-[10px]–[11px] uppercase tracking-wide text-neutral-500/600` | labels, counts, timestamps (mono) |

---

## Components

- **Sidebar** — left icon rail; the active item glows emerald, hover brightens.
- **Screen header** — title left; a segmented control or action right; hairline
  `border-b border-neutral-900`, `px-6 py-4`.
- **Cards** — `rounded-2xl border border-neutral-800 bg-neutral-900/40–60 p-5–6`; hover
  `border-neutral-700`. The skin lights and lifts them.
- **Segmented control** — `@offgrid/operator-ui/operator/segmented`, or
  `rounded-full border border-neutral-800 p-0.5` with an active pill; the highlight glides.
- **Icon buttons first** — any action with a clear glyph (stop, pause, continue, retry, copy,
  delete, edit, close, send, download, refresh, settings, add, more) is a `size="icon-*"` button
  with the label as `aria-label` and a tooltip. Words only when an icon would be ambiguous or for
  the screen's one primary call to action.
- **Buttons** — `ui/button` variants. Hand-built primary: `bg-green-500 text-neutral-950`;
  secondary: `border border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500`.
- **Inputs** — `rounded-md border border-neutral-800 bg-neutral-950 text-neutral-200`; focus glows.
- **Lists / rows** — thin rows (about 40–52px): title + meta inline, badges inline, a trailing icon action
  or chevron revealed on hover; click → detail. Never a tall card per item with a button row.
- **Badges** — `rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400`; active
  ones emerald.
- **Popups, menus, tooltips, dialogs** — the `ui/*` primitives: glass, spring in from their
  trigger, items cascade, exits animate.
- **Empty states** — one muted icon, one line, one action when useful.
- **Logos** — real brand marks, bare.

---

## Space and density

Use these rules across the product, including panels and settings:

- Put names on the left, short facts in aligned columns, and state and controls on the right.
  Use `ListRow` metadata and trailing slots. Use compact rows when the content fits on one line.
- Use the width before adding height. A short status belongs beside a name when there is room.
  Keep useful space between groups, but avoid large empty areas inside repeated rows.
- Keep labels readable. Let controls wrap when a panel is narrow; do not squeeze several cards
  side by side until their labels disappear. Use the available panel width, not only window width.
- Keep long descriptions and detail in the appropriate panel. Do not hide required facts just to
  make a row shorter. Preserve keyboard focus, clear actions, and loading and error states.
- Apply a repeated layout change in its shared component so each use has the same behavior.
  Keep its motion and reduced-motion support.

---

## Interaction mechanics

Motion rules and timings are brand's (Motion, and the Desktop profile). How Desktop wires them:

- **Pointer:** surfaces near the pointer catch its light; a press sends a soft wave through
  nearby surfaces. This is automatic once `AliveProvider` is mounted.
- **Hover:** reveal secondary actions with `opacity-0 group-hover:opacity-100`.
- **Focus:** the field's edge glows emerald; keyboard focus shows a soft ring.
- **Loading:** mark busy regions `aria-busy` or use the Button `loading` prop; the page's busy
  signal quickens the primary glow. Skeletons share one sweep. Keep old content visible while
  refreshing.
- **Results:** status lines use `role="status"`; when one changes it settles with a soft flash.
- **Easing:** use `--og-ease-out` and `--og-ease-spring`.
- **Reduced motion:** honoured by the library layers and by `main.css`.

---

## Desktop anti-patterns

A phone-width column on a wide screen · ignoring hover · cramming detail inline instead of using
panels. Brand lists the anti-patterns for every surface.

---

## Checklist

- [ ] Read brand's design philosophy for the change you are making.
- [ ] Uses the full width where it helps.
- [ ] Results in `role="status"`, loading in `aria-busy`.
- [ ] Primitives from `ui/*`; no hard-coded colours or shadows.
- [ ] Clear actions are icon buttons with an `aria-label` and tooltip, not text labels.
