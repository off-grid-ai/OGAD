# Off Grid AI Desktop — Release Runbook

How we ship Off Grid AI Desktop: one app per platform with Pro code bundled and
locked until Keygen license activation. macOS is signed and notarized. Mirrors the
mobile licensing model (same Keygen account/product — a key works on both).

---

## Release preparation — 8 October 2026

Scope: [OGAD #176](https://github.com/off-grid-ai/OGAD/pull/176),
[Desktop Pro #90](https://github.com/off-grid-ai/desktop-pro/pull/90), and
[Shared #46](https://github.com/off-grid-ai/shared/pull/46).
Other open PRs are outside this preparation scope.

Support contact: `support@getoffgridai.co`. Author and package-maintainer metadata
are separate from the support address.

Merge Shared #46 first, then Desktop Pro #90, then OGAD #176. Pro uses the new lazy
sync payload option from Shared. Release builds from `main` use Shared `main`.
OGAD pins Pro commit `86a14b9528781120b3762497a3404ee3f44d035e`; Shared #46 is at
`fde4f0b0d17add736e4da7fbccf76321cb3a300e`. Keep the pinned Pro commit available
after merging. An empty `pro_ref` uses that pin; it does not use Pro `main`.

Current release gates:

- OGAD CI run `37763437151` failed in DB journeys and lint. The source fixes
  remove the two invalid image-size fallbacks. Focused lint passes.
- The Pro expiry/recovery test now expects the app to select another free port.
  It verifies a real TCP connection to that port after paid features close.
  All four service activation tests pass against a temporary SQLite profile.
- All eleven guide tests pass, including a regression for nested markup removal.
- Four image gateway journeys pass using real HTTP, SQLite, and a synthetic native
  runtime. Image requests support `DELETE /v1/requests/{request_id}`. Cancelling a
  queued request does not stop another running request. Mobile Stop must use this
  endpoint, so record the paired Mobile and Desktop source commits together.
- Synchronous image work stops on HTTP disconnect, which matches the browser's
  existing Stop behavior. Desktop detaches CDP before releasing a browser tab and
  waits for detach during task cleanup. Retained result tabs keep their chat mapping.
- CodeQL alert 25 is closed after the iterative element-removal fix. SonarCloud
  passes on cancellation source `f315a6ea1`. Check the final dependency-patch source
  again before release.
- CI run `37774358922` passes fast coverage, real SQLite DB journeys, and both
  native recording jobs. Heavy integration and UI checks are still running.
- Compatible dependency patches include `tar` 7.5.22, `proxy-addr` 2.0.8,
  Electron 39.8.10, the MCP SDK, image libraries, and build tools. Two local native
  archive install checks, a real HTTP proxy-address check, and native PNG
  encode/decode pass. The built app starts with a fresh synthetic profile.
- The candidate production audit has zero critical, three high, and fourteen
  moderate findings. The remaining high paths include Electron, `extract-zip`,
  and `@xmldom/xmldom`. Major-version or forced downgrade fixes need compatibility
  evidence. These findings remain open; a green CI result does not resolve them.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` secret names are present in OGAD.
  Their values and provider consent remain unverified in the release artifact.

After manual verification and required checks pass, use **Build and Release** on
the selected source with `channel=beta`, empty `pro_ref`, and `artifact_only=true`
for a signed macOS candidate without publishing or sending the Slack announcement.
Verify the installed candidate with a fresh synthetic profile. Check launch, chat,
locked Pro, activation, account consent, guide output, and pairing recovery.
Record the source commits, workflow run, artifact checksum, OS, and manual results.
Do not mark the release approved while required checks or manual evidence are missing.

The latest stable release is `v0.0.54`; the latest listed beta is
`v0.0.55-beta.114`. Let the workflow resolve the next version. Do not change the
version solely to clear the checks.

---

## 0. Mental model

- **Core build** — no `pro/` submodule code bundled (`__OFFGRID_PRO__ = false`).
  Free features only. Pro tabs show the UpgradeScreen.
- **Pro build** — `pro/` submodule bundled (`__OFFGRID_PRO__ = true`), but pro
  stays **locked until a valid Keygen license is activated** at runtime. A leaked
  pro DMG is inert without a key.
- The gate lives in the **main process** (`src/main/bootstrap/loadProFeaturesMain.ts`
  → `proEnabled()`), which consults `isProEntitled()` from
  `src/main/licensing/license-service.ts`. The renderer reads the verdict
  synchronously at load via the `pro:is-enabled` IPC (preload → `window.api.isPro`).

Env overrides (dev/contributor only):

- `OFFGRID_PRO=0` → force free even in a pro build.
- `OFFGRID_PRO=1` → force pro on **without** a license (for working on pro features).
- unset → the real paid path: license-gated.
- `OFFGRID_FORCE_CORE=1` (build-time) → build a core artifact even though `pro/`
  is checked out (used to produce both DMGs from one checkout).

---

## 1. Local test build (no signing, no publish) ← do this BEFORE any release

The last macOS release published but didn't run properly. Always smoke-test a
**packaged** build locally first.

```bash
git lfs pull                      # ensure resources/bin/* are real binaries, not LFS stubs
./scripts/build-mac-local.sh both # → dist/OffGrid-core-<v>.dmg + dist/OffGrid-pro-<v>.dmg
# or: ./scripts/build-mac-local.sh core   /   pro
```

These builds are **unsigned** (no cert/Apple-ID prompts) and never touch GitHub.

### Smoke test

1. Open `dist/OffGrid-core-<v>.dmg`, drag to /Applications, **right-click → Open**
   (unsigned → Gatekeeper). Confirm: app launches, a model downloads + chat works,
   pro tabs show the UpgradeScreen (no license box, since core).
2. Open `dist/OffGrid-pro-<v>.dmg` similarly. Confirm: app launches, pro tabs show
   the UpgradeScreen **with** a "Enter your license key" box. Paste a valid key →
   "Activated. Restart to finish unlocking Pro." → Restart → pro tabs unlock.
3. Things that broke before — verify explicitly: local model server starts on
   :7878 (chat responds), whisper/ffmpeg present, no missing-binary errors in the
   console (`Console.app` → filter "Off Grid AI").

> Both DMGs use distinct appIds (`…desktop` / `…desktop.pro`) so they can be
> installed side by side. They share the canonical userData dir
> (`~/Library/Application Support/Off Grid AI Desktop`), so an activated license
> persists across both.

---

## 2. Licensing — how a purchase becomes an unlock

This backend already exists (shared with mobile). Nothing to build:

```
Buy Pro on web (RevenueCat checkout)
  → RevenueCat webhook → Cloudflare Worker (license.getoffgridai.co)
  → Worker creates/renews a Keygen license, emails the key via Resend
  → user pastes key into the app (UpgradeScreen)
  → app validates via Keygen + activates this machine (platform tag macos/windows)
  → entitlement cached, encrypted, in userData/license.json
  → background revalidation catches expiry/revocation when online
```

Desktop licensing code (ported from mobile):

- `src/main/licensing/keygen-config.ts` — account/product/policy IDs, public key (non-secret).
- `src/main/licensing/keygen-client.ts` — Keygen REST (validate / activate / list / deactivate).
- `src/main/licensing/device-fingerprint.ts` — stable per-install id (userData file).
- `src/main/licensing/license-service.ts` — entitlement logic, encrypted cache, revalidation.
- `src/main/license-ipc.ts` — IPC: `pro:is-enabled` (sync), `license:activate|status|…`.

Device cap is enforced server-side by Keygen. Reinstalls reuse the same
fingerprint and reclaim their slot.

---

## 3. Real release (one app per platform)

The manual `.github/workflows/release.yml` builds macOS, Windows, and Linux from
one resolved Core commit and its pinned Pro commit. `artifact_only=true` builds
only the signed macOS candidate. A normal release can send a Slack announcement;
obtain explicit authorization before dispatching that path.

### macOS (working today)

Signing uses the Apple Developer ID + notarization (`electron-builder.yml`
`mac.notarize: true`). CI secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY*`. Do **not** add an afterSign re-sign hook — it invalidates the
notarization staple (this was a past bug).

### Windows

The current workflow builds Windows and publishes its installer and update feed.
The Azure Trusted Signing notes in §4 are historical setup guidance, not evidence
that current Windows artifacts are signed or verified.

### Per-artifact config

The separate Core and Pro variants in `scripts/build-mac-local.sh` are local
diagnostic builds. Production ships the Pro-capable app locked by default.
macOS publishes `latest-mac.yml` and a compatibility copy, `pro-mac.yml`, for
older Pro installations. Stable and beta release paths are selected by the workflow.

---

## 4. Azure Trusted Signing setup (Windows) — PARKED (kept for when Windows resumes)

Modern Windows code-signing requires the private key on certified hardware/HSM,
so a downloadable `.pfx` no longer works in CI. Azure Trusted Signing is the
cheapest CI-native option (~$10/mo) and electron-builder 25+ supports it natively.

### One-time setup (Azure portal — only the org owner can do this)

1. **Subscription + provider**: in an Azure subscription, register the
   `Microsoft.CodeSigning` resource provider.
2. **Trusted Signing Account**: create one (region: East US / West US3 /
   West Central US / North or West Europe).
3. **Identity Validation** ⏳ **(1–3 weeks — start FIRST)**: submit legal business
   name + D-U-N-S + address. The validated name becomes the cert subject and your
   `publisherName`.
4. **Certificate Profile**: once validation passes, create a **Public Trust** profile.
5. **CI service principal**: create an App Registration + client secret, and assign
   it the **"Trusted Signing Certificate Profile Signer"** role on the account.

### Values to collect

| What                                                   | Where it goes           |
| ------------------------------------------------------ | ----------------------- |
| `endpoint` (e.g. `https://eus.codesigning.azure.net/`) | electron-builder config |
| `codeSigningAccountName`                               | electron-builder config |
| `certificateProfileName`                               | electron-builder config |
| `publisherName` (exact validated org name)             | electron-builder config |
| `AZURE_TENANT_ID`                                      | GitHub repo secret      |
| `AZURE_CLIENT_ID`                                      | GitHub repo secret      |
| `AZURE_CLIENT_SECRET`                                  | GitHub repo secret      |

### electron-builder wiring (when values are in hand)

Add to the Windows config (electron-builder 25+ reads `AZURE_*` env via
DefaultAzureCredential and auto-downloads the Trusted Signing dlib):

```yaml
win:
  executableName: off-grid-ai
  azureSignOptions:
    publisherName: '<validated org name>'
    endpoint: 'https://<region>.codesigning.azure.net/'
    certificateProfileName: '<profile>'
    codeSigningAccountName: '<account>'
```

SmartScreen reputation accrues over downloads; Microsoft-backed certs gain trust
quickly. No EV needed.

---

## TODO before first paid release (macOS)

- [x] Use one production app per platform with Pro bundled and locked until activation.
- [ ] Confirm the RevenueCat offering/products issue desktop-valid keys (they're
      product-scoped, so likely already do) and the key email copy isn't mobile-only.
- [ ] Device-management UI (list/deactivate machines) — backend is ready
      (`license:list-devices` / `license:deactivate`).

### Parked (owned elsewhere)

- [ ] Windows: bundled llama-server doesn't start — fix in progress separately.
- [ ] Azure Trusted Signing validated + `azureSignOptions` wired (§4) — resumes with Windows.
