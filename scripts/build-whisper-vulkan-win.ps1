# Match the pinned Windows whisper download in fetch-win-binaries.ps1.
$ErrorActionPreference = 'Stop'
$WhisperRef = 'b5130'
$WhisperCommit = '927cfce34f31707e17f2bff35c349632fb9e2c3a'
if (-not $env:VULKAN_SDK -or -not (Test-Path "$env:VULKAN_SDK\Bin\glslc.exe")) {
  throw 'The Vulkan SDK with glslc is required to build Windows Whisper'
}
. "$PSScriptRoot\config\windows-vc-runtime.ps1"
$dest = Join-Path $PSScriptRoot '..\resources\bin\whisper-vulkan'
$tmpBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$work = Join-Path $tmpBase ("whisper-vulkan-" + [guid]::NewGuid().ToString('N'))
try {
  git clone --depth 1 --branch $WhisperRef https://github.com/ggml-org/whisper.cpp "$work\src"
  if ($LASTEXITCODE -ne 0) { throw 'Whisper clone failed' }
  $commit = git -C "$work\src" rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $commit -ne $WhisperCommit) { throw 'Whisper source commit mismatch' }
  cmake -S "$work\src" -B "$work\build" -A x64 `
    -DGGML_VULKAN=ON -DWHISPER_BUILD_SERVER=ON -DCMAKE_BUILD_TYPE=Release `
    -DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_CUDA=OFF `
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
  if ($LASTEXITCODE -ne 0) { throw 'Whisper CMake configuration failed' }
  cmake --build "$work\build" --config Release --parallel 4 --target whisper-cli whisper-server
  if ($LASTEXITCODE -ne 0) { throw 'Whisper Vulkan build failed' }
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem "$work\build" -Recurse -File |
    Where-Object { $_.Name -in @('whisper-cli.exe', 'whisper-server.exe') -or $_.Extension -eq '.dll' } |
    Copy-Item -Destination $dest -Force
  Copy-VCRuntime $dest
  foreach ($name in @('whisper-cli.exe', 'whisper-server.exe')) {
    if (-not (Test-Path "$dest\$name")) { throw "Whisper Vulkan output missing: $name" }
  }
} finally {
  if (Test-Path $work) { Remove-Item -Recurse -Force $work }
}
