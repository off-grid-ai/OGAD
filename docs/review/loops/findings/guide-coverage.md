# Guide coverage

Read from code only. Nothing was run. Partial: the usage limit cut this audit short.

- All 699 flows name labels that exist in their app's code. All cited files exist. Checked by script.
- "Closes" means the topic's button lands on the right screen and its promise holds.
- Flow rows are grouped by topic. One row per flow was not finished.

## Topics

| Topic | Told on | Runs on | Closes today | Finding |
|---|---|---|---|---|
| chat | desktop | computer | yes | |
| images | desktop | computer | no | guide-desktop-images-opens-plain-chat |
| models | desktop | computer | yes | |
| projects | desktop | computer | yes | |
| connectors | desktop | computer | yes | |
| Pro catalog (Video, Tasks, Day, Reflect, Replay, Meetings, Actions, Entities, Search, Notifications, Scribe, Notes, Vault, Clipboard) | desktop | computer | yes (not each screen checked) | |
| God (explore) | desktop | computer | no | guide-god-assistant-names |
| Voice | desktop | computer | no | guide-desktop-hides-free-voice-mode |
| Devices and sync | desktop | computer | partly | guide-phone-sync-button-says-devices |
| computer | mobile | computer | no | guide-other-device-topics-get-only |
| phone | desktop | phone | no | guide-other-device-topics-get-only |
| phone-chat | mobile | phone | yes | |
| phone-images | mobile | phone | yes | |
| phone-vision | mobile | phone | yes | |
| phone-speech | mobile | phone | yes | |
| phone-documents | mobile | phone | yes | |
| phone-voice | desktop, mobile | phone | no (on desktop) | guide-desktop-hides-free-voice-mode |
| phone-video | desktop, mobile | phone | yes | |
| phone-notes | mobile | phone | partly | guide-sync-promises-default-off |
| phone-improve | mobile | phone | no | guide-phone-scribe-opens-notes, guide-android-improve-share-wording |
| phone-vault | mobile | phone | no | guide-sync-promises-default-off |
| phone-clipboard | mobile | phone | no | guide-sync-promises-default-off |
| phone-sync | mobile | phone | no | guide-phone-sync-button-says-devices |
| phone-tools | mobile | phone | yes | |
| phone-models | mobile | phone | yes | |
| extension | desktop, mobile | browser | no | guide-extension-get-chrome-only, xa-phone-extension-link |
| extension-vault | desktop | browser | no | guide-extension-get-chrome-only |

## Flows by file

| Flows | Told on | Runs on | Count | Close today | Finding |
|---|---|---|---|---|---|
| desktop.json | desktop | computer | 349 + 38 not-supported | yes (labels present) | |
| mobile.json | mobile | phone | 246 + 37 not-supported | 245 of 246 | guide-android-improve-share-wording |
| extension.json | desktop, mobile | browser | 74 + 15 not-supported | no: not told in the extension | guide-extension-has-no-guide |
| cross.json | desktop, mobile | two devices | 30 | 28 of 30 (vault and clipboard sharing off by default) | guide-sync-promises-default-off |

Total: 699 flows. 622 close today (all desktop flows, 245 phone, 28 cross). The 74 extension flows do not close inside the extension.

## Not finished

- Each Pro catalog screen's locked state and next step.
- One row per flow step.
- Phone Ask box with no model.
