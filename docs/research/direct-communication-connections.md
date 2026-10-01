# Direct communication connections for Off Grid AI Desktop

Research date: 30 September 2026. This report is for internal product and engineering use.

## RICE priority for consumer setup

These are planning assumptions for 100 knowledge workers over one quarter, not measured product usage. RICE = reach × impact × confidence ÷ effort. Reach is users per quarter; impact is 0.5–3; confidence is a fraction; effort is engineer-weeks for an initial direct reader, excluding provider approval time and full synchronization. Replace these values with customer data before making delivery commitments.

| Order | Connection | Reach | Impact | Confidence | Effort | RICE | Customer setup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Local files / Obsidian | 65 | 2 | 90% | 0.5 | 234 | Select a vault folder; no plugin or login required |
| 2 | Notion | 60 | 2 | 85% | 0.5 | 204 | Connect to the official MCP and approve access |
| 3 | Google: Gmail, Calendar, Drive, Contacts | 80 | 3 | 75% | 1 | 180 | One registered application sign-in; own-client alternative |
| 4 | Jira / Confluence | 45 | 2 | 85% | 0.5 | 153 | One official MCP sign-in; tenant approval can apply |
| 5 | Linear | 25 | 1.5 | 90% | 0.5 | 67.5 | Official MCP sign-in through the existing connector path |
| 6 | Microsoft: Outlook, calendars, OneDrive | 60 | 3 | 75% | 3 | 45 | One public-client Graph sign-in; tenant consent can apply |
| 7 | Slack | 55 | 2 | 65% | 2 | 35.8 | Official MCP after application and workspace access requirements are met |
| 8 | Dropbox | 30 | 1.5 | 80% | 1.5 | 24 | Registered app plus native PKCE sign-in |
| 9 | Trello | 20 | 1 | 80% | 1 | 16 | Registered public API key plus user approval |
| 10 | Other email / calendars | 30 | 2 | 60% | 3 | 12 | IMAP / CalDAV; provider-specific account setup |

The current implementation starts with the existing hosted MCP routes and Google API reader. The worktree now includes the local-vault reader described below. WhatsApp, WeChat, personal Teams history, and a complete social inbox have no verified universal consumer sign-in route under the direct-device rule. They must not appear as working one-click choices.

## Onboarding implementation, 30 September 2026

Changes are isolated in the attached Desktop worktree and its private Pro checkout. An optional **Connect your work** step follows device setup. The same controls are available in Integrations. The generic core owns sign-in state, cancel, retry, and failed-record cleanup. Pro owns Google client settings, direct OAuth, and Gmail / Calendar / Drive / Contacts REST tools. The core-only build does not acquire a Google provider implementation.

Google presents **Connect with Off Grid AI** and **Use your own client**. A grouped connection requests read scopes once and verifies all four APIs. Drive lists files with pagination and exports supported text documents, with a 2 MB read limit; binary files return metadata. Contacts retain pagination cursors. New quick connections stay disabled until verification succeeds and skip automatic memory imports. Existing connections retain their previous import policy.

Shared UI selection: `wednesday-solutions/component-library-animations`, commit `ca35d2f9004b212ea034b73109fcd2819a08816b`, consumed through the `@offgrid/operator-ui` alias to avoid collision with the headless `@offgrid/ui` package. Production `Button`, `Card`, `Label`, and `NativeSelect` provide real props, keyboard support, loading state, and reduced motion. The main-branch previews and timer-based demo buttons were rejected. The existing own-client side panel remains the form owner. New controls use Off Grid design tokens and Phosphor icons.

Credential check (30 September 2026): Google Cloud Console confirms the existing Off Grid AI registration is a public Desktop client. Its ID and enabled application credential match the user-authorized saved configuration. Both are configured in the ignored worktree `.env.local`, with `GOOGLE_OAUTH_CLIENT_TYPE=desktop`; the build includes them only in the main process. Release builds must receive the same Desktop configuration. Customers can use Connect with Off Grid AI without supplying developer credentials, or select their own client. OAuth uses the system browser, PKCE, a local callback, and protected local token storage. All service traffic goes directly to Google. The project is External and In production, but Google still requires verification for the requested scopes and shows a 100-user cap. The owner will complete verification. The configured build passed and the worktree app was restarted; real Google account sign-in remains to be reviewed.

Validation covers rendered onboarding and provider choices, successful setup, failure cleanup, retry, cancellation, PKCE, partial grants, direct API execution, encrypted storage, and provider schema discovery. No end-to-end app run or screenshot was performed: repository instructions require an explicit user request. Both the Pro and core-only production builds passed. 63 product tests and 7 database integration tests passed. Changed implementation files passed lint with zero errors. Pro type checking passed. The full core type check reports an existing `ActiveChatStreamContract` / `ChatStreamPhase` mismatch for video phases in unchanged files. Worktree dependency copies required the shared sync package's own version of `@noble/hashes` and `xstate`; these fixes touched ignored dependencies only.

## Current scope: knowledge-worker sources through MCP or APIs

Direct APIs and MCP are both acceptable. Use one Off Grid connection interface across platforms, but do not require a local MCP server for a provider whose API is already simple to call. The device can call a source-operated MCP endpoint or a source API directly. Wrap either route in the same account, tool, action, and retention model. No third-party hosted connector is needed.

The scope now covers email, calendar, messaging, task tools, notes, and files. Additional useful categories are meetings and transcripts, contacts, browser bookmarks and selected pages, developer work such as issues and pull requests, and CRM records. These are product categories, not commitments to implement every application. Prioritize the sources used by the selected customer group rather than treating all knowledge workers as one market.

### Revised priority across the broader scope

This order supersedes the communication-only rankings below. Effort is a relative judgment based on the inspected Desktop code and documented connection routes. Reach is expected coverage, not measured user demand. Complete sync, platform packaging, and permission work can raise the cost beyond an initial read tool.

| Priority | Source | Direct route | Relative effort | Why it comes here |
| --- | --- | --- | --- | --- |
| 1 | Gmail and Google Calendar | Existing REST provider | Low for initial tools | Reuse existing code and cover communication plus scheduling |
| 2 | Local files and Obsidian | Selected folders and Markdown files; optional local MCP tools | Low for a Desktop reader | No provider sign-in; one route also covers local documents and downloaded files |
| 3 | Notion | Official source-operated MCP with OAuth and PKCE | Low to medium for live tools | Existing generic HTTP MCP system can supply notes and shared knowledge without a new full REST client |
| 4 | Microsoft mail and calendars | Graph and public-client OAuth | Medium | Major work suite through one account; evaluate OneDrive and SharePoint as later file capabilities |
| 5 | Jira and Confluence | Official Atlassian Rovo MCP | Low to medium for live tools | One source MCP covers issues and shared documentation; tenant approval may add setup steps |
| 6 | Google Drive, including Google document exports | Drive API | Medium | Reuses Google identity work; selected-file access and full-drive access have different scope and verification costs |
| 7 | Slack | Official source MCP | Medium overall | Important work context; publication, access, and retention remain release dependencies |
| 8 | Dropbox | Direct API with PKCE | Medium | Supported native sign-in; add after common file import and change tracking exist |
| 9 | Trello | Direct REST and delegated API-token authorization | Low to medium | Straightforward board/card model; useful but narrower than a work suite |
| 10 | Other email and calendar providers | Shared IMAP and CalDAV adapters | Medium | Broad coverage, with more credential and compatibility friction |
| Later | Meetings, contacts, CRM, browser sources, and developer work | Source-specific API, MCP, or deliberate local import | Not yet estimated | Select a role and test demand before another wide provider expansion |

Obsidian stores its notes as Markdown files in a local vault folder. Start with user-selected read access; do not require an Obsidian plugin to read those files. A mobile sandbox can require a document picker or scoped file grant, so the same tool contract does not imply identical folder access on every device. A locally synced Dropbox or Drive folder is also useful, but it contains only the files present locally and does not prove complete cloud coverage. [Obsidian data storage](https://obsidian.md/help/data-storage)

Notion publishes `https://mcp.notion.com/mcp` and documents custom clients using OAuth with PKCE and dynamic client registration. This is a strong early MCP target. Its legacy open-source local server is no longer actively maintained. Live tools are the first deliverable; background import still needs a separate review of coverage, pagination, deletion, and allowed retention. [Notion custom MCP client](https://developers.notion.com/guides/mcp/build-mcp-client), [Notion connection guide](https://developers.notion.com/guides/mcp/get-started-with-mcp)

Atlassian documents `https://mcp.atlassian.com/v2/mcp` with interactive OAuth 2.1 and access to Jira, Confluence, and other Atlassian work. Use that source route first. Its separate Jira REST 3LO flow requires a client secret; the REST guide also warns against applications that collect API tokens or instruct customers to create individual 3LO apps. Do not use the current Google own-client setup as a general template for Jira. Tenant callback allowlists can still block a desktop sign-in. Do not assume this MCP includes Trello. [Atlassian MCP setup](https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/), [MCP OAuth](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/), [Jira REST authorization](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)

Google recommends the non-sensitive `drive.file` scope for files the user opens or shares with the application. It does not grant a complete Drive account view. Full-drive read access uses a restricted scope. Pick the product behavior before choosing the scope; a selected-file reader should not be called whole-drive sync. Native Google documents also need an export/read route rather than a normal binary download assumption. [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

Dropbox documents PKCE for public clients such as Desktop and mobile apps. It fits the direct-on-device rule without embedding a shared confidential secret. Resolve the file scope, app approval, change cursors, and content parser behavior as part of implementation. [Dropbox authorization](https://docs.dropboxapi.com/dropbox-api/docs/get-started/authorization)

Trello documents a public API key and a private user token obtained through delegated authorization. The key alone does not expose user data. Off Grid should register its application and let the user authorize it; users should not create their own developer application. Test safe callback delivery on each platform and keep tokens out of URL logs. Use periodic reconciliation rather than requiring a public webhook receiver on the user's device. [Trello API introduction](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/)

### Can social accounts provide one complete view?

Some services expose a user's feed, but there is no verified universal API for everything a user can see in every social app. Separate home feed, own posts, mentions, bookmarks, notifications, and direct messages in the capability model. Access to one does not establish access to the others. An MCP wrapper cannot supply data that its underlying provider denies.

| Social source | Verified route or limit | Product decision |
| --- | --- | --- |
| Mastodon | Timeline APIs include authenticated user timelines | Good first social feasibility target; test the selected instance's rules |
| Bluesky | Official protocol defines the requesting account's home-timeline query with pagination | Good API candidate; authentication, chat, notifications, and retention need separate checks |
| X | Official API exposes authenticated reverse-chronological home timeline and mentions | Feasible for these features; check access cost and developer terms before release; this is not the algorithmic feed |
| LinkedIn | Member feed management requires approved Community Management access | Approval-dependent; do not promise normal sign-in grants full home feed or inbox |
| Instagram | Meta's published API collection describes professional-account access and excludes consumer accounts for Facebook Login | Do not promise a general personal-feed aggregator; distinguish professional tools from consumer access |
| Reddit | Data API use is approval-dependent, including commercial eligibility | Resolve approved product use before prioritizing a consumer aggregator |

Mastodon's API describes user timeline access. Bluesky's official lexicon defines `app.bsky.feed.getTimeline`. X documents a home timeline from followed accounts that excludes algorithmic ranking and requires user authentication. These are concrete feed capabilities, not proof of a complete cross-service inbox. [Mastodon timelines](https://docs.joinmastodon.org/methods/timelines/), [Bluesky timeline definition](https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/getTimeline.json), [X timelines](https://docs.x.com/x-api/posts/timelines/introduction)

LinkedIn's member feed program requires approval. Meta's published Instagram collection describes professional-account restrictions; direct Meta developer pages remained partly inaccessible in this research. Reddit says approved use and commercial eligibility depend on app review. Consumer Facebook feed and inbox access was not verified here. Keep these as explicit limits or questions rather than unsupported complete-account promises. [LinkedIn access](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide?view=li-lms-2026-03), [Meta Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-15c537cd-a773-4b40-a87c-27829e49a439), [Reddit access rules](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)

Recommendation: deliver work context first. If social demand is strong, start a separate Mastodon/Bluesky experiment, then evaluate X. Present a combined view of the capabilities actually granted. Do not market it as every social feed and message in one place. No social accounts were connected for this research.

## Updated decision: one MCP interface across platforms

The product requirement is now a uniform MCP-based connection system across supported platforms and form factors. This changes the first-release order below. Mac EventKit remains an optional local adapter; it is not the common connection foundation. The checked Desktop build configuration targets macOS, Windows, and Linux. Other form factors were not inspected in this repository. The following mobile design is a proposal, not a claim of existing support.

**Recommended design:** bundle Off Grid-owned MCP adapters with the app. Each adapter calls the provider directly. Expose the same tool definitions, account identity, permission status, pagination, and result shapes to every Off Grid client. Reuse the existing Google REST implementation behind its MCP adapter. A service does not need to offer its own MCP endpoint for this to work.

The data path is `Off Grid client → on-device MCP adapter → source provider`. There is no hosted Off Grid connector. Source-operated MCP can also be used where supported, but it must pass the same account, action, and retention checks. A shared MCP interface does not make provider authorization or data-storage rules uniform.

Share the tool contract and provider logic where the runtime permits it. On Desktop, a bundled adapter can use the Electron runtime and an MCP stdio transport. Do not require a separate Node installation. On a mobile platform that cannot launch this process, embed the adapter and use a documented in-process MCP transport through that platform's SDK. Do not promise that the Desktop Node process can run unchanged on mobile. MCP permits custom transports that preserve its protocol semantics. [MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

Use platform-specific browser callbacks and protected credential storage behind common interfaces. Authenticate each device directly unless a provider-approved credential transfer is explicitly designed. Share provider configuration and data schemas; do not assume a Desktop loopback OAuth callback works in every form factor. Browser-only deployment needs a separate check of provider CORS and public-client rules. It cannot fall back to a hosted connector under this requirement.

Define a small common tool set: search messages, read a message or thread, list calendars, and list events. Add sending later through the existing action controls. Preserve provider-specific IDs and capabilities rather than pretending every service has the same features. Keep a separate resumable sync interface in the adapter: MCP tool access alone does not maintain a complete mailbox. A provider capability record must say whether local retention is allowed, unresolved, or prohibited.

### Priority: least effort and highest useful reach

These are relative engineering estimates, not measured development times or user-market statistics. The order weighs existing code, supported provider routes, setup friction, and the number of services covered. Registration and approval effort is shown separately because a small adapter can still have a long release dependency.

| Priority | Connection | Adapter effort | Release dependency | Expected impact and reason |
| --- | --- | --- | --- | --- |
| 0 | Shared bundled MCP adapter host and contract | Low to medium on Desktop; unmeasured on other form factors | Verify runtime and OAuth callback support on each target | Required once; gives every later provider the same client interface |
| 1 | Gmail and Google Calendar | Low for initial MCP tools; medium for complete sync | Google verification for default consumer sign-in | Highest reuse: existing direct REST, OAuth, and tool hooks already work as the base |
| 2 | Outlook.com and Microsoft 365 mail and calendars | Medium | App registration, publisher verification, and tenant consent | One Graph adapter supplies two major services through normal sign-in |
| 3 | Shared IMAP and CalDAV adapters | Medium | Provider credential and compatibility checks | Broad provider coverage: iCloud, Yahoo, Zoho, custom mail, and compatible calendar servers; setup is less simple than OAuth |
| 4 | Slack live tools through official source MCP | Low to medium client integration; medium overall | Published or internal app eligibility; confirm public-client flow and retention | Strong work-chat value with an existing source MCP endpoint; do not connect restricted search output to automatic memory import |
| 5 | Fastmail JMAP adapter | Low to medium after the common host | Provider OAuth registration; separate calendar credentials | Cleaner mail sync for one provider; IMAP already supplies a fallback |
| Hold | Telegram | High native packaging and lifecycle work | Resolve AI-use and participant-consent rules | A usable client library exists, but the unresolved policy blocks general AI import |
| Hold | Personal WhatsApp and WeChat | High and uncertain | No verified supported general inbox route in this research | Do not make unsupported client maintenance the foundation of the uniform system |

Slack's source server requires a registered, published or internal application; a generic MCP URL alone is not sufficient. Gmail's source MCP is still a restricted Developer Preview. These facts favor a bundled Google adapter and a conditional official Slack adapter. [Slack MCP eligibility](https://docs.slack.dev/ai/slack-mcp-server/), [Gmail MCP preview](https://developers.google.cn/workspace/gmail/api/guides/configure-mcp-server?hl=en)

**First concrete deliverable:** wrap the current Google provider in the common MCP contract and prove the same search and event calls on macOS, Windows, and Linux. Then add Graph without changing the client-facing contract. Validate another form factor's embedded runtime before claiming full portability. EventKit can later expose the same calendar tools on Mac, but must remain an optional capability rather than a requirement for all clients.

The sections below retain the detailed provider evidence. Their earlier Mac-first order addressed minimum setup on this Desktop app; the updated MCP-first order above controls the current recommendation.

Off Grid can connect directly to email, calendar, and some messaging services. The best general design is a provider module in the Electron main process. That module calls the source service and supplies tools to the existing connection system. The proposed design keeps credentials, imported data, and AI processing on the device.

The first work should reuse the existing Mac calendar reader, add Microsoft mail and calendar access through Microsoft Graph, and reduce Google setup steps with a registered desktop OAuth application. Slack is feasible, but its publication and data storage rules affect the design. Telegram is technically feasible but has a material AI use restriction. Personal WhatsApp and WeChat do not have a verified general inbox API that meets the requirements in this research.

Recommendations in this report are engineering judgments. They are not results from live account tests. Provider facts have links to their sources. Proposed setup steps and implementation choices are identified as proposals.

## Scope and direct connection rule

The requirement is interpreted as follows: Off Grid may contact the user's source service, such as Google or Microsoft, from the device. It must not send data through an Off Grid server, a connector service, or a cloud AI service. Without contact with the source service, the app can read only data already available on the device.

Three paths meet this interpretation:

1. Off Grid calls the provider's API directly.
2. Off Grid calls a local operating system API or a local provider program.
3. Off Grid calls an MCP endpoint operated by the source provider, if its terms permit the use.

A third-party hosted MCP server does not meet this rule. A local MCP program may meet it, but only if its actual network requests go directly to the source. A local process can still send data elsewhere. MCP does not establish the data path or remove provider permission requirements. The protocol supports both local standard input/output and HTTP transports. [MCP transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)

For the default consumer product, prefer a built-in provider module over a program that the user must install with Node, Python, Docker, or a terminal. Keep custom local MCP connections as an advanced option.

This report covers reading data, searching it, keeping a local copy where permitted, and later communication actions. It distinguishes these tasks from letting a user send commands to Off Grid through a bot. A bot chat does not usually grant access to the user's full inbox.

## Existing code and what to reuse

The managed worktree uses core commit `9a5181f3a3c5a2eb9b5ce637cc0ee655a8d703a8` and Pro commit `08531ba6521de1b6b3e257ece01269cde88bc585`. It starts from the repository's remote default branch. The Google client and REST files were also compared with the original checkout. Those files had no differences. No application code was changed.

| Existing file | Observed behavior | Effect on the proposal |
| --- | --- | --- |
| [Google client](../../pro/main/google-client.ts) | Each user supplies a Google Web application client ID and secret. One client serves Gmail and Calendar. | Reuse the direct data path. Do not make this setup the default for every new service. |
| [Google REST module](../../pro/main/google-rest.ts) | Calls Gmail v1 and Calendar v3 directly. Refreshes and retries once after HTTP 401. | This is the main pattern for new provider modules. |
| [Provider registration](../../pro/main/index.ts) | Registers `HOOKS.mcpConnectorToolSource` for Google tools. | Provider-owned tools can use REST without running an MCP server. |
| [Core connection system](../../src/main/mcp.ts) | Stores connection records. Supports HTTP and local processes. A `ConnectorToolSource` owns tool definitions, verification, and execution. | Keep this common interface. Provider implementations belong in Pro. |
| [OAuth provider](../../src/main/mcp-oauth.ts) | Uses the system browser, state, PKCE, and a local callback. Static client configuration currently requires a secret. | Generalize static public-client configuration for Microsoft, Slack, and other native clients. |
| [OAuth callback](../../src/shared/mcp-oauth-callback.ts) | Uses `http://127.0.0.1:33418/callback`. | Keep existing Google Web clients working. Add provider-specific native redirect configuration. |
| [Secret store](../../src/main/secrets.ts) | Stores encrypted blobs in SQLite. Electron `safeStorage` uses an OS-held encryption key. | Reuse it. Credentials are not each stored as a separate Keychain entry. |
| [Memory import](../../pro/main/ingest.ts) | Imports Google data and has a Slack adapter for named MCP tools. | Add explicit provider import methods. Do not infer all sync behavior from arbitrary tool names. |
| [Service timer](../../pro/main/services.ts) | Starts connection refresh after about one minute and repeats every 30 minutes. | Add per-provider cursors and schedules. Retain a visible last successful sync time. |
| [Native actions helper](../../scripts/actions-helper/main.swift) | Already reads calendar events with EventKit, creates events, and sends mail with AppleScript. | Reuse the existing native boundary for Mac calendars. Mail reading still needs separate work. |
| [Native action mapping](../../src/main/actions/semantic-rail.ts) | Maps calendar lookup to `calendar.listEvents`. | A native calendar connection does not require a second standalone helper. |
| [Action control](../../src/main/actions/chat-connector-action.ts) | Routes chat connection mutations through the durable action engine. | Keep sending and calendar changes on this route. |

The present Google tools are narrower than a full email or calendar client. Gmail search returns up to 20 messages, with headers, snippets, and links. It does not return full message bodies or attachments. Calendar reads the primary calendar, with a default 14-day range and a result limit of 50. These functions do not follow result pagination or maintain change cursors.

The Google memory import turns these results into observations. A richer connection needs stable source IDs, update handling, deletion handling, and a complete account identity. Repeatedly importing a short recent list is not sufficient to maintain a complete local mailbox.

There is also an existing Slack import. It looks for `slack_get_channel_history`, resolves users, selects channels where the bot is a member, reads up to 12 channels, and stops after 50 messages. It is a bot-oriented path. It is not a complete personal Slack connection, and the official Slack MCP tool set must be mapped explicitly.

Two current behaviors need attention before broader messaging import. The importer logs the start of generic tool results and a sample Slack history result. These logs can contain message data. The service timer also runs connection sync before it checks whether screen capture is paused. Capture pause therefore does not pause connection import. Add a clear per-account sync control, and decide how a global pause should affect it. Remove content samples from normal logs before enabling sources that prohibit retention.

## Service comparison

The setup ratings below are estimates for the proposed product. Low means normal sign-in or one OS permission. Medium means an app password, local program, or workspace approval. High means developer setup or an unsupported protocol. The detailed sections contain the source evidence and conditions.

| Service | Preferred direct path | Consumer setup | Main limit | Recommendation |
| --- | --- | --- | --- | --- |
| Calendars already on the Mac | Existing EventKit helper | Low if accounts are already configured | Mac only; OS controls refresh | Start here |
| Gmail | Direct Gmail API and desktop OAuth | Low after Off Grid verification; high with current own-client setup | Restricted scopes and verification | Keep REST; improve sign-in |
| Google Calendar | Direct Calendar API; EventKit as a Mac option | Low after application setup | Calendar selection and complete sync need work | Expand existing module |
| Outlook.com and Microsoft 365 mail | Microsoft Graph and public-client OAuth | Low for personal accounts; may need work administrator approval | Organization consent policy | First new network provider |
| Microsoft calendars | Same Graph account; EventKit when configured on Mac | Low to medium | Shared calendar and tenant limits | Add with Microsoft mail |
| Fastmail | JMAP OAuth for mail; CalDAV for calendars | Low after provider registration; medium with a token | Calendar credentials need separate verification | Good second email provider |
| iCloud Mail | IMAP and SMTP with an app password | Medium | New Apple account authorization is not yet verified for Off Grid | Use standards fallback |
| Yahoo and AOL | IMAP and SMTP with an app password | Medium | Password availability and provider OAuth approval | Add provider presets |
| Zoho and other IMAP mail | IMAP; provider REST when useful | Medium | Plan, region, and administrator settings | Support through shared mail adapter |
| Proton Mail | Local Proton Mail Bridge and IMAP | Medium | Paid plan and Bridge installation | Optional local integration |
| Other calendars | CalDAV or a selected calendar feed | Medium | Feed may be read-only or delayed | Shared calendar adapter |
| Slack | Source-operated MCP or direct API with user OAuth | Low after publication and workspace approval | MCP eligibility, rate limits, and retention rules | Feasibility work before release |
| Telegram | TDLib as a user client | Low to medium technically | AI use and participant consent terms | Hold general AI import |
| Personal WhatsApp | No verified official general inbox path; local linked-device libraries exist | QR setup can be simple | Unsupported clients, account blocks, incomplete history | Optional research only |
| WhatsApp Business | Direct Meta API | High for consumers | Business setup and inbound delivery design | Separate business product |
| WeChat personal chats | No verified supported inbox route found | High or uncertain | Web login eligibility and unavailable official evidence | Defer automatic sync |
| Teams work chats | Microsoft Graph | Medium | Work accounts and broader permissions | Later Microsoft extension |
| Matrix | Direct client-server API | Medium | Encryption keys and homeserver policy | Good open-protocol extension |
| Signal | Local `signal-cli` | Medium | Community client and frequent maintenance | Experimental extension |
| Discord | Official bot API | Medium | Bot access is not personal inbox access | Limit to bot-visible spaces |

## Google mail and calendars

### Preserve the direct REST path

The existing Google data path fits the requirement. Keep it as the production basis. The Gmail MCP guide still identifies the server as a Developer Preview and requires program membership. MCP also adds service setup that is not needed for the current REST functions. [Gmail MCP configuration](https://developers.google.cn/workspace/gmail/api/guides/configure-mcp-server?hl=en)

### Reduce setup through a desktop application

Proposed default: Off Grid registers and verifies its own Google Desktop application. The user selects Connect, signs in through the system browser, and grants the selected service access. Authorization code exchange and token refresh occur on the device.

Google supports PKCE and a local loopback redirect for desktop clients. A distributed native client cannot keep an application secret confidential. An application registration identifies Off Grid to Google; it does not require an Off Grid data server. Google also says installed applications do not support incremental authorization. Design mail and calendar grants with that limit in mind. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

Retain the user's own client as an advanced option. Do not silently convert an existing Web application registration to Desktop type. Its callback rules and saved tokens belong to the existing client.

Current own-client setup has a recurring friction point: an External consent screen in Testing issues refresh tokens that normally expire after seven days when mail or calendar scopes are requested. This can cause frequent reconnects. It is a provider behavior, not necessarily a token storage defect. [Google token expiry rules](https://developers.google.com/identity/protocols/oauth2#expiration)

### Verification and access level

`gmail.readonly` is a restricted scope. `gmail.metadata` is also restricted; changing to metadata does not remove restricted-scope verification. `gmail.send` is a separate sensitive scope. Request it only when sending is added. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) The metadata scope also does not support Gmail's `q` search parameter. [Gmail message search parameters](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)

Google's restricted-scope guide requires an assessment when the application can access restricted data from or through a third-party server. Local processing is relevant to this assessment, but it is not a promise of approval or exemption. Document the complete data path, including optional remote models, sync, crash reports, and backups, before making a verification claim. Confirm the assessment decision with Google's verification team. [Restricted-scope verification](https://developers.google.cn/identity/protocols/oauth2/production-readiness/restricted-scope-verification?hl=en)

Google lists email productivity features, including generative AI summaries, as an approved Gmail use case. Its data policy also requires clear disclosure, limited access, secure handling, and deletion support. Do not use imported mail to train a general model. [Google Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

For Calendar, request only the event and calendar-list scopes needed by the released features. The current module asks for free/busy access as well. Review whether the current REST tool uses it before carrying that request into a new application registration. [Calendar scope reference](https://developers.google.com/workspace/calendar/api/auth)

### Complete the sync model

Proposed next steps are full bodies on demand, selected folders or labels, pagination, and a stable source record before summary generation. Keep Gmail's `historyId` for partial sync. If the history cursor is no longer valid, perform a bounded full sync. [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)

For Calendar, add calendar selection and per-calendar sync tokens. Process deleted events and invalid token recovery. The current moving date window must not simply be combined with a sync token; use request parameters that the API permits and a stable sync query. [Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)

## Microsoft email and calendars

Outlook is an application and product name. Microsoft-hosted Outlook.com, Hotmail, Live, and Microsoft 365 mail can use one Graph provider. A Gmail account shown inside Outlook still belongs to Google. An on-premises Exchange mailbox is a separate case.

Microsoft supports authorization code with PKCE for desktop public clients and supports both personal and work or school accounts. Register an Off Grid application for the required account types. A public client does not need a shared application secret. [Microsoft authentication flows](https://learn.microsoft.com/en-us/entra/identity-platform/authentication-flows-app-scenarios)

Proposed implementation: use `@azure/msal-node` in the main process for sign-in and token management. Microsoft supplies an Electron system-browser example. Store the MSAL token cache with the existing protected storage. Use silent token acquisition after the initial sign-in. Do not copy the example's plaintext file cache into the product. [Microsoft Electron example](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/samples/msal-node-samples/ElectronSystemBrowserTestApp/README.md), [MSAL token acquisition](https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests)

Use delegated permissions. For the present Gmail-equivalent experience, use `Mail.Read` because `Mail.ReadBasic` excludes the body and preview. `Calendars.ReadBasic` can cover basic event details; use `Calendars.Read` if the released feature needs event bodies. Add `Mail.Send` or `Calendars.ReadWrite` only with the relevant action. `Mail.ReadWrite` does not itself grant sending. Shared resources have separate permissions and account limits. [Graph permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference)

Proposed initial endpoints are `/v1.0/me/messages`, `/v1.0/me/mailFolders`, `/v1.0/me/calendars`, and a bounded calendar view. Use API pagination and per-resource change cursors. Calendar delta tracks a defined calendar view; retain its date range as part of the cursor state. [Calendar delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0)

Microsoft publisher verification can reduce consent friction. It cannot override an organization's policy. A tenant can require administrator approval even for delegated permissions that do not normally require it. Show that state clearly and retain the completed local setup. Do not ask the user to repeat sign-in without a change in policy. [Publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)

Do not build a new Exchange Online connection around EWS. Microsoft's current guidance says phased disablement starts on 1 October 2026 and permanent retirement is on 1 April 2027. This does not mean on-premises Exchange has the same retirement date. [Microsoft EWS retirement guidance](https://learn.microsoft.com/en-us/skypeforbusiness/hybrid/prepare-for-ews-retirement)

Proposed user steps: select Microsoft, sign in, choose Mail and/or Calendar, then choose the import scope. Users should not need to create an Azure application. Keep an own-client option for organizations that require it. Never borrow Microsoft Office or another application's client ID to avoid registration.

## Mac calendars and other calendar services

### Reuse EventKit first

The native helper already calls `requestFullAccessToEvents` on macOS 14 and later, then reads events in a specified date range. Older macOS uses the earlier request method. The app build configuration already contains calendar permission descriptions.

Apple's Calendar supports iCloud, Google, CalDAV, and Exchange accounts. Thus, a local EventKit connection can cover several providers when the account is already configured on the Mac. It reads the OS calendar store. Off Grid does not need the provider's password or OAuth token. [Mac calendar accounts](https://support.apple.com/guide/calendar/add-calendars-and-calendar-accounts-icl4308d6701/mac)

Reading existing events requires full calendar access under the newer permission model. This permission also allows writing; the OS does not supply an equivalent read-only event grant. Keep Off Grid's default tools read-only even though the OS permission is broader. [Apple calendar access levels](https://developer.apple.com/documentation/technotes/tn3152-migrating-to-the-latest-calendar-access-levels)

Proposed work: extend the existing helper to enumerate calendar IDs and sources, accept a calendar selection, and return source identifiers, time zones, locations, and attendees where available. Use the current helper invocation boundary. Verify permission attribution in the signed app when implementation begins.

The existing helper is a one-shot process. It cannot retain `EKEventStoreChanged` subscriptions after it exits. Begin with a small periodic local read. Add a persistent native component only if update speed requires it. EventKit supplies store-change notifications for a running client. [EventKit access guide](https://developer.apple.com/documentation/eventkit/accessing-calendar-using-eventkit-and-eventkitui?changes=_7)

Limit: Off Grid cannot promise a provider refresh time from a local store read. macOS owns account sync. If the user has not added an account, adding it through Calendar or Internet Accounts is an extra step. Direct Google or Graph access remains useful for those users.

### CalDAV and calendar feeds

Proposed second path: one CalDAV adapter for providers such as Fastmail and compatible self-hosted services. Use discovery, selected calendars, event UIDs, recurrence IDs, and ETags. Detect supported change-sync features rather than assuming every server has them. `tsdav` is a candidate TypeScript client; it needs a provider compatibility check before adoption. [tsdav documentation](https://tsdav.vercel.app/docs/)

An ICS file import is a simple offline fallback. A subscribed calendar URL is a read-only network source and can update slowly. Treat a private feed URL as a credential. Do not present it as a full calendar account connection. Proton offers calendar sharing by link; that does not establish a CalDAV account API. [Proton calendar sharing](https://proton.me/support/share-calendar-via-link)

Do not import the same calendar twice through EventKit and a direct API. Let the user select one source route. Matching an event by title and time alone is not a safe general deduplication rule.

## Other email providers

### Shared IMAP and SMTP support

Build a common direct mail adapter. IMAP handles reading and folder state. SMTP handles sending. Add provider presets and an advanced server form. Use TLS and normal certificate validation. A provider domain or MX record alone is not enough to identify all server and authentication settings safely.

`ImapFlow` is a candidate for direct IMAP access. It supports message retrieval, searching, mailbox management, and IMAP extensions. Use the library without deploying the separate EmailEngine service. [ImapFlow](https://imapflow.com/)

For proposed sync state, keep mailbox identity, `UIDVALIDITY`, UIDs, and the server's supported modification state. Use read operations that do not mark mail as read. Use IDLE while the app runs where supported, with reconnect and periodic reconciliation. Do not keep every account connection active without a resource budget.

`Nodemailer` is a candidate for SMTP. Keep protocol debug logging disabled for customer data. For attachments, use validated local inputs and disable arbitrary file or URL access. Sending must use the app's action controls. [Nodemailer SMTP](https://nodemailer.com/smtp)

### Fastmail

Fastmail documents JMAP mail access, OAuth with PKCE, loopback redirects, API tokens, and CalDAV calendar access. Register Off Grid for the consumer OAuth path. An API token is a useful advanced fallback. The OAuth documentation does not prove that the resulting JMAP token can also authenticate CalDAV; verify that separately. [Fastmail developer documentation](https://www.fastmail.com/dev/)

Recommendation: use JMAP for Fastmail mail instead of IMAP if this provider is built as a dedicated module. Its structured API fits a local account and change-state model. Do not assume Fastmail calendars have the same production JMAP interface as its mail. Use CalDAV for the documented calendar route.

### iCloud Mail

An app-specific password is the verified fallback for IMAP and SMTP. It requires two-factor authentication on the Apple Account. The user creates a password for Off Grid and can revoke it. Do not request the main Apple Account password. [Apple app-specific passwords](https://support.apple.com/en-us/102654)

Apple now also documents account authorization for supported third-party Mail, Calendar, and Contacts apps. It is therefore inaccurate to say all iCloud access always requires an app password. However, that support page does not establish a public registration process that Off Grid can use today. Treat direct Apple account authorization as a provider inquiry, not a ready implementation. Generic Sign in with Apple is not evidence of mail access. [Apple third-party account authorization](https://support.apple.com/en-us/121539)

For iCloud calendars on Mac, prefer EventKit. It avoids a second credential setup when the account is already configured.

### Yahoo and AOL

Use the shared mail adapter with an app-password setup guide. Yahoo documents that third-party apps with older sign-in methods need an app password. Availability and account restrictions must be checked in the product's feasibility test. [Yahoo secure access](https://uk.help.yahoo.com/kb/SLN27791.html)

Yahoo also documents an OAuth registration with a consumer key and secret. Do not assume this server-oriented flow can be shipped as a secret-free native flow, or that mail access is automatically approved for a new application. Resolve these questions before promising one-click Yahoo sign-in. [Yahoo OAuth flow](https://developer.yahoo.com/oauth2/guide/flows_authcode/)

### Zoho and custom domains

Zoho documents both REST OAuth and IMAP access. Its IMAP help describes account settings and plan limits. Use the shared adapter first, with the correct regional server and a clear explanation if IMAP is disabled. Add REST only if it materially reduces setup or supplies a required capability. [Zoho IMAP](https://www.zoho.com/mail/help/imap-access.html), [Zoho OAuth](https://www.zoho.com/mail/help/api/using-oauth-2.html)

### Proton Mail

Proton Mail Bridge provides local IMAP and SMTP to desktop clients. It requires a paid Proton Mail plan. Off Grid can connect to Bridge on the same device; Bridge handles the Proton connection and mail decryption. The user must install and sign in to Bridge and enter its local connection credentials. [Proton Bridge setup](https://proton.me/support/imap-smtp-and-pop3-setup)

Keep Bridge's local credentials protected. Do not expose the local mail port on the network. Do not assume Mail Bridge also supplies a Calendar API. Use a separate calendar path if needed.

### Apple Mail as a local source

The native helper already sends mail through AppleScript, but it does not read mail. A selected-mail import or bounded Apple Mail reader is a reasonable feasibility experiment for users who already have accounts configured.

This is a proposal, not verified inbox support. Check the Mail scripting dictionary, Automation permission, retrieval performance, attachments, and whether requested bodies are already downloaded. Prefer supported scripting over reading the Mail app's private database. Do not copy another app's account tokens. Do not require Full Disk Access merely to avoid a provider sign-in flow.

## Slack

### Direct desktop sign-in is now supported

Slack's current PKCE documentation supports desktop public clients without a client secret. Desktop redirects may request user scopes, not bot scopes. Custom schemes require PKCE. The documented public-client flow also changes token rotation behavior, and PKCE refresh tokens expire after 30 days. The product must handle that expiry and concurrent refresh safely. [Slack PKCE](https://docs.slack.dev/authentication/using-pkce/)

This changes the recommendation from older Slack integrations. An Off Grid-owned public application can remove developer credential setup for the user. It still requires registration, correct scopes, and workspace permission. The dedicated user token exchange is documented for MCP clients. [Slack user token exchange](https://docs.slack.dev/reference/methods/oauth.v2.user.access/)

### Official MCP is a direct source option

Slack supplies `https://mcp.slack.com/mcp` over Streamable HTTP. It does not support dynamic client registration. Only published directory applications and internal applications may use it; unlisted distributed applications are prohibited. Its server offers search, message reading, and actions. This is source-operated MCP, so it can fit the direct connection rule. [Slack MCP overview](https://docs.slack.dev/ai/slack-mcp-server/)

Proposal: test the official MCP path first for live chat tools, using an internal test application. For consumer distribution, resolve Marketplace eligibility and publication. Configure a fixed public client and the correct user OAuth endpoints. Do not use the current generic dynamic-registration assumption unchanged.

### Live search and saved memory need different designs

Slack's Real-time Search API supports user queries from outside Slack through a user token. It restricts access to published or internal applications. It prohibits storing or copying retrieved data, training use, and scraping unrelated to user queries. It also requires an in-Slack experience under its general usage guidelines. [Slack Real-time Search](https://docs.slack.dev/apis/web-api/real-time-search-api/)

Recommendation: keep this route for live, user-requested context. Do not send these results to `recordObservation`, embeddings, persistent model history, or paired-device sync. A local disk copy is still a copy. Confirm how these rules apply to official MCP search results and derived summaries before retention is enabled.

For a separate Conversations API import, confirm the applicable Slack agreement and approved product use. Do not infer a right to store an entire workspace from possession of an OAuth token. The current Slack memory import must not automatically run for a new official MCP connection.

### History limits and bot alternatives

`conversations.history` has a limit of one request per minute and 15 objects for affected new commercially distributed non-Marketplace applications or installations. Marketplace and internal applications have different limits. User tokens and bot tokens also have different conversation visibility. [Slack history method](https://docs.slack.dev/reference/methods/conversations.history/)

At 15 messages per minute, 10,000 messages require about 667 minutes, or 11.1 hours, before retries and extra thread requests. This is a calculated lower-bound example, not a benchmark. It makes full history import a poor default for that application class. Check thread limits independently. MCP must not be treated as a way to evade API limits.

Socket Mode receives events through an outbound WebSocket without a public callback. However, it needs an app-level token, and Socket Mode applications cannot currently be listed in the public Marketplace. It is useful for a user's own internal app, not a shared app-level secret embedded in every consumer installation. [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)

Recommended Slack order: direct live search and selected-thread reads, then approved communication actions, then a separately approved retained-memory design if Slack permits it.

## Telegram

TDLib is Telegram's official client library. It handles networking, encryption, and local storage. It is a better base for a user-account connection than a bot API wrapper. [Telegram TDLib](https://core.telegram.org/tdlib)

QR authentication is available through TDLib. It can reduce setup steps when the user already has Telegram on a phone. The login state machine must still handle password and other account challenges. Off Grid needs its own application API identity. A user should not need to create a developer application for the default product. [TDLib QR authentication](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1request_qr_code_authentication.html), [Telegram application registration](https://core.telegram.org/api/obtaining_api_id?source=post_page---------------------------)

The material limit is policy. Telegram's content terms prohibit broad scraping, indexing, aggregation, and use for AI development or deployment. The stated exception requires explicit, informed, affirmative, continued consent from all relevant users for the specific content or chat context. One account holder's connection consent does not establish that condition. [Telegram content terms](https://telegram.org/tos/content-licensing)

Recommendation: hold general AI inbox ingestion until Telegram clarifies the intended use and consent process. A non-AI client capability and a scoped conversation where the required consent exists are different product cases. Local inference alone does not remove the restriction.

If this is resolved, run TDLib as a managed local component and keep sessions and keys protected. It needs a persistent lifecycle, unlike the current on-demand MCP process. Do not assume cloud chat history also grants access to secret-chat history on another device. A Telegram bot can provide a command interface to Off Grid, but cannot substitute for the user's inbox.

## WhatsApp

### Personal inbox and agent chats are different

WhatsApp now documents third-party agents. They can read only what the user shares with them, cannot join or access other chats, and are available only in limited countries. This is useful for an Off Grid command interface, but not for personal inbox access. [WhatsApp third-party agent help](https://faq.whatsapp.com/1050934623978152)

The agent terms were updated on 25 August 2026. They state that agent conversations are not end-to-end encrypted personal conversations and use Meta's agent platform. These terms do not establish a device-only transport or a general personal inbox API. [WhatsApp agent terms](https://www.whatsapp.com/legal/third-party-agents-terms)

### Local linked-device libraries are technically possible

Baileys is a TypeScript library that uses a direct WebSocket connection. It supports QR or pairing-code authentication as another linked client and does not need a browser. It is not an official WhatsApp integration. [Baileys project documentation](https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/README.md)

`whatsapp-web.js` uses Puppeteer and a managed browser to access WhatsApp Web internals. Its project warns that account blocking remains possible. Packaging a second browser also adds a resource and maintenance burden to this Electron app. [whatsapp-web.js project documentation](https://raw.githubusercontent.com/pedroslopez/whatsapp-web.js/main/README.md)

Engineering judgment: if Off Grid chooses to fund an experimental personal WhatsApp connection, evaluate Baileys first. It offers the simpler local architecture. The experiment must prove reconnect behavior, session key storage, history completeness, message edits, deletion, disappearing messages, and account stability. It must not claim provider support or complete history access.

A local MCP wrapper does not change those limits. It only exposes the same unofficial client through tools. Do not use a managed cloud bridge to reduce setup steps under this task's direct connection requirement.

Recommendation for the normal product: offer deliberate local import of selected user-provided messages or exports. Keep continuous personal WhatsApp sync outside the first release. This is a product reliability decision; the research did not establish that a direct local implementation is impossible.

### Business API and new business MCP

WhatsApp Business API access serves a business account, not arbitrary access to a consumer account. A direct implementation must resolve business registration, phone number setup, permissions, and inbound message delivery. Receiving webhooks on a consumer Mac behind a router is a substantial obstacle under a strict no-relay rule. An external tunnel would add another service to the data path.

Meta's developer overview required login or returned rate-limit errors during this research. Its official SDK provides a separate Cloud API setup route. Business account coexistence, current AI-provider restrictions, and the newly reported business-management MCP were not verified from accessible primary documentation. Do not use older blanket claims about WhatsApp AI bans or assume that business-management MCP grants personal inbox access. These remain provider questions. [Meta Cloud API SDK](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/), [Meta developer overview requiring access](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview)

## WeChat

No supported general personal WeChat inbox API was verified. Official Account and WeCom documentation could not be read through the research tool. Their product names must not be treated as proof of access to personal WeChat conversations. This is an evidence gap, not a categorical proof that no such capability can exist.

The local Wechaty Web provider is a real candidate, but its own documentation warns that accounts registered after 2017 may be unable to log in to Web WeChat. It also reports contact and room IDs changing between sessions. Those limits make it unsuitable as a predictable default for new consumers. [Wechaty Web provider](https://wechaty.js.org/docs/puppet-providers/wechat)

Recommendation: defer automatic personal sync. Investigate supported user export or selected-content import. Evaluate a local UI read only for an explicit user task, using the existing opt-in capture controls and visible indicator. Do not describe screen content as a complete inbox. Do not extract process keys or patch the WeChat application as the default product design.

Treat WeCom as a separate business request. Before scoping it, verify the archive product, administrator setup, participant consent, IP restrictions, supported SDK platforms, and whether the data can travel directly to the Mac. Do not buy a hosted Wechaty provider unless its data path is acceptable; some provider designs add a remote service.

## Other communication systems

Teams can extend the Microsoft provider for work accounts. Graph lists chat messages with delegated `Chat.Read`; personal Microsoft accounts are not supported by that API. Channel messages use different permissions and require separate access work. Mail consent alone does not grant Teams messages. [Graph chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0), [Graph channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)

Matrix has a direct client-server protocol for authentication, sync, messages, and device encryption. It fits the proposed architecture well. The main work is a full local client session, including key verification and recovery for encrypted rooms. A Matrix bridge to WhatsApp or WeChat is a separate data path; do not assume that it meets the same requirement. [Matrix client-server specification](https://spec.matrix.org/latest/client-server-api/)

Signal can use the community `signal-cli` program locally. The project supports linking an existing account and a JSON-RPC daemon. It also warns that releases older than three months may fail after server changes. This adds runtime packaging and maintenance work. Treat it as an optional experiment, not a low-maintenance official provider API. [signal-cli documentation](https://github.com/AsamK/signal-cli/blob/master/README.md)

Discord supports bot automation. It forbids automating a normal user account as a self-bot outside the supported OAuth or bot API. A bot connection can cover permitted server channels; it does not provide a general copy of the user's private inbox. [Discord self-bot policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)

## Proposed shared architecture

Keep provider code and paid memory behavior in `pro/`. Reuse the generic core hooks and tools. Any new core boundary should remain inert when Pro is absent. No Pro implementation should be added to the public core to make a single provider easier.

Use an explicit provider identifier. Today, a Google connection's MCP URL also selects its REST behavior. A provider ID is clearer for Graph, IMAP, CalDAV, and native sources, which may not have a meaningful MCP URL.

A proposed provider module needs these operations:

- Connect an account, cancel an attempt, and report granted access.
- Verify a small authenticated read.
- Enumerate selectable folders, calendars, or conversations.
- Supply tools for live reads and permitted actions.
- Import permitted records with pagination and a resumable cursor.
- Reconcile updates and deletions.
- Revoke access where supported and remove local credentials.
- Report account-specific status without exposing tokens or message bodies in logs.

Keep account authentication separate from service selection. One Microsoft account can supply Mail and Calendar while the user enables each service separately. Persist a stable provider account ID, tenant where applicable, granted scopes, and connection generation. Do not use a visible display name as the record's identity.

Keep live search separate from retained memory. Each tool result needs a retention rule supplied by the provider module: transient use only, permitted local retention, or retention not yet established. The memory importer must check this rule. Transient data must also stay out of persistent chat history, tool traces, embeddings, error dumps, and paired-device sync.

For retained data, store normalized source records before summaries. A proposed identity is provider, account, collection, item ID, and version. Calendar recurrence needs an occurrence identity as well. Keep deleted-record state long enough to remove derived observations. Advance a sync cursor only after records commit successfully.

Provider modules must report explicit tool risk and capability. The current generic MCP classifier uses the tool name to decide whether a call is a read. That can remain a fallback for advanced custom servers. Built-in modules know whether a call sends, changes, deletes, or only reads. They should use that knowledge.

Use a per-account sync lock and bounded requests. Apply `Retry-After`, backoff, cancellation, and sleep/wake recovery. Record the last successful sync separately from the last attempt. A denied token, blocked administrator consent, and a temporary rate limit need different status values.

For direct data retrieval, prefer polling change cursors over adding a public webhook server. Provider-specific outbound streams can reduce delay where available. The current 30-minute timer is a useful starting point, not a universal freshness promise. When the app is closed or the Mac sleeps, a device-only system cannot continue processing on an Off Grid cloud worker.

Enforce local AI processing for these sources. The fact that a request uses the shared `llm` interface does not alone prove that every configured model route is local. Check the selected execution route before supplying communication data. The same applies to embeddings and summaries. Do not send data to an optional remote model under this research's scope.

Allow only the provider's required network destinations, including auth, API, and documented content-download hosts. Validate redirect and pagination destinations before forwarding credentials. Do not automatically load remote images in email bodies. Keep message content as data; it must not authorize a new connection or a send operation.

The current local MCP launcher merges the parent process environment into the child environment. For managed provider programs, pass only the environment values they need. Do not give every local integration all parent environment values. A custom MCP program also needs an explicit installation and trust decision; local execution alone does not prove that its network path meets the requirement.

Disconnection and deletion are separate user choices. Removing a token does not remove already imported observations. Offer a clear local data removal path, including derived summaries and indexes. Retain the current opt-in and visible indicator requirements for any screen capture fallback.

## Proposed consumer setup

The default setup should have four stages:

1. Select the source.
2. Sign in at the provider or grant the OS permission.
3. Select the services and data scope.
4. Confirm the first small import and show its date range and result count.

Do not ask a normal consumer for client IDs, client secrets, MCP URLs, terminal commands, or Docker setup. Where a provider requires an app password, show the provider's own page and ask only for the minimum credentials. Keep own-client and custom MCP setup in an advanced path.

Proposed first import: a bounded recent range and selected folders or calendars. Show older history as an explicit choice with an estimated cost in time or disk space when the provider supports it. This is a product choice, not a claim that 30 days is a provider limit.

Show the account, selected data, data path, last successful sync, and access that needs renewal. Report a limited local calendar cache or a partial message history plainly. Avoid a green Connected status that implies complete data coverage.

## Implementation order and decision tests

### First release work

1. **Mac calendar connection.** Reuse the EventKit reader. Add calendar selection and a Pro import module. This offers the fewest setup steps for users with configured Mac accounts.
2. **Microsoft mail and calendars.** Register a public application, complete publisher verification, and build a Graph module with protected MSAL caching. This is the strongest new direct network provider.
3. **Google setup improvement.** Keep REST, add a verified Desktop application path, and retain the own-client path. Add selected calendars, paging, and change tracking.
4. **Shared IMAP and CalDAV.** Add iCloud, Yahoo, Zoho, and custom-provider presets. Add Proton Bridge as a named local option.
5. **Fastmail.** Add JMAP OAuth if demand justifies a dedicated mail module.

### Separate feasibility work

- **Slack:** prove public-client login, refresh, MCP eligibility, account visibility, and live search without persistent copies. Resolve approved retained-memory use before connecting the autosync importer.
- **Telegram:** obtain provider clarification on AI use and consent before general import work.
- **Personal WhatsApp:** evaluate a direct local linked client only as an optional experiment with an explicit support limit.
- **WeChat:** obtain accessible provider documentation and test a supported account route before committing to sync.
- **Teams, Matrix, and Signal:** add after the common account and import model is stable.

These priorities are judgments based on setup friction, existing code, provider support, and maintenance burden. They are not development-time estimates. Provider verification can take longer than implementation, so start registration work early.

Before a provider is selected for release, run a small disposable-account test that proves:

- First sign-in, cancellation, restart, reconnect, and concurrent account behavior.
- The account scope and returned identity match the user's selection.
- Data requests go directly to the source and AI processing stays local.
- Paging, token refresh, rate limits, updates, deletions, and interrupted sync are handled.
- No live-search-only data persists in memory, model history, logs, or sync.
- Sending and calendar changes use the existing action controls and correct account.

For EventKit, also test denied OS access, signed-app permission attribution, multiple calendars, all-day events, daylight-saving changes, and recurring events. For IMAP, prove that a fetch does not change the Seen flag. For Slack, prove private scope revocation and the chosen retention rule. These are proposed future implementation checks; none was executed against a customer account for this report.

## Evidence limits and unresolved questions

This research inspected code and current provider documentation. It did not connect user accounts, install integration programs, run the app, or run end-to-end tests. No credentials or private profile records were used.

The following items need direct confirmation before a release promise:

| Item | What remains unresolved | Required next evidence |
| --- | --- | --- |
| Google verification | Exact assessment scope for the complete Off Grid configuration | Verification-team response to the documented local data path |
| Microsoft organizations | Consent behavior under customer tenant policy | A disposable personal account and a managed test tenant |
| Slack | Marketplace eligibility; retention rules for MCP, RTS, and derived output | Provider approval and a scoped internal-app test |
| Apple account authorization | Off Grid eligibility and developer registration for Mail access | Apple developer guidance; do not infer it from consumer help |
| Fastmail calendars | OAuth credential compatibility with CalDAV | Provider documentation or a registered test application |
| Telegram | AI use and all-participant consent implementation | Provider clarification for the specific product behavior |
| WhatsApp | Consumer inbox API availability; business inbound path; current agent and business MCP developer access | Accessible primary documentation and a disposable account |
| WeChat and WeCom | Supported personal path and business archive requirements | Accessible Tencent documentation and provider-approved test setup |

Primary Meta and Tencent pages were partly inaccessible or required login. Community reports were used to find questions, not to establish release capabilities. Project documentation for Baileys, Wechaty, and signal-cli establishes what those projects claim; it does not establish provider approval.

The saved result is a research document only. It contains private-repository source references and should remain internal. The main checkout's application files were not changed. New provider code should be implemented and committed in the Pro repository, with separate core changes only where a generic interface needs extension.


## Obsidian implementation choice

User job: connect local Markdown notes from onboarding or Integrations with one folder choice. Reuse the pinned production `Card` and `Button` primitives already used by Google. The native folder dialog owns folder selection; a text path field or third-party MCP process would add setup work and is not selected. A private provider supplies read tools through the existing core MCP tool-source hook. The grant names one vault directory; hidden directories, symbolic links, non-Markdown files, and paths outside that directory are excluded. Notes are read when requested, without a background import. No new tests will be written or run until the user agrees that the product works.


Obsidian delivery: onboarding and Integrations now include **Choose vault** and **Change vault**. The private provider supplies `list_notes`, `search_notes`, and `read_note` through the same MCP chat extension as other connections. Folder grants are protected in the device secret store and are removed when the connection is removed. A changed or unavailable vault requires folder selection again. The reader skips hidden paths and symbolic links, accepts Markdown only, limits each note to 2 MB, and reports bounded search results. No writes or automatic memory import are available from this provider. The build and Pro type check passed. No Obsidian tests were written or run. New profiles also leave clipboard capture off until explicitly enabled; saved user choices retain their previous value.

## Microsoft implementation, 30 September 2026

The private provider uses direct Microsoft Graph v1.0 requests and the common
Microsoft identity authority for personal and work/school accounts. One public
application identity requests delegated User.Read, Mail.Read, Calendars.Read,
and Files.Read permissions, plus offline_access for refresh. Authorization uses
PKCE, the existing system-browser loopback, cancel, and encrypted local tokens.
No confidential client secret is requested or bundled.

Onboarding and Integrations offer registered Off Grid sign-in or a user-supplied
public application ID. Configure MICROSOFT_CLIENT_ID for the registered build.
No Microsoft registration was supplied for this worktree, so registered sign-in
is visibly unavailable. Register personal and organizational account support
and the app's displayed loopback URI under Mobile and desktop applications.
Microsoft requires the 127.0.0.1 HTTP URI to be configured through the app manifest
when the portal field does not allow it. Work tenants may require administrator
consent. This implementation targets the global Microsoft cloud.

Tools read/search Outlook messages, read message bodies, list calendars and
calendar occurrences, list/search OneDrive files, and read text files up to 2 MB.
Binary Office documents return metadata. Collection tools preserve next-page
links and restrict authenticated pagination to the same Graph collection.
OneDrive download redirects never receive the OAuth token. Connections stay
live-only, without automatic memory import. Changed own-app settings remove
old tokens and require approval again.

Sources: [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[redirect configuration](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url),
[mail reads](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0),
[calendar occurrences](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0),
[OneDrive download redirects](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0).

## Design correction and reload recovery

The sibling brand guide at 15e6b2f (7 September) is newer than the Desktop guide
at 332e48397 (27 August). The Desktop guide now includes the canonical content
and a source record; DESIGN.md refers to it. The connection screen reuses the existing Desktop Item, ItemGroup, Button, and
SidePanel components after product review rejected the earlier card composition.
Shared Input, Label, and NativeSelect controls remain for the advanced setup
form. Row composition wins over tall Cards and catalogue demo controls because
it matches the existing Desktop patterns, keeps actions beside content, and
moves application configuration into a focused side panel. No Card or Sheet
copy remains in the connection screen. The pinned operator dependency is
ca35d2f9004b212ea034b73109fcd2819a08816b.

Locally bundled monochrome app marks identify Google, Microsoft, Obsidian,
Notion, Jira, Confluence, and Linear; generic service icons were removed.
CSS layer ordering places Tailwind resets before shared components. Previously
the reset layer was registered after components and overrode spacing and text
sizes. New profiles now start in dark mode, consistent with the documented
Desktop default; explicit light and system preferences remain respected.

Packaged navigation now keeps the renderer HTML path and stores routes in the
fragment, preventing reload from opening missing file:///settings pages.
Onboarding loads the provider slot for entitled builds before full app activation,
so Google, Microsoft, and Obsidian appear with the existing MCP providers.
No tests were added or run during this implementation. Real account authorization
is still unverified.

Delivery checks: the final Pro type check and production bundle pass. Core type
checking still reports the existing chat-stream video-phase contract mismatch
in src/main/chat-stream-state.ts. No tests were written or run. The isolated
review app shows the connection rows, correct app marks, dark default, and the
Microsoft own-application SidePanel. Real-account sign-in remains unverified.

### Google setup correction, 30 September 2026

Enabled the Google Drive API and Google People API in the Off Grid AI project through Google Cloud Console. The owner approved the People API terms. The Enabled APIs page confirms Gmail, Calendar, Drive, and People. The worktree now offers Add account after a successful Google connection. Each addition creates its own connector ID and protected token keys; Google shows an account chooser. Successful verification labels the connector with its account email, so chat can distinguish account-specific tool sets. Existing Integrations controls manage each connector separately. Setup errors render below the row and disabled-API responses use short actionable copy. Production build and Pro type check pass; no tests were written or run. Real sign-in and multiple-account behavior need owner review.

Obsidian update: the community Local REST API plugin now includes a built-in MCP server, so a separate wrapper server is unnecessary. This requires the plugin, API key, and a running Obsidian session; the existing folder reader remains the no-plugin option. See https://github.com/coddingtonbear/obsidian-local-rest-api.

### Microsoft registered application, 30 September 2026

Created Off Grid AI Desktop in Microsoft Entra with the owner's approval of Microsoft Platform Policies. Public client ID: 2bbfd68a-f7ce-4327-8cb9-45760b77c27f. Account audience: organisational and personal Microsoft accounts. Mobile/Desktop redirect: http://127.0.0.1:33418/callback. No client secret was created. The ignored worktree configuration supplies MICROSOFT_CLIENT_ID; release builds need the same public ID. The production build passed and the review app was restarted. Microsoft displays a publisher-verification requirement for customer consent to newly registered multitenant applications. No tenant-wide administrator consent was granted. Real account sign-in remains to be reviewed.

### Per-account service selection

Google and Microsoft quick setup now opens the shared SidePanel with service checkboxes before sign-in, in both onboarding and Integrations. At least one service is required. Each connector stores its own validated service selection in protected storage. OAuth scopes, Microsoft refresh scopes, service verification, and exposed chat tools follow that selection; tool execution also rejects unselected services. Existing connections without selection metadata keep their previous full-service behavior. Google identity fallback reads skip unselected Gmail/Calendar. The existing shared Input/Label primitives supply checkbox controls. Production build and Pro type check pass. No tests were written or run. The Google checklist is visible in the running review app; actual consent for a reduced selection remains to be reviewed.

### Account management progress

Added account lists and per-connection Remove actions for Google, Microsoft, Notion, Jira, Linear, plus Obsidian vault removal. Google/Microsoft Edit access loads saved selections. A new disabled connection holds sign-in and verification; only a matching provider identity can replace the existing account credentials. Failed/cancelled attempts leave the original connection intact. Duplicate Google/Microsoft sign-in targets the existing connection. Older Microsoft labels are filled from Graph /me. Existing duplicate rows are not automatically removed.

MCP account identity checks use advertised Jira/Linear identity tools and Notion workspace metadata when available. Notion self lookup follows the advertised input schema and requires a workspace ID. Missing identity leaves connections separate; universal deduplication is not yet established. No identity is inferred from a shared server URL. Provider-managed permission changes for those MCP servers still need their consent flows. No tests were run or written.
