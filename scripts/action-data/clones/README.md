# Clone farm

Self-hosted open-source clones of the apps people use (mail, drive, chat, boards, docs, social,
shop), seeded with synthetic content, on the training server. Tasks run there with writes allowed
(send, post, like, delete...), and every row is verified against the app's own database or API.

- `clone-capture.mjs` runs scripted episodes and writes OGAD rows (`actor`, `evaluator`, `planner`,
  `episodes` jsonl + `images/`), built with `../contract.mjs` exactly like `live/live-capture.mjs`.
  Write actions run only when the page host matches `CLONE_HOST` (`*.farm.test`).
  `live-capture.mjs` keeps its UNSAFE filter for every other site.
- `tree.mjs` finds a control in the snapshot by role, name, value and the text around it.
- `probe.mjs` prints an app's snapshot after a few actions (authoring aid).
- `apps/<app>.mjs` one module per app: `reset`, `login`, and task generators (goal, plan, the exact
  actions, and a `verify` against app state). `mail-common.mjs` is shared by the two webmail apps.
- `seed/` synthetic data generators. No real people or addresses; all domains are `*.test`.
- `farm/` server side: `farm.sh` (service runner, no systemd), service commands, nginx vhosts,
  per-app install and reset scripts, `accounts.json` (the farm's test password).

Server layout: `/workspace/clone-farm` (configs, seed snapshots, logs), code trees and live data in
`/dev/shm/clone-farm` (fast resets; rebuilt by the install scripts after a pod restart — /workspace
has a quota and charges ~64 KB per small file). Our nginx on port 80 serves every `<host>.farm.test`.

Held-out test apps (never train on them): SnappyMail, Kanboard, HumHub. Their runs go to
`/workspace/action-data/clones-test-<app>/` and are built with
`train/build_testset.py --run <runs...> --out /workspace/action-train/realsite/clones-test`.

```
cd /workspace/action-data-gen/scripts
xvfb-run -a node clones/probe.mjs --app roundcube --do 'click:button:/Compose/' --grep 'textbox|button'
nice -n 10 xvfb-run -a node clones/clone-capture.mjs --app roundcube --episodes 600 --out /workspace/action-data/clones-roundcube --cdp 9700
```
