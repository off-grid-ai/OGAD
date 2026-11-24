# Desktop ↔ mobile journeys

Read-only audit, 2026-11-20. "Closes" means: the starting side names the next step, the other side shows the result, and a block is explained in one line. Finding ids are in `desktop-mobile.json`.

| Journey | Direction | Closes today | Why not (finding) |
|---|---|---|---|
| Pair by QR, happy path | desktop → mobile | yes | |
| Pair by QR, happy path | mobile → desktop | yes | |
| Pair by code, happy path | both | yes | |
| Pair when the phone app is not installed | desktop → mobile | no | No link beside the QR. dm-desktop-pairing-no-path-to-phone-app |
| Find the pairing screen on the other app | both | no | Devices vs Sync vs Personal Mesh. dm-screen-names-differ |
| Pair when neither or the other side has Pro | both | no | Fault is stated, no next step. dm-pairing-failure-no-next-step |
| Pair when the licence is full (5 devices) | both | partly | Cost is shown before pairing. Failure line has no step. dm-pairing-failure-no-next-step |
| Same-licence devices join without a code | both | no | Refusal reasons go to logs. dm-silent-join-refusal-logs-only |
| Get Pro on the phone from a desktop licence | desktop → mobile | no | Phone shows only key entry and checkout. dm-pro-by-pairing-hidden-on-phone |
| Expired QR or wrong code | both | yes | |
| Version mismatch while pairing | both | no | Ends as a timeout. dm-version-mismatch-times-out |
| Remove a device | both | no | Removed side loses Pro with no reason. dm-removed-device-not-told |
| Paired device offline or away | both | no | Only "Pair again" is offered. dm-pending-no-open-app-hint |
| Chats sync | both | yes | |
| Chat continued on the other device | both | yes | Phone uses its own active model. |
| Projects and knowledge documents | desktop → mobile | yes | Phone shows progress and failure. |
| Actions (approvals) | mobile → desktop | no | Phone has no approval card. dm-approval-no-card-on-phone |
| Notes sync, text | both | yes | |
| Notes sync, failure or conflict | both | no | Log only. dm-note-sync-failures-log-only |
| Notes page says sync state | mobile | no | Says "stay on this device". dm-notes-empty-state-wrong |
| Writing (Scribe / Improve) | both | partly | Syncs. Phone page has no sync control. dm-mobile-pages-lack-sync-control |
| Model settings (off by default) | both | partly | Syncs when on. Neither side sees the other's switch. dm-peer-state-not-on-wire |
| Copied text, both switches on | both | yes | Origin shown on both. |
| Copied text, one switch off | both | no | Dropped in silence. dm-peer-state-not-on-wire |
| Copied text from Android or iPhone limits | mobile → desktop | no | dm-clipboard-setup-differs-by-entry |
| Vault sync, both open | both | yes | |
| Vault sync, other vault locked or off | both | no | dm-vault-open-on-other-device |
| Share a file to a device, receiver online | both | yes | In-app notice with Open. |
| Share a file, receiver away | both | no | No "open the app" step. dm-pending-no-open-app-hint |
| File arrives while app is in background | both | no | No system notification. dm-no-os-notification-on-arrival |
| Screenshots and downloads, receiver has kind off | both | no | Raw "declined by receiver". dm-transfer-refusal-raw-text |
| Screenshots from phone, permission refused | mobile → desktop | no | dm-phone-media-permission-silent |
| Share once / Not this one approvals | both | yes | Same words on both. |
| Send a model, computer to phone | desktop → mobile | partly | Phone row is clear. Desktop errors are raw. dm-model-send-failure-raw-on-desktop |
| Send a model, phone to computer | mobile → desktop | no | Desktop shows loose files. dm-desktop-model-receive-has-no-job |
| Model ready on the receiver | both | no | No notice. dm-model-arrival-no-notice |
| Model the receiver cannot run | both | no | Hidden with no reason. dm-unsendable-models-hidden |
| Phone chats with the computer's models | mobile → desktop | partly | Works. Asleep computer gives a raw error. dm-computer-unreachable-raw-error |
| Computer revokes the phone's model access | desktop → mobile | no | Reason dropped. dm-gateway-key-revoked-reason-dropped, dm-devices-silent-on-model-lending |
| Phone turns on the computer's tools | mobile → desktop | no | Switch snaps back. dm-remote-actions-off-no-reason |
| Phone runs Web Use / Computer Use, happy path | mobile → desktop | yes | Task card is good. |
| Task fails on the computer (permission, setup) | mobile → desktop | no | dm-task-recovery-hint-never-sent |
| Stop, pause, guide a task from the phone | mobile → desktop | partly | Works. Refused control times out. dm-task-control-times-out |
| Films and video on the computer from the phone | mobile → desktop | partly | Pro-missing is clear. Network failure not confirmed. |
| Link to get the other app | both | yes | Real links on both. |
| Names of shared features | both | no | dm-feature-names-differ |
