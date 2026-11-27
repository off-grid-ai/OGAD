# Windows code signing for the electron-builder --win step. Sourced (bash) by the release and
# branch-build workflows; sets WIN_SIGN_ARGS for electron-builder and exports WIN_SIGNED.
#
# Azure Trusted Signing (preferred) when AZURE_CLIENT_SECRET is set, else a PFX through CSC_LINK.
# Either way forceCodeSigning is on, so a build that is meant to be signed fails instead of
# shipping unsigned, and the publisher name lands in app-update.yml so electron-updater only
# installs updates signed by the same publisher. With neither, the build is unsigned and says so.
#
# Azure: secrets AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (an Entra app with the
# "Trusted Signing Certificate Profile Signer" role); variables WIN_SIGNING_ENDPOINT,
# WIN_SIGNING_ACCOUNT, WIN_SIGNING_PROFILE, WIN_PUBLISHER_NAME (the certificate's subject CN).

WIN_SIGN_ARGS=()
WIN_SIGNED=false

if [ -n "${AZURE_CLIENT_SECRET:-}" ]; then
  for name in AZURE_TENANT_ID AZURE_CLIENT_ID WIN_SIGNING_ENDPOINT WIN_SIGNING_ACCOUNT WIN_SIGNING_PROFILE WIN_PUBLISHER_NAME; do
    if [ -z "${!name:-}" ]; then
      echo "::error::Azure Trusted Signing is half configured: $name is empty."
      return 1
    fi
  done
  WIN_SIGN_ARGS=(
    "-c.win.azureSignOptions.publisherName=$WIN_PUBLISHER_NAME"
    "-c.win.azureSignOptions.endpoint=$WIN_SIGNING_ENDPOINT"
    "-c.win.azureSignOptions.codeSigningAccountName=$WIN_SIGNING_ACCOUNT"
    "-c.win.azureSignOptions.certificateProfileName=$WIN_SIGNING_PROFILE"
    "-c.forceCodeSigning=true"
  )
  WIN_SIGNED=true
  echo "Windows signing: Azure Trusted Signing ($WIN_SIGNING_ACCOUNT/$WIN_SIGNING_PROFILE) as $WIN_PUBLISHER_NAME"
elif [ -n "${CSC_LINK:-}" ]; then
  WIN_SIGN_ARGS=("-c.forceCodeSigning=true")
  if [ -n "${WIN_PUBLISHER_NAME:-}" ]; then
    WIN_SIGN_ARGS+=("-c.win.signtoolOptions.publisherName=$WIN_PUBLISHER_NAME")
  fi
  WIN_SIGNED=true
  echo "Windows signing: PFX certificate (CSC_LINK)"
else
  echo "::warning::Windows code signing is not configured: this installer is UNSIGNED and SmartScreen will warn."
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "### Windows installer is UNSIGNED (no Azure Trusted Signing or PFX secrets)" >> "$GITHUB_STEP_SUMMARY"
  fi
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "WIN_SIGNED=$WIN_SIGNED" >> "$GITHUB_ENV"
fi
