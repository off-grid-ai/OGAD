# Windows code signing for the electron-builder --win step. Sourced (bash) by the release and
# branch-build workflows; sets WIN_SIGN_ARGS for electron-builder and exports WIN_SIGNED.
#
# Azure Artifact Signing (preferred) when WIN_SIGNING_PROFILE is set, else a PFX through CSC_LINK.
# Either way forceCodeSigning is on, so a build that is meant to be signed fails instead of
# shipping unsigned, and the publisher name lands in app-update.yml so electron-updater only
# installs updates signed by the same publisher. With neither, the build is unsigned and says so.
#
# Azure: the workflow signs in first (azure/login with GitHub's OIDC token: repository variables
# AZURE_TENANT_ID and AZURE_CLIENT_ID, an Entra app whose federated credential trusts the
# windows-signing environment and holds "Artifact Signing Certificate Profile Signer"), and the
# signing module picks up that Azure CLI session. No client secret. Variables WIN_SIGNING_ENDPOINT,
# WIN_SIGNING_ACCOUNT, WIN_SIGNING_PROFILE, WIN_PUBLISHER_NAME (the certificate's subject CN).

WIN_SIGN_ARGS=()
WIN_SIGNED=false

if [ -n "${WIN_SIGNING_PROFILE:-}" ]; then
  for name in WIN_SIGNING_ENDPOINT WIN_SIGNING_ACCOUNT WIN_PUBLISHER_NAME; do
    if [ -z "${!name:-}" ]; then
      echo "::error::Azure Artifact Signing is half configured: $name is empty."
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
  echo "Windows signing: Azure Artifact Signing ($WIN_SIGNING_ACCOUNT/$WIN_SIGNING_PROFILE) as $WIN_PUBLISHER_NAME"
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
    echo "### Windows installer is UNSIGNED (no Azure Artifact Signing profile or PFX set up)" >> "$GITHUB_STEP_SUMMARY"
  fi
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "WIN_SIGNED=$WIN_SIGNED" >> "$GITHUB_ENV"
fi
