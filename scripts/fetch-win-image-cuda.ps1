$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path $PSScriptRoot -Parent
$destination = Join-Path $root 'resources\bin\sd-cuda'
$temporary = Join-Path $env:TEMP "offgrid-sd-cuda-$([guid]::NewGuid().ToString('N'))"
$archive = Join-Path $temporary 'sd-cuda.zip'
$expanded = Join-Path $temporary 'expanded'
$url = 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-920-2f88688/sd-master-2f88688-bin-win-cuda12-x64.zip'
$expectedHash = '479133a03d5c861ce77e70354dbbe75dd6e8d9955d1d1c7b6b1456b4571e3039'

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
