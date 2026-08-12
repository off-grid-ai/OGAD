# Off Grid AI Desktop — agent guide

This is **Off Grid AI Desktop** — an Electron (macOS) desktop app. The product name is always **"Off Grid AI Desktop"** (never "Off Grid Desktop", "My Memories", etc.) — in window titles, OAuth client names, about screens, everywhere.

## Design — DESKTOP-FIRST, Off Grid brand

Full design doc: **`docs/DESIGN.md`**. The essentials, which OVERRIDE any mobile-first or monochrome assumptions:

- **Desktop-first.** Wide canvas: multi-column layouts, dense lists/tables, side panels, detail screens, hover affordances. Never design mobile-first or for narrow viewports. (The mobile app is a separate product with its own guide.)
- **Typeface: Menlo** (monospace) everywhere — terminal/brutalist.
- **Accent: emerald** — `#34D399` (dark) / `#059669` (light). THE accent for primary actions, active states, links, success. (Tailwind `green-500/400` is an acceptable stand-in but prefer the exact tokens.)
- **Base:** black / `#0A0A0A` + white; neutral grays for surfaces/borders/text tiers. Flat, sharp, dense.
- Tokens: `@offgrid/design`. Brand canon: `mobile/docs/design/DESIGN_PHILOSOPHY_SYSTEM.md` (brand only — desktop _layout_ follows `docs/DESIGN.md`, desktop-first).
- Real brand logos (Simple Icons), no decorative tiles behind them; no gradients; no emojis in the UI.

### Use the screen real estate — desktop density rules

The window is WIDE. A list of cards/rows stretched edge-to-edge in a single column (one item per 1900px line, the action button marooned on the far right) wastes the canvas and reads worse, not better. Lay out for the space you have. These are hard rules, learned the hard way on the Models screen:

- **Multi-column responsive grids for collections.** Any list of comparable items (models, connectors, entities, meetings) is a grid that fills the width: `grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4`, not one full-width row each. A card's controls stay next to its content, never flung across empty space.
- **Tight, consistent spacing on a 4/8/12px scale.** Dense data UIs use narrow gutters (8-12px) and small padding, NOT the 16-24px editorial spacing. Body text ~12-14px, compact line-height. Flat and sharp, per the brand.
- **Group, then separate.** Reduce gaps _within_ a group (rows in a section) but keep clear separation _between_ functional groups (filters vs data, "On this device" vs "Available"). Section headers over a wall of identical rows.
- **Progressive disclosure.** Secondary info and rarely-used controls go behind a detail panel / "…" / hover affordance — don't lay everything flat. Master list stays scannable; depth lives in the side panel or slide-over.
- **Sticky context.** Fix headers, tabs, filter bars, and column labels while the body scrolls, so context never scrolls away.
- **Finesse the interactions.** Every click gets a small micro-interaction — `transition-all duration-150`, `active:scale-95` on buttons, slide+fade (not abrupt mount) for panels/slide-overs. State changes animate; nothing pops in or out hard.
- **Offer density where it matters**, but the default IS dense — this is a terminal/brutalist desktop app, not a spacious mobile-first card feed.

Best-practice references: [UXPin grid systems](https://www.uxpin.com/studio/blog/ui-grids-how-to-guide/), [Pencil & Paper enterprise data tables](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables), [Designing for data density](https://paulwallas.medium.com/designing-for-data-density-what-most-ui-tutorials-wont-teach-you-091b3e9b51f4), [Andrew Coyle on large data tables](https://coyleandrew.medium.com/ui-considerations-for-designing-large-data-tables-aa6c1ea93797).

## What this app is

A private, **local-first** layer that **sees** (screen capture → OCR → entities), **remembers** (observations/entities/memory), helps you **reflect** (mind-share / day), and **acts** (MCP connectors + approval-gated actions). Everything is processed on-device by a bundled local LLM (llama.cpp + gemma); nothing routes through a server we own.

Roadmap: **`ROADMAP_DESKTOP.md`** (this repo) and `../shared/ROADMAP.md`.

## Stack

Electron 39 + React 19 + Tailwind v4 + electron-vite; better-sqlite3; bundled `llama-server` (port 8439), `whisper.cpp`, `ffmpeg`, `sharp`. Local LLM is a reasoning model — pass `chat_template_kwargs:{enable_thinking:false}` + grammar-constrained `response_format` for structured output. userData dir is `~/Library/Application Support/Off Grid AI Desktop`.

## Bundled chat engine (`llama-server`) — built in CI, gated, verified the hard way

The chat engine is compiled from llama.cpp **in CI** (`scripts/build-llama.sh`, run by `release.yml` before signing), NOT shipped from the committed/LFS binary. Three engine failures already shipped a broken app to real users — each has a gate now; do not weaken them:

- **Pin the macOS deployment target.** A binary built on a newer SDK gets `minos` = that SDK and silently refuses to launch on older macOS ("Chat model Down", no reason). The script sets `CMAKE_OSX_DEPLOYMENT_TARGET` and **gates on `minos`** (fails if it exceeds target). The committed binary is not trustworthy for this — CI rebuilds.
- **Stage the exact `@rpath` names, as real files.** The names the binary loads (`libggml.0.dylib`) are **symlinks** to versioned files (`libggml.0.15.3.dylib`). `find -type f` skips symlinks → the bundle misses the linked name → dyld "Library not loaded" for every user (this was 0.0.28). Use `find` **without** `-type f` + `cp` (follows symlinks into real copies; no symlinks inside a signed .app). A **dependency-closure gate** fails the build if any `@rpath/<name>` isn't staged — that gate would have stopped 0.0.28.
- **No foreign deps.** Any `/opt/homebrew` or `/usr/local` path in the engine's `otool -L` won't exist on a user's Mac; the script gates on this too (e.g. brew OpenSSL — disable it in the cmake config).

Two process rules, learned from the same incident — they matter as much as the gates:

- **Surface the engine's stderr; never guess at the cause.** When `llama-server` dies on load, classify its stderr into a real, actionable reason (`src/main/llama-error.ts`) and show it in System Health. A blank "Model installed but server is not running" got misdiagnosed as code-signing for days when the stderr said `unknown model architecture: 'gemma4'` the whole time.
- **Verify the EXACT CI path, not an approximation.** A local build using different `cp`/`find` flags than `build-llama.sh` proves nothing — that is exactly how 0.0.28's regression slipped through (local test followed symlinks; CI's `-type f` didn't). Run `scripts/build-llama.sh` itself, then confirm the staged `.0.dylib` names exist as real files **and** a model loads, before claiming a fix is shipped.

## Conventions

- Verify changes with `npx tsc --noEmit` (main: `tsconfig.node.json`, web: `tsconfig.web.json`) before declaring done. **If you touched `pro/`, also run `cd pro && npx tsc --noEmit -p tsconfig.json`** — that is a separate CI gate, and core's two configs do NOT compile pro's tests.
- Main-process changes need an app restart; renderer changes hot-reload.
- Don't over-restart — it interrupts capture.
- **Local packaged builds:** commands for building the `.app` on a dev Mac (signing, unsigned, fresh-profile) live in `local-build.local.md` (gitignored, machine-specific). Check it before running `build:unpack`/`build:mac` locally — keychain cert setup varies per machine. Real release signing is CI-only (`release.yml`).

## Commit incrementally — never batch a session's work into one commit

A long agent session WILL hit a context/session limit; anything uncommitted is lost. Protect
progress by committing continuously, not at the end:

- **One logical change = one commit, landed as soon as it's green** (tsc + its tests pass). A bug
  fix, a single consolidation/extraction, a doc update — each is its own small, self-contained,
  well-described commit. Do NOT accumulate 5 unrelated edits and commit them together "later".
- **Commit the moment a unit is verified**, before starting the next one — so a session cut-off at
  any point leaves every finished unit already saved. Treat "done and green" as "commit now".
- **Push regularly** (at least whenever you'd be sad to lose what's landed) so progress survives even
  a lost local worktree; the pre-push gate (tsc + tests + coverage ratchet) still runs each time.
  If a pre-push hook is blocked by an unrelated environment issue (e.g. a running app holding a
  port), use the documented CI-equivalent workaround (see the gateway-dead-port note) — never
  `--no-verify`.
- **Small commits are the record** (merge, never squash — see the workspace multi-agent model), so
  each step stays reviewable and revertible. A giant end-of-session commit is a defect.

## Code hygiene (adopted)

The wednesday-solutions gold-standard hygiene is **adopted** (landed on the quality-hardening
release branch, not a separate PR). Two parts:

1. **Prettier — applied repo-wide.** Config: `.prettierrc.yaml` (`singleQuote`, `semi: false`,
   `printWidth: 100`, `trailingComma: none`) — the repo settled on 100/semi-false rather than the
   120 originally sketched. The whole tree is formatted to it; `eslintConfigPrettier` runs
   `prettier/prettier` as a lint rule so drift is caught. `.prettierignore` (core + `pro/`) excludes
   vendored/ephemeral trees (`.claude` worktrees, `resources/artifacts` + `**/*.min.*`, tsconfig
   jsonc, local scratch). Re-run with `npm run format`.
2. **ESLint — gold-standard rules as a warn RATCHET** (`eslint.config.mjs`, `goldStandardRatchet`):
   `curly: all`, `no-console: [allow error,warn]`, `no-else-return`, `no-empty`, `prefer-template`,
   `max-params: 3`, `complexity: 15`, `max-lines-per-function: 250`, `max-lines: 350`,
   `@typescript-eslint/no-shadow` — all at `warn` because the god-files (MemoryChat ~2.6k, ipc.ts
   ~1.7k) exceed the structural caps. **Tighten toward `error` (and `complexity` toward the gold 5)
   as those files decompose — never loosen to pass.** This is the same ratchet discipline as the
   coverage floor. Source: github.com/wednesday-solutions/react-template.

## Testing — test every approved behavior change in the same pass

When iterating (a request, a fix, a tweak the user just confirmed), add a test that captures that specific behavior **as part of the same change** — a regression test that would fail before the change and pass after. This applies to bug fixes (test the exact broken case), new branches/conditions (cover each), and copy/contract changes other code depends on. Do not defer tests to "later" or a separate commit. Err toward MORE tests, not fewer — one case per branch, condition, and error path, not a single token test per file.

- **Coverage bar — 85% is the standard, enforced by a rising floor.** The goal is **85% on every metric — statements, branches (which subsume conditions), functions, lines** — across the testable surface. The repo is not there yet (it is mostly Electron/native I/O shell that can't be unit-tested), so `npm run test:coverage` gates a **ratchet floor** set just under current coverage: the pre-push hook blocks any REGRESSION and the floor only rises. Every change that adds logic adds tests, nudges the number up, and the floor follows it toward 85 (raise the `thresholds` in `vitest.config.ts` as coverage climbs; never lower them). New code never ships uncovered — add a branch or an error path, add the case.
- **Unit tests** — vitest, `src/**/*.test.ts` (run `npm test`). Keep logic pure and Electron-free so it's testable: extract decision logic into a no-import module and test that (see `model-sizing.ts`, `search-ranking.ts` + their `__tests__/`). DB/Electron-bound code (anything importing `getDB`, `vision`, etc.) can't be unit-tested directly — pull the pure part out.
- **Integration tests over mocks** — cover the real seams too, not just the pure units. Run the actual implementation against real collaborators wherever it's feasible (a temp SQLite DB, a temp `OFFGRID_USER_DATA` dir, real crypto/WASM) — see `vault-service.test.ts`, which exercises real kdbxweb + Argon2 against a temp dir. **Use mocks very sparingly**, only at true boundaries you can't run in-process (the network, a native OS dialog, hardware IDs). A mock that stands in for your own logic hides the thing under test and lets it rot green — prefer a real (or in-memory) implementation so the test fails when the behavior actually breaks.
- **Regression guards for prompts/contracts** — when a fix lives in a prompt or string contract, assert it by reading the source (see `extract-prompt.test.ts`, which guards the observation-confabulation fix).
- **Tests guard the architecture too (SOLID + DRY).** Prove the seam: exercise the abstraction through a second/fake implementation so a test fails the moment a caller starts branching on a concrete type (`kind === 'x'`, `instanceof`) instead of the interface — that is how we test for DSP, not just assert it in review. Guard DRY: import the single source of truth into the test and assert against it; never re-hardcode the value the code defines, or the duplication just moves into the test. A mapping/rule/constant is defined once and tested once.
- **E2E** — Playwright Electron tour in `e2e/` (`npm run test:e2e`), DOM-driven, fresh temp profile, `OFFGRID_PRO=0`. Assert new surfaces render. Screenshot key states via `page.screenshot({ path: 'e2e/screenshots/<name>.png' })`; include those screenshots in the PR body.
- Before declaring a change done: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && (cd pro && npx tsc --noEmit -p tsconfig.json) && npm test` — fix failures first. The `pro` leg is not optional when you touched `pro/`: CI runs it as its own `Typecheck (pro)` step, the release does not run it at all, and core's two configs never compile `pro/**/__tests__`. A pro-only type error therefore passes every local check and every release build, then fails CI on main (this is exactly how an undeclared `js-yaml` import reached main). When you touched logic, run `npm run test:coverage` and keep every metric at or above the 85% floor.

## E2E capture — SYNTHETIC data only, seeded via the demo script

E2E and screenshot/video capture (including any device capture harness) run the app on a **fresh temp `OFFGRID_USER_DATA` profile** and must use **synthetic demo data only — never a real profile, never upload real user data.**

- **Seed with the demo script — BOTH seeders.** A blank profile is EMPTY, so any flow that _generates_ (chat, especially the "All memory" scope) will error with **"Sorry, something went wrong…"** — a **profile/RAG gap, not a bug**: no seeded memory store means the memory path throws before streaming. There are TWO independent seeders and a flow may need both: **`OFFGRID_SEED=force`** → core `seedDemo` (`src/main/index.ts` → `dev-seed.ts`) seeds chats / knowledge / RAG memory (this is what "All memory" chat queries); **`OFFGRID_SEED_PRO=force`** → pro `seedProDemo` (`pro/main/index.ts` → `pro/main/dev-seed.ts`) seeds observations / entities / clipboard / replay frames. `npm run demo` sets both — use it (or set both env vars) for any capture that exercises chat/generation.
- **Model ports are single-owner.** Only one app instance can bind the model engine ports (`:7878` gateway, `:8439` llama-server, `:7879`). A running `npm run dev` will block a second capture instance's engine → generation errors that look like a bug but aren't. Free the ports (stop the dev app) before an e2e capture, or the recording exercises the error path only.
- **Never upload private data.** Screenshots/video from real-profile runs (real chats, memories) must not be published. Capture runs must be synthetic-seeded so anything that lands in a PR or the public showcase is demo data.

## Pull requests — required evidence

Every PR must include in its body:

- **Screenshots** — at minimum one before/after or annotated screenshot per changed surface. Use `page.screenshot()` in E2E tests to capture these automatically into `e2e/screenshots/`; embed them in the PR body with `![description](url)`.
- **Video** (when the change involves interaction or animation) — record a short screen capture (QuickTime / `ffmpeg -f avfoundation`) of the golden path and attach it. A 15-30 second clip is enough. If a video can't be captured (CI/headless), add a note explaining why and provide extra screenshots instead.
- **Test output** — paste the relevant lines from `npm test` and `npm run test:e2e`.

**Screenshot validation is mandatory — not optional.** Before embedding any screenshot in the PR body, read the image file and confirm it shows what the description claims. If the screenshot shows an unexpected state (wrong screen, error that contradicts the fix, two bubbles when one is expected, etc.), investigate why the screenshot looks that way, fix the underlying issue, and retake the screenshot. A screenshot that disproves the fix is worse than no screenshot at all.

Without evidence the PR is not ready to merge.

## Reuse before building — check the inventory FIRST

This is a hard rule, not a preference. **Before writing ANY new component, panel, modal, hook, or service, first search the existing inventory** (`grep -rn` `src/renderer/src/components/`, `ui/`, the relevant screen folder) for something that already does it, and **reuse it**. Do NOT create a new variant of a thing that already exists.

- If something close exists, **extend it with a prop** — never fork a parallel copy. Two surfaces showing the same kind of thing (a viewer, a modal, a card, a search box, a preview pane) MUST use the same component. Parallel versions cause visual + behavioural drift (e.g. don't build a new centered modal when the image **Lightbox** overlay already exists — reuse that layout).
- Only build new when nothing fits, and say why.
- UI follows the approved-library + brand-token rules in `docs/DESIGN.md`; icons are `@phosphor-icons/react` only (never lucide).

## Open core — pro feature code lives in the pro repo

The `pro/` directory is a **git submodule** pointing at the private `desktop-pro` repo. It is present in the working tree when you have access to it, absent otherwise. Always run `git submodule update --init` after cloning or pulling if `pro/` is empty. Do not commit changes inside `pro/` from the core repo — commit them in `desktop-pro` first, then bump the submodule pointer here with `git add pro`.

**All code for pro features lives in the `desktop-pro` repo (`pro/`), never in core (`desktop`).** Core is public (AGPL); shipping pro source in it defeats open core. This is a hard rule, not a preference.

- A new pro feature: backend → `pro/main/`, UI → `pro/renderer/`, wired in via pro's `activateMain` / view-router — not core `index.ts`, not core `src/renderer`.
- Core only carries the **inert shell** for a pro surface: a `proCatalog` entry + a `locked: !isPro` nav item that shows `UpgradeScreen`, or a dimmed `ProPlaceholder` in Settings. No pro business logic, handlers, or data flow in core.
- Pro renderer reaches its IPC through the generic `proInvoke` / `proOn` passthrough — do NOT add per-feature namespaces to the core preload for pro features.
- Shared, reusable **engines** (e.g. `@offgrid/clipboard`) stay in `shared/` and may be consumed by either tier; it's the desktop **pro integration** that must live in `pro/`.
- `proEnabled()` (main) / `isPro` (renderer) gate activation; `OFFGRID_PRO=0` forces free. Gating alone is not enough — the source must also physically live in `pro/`.

**Settings sections follow the same rule.** A pro Settings section (proactive delivery, secretary/learned-prefs, identity, fleet console, etc.) is pro feature code — its component + logic live in `pro/renderer` and register into the core Settings screen via the section-registry seam (`pro/renderer/settings.ts` `registerProSettings` → core `registerSettingsSection`; core renders its own sections + all registered ones). Core must NOT hardcode pro section bodies in `Settings.tsx` gated by `isPro` — core only renders a dimmed `ProPlaceholder` for the locked preview when the section isn't registered (free build). Do not `if (isPro) <RealProSection/> : <ProPlaceholder/>` with the real section defined in core.

<!-- BEGIN GENERATED: shared/CLAUDE.md#debugging-source-of-truth -->
> **Generated from `shared/CLAUDE.md` - do not edit this section here.**
> Run `node scripts/mirror-doctrine.mjs` in `shared/` after changing the canonical copy.
> `--check` fails the build when a mirror drifts, so these cannot silently disagree.

## Debugging — start with the source of truth

**Most bugs here are source-of-truth bugs, and the fix is almost always to collapse two sources into
one.** So before reading a stack trace or reaching for a log, ask three questions in order:

1. **What is the source of truth for this fact?** Not "where is the bug" - "who is entitled to answer
   this question". A device's connection state, a model's identity, whether a transfer finished.
2. **Is anything else answering the same question?** Two answers is the bug, even when both are
   individually correct. Look for a value derived twice, a rule written in two layers, a state
   hardcoded next to a state that is computed.
3. **Can we refactor so there is ONE source, and would that fix it?** If yes, that is the fix. Patching
   the wrong answer leaves the second source in place, and it will disagree again somewhere else.

If the answer to 3 is no, say so explicitly and fix the symptom - but say WHY one source is not
achievable, because that is usually a design constraint worth writing down.

### Why this is the default heuristic (a session's worth of evidence)

Every one of these presented as a different bug and was the same bug:

| Symptom | The two sources | The one source |
|---|---|---|
| A connected device had no actions at all on macOS | two hand-written button lists, one per section | one component driven by `device.actions.*.visible` |
| "4 of 5 licensed devices" over a list of one | count from the registry, list from `saved` (which excludes devices that are ON the network) | the whole mesh |
| One model appeared 35 times | absolute path as identity, and iOS moves it every reinstall | `fileName`, unique within the dir |
| Sender said "sent", receiver said "could not receive" | the send loop's "I pushed bytes" vs the receiver's verdict | one package-state rule (`modelPackagePhase`) |
| Activity said COMPLETED for a half-sent model | per-FILE rows vs a package the user asked for | package state, files underneath |
| A live mesh read as half-down | each flow reading device rows its own way | the surface layer owns reading |
| "Needs repair" after a deliberate disconnect | a flag set by one path and clearable only by another | one lifecycle, cleared on the next success |

The tell is almost always the same: **two things that must agree, kept in step by hand.** A comment
saying "these must match" is a bug waiting for a witness; so is a hardcoded literal sitting next to a
computed value (`status: 'completed'` beside a record that also has a status).

### Durability and resilience are SSOT problems too

A fact that is not persisted has no source of truth after a restart - it silently becomes whatever the
UI last remembered. Failures were dropped on the floor (`if (status !== 'completed') return`), so a
failed transfer stopped existing the moment the view reset, and the surface confidently showed success.
When you fix durability, fix the READ at the same time: persisting a failure while the renderer still
hardcodes `status: 'completed'` converts a lost record into a durable lie.
<!-- END GENERATED: shared/CLAUDE.md#debugging-source-of-truth -->
## Architecture & abstractions (SOLID)

Design to abstractions, not concrete types. When implementations are interchangeable (model backends, TTS/STT engines, image/diffusion runtimes, connectors), the rest of the app depends on one service/interface — never branch on a concrete type in UI/stores (`if (engine === 'kokoro')`, `instanceof X`). Push the decision behind the abstraction; adding an implementation should need zero changes to callers. Normalize capability gaps inside the service, not the UI.

**Before every code edit, stop and ask three questions — out loud, in the response:**

1. **Is there enough here to abstract?** Two or more concrete cases handled by the same caller (text vs vision vs image models, Slack vs Mail surfaces, kokoro vs piper TTS) means there's a seam. One case, used once, is not — don't abstract speculatively (YAGNI).
2. **Can we apply SOLID here?** Mainly: does one thing own one responsibility (SRP), and do callers depend on an interface rather than the concretes (DSP)? A `kind === 'x'` / `instanceof` / per-type `switch` in a caller — _especially in the renderer_ — is the tell that the decision belongs behind a service.
3. **Are we actually using it?** A mapping or rule must be defined ONCE and reused. If the same kind→modality map, the same routing `if`, or the same capability check appears in two layers (e.g. main process AND renderer), that's duplication, not abstraction — collapse it to a single source of truth and have both sides call it.

If the answer to 1 is "no", say so and write the simple version. If "yes", build the seam before piling on the second concrete branch — retrofitting after drift is the expensive path.

## Copy & content standards

Any change to UI strings, docs, essays, or marketing copy follows the brand voice (`mobile/docs/brand_tone_voice.md`). Easy-to-miss rules: proof-first ("15-30 tok/s", not "fast"); privacy as mechanism ("runs in your Mac's RAM, nothing leaves the device", not "we value privacy"); no em dashes (use " - "), no curly quotes, no exclamation marks; banned words (revolutionary, seamless, empower, leverage, robust, comprehensive, crucial, delve, tapestry, testament, foster, showcase, enhance) and AI-slop phrases ("serves as", "stands as", "it's not X, it's Y") — say it plainly. No emojis in UI.
