# Off Grid Desktop (god-twin build)

Follow [the workspace engineering contract](../../.codex/ENGINEERING_CONTRACT.md). It takes priority over these repo notes. Keep each change in the smallest existing owner; do not move app logic to `shared` unless asked.

- This is the macOS Electron app. Paid feature code belongs in the private `pro/` submodule; keep core integration inert.
- For UI work, use the existing design tokens and `brand/DESIGN_PHILOSOPHY.md`. Reuse a fitting component.
- For customer-facing copy, read the brand guide. Do not publish private profile data.
- Verify the changed user journey with synthetic data for screenshots and automated UI runs.
- Only when changing the bundled chat engine or its packaging: run `scripts/build-llama.sh` and check that the staged binary loads a model with its required libraries.

<!-- BEGIN GENERATED: shared/CLAUDE.md#debugging-source-of-truth -->
> **Generated from `shared/rules.md` - do not edit this section here.**
> Run `node scripts/mirror-doctrine.mjs` in `shared/` after changing the canonical copy.
> `--check` fails the build when a mirror drifts, so these cannot silently disagree.

## Debugging — reason from first principles

Read the observed behavior and the owning code. Use logs or a live reproduction when needed. Fix the reported cause without assuming that every bug needs a new source of truth or abstraction.
<!-- END GENERATED: shared/CLAUDE.md#debugging-source-of-truth -->
