#requires -Version 5.1
<#
Guided source setup for Windows Server 2022 x64 with an NVIDIA GPU.
Run from an Administrator terminal:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-OGAD-Source.ps1
Tool installers use official sources. Run this file again after a restart or failure.
#>
[CmdletBinding()]
param(
    [string]$Workspace = "$env:USERPROFILE\offgrid-dev",
    [string]$Branch = 'feature/linux-core-chat-release',
    [switch]$SetupOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$script:SetupDir = Join-Path $env:LOCALAPPDATA 'OGAD-Setup'
$script:Stage = 'Start'

function Step([string]$Title) {
    $script:Stage = $Title
    Write-Host "`n=== $Title ===" -ForegroundColor Cyan
}
function Pause-Step([string]$Message) {
    Write-Host $Message -ForegroundColor Yellow
    [void](Read-Host 'Press Enter when ready')
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
        "$env:ProgramFiles\Git\cmd;$env:ProgramFiles\GitHub CLI;$env:ProgramFiles\Volta;$env:LOCALAPPDATA\Volta\bin;$env:LOCALAPPDATA\Programs\Python\Launcher"
}
function Download-Checked([string]$Url, [string]$Name, [string]$Sha256) {
    $target = Join-Path $script:SetupDir $Name
    if (Test-Path $target) {
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $Sha256) {
            return $target
        }
        Remove-Item -LiteralPath $target -Force
    }
    Write-Host "Downloading $Name. This can take several minutes."
    $partial = "$target.partial"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $partial -TimeoutSec 1800
            if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
                throw 'The download did not pass the file check.'
            }
            Move-Item -LiteralPath $partial -Destination $target -Force
            return $target
        } catch {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            if ($attempt -eq 3) { throw }
            Write-Host 'Download failed. Trying again in five seconds.'
            Start-Sleep -Seconds 5
        }
    }
}
function Request-Restart {
    Write-Host "`nA Windows restart is needed." -ForegroundColor Yellow
    Write-Host 'Save any open work. After you reconnect, run this same script again.'
    Write-Host 'Use RESTART to continue setup. To pause an AWS VM, use EC2 > Instance state > Stop instance.'
    Write-Host 'Windows Shut down follows a separate AWS setting and can terminate the instance. Check that setting first.'
    $answer = Read-Host 'Type RESTART to restart now, or press Enter to leave setup'
    if ($answer -ceq 'RESTART') { Restart-Computer -Force }
    exit 0
}
function Find-NvidiaSmi {
    $command = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($path in @(
        "$env:SystemRoot\System32\nvidia-smi.exe",
        "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
    )) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    $found = Get-ChildItem "$env:SystemRoot\System32\DriverStore\FileRepository" `
        -Filter nvidia-smi.exe -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}
function Test-Nvidia {
    $script:Smi = Find-NvidiaSmi
    if (-not $script:Smi) { return $false }
    # Native errors must not end setup before the driver repair instructions.
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $gpuText = & $script:Smi --query-gpu=name,driver_version --format=csv,noheader 2>&1
    $gpuExit = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    Write-Host ($gpuText -join "`n")
    if ($gpuExit -ne 0) { return $false }
    if ($gpuExit -eq 0 -and $gpuText) { return $true }
    return $false
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open Command Prompt with Run as administrator, then run this script again.'
    }
    if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'Run this script in 64-bit Windows PowerShell on the x64 VM.'
    }
    New-Item -ItemType Directory -Path $script:SetupDir -Force | Out-Null
    Write-Host 'This script sets up GitHub access, the GPU, and OGAD from source.'
    Write-Host 'It pauses when you need to use the browser or an installer.'
    Write-Host 'You can run it again after a restart. Installed tools are checked first.'

    Step '1 of 8: Install Git and GitHub CLI'
    Refresh-Path
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        $installer = Download-Checked `
            'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe' `
            'Git-2.55.0.5-64-bit.exe' `
            'd065a4e23c3d9a6b5073d609b5be0830227ec3ca053c083ba385061ddfaf94c6'
        Write-Host 'Installing Git. Please wait.'
        $process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP-' -Wait -PassThru
        if ($process.ExitCode -notin @(0, 3010)) { throw "Git installation failed: exit code $($process.ExitCode)." }
        if ($process.ExitCode -eq 3010) { Request-Restart }
    }
    Refresh-Path
    if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) {
        $installer = Download-Checked `
            'https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_windows_amd64.msi' `
            'gh_2.101.0_windows_amd64.msi' `
            '9ba92256a431d254706844ee1991f6f4a9559a3c3646ff7ae7fe23724bfaef83'
        Write-Host 'Installing GitHub CLI. Please wait.'
        $process = Start-Process msiexec.exe -ArgumentList "/i `"$installer`" /qn /norestart" -Wait -PassThru
        if ($process.ExitCode -notin @(0, 3010)) { throw "GitHub CLI installation failed: exit code $($process.ExitCode)." }
        if ($process.ExitCode -eq 3010) { Request-Restart }
    }
    Refresh-Path
    & git.exe --version
    if ($LASTEXITCODE -ne 0) { throw 'Git did not pass its version check.' }
    & gh.exe --version
    if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI did not pass its version check.' }

    Step '2 of 8: Sign in to GitHub'
    & gh.exe auth status --hostname github.com
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'GitHub will show a short code. Copy it and follow the browser sign-in steps.' -ForegroundColor Yellow
        Write-Host 'You can open the shown GitHub URL on your Mac and enter the code there.'
        Write-Host 'If GitHub asks whether to authenticate Git, select Yes.'
        & gh.exe auth login --hostname github.com --git-protocol https --web
        if ($LASTEXITCODE -ne 0) { throw 'GitHub sign-in was not completed. Run this script again to retry.' }
    }
    & gh.exe auth setup-git --hostname github.com
    if ($LASTEXITCODE -ne 0) { throw 'GitHub could not configure Git access.' }
    & gh.exe api user --jq .login
    if ($LASTEXITCODE -ne 0) { throw 'The GitHub account check failed.' }
    Write-Host 'The account name above is the account now in use.'

    Step '3 of 8: Install Windows media features'
    $restartMarker = Join-Path $script:SetupDir 'feature-restart.txt'
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    if (Test-Path $restartMarker) {
        if ((Get-Content $restartMarker -Raw).Trim() -eq $boot) { Request-Restart }
        Remove-Item $restartMarker -Force
    }
    Import-Module ServerManager
    $missing = @(Get-WindowsFeature Server-Media-Foundation,qWave | Where-Object { -not $_.Installed })
    if ($missing.Count -gt 0) {
        $result = Install-WindowsFeature -Name $missing.Name
        if (-not $result.Success) { throw 'Windows could not install the media features.' }
        if ("$($result.RestartNeeded)" -eq 'Yes') {
            Set-Content -LiteralPath $restartMarker -Value $boot
            Request-Restart
        }
    }

    Step '4 of 8: Check the NVIDIA GPU'
    while (-not (Test-Nvidia)) {
        Write-Host 'The NVIDIA driver check did not pass.' -ForegroundColor Yellow
        Write-Host 'For the AWS G6e VM, select Tesla / L-Series / L40S / Windows Server 2022 64-bit. For another GPU, select its model.'
        Write-Host 'Download a current compatible data center driver with CUDA 12.8 support and run its installer.'
        Write-Host 'Follow the installer steps. If a restart is required, restart and run this script again.'
        Write-Host 'Do not select Shut down. Do not disable Microsoft Remote Display Adapter.'
        Start-Process 'https://www.nvidia.com/Download/Find.aspx'
        $answer = Read-Host 'After installation, type CHECK to test again, RESTART to restart, or Enter to leave setup'
        switch ($answer.ToUpperInvariant()) {
            'CHECK' { continue }
            'RESTART' { Request-Restart }
            default { exit 0 }
        }
    }
    & $script:Smi
    Write-Host 'The NVIDIA GPU and its driver passed the check.' -ForegroundColor Green


    Step '5 of 8: Install development tools'
    function Run-Checked([string]$Program, [string[]]$Arguments) {
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE. Read the error above." }
    }
    function Get-Installer([string]$Url, [string]$Name, [string]$Publisher) {
        $target = Join-Path $script:SetupDir $Name
        Write-Host "Downloading $Name. Please wait."
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $target -TimeoutSec 1800
        $sig = Get-AuthenticodeSignature -LiteralPath $target
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch $Publisher) {
            throw "The installer publisher check failed for $Name. Do not run this file."
        }
        return $target
    }
    function Install-Gui([string]$Path, [string]$Options = '') {
        Write-Host 'Complete the installer window. Read and accept its terms if you agree.' -ForegroundColor Yellow
        if ($Path.EndsWith('.msi')) {
            $process = Start-Process msiexec.exe -ArgumentList "/i `"$Path`" /norestart" -Wait -PassThru
        } elseif ($Options) {
            $process = Start-Process $Path -ArgumentList $Options -Wait -PassThru
        } else {
            $process = Start-Process $Path -Wait -PassThru
        }
        if ($process.ExitCode -in @(3010, 1641)) { Request-Restart }
        if ($process.ExitCode -ne 0) { throw "Installer stopped with code $($process.ExitCode). Run setup again after you fix the error." }
        Refresh-Path
    }
    if (-not (Get-Command volta.exe -ErrorAction SilentlyContinue)) {
        # SHA-256 of the official Volta v2.0.2 x64 MSI.
        $installer = Download-Checked 'https://github.com/volta-cli/volta/releases/download/v2.0.2/volta-2.0.2-windows-x86_64.msi' 'volta-2.0.2-windows-x86_64.msi' '104bf5518177990e4c4de78097caa747eb8f64e1149bfdfa9106f4a3d3e5f10b'
        Install-Gui $installer
    }
    Run-Checked 'volta.exe' @('--version')
    Run-Checked 'volta.exe' @('install', 'node@22')
    Refresh-Path
    Run-Checked 'node.exe' @('--version')

    function Find-Python {
        if (Get-Command py.exe -ErrorAction SilentlyContinue) {
            $savedPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            $result = & py.exe -3.12 -c 'import sys; print(sys.executable)' 2>$null
            $code = $LASTEXITCODE
            $ErrorActionPreference = $savedPreference
            if ($code -eq 0 -and $result) { return "$result".Trim() }
        }
        foreach ($candidate in @("$env:ProgramFiles\Python312\python.exe", "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")) {
            if (Test-Path $candidate) { return $candidate }
        }
        return $null
    }
    $python = Find-Python
    if (-not $python) {
        $installer = Get-Installer 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' 'python312.exe' 'Python Software Foundation'
        Write-Host 'Install Python 3.12 with pip and the Python launcher. Keep Add Python to PATH selected.'
        Install-Gui $installer 'InstallAllUsers=1 PrependPath=1 Include_launcher=1 InstallLauncherAllUsers=1 Include_pip=1'
        $python = Find-Python
    }
    if (-not $python) { throw 'Python 3.12 is still missing. Complete its installation, then run this script again.' }
    Run-Checked $python @('-c', 'import sys; assert sys.version_info[:2] == (3,12); print(sys.version)')
    $env:npm_config_python = $python
    $env:PYTHON = $python
    $env:npm_config_msvs_version = '2022'
    function Find-CppTools {
        $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vswhere) {
            & $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        }
    }
    if (-not (Find-CppTools)) {
        $installer = Get-Installer 'https://aka.ms/vs/17/release/vs_BuildTools.exe' 'vs_BuildTools.exe' 'Microsoft Corporation'
        Write-Host 'Install Desktop development with C++. Keep the recommended Windows SDK selected.'
        Install-Gui $installer '--wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        while (-not (Find-CppTools)) {
            Write-Host 'Build Tools installation is not complete. The installer itself is not the C++ toolset.' -ForegroundColor Yellow
            $answer = Read-Host 'Finish Desktop development with C++ in the installer, then type CHECK. Press Enter to stop'
            if ($answer -ine 'CHECK') { throw 'C++ tools are not ready. Complete installation, then run this file again.' }
            Refresh-Path
        }
    }

    $sdkHeaders = "${env:ProgramFiles(x86)}\Windows Kits\10\Include"
    $sdkReady = @(Get-ChildItem $sdkHeaders -Directory -ErrorAction SilentlyContinue | Where-Object {
        (Test-Path (Join-Path $_.FullName 'um\Windows.h')) -and (Test-Path (Join-Path $_.FullName 'ucrt\stdio.h'))
    })
    if ($sdkReady.Count -eq 0) { throw 'Windows SDK headers are missing. In Visual Studio Installer, select Modify, add the recommended Windows SDK, and run setup again.' }

    Step '6 of 8: Get source and check private repository access'
    foreach ($repo in @('OGAD', 'shared', 'desktop-pro', 'executorch-speech')) {
        Run-Checked 'gh.exe' @('repo', 'view', "off-grid-ai/$repo", '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
    }
    New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
    function Sync-Source([string]$Repo, [string]$Destination, [string]$Ref) {
        if (-not (Test-Path $Destination)) {
            Run-Checked 'gh.exe' @('repo', 'clone', $Repo, $Destination, '--', '--branch', $Ref)
        } else {
            if (-not (Test-Path (Join-Path $Destination '.git'))) { throw "$Destination exists but is not a source checkout." }
            $remote = & git.exe -C $Destination remote get-url origin
            if ($LASTEXITCODE -ne 0 -or $remote -notmatch ([regex]::Escape($Repo) + '(\.git)?$')) { throw "Unexpected repository at $Destination. Use another -Workspace folder." }
            $dirty = & git.exe -C $Destination status --porcelain
            if ($LASTEXITCODE -ne 0) { throw "Cannot read source status at $Destination." }
            if ($dirty) {
                Write-Warning "Local changes found at $Destination. Keeping this checkout and skipping its source update."
                Write-Host 'Setup will continue using the files already in this folder.'
                return
            }
            Run-Checked 'git.exe' @('-C', $Destination, 'fetch', 'origin', $Ref)
            Run-Checked 'git.exe' @('-C', $Destination, 'switch', $Ref)
            Run-Checked 'git.exe' @('-C', $Destination, 'pull', '--ff-only', 'origin', $Ref)
        }
    }
    $desktop = Join-Path $Workspace 'desktop'
    $shared = Join-Path $Workspace 'shared'
    $speech = Join-Path $Workspace 'executorch-speech'
    $previousSmudge = $env:GIT_LFS_SKIP_SMUDGE
    $env:GIT_LFS_SKIP_SMUDGE = '1'
    try {
        Sync-Source 'off-grid-ai/OGAD' $desktop $Branch
        Sync-Source 'off-grid-ai/shared' $shared $Branch
        Sync-Source 'off-grid-ai/executorch-speech' $speech 'main'
        # Use the Pro commit recorded by Desktop, not the latest Pro main commit.
        Run-Checked 'git.exe' @('-C', $desktop, 'submodule', 'update', '--init', 'pro')
    } finally { $env:GIT_LFS_SKIP_SMUDGE = $previousSmudge }

    function Run-KevScript([string]$ScriptPath) {
        # Older branch copies pass double quotes through Python -c, which fails
        # under Windows PowerShell 5.1. Convert those calls to stdin in a temporary
        # sibling file. Keep the original source and PSScriptRoot unchanged.
        $fullPath = (Resolve-Path $ScriptPath).Path
        $source = Get-Content -LiteralPath $fullPath -Raw
        $pattern = '& \$(Python|KevPython) -c (''[^''\r\n]*'')'
        $source = [regex]::Replace($source, $pattern, {
            param($match)
            $match.Groups[2].Value + ' | & $' + $match.Groups[1].Value + ' -'
        })
        $temporary = Join-Path (Split-Path $fullPath) ('.ogad-setup-' + [guid]::NewGuid() + '.ps1')
        try {
            Set-Content -LiteralPath $temporary -Value $source -Encoding UTF8
            Run-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $temporary)
        } finally {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }

    Step '7 of 8: Build OGAD and check CUDA'
    Push-Location $desktop
    try {
        Run-Checked 'git.exe' @('lfs', 'install', '--local', '--skip-repo')
        Run-Checked 'git.exe' @('lfs', 'pull', '--include=resources/bin/kev-local-server.py', '--exclude=')
        Run-Checked 'npm.cmd' @('--prefix', $shared, 'ci')
        foreach ($package in @('models', 'sync', 'use', 'automation', 'speech', 'ui', 'rag', 'design')) {
            Run-Checked 'npm.cmd' @('--prefix', (Join-Path $shared "packages\$package"), 'run', 'build')
        }
        Run-Checked 'npm.cmd' @('ci')
        Run-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\fetch-win-binaries.ps1')
        # A checkpoint is written only after the complete runtime build succeeds.
        $runtimeStamp = Join-Path $script:SetupDir 'kev-build.sha256'
        $runtimeHash = (Get-FileHash 'scripts\build-kev-runtime.ps1' -Algorithm SHA256).Hash
        $runtimePython = Join-Path $desktop 'resources\bin\kev-runtime\python\python.exe'
        $runtimeReady = $false
        # Recover a completed pip install if an older setup failed during cleanup.
        # A changed builder with an existing checkpoint still forces a rebuild.
        if (Test-Path $runtimePython) {
            if (-not (Test-Path $runtimeStamp) -or (Get-Content $runtimeStamp -Raw).Trim() -eq $runtimeHash) {
                'import kev, torch, uvicorn; assert torch.version.cuda' | & $runtimePython -
                $runtimeReady = ($LASTEXITCODE -eq 0)
            }
        }
        if (-not $runtimeReady) {
            Run-KevScript 'scripts\build-kev-runtime.ps1'
        }
        Run-KevScript 'scripts\enable-win-kev-gpu.ps1'
        Run-Checked $runtimePython @('resources\bin\kev-local-server.py', '--help')
        Run-Checked 'npm.cmd' @('run', 'build')
        Set-Content $runtimeStamp $runtimeHash
        Write-Host 'Dependencies, Kev server check, and CUDA operation passed. Model inference still needs an app test.' -ForegroundColor Green

        # Remove the previous VM-only requirement; the app selects a supported backend.
        [Environment]::SetEnvironmentVariable('OFFGRID_REQUIRE_CUDA', $null, 'User')
        Remove-Item Env:OFFGRID_REQUIRE_CUDA -ErrorAction SilentlyContinue

        Step '8 of 8: Start OGAD from source'
        Write-Host "Source folder: $desktop"
        Write-Host 'Close any installed OGAD app before you start this source version.'
        if (-not $SetupOnly) {
            Pause-Step 'Press Enter to start OGAD. Keep this window open while the app runs.'
            Run-Checked 'npm.cmd' @('run', 'dev')
        } else {
            Write-Host "Setup is complete. To start: cd /d `"$desktop`", then npm run dev."
        }
    } finally { Pop-Location }
} catch {
    Write-Host "`nSetup stopped at: $script:Stage" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Fix the reported problem, then run this same file again.'
    [void](Read-Host 'Press Enter to close setup')
    exit 1
}
