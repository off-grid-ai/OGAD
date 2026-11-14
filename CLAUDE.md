# Desktop instructions

Read [AGENTS.md](./AGENTS.md) and [the workspace engineering contract](../.codex/ENGINEERING_CONTRACT.md). No additional process or architecture rules apply here.

Before you change a feature, run `python3 scripts/change-map/scan.py --plan <feature>` and follow its plan: every place the feature lives, in order, with the check for each step and what not to change at the same time. See [scripts/change-map/README.md](./scripts/change-map/README.md).

<!-- BEGIN GENERATED: shared/CLAUDE.md#debugging-source-of-truth -->
> **Generated from `shared/CLAUDE.md` - do not edit this section here.**
> Run `node scripts/mirror-doctrine.mjs` in `shared/` after changing the canonical copy.
> `--check` fails the build when a mirror drifts, so these cannot silently disagree.

## Debugging — reason from first principles

Read the observed behavior and the owning code. Use logs or a live reproduction when needed. Fix the reported cause without assuming that every bug needs a new source of truth or abstraction.
<!-- END GENERATED: shared/CLAUDE.md#debugging-source-of-truth -->
