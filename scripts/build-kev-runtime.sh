#!/usr/bin/env bash
# Stage the self-contained macOS Kev server runtime. Model weights are never
# included here; the app downloads them through the Models screen.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/resources/bin/kev-runtime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.12.15%2B20261013-aarch64-apple-darwin-install_only_stripped.tar.gz"
PYTHON_SHA256="9866e11cf2ae9caa1e671383786f248859a52dd8bfb702fb4c0dc2c65f1d36de"
KEV_REF="6b719c3c3f367295f6ef336f4f751cf5ff970abc"
MLX_URL="https://files.pythonhosted.org/packages/6d/92/7a999dcf6460525a31e555905cdca2f835ec0d786c528e969e04cd00d158/mlx-0.32.4-cp312-cp312-macosx_15_0_arm64.whl"
MLX_SHA256="f0604cb3015091f285c79c7b7dbfcabcfa9948248728c7bab6e0263513c3d3fe"
MLX_METAL_URL="https://files.pythonhosted.org/packages/54/8c/9754dd6c4db485037f59cc8be6495738e14cdeb8bf19d5bddb5e96da890f/mlx_metal-0.32.4-py3-none-macosx_15_0_arm64.whl"
MLX_METAL_SHA256="9f0a3cc26d89724434d9684932fc6f3e4e83669d2a895d858ed2c8a55eb84e8b"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "error: the macOS Kev runtime requires Apple Silicon" >&2
  exit 1
fi

curl -fsSL "$PYTHON_URL" -o "$TMP/python.tar.gz"
echo "$PYTHON_SHA256  $TMP/python.tar.gz" | shasum -a 256 -c -
tar -xzf "$TMP/python.tar.gz" -C "$TMP"

rm -rf "$DEST"
mkdir -p "$DEST"
mv "$TMP/python" "$DEST/python"

PYTHON="$DEST/python/bin/python3"
"$PYTHON" -m pip install --disable-pip-version-check \
  "kev[serve] @ git+https://github.com/jaredpalmer/kev.git@$KEV_REF"
# pip otherwise prefers a wheel built for the build host's macOS release. Pin
# the macOS 15 wheel, the app's minimum, so release builds made on macOS 26 still
# run on macOS 15 and newer.
curl -fsSL "$MLX_URL" -o "$TMP/mlx-0.32.4-cp312-cp312-macosx_15_0_arm64.whl"
curl -fsSL "$MLX_METAL_URL" -o "$TMP/mlx_metal-0.32.4-py3-none-macosx_15_0_arm64.whl"
echo "$MLX_SHA256  $TMP/mlx-0.32.4-cp312-cp312-macosx_15_0_arm64.whl" | shasum -a 256 -c -
echo "$MLX_METAL_SHA256  $TMP/mlx_metal-0.32.4-py3-none-macosx_15_0_arm64.whl" | shasum -a 256 -c -
"$PYTHON" -m pip install --disable-pip-version-check --force-reinstall --no-deps \
  "$TMP/mlx-0.32.4-cp312-cp312-macosx_15_0_arm64.whl" \
  "$TMP/mlx_metal-0.32.4-py3-none-macosx_15_0_arm64.whl"

# PyTorch wheels include C++ headers and CMake metadata for compiling extensions.
# Kev only imports the packaged runtime, so these build-only files add no runtime
# value and make codesign traverse tens of thousands of unnecessary files.
SITE_PACKAGES="$($PYTHON -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
rm -rf "$SITE_PACKAGES/torch/include" "$SITE_PACKAGES/torch/share/cmake"

find "$DEST" -type d \( -name __pycache__ -o -name tests -o -name test \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete 2>/dev/null || true
"$PYTHON" -c 'import kev, mlx_lm, torch, uvicorn; print("Kev macOS runtime ready")'
"$PYTHON" "$ROOT/resources/bin/kev-local-server.py" --help >/dev/null
du -sh "$DEST"
