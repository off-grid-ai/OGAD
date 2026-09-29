param(
  [ValidateSet('cpu', 'vulkan', 'cuda')]
  [string]$Backend = 'cpu'
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows x64 is required.' }
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root 'build\image-windows'
$source = Join-Path $cache 'source'
$build = Join-Path $cache $Backend
$name = if ($Backend -eq 'vulkan') { 'sd' } else { "sd-$Backend" }
$destination = Join-Path $root "resources\bin\$name"

# MSVC/CMake, the Vulkan SDK or CUDA 12.8 toolkit must be installed by the host.
& node (Join-Path $PSScriptRoot 'prepare-image-runtime.mjs') $source
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the patched image runtime.' }
$cuda = if ($Backend -eq 'cuda') { 'ON' } else { 'OFF' }
$vulkan = if ($Backend -eq 'vulkan') { 'ON' } else { 'OFF' }
& cmake -S $source -B $build -A x64 '-DCMAKE_BUILD_TYPE=Release' `
  "-DSD_CUDA=$cuda" "-DSD_VULKAN=$vulkan" '-DSD_BUILD_EXAMPLES=ON' `
  '-DSD_SERVER_BUILD_FRONTEND=OFF' '-DSD_BUILD_SHARED_LIBS=ON' `
  '-DSD_BUILD_SHARED_GGML_LIB=ON' '-DGGML_NATIVE=OFF' '-DGGML_CUDA_NCCL=OFF' '-DCMAKE_CUDA_ARCHITECTURES=61;70;75;80;86;89;90'
if ($LASTEXITCODE -ne 0) { throw "Could not configure the $Backend image runtime." }
& cmake --build $build --config Release --target sd-cli sd-server --parallel 4
if ($LASTEXITCODE -ne 0) { throw "Could not build the $Backend image runtime." }
$cli = Get-ChildItem $build -Recurse -Filter sd-cli.exe | Select-Object -First 1
if (-not $cli) { throw 'Built image CLI is missing.' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Get-ChildItem $cli.DirectoryName -File | Where-Object { $_.Extension -in '.exe', '.dll' } |
  Copy-Item -Destination $destination -Force
Copy-Item (Join-Path $source 'LICENSE') $destination -Force
$env:PATH = "$destination;$(Join-Path $root 'resources\bin\cuda-runtime');$env:PATH"
$help = & (Join-Path $destination 'sd-cli.exe') --help 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or -not $help.Contains('--decode-preview-path')) {
  throw 'Built image runtime does not expose decoded video previews.'
}
Write-Host "Patched $Backend image/video runtime ready at $destination"
