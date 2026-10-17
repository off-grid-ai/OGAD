$ErrorActionPreference = "Stop"

# Stage the self-contained Windows Kev server runtime. Model weights are never
# included here; the app downloads them through the Models screen.
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "resources/bin/kev-runtime"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("offgrid-kev-" + [guid]::NewGuid())
$PythonUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
$PythonSha256 = "7a2aef48e5ee569e310b29b32681debbc5d888e92790d85331a47736c6b06aad"
$KevRef = "6b719c3c3f367295f6ef336f4f751cf5ff970abc"

New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  $Archive = Join-Path $Temp "python.tar.gz"
  Invoke-WebRequest -Uri $PythonUrl -OutFile $Archive
  $Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
  if ($Actual -ne $PythonSha256) {
    throw "Kev Python archive checksum mismatch: expected $PythonSha256, found $Actual"
  }
  tar -xzf $Archive -C $Temp

  if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
  New-Item -ItemType Directory -Path $Dest | Out-Null
  Move-Item (Join-Path $Temp "python") (Join-Path $Dest "python")

  $Python = Join-Path $Dest "python/python.exe"
  & $Python -m pip install --disable-pip-version-check "torch==2.8.0+cu128" --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw "Could not install the Kev Torch runtime" }
  & $Python -m pip install --disable-pip-version-check "kev[serve] @ git+https://github.com/jaredpalmer/kev.git@$KevRef"
  if ($LASTEXITCODE -ne 0) { throw "Could not install the Kev server" }

  # The Torch wheel carries extension-build headers and CMake metadata. Kev only
  # needs the runtime, and packaging these files makes signing needlessly expensive.
  # Pass Python source through stdin so Windows PowerShell 5.1 keeps quotes.
  $SitePackages = 'import sysconfig; print(sysconfig.get_paths()["purelib"])' | & $Python -
  if ($LASTEXITCODE -ne 0 -or -not $SitePackages) { throw "Could not locate the Kev site-packages directory" }
  $SitePackages = ($SitePackages | Out-String).Trim()
  Remove-Item -Recurse -Force (Join-Path $SitePackages "torch/include") -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force (Join-Path $SitePackages "torch/share/cmake") -ErrorAction SilentlyContinue

  Get-ChildItem $Dest -Directory -Recurse -Force |
    Where-Object { $_.Name -in @("__pycache__", "tests", "test") } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem $Dest -File -Recurse -Force -Include *.pyc,*.pyo |
    Remove-Item -Force -ErrorAction SilentlyContinue

  # CI need not have a physical GPU, but the installed wheel must contain CUDA.
  'import kev, torch, uvicorn; assert torch.version.cuda, "CPU-only PyTorch is not allowed in the Windows Kev runtime"; print("Kev Windows CUDA runtime ready:", torch.version.cuda)' | & $Python -
  if ($LASTEXITCODE -ne 0) { throw "The staged Kev runtime failed its import check" }
  & $Python (Join-Path $Root "resources/bin/kev-local-server.py") --help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The staged Kev server failed its launch check" }
}
finally {
  if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp }
}
