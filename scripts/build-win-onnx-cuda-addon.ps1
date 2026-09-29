param(
  [Parameter(Mandatory=$true)][string]$WorkDir,
  [Parameter(Mandatory=$true)][string]$OutputFile
)

# Rebuild the LFS addon from official ONNX Runtime 1.30.0 sources and its
# matching CUDA 12 import library. Run in a VS 2022 C++ build environment with
# Node 22, npm, CMake, and Git available on PATH.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sourceUrl = 'https://github.com/microsoft/onnxruntime/archive/refs/tags/v1.30.0.tar.gz'
$sourceSha = 'f6681ecbddf53898adf0cc9e8e84657485b84d2eca3c8aa353de6d7dd417ef'
$runtimeUrl = 'https://github.com/microsoft/onnxruntime/releases/download/v1.30.0/onnxruntime-win-x64-gpu_cuda12-1.30.0.zip'
$runtimeSha = 'd4667ea48eb0a10bc9b96b838f7b8975a6bf18de3bc5edd403a22e15c1458b23'

function Download-Verified($url, $sha, $destination) {
  Invoke-WebRequest -Uri $url -OutFile $destination
  $actual = (Get-FileHash -Algorithm SHA256 -Path $destination).Hash.ToLowerInvariant()
  if ($actual -ne $sha) { throw "SHA256 mismatch: $destination ($actual)" }
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$sourceArchive = Join-Path $WorkDir 'onnxruntime-v1.30.0.tar.gz'
$runtimeArchive = Join-Path $WorkDir 'onnxruntime-gpu-cuda12-v1.30.0.zip'
Download-Verified $sourceUrl $sourceSha $sourceArchive
Download-Verified $runtimeUrl $runtimeSha $runtimeArchive
tar -xzf $sourceArchive -C $WorkDir
if ($LASTEXITCODE -ne 0) { throw 'ONNX Runtime source extraction failed' }
Expand-Archive -Path $runtimeArchive -DestinationPath $WorkDir -Force

$source = Join-Path $WorkDir 'onnxruntime-1.30.0'
$runtime = Join-Path $WorkDir 'onnxruntime-win-x64-gpu_cuda12-1.30.0'
$build = Join-Path $WorkDir 'ort-build'
New-Item -ItemType Directory -Force -Path (Join-Path $build 'Release') | Out-Null
Copy-Item (Join-Path $runtime 'lib/onnxruntime.lib') (Join-Path $build 'Release/onnxruntime.lib')
Copy-Item (Join-Path $runtime 'lib/onnxruntime.dll') (Join-Path $build 'Release/onnxruntime.dll')

Push-Location (Join-Path $source 'js/common')
try {
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'ONNX common npm install failed' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'ONNX common build failed' }
} finally { Pop-Location }

Push-Location (Join-Path $source 'js/node')
try {
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'ONNX Node npm install failed' }
  npm install --no-save --ignore-scripts --no-audit --no-fund '@types/fs-extra@11.0.4'
  if ($LASTEXITCODE -ne 0) { throw 'ONNX Node type install failed' }
  & (Join-Path $source 'js/common/node_modules/.bin/tsc.cmd') --build script
  if ($LASTEXITCODE -ne 0) { throw 'ONNX build script compile failed' }
  node script/build.js --config=Release --arch=x64 --use_cuda --onnxruntime-build-dir=$build
  if ($LASTEXITCODE -ne 0) { throw 'ONNX CUDA addon build failed' }
} finally { Pop-Location }

$addon = Join-Path $source 'js/node/bin/napi-v6/win32/x64/onnxruntime_binding.node'
New-Item -ItemType Directory -Force -Path (Split-Path $OutputFile -Parent) | Out-Null
Copy-Item $addon $OutputFile -Force
Write-Host "Windows ONNX CUDA addon built at $OutputFile"
