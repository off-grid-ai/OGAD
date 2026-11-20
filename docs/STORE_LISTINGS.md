# Store listings: Microsoft Store, Ubuntu App Center, Mac App Store

Status 2026-11-20. Direct downloads (GitHub releases, website) stay the main channel.
Store builds are extra packages built from the same app.

## How a store build behaves

- The app knows its store from the runtime: `process.mas`, `process.windowsStore`, `SNAP`
  (`src/main/store-distribution.ts`).
- The store updates a store install. The app never downloads or swaps its own bundle there.
  Settings → Software update shows "Updates come from the store" instead of the controls.
- Apple and Microsoft store builds keep the engines they shipped with. Engine self-updates
  download native code, which both stores refuse. A snap keeps engine updates.

## Microsoft Store (MSIX)

Built: `electron-builder --win appx`, the `appx` block in `electron-builder.yml`.
CI: Branch Builds → `store_packages: true` uploads `off-grid-ai-windows-msix`.

To do (Mac):
1. Partner Center account (free for individuals, about $99 once for a company).
2. Reserve the name "Off Grid AI". Copy Product identity → secrets
   `MS_STORE_IDENTITY_NAME`, `MS_STORE_PUBLISHER`, `MS_STORE_PUBLISHER_NAME`.
3. Listing: screenshots, privacy policy URL, age rating (IARC), description.
4. Generative-AI note for review: what the app does to limit harmful output and how users report it.

Open: Kev's Python runtime downloads on first use. Review may treat it as downloaded code.
If they flag it, ship it inside the MSIX (no size limit problem there).

## Ubuntu App Center (Snap Store)

Built: `electron-builder --linux snap`, the `snapcraft` block in `electron-builder.yml` (core24, strict).
CI: Branch Builds → `store_packages: true` uploads `off-grid-ai-linux-snap`.

To do (Mac):
1. snapcraft.io account (Ubuntu One, free). `snapcraft register off-grid-ai`.
2. Ask on the Snapcraft forum for auto-connect of `audio-record` and `camera`.
3. `snapcraft export-login - | base64 -w0` → secret `SNAP_CSC_LINK` (then CI can upload to `edge`).

To test under strict confinement: paste (xdotool/wtype), screen capture through the portal,
global hotkeys, the Scribe overlay (AT-SPI), CUDA through the `opengl` plug.

## Mac App Store

Not built yet. The App Store needs the App Sandbox, and the sandbox blocks parts of the app:

| Area | In the sandbox | Store build plan |
| --- | --- | --- |
| Chat, image, voice, notes, documents | Works (bundled engines, user-picked files) | Ship |
| Engine self-updates | Refused (2.5.2) | Off (done) |
| Kev Python runtime download | Refused (2.5.2) | Bundle it, or leave Kev out |
| Computer use, paste into other apps, Scribe overlay | Accessibility control of other apps is not allowed | Leave out |
| Apple Events to Messages, Mail, Notes | Needs a per-app exception that review rarely grants | Leave out |
| Screen capture | ScreenCaptureKit works with user permission | Ship |
| Pro purchase ($119 once, $7.99/month) | Must be In-App Purchase (3.1.1) | IAP for both; a licence bought on the web can still sign in (3.1.3(b)) |

Also needed:
- App Store Connect record. The iOS app holds the name "Off Grid AI", so the Mac app is
  either "Off Grid AI Desktop" (own record) or the macOS platform on the iOS record
  (needs the same bundle ID and universal purchase).
- Certificates: Apple Distribution + Mac Installer Distribution, a Mac provisioning profile.
- `mas` target with `entitlements.mas.plist` (app-sandbox, network client/server, audio input,
  camera, user-selected files) and `entitlements.mas.inherit.plist` for every helper in `Resources/bin`.
- Apple's commission: 15% on the Small Business Program.

Decision for Mac: the App Store edition scope (the table above) and IAP pricing.
