# Off Grid Desktop

- This is the macOS Electron app. Core is public (AGPL); paid feature code belongs in the private `pro/` submodule. Keep core integration inert and commit Pro changes in its own repo.
- For UI work that changes layout, styling, interaction behavior, or visual hierarchy, use `docs/DESIGN.md` and `@offgrid/design`. Use judgment for small copy or data-only changes to existing controls. Keep the Desktop layout dense and suited to a wide window. Reuse an existing component and use `@phosphor-icons/react`.
- For customer-facing copy, read the applicable guide in `brand/`. Capture remains opt-in with a visible recording indicator. Do not publish private profile data.
- Do not run end-to-end tests unless the user explicitly requests them. If the user requests screenshots or automated UI runs, use a fresh synthetic profile; `npm run demo` seeds both core and Pro data.
- For a verification check that takes a long time or uses a large data set, use a small synthetic profile that reproduces the same behavior in less time. Keep its data and settings separate from real profiles. Record the evidence as a synthetic-profile check and state any acceptance condition that it does not prove.
- Main-process edits need an app restart; renderer edits hot-reload. Read the app log before guessing at a runtime failure.
- Only when changing the bundled chat engine or its packaging: run `scripts/build-llama.sh` and check that the staged binary loads a model with its required libraries.
