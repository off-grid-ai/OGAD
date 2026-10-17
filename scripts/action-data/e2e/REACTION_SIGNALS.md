# Browser reaction signals

What the harness can watch after an action to tell whether, where and how the page reacted.
Each signal is captured by the browser itself, so no text diff is needed. "Now" means it is worth
building first; "later" adds coverage for rarer cases.

A reaction recorder starts before each action (an init script on the page plus Playwright events),
stops when the page settles, and returns one report: what changed, how far from the acted-on element,
and whether it touched the area the plan step expects.

## 1. Navigation and tabs

| Signal | Tells us | Capture | When |
|---|---|---|---|
| URL change | went to a new page | `page.on('framenavigated')` (main frame) | now |
| SPA route change | in-app navigation without a load | patch `history.pushState` / `replaceState`; `popstate`, `hashchange` | now |
| Load state | page finished loading | `waitForLoadState('domcontentloaded' / 'load')` | now |
| New tab or popup | link or script opened a window | `context.on('page')`, `page.on('popup')` | now |
| Page closed or crashed | the tab went away | `page.on('close')`, `page.on('crash')` | now |
| Leave-page prompt | unsaved-changes guard | `beforeunload` listener | later |

## 2. DOM structure and state

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Elements added or removed | content appeared or went (results, modal, row) | `MutationObserver` `childList`, `subtree` | now |
| ARIA and state attributes | toggles, menus, tabs, accordions | `MutationObserver` `attributes` on `aria-expanded`, `aria-checked`, `aria-selected`, `aria-pressed`, `aria-hidden`, `aria-current`, `aria-busy`, `open`, `hidden`, `disabled` | now |
| Visibility through style or class | shown or hidden with CSS | `attributes` on `class`, `style`; confirm with computed `display` / `visibility` | now |
| Text changes | labels, counters, messages updated | `MutationObserver` `characterData`; ignore digit-only changes (timers) | now |
| Shadow DOM changes | web components (many design systems) | observe each open shadow root; patch `attachShadow` to catch new ones | later |
| Frame content | same-origin iframes changed | observer per same-origin frame; `page.on('frameattached'/'framedetached')` | later |

## 3. Layout, visibility and scroll

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Scroll position | the page or a panel moved | `window.scrollY`; `scroll` events on scrollable containers (`scrollTop`) | now |
| Document grew | infinite scroll or "load more" added content | `document.scrollingElement.scrollHeight` before vs after | now |
| Element entered or left the viewport | lazy content, toast, modal came into view; target scrolled away | `IntersectionObserver` on new nodes and on the target | now |
| Target is on screen | click vs scroll decision | `getBoundingClientRect()` vs viewport | now |
| Element resized | accordion opened, dropdown grew, text wrapped | `ResizeObserver` on the target's ancestors and new nodes | later |
| Layout shift | page jumped (ads, images loading) | `PerformanceObserver` `layout-shift`: noise to discount | later |

## 4. Focus and input

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Focus moved | a field or dialog took focus | `focusin` / `focusout`, `document.activeElement` | now |
| Value changed | typing landed; select changed | `input`, `change` events; read `value`, `checked`, `selectedIndex` of the target | now |
| Form submitted | a search or form was sent | `submit` event | now |
| Validation error | input rejected | `invalid` event, `aria-invalid`, `:invalid` | now |
| Text selection | text was selected | `selectionchange` | later |

## 5. Overlays and feedback

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Dialog opened or closed | modal, cookie banner, confirm | `<dialog open>`, added `role=dialog` / `alertdialog`, `aria-modal` | now |
| Popover or menu opened | dropdown, menu, listbox | Popover API `toggle` event; added `role=menu` / `listbox` / `tooltip` | now |
| Live region updated | toast, status, "Saved", error banner | text changes under `aria-live`, `role=status`, `role=alert` | now |
| Native browser dialog | `alert` / `confirm` / `prompt` | `page.on('dialog')` | now |
| Animation ran | menu or modal animating in | `animationstart`, `transitionend` | later |
| Fullscreen | video or viewer went fullscreen | `fullscreenchange` | later |

## 6. Network

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Requests after the action | the page asked the server for something | `page.on('request' / 'requestfinished')`, filtered to XHR and fetch | now |
| Request failed or errored | action failed on the server | `requestfailed`; responses with status 4xx / 5xx | now |
| Data sent | a POST, PUT or DELETE (a write) | request method | now |
| Download started | a file is coming | `page.on('download')` | now |
| Live updates | chat or feed pushed data | `page.on('websocket')` frames | later |

## 7. Errors and console

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Script error | the page broke on the action | `page.on('pageerror')` | now |
| Console error | something failed quietly | `page.on('console')`, type `error` | later |

## 8. Visual

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Pixel change in the impact area | canvas, CSS-only, hover or colour changes the DOM does not show | screenshot of the target's box (and the expected area), compared with before | now |
| Whole-screen change | big visual change | downscaled screenshot comparison | later |
| Media state | video or audio played or paused | `play`, `pause` events | later |

## 9. Session and auth

| Signal | Tells us | Capture | When |
|---|---|---|---|
| Cookies or storage changed | logged in, preference saved | `context.cookies()`, `localStorage` length before vs after | later |
| Redirected to a login page | needs sign-in (hand over to the user) | URL or title matches sign-in patterns after a navigation | now |

## 10. Settling (when to look)

Replaces fixed waits. The page has settled when, for about 300 ms: no DOM mutations, no XHR or
fetch in flight, no running animations, and no layout shift. Cap the wait at 5 s, and report "still
busy" if it is hit.

## Scoring a reaction

Each recorded change gets a place:

1. **On the target:** the acted-on element itself (value, checked, expanded).
2. **Near the target:** its parent, siblings and subtree.
3. **In the expected area:** what the plan step's check names (a text, a field, a dialog).
4. **Elsewhere on the page.**

It also gets a kind: navigation, overlay, content, state, scroll, network, error, visual.

Noise is discounted first: digit-only text changes, cross-origin ad frames, layout shifts, and repeating carousel attributes.

Uses in the harness:

- **"Changed"**: any real change in 1–3, or a navigation, overlay, scroll, download or new tab.
- **Loop**: the same action twice on the same page state, with no change in 1–3.
- **Failed action**: an error signal (request failed, script error, validation error) or no reaction at all.
- **Success check**: the expected area changed the way the check says.

Model-facing text stays "ok, page changed" until the models are trained on richer feedback. A later
contract version can say what changed, for example "dialog 'Sign up' opened" or "12 results added".
