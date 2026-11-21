# Product loops: build rules (20 Nov 2026)

Mac accepted "Build the shared fix" for all 8 decisions on the decision page
(https://claude.ai/artifact/P3SqoZo8TuLkrJPmqLthnK). Each thread builds its decision across every product.
Your findings: `docs/review/loops/themes/<decision>.json` (each item cites files; the code is the truth, drop a
finding the code proves wrong and say so).

## Who builds what

| Decision | Thread |
|---|---|
| sync-state | loops-desktop-mobile |
| names | loops-guide |
| licence, other-product | loops-extension-apps |
| no-model, permissions | loops-mobile |
| errors (desktop + phone items) | loops-desktop |
| errors (extension items) | loops-extension |
| approvals-tasks | web-use |

Coordinator: the "Release check + product loops audit" session (`local_a912391d-7faa-40e6-8347-3ee76637242f`).

## Rules

- **The fix is a shared rule plus a line on each screen.** Put the rule in `shared/` (hexagonal: shared owns logic;
  apps are ports and UI). Run `python3 scripts/change-map/scan.py --plan <feature>` in `desktop/` first and follow its order.
  No second writer, no copied rule, no backward arrow (shared → app → Pro).
- **Every product the finding names:** desktop (+ Pro), phone (+ Pro), extension. A step you can't do on one product: say so in your report.
- **Branches:** stay on the current branch in each main checkout (`feature/onboarding-picks`; extension
  `feature/scribe-notes-fixes`; ui-library `feature/scribe-notes`). No new branches, no worktrees.
- **Shared checkout, 7 writers:** write finished, typechecking files only; commit each small change at once;
  `git add <named files>` only, never `-A`/`-u`. Before editing a file outside your decision, check `git log -3 -- <file>`;
  if another thread changed it in the last hour, message that thread first.
- **Push** after each coherent piece; pre-push hooks must pass, never `--no-verify`. Pro first, then bump the `pro` pointer.
- **No releases.** No tags, no release workflows, no store uploads, no rollouts. Mac tests tomorrow and gives the go.
- **Never touch:** Stripe Managed Payments (stays on), `license-worker` pricing, Mac's own app data, the GPU training job.
- **Copy:** short, plain, outcome first; brand rules in `brand/`. Icons: Phosphor. UI: approved components only.
- **Checks:** targeted tests for what you changed (no mocks/spies); full suites run once at the end by the coordinator.
- **Live checks:** desktop dev app on the isolated profile only, one at a time (`ss -ltnp | grep 9333` before you launch;
  stop it when done). Android phone on USB: ask the coordinator before you use it (one thread at a time).
- **Shots for review:** put before/after shots of each screen you changed in `docs/review/loops/fixes/<decision>/`
  with a `screens.json` (`{id, name, group, what, file, step}`, `step` shared by the same screen on different products).

## Report (to the coordinator)

Short bullets: commits per repo, what each fixed (finding ids), what you dropped and why, what is not done.
