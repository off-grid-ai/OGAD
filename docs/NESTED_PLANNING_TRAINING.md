# Nested planning: training plan (proposal)

The loop and contract for nested planning are in `@offgrid/use` and `docs/MODEL_CONTRACT.md`
(section "Nested planning"). They are off by default. This is how LFM3 learns them. Nothing here
changes the running r18 pipeline; the pipeline owner decides when to take it.

## What the planner must learn

- On a whole job (many units, several sites): write `goal: <sub-goal>` steps when `SUBGOALS: allowed`.
- With `WITHIN`: plan only this sub-goal, in units of about 5 actions with a visible check.
- With `NOTES`: use the facts; do not look them up again.
- Without `SUBGOALS`: plan flat, as today.

The actor needs no new skill: it reads `WITHIN`/`NOTES` as context. The evaluator learns one new
habit: inside a sub-goal, `success("...")` carries the facts the next parts need.

## Teacher data

1. Bring the two `feature/nested-planner` commits (shared, desktop) into the bench app
   (`~/agent-sandbox/ogad-src` and `~/agent-sandbox/shared`) by merge, not cherry-pick.
2. Harvest the end-to-end jobs (the composed jobs on the `life` profile) with the teacher and
   `"nestedPlanning": true` in the agentModels JSON that `bench.sh` passes. The teacher runs with
   `instructions: true`, so it gets the new planner and evaluator lines.
3. `teach_rows.py` needs no change: each call's request is kept as-is, and
   `N goal: ... | check: ...` already matches its plan pattern. Sub-goal planner calls become rows
   with `WITHIN`/`NOTES`; top-level calls become rows with `SUBGOALS: allowed`.
4. Keep the short tasks flat (no `nestedPlanning`): most rows stay v0, so the flat skill does not drift.
5. Grade by end state (site `/_state`, IMAP, CalDAV), not by the evaluator's word.

## Public benchmarks

`scripts/e2e/run-benchmark.mjs` (WebVoyager, Mind2Web) has its own loop. WebVoyager and Mind2Web
tasks are short, so they stay flat. Port nested planning there only if a public task needs it.

## Done when

- LFM3 planner, on held-out whole jobs, writes sub-goals and finishes more jobs end to end than with
  nesting off. Effective = the job gets done.
- Flat scores (OGAD-111, WebVoyager, Mind2Web) do not drop beyond pass noise.
