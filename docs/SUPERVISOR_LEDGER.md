# Supervisor ledger

One line per 20-minute round (`oga-throughput`): time, what landed, pass/fail, queue size, the bottleneck with numbers, what was removed.

- 2026-11-17 r1 · landed: shared writing rules (6) + closest-only spelling + note previews; mobile Get Pro tests (3 files); desktop-pro notes (backlinks refresh/plain, find, history, settings grid, graph ring/fit/checkboxes), Scribe Add · checks: writing 0 fail, notes 87/0, mobile 4/4 · queue 51 open → ~22 (engine 9 closed, 5 stale-message closed, 7 desktop polish fixed) · bottleneck: push hooks, ~25 min per repo run in series, 2 runs lost to one flake (ModelsScreen import hook under load) and one to another session's untracked shared test · removed: no per-change tests; push all repos in one background chain.
