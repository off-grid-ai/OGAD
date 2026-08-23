# Off Grid — close the gaps in `desktop/docs/GAPS_BACKLOG.md`

## Branch rule — read first, do not get this wrong

Do NOT create a branch. Do NOT switch branches. Do NOT merge to main.
Everything stays on `release/sync-cross-platform`, which is the current branch in all five repos:
`mobile/`, `mobile/pro/`, `shared/`, `desktop/`, `desktop/pro/`.
Commit directly there, small, one concern per commit. Never squash; always `gh pr merge --merge` if a
PR is ever involved. **Ask before pushing.**

Read `mobile/rules.md` in full first. Tests come LAST, and only when Mac asks.

## How to talk to Mac

ASD-STE100 Simplified Technical English. Short sentences, active voice, one idea per sentence, no em
dashes. When he asks for status he means three lines: what you did last, what you are on, what is
blocking you. Answer his actual question before volunteering anything else.

## The rule that matters more than any individual fix

He will say **SSOT, SOLID, DRY** repeatedly. He means it. Before every edit, say out loud: is there
one owner for this fact, is the decision behind an interface, is the rule written once.

The generative cause of nearly every bug in this codebase is narrower than "logic in the wrong place":

> **A host contract carries FACTS, not VERDICTS. If shared code branches on a host's answer, shared
> asked the wrong question — move the branch and ask for its result instead.**

That is Tell, Don't Ask. The last session's worst bug was `getSharedSecret(deviceId): string | undefined`
— an interface asking for *data* when the caller needed a *decision*. So the decision leaked into one
host, the other host made the opposite one, and the two phones could never connect.

Two checks that catch this class mechanically, and cost seconds:

1. **Callback audit.** For every function a host passes into shared, ask: is this a fact I own, or a
   judgement? `hasCredential` is a fact. Returning undefined *because the pairing looked broken* is a
   judgement wearing a fact's clothes.
2. **Parity diff.** `grep` the same option name across `desktop/pro` and `mobile/pro` and read both
   together. Divergence here is invisible — nothing errors, a device just quietly never connects.

Also from `rules.md`, and I failed to follow it last session: **debugging starts with the SSOT
questions, not with a log.** Ask "who owns this fact, does anything else answer it, would one owner fix
it" BEFORE pulling a device log. The device playbook is for *verifying* a fix, not for *locating* an
owner.

Relevant architecture, already in the tree:
- `shared/packages/sync/src/peer-link.ts` + `peer-link-service.ts` own "what is my relationship with
  each peer". Pure reducer, thin service, adopted by the orchestrator last session. Do not add a
  second answer anywhere.
- `shared/packages/sync/src/discovery/address-rules.ts` owns the address predicates, shared by
  `connectableHost` (which of THEIR addresses to dial) and `advertisableAddress` (which of MINE to
  publish). Hosts supply adapters that list addresses, and no address logic.
- Hosts (`desktop/pro`, `mobile/pro`) should be I/O adapters plus UI projection. Nothing else.

## Devices — both phones are connected and reachable

- Mac `192.168.1.90` · Windows VM `192.168.1.94` (offline mirror target) · Nord `192.168.1.26` ·
  iPhone `192.168.1.54`. Addresses move; the phones re-advertise within ~15s now.
- Nord package `ai.offgridmobile.dev` · iPhone udid `00008150-000225103CD8C01C`

```sh
# Android log + screenshot (both work)
adb exec-out run-as ai.offgridmobile.dev cat files/offgrid-debug.log
adb exec-out screencap -p > /tmp/nord.png

# iPhone log
xcrun devicectl device copy from --device 00008150-000225103CD8C01C \
  --domain-type appDataContainer --domain-identifier ai.offgridmobile.dev \
  --source Documents/offgrid-debug.log --destination /tmp/ios.log

# Desktop database (plain SQLite, no key needed)
sqlite3 "$HOME/Library/Application Support/Off Grid AI Desktop/memories.db" '<query>'
```

You cannot screenshot the iPhone unless WDA is running
(`WDA_UDID=... node scripts/ios/launch-wda.mjs`). **Ask Mac before starting it.**

**Mac drives the phones. Do not tap through the UI.**

## Hard-won operational rules

- **Read the device, not the code** — but only after the SSOT questions. Every real answer last session
  came from a log pull, a screenshot, or a SQLite query.
- **A swallowed error is the bug.** `.catch(() => undefined)` hid a hung handshake for hours.
- **Do not edit mobile files under his live Metro without telling him.** It hot-swaps half-finished
  code onto the phone and produces errors that look real. Build `shared` only when committed, then tell
  him to reload. A phantom "property X doesn't exist" was exactly this last session.
- **The mobile file sink lags.** Ask Mac to foreground the app before trusting a log tail. `logcat`
  carries nothing from the app's JS logger, but native errors do appear there.
- **The mobile push gate flakes on parallel load.** Retry the push; do not "fix" the test. It failed
  once and passed on retry last session.
- **`timeout` does not exist on macOS.** Never use it in bash.
- Timezone is IST, UTC+5:30. Device logs are UTC.

## The gaps

`desktop/docs/GAPS_BACKLOG.md`, `## OPEN` section. Twelve items. Each has Evidence, Owning seams,
Acceptance criteria, and Evidence-required-to-close — honour that structure; do not close one without
the evidence it asks for.

**Nine desktop capture / permissions / catalog items, all P1:**

| Id | One line |
|---|---|
| DEF-001 | Replay's capture control reports a state that is not factual |
| DEF-002 | Permission status and recovery are not independently discoverable |
| DEF-003 | Capture exposes raw JSON parser failures and strands failed frames |
| DEF-004 | Oversized capture analysis stays pending and retries forever |
| DEF-005 | Settings Pro previews are dead ends and omit Proactive delivery |
| DEF-006 | Screen Recording recovery returns to a blank, stale Settings scroll |
| DEF-008 | Catalog model downloads have a checksum gate but no trusted checksums |
| BLK-001 | APP-106 is green but its provider trace was not retained |
| AUT-001 | APP-142 proves recorder lifecycle, not finalized meeting persistence |

DEF-001 and DEF-002 are the same shape as last session's bugs and should be done together: several
surfaces (Replay, Settings, tray) each interpret `running` / `paused` / permission for themselves.
There must be ONE capture state machine, projected. That is `peer-link.ts` again, in a different
subsystem — read it first as the reference implementation.

**Three sync items I added last session, with evidence:**

- **SYN-001 (P2)** — the offline-chat gateway journey cannot reach its own server. `ENOENT`/`ECONNREFUSED`
  in 2ms, fails alone as well as in company, so the journey it claims to test never runs. `startModelServer`
  appears not to restore a listener once one has been closed on that port. One owner for "is there a
  listener on this port".
- **SYN-002 (P1)** — deliveries outlive the device. 2,246 delivery rows on Mac's machine point at
  `device_id`s that are not in `sync_paired_devices`, so every queued/failed count the user reads
  describes work aimed at machines he no longer has, and no retry can clear them. A delivery is parented
  by a device; forgetting the device must settle its deliveries. Note the ids are not even the same
  shape (32-hex vs 22-char base64url), so a migration keying on that column must not assume one form.
- **SYN-003 (P2)** — a knowledge-document test outlives its own temp directory. Passes alone, fails in a
  full-directory run, because async work started by the test is cleaned up underneath it.

## Do not do

- Do not retry the 2,246-row delivery backlog. It would fire six days of screenshots at his phones.
  **Ask first.**
- Do not repair the two inflated generated-image file names without asking. For records the Mac
  originated the true name is knowable from `local_path`; for received ones it is genuinely lost.
- Do not write tests until Mac asks. Finish the source change, get it green, let him verify on the
  devices, then ask.

## Gates before any push

```
shared:       cd shared/packages/sync && npm test          # 452 pass, 0 fail
desktop:      npm run typecheck && npm test                 # 437 files, 4141 tests
desktop pro:  npx vitest run --project product-integration pro/main/sync/__tests__
mobile:       npx tsc --noEmit && npx jest __tests__/unit/sync --maxWorkers=1   # 838 pass
```

Lint has a large pre-existing error count in both apps. **Measure your delta, do not chase the
absolute number** — count errors in the files you touched before and after. `mobile` also enforces a
500-line file limit, which is easy to trip.

A cross-platform fix must be verified on a real Android AND a real iOS device before it merges.
"It is shared JS, so it works on both" is a defect assumption.
