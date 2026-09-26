$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$KevPython = Join-Path $Root "resources/bin/kev-runtime/python/python.exe"
if (-not (Test-Path $KevPython)) { throw "Kev runtime is missing. Run scripts/build-kev-runtime.ps1 first." }

# Upgrade existing development installs without downloading Python and Kev again.
& $KevPython -m pip install --disable-pip-version-check "torch==2.8.0+cu128" --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { throw "Could not install CUDA-enabled PyTorch for Kev" }
& $KevPython -c 'import torch; assert torch.version.cuda, "CPU-only Torch is installed"; assert torch.cuda.is_available(), "CUDA is not available: check the NVIDIA driver"; x = torch.ones(8, device="cuda"); torch.cuda.synchronize(); print("Kev GPU ready:", torch.cuda.get_device_name(0))'
if ($LASTEXITCODE -ne 0) { throw "Kev GPU test failed. CPU fallback is not a successful GPU test." }
