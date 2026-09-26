param(
  [string]$Workspace = "$env:USERPROFILE\offgrid-dev",
  [string]$Branch = "feature/linux-core-chat-release",
  [switch]$WithKev,
  [switch]$SetupOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Install-PackageIfMissing($command, $packageId) {
  if (Get-Command $command -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Windows Package Manager (winget) is required. Install App Installer from Microsoft Store."
  }
  Write-Host "Installing $packageId..."
  & winget install --id $packageId --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Could not install $packageId" }
  Refresh-Path
}

function Sync-Repository($repository, $directory, $ref) {
  if (-not (Test-Path (Join-Path $directory ".git"))) {
    & gh repo clone $repository $directory -- --branch $ref
    if ($LASTEXITCODE -ne 0) { throw "Could not clone $repository" }
    return
  }

  $dirty = & git -C $directory status --porcelain
  if ($dirty) {
    Write-Warning "$directory has local changes. It was not updated."
    return
  }
  & git -C $directory fetch origin $ref
  if ($LASTEXITCODE -ne 0) { throw "Could not fetch $repository" }
  & git -C $directory switch $ref
  if ($LASTEXITCODE -ne 0) { throw "Could not switch $repository to $ref" }
  & git -C $directory pull --ff-only origin $ref
  if ($LASTEXITCODE -ne 0) { throw "Could not update $repository" }
}

Install-PackageIfMissing "git" "Git.Git"
Install-PackageIfMissing "gh" "GitHub.cli"
Install-PackageIfMissing "volta" "Volta.Volta"
Install-PackageIfMissing "py" "Python.Python.3.12"

& volta install node@22
if ($LASTEXITCODE -ne 0) { throw "Could not install Node.js 22" }
Refresh-Path

& gh auth status --hostname github.com 2>$null
if ($LASTEXITCODE -ne 0) {
  & gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0) { throw "GitHub login failed" }
}
& gh auth setup-git

New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$desktop = Join-Path $Workspace "desktop"
$shared = Join-Path $Workspace "shared"
$speech = Join-Path $Workspace "executorch-speech"
$pro = Join-Path $desktop "pro"

Sync-Repository "off-grid-ai/OGAD" $desktop $Branch
Sync-Repository "off-grid-ai/shared" $shared $Branch
Sync-Repository "off-grid-ai/executorch-speech" $speech "main"
Sync-Repository "off-grid-ai/desktop-pro" $pro "main"

& git -C $desktop lfs install
& git -C $desktop lfs pull --include="resources/bin/kev-local-server.py" --exclude=""

Write-Host "Preparing shared packages..."
& npm --prefix $shared ci
if ($LASTEXITCODE -ne 0) { throw "Shared dependency installation failed" }
& npm --prefix $shared run build
if ($LASTEXITCODE -ne 0) { throw "Shared package build failed" }

Write-Host "Preparing Desktop..."
$env:npm_config_python = (& py -3.12 -c "import sys; print(sys.executable)").Trim()
& npm --prefix $desktop ci
if ($LASTEXITCODE -ne 0) {
  throw "Desktop dependency installation failed. Install Visual Studio 2022 Build Tools with the C++ workload, then run this script again."
}
& powershell -ExecutionPolicy Bypass -File (Join-Path $desktop "scripts/fetch-win-binaries.ps1")
if ($LASTEXITCODE -ne 0) { throw "Windows runtime setup failed" }

if ($WithKev) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $desktop "scripts/build-kev-runtime.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Kev runtime setup failed" }
}

Write-Host "Windows development environment is ready at $desktop"
if (-not $SetupOnly) {
  Set-Location $desktop
  & npm run dev
}
