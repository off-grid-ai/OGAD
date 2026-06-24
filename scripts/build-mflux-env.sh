#!/usr/bin/env bash
# Build a relocatable, fully-offline Python + MLX (mflux) environment bundled
# into resources/bin/mflux/. This is the MLX image runtime (FLUX + Z-Image with
# LoRA). Apple Silicon only. Run this BEFORE electron-builder packaging.
#
#   resources/bin/mflux/bin/python3 -m mflux.generate ...
#
# The env is large (~1-2GB) and is gitignored — rebuild via this script.
set -euo pipefail

MFLUX_VERSION="${MFLUX_VERSION:-}"   # empty = latest on PyPI; or pin e.g. 0.10.0
PYTHON_SERIES="3.11"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/resources/bin/mflux"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$(uname -m)" != "arm64" ]; then
  echo "error: MLX requires Apple Silicon (arm64). This machine is $(uname -m)." >&2
  exit 1
fi

echo ">> resolving latest python-build-standalone $PYTHON_SERIES (aarch64-apple-darwin, install_only)…"
# Query the GitHub release API for the newest install_only asset for our series.
# NB: browser_download_url URL-encodes the '+' in the version as %2B, so match
# loosely between the version and the arch. '|| true' so a head SIGPIPE under
# pipefail doesn't abort.
ASSET_URL="$(curl -fsSL https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
  | grep -oE 'https://[^"]*cpython-'"$PYTHON_SERIES"'\.[0-9]+[^"]*aarch64-apple-darwin-install_only\.tar\.gz' \
  | head -1 || true)"
if [ -z "$ASSET_URL" ]; then
  echo "error: could not find a python-build-standalone install_only asset for $PYTHON_SERIES." >&2
  exit 1
fi
echo "   $ASSET_URL"

echo ">> downloading + extracting standalone CPython…"
curl -fsSL "$ASSET_URL" -o "$TMP/python.tar.gz"
tar -xzf "$TMP/python.tar.gz" -C "$TMP"          # extracts to $TMP/python/

echo ">> placing env at $DEST (fresh)…"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$TMP/python" "$DEST"

PY="$DEST/bin/python3"
echo ">> python: $("$PY" --version)"

echo ">> upgrading pip and installing mflux${MFLUX_VERSION:+==$MFLUX_VERSION}…"
"$PY" -m pip install --upgrade pip wheel
if [ -n "$MFLUX_VERSION" ]; then
  "$PY" -m pip install "mflux==$MFLUX_VERSION"
else
  "$PY" -m pip install mflux
fi

echo ">> pruning to shrink the bundle…"
# Remove test suites, caches, and bytecode (re-generated on first run).
find "$DEST" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type d -name "test" -prune -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null || true

echo ">> recording versions…"
"$PY" -m pip show mflux mlx 2>/dev/null | grep -E '^(Name|Version):' || true
"$PY" -m pip freeze > "$DEST/requirements.lock.txt" || true

echo ">> sanity import…"
"$PY" -c "import mflux, mlx; print('mflux + mlx import OK')"

echo ">> done. env size: $(du -sh "$DEST" | cut -f1)"
echo "   run: $PY -m mflux.generate --help   (or the mflux-generate console entry)"
