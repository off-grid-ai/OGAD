# Fetch the Windows (x64) native runner binaries into resources/bin for the
# Windows package. The repo ships macOS binaries (Git LFS); this populates the
# win64 equivalents from upstream official releases at build time — laid out to
# match exactly what the app's resolvers expect:
#
#   resources/bin/llama/llama-server.exe   (+ ggml/llama DLLs)   <- src/main/llm.ts
#   resources/bin/sd/sd-cli.exe            (+ DLLs)              <- src/main/imagegen.ts
#   resources/bin/whisper/whisper-cli.exe  (+ DLLs)             <- src/main/rag/extractors.ts
#   resources/bin/ffmpeg.exe                                     <- src/main/rag/extractors.ts
#
# On Windows the DLL loader searches the directory of the .exe first, so each
# runtime's DLLs MUST sit next to its .exe (hence the per-runtime subdirs).
#
# Most runtimes are resolved DYNAMICALLY from each project's latest GitHub
# release so the script does not go stale. llama.cpp is the EXCEPTION: it is
# pinned to the same ref the macOS engine is built from (scripts/build-llama.sh,
# LLAMA_REF=b9838) so grammar / native tool-call handling is byte-for-byte
# identical across platforms. 'latest' floats, and upstream builds have shipped
# that reject the tool-call GBNF the app generates from MCP tool schemas.
# Set OFFGRID_GH_TOKEN (or GITHUB_TOKEN) to avoid the unauthenticated API rate
# limit (CI sets GITHUB_TOKEN automatically).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # makes Invoke-WebRequest downloads fast

$bin = Join-Path $PSScriptRoot '..\resources\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
# Canonicalize: collapses the 'scripts\..\' segment to a real absolute path. The
# uncollapsed form is longer than the copied files' paths, which made the final
# Substring-based listing throw and (with ErrorActionPreference=Stop) fail the
# whole script AFTER the binaries had already copied.
$bin = [System.IO.Path]::GetFullPath($bin)
$tmpBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$tmp = Join-Path $tmpBase 'ogbin'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$ghHeaders = @{ 'User-Agent' = 'offgrid-fetch-win' }
$token = if ($env:OFFGRID_GH_TOKEN) { $env:OFFGRID_GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $null }
if ($token) { $ghHeaders['Authorization'] = "Bearer $token" }

# Find the download URL of a release asset whose name matches $pattern. With no
# $tag it uses the project's LATEST release; with $tag it pins to that exact
# release (e.g. llama.cpp b9838, to match the macOS source build).
function Get-AssetUrl($repo, $pattern, $tag) {
  $uri = if ($tag) { "https://api.github.com/repos/$repo/releases/tags/$tag" }
         else      { "https://api.github.com/repos/$repo/releases/latest" }
  $rel = Invoke-RestMethod -Headers $ghHeaders -Uri $uri
  $asset = $rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { throw "no asset matching /$pattern/ in $repo @ $($rel.tag_name)" }
  Write-Host "  $repo @ $($rel.tag_name) -> $($asset.name)"
  return $asset.browser_download_url
}

# Download + extract a zip asset, return the extraction dir. Optional $tag pins
# to a specific release instead of latest.
function Expand-Asset($repo, $pattern, $tag) {
  $url = Get-AssetUrl $repo $pattern $tag
  $zip = Join-Path $tmp ([System.IO.Path]::GetRandomFileName() + '.zip')
  Write-Host "  downloading $url"
  Invoke-WebRequest -Headers $ghHeaders -Uri $url -OutFile $zip
  $out = Join-Path $tmp ([System.IO.Path]::GetFileNameWithoutExtension($zip))
  Expand-Archive -Path $zip -DestinationPath $out -Force
  return $out
}

# Copy every .exe/.dll found anywhere under $srcDir into $destSubdir (flattened).
function Copy-Runtime($srcDir, $destName) {
  $dest = Join-Path $bin $destName
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem -Path $srcDir -Recurse -Include *.exe, *.dll |
    Copy-Item -Destination $dest -Force
  return $dest
}

# --- llama.cpp (server + CLIs + ggml DLLs) -----------------------------------
# PINNED to match the macOS engine (scripts/build-llama.sh). Overridable via env
# for a coordinated cross-platform bump — keep it in lockstep with build-llama.sh.
#
# We ship TWO builds so Windows gets GPU speed without breaking GPU-less boxes:
#   bin/llama      <- Vulkan (GPU) build, the app's PRIMARY. Offloads to any
#                     Vulkan device (Intel/AMD/NVIDIA, incl. iGPUs like Radeon
#                     740M) and still runs on CPU when no device is present.
#                     Needs the system Vulkan loader (vulkan-1.dll, present with
#                     any modern GPU driver).
#   bin/llama-cpu  <- CPU-only build, the app's FALLBACK (llm.ts) for the rare
#                     box with no Vulkan loader at all, where the Vulkan .exe
#                     can't even load.
$LlamaRef = if ($env:LLAMA_REF) { $env:LLAMA_REF } else { 'b9838' }
Write-Host "== llama.cpp (pinned $LlamaRef): vulkan primary + cpu fallback =="
try {
  $x = Expand-Asset 'ggml-org/llama.cpp' 'bin-win-vulkan-x64\.zip$' $LlamaRef
  Copy-Runtime $x 'llama' | Out-Null
} catch { Write-Warning "llama.cpp (vulkan) fetch failed: $_" }
try {
  $x = Expand-Asset 'ggml-org/llama.cpp' 'bin-win-cpu-x64\.zip$' $LlamaRef
  Copy-Runtime $x 'llama-cpu' | Out-Null
} catch { Write-Warning "llama.cpp (cpu fallback) fetch failed: $_" }

# --- whisper.cpp (whisper-cli.exe + DLLs) ------------------------------------
Write-Host '== whisper.cpp =='
try {
  $x = Expand-Asset 'ggml-org/whisper.cpp' '^whisper-bin-x64\.zip$'
  $dest = Copy-Runtime $x 'whisper'
  # Older releases ship the CLI as main.exe; the app expects whisper-cli.exe.
  $wc = Join-Path $dest 'whisper-cli.exe'
  $mn = Join-Path $dest 'main.exe'
  if (-not (Test-Path $wc) -and (Test-Path $mn)) { Copy-Item $mn $wc -Force }
} catch { Write-Warning "whisper.cpp fetch failed: $_" }

# --- stable-diffusion.cpp (image gen): vulkan primary + cpu fallback ---------
# TEST BRANCH (feat/win-gpu-imagegen): ship BOTH builds so Windows image gen can
# run on the GPU, mirroring the llama bin/llama + bin/llama-cpu ladder:
#   bin/sd      <- Vulkan (GPU) build, PRIMARY. Offloads to any Vulkan device
#                  (Intel/AMD/NVIDIA, incl. iGPUs). Needs the system Vulkan loader
#                  (vulkan-1.dll, present with any modern GPU driver).
#   bin/sd-cpu  <- CPU-only build, FALLBACK for a box with no Vulkan loader.
# The app's sd-bin.ts resolves sd/ first, then sd-cpu/.
#
# KNOWN GAP — MUST close before merge to main: the one-shot `sd-cli` path (the
# DEFAULT image path; resident sd-server is opt-in) spawns once and reports a
# single exit code, so it CANNOT tell "GPU won't load here" from "generation
# failed" — there is no launch-failure ladder like llm.ts (which detects load via
# HTTP readiness). The GPU path should therefore route through the resident
# `sd-server` (it HAS an HTTP readiness seam) and fall back to bin/sd-cpu when the
# Vulkan server doesn't become ready. Until that runtime fallback lands, a
# GPU-less Windows box would try Vulkan first and fail. This branch is for
# MEASURING GPU speed on a real GPU, not for shipping.
#
# Dynamic 'latest' matching (upstream renames assets — was bin-win-avx2-x64, now
# bin-win-cpu-x64). Re-check the asset names on any upstream bump; a stale pattern
# fails SILENTLY (verify below only WARNS) and ships without the image binary.
Write-Host '== stable-diffusion.cpp: vulkan (gpu) primary + cpu fallback =='
try {
  $x = Expand-Asset 'leejet/stable-diffusion.cpp' 'bin-win-vulkan-x64\.zip$'
  $dest = Copy-Runtime $x 'sd'
  # Upstream names the one-shot binary sd.exe; the app resolves <dir>/sd-cli(.exe).
  $cli = Join-Path $dest 'sd-cli.exe'; $sd = Join-Path $dest 'sd.exe'
  if (-not (Test-Path $cli) -and (Test-Path $sd)) { Copy-Item $sd $cli -Force }
} catch { Write-Warning "stable-diffusion.cpp (vulkan) fetch failed: $_" }
try {
  $x = Expand-Asset 'leejet/stable-diffusion.cpp' 'bin-win-cpu-x64\.zip$'
  $dest = Copy-Runtime $x 'sd-cpu'
  $cli = Join-Path $dest 'sd-cli.exe'; $sd = Join-Path $dest 'sd.exe'
  if (-not (Test-Path $cli) -and (Test-Path $sd)) { Copy-Item $sd $cli -Force }
} catch { Write-Warning "stable-diffusion.cpp (cpu fallback) fetch failed: $_" }

# --- ffmpeg (GPL, win64) — single ffmpeg.exe flat in resources/bin -----------
Write-Host '== ffmpeg =='
try {
  $zip = Join-Path $tmp 'ffmpeg.zip'
  Invoke-WebRequest -Headers @{ 'User-Agent' = 'offgrid-fetch-win' } `
    -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' `
    -OutFile $zip
  $out = Join-Path $tmp 'ffmpeg'
  Expand-Archive -Path $zip -DestinationPath $out -Force
  Get-ChildItem -Path $out -Recurse -Filter 'ffmpeg.exe' |
    Select-Object -First 1 | Copy-Item -Destination (Join-Path $bin 'ffmpeg.exe') -Force
} catch { Write-Warning "ffmpeg fetch failed: $_" }

Write-Host ''
Write-Host 'resources/bin now contains (win64):'
Get-ChildItem -Path $bin -Recurse -Include *.exe |
  ForEach-Object { Write-Host "  $($_.FullName.Replace($bin, '').TrimStart('\'))" }

# Verify the result so a failed fetch fails LOUD here, not as a confusing
# "binary not found" at app startup. llama-server is REQUIRED (no chat without
# it); whisper/sd/ffmpeg are optional (voice/image degrade gracefully if absent).
$llama = Join-Path $bin 'llama\llama-server.exe'
if (-not (Test-Path -LiteralPath $llama)) {
  Write-Error "REQUIRED binary missing: $llama (the llama.cpp fetch failed above). Cannot run the model server."
  exit 1
}
foreach ($p in @(
    (Join-Path $bin 'llama-cpu\llama-server.exe'),
    (Join-Path $bin 'whisper\whisper-cli.exe'),
    (Join-Path $bin 'sd\sd-cli.exe'),
    (Join-Path $bin 'sd-cpu\sd-cli.exe'),
    (Join-Path $bin 'ffmpeg.exe'))) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Warning "optional runtime missing (feature will be unavailable): $p" }
}
Write-Host ''
Write-Host "OK: llama-server.exe present at $llama"
