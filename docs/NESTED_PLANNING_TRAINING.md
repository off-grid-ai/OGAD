# Nested planning: training

Nested planning is done by the harness alone (`docs/MODEL_CONTRACT.md`, "Nested planning"): every
request stays v0, and a step's own GOAL is plain text. So no model needs new vocabulary, and any trained
model can run nested today.

## Data

- The teacher harvest of whole end-to-end jobs runs with nesting on (`~/agent-sandbox/jobs/harvest-jobs.sh`;
  `NESTED=1` → `agentModels.nestedPlanning`). Its calls are ordinary v0 rows, so `teach_rows.py` needs no
  change.
- A run becomes rows only if the job is DONE by end state (`check_state.py`: site state, sent mail,
  mail folders, calendar), never by the evaluator's word.
- Short tasks stay flat; most rows are flat, so the flat skill does not drift.

## Measuring

- Whole jobs held out (`jobs-e2e.json`, split holdout, 18): `run-jobs.sh <out> holdout` with and without
  `NESTED=1`, for each model and for the bar. Effective = jobs done by end state.
- The public benchmarks (WebVoyager, Mind2Web) and OGAD-111 stay flat: their tasks are short.
