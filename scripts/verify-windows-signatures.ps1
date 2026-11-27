# Fails when any executable code in a signed Windows build lacks a valid Authenticode signature:
# the web installer, the app exe, and every .exe/.dll/.node in the unpacked app (resources\bin,
# app.asar.unpacked, Electron's own DLLs). Runs only when scripts/windows-signing.sh signed the build.
param(
  [string]$AppDir = 'dist/win-unpacked',
  [string]$InstallerGlob = 'dist/nsis-web/*-setup.exe'
)
$ErrorActionPreference = 'Stop'

$files = @(Get-ChildItem -Path $InstallerGlob -File)
if ($files.Count -ne 1) { Write-Error "Expected one web installer at $InstallerGlob, found $($files.Count)"; exit 1 }
$files += Get-ChildItem -Path $AppDir -Recurse -File -Include *.exe, *.dll, *.node

$bad = @()
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -FilePath $file.FullName
  if ($signature.Status -ne 'Valid') { $bad += "$($signature.Status)  $($file.FullName)" }
}

Write-Host "Checked $($files.Count) files."
if ($bad.Count -gt 0) {
  $bad | ForEach-Object { Write-Host "::error::Unsigned: $_" }
  Write-Error "$($bad.Count) Windows binaries are not validly signed."
  exit 1
}
$main = Get-AuthenticodeSignature -FilePath (Join-Path $AppDir 'off-grid-ai.exe')
Write-Host "OK: every binary is signed by $($main.SignerCertificate.Subject)"
