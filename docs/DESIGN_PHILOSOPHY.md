# Off Grid — Design Philosophy (shared source of truth)

This is the **canonical, cross-platform design philosophy** for Off Grid. Every surface — Off
Grid Desktop, Off Grid Mobile, the Console, the website, and every landing page — inherits from
here. When a platform doc and this doc disagree on a shared principle, this doc wins; platform
docs own only the platform-specific mechanics (component libraries, token accessors, layout
density) and link back here.

Read this before designing or reviewing any Off Grid surface. It pairs with the copy guides in
this folder (`README.md`, `brand_tone_voice.md`) — the look and the words carry the same
disposition: give the user something clean and honest, show the mechanism, never decorate to
impress.

---

## The disposition

The interface is quiet on purpose. It is private, on-device, and fast — and it should feel that
way: calm, dense, immediate. Nothing shouts. The product earns trust by being clear and by
getting out of the way, not by ornament. Restraint and motion do the work that gradients and
color usually do elsewhere. Let the content — the memory, the AI response, the captured moment —
be the thing that shines.

**Silence, clarity, and function over form.**

---

## Shared principles (binding on every platform)

### 1. Brutalist / terminal aesthetic
Minimal, functional, terminal-inspired. Flat, sharp, dense. Every element earns its place;
remove before adding. No decorative tiles, no 3D effects, no emojis in the UI, no gradients
beyond the brand.

### 2. Typeface: Menlo, monospace, everywhere
One font family across the whole product. Weights stay light (roughly 200–400). Hierarchy comes
from size, weight, and spacing — never from mixing fonts.

### 3. Accent: emerald, and only emerald
- Dark mode: `#34D399`
- Light mode: `#059669`

The single accent color. Used sparingly — active states, focus, the one important action on a
screen. Everything else is a monochrome hierarchy. Do not introduce a second accent; do not
color-code information (use position, size, and weight instead). Semantic colors (error/red)
exist only for their exact purpose.

### 4. Base: black / white + neutral grays
Dark mode background is pure-ish black (`#0A0A0A`); light mode is clean white (`#FFFFFF`).
Build depth with a small tiered surface system (background → surface → nested/input), not with
shadow. High contrast in both themes.

### 5. Tokens, not magic numbers
All color, spacing, and typography come from **`@offgrid/design`** (and each platform's token
layer that maps to it). No hardcoded hex, no magic numbers in component styles. Components
inherit the brand and flip light/dark automatically through the token mapping — never hardcode a
color that a token already expresses.

### 6. Visual hierarchy through size and weight, not color
Primary → secondary → tertiary is expressed by typographic scale and spacing. Labels are quiet
uppercase "whispers" in muted tone; metadata is small and muted. Give content breathing room at
the top level and tighten within components. Respect information density where it serves scanning.

### 7. Motion clarifies, never decorates
- Animate **only** `transform` and `opacity`. Never layout-thrashing properties.
- Timings: micro 100–150ms · hover/spring 200–300ms · reveal 300–500ms.
- Always honor `prefers-reduced-motion`.
- Stream anything that takes time; never a frozen wall — use skeletons/shimmer/progress.
- Functional animation only. If it doesn't clarify state or guide attention, cut it.

### 8. Sensible defaults, no needless modes
Nothing should require configuration before it works. Infer intent; tuck advanced controls away
until wanted. Accessible by default: `aria-label` on icon buttons, `alt` on images, ≥4.5:1
contrast, touch targets ≥44px.

### 9. Use the space of the host surface
Do not make one platform imitate another. Desktop uses its wide canvas for responsive grids,
master-detail views, tables, and side panels. Mobile uses a focused vertical flow and progressive
disclosure. In both cases, avoid purposeless empty space and horizontal page overflow.

### Anti-patterns (avoid everywhere)
Colorful gradients or heavy shadows · multiple accent colors · rounded pill shapes (use minimal
~8px radius) · decorative animation · mixed font families · 3D effects · color-coded
information · purposeless empty space · cluttered layouts.

---

## Desktop profile

Desktop is a wide, mouse-driven, keyboard-driven, multi-window surface.

- Fill the canvas with responsive multi-column grids, dense tables, master-detail views, and side
  panels. Do not center a phone-width column on a wide window. Keep controls near their content.
- Use tight 4/8/12px spacing inside dense groups and clearer separation between groups. Keep
  headers, filters, tabs, and column labels visible while their body scrolls.
- Treat hover and keyboard input as first-class states. Reveal secondary actions on hover and
  provide shortcuts for repeated navigation and submission.
- Use the shared `SidePanel` for settings, editors, previews, and multi-step details. It must close
  by Escape, outside click, and its close control. Reserve a centered dialog for a short blocking
  confirmation.
- Desktop typography roles are: title 18px; body and subtitle 14px; description 12px; metadata and
  labels 10–11px. Labels are uppercase, muted, and tracked.
- In Tailwind, use `font-mono`, `rounded-md`, neutral surface and border tokens, and the emerald
  token for active, focus, and primary-action states. Use `@phosphor-icons/react` for icons.
- Interactive controls transition in 100–150ms and use a small pressed scale. Panels and dialogs
  use opacity plus scale or slide over 120–200ms. Keep exit animation and reduced-motion behavior.
- Radix dialogs are centered with the CSS `translate` property. Their keyframes may animate only
  `transform: scale()` and opacity; adding a transform translation causes the dialog to jump.

## Mobile profile

Mobile is a touch-driven, narrow surface. Use a clear vertical flow, compact groups, and progressive
disclosure. Touch targets are at least 44px.

### Mobile tokens

- Access colors and shadows through `useTheme()` and styles through `useThemedStyles()`.
- Use `TYPOGRAPHY`, `SPACING`, and `FONTS` from `src/constants`; never hardcode their values in a
  component.
- The spacing scale is 4, 8, 12, 16, 24, and 32px (`xs` through `xxl`). Standard screen padding is
  24px, card padding is 16px, and normal control or list spacing is 8–12px.
- Surface tokens are `background`, `surface`, and `surfaceLight`. Text tokens are `text`,
  `textSecondary`, and `textMuted`. Use `borderFocus` for focus and `error` only for errors.

### Mobile typography hierarchy

| Role | Token | Size | Weight | Use |
| --- | --- | ---: | ---: | --- |
| Display | `TYPOGRAPHY.display` | 22px | 200 | Large numeric values |
| Title | `TYPOGRAPHY.h2` | 16px | 400 | One screen title |
| Body | `TYPOGRAPHY.body` | 14px | 400 | Messages, inputs, buttons, and primary content |
| Subtitle | `TYPOGRAPHY.h3` | 13px | 400 | Sections, cards, and modal titles |
| Description | `TYPOGRAPHY.bodySmall` | 13px | 400 | Help and explanatory text |
| Metadata | `TYPOGRAPHY.meta` / `label` | 9–10px | 300–400 | Timestamps, metrics, and uppercase labels |

`h1` is reserved for rare hero text and is not a normal screen title. Hierarchy comes from size,
weight, and tone. Metadata must remain quiet.

### Mobile components

- Top-level tabs use the shared `ScreenHeader` with 12px horizontal and 8px vertical padding.
  Pushed screens use 16px horizontal and 12px vertical padding, a back control, a title, and an
  optional trailing action. Headers use the surface token, a subtle divider, and a stable stacking
  level. Onboarding, lock, and model-download screens may use full-screen layouts.
- Buttons and inputs use an 8px radius, token spacing, and clear focus, pressed, disabled, loading,
  and error states. Cards use `surface`, a subtle border, and at most a small theme shadow.
- Use `react-native-vector-icons`; Feather is the default. Do not use emojis as interface icons.
- Empty states contain one direct message and, when useful, one clear action.

## Component ownership

Use `@offgrid/design` for tokens and `wednesday-solutions/component-library-animations` for reusable
visual and interaction primitives. Search the existing product components before adding anything.
Extend a shared primitive when the concept is the same; do not fork a local visual copy.

Console, website, and landing pages inherit the shared principles directly.

---

**Remember:** the UI should feel like the product — private, quiet, fast. Let the AI's
capabilities and the user's content speak, not the interface.

## Desktop source record

Synchronized on 30 September 2026 from the sibling `brand/DESIGN_PHILOSOPHY.md`,
commit `15e6b2f` (7 September 2026). The previous Desktop guide last changed at
`332e48397` (27 August 2026). Use this guide before each Desktop UI change.
Shared principles follow the brand source; Desktop implementation details also
follow `docs/DESIGN.md`.

Desktop uses `@offgrid/design` tokens and the shared operator primitives from
`wednesday-solutions/component-library-animations`. Consume the package export;
do not install separate registry copies or use catalogue demos as controls.
Keep Tailwind layers in `theme, base, components, utilities` order so resets cannot
override the shared controls.
