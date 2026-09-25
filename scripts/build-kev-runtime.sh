#!/usr/bin/env bash
# Stage the self-contained macOS Kev server runtime. Model weights are never
# included here; the app downloads them through the Models screen.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/resources/bin/kev-runtime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-aarch64-apple-darwin-install_only_stripped.tar.gz"
PYTHON_SHA256="81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b"
KEV_REF="9145646c4188e1ed929fb6478d93df437cb57cf7"
MLX_URL="https://files.pythonhosted.org/packages/c3/47/5f33906cb03d6a378a697cd2d2641a26b37dea17ee3d9124d7e39e8eca01/mlx-0.31.2-cp312-cp312-macosx_14_0_arm64.whl"
MLX_SHA256="e5067aaf2be1f3d7bba5be52348775804f111173c1ed04639618fd713b1a530f"
MLX_METAL_URL="https://files.pythonhosted.org/packages/3f/69/fe3b783ebe999f3118234e1e940feb622518bfb1dea6ac5d13b1d36a8449/mlx_metal-0.31.2-py3-none-macosx_14_0_arm64.whl"
MLX_METAL_SHA256="b25385bcee18fc194092255b8b53b9a3d8489eb650e59160f1b57aadd07aa2dc"

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
# the oldest wheel supported by Kev so release builds made on macOS 26 still
# run on macOS 14 and newer.
curl -fsSL "$MLX_URL" -o "$TMP/mlx-0.31.2-cp312-cp312-macosx_14_0_arm64.whl"
curl -fsSL "$MLX_METAL_URL" -o "$TMP/mlx_metal-0.31.2-py3-none-macosx_14_0_arm64.whl"
echo "$MLX_SHA256  $TMP/mlx-0.31.2-cp312-cp312-macosx_14_0_arm64.whl" | shasum -a 256 -c -
echo "$MLX_METAL_SHA256  $TMP/mlx_metal-0.31.2-py3-none-macosx_14_0_arm64.whl" | shasum -a 256 -c -
"$PYTHON" -m pip install --disable-pip-version-check --force-reinstall --no-deps \
  "$TMP/mlx-0.31.2-cp312-cp312-macosx_14_0_arm64.whl" \
  "$TMP/mlx_metal-0.31.2-py3-none-macosx_14_0_arm64.whl"

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
