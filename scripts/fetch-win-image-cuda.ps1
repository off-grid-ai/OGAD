$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:OFFGRID_BUILD_IMAGE_FROM_SOURCE -eq '1') {
  & (Join-Path $PSScriptRoot 'build-image-windows.ps1') -Backend cuda
  return
}

$root = Split-Path $PSScriptRoot -Parent
$destination = Join-Path $root 'resources\bin\sd-cuda'
$temporary = Join-Path $env:TEMP "offgrid-sd-cuda-$([guid]::NewGuid().ToString('N'))"
$archive = Join-Path $temporary 'sd-cuda.zip'
$expanded = Join-Path $temporary 'expanded'
$pins = Get-Content (Join-Path $root 'resources/engine-pins.json') -Raw | ConvertFrom-Json
$sdRef = $pins.sd.ref
$sdCommit = $sdRef.Split('-')[-1]
$url = "https://github.com/leejet/stable-diffusion.cpp/releases/download/$sdRef/sd-master-$sdCommit-bin-win-cuda12-x64.zip"
$expectedHash = $pins.sd.sha256.'win-cuda'

try {
  New-Item -ItemType Directory -Force -Path $temporary, $destination | Out-Null
  Write-Host 'Downloading the NVIDIA CUDA image runtime...'
  Invoke-WebRequest -Headers @{ 'User-Agent' = 'offgrid-fetch-win' } -Uri $url -OutFile $archive
  if ((Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'CUDA image runtime checksum mismatch.'
  }
  Expand-Archive -Path $archive -DestinationPath $expanded -Force
  Get-ChildItem -Path $expanded -Recurse -Include *.exe, *.dll |
    Copy-Item -Destination $destination -Force

  $cli = Join-Path $destination 'sd-cli.exe'
  $cuda = Join-Path $destination 'ggml-cuda.dll'
  if (-not (Test-Path $cli) -or -not (Test-Path $cuda)) {
    throw 'CUDA image runtime is incomplete.'
  }
  Write-Host "CUDA image runtime ready at $destination"
} finally {
  if (Test-Path $temporary) { Remove-Item -Recurse -Force $temporary }
}
