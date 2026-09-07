# Google account feature implementation

Code checkpoint: Desktop HEAD `0dd88cbc`, Pro HEAD `5c2bf09`. Changes are uncommitted. No tests, builds, live checks, commits or pushes were run by this worker.

## Owned paths

- Core `src/main/mcp-oauth.ts`, `src/renderer/src/components/ConnectorsScreen.tsx`.
- Pro `main/google-accounts.ts` (new), `main/google-rest.ts`, `main/google-ipc.ts`, `renderer/GoogleAccountSetup.tsx` (new), `renderer/GoogleClientSetup.tsx`.
- Approved attribution extension: Pro `main/ingest.ts`, `main/crm/calendar.ts`, `main/crm/calendar-identity.ts`. The schema bootstrap is already in calendar.ts; no other schema file changed.

## Production changes

- BYO OAuth connectors remain in the gallery after the first account. Each add still uses the existing numeric connector record and its own `connector:<id>:oauth:*` secrets.
- Google OAuth requests consent plus account selection. Existing account records are not renamed, migrated or replaced.
- Existing connector setup slot accepts optional connector ID and compact mode. Connected rows show account email. Details show identity, selected calendars, reload and reconnect. Existing per-ID Remove remains the disconnect owner and deletes only that connector's credential prefix.
- Google account state validates one v3 userinfo subject/email codec. Identity learning uses this same codec, not a silent profile/primary-calendar fallback.
- Calendar selection uses existing secrets storage under the same connector prefix. Preference identity is Google subject, not email or display name. A different subject defaults to its primary calendar instead of receiving another account's selection. Save validates every selected ID against that account's current calendar list.
- Calendar list response kind, items, IDs, flag/name types and page token types are validated. Repeated pages fail. Network/authorization errors are visible, not successful empty accounts.
- Whole Calendar/Gmail reads use a scoped view of the existing token credential. Each request checks that credential before and after I/O, and a final check runs before returning data. Preference commit checks it synchronously before writing. Refresh retains the same credential and refuses to restore a token after disconnect/reconnect. No second token store exists.
- Reconnect is a user entrypoint: validate Google connector, cancel its pending OAuth, use the existing provider credential invalidation, then the canonical testConnector command. Inspection found no persistent session cache in connect: transports are ephemeral and closed by discovery. Other connector IDs are not touched.
- Calendar REST queries use all selected calendars. Gmail links carry the authenticated email rather than `/u/0`. Account email is included in ingest text and calendar source attribution.
- Provider event keys encode Google subject + calendar ID + event ID. Recurring instance IDs remain distinct. Renames/reschedules update the same provider row; returned cancellations remove only that exact provider key. Repair preserves provider keys instead of recomputing title/day. Legacy rows retain the legacy key; no blanket deletion or reassignment occurs.
- Gmail detail-read errors now fail visibly instead of silently dropping messages. Google fetches have a 30-second timeout.

## Code gates

- Pro source typecheck: command exit 2, 120 diagnostics, all in tests; zero production diagnostics.
- Pro focused ESLint over eight owned files: exit 0, zero errors. New google-accounts and GoogleAccountSetup have zero warnings. Existing file warning totals retained/reduced. The pure GoogleClientSetup slot wrapper gets a new sonarjs/function-name warning for its PascalCase React component name (file total 3 versus HEAD 5); no baseline or suppression was added.
- Desktop node and web typechecks: each exit 2, 26 diagnostics; none in owned mcp-oauth or ConnectorsScreen paths. Not a claim that the whole Desktop gate is green.
- Core focused lint: first run found existing slot suppression displaced by formatting. Moved the same suppression to the JSX line; rerun exit 0, three existing structural warnings.

## Required live verification after production review

1. Add Gmail A, then Gmail B. Verify both rows show the correct email. Add Calendar A and Calendar B independently.
2. Select a secondary calendar in A; leave B on primary. Reload/restart. Verify choices remain separate and only chosen calendars are fetched.
3. Open Gmail messages from each account; verify the browser opens the right account.
4. Reconnect A while B remains usable. Cancel reconnect; error remains visible and B is unaffected. Reconnect A to another subject; old subject's calendar preference must not apply.
5. Remove A; verify B remains usable and A's prefix is removed by the existing connector removal command.
6. Create equal-title/day events in different accounts/calendars; verify neither overwrites the other. Rename/reschedule one, then cancel it; verify the exact provider row updates/removes.
7. Pause a Google response, disconnect/reconnect that connector, then release it. Verify no response is returned under the old account identity and no stale preference/token is saved.
8. Exercise malformed Google list response, timeout, revoked access and missing identity. None must show a successful empty account or silent partial Gmail sync.

## Explicit limits / review points

- No live proof yet. Feature is not release-verified.
- Existing query horizons/result limits remain; this is not a full historical or incremental Calendar mirror. Returned cancellations are applied, but events outside the queried horizon are not reconciled.
- Legacy title/day rows can temporarily coexist with new provider-key rows. Their original account cannot be recovered safely from the old data; they are preserved rather than guessed or removed.
- No calendar/account metadata is written to a new database. Renderer receives account identity/calendar IDs only, never OAuth tokens or client secrets.
- UI work extends existing connector surfaces and native form controls. Brand guidance and the UI skill were read; the component library was fetched/inspected at b2268673. It is a private catalogue with no package exports. No catalogue component was copied or new reusable primitive created.
