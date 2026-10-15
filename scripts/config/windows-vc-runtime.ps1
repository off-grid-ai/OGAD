# App-local VC++ runtime for each native executable, including optional engines.
function Copy-VCRuntime($Destination) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { throw "VC++ redist not found: vswhere is missing at $vswhere" }
  $installation = & $vswhere -latest -products '*' -property installationPath
  if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'VC++ redist not found: install Visual Studio C++ build tools' }
  $redistRoot = Join-Path $installation 'VC\Redist\MSVC'
  if (-not (Test-Path $redistRoot)) { throw "VC++ redist folder not found: $redistRoot" }
  $version = Get-ChildItem $redistRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if (-not $version) { throw "VC++ redist version folder not found: $redistRoot" }
  $x64 = Join-Path $version.FullName 'x64'
  if (-not (Test-Path $x64)) { throw "VC++ x64 redist folder not found: $x64" }
  $folders = @(Get-ChildItem $x64 -Directory | Where-Object { $_.Name -match '^Microsoft\.VC14.*\.(CRT|OpenMP)$' })
  if ($folders.Count -lt 2) { throw "VC++ CRT/OpenMP redist folders not found: $x64" }
  foreach ($name in @('MSVCP140.dll', 'MSVCP140_1.dll', 'MSVCP140_2.dll',
      'MSVCP140_ATOMIC_WAIT.dll', 'MSVCP140_CODECVT_IDS.dll', 'VCRUNTIME140.dll',
      'VCRUNTIME140_1.dll', 'CONCRT140.dll', 'VCOMP140.dll')) {
    $source = $folders | ForEach-Object { Join-Path $_.FullName $name } |
      Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $source) { throw "VC++ redist DLL missing: $name under $x64" }
    Copy-Item -LiteralPath $source -Destination $Destination -Force
  }
}
