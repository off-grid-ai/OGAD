# Change map

Shows where a concept lives across Off Grid, the order to change it, the check for each step, and what must not change
at the same time. It covers shared, desktop, desktop/pro, mobile, mobile/pro, browser-extension and website.

```bash
python3 scripts/change-map/scan.py --list            # every concept, by how many places it lives
python3 scripts/change-map/scan.py --plan writing    # the change plan for one concept
python3 scripts/change-map/scan.py --html map.html   # the interactive page
```

- **Concepts** are the features in `shared/packages/features`, plus model library and Pro licensing.
- **Layers, in change order:** shared owner → native engine → app logic → view → catalog data → website copy → tests →
  hand-test rows from each `docs/RELEASE_TEST_CHECKLIST.csv`.
- **Collisions:** concepts that share files. Change them one after another, never in parallel.
- **Change review page:** `python3 scripts/change-map/review.py <spec.json> <out-dir>` joins a change's existing
  screen-review shots, Argus Next release and this map into one review page (`review.html`). See the
  `graph-engineering` skill for the spec and the publish step.
- **Limits:** a file joins a concept by its path name, so some files are missed. To fix a miss, change the concept's
  pattern in `CONCEPTS` in `scan.py`.
