# R1 checklist - chat actions on the durable spine (Days 1 - 4)

Execution checklist for R1 of `COMPUTER_USE_PLAN.md` (the build doc). The plan stays the source of truth for schedule and scope; this file only tracks R1's execution. Tick a box when its unit is landed green.

**Rules for every box (from CLAUDE.md):**
- One box = one commit-sized unit. Land it as soon as it is green (`npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm test`), then move on. Spine work commits in `../shared`.
- Tests land in the same commit as the change - one case per branch, condition, and error path. Coverage ratchet holds.
- Port before writing: the sources per component are in `PORTING_MAP.md`. Verify the license at the point of adoption.
- Any UI string follows the brand copy rules.

**Design references:** the Action record and state machine are `ASSISTANT_ARCHITECTURE.md` Section 3; the reliability stack is Section 4; the gate contract is decision 7 (payload binding). The spine is platform-free and lives in `../shared/packages/use` (`@offgrid/use`); OGAD consumes it via `file:../shared/packages/use`.

---

## Day 1 - the spine package (`@offgrid/use`, in `../shared`)

- [x] **1. Scaffold `packages/use`** in the shared repo: tsup + node --test (the shared-repo house pattern), mirroring the sync engine layout; consumed from OGAD as `file:../shared/packages/use`.
  *Done when:* the package builds, an empty test runs, and OGAD's tsc still passes with the dependency declared.
- [x] **2. The Action contract** (`packages/use/src/action.ts`): Zod schema + types for `id, type, source, intent, args, payloadHash, risk, rail, idempotencyKey, attempts, verification, state, triggerAt`, audit refs. Closed `type` enum (message / email / calendar / reminder / open / lookup / file-share / web-task).
  *Done when:* schema tests cover each risk class, each type, and reject malformed input (fail closed).
- [x] **3. The state machine** (`packages/use/src/machine.ts`, XState v5): `proposed -> rejected | scheduled | resolving -> awaiting_approval | ready -> executing -> verifying -> done | executing(retry) | needs_help`, exactly as the architecture doc draws it. Persist via `getPersistedSnapshot()`; rehydrate on start.
  *Done when:* every transition has a test, plus a snapshot -> restore roundtrip test (the crash-resume guarantee).
- [x] **4. The durable queue** (`packages/use/src/queue.ts`): the goqite/sqliteq pattern - lease + visibility timeout + auto-extend + attempts + `UNIQUE(idempotencyKey)` dedup - behind a small `Storage` interface (the spine stays platform-free; hosts inject the DB).
  *Done when:* tested against better-sqlite3 `:memory:` - lease expiry re-queues, a duplicate enqueue dedups, attempts increment, a held lease blocks a second worker.

## Day 2 - the guarantees

- [x] **5. Retry policy** (`packages/use/src/retry.ts`; pure policy - the machine owns the loop, so no promise-retry dep): retry-once-with-verify for reversible actions; single-attempt-behind-the-gate for irreversible ones (decision 8.1 lean).
  *Done when:* both policies are tested, including that an irreversible action never fires twice even when verify errors.
- [x] **6. The gate seam** (`packages/use/src/gate.ts`): the interrupt -> approve/edit/reject -> resume contract as a host callback; `payloadHash` computed at propose time and re-checked at execute time so the approved payload is exactly what runs.
  *Done when:* tests cover approve, reject, edit-then-approve (hash changes, re-gate), and a tampered payload refusing to execute.
- [x] **7. The DeviceController port + handler registry** (`packages/use/src/device.ts`, `registry.ts`): `execute(action)` port; each action handler declares its rail, risk default, and how it verifies (read-back / status / none-fuzzy). Every attempt records the rail it ran on (the Action record is the effect journal), and escalation across rails is a re-fire governed by box 5's policy - a non-retryable action never escalates.
  *Done when:* a fake DeviceController proves the seam - registering a second fake handler needs zero caller changes (the DSP test), and routing picks by declared rail.
- [x] **8. The engine facade + worker** (`packages/use/src/engine.ts`): `propose()` validates and enqueues; a worker drains the queue through machine -> gate -> execute -> verify.
  *Done when:* the fake-device suite is green end to end: a routed action, the gate flow, a verify-retry scenario, crash-resume (kill mid-execute, rehydrate, no double-fire thanks to the idempotency key), exactly-once under a duplicate enqueue. **This is the engine checkpoint.**

## Day 3 - wire into the app (macOS end to end)

- [x] **9. The storage adapter in OGAD** (`src/main/actions/use-driver.ts` + `src/main/__tests__/use-storage.integration.dbtest.ts`): the queue/state tables live in the app's existing better-sqlite3 DB (one DB is the SSOT), with a migration.
  *Done when:* an integration test runs the real engine against a temp app DB (no mocks at the DB seam).
- [x] **10. The semantic rail adapter** (`src/main/actions/semantic-rail.ts`): wrap the existing `runNativeAction` helper behind the DeviceController port; map the Action types to the helper's verbs (calendar, reminders, contacts, messages, mail, open_url).
  *Done when:* each mapped type has a test through an injected helper boundary; unknown types are refused, not guessed.
- [x] **11. The gate host**: wire the existing `actions:proposeApproval` seam as the engine's gate callback; the approval card shows the resolved values from the bound payload.
  *Done when:* an integration test proves approve runs exactly the approved payload and reject lands the Action in `rejected`.
- [x] **12. Emission hardening** (`src/main/actions/emit.ts`): the action tool's schema goes to llama-server as grammar-constrained `response_format`; a TS SAP coercer (ported from BAML's schema-aligned parsing, keyed to the Action schema) repairs near-misses; bounded Zod validate-and-retry feeds the error back.
  *Done when:* coercion tests per branch (markdown fence, trailing prose, unquoted keys, missing optional), and a test that an unrepairable emission is rejected, never guessed.
- [x] **13. Chat tool integration**: mutations from the chat tool loop enqueue durable Actions through the engine; pure reads stay inline (decision 7.5). Existing native-tool behavior is preserved.
  *Done when:* the existing native-action tests still pass, plus new tests that a mutation goes through the queue and gate while a read does not.
- [ ] **14. Verification per handler**: calendar and reminders verify by read-back (list after create); messages and mail declare fuzzy -> single-attempt; open_url verifies by launch result.
  *Done when:* each handler's declared verification has a test, including a failed read-back triggering the retry policy correctly.
- [ ] **15. macOS checkpoint evidence**: on a seeded demo profile (`npm run demo` seeding rules), a chat ask ("remind me to send the deck at 6pm") produces gate -> execute -> verified -> confirmation. Capture screenshots into `e2e/screenshots/`.
  *Done when:* the flow runs clean and the screenshots show the approval card and the verified confirmation (validate the images before counting this done).

## Day 4 - Windows + release

- [ ] **16. Windows toolchain** (start this in parallel as early as Day 1 - it is the schedule floor and has CI latency): electron-builder Windows target, code-signing, and the `llama-server` Windows engine build in `release.yml` with the same gates the mac build learned (deployment target / staged deps / no foreign paths, adapted to Windows).
  *Done when:* CI produces a signed Windows build whose bundled engine loads a model.
- [ ] **17. The Windows semantic rail** (`src/main/actions/semantic-rail-win.ts`), **local-first**: mail + calendar via local Outlook automation (COM / PowerShell) where Outlook exists - a local write that syncs later, matching the mac rail - with Microsoft Graph as the fallback for setups without local Outlook (online-only, labeled honestly, user's own sign-in); open via the Windows shell. iMessage is macOS-only in R1 (documented tier difference).
  *Done when:* handler tests through an injected Graph boundary; the registry proves macOS and Windows rails swap with zero caller changes.
- [ ] **18. E2E + evidence**: a Playwright spec driving chat ask -> approval card -> done state on a fresh temp profile (`OFFGRID_PRO=0`, synthetic seed only); screenshots per surface, a short video of the golden path.
  *Done when:* `npm run test:e2e` includes the new spec and passes; evidence attached to the PR per the repo's PR rules.
- [ ] **18b. Release UX notes**: Tools defaults ON (fresh installs) with native actions under the Tools category - verify in the e2e that a fresh profile can act without touching any toggle. Flag to the lead: the free-build inline-confirm question for mutate/irreversible actions (open-core line), and the R2 router retiring the per-turn toggle.
- [ ] **19. Ship it**: version bump, release via CI, checkpoint sign-off against the plan ("on both macOS and Windows, a chat ask calls the action tool and the action runs gated and verified"). Update `COMPUTER_USE_PLAN.md` if any date moved.
  *Done when:* the release is out and the plan reflects reality.

---

## Watch-list (honest risks inside R1)

- **Box 16 is the long pole.** Windows CI signing + the engine build is net-new infra with slow feedback loops; kick it off on Day 1 and let it bake while the spine lands.
- **Box 12's SAP coercer is new surface** - err toward more coercion-branch tests, not fewer; every repair rule gets a regression case.
- **Boxes 9 - 11 touch the running app** - main-process changes need an app restart; do not over-restart during capture hours.
- If a box slips, the plan's rule applies: scope trims at the tail (Windows rail detail, evidence polish), never the released core.
