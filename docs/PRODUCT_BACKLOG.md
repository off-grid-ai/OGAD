# Product backlog for review

Prepared: 30 September 2026. Status: draft for review. No product changes or external issues were made.

This backlog combines the mobile reports from the audit and the selected OGAD (Desktop) plan items. Desktop sync, remote models, Computer Use, and Web Use are excluded. The mobile reports remain in scope.

There are four mobile report threads, grouped into three backlog titles. The two authentication reports are under item 1 until their causes are known. This grouping does not mean that they are the same bug. Desktop titles below come from the recovery plan; an unchecked plan item is not proof that the defect remains on current main. Check each Desktop item before sprint planning. Items already found to be resolved in the earlier audit are omitted.

## Backlog titles

### Reported mobile bugs — first to review

1. **OGAM — Fix saved-key handling in remote connection and model checks; investigate LM Studio 401 failures**
2. **OGAM — Fix empty web-search results through a paired Desktop server**
3. **OGAM — Restore generated-image deletion on Samsung tablets**

### Desktop plan items — proposed P0

4. **OGAD — Keep the running model unchanged when a resource-mode save fails**
5. **OGAD — End stalled transcription with a clear error and release the session**
6. **OGAD — Remove the old artifact preview when the selected artifact changes**
7. **OGAD — Prevent stale search results and facets from replacing newer results**
8. **OGAD — Cancel search work when a newer search starts**
9. **OGAD — Show the correct conversations for each chat source filter**
10. **OGAD — Make knowledge-base text safe to insert into prompts**
11. **OGAD — Remove duplicate calendar meetings and keep one meeting record**
12. **OGAD — Show meeting-evidence load failures as errors**
13. **OGAD — Apply meeting access correctly for Free profiles and newly activated Pro profiles**
14. **OGAD — Prevent overlapping entitlement checks**
15. **OGAD — Restore Pro access after license renewal without a restart**
16. **OGAD — Show license-provider failures instead of an empty device list**
17. **OGAD — Show failed “You” profile saves correctly**
18. **OGAD — Keep proactive delivery off when its saved setting cannot be read**
19. **OGAD — Keep connected Google accounts separate**

### Desktop plan items — proposed P1

20. **OGAD — Clear incomplete model downloads from Temporary Storage**
21. **OGAD — Keep speaker lines in saved transcripts**
22. **OGAD — Create a meeting when recording starts and let the user select its language**
23. **OGAD — Show captured screen context in meeting details**
24. **OGAD — Stop automatic meeting recording when the detected call ends**
25. **OGAD — Keep startup and diagnostics work off the user interaction path**

### Desktop plan items — proposed P1/P2

26. **OGAD — Apply saved per-model image settings in every image-generation flow**
27. **OGAD — Extract the enhanced prompt from reasoning-model output**
28. **OGAD — Use the index for chat-list search**
29. **OGAD — Keep large search and list views responsive while typing**
30. **OGAD — Index valid PDFs that use classic cross-reference tables**
31. **OGAD — Open the cached Day journal without generating it again**
32. **OGAD — Keep large entity and memory views responsive**
33. **OGAD — Limit startup recovery and capture backfill work**
34. **OGAD — Update only the views affected by capture and CRM changes**
35. **OGAD — Let background capture yield to user actions and foreground model work**

### Desktop plan items — proposed P2

36. **OGAD — Keep playback state separate for each voice bubble**
37. **OGAD — Show the registered macOS dictation shortcut**
38. **OGAD — Keep settings responsive while values are edited**
39. **OGAD — Apply and save zoom across the full window**
40. **OGAD — Let the sidebar stay open**
41. **OGAD — Place Explore beside Chat**
42. **OGAD — Render only visible rows in large utility lists**
43. **OGAD — Cancel copy feedback and delayed scrolling when the screen closes**

## Item 1 — Mobile remote authentication

**Status:** Ready for review; implementation and verification have not started.  
**Proposed priority:** P0 for triage, because an affected user cannot use the configured remote model. Confirm sprint priority at planning.  
**Product:** OGAM, shared React Native code for iOS and Android.  
**Code baseline:** OGAM main at `321b7e42f42e8005fddcba8fe14fee655a03dfa7`. Line references below use this commit, not the local working branch. Main was checked during this audit.  
**Suggested work unit:** One engineer, one code reviewer, and QA on iOS and Android. No person is assigned.

### Product manager detail

**User problem:** A saved server can pass one check but fail a later check. Background requests can return 401, hide model capabilities, or leave the user without a usable model. The user needs consistent checks and an error that states what failed.

**User story:** As a mobile user with an authenticated remote server, I want all supported connection and model checks to use my saved key, so that model discovery and model selection work after I save the server, open the server list, or restart the app.

**Desired result:** On a supported HTTPS endpoint, the app uses the current saved key for connection checks, model discovery, and relevant capability probes. Authentication failures are shown as failures. They do not look like an empty model list or a model with no tools.

#### Reports and evidence

| Report | Known facts | Limit of the evidence |
| --- | --- | --- |
| [GitHub #696](https://github.com/off-grid-ai/OGAM/issues/696) | Reported 28 September. OnePlus 12R, Android 16, OGAM 0.0.110. A keyed llama.cpp server returns background 401 errors and tool options disappear. Removing server authentication makes it work. The reported endpoint uses private HTTP with a /v1 suffix. | Current policy intentionally does not send keys over HTTP. Adding key arguments alone will not make this configuration work. |
| User-supplied LM Studio report | OGAM 0.0.111, build 1790418213; iPhone 16 Pro, iOS 27.0; remote server enabled; selected model shown as None. The server previously worked, then returned 401. The user reports no change in LM Studio. | Endpoint scheme, base path, saved-key state, LM Studio version, and the failing request are unknown. Cause and duplicate status are unconfirmed. |
| Source inspection of main | Startup discovery, capability refresh on model selection, and server-list checks have paths that omit the saved key. Capability probes do not accept or send it. Some failure paths can hide authentication errors. | These are confirmed code gaps. Their effect on each reported device has not been reproduced. |

A 401 is evidence of an authentication failure, not proof of which component caused it.

#### Scope

- Pass the current Keychain key through existing connection, discovery, and capability request paths.
- Use the existing transport policy for authorization headers and redirects.
- Show clear 401/403 results from connection and model-list requests.
- Keep the last known model and capability data when refresh fails. Show the refresh failure separately.
- Check the LM Studio report against the corrected paths. If its cause differs, create a separate proposed backlog item in the review notes.
- Explain the current HTTP restriction when a user configures a key for a private HTTP endpoint. Use an existing error surface; no new screen is needed.

This draft preserves the HTTPS-only key policy. Support for keys over private HTTP would require a separate product and security decision. It is not included in this implementation scope. Media generation, pairing, and general remote-provider changes are outside this item.

### Acceptance criteria

1. **Saved key:** Saving an HTTPS server with a valid key allows connection checks and model discovery through the editor and server list.
2. **Lifecycle:** The same checks work after app restart and when selecting a model that needs a capability refresh.
3. **Capability requests:** Relevant llama.cpp, Ollama, and LM Studio probes use the current saved key. This includes the LM Studio thinking probe when it runs.
4. **Truthful capabilities:** A supported model keeps its known tool, vision, and context data after an authenticated refresh. An actually unsupported feature stays unsupported.
5. **Authentication error:** A 401/403 from the connection or model-list API produces a clear authentication error. A successful health page must not override that failure. A failed refresh must not publish an empty success or erase the last known data.
6. **Probe fallback:** An unavailable optional API can still fall back to another valid probe. A rejected required probe must not be interpreted as proof that the model lacks a feature. An error from an unused speculative probe must not invalidate successful authoritative data.
7. **Key changes:** After key replacement or removal, new requests use the current value. Concurrent checks for different saved servers at the same endpoint cannot share a request made with another server's credentials.
8. **Request limits:** Every check ends on success, failure, cancellation where supported, or timeout. Loading state clears after failure.
9. **Transport:** Keys remain in Keychain. They are not written to persisted server records, logs, URLs, or error text. No key is sent over HTTP or forwarded by a redirect.
10. **HTTP message:** A keyed private HTTP configuration reports that the key requires HTTPS under current policy. A private HTTP server without authentication retains its current supported behavior.
11. **Compatibility:** Existing endpoint forms, including supported base-path forms, keep their behavior. Before implementation, reproduce the reported /v1 form and check for a separate URL-path defect. Do not remove a reverse-proxy path without evidence.
12. **Report closure:** Record the result for each report separately. Do not mark #696 or the iPhone report resolved solely because HTTPS fixture tests pass.

### Scrum master review

The confirmed key-handling work has a clear boundary and observable acceptance criteria. It can be picked up after review. The two customer reports are linked evidence, not two estimates for the same implementation.

Keep three tasks under this item: reproduce and identify the failing request; correct the shared request paths; verify and record each report outcome. If the iPhone cause or the /v1 path problem is separate, split that work before extending the implementation.

The private HTTP behavior is a known scope limit. The recommended decision for this item is to preserve current policy and provide a clear message. Do not promise that the scoped fix will resolve #696 on HTTP.

### Project manager detail

| Step | Output | Completion check |
| --- | --- | --- |
| 1. Reproduce | Request-path notes for authenticated llama.cpp and LM Studio fixtures | Record endpoint form, status, app path, and whether the request has authorization. Keep token values out of notes. |
| 2. Implement | Small changes in shared TypeScript owners | Editor, server-list, startup, and model-selection paths all use the existing key owner and transport policy. |
| 3. Automated checks | Boundary tests plus existing relevant regression suites | Valid key, wrong key, rotation, failure state, redirect refusal, and concurrent credential isolation pass. |
| 4. Device checks | iOS and Android results using test servers | Record device, OS, build, endpoint scheme, and result for restart and refresh flows. |
| 5. Review handoff | Diff, check results, and separate report outcomes | Reviewer can trace each changed request to an acceptance criterion. Any remaining cause is stated. |

**Planning estimate:** Allow 2–4 engineering days and 1 QA day after test fixtures are available. This is a draft estimate, not a delivery commitment. A separate base-path defect or HTTP policy change needs a new estimate.

**Dependencies:** Authenticated HTTPS test endpoints, a controlled native Keychain test boundary, and access to one iOS and one Android test device. The iPhone report needs the endpoint scheme/base path, LM Studio version, key-enabled state, and sanitized failing-request details. These details help report triage; they do not block correction of the confirmed code paths.

No native runtime upgrade, data migration, Pro change, or new dependency is expected.

### QA lead review and test plan

Use synthetic server keys and test profiles. New tests must follow the mobile engineering contract: exercise normal product actions and real owners, with faithful fakes only at external network, storage, and native boundaries. Do not mock the manager or capability service to prove that it works.

| Case | Action | Expected result |
| --- | --- | --- |
| Valid HTTPS key | Save a server, run the editor check, reopen the server list, and refresh | Model list loads; all required requests use the saved key. |
| Restart | Restart with a saved authenticated server | Startup discovery works without entering the key again. |
| Model switch | Select a model whose capabilities need refresh | Authenticated capability data appears; loading ends. |
| Wrong or expired key | Refresh models; let a health endpoint return 200 | Show the authentication error. Health success does not hide it. Previous data is kept. |
| Capability rejection | Let the relevant capability endpoint reject the key | Show or retain the refresh error; do not turn supported features into false values. |
| Optional API missing | Return 404 for an unused probe and valid authoritative data from another | The valid data wins. Supported fallback still works. |
| Key rotation and removal | Change the key through the editor, then check again | New requests use the new value, or no key after removal. |
| Same endpoint, different keys | Check two saved servers concurrently | No request or result is shared across different credentials. |
| Network failure and timeout | Disconnect or stall a required request | A useful error appears and loading ends. |
| Empty success | Return 200 with a valid empty model list | Show the valid empty state; do not label it an authentication failure. |
| HTTP policy | Try private HTTP with and without a configured key | Keyed case explains the HTTPS requirement; keyless supported case still works. No key leaves over HTTP. |
| Redirect | Return a cross-origin redirect or HTTPS-to-HTTP redirect | The check fails under current policy; the destination receives no key. |
| Base paths | Check host-root and supported /v1 or proxy-prefix forms | URLs follow the existing endpoint contract. Record any independent defect. |
| Platform regression | Repeat restart, model switch, and server-list checks on iOS and Android | Both use the corrected shared path. Existing remote text generation still works. |

**Suggested automated checks after implementation:** Run the focused Jest suites for remote discovery, rendered remote-server connection, transport policy, capabilities, and the manager. Inspect and update the fixture coverage before treating a green suite as authentication evidence. Do not use the broad npm test command for this item without checking its native-test side effects. No E2E run is required by this draft.

**QA release condition:** Each acceptance criterion has evidence. Customer reports have separate outcomes: reproduced and fixed, explained by HTTP policy, or still under investigation. A green fixture test alone does not close an unreproduced report.

### Tech lead review

Reuse the existing ownership: the manager reads Keychain; the store receives an optional key; request helpers apply transport policy. Do not put Keychain reads in the store or add credentials to persistent server state.

Pass the key through all capability branches, including nested probes. Apply the existing redirect rule to those requests. Keep authentication errors separate from a missing optional API and a genuine lack of model capability.

The current llama.cpp in-flight cache is keyed only by endpoint. For authenticated probes, a small safe option is to bypass this shared cache. Do not use raw API keys as cache keys. Keep current coalescing for keyless requests unless tests show a reason to change it.

Keep URL normalization as a checked dependency. Some helpers append API paths to the configured endpoint. Reproduce the reported /v1 form before selecting a fix. If it is a separate defect, split it instead of adding a broad provider refactor.

No shared protocol, persistent schema, new service layer, or UI layout change is needed for the scoped fix.

### Senior developer scout — files and line ranges

These references are pinned to the inspected main commit. Local branch line numbers can differ. “Change” means a proposed edit; no code has been edited.

| File and lines | Finding | Proposed work |
| --- | --- | --- |
| [remoteServerManagerUtils.ts, 162–177](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/services/remoteServerManagerUtils.ts#L162) | Model selection retries discovery without the saved key at line 170. | **Change:** Read the key through the existing utility owner and pass it to discovery. |
| [remoteServerManagerUtils.ts, 271–310](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/services/remoteServerManagerUtils.ts#L271) | Startup initializes providers and migrates old credentials, then calls discovery without a key at line 294. | **Change:** After any existing migration, read the current key and pass it to discovery. Keep the existing startup flow. |
| [RemoteServersScreen.tsx, 55–96](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/screens/RemoteServersScreen.tsx#L55) | Screen-open and manual checks use the store action directly, without the saved key. | **Change:** Use the existing manager connection method. Remove the unused direct store action. |
| [remoteServerHelpers.ts, 347–530](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/stores/remoteServerHelpers.ts#L347) | Model-list requests accept a key, but capability calls at lines 398, 446, and 498 omit it. Catch/fallback paths can turn failure into empty results. | **Change:** Pass the key to each capability branch. Preserve required authentication failures through fallbacks; keep valid missing-API fallback. |
| [remoteModelCapabilities.ts, 99–184](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/stores/remoteModelCapabilities.ts#L99) | Ollama and LM Studio metadata requests have no key argument or authorization header. | **Change:** Accept the optional key and apply existing header and redirect policy. Handle status without confusing auth failure with unsupported APIs. |
| [remoteModelCapabilities.ts, 224–265](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/stores/remoteModelCapabilities.ts#L224) | The nested LM Studio thinking probe does not send a key. | **Change:** Pass the key into this probe and apply the same transport rules. |
| [remoteModelCapabilities.ts, 285–333](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/stores/remoteModelCapabilities.ts#L285) | llama.cpp props requests omit the key; the in-flight cache uses only endpoint identity. | **Change:** Authenticate the probe and isolate authenticated requests. Test concurrent servers with different keys. |
| [remoteModelCapabilities.ts, 428–452](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/stores/remoteModelCapabilities.ts#L428) | The public capability function cannot receive a key and runs three probes in parallel. | **Change:** Add the optional key argument and pass it to all probes. Keep authoritative data and supported fallback rules. |
| [httpClientUtils.ts, 130–181](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/services/httpClientUtils.ts#L130) | Main checks send headers correctly, but any rejected model request can fall back to health/root success. | **Change:** Return a clear 401/403 failure before health fallback. Check the /v1 path construction during reproduction. |
| [remoteTransportPolicy.ts, 38–78](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/services/remoteTransportPolicy.ts#L38) | HTTPS-only authorization and redirect refusal already exist. | **Reuse:** Keep this policy. Use it for capability probes. No HTTP key-policy change is proposed. |
| [remoteServerManager.ts, 137–178](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/services/remoteServerManager.ts#L137) | Manager methods already retrieve the key for direct connection and discovery calls. | **Reuse:** Use these methods where the screen currently bypasses the manager. Keep key ownership here. |
| [remoteServerManagerUtils.ts, 24–54](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/services/remoteServerManagerUtils.ts#L24) | Existing helpers store and read Keychain values. | **Reuse:** Use these helpers within initialization and selection utilities; avoid a manager import cycle. |
| [remoteServerStore.ts, 257–313](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/stores/remoteServerStore.ts#L257) | Store discovery and connection actions already accept an optional key. | **Review; change only if needed:** Keep caller-supplied credentials, release loading on failure, and retain last known data. |
| [useRemoteServerForm.ts, 170–218](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/components/RemoteServerEditor/useRemoteServerForm.ts#L170) | Editor checks already use the manager and entered key. | **Conditional:** Reuse the error surface for the HTTP/key message. Verify reopened forms and key changes. |
| [openAICompatibleProvider.ts, 162–170](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/src/services/providers/openAICompatibleProvider.ts#L162) | Remote text generation already uses the transport header policy. | **Regression check:** Verify generation after the discovery fix. Change only if a separate reproduction shows a provider defect. |

For the HTTP/key message, inspect the existing editor validation and connection-helper error paths first. Keep the message in the owner that can distinguish a keyed HTTP request. Do not silently fall back to a keyless request and report success.

#### Test files to inspect or extend

| File | Work needed |
| --- | --- |
| [remoteServerDiscovery.test.ts](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/__tests__/integration/stores/remoteServerDiscovery.test.ts#L1) | Add authenticated discovery, required 401/403, valid empty results, and retained-data coverage through real owners. |
| [remoteServerConnect.rendered.happy.test.tsx, 1–55](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/__tests__/integration/generation/remoteServerConnect.rendered.happy.test.tsx#L1) | Add normal editor/save/server-list flows with external boundary fixtures. Existing keyless happy-path coverage is insufficient. |
| [remoteTransportPolicy.test.ts, 15–96](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/__tests__/unit/services/remoteTransportPolicy.test.ts#L15) | Keep HTTPS-only headers, private HTTP behavior, and redirect protections covered. |
| [remoteModelCapabilities.test.ts](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/__tests__/unit/stores/remoteModelCapabilities.test.ts#L1) | Cover authenticated probes, fallback, and credential isolation without replacing the capability owner. |
| [remoteServerManager.test.ts](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/__tests__/unit/services/remoteServerManager.test.ts#L1) | Cover startup and model-selection key retrieval, rotation, and removal at external boundaries. |
| [remoteHarness.ts, 12–58](https://github.com/off-grid-ai/OGAM/blob/321b7e42f42e8005fddcba8fe14fee655a03dfa7/__tests__/harness/remoteHarness.ts#L12) | **Conditional:** Its FakeXHR ignores request headers. It cannot prove authorization as it stands. Use a faithful transport fixture if generation-header verification needs it. |

No native iOS/Android file or Pro repository edit is expected. Confirm that during the diff review.

### Ready-for-development check

- The scope, evidence limits, acceptance criteria, affected owners, and QA cases are documented.
- The recommended transport decision is explicit: preserve HTTPS-only keys.
- The core correction can proceed without waiting for the iPhone reporter's missing details.
- Fixture setup and the /v1 reproduction are the first development tasks.
- No implementation, automated tests, or device tests were performed for this research task.

### Done condition

The reviewed scope is implemented; focused checks and both platform checks pass; credential storage and transport rules remain intact; and each report has its own documented outcome. Any unrelated cause becomes a separate proposed item. The review draft does not claim that either report is already fixed.

## Sources for the title list

- Mobile authentication: [GitHub #696](https://github.com/off-grid-ai/OGAM/issues/696), inspected OGAM main, and the user-supplied iPhone report.
- Mobile empty web search: [Slack report, 30 September](https://off-grid-mobile.slack.com/archives/C0AFARY80HJ/p1790707059383949). Mobile OS and app version were not stated.
- Samsung image deletion: [email thread](https://mail.google.com/mail/u/0/#all/1a0b2ad9df9683fd). The report names SM-X800, Android 16, and OGAM 0.0.107. The separate texture complaint had a confirmed workaround; deletion did not have a confirmed resolution.
- Desktop candidates: [release-priority-product-flows.md](./release-priority-product-flows.md) and [recovery-product-flows.md](./recovery-product-flows.md). Their priorities are planning input. They are not a fresh verification of current Desktop main.
