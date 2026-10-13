# Off Grid AI work log audit

Date: 2026-10-06

Reported by Codex.

This document stores the source audit of the supplied work log, including Desktop, Pro, the browser extension, and related mobile code. It includes privacy, correctness, UI, and consumer experience findings.

The UI review uses Off Grid AI's focus on simple actions, clear status, useful recovery, and user control. Sources include the shared brand design philosophy, Desktop design guide, mobile design guides, and the Off Grid UI skill. The component library checkout inspected was `b2268673cf980ce8d9a4a1563d49bd1babc10c0f`. No component was selected or changed.

## Scope and evidence

| Repository | Source inspected |
|---|---|
| Desktop account work | Existing checkout at `/Users/user/.codex/worktrees/communication-research/desktop`, branch `feat/direct-account-connections`, commit `0b1e49ef8` |
| Desktop Pro account work | Its private `pro/` submodule, commit `f358ec284b2b03f3d8218b78072b4761f25fc720` |
| Desktop extension bridge | Source available in `/Users/user/wednesday/off-grid-ai/desktop` during the audit |
| God Twin | Git source on `feature/god-twin-current-main`, commit `45e587c5f`; inspected without changing branches |
| Browser extension | `/Users/user/wednesday/off-grid-ai/browser-extension`, branch `feature/browser-companion`, commit `65590e8` |
| Mobile | `/Users/user/wednesday/off-grid-ai/mobile`, branch `feat/uat-latest-main-pro-20261005`, commit `b1428ab3`, and its private Pro code |

Mobile work was not listed in the supplied log. The mobile review covered related tool routing, remote image generation, and deletion paths. It was not a review of every mobile feature.

Evidence labels:

- **Source:** The behavior is visible in code. It has not been reproduced in a running app during this audit.
- **Risk:** The source shows a failure condition that still needs a live reproduction.
- **Gap:** The inspected branches do not support the work log's claim.

Priorities in this document:

- **P0:** Immediate privacy issue.
- **P1:** Major function, trust, recovery, or release issue.
- **P2:** Usability, accessibility, or less severe failure issue.

All findings are open. No fixes were made. No tests, live app checks, or packaged builds were run. The Response column was added on 6 Oct 2026 by the follow-up work: it says what changed for each row, or why no fix is needed, with the commits. The local file links identify the exact source inspected; they may need to be updated if those checkouts move.

## Findings

| # | Priority | Product / area | Finding and effect on the user | Evidence | Required result | Response (6 Oct) |
|---:|:---:|---|---|---|---|---|
| 1 | P0 | Desktop / live-only accounts | **Manual sync can save live-only account data into memory.** Automatic sync checks the flag; manual ingestion does not. | Source: [ingestion handler](/Users/user/.codex/worktrees/communication-research/desktop/pro/main/crm-ipc.ts:354), [automatic guard](/Users/user/.codex/worktrees/communication-research/desktop/pro/main/ingest.ts:80) | Enforce live-only access in the ingestion entry point, including manual calls. | Fixed. Pro `72960c2`: the ingestion entry point refuses a live-only account, so manual Sync recent cannot save one into memory either. OGAD `ba8581fd1`: the connector screen says accounts are read live. |
| 2 | P1 | Extension / autofill | **The cross-site frame check always passes at this call site.** Autofill supplies the frame URL as both URLs. The script can run in all frames after all-sites access is granted. | Source: [fill.ts](/Users/user/wednesday/off-grid-ai/browser-extension/src/shared/autofill/fill.ts:114), [frame rule](/Users/user/wednesday/off-grid-ai/browser-extension/src/shared/autofill/safety.ts:167), [frame registration](/Users/user/wednesday/off-grid-ai/browser-extension/src/background/inline-register.ts:19) | Check the actual top page and frame before releasing credentials. | Fixed. Ext `4650710`: autofill compares the real top page with the frame before releasing credentials. Ext `b641a52` tests it with real iframes; the cross-site case fails against the old code. |
| 3 | P1 | Mobile / tools | **Tools with the same name can run on the wrong server.** A second server replaces the first tool's owner. Tool switches also use the name alone. | Source: [tool ownership](/Users/user/wednesday/off-grid-ai/mobile/pro/mcp/mcpStore.ts:70), [tool switches](/Users/user/wednesday/off-grid-ai/mobile/pro/ui/McpToolsScreen.tsx:57), [execution route](/Users/user/wednesday/off-grid-ai/mobile/pro/mcp/mcpService.ts:332) | Keep the selected server attached to each enabled tool and execution. | Fixed and merged 2026-10-10 ([OGAM#701](https://github.com/off-grid-ai/OGAM/pull/701), [mobile-pro#86](https://github.com/off-grid-ai/mobile-pro/pull/86)). mobile-pro `5f498c72` and OGAM `7128f923` ([OGAM#701](https://github.com/off-grid-ai/OGAM/pull/701), [mobile-pro#86](https://github.com/off-grid-ai/mobile-pro/pull/86)): each enabled tool keeps the server it was turned on for, and that server runs it. Device check pending. |
| 4 | P1 | Desktop / Google removal | **Removing an account does not revoke its grant at Google in the inspected removal path.** Local deletion leaves the provider grant active. | Source: [removal path](/Users/user/.codex/worktrees/communication-research/desktop/src/main/mcp.ts:151), [caller](/Users/user/.codex/worktrees/communication-research/desktop/pro/renderer/AccountQuickConnection.tsx:115) | Revoke the Google grant and report any failure clearly. | Fixed. Pro `bb89261` and OGAD `0ee4da77d`: Remove revokes the sign-in at Google. Pro `c6275e8` (6 Oct): when Google cannot be reached, a notification names the account and says where to remove the access. |
| 5 | P1 | Desktop / Google refresh | **A late refresh can restore a removed token.** The response writes a secret without checking whether the account still exists or its credentials changed. | Source: [google-rest.ts](/Users/user/.codex/worktrees/communication-research/desktop/pro/main/google-rest.ts:34) | Discard refresh results after removal or a change of credentials. | Fixed. Pro `d6eb667`: a refresh that finishes after removal or after a newer sign-in is discarded and saves nothing. |
| 6 | P1 | Desktop / account permissions | **Partial consent still fails sign-in.** The user cannot connect with fewer permissions than selected. This conflicts with the log's Partial access claim. | Source: [Google](/Users/user/.codex/worktrees/communication-research/desktop/pro/main/google-authorization.ts:55), [Microsoft](/Users/user/.codex/worktrees/communication-research/desktop/pro/main/microsoft-authorization.ts:60) | Save granted access and show which services remain unavailable. | Fixed. Pro `bb89261`: a partial grant connects with what was granted, for Google and Microsoft, and the card lists what was not granted. |
| 7 | P1 | Desktop / account recovery | **Broken and disabled accounts disappear from their card.** The user loses the account's status and recovery action. | Source: [account filter](/Users/user/.codex/worktrees/communication-research/desktop/pro/renderer/AccountQuickConnection.tsx:74) | Keep every account visible with its state and a clear recovery action. | Fixed. Pro `998c9f2`: every account stays on its card with its state and a Sign in again action. |
| 8 | P1 | Desktop / Obsidian | **The quick connection manages only one vault.** The handler chooses the first connector; the UI stores one vault. | Source: [status handler](/Users/user/.codex/worktrees/communication-research/desktop/pro/main/obsidian-ipc.ts:41), [UI state](/Users/user/.codex/worktrees/communication-research/desktop/pro/renderer/ObsidianQuickConnection.tsx:24) | List and manage each vault separately. | Fixed. Pro `84edd81`: each vault is listed, added, changed and removed on its own; the same folder cannot be added twice. Checked in the real app on 6 Oct (`e2e/accounts-lifecycle.spec.ts`). |
| 9 | P1 | Desktop + extension / link | **Concurrent encrypted messages can be sent out of sequence.** A valid frame can then fail authentication and close the link. Sequence numbers are assigned before asynchronous encryption finishes. | Risk: [sequence assignment](/Users/user/wednesday/off-grid-ai/browser-extension/src/shared/bridge/socket.ts:94), [extension send](/Users/user/wednesday/off-grid-ai/browser-extension/src/shared/bridge/socket-client.ts:203), [Desktop send](/Users/user/wednesday/off-grid-ai/desktop/src/main/extension-bridge/bridge-socket.ts:122) | Preserve sequence order through encryption and sending. | Fixed. Ext `4650710` and OGAD `641d65e63`: frames are sealed and sent in sequence order. Ext `4dbcb9e` tests out-of-order encryption; the link stays open. |
| 10 | P2 | Extension / Web Use | **Key commands can report success without performing the action.** Synthetic events do not provide normal Tab, Backspace, or arrow-key behavior. Enter has a separate form-submit action. | Source: [pressKey](/Users/user/wednesday/off-grid-ai/browser-extension/src/shared/agent/aria.ts:103) | Perform supported actions or return a clear unsupported result. | Fixed. Ext `f64fa8c`: keys perform their action or report that they could not. Ext `8f5cecd` adds tests, which found more cases fixed in `15321eb` (Enter on buttons, links and text areas; Backspace in email fields and never in a password). |
| 11 | P1 | Extension / chat deletion | **Deleted chats can return after sync.** Offline deletion is not retained for the next connection; sync imports the Desktop copy again. Delete all changes only the local library. | Source: [local deletion](/Users/user/wednesday/off-grid-ai/browser-extension/src/sidepanel/library-store.ts:107), [merge behavior](/Users/user/wednesday/off-grid-ai/browser-extension/src/shared/desktop/merge.ts:106), [remote delete](/Users/user/wednesday/off-grid-ai/browser-extension/src/background/chats.ts:78) | Keep deletion effective after reconnecting. Show whether it applies locally or across devices. | Fixed. Ext `6ee5a8b`: deletions are kept until the desktop confirms them and are not imported again; Delete all is local only and says so. Ext `e46015d` adds 8 tests. |
| 12 | P1 | Extension / privacy copy | **Nothing is sent anywhere is false when paired.** Saved chats are pushed to Desktop. This gives the user a wrong account of data movement. | Source: [settings copy](/Users/user/wednesday/off-grid-ai/browser-extension/src/sidepanel/SettingsScreen.tsx:151), [chat push](/Users/user/wednesday/off-grid-ai/browser-extension/src/sidepanel/library-store.ts:100) | Explain local storage and paired-device sync accurately. | Fixed. Ext `6ee5a8b`: Settings says chats are saved here and sync with the paired desktop. |
| 13 | P2 | Extension / destructive action | **Deleting one chat has no confirmation or undo.** A small trash button removes the chat at once. The supplied log already lists deletion confirmation as open work. | Source: [history action](/Users/user/wednesday/off-grid-ai/browser-extension/src/sidepanel/HistoryDrawer.tsx:153) | Provide a short confirmation or a reliable undo action. | Fixed. Ext `e1c150a`: deleting a chat asks first; a chat can also be renamed in place. |
| 14 | P2 | Desktop / destructive action | **Account removal has no confirmation.** The button calls removal immediately, despite the log claiming confirmed removal. | Source: [Remove button](/Users/user/.codex/worktrees/communication-research/desktop/pro/renderer/AccountQuickConnection.tsx:421) | Name the account and explain the effect before removal. | Fixed. Pro `998c9f2`: Remove names the account and explains the effect before removing it. OGAD `432d8f377` (6 Oct) does the same for MCP connectors. |
| 15 | P2 | Mobile / image cancellation | **Cancel during file transfer can still save the image.** Cancellation is checked before file work, but not after it. | Source: [remote image flow](/Users/user/wednesday/off-grid-ai/mobile/src/services/remoteImageGeneration.ts:66) | Stop the transfer where possible and check cancellation before publishing the result. | Fixed and merged 2026-10-10 ([OGAM#701](https://github.com/off-grid-ai/OGAM/pull/701), [mobile-pro#86](https://github.com/off-grid-ai/mobile-pro/pull/86)). OGAM `5962357b`: Cancel stops the transfer, checks again after the file is written and deletes the partial file. Device check pending. |
| 16 | P2 | Mobile / failed image transfer | **A failed transfer can leave an untracked file.** HTTP or format errors occur after the file has been written, without cleanup. | Source: [download and error paths](/Users/user/wednesday/off-grid-ai/mobile/src/services/remoteImageGeneration.ts:79) | Remove incomplete files and keep a useful retry path. | Fixed and merged 2026-10-10 ([OGAM#701](https://github.com/off-grid-ai/OGAM/pull/701), [mobile-pro#86](https://github.com/off-grid-ai/mobile-pro/pull/86)). OGAM `cce8e478`: any failure after the transfer starts deletes the partial file, so Retry starts clean. |
| 17 | P2 | Mobile / delete feedback | **Chat deletion can claim that images were deleted when file removal failed.** Records are removed first and errors are ignored. | Source: [chat deletion](/Users/user/wednesday/off-grid-ai/mobile/src/screens/ChatsListScreen.tsx:99) | Report incomplete deletion and retain enough information to retry it. | Fixed and merged 2026-10-10 ([OGAM#701](https://github.com/off-grid-ai/OGAM/pull/701), [mobile-pro#86](https://github.com/off-grid-ai/mobile-pro/pull/86)). OGAM `55b6a9c2`: each image file is removed before its record; if one stays, the user is told how many and that they can delete them from the Gallery. The in-chat delete (`useChatGenerationActions.ts`) follows the same pattern since `1e99a2ad1`. |
| 18 | P2 | Extension / keyboard access | **Settings tabs have incomplete keyboard behavior.** They use tab roles, but have no arrow-key navigation or focus management. | Source: [PillTabs](/Users/user/wednesday/off-grid-ai/browser-extension/src/sidepanel/ui.tsx:39) | Support the keyboard behavior expected of tabs. | Fixed. Ext `9edfe6c`: the tabs follow the tabs pattern (roving focus, arrows, Home and End, panels labelled by their tab), with unit and end-to-end tests. |
| 19 | P2 | Mobile / tool recovery | **The tools screen combines loading, missing data, and no tools into one empty state.** It says connect the server first without showing the actual connection state or a connect action. | Source: [tool data](/Users/user/wednesday/off-grid-ai/mobile/pro/ui/McpToolsScreen.tsx:41), [empty state](/Users/user/wednesday/off-grid-ai/mobile/pro/ui/McpToolsScreen.tsx:173) | Show the actual state and one useful action: wait, reconnect, retry, or return. | Fixed and merged 2026-10-10 ([OGAM#701](https://github.com/off-grid-ai/OGAM/pull/701), [mobile-pro#86](https://github.com/off-grid-ai/mobile-pro/pull/86)). mobile-pro `ae3a304f` and OGAM `6b912def`: the tools screen shows the real state with one action (wait, Connect, Try again or Go back). |
| 20 | P1 | Desktop / Ares microphone | **The Listen control shows an active state but cannot stop listening.** Clicking it always sends a wake request; the voice handler only starts capture when idle. | Source on `feature/god-twin-current-main`: `src/renderer/src/components/GodTwinCompanion.tsx:303`, `src/renderer/src/components/use-chat-voice-turns.ts:439` | Give the user a direct Stop action while listening. | Fixed. OGAD `a4a3c5b41`: the Talk button stops listening when pressed again. |
| 21 | P2 | Desktop / Ares interruption | **Ares appears by default above other applications.** Its large window stays on top and follows the active display. This can interrupt the user's work. | UX risk on `feature/god-twin-current-main`: `src/main/god-twin-window.ts:59`, `:172` | Make the first appearance clear and easy to dismiss; verify that it does not block normal work. | Fixed. OGAD `0599fc553` (6 Oct): Ares on the desktop is off until turned on in God settings, and when on it floats above windows but not over full-screen apps. |
| 22 | P2 | Desktop / Ares controls | **The control bar depends on small symbols and hover labels.** Controls are about 24px high, and the bar uses fixed light colors. | Source on `feature/god-twin-current-main`: `src/renderer/src/components/GodTwinCompanion.tsx:295` | Use clear actions, adequate targets, visible focus, and theme tokens. | Fixed. OGAD `a4a3c5b41`: controls are labelled with visible focus. OGAD `aea6cbeb2` (6 Oct) shares one control row between the God screen and the desktop, each a full-height target. The desktop bar keeps a dark fill because it floats over any app. |
| 23 | P1 | Desktop / integration state | **The named account branch does not contain the claimed God or extension bridge work.** There is no single inspected branch that represents the log's complete result. | Gap: Git trees for `feat/direct-account-connections` and `feature/god-twin-current-main` | Identify and review the exact Desktop and Pro commits intended for release. | No fix needed. The branch now holds the God work, the extension bridge and the wake word, and it is the branch under review (OGAD#176, desktop-pro#90). |
| 24 | P1 | Desktop / God claims | **The claimed wake-word journey is not present in the inspected account or God Twin branches.** The God Twin branch provides a manual wake action; no wake-word detector or its settings were found. | Gap: branch source searches and the God Twin diff | Locate the implementation or change the work log's status from Done. | No fix needed. The wake word is on the branch: `src/main/god-twin-wake.ts`, its settings in God settings, and `src/main/__tests__/god-twin-wake.integration.test.ts` (7 cases, including free builds). |

Rows 4 and 14 cover separate parts of the same removal journey: provider revocation and the user's confirmation. Rows 15 and 16 cover cancellation and failed-transfer cleanup. Fixes may share a focused change, but each result must be verified.

## Verification that remains

| Area | Verification that remains |
|---|---|
| God chat, current context, proactive posts, and workflows | Review the exact branch that contains these features, then verify the complete user journey. |
| Account sign-in and recovery | Verify real Google and Microsoft consent, cancellation, expiry, reconnect, and removal. |
| Extension experience | Verify Chrome and Firefox, narrow panel widths, keyboard use, themes, queues, tab switching, replay, and Stop. |
| Mobile experience | Verify the affected journeys on iOS and Android, including touch targets, text scaling, interruptions, and recovery. |
| Accessibility and visual layout | Inspect rendered screens for contrast, focus, clipping, motion, and readable status. |
| Packaging | Verify a packaged Desktop build and its private Pro code. The work log already marks this as blocked. |
| Work log status | Reconcile each Done claim with the exact release commits and its verification evidence. |

This is the complete source findings list from this audit so far. It does not establish that all product behavior is correct. The remaining checks above are required before making that claim.

## Original work log

The supplied work log is preserved below so the claims can be compared with the findings. Its Done labels and test claims are statements from the supplied log, not verification completed by this audit.
```text
Off Grid AI work log
Everything done in this session across the browser extension, Off Grid AI Desktop (OGAD) and Pro, ranked P0 to P3, with what is still open. P0 is what you asked for directly or what protects privacy and correctness; P3 is cleanup.

Ext: feature/browser-companion
OGAD: feat/direct-account-connections
Pro: feat/direct-account-connections
32
Done
3
Open
2
Blocked
15
P0
13
P1
5
P2
4
P3
Status
All
done
open
blocked
Priority
All
P0
P1
P2
P3
Repo
All
Ext
OGAD
Pro
Pri	Area	What	Repo	Status
P0	God	
God is a chat with Ares
Conversation with God beside the 3D Ares (listening, thinking, speaking), markdown answers, mic and text box. Replaces the old Assistant tab, open to everyone.	OGAD	Done
P0	God	
God has context
A Right now card (time, next meeting, open to-dos, approvals waiting, accounts read), refreshed every minute; the same context goes with every question.	OGAD, Pro	Done
P0	God	
God is proactive
Posts the day's plan, prep for a meeting starting within 20 minutes, and approvals waiting, each once; offers what fits now (prep me, what first, review, plan my day).	OGAD, Pro	Done
P0	God	
Wake word "Aries"
Opt-in always listening; hears Aries, Ares, Aires, Ari's. Short clips are transcribed on this machine only, even when transcription is remote, and never saved. Settings: wake word, sensitivity, microphone.	OGAD	Done
P0	God	
God is the assistant
One name: the chat switch, its Pro dialog and the Settings tool group say God. With Pro, God acts with Web Use and Computer Use.	OGAD	Done
P0	Setup	
Branches merged
Checked out the accounts PRs (OGAD#176, desktop-pro#90), merged latest main and the God Twin PR (OGAD#151), resolved 5 conflicts keeping both sides.	OGAD, Pro	Done
P0	Accounts	
Partial access
Unticked permissions at sign-in make a smaller connection, not a failed one; what is missing is shown. Google keeps earlier grants on update.	Pro	Done
P0	Accounts	
Every account on its card
Broken and switched-off accounts stay visible with what each reads and a Sign in again button.	Pro	Done
P0	Accounts	
Delete done properly
Remove asks first and revokes the Google sign-in at Google; a refresh finishing after removal no longer leaves a token behind.	OGAD, Pro	Done
P0	Accounts	
Expired sign-in detected
A sign-in Google rejects marks the account as needing a new sign-in instead of looking connected while every call fails.	Pro	Done
P0	Accounts	
Live-only stays live
Accounts are never copied into memory, including from the manual Sync recent; the connector screen says so.	OGAD, Pro	Done
P0	Extension	
Private desktop link
Sealed end-to-end channel between the extension and the desktop: pairing, chats synced both ways, vault, desktop tools.	Ext, OGAD	Done
P0	Extension	
Web tasks in this browser
The desktop's Web Use runs in the user's own tab through the extension, on Chrome without the debugger and on Firefox through the page path.	Ext, OGAD	Done
P0	Extension	
Agent hands off to the desktop
Agent mode goes straight to the desktop's Web Use in the chat's own tab; the browser's own loop is the fallback.	Ext	Done
P0	Extension	
Vault and in-field autofill
Key icon inside sign-in fields (LastPass style), two-step sign-ins, every safety rule enforced, Bitwarden corner cases covered.	Ext	Done
P1	Accounts	
Duplicates
Signing in to a connected account updates it and says so; duplicate rows are flagged; a duplicate no longer blocks reconnect; Atlassian keyed on the person.	Pro	Done
P1	Accounts	
Several Obsidian vaults
List, add, change and remove each; the same folder cannot be added twice; each vault is named.	Pro	Done
P1	Accounts	
Onboarding copy and Reconnect
Onboarding says accounts are read live; a failed card load says so; Reconnect fixes the broken account, not the first.	OGAD	Done
P1	Extension	
Accounts in Settings > Connectors
What each reads, what is missing, which need a sign-in, on/off and confirmed remove. A browser cannot add an account address as a web connector.	Ext, OGAD	Done
P1	Extension	
Web Use row like OGAM
Using Web Use: goal with a live view and Stop; afterwards a step replay with scrubber, Play and full screen. The plan is hidden.	Ext	Done
P1	Extension	
Next step after an Agent run
A suggested next instruction shows as the placeholder; Tab puts it in the box.	Ext	Done
P1	Extension	
One chat per tab
Each browser tab keeps its own chat, as ChatGPT's panel does; a run drives its own tab only.	Ext	Done
P1	Extension	
Queue and send now
Enter queues while a reply runs; Cmd/Ctrl+Enter sends now; queued messages can be sent or deleted.	Ext	Done
P1	Extension	
Pointer and working bar
The agent pointer moves on the page and a bar says Off Grid AI is working in this tab.	Ext	Done
P1	Extension	
Desktop's settings in the panel
Text, Tasks, Tools, Connectors, Image, Transcription, Voice and Remote tabs read and change the desktop over the link.	Ext, OGAD	Done
P1	Extension	
Chat parity with the desktop
Tool rows, answer versions, thinking, message actions, retry, metrics, Stop shown as stopped.	Ext	Done
P1	Desktop chat	
Answer versions on desktop
Regenerate and Resend keep previous and current answers (1/2), like the extension.	OGAD	Done
P2	God	
Workflows and fallbacks
Prepared workflows under All workflows (Pro); desktop Ares mirrors state; a glow replaces the 3D Ares without WebGL.	OGAD	Done
P2	Extension	
Models and polish
Models on four tabs including Computer Use; toolbar icon opens the panel; themes; close button; design canon.	Ext	Done
P2	Fixes	
Connect your work crash
The section no longer crashes when the connector list comes back missing.	OGAD	Done
P3	Tests	
Stale tests aligned
Theme default Dark, Pro slot list, OAuth cancel test, Google card tests, Workspace request count, account lifecycle DB tests added.	OGAD, Pro	Done
P3	Builds	
Chrome builds
v31 (Web Use row) and v32 (accounts) sent.	Ext	Done
P1	PRs	
Update PR descriptions
OGAD#176, desktop-pro#90 and ext#9 with screenshots and test output for God and accounts.	All	Open
P2	Extension	
Remaining OGAM audit
Expandable rows, edit and resend details, history rename and delete confirm, generation details setting, attachment thumbnails.	Ext	Open
P2	Builds	
Next Chrome build
v33 with the Agent next-step suggestion.	Ext	Open
P3	Tests	
Real-desktop end-to-end rerun
Blocked here by the model cold-loading too slowly in this container.	Ext, OGAD	Blocked
P3	Tests	
Packaging checks
Need a packaged app build; run on a machine or CI that builds the app.	OGAD	Blocked
```
