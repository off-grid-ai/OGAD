# Where Scribe helps on desktop

One rule decides, on every surface: `isProseField` in `shared/packages/writing/src/fields.ts`. Scribe helps where a person writes sentences. It stays out of secrets, form data (names, addresses, phones), search and filter boxes, file and folder names, URLs and paths, code, and short form labels. An explicit invoke (⌥Enter in the app, the Scribe hotkey system-wide) works in any field except a secret or an opted-out one.

- In the app, `pro/renderer/scribe/fields.ts` `scribeFieldOf` reads the field into `FieldFacts` and asks the rule.
- System-wide, the native helpers report the field's facts (role, subrole, labels, line count). Main decides with the same rule (`overlay-policy.ts` `overlayFieldAllowed`) and sends `clear` so the helper stands down. The helpers refuse secure fields on their own as well.
- The app deny list (`OVERLAY_DENY`) removes whole apps that hold no prose. This is a different control from capture exclusions, which the user sets.

## In-app fields (renderer and pro)

"Before" is the old `scribeFieldOf`: every textarea, every `type=text` input and every rich editor, except a few input types, `data-scribe="off"`, CodeMirror and one-time codes.

| Place | What it was | What it is now |
|---|---|---|
| Notes: rename a file or folder (`notes/Sidebar.tsx`, "Name") | Scribe checked it | Out: a single line with a name label. ⌥Enter works there |
| Notes: Filter files, Find and Replace, Quick open | Scribe checked it | Out: filter, find and search labels |
| Notes editor (CodeMirror) | Has its own Scribe (marks and paragraph improve) | Unchanged: Notes' own Scribe. The app-wide hook leaves `.cm-editor` alone |
| Chat composer (`PromptInputTextarea`) | Scribe helps | Helps: a textarea |
| Video and image prompt bars, negative prompts, Extend prompt | Scribe helps | Helps: textareas |
| Projects: description, instructions | Scribe helps | Helps: textareas |
| Projects: Find a project, new project name | Scribe checked them | Out: search and name labels |
| Skills: name ("proofread") | Scribe checked it | Out: a single line, nothing says prose |
| Skills: description, instructions, routine prompt | Scribe helps | The textareas help. The one-line "What this skill does" stays out (it is a menu label) |
| Skills: time ("08:00"), keywords | Scribe checked them | Out: single lines |
| Routines (God): name / prompt | Name checked, prompt helps | Name out; prompt helps |
| God settings: name, wake word / rules | Name and wake word checked; rules helps | Name and wake word out; rules helps |
| Settings: identity name, email, nickname | Scribe checked name and nickname | Out: name labels; email is not a text input |
| Settings: gateway key name, MCP name and URL, remote server name and address, sync port, device names | Scribe checked them | Out: name, URL, address, port and key labels |
| Settings: Google Client ID, GCP project id, account client id | Scribe checked them | Out: id and key labels |
| Settings: API keys, client secrets, vault master password, PINs | Password inputs skipped | Out: secrets (unchanged) |
| Settings: model search (Hugging Face, embeddings, remote models) | `type=search` skipped; text-type search boxes checked | Out: search labels and search roles |
| Image and video settings: seed, steps, guidance | Number inputs skipped; text "seed" checked | Out: not text, or a single line |
| Vault: title, folder, URL, expiry, setup link | Scribe checked them | Out: title, folder, URL and link labels; single lines |
| Vault: notes | Scribe helps | Helps: a textarea |
| Vault: recovery phrase | Scribe checked it | Out, even on ⌥Enter: the box opts out (`data-scribe="off"`), as a secret |
| Entities: name, type, parent project, survivor search | Scribe checked them | Out: name, search and single lines |
| Clipboard tags, Replay tags | Scribe checked them | Out: tag labels |
| To-dos: "Jot a to-do" (Actions, Day view) | Scribe checked it | Out: a single line, nothing says prose |
| Meeting speakers: name | Scribe checked it | Out: name label |
| Scribe screen: Try it, Your style, snippet text | Scribe helps | Helps: textareas |
| Scribe screen: phrase, app id, "where it applies" | Scribe checked them | Out: single lines |
| Approval setup, task guidance, Replay notes | Scribe helps | Helps: textareas |
| Action gate: edit a field | Scribe checked it | Out unless its label says prose (a Subject or a message helps) |
| Upgrade: licence key | Scribe checked it | Out: a key label |
| Any field in `role=search`, a combobox, a grid, Monaco or a terminal | Scribe checked most | Out |
| Any field with `data-gramm="false"`, `data-enable-grammarly="false"`, `data-lt-active="false"` | Only `data-scribe="off"` honoured | Out, even on ⌥Enter, as other writing tools do |
| Any field with `writingsuggestions="false"` | Checked | No automatic help; ⌥Enter still works |
| `spellcheck="false"` (Scribe sets it on the field it helps in) | Not read | Not an opt-out: apps set it on their own composers, and Grammarly ignores it too |
| ⌥Enter in any non-secret text field | Did nothing outside fields Scribe had | Opens versions of the paragraph: the person asked |

## System-wide overlay (macOS, Windows, Linux)

| Place | What it was | What it is now |
|---|---|---|
| macOS: Finder rename, Save dialog name | Underlined (`AXTextField`) | Out: a single line with no prose label. Finder is also on the deny list |
| macOS: Spotlight, search fields (`AXSearchField`) | Out: the helper refused them | Out: main refuses the role |
| macOS: browser URL bars | Browsers denied; the helper also refused address bars | Out: browsers denied, and main refuses address and search labels |
| macOS: combo boxes (`AXComboBox`) | Never read | Out for underlines; the hotkey works |
| macOS: password fields (`AXSecureTextField`) | Refused by the helper | Refused by the helper (unchanged) |
| macOS: Mail, Messages, Notes, Slack message bodies (`AXTextArea`) | Underlined | Underlined |
| macOS: Mail Subject (`AXTextField` labelled Subject) | Underlined | Underlined: a prose label |
| macOS: Mail To / Cc, form names, addresses | Underlined | Out: single lines, name and address labels |
| Windows: Explorer rename, one-line Win32 edits | Underlined | Out: the helper reports `ES_MULTILINE`, main refuses single lines. Explorer is also denied |
| Windows: search boxes, address bars | The helper refused them | Out: main refuses search and address labels |
| Windows: Outlook body (Document), multi-line edits | Underlined | Underlined |
| Windows: Electron and WPF edits with no line count | Underlined | Help if the label says prose ("Message #general"); otherwise out |
| Linux: GTK entries (`SINGLE_LINE`), file chooser name | Underlined | Out: single lines |
| Linux: text views, documents (`MULTI_LINE`) | Underlined | Underlined |
| Linux: password text, terminals | Refused by the helper | Refused by the helper (unchanged) |
| Two fields in a row with the same text (two empty boxes) | Main kept the first field's context | Each field is its own context: the facts are part of the key |
| The hotkey (rewrite menu, improve paragraph) | Any text field the helper read | Any non-secure text field, search and rename boxes included |
| The "Rephrase" pill on a selection | Prose apps only; the helper refused address bars | Only where main said the field is prose |

## App deny list (`OVERLAY_DENY`)

| Place | What it was | What it is now |
|---|---|---|
| Browsers | Denied (the extension covers them) | Denied |
| Terminals | Denied | Denied |
| Password managers | 1Password, Bitwarden, Keychain, Passwords | Adds KeePassXC, Enpass, Proton Pass, Strongbox |
| Code editors and IDEs | Read | Denied: VS Code, Cursor, Windsurf, Zed, Sublime, Nova, Xcode, Android Studio, JetBrains IDEs, Visual Studio, Notepad++, Kate, Builder |
| Spreadsheets | Read | Denied: Excel, Numbers, Gnumeric |
| Finder, File Explorer, Linux file managers | Read | Denied |
| System Settings, Windows Settings, GNOME and KDE settings | Read | Denied |
| Off Grid AI itself | Denied (it has in-app Scribe) | Denied |
