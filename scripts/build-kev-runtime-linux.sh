#!/usr/bin/env bash
# Self-contained Linux x64 Kev runtime; model weights are downloaded in the app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/build/linux-bin/kev-runtime"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Linux x64 is required' >&2; exit 1; }
PYTHON_URL='https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.12.14%2B20260924-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
PYTHON_SHA256='269b2c99e4db15b242bf01832f4fea1e8f1a664f273cff519393f296e9820b41'
KEV_REF='9145646c4188e1ed929fb6478d93df437cb57cf7'
git -C "$ROOT" lfs pull --include='resources/bin/kev-local-server.py' --exclude=''
if head -n 1 "$ROOT/resources/bin/kev-local-server.py" | grep -q '^version https://git-lfs.github.com/spec/'; then
  echo 'Kev launcher is still an LFS pointer' >&2
  exit 1
fi
if [[ "${OFFGRID_KEV_PREBUILT:-0}" == 1 ]]; then
  "$DEST/python/bin/python3" -c 'import kev, torch, uvicorn; assert torch.version.cuda'
  "$DEST/python/bin/python3" "$ROOT/resources/bin/kev-local-server.py" --help >/dev/null
  cp "$ROOT/resources/bin/kev-local-server.py" "$ROOT/build/linux-bin/kev-local-server.py"
  echo '[build-kev-runtime-linux] reused pinned CUDA runtime'
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 "$PYTHON_URL" -o "$TMP/python.tar.gz"
echo "$PYTHON_SHA256  $TMP/python.tar.gz" | sha256sum -c -
tar -xzf "$TMP/python.tar.gz" -C "$TMP"
PYTHON="$TMP/python/bin/python3"
"$PYTHON" -m pip install --no-cache-dir --disable-pip-version-check \
  'torch==2.8.0+cu128' --index-url https://download.pytorch.org/whl/cu128
"$PYTHON" -m pip install --no-cache-dir --disable-pip-version-check \
  'torch==2.8.0+cu128' "kev[serve] @ git+https://github.com/jaredpalmer/kev.git@$KEV_REF"
# Check the payload on CPU-only build runners; do not require a physical GPU.
"$PYTHON" -c 'import kev, torch, uvicorn; assert torch.version.cuda, "Kev requires a CUDA-enabled wheel"'
"$PYTHON" "$ROOT/resources/bin/kev-local-server.py" --help >/dev/null
mkdir -p "$DEST"
if [[ -d "$DEST/python" ]]; then rm -rf "$DEST/python"; fi
mv "$TMP/python" "$DEST/python"
cp "$ROOT/resources/bin/kev-local-server.py" "$ROOT/build/linux-bin/kev-local-server.py"
# Verify imports after relocation as well; no host Python is used at runtime.
"$DEST/python/bin/python3" -c 'import kev, torch, uvicorn; assert torch.version.cuda'
