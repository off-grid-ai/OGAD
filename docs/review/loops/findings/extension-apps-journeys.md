# Extension and apps: journeys

Read from code only. Nothing was run. "Closes today" means both sides say what happened and give the next step.

| # | Journey | Direction | Closes today | Finding |
|---|---------|-----------|--------------|---------|
| 1 | Install the extension from the desktop Scribe screen | desktop→extension | Partly: link is Chrome-only | xa-extension-link-coverage |
| 2 | Install the extension from desktop Vault, Web Use, Pro page, chat | desktop→extension | No: no link | xa-extension-link-coverage |
| 3 | Get the desktop from the extension when it is not installed | extension→desktop | No: no link | xa-no-desktop-get-link |
| 4 | Desktop installed but not running | extension→desktop | Yes: "Start Off Grid AI Desktop", auto-reconnect, Retry | |
| 5 | Desktop on another computer (address) | extension→desktop | Yes: "Change desktop address" | |
| 6 | Pair a browser, happy path (Chrome, Firefox) | extension→desktop | Partly: desktop shows nothing after Pair | xa-desktop-silent-after-pairing |
| 7 | Pair declined, timed out, or retried too soon | desktop→extension | No: wrong reason for timeout and retry block | xa-pair-timeout-says-declined |
| 8 | Pair on a desktop without Pro | extension→desktop | No: Pro wall after pairing, no link | xa-free-pair-then-pro-wall |
| 9 | Unpair from the browser | extension→desktop | No: no control | xa-no-unpair-in-extension |
| 10 | Remove a browser on the desktop | desktop→extension | Partly: browser falls to setup, no reason | xa-removed-browser-unclear |
| 11 | Tell paired browsers apart | extension→desktop | No: same name | xa-paired-browsers-same-name |
| 12 | Chat from the panel, found on the desktop | extension→desktop | Yes: desktop chat list is told (no origin label on desktop) | |
| 13 | Desktop and phone chats shown in the panel | desktop→extension | Yes: "Desktop" and "Phone" labels | |
| 14 | No model loaded on the desktop | desktop→extension | Yes: one line plus the panel's Models screen | |
| 15 | Tools off or tool not available | desktop→extension | Yes: tool lines and panel Tools tab | |
| 16 | Vault locked | extension→desktop | Yes: Unlock opens the desktop Vault and waits | xa-vault-browser-actions-untraced (desktop does not say who asked) |
| 17 | Vault not set up, or not Pro | extension→desktop | No: text only | xa-vault-gate-no-button |
| 18 | Autofill from the vault | desktop→extension | Yes: clear refusal lines | |
| 19 | Save a password in the browser to the desktop vault | extension→desktop | Partly: saved, list updates on focus only, no mark | xa-vault-browser-actions-untraced |
| 20 | Scribe in the browser, desktop Scribe switch off | desktop→extension | No: shows "No writing issues" | xa-scribe-off-looks-clean |
| 21 | Scribe in the browser shown on the desktop Scribe screen | extension→desktop | No: "Not connected" | xa-scribe-browser-row-wrong |
| 22 | Learned words and feedback from the browser | extension→desktop | Yes: desktop screen reloads on the learned event | |
| 23 | Scribe with no chat model | desktop→extension | Yes: no-model line | |
| 24 | Settings changed in the panel, shown on the desktop | extension→desktop | Partly: only Tasks is live | xa-panel-settings-not-live-on-desktop |
| 25 | Settings changed on the desktop, shown in the panel | desktop→extension | Yes: settings watch | |
| 26 | Feature list of the paired desktop | desktop→extension | Partly: wrong reasons | xa-feature-rows-wrong-reasons |
| 27 | Web Use from the desktop in the user's browser | desktop→extension | No: "Waiting for your browser" hides the extension switch | xa-web-use-waiting-no-reason |
| 28 | Web Use allowed in the extension, desktop not set to use it | extension→desktop | Yes: hint names the desktop setting, and the panel can change it | |
| 29 | Web Use task with no browser connected | desktop→extension | Yes: runs in the Off Grid AI browser and says so on the task | |
| 30 | Old desktop, new extension | extension→desktop | No: "update" lines with no action; unknown method reads as unpaired | xa-update-desktop-no-action, xa-removed-browser-unclear |
| 31 | Old extension, new desktop | desktop→extension | No: desktop never knows the extension version | xa-update-desktop-no-action |
| 32 | Get the extension from the phone | mobile→extension | No: Chrome Web Store on a phone | xa-phone-extension-link |
| 33 | Password saved in the browser reaching the phone | extension→mobile | Partly: only through desktop Vault sync; the browser never says so | xa-extension-silent-on-phone |
| 34 | Chat from the panel on the phone, page or selection sent to the phone | extension→mobile | No direct path. Chats go through desktop sync. No send-to-phone feature exists; not reported as a gap. | |
| 35 | Phone to extension (anything) | mobile→extension | No path. Phone chats show in the panel through the desktop (row 13). | |
