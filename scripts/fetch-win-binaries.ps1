# Fetch the Windows (x64) native runner binaries into resources/bin for the
# Windows package. The repo ships macOS binaries; this populates the win64
# equivalents from upstream official releases at CI time.
#
# NOTE: these upstream asset names/versions move. If a download 404s, bump the
# pinned version below to a current release. After the first successful CI run,
# verify the app spawns each binary correctly on Windows (paths/.exe handling).
$ErrorActionPreference = 'Stop'
$bin = Join-Path $PSScriptRoot '..\resources\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$tmp = Join-Path $env:RUNNER_TEMP 'ogbin'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-Zip($url, $dest) {
  Write-Host "↓ $url"
  $zip = Join-Path $tmp ([System.IO.Path]::GetRandomFileName() + '.zip')
  Invoke-WebRequest -Uri $url -OutFile $zip
  $out = Join-Path $tmp ([System.IO.Path]::GetFileNameWithoutExtension($zip))
  Expand-Archive -Path $zip -DestinationPath $out -Force
  return $out
}

# --- llama.cpp (server + CLIs + ggml dlls), CPU x64 baseline -----------------
$LLAMA_BUILD = 'b4585'   # TODO: bump to a current llama.cpp release tag
try {
  $x = Get-Zip "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_BUILD/llama-$LLAMA_BUILD-bin-win-cpu-x64.zip" $tmp
  Get-ChildItem -Path $x -Recurse -Include *.exe,*.dll | Copy-Item -Destination $bin -Force
} catch { Write-Warning "llama.cpp fetch failed: $_" }

# --- whisper.cpp -------------------------------------------------------------
$WHISPER = 'v1.7.4'      # TODO: confirm current whisper.cpp release
try {
  $x = Get-Zip "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER/whisper-bin-x64.zip" $tmp
  Get-ChildItem -Path $x -Recurse -Include *.exe,*.dll | Copy-Item -Destination $bin -Force
} catch { Write-Warning "whisper.cpp fetch failed: $_" }

# --- ffmpeg (GPL, win64) -----------------------------------------------------
try {
  $x = Get-Zip 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' $tmp
  Get-ChildItem -Path $x -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1 | Copy-Item -Destination $bin -Force
} catch { Write-Warning "ffmpeg fetch failed: $_" }

# --- stable-diffusion.cpp (image gen), avx2 x64 ------------------------------
$SD = 'master-8847020'  # TODO: confirm current stable-diffusion.cpp release
try {
  $x = Get-Zip "https://github.com/leejet/stable-diffusion.cpp/releases/download/$SD/sd-$SD-bin-win-avx2-x64.zip" $tmp
  Get-ChildItem -Path $x -Recurse -Include *.exe,*.dll | Copy-Item -Destination $bin -Force
} catch { Write-Warning "stable-diffusion.cpp fetch failed: $_" }

Write-Host "resources/bin now contains:"
Get-ChildItem -Path $bin | Select-Object Name | Format-Table -HideTableHeaders
