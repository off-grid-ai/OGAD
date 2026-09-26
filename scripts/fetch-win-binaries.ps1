# Fetch the Windows (x64) native runner binaries into resources/bin for the
# Windows package. The repo ships macOS binaries (Git LFS); this populates the
# win64 equivalents from upstream official releases at build time — laid out to
# match exactly what the app's resolvers expect:
#
#   resources/bin/llama-cuda/llama-server.exe (+ CUDA backend DLLs) <- NVIDIA
#   resources/bin/llama/llama-server.exe      (+ Vulkan DLLs)       <- other GPUs
#   resources/bin/llama-prism-cuda/llama-server.exe                <- Bonsai 2 NVIDIA
#   resources/bin/cuda-runtime/*.dll                               <- shared CUDA runtime
#   resources/bin/sd-cuda/sd-cli.exe       (+ shared CUDA DLLs)  <- NVIDIA image path
#   resources/bin/sd/sd-cli.exe            (+ Vulkan DLLs)       <- other GPU path
#   resources/bin/sd-cpu/sd-cli.exe        (+ CPU DLLs)          <- image fallback
#   resources/bin/whisper/whisper-cli.exe  (+ CUDA DLLs)        <- STT GPU path
#   resources/bin/whisper-cpu/whisper-cli.exe (+ DLLs)          <- STT fallback
#   resources/bin/ffmpeg.exe                                     <- src/main/rag/extractors.ts
#
# On Windows the DLL loader searches the directory of the .exe first. Runtime-
# specific DLLs stay beside each executable; the shared CUDA directory is added
# to PATH when a CUDA engine starts.
#
# Most runtimes are resolved DYNAMICALLY from each project's latest GitHub
# release so the script does not go stale. llama.cpp is the EXCEPTION: it is
# pinned to the same ref the macOS engine is built from (scripts/build-llama.sh,
# package.json offgrid.llamaRef) so grammar / native tool-call handling is byte-for-byte
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
# release (package.json offgrid.llamaRef, to match the macOS source build).
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
function Expand-Asset($repo, $pattern, $tag, $sha256 = $null) {
  $url = Get-AssetUrl $repo $pattern $tag
  $zip = Join-Path $tmp ([System.IO.Path]::GetRandomFileName() + '.zip')
  Write-Host "  downloading $url"
  Invoke-WebRequest -Headers $ghHeaders -Uri $url -OutFile $zip
  if ($sha256 -and (Get-FileHash -Algorithm SHA256 -Path $zip).Hash -ne $sha256) {
    throw "SHA256 mismatch for $url"
  }
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
# We ship CUDA, Vulkan, and CPU builds in that order:
#   bin/llama-cuda <- NVIDIA CUDA build with shared bin/cuda-runtime DLLs.
#   bin/llama      <- Vulkan build for AMD/Intel and NVIDIA CUDA fallback.
#                     Needs the system Vulkan loader (vulkan-1.dll, present with
#                     any modern GPU driver).
#   bin/llama-cpu  <- CPU-only build, the app's FALLBACK (llm.ts) for the rare
#                     box with no Vulkan loader at all, where the Vulkan .exe
#                     can't even load.
# The version has ONE owner: package.json's offgrid.llamaRef, shared with build-llama.sh. Hardcoding it in
# both is how the macOS build and the Windows binaries drift apart within a single release.
$PackageJson = Join-Path (Split-Path $PSScriptRoot -Parent) 'package.json'
$LlamaRef = if ($env:LLAMA_REF) { $env:LLAMA_REF } else { (Get-Content $PackageJson -Raw | ConvertFrom-Json).offgrid.llamaRef }
Write-Host "== llama.cpp (pinned $LlamaRef): CUDA + Vulkan + CPU =="
$x = Expand-Asset 'ggml-org/llama.cpp' '^llama-.+-bin-win-cuda-12\.4-x64\.zip$' $LlamaRef 'cb6e838cad17e9920b99ab8496ca9aa7cdc3d3c218128957179bb1fbe0772c4c'
Copy-Runtime $x 'llama-cuda' | Out-Null
$x = Expand-Asset 'ggml-org/llama.cpp' '^cudart-llama-bin-win-cuda-12\.4-x64\.zip$' $LlamaRef '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6'
Copy-Runtime $x 'cuda-runtime' | Out-Null
$x = Expand-Asset 'ggml-org/llama.cpp' 'bin-win-vulkan-x64\.zip$' $LlamaRef 'b7b5ef4a1f47542635a3a5e3e471cbfcbaee057aa0c962f9573329ddd9168c5a'
Copy-Runtime $x 'llama' | Out-Null
$x = Expand-Asset 'ggml-org/llama.cpp' 'bin-win-cpu-x64\.zip$' $LlamaRef 'a2668a200ca7271e66af0a54fd4376aaf8ae0b2a562cf7a63c41d8fd2a8245fa'
Copy-Runtime $x 'llama-cpu' | Out-Null

# Bonsai 2 uses packed ternary weights that require PrismML's llama.cpp fork.
# Try CUDA on NVIDIA, Vulkan on other GPUs, then CPU.
# Keep these DLLs separate from the standard llama.cpp DLLs.
$PrismLlamaRef = (Get-Content $PackageJson -Raw | ConvertFrom-Json).offgrid.prismLlamaRef
Write-Host "== Prism llama.cpp (pinned $PrismLlamaRef): CUDA + Vulkan + CPU =="
$x = Expand-Asset 'PrismML-Eng/llama.cpp' '^llama-.+-bin-win-cuda-12\.4-x64\.zip$' $PrismLlamaRef 'f565c8428c1f108311f65ed97f02425188b3aa3c745c2bc597521bbd24bcbbc9'
Copy-Runtime $x 'llama-prism-cuda' | Out-Null
$x = Expand-Asset 'PrismML-Eng/llama.cpp' 'bin-win-vulkan-x64\.zip$' $PrismLlamaRef 'fabef609b588cbbed85b5f10b45809c46088f0a63caca7976054034e24b40836'
Copy-Runtime $x 'llama-prism' | Out-Null
$x = Expand-Asset 'PrismML-Eng/llama.cpp' 'bin-win-cpu-x64\.zip$' $PrismLlamaRef '92cd4d1cee11107593ff87d77eb57b02d804c86dd4b13224e18ba963a4271ad8'
Copy-Runtime $x 'llama-prism-cpu' | Out-Null

# --- whisper.cpp (whisper-cli.exe + DLLs): CUDA GPU + CPU fallback -----------
# The newest semantic release can have no binary assets. Pin the current build
# release so Windows voice cannot disappear because GitHub's "latest" moved.
$WhisperRef = 'b5130'
Write-Host "== whisper.cpp (pinned $WhisperRef): CUDA 11.8 + CPU =="
try {
  $x = Expand-Asset 'ggml-org/whisper.cpp' '^whisper-cublas-11\.8\.0-bin-x64\.zip$' $WhisperRef '0b29b2175bb17ec26da29677cbc7c467c57d103245144d62a49a703f6bc3fdae'
  $dest = Copy-Runtime $x 'whisper'
  # Older releases ship the CLI as main.exe; the app expects whisper-cli.exe.
  $wc = Join-Path $dest 'whisper-cli.exe'
  $mn = Join-Path $dest 'main.exe'
  if (-not (Test-Path $wc) -and (Test-Path $mn)) { Copy-Item $mn $wc -Force }

  $x = Expand-Asset 'ggml-org/whisper.cpp' '^whisper-bin-x64\.zip$' $WhisperRef 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
  $dest = Copy-Runtime $x 'whisper-cpu'
  $wc = Join-Path $dest 'whisper-cli.exe'
  $mn = Join-Path $dest 'main.exe'
  if (-not (Test-Path $wc) -and (Test-Path $mn)) { Copy-Item $mn $wc -Force }
} catch { Write-Warning "whisper.cpp fetch failed: $_" }

# --- stable-diffusion.cpp (image gen): CUDA, Vulkan, then CPU -------------------
# The CUDA engine reuses bin/cuda-runtime from llama.cpp. Do not fetch the
# separate 563 MB stable-diffusion CUDA runtime archive: it contains the same
# three CUDA DLLs and previously made the installer too large to build.
# Keep this release pinned: Qwen-Image 2.1 needs the current runtime and a moving
# latest release can change the packaged DLL contract without review.
$SdRef = 'master-920-2f88688'
Write-Host "== stable-diffusion.cpp (pinned $SdRef): CUDA + Vulkan + CPU =="
try {
  $x = Expand-Asset 'leejet/stable-diffusion.cpp' 'bin-win-cuda12-x64\.zip$' $SdRef '479133a03d5c861ce77e70354dbbe75dd6e8d9955d1d1c7b6b1456b4571e3039'
  $dest = Copy-Runtime $x 'sd-cuda'
  $cli = Join-Path $dest 'sd-cli.exe'
  $sd = Join-Path $dest 'sd.exe'
  if (-not (Test-Path $cli) -and (Test-Path $sd)) { Copy-Item $sd $cli -Force }
} catch { Write-Warning "stable-diffusion.cpp CUDA fetch failed: $_" }

try {
  $x = Expand-Asset 'leejet/stable-diffusion.cpp' 'bin-win-vulkan-x64\.zip$' $SdRef '63e84439c20dde75487a933066318ae01353e9e80ee70e031acad48e857e1cb9'
  $dest = Copy-Runtime $x 'sd'
  # Older releases named the one-shot binary sd.exe; normalize the app contract.
  $cli = Join-Path $dest 'sd-cli.exe'
  $sd = Join-Path $dest 'sd.exe'
  if (-not (Test-Path $cli) -and (Test-Path $sd)) { Copy-Item $sd $cli -Force }

  $x = Expand-Asset 'leejet/stable-diffusion.cpp' 'bin-win-cpu-x64\.zip$' $SdRef '10fc73b25bd97fb071c6bb6ba2a18e8811e6dd421c32bead98c18c84cd305d7f'
  $dest = Copy-Runtime $x 'sd-cpu'
  $cli = Join-Path $dest 'sd-cli.exe'
  $sd = Join-Path $dest 'sd.exe'
  if (-not (Test-Path $cli) -and (Test-Path $sd)) { Copy-Item $sd $cli -Force }
} catch { Write-Warning "stable-diffusion.cpp fetch failed: $_" }

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
$prism = Join-Path $bin 'llama-prism\llama-server.exe'
if (-not (Test-Path -LiteralPath $prism)) {
  Write-Error "REQUIRED binary missing: $prism (the Prism llama.cpp fetch failed above). Cannot run Bonsai 2."
  exit 1
}
$prismCpu = Join-Path $bin 'llama-prism-cpu\llama-server.exe'
if (-not (Test-Path -LiteralPath $prismCpu)) {
  Write-Error "REQUIRED binary missing: $prismCpu (the Prism CPU fallback fetch failed above). Cannot run Bonsai 2 without Vulkan."
  exit 1
}
foreach ($p in @(
    (Join-Path $bin 'llama-cuda\llama-server.exe'),
    (Join-Path $bin 'llama-prism-cuda\llama-server.exe'),
    (Join-Path $bin 'cuda-runtime\cudart64_12.dll'),
    (Join-Path $bin 'cuda-runtime\cublas64_12.dll'),
    (Join-Path $bin 'cuda-runtime\cublasLt64_12.dll'),
    (Join-Path $bin 'sd-cuda\sd-cli.exe'),
    (Join-Path $bin 'sd-cuda\ggml-cuda.dll'))) {
  if (-not (Test-Path -LiteralPath $p)) { throw "REQUIRED CUDA runtime missing: $p" }
}
foreach ($p in @(
    (Join-Path $bin 'llama-cpu\llama-server.exe'),
    (Join-Path $bin 'whisper\whisper-cli.exe'),
    (Join-Path $bin 'whisper-cpu\whisper-cli.exe'),
    (Join-Path $bin 'sd\sd-cli.exe'),
    (Join-Path $bin 'sd-cpu\sd-cli.exe'),
    (Join-Path $bin 'ffmpeg.exe'))) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Warning "optional runtime missing (feature will be unavailable): $p" }
}
Write-Host ''
Write-Host "OK: llama-server.exe present at $llama"
Write-Host "OK: Prism llama-server.exe present at $prism"
