# Off Grid Desktop

Follow [the workspace engineering contract](../.codex/ENGINEERING_CONTRACT.md). It takes priority over these repo notes. Keep each change in the smallest existing owner.

- This is the macOS Electron app. Core is public (AGPL); paid feature code belongs in the private `pro/` submodule. Keep core integration inert and commit Pro changes in its own repo.
- For UI work, use `docs/DESIGN.md` and `@offgrid/design`. Keep the Desktop layout dense and suited to a wide window. Reuse an existing component and use `@phosphor-icons/react`.
- For customer-facing copy, read the applicable guide in `brand/`. Capture remains opt-in with a visible recording indicator. Do not publish private profile data.
- Do not run end-to-end tests unless the user explicitly requests them. If the user requests screenshots or automated UI runs, use a fresh synthetic profile; `npm run demo` seeds both core and Pro data.
- Main-process edits need an app restart; renderer edits hot-reload. Read the app log before guessing at a runtime failure.
- Only when changing the bundled chat engine or its packaging: run `scripts/build-llama.sh` and check that the staged binary loads a model with its required libraries.
