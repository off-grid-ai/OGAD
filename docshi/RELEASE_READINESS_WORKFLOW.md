# Release readiness workflow

This is the durable handoff for future agents and release owners. Do not reconstruct release
coverage from test counts or old chat context.

## Sources of truth

- [`RELEASE_TEST_CHECKLIST.csv`](RELEASE_TEST_CHECKLIST.csv) defines the canonical 155 product
  journeys and their priorities.
- [`P0_P2_INTEGRATION_COVERAGE.md`](P0_P2_INTEGRATION_COVERAGE.md) classifies those journeys as
  `COMPLETE`, `PARTIAL`, or `OPEN` under the no-mockist testing standard.
- [`release-readiness-supplemental-0.0.40.json`](release-readiness-supplemental-0.0.40.json) records
  release, native, security, compatibility, and shipped-surface cases found by manual audit but
  missing from the canonical ledger.
- [`RELEASE_READINESS_CHECKLIST_0.0.40.csv`](RELEASE_READINESS_CHECKLIST_0.0.40.csv) is the generated
  execution sheet to import into Google Sheets.
- [`MANUAL_RELEASE_TESTS_0.0.40.md`](MANUAL_RELEASE_TESTS_0.0.40.md) provides grouped device-pass
  guidance and stop conditions.
- [`CORE_RELEASE_JOURNEY_AUDIT_0.0.40.md`](CORE_RELEASE_JOURNEY_AUDIT_0.0.40.md),
  [`PRO_RELEASE_JOURNEY_AUDIT_0.0.40.md`](PRO_RELEASE_JOURNEY_AUDIT_0.0.40.md), and
  [`NATIVE_RELEASE_GAP_AUDIT_0.0.40.md`](NATIVE_RELEASE_GAP_AUDIT_0.0.40.md) preserve the audit
  reasoning and exact evidence for future work.

## Generate and validate

Run:

```sh
node scripts/generate-release-readiness-checklist.mjs
npx vitest run src/main/__tests__/p0-p2-coverage-ledger.test.ts
```

The generator must produce 210 unique rows with one header row and 28 columns. The validation test
prevents canonical journey/status drift, duplicate IDs, invalid tiers/confidence, empty evidence
explanations, and non-pending manual results in a newly generated sheet.

The generated CSV is UTF-8 with RFC-style quote escaping and no multiline records. In Google
Sheets, use **File > Import > Upload**, select the CSV, choose comma as the separator, and import it
as a new sheet. Do not enable automatic conversion of IDs such as `NR-01`, `PR-01`, or `CR-01`.

## Status snapshot after the current integration hardening pass

- Total: 210 journeys - 21 `COMPLETE`, 179 `PARTIAL`, 10 `OPEN`.
- P0: 93 journeys - 59.7% automation coverage, 41.8% initial readiness before manual results.
- P1: 93 journeys - 63.7% automation coverage, 44.6% initial readiness before manual results.
- P2: 21 journeys - 71.2% automation coverage, 49.8% initial readiness before manual results.
- P3: 3 journeys - 45.0% automation coverage, 31.5% initial readiness before manual results.
- Overall: 62.4% automation coverage, 43.7% initial readiness before manual results.
- This pass closed the gateway and OAuth P0 automation gaps, added production composition coverage
  for TCC revocation and shutdown, replaced clipboard and chat tours with real persistence/runtime
  integrations, and added guarded entity graph, contextual Jot, and complete rendered action-state
  lifecycle coverage. System Health now consumes one typed production status owner and renders real
  helper, permission, and classified engine-stderr states without a parallel UI truth map.
  Shipped entity correction controls now run against the guarded SQLite/filesystem owner through
  relaunch; fact editing and observation split remain recorded UI gaps rather than implied coverage.

Initial readiness is lower than automation coverage because every newly generated row starts with
`Manual result = NOT RUN`. Passing release-device evidence raises the manual component; a manual
`FAIL` or `BLOCKED` forces the row to 0% readiness.

The percentage columns use one deterministic policy:

- `Automation coverage %` is `100` for strict `COMPLETE`, `0` for `OPEN`, and `25-85` for
  `PARTIAL`, based on whether evidence is a real E2E, integration, package, or contract seam and
  whether a decisive native/external boundary remains.
- `Manual verification %` becomes `100` only when `Manual result` is `PASS`; it remains `0` for
  `NOT RUN`, `FAIL`, or `BLOCKED`.
- `Release readiness %` weights faithful automation at 70% and exact release-device manual evidence
  at 30%. A `FAIL` or `BLOCKED` manual result forces readiness to `0`.
- `Remaining gap %` is `100 - Release readiness %`.
- `Work state` and `Gap-closing action` explain whether the remaining work is automation, manual
  verification, or both.

These are coverage/readiness estimates, not probability-of-no-bug claims. Do not change a percentage
by hand to make a release look healthier; improve the evidence or record the manual result.

## Classification rules

- `COMPLETE`: decisive production collaborators run through the real application seam. Native or
  release-artifact checks may still remain manual.
- `PARTIAL`: useful real automation exists, but a rendered, persistence, runtime, native, external,
  or joined-journey seam remains separate or substituted.
- `OPEN`: the decisive release journey or failure class has no adequate automation.
- `HIGH` confidence: strict complete automation and no unresolved decisive native/external gap.
- `MEDIUM` confidence: strong real seam evidence, but the complete user/release journey is split.
- `LOW` confidence: a release, security, OS, hardware, external, or full-journey boundary can still
  fail while automation stays green.

High confidence never means manual release QA may be skipped. A passing manual row requires tester,
date, evidence, and the exact artifact/profile/device identity.

## Updating the checklist

1. Add or change ordinary product behavior in the canonical 155-row checklist.
2. Add native, security, release-process, compatibility, or omitted-surface cases to the
   supplemental JSON with a stable prefix: `NR`, `PR`, or `CR`.
3. Record the exact test path and what it proves. Do not write only "tests pass".
4. Keep the remaining manual boundary specific enough that a tester can reproduce it.
5. Never promote a row to `COMPLETE` because a unit test, source assertion, rendered shell, fake
   Off Grid service, or separate package probe exists.
6. Regenerate the CSV and run the validation test in the same commit.
7. Update the relevant Core, Pro, or native audit when a finding is closed or a new gap is found.

## Known release-significant audit findings

- `NR-12` is fixed: the gateway binds to canonical `127.0.0.1`, and a real TCP integration test
  rejects the Mac's non-loopback interface. A second-device installed-app probe remains manual.
- `NR-13` is fixed: OAuth callbacks require exact, live, single-use state through a persistent
  loopback owner, with twelve real HTTP lifecycle cases. A real-provider installed-app pass remains
  manual.
- `NR-08` is integration-backed: the CRM migration is transactional and recovers from a real
  SQLite storage interruption across repeated reopen. Literal process termination remains manual.
- `NR-10` is integration-backed: lock and sleep reasons cannot resume capture early, dictation is
  suspended, meetings stop, and user pause survives. Real macOS power/session events remain manual.
- `NR-01`: release sources historically disagreed about one production Pro-capable artifact versus
  separate production Core and Pro artifacts. The intended topology is one production artifact
  that starts locked; local Core/Pro variants are diagnostic only.

Do not mark the release approved while a P0 row is failed, blocked without an explicit release
decision, or missing evidence.
