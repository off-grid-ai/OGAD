# Session 2026-08-11 — DEF-004, SYN-002, and one repeated defect

## The pattern

Six bugs today. Every one is the same shape.

**A consumer decides a fact that only the owner can decide.**

| # | The owner knew | The consumer decided | Cost |
|---|---|---|---|
| 1 | the model server knew it refused a request permanently | capture called it a temporary outage | one frame retried 34 times over 2 days |
| 2 | the pairing store knew a device was gone | nothing settled the rows parented by it | 2,292 deliveries + 211 history rows counted forever |
| 3 | the transport knew Windows was offline | the delivery layer called it a failure | 1,928 rows marked failed for a closed laptop |
| 4 | the delivery row carried its device name | the card re-derived it from a live list | every history card read "Paired device" |
| 5 | the host stored UTC | the renderer read it as local | "Last observation" wrong by 5h30m |
| 6 | the pairing store owns "this device is ours" | Evict told only the entitlement path | forget never removed the pairing row |

The rule for all six: **a host contract carries facts, not verdicts.**

## Fixed and verified on the machine

**Malformed request body.** A lone UTF-16 surrogate from macOS Accessibility made the JSON body
unparseable to llama-server. Repaired once at the request builder, not per field — the frame's own
text was clean, so hunting the field would have failed. Frame 21469445 went from 34 failures to
`observed` on its first attempt after restart.

**Failure classification.** `postCompletionOnce` now rejects with a typed `ModelServerError`
carrying `unavailable | overflow | rejected | aborted`. Capture maps that fact instead of guessing.

**One retry ceiling.** The old ceiling applied only to UNTAGGED errors, and every capture error is
tagged, so it never fired. Now every retryable failure shares one budget of 8.

**Timestamps.** The stats query emits a marked UTC instant. `strftime` runs BEFORE the `MAX`,
because ' ' sorts under 'T' and a mixed-format MAX picks the wrong row too.
Verified: "02:39 PM", was "09:09 AM".

**Orphan deliveries.** `[sync] removed 2503 row(s)`. Ghosts to zero, the three real devices
untouched. Both ghost ids turned out to be the two evicted devices.

**History device names.** All 87 rows repaired. Repair must run BEFORE the in-memory load — the
renderer builds one name-per-device map with history applied last, so one stale cached name
overwrote every other card for that device.

## Written, not yet proven

**The forget lifecycle.** `pro:sync:forget` called only `pairingEntitlement.evict`, which releases
the licence seat and updates the registry. The pairing store was never told. The handler now also
calls `service.forget`, which revokes the membership and takes the row out through the store's one
exit — which is what releases the deliveries.

Test, ready to run: the Nord is already in the broken state. Re-pair it, share a file, forget it,
and its rows must go with no restart.

**The blocked frame state.** Built: a `blocked` status, a `blocked_min_context` column, a pure
input budget, and automatic release when the model can hold the frame. It never fires on this
machine at 16K. Keep with corrected copy, or drop. Mac's call.

## Decisions Mac made

- **A fresh install is a new device.** No adoption, no re-keying. Rule 2 dropped deliberately.
- **Delete orphan rows**, do not mark them cancelled.
- Keep both `device_id` and `membership_id`. Device id = which machine. Membership id = which
  grant, revocable, with its own proof secret.

## Open

1. **1,928 Windows rows marked failed for "device is not connected".** Not a failure. Reachability
   is the transport's fact. No link means no outcome, and the row stays queued.
2. **Vision may be regressed.** `mtmd_tokenize: number of media markers in text (0) does not match
   number of bitmaps (1)` repeating; every frame falls back to text only. Unknown whether today's
   changes caused it. Check by reverting the two llm-path changes and running one frame.
3. **The old Nord's eviction is stuck at `pending`**, never `tombstone`, and retries at every launch.
4. 423 of 8,529 observations are prompt-template placeholders, running at ~40/day. Parked by Mac.
5. Gaps doc: DEF-004's text describes a context overflow that does not exist. Rewrite against the
   real cause.

## Gates

Typecheck clean, both projects. Zero lint errors on every changed file. No tests written —
per the repo rule, they come last and only when asked. No local production build yet.
