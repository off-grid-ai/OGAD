# Off Grid AI Desktop — Release Runbook

How we ship Off Grid AI Desktop: two artifacts (**core** = free, **pro** =
license-gated), signed + notarized, with Keygen license activation. Mirrors the
mobile licensing model (same Keygen account/product — a key works on both).

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
   console (`Console.app` → filter "Off Grid").

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

## 3. Real release (signed + notarized, two artifacts)

> Not yet wired into CI as two artifacts — see TODO at the bottom. The mechanics:

### macOS (working today)

Signing uses the Apple Developer ID + notarization (`electron-builder.yml`
`mac.notarize: true`). CI secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY*`. Do **not** add an afterSign re-sign hook — it invalidates the
notarization staple (this was a past bug).

### Windows — PARKED

Windows is on hold and owned elsewhere (the bundled llama-server doesn't start in
the Windows binary; being fixed separately). Azure Trusted Signing setup (§4) is
kept below for when Windows resumes, but it is **not** on the current path. Focus
is macOS core + pro.

### Per-artifact config

Core and pro differ only by `OFFGRID_FORCE_CORE`, `productName`, `appId`, and
`artifactName` (see `scripts/build-mac-local.sh` for the exact overrides). They
must publish to **separate update channels** so electron-updater never feeds a
core user a pro binary (or vice versa).

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

- [ ] Split `.github/workflows/release.yml` into **macOS** core + pro build jobs,
      using `OFFGRID_FORCE_CORE` and the per-artifact overrides; separate update channels.
- [ ] Confirm the RevenueCat offering/products issue desktop-valid keys (they're
      product-scoped, so likely already do) and the key email copy isn't mobile-only.
- [ ] Device-management UI (list/deactivate machines) — backend is ready
      (`license:list-devices` / `license:deactivate`).

### Parked (owned elsewhere)

- [ ] Windows: bundled llama-server doesn't start — fix in progress separately.
- [ ] Azure Trusted Signing validated + `azureSignOptions` wired (§4) — resumes with Windows.
