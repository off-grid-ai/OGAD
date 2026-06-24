#!/usr/bin/env bash
# Convert a full SDXL .safetensors checkpoint into sd.cpp-loadable GGUFs (q8_0 + q4_K)
# and emit an attributed, OpenRAIL model card — ready to publish under an Off Grid
# HF org. The mis-exported community GGUFs of these finetunes don't load; converting
# the official webui .safetensors with our bundled sd-cli produces correctly-named
# GGUFs that DO load on-device.
#
# Usage:
#   scripts/build-sd-gguf.sh <hf_repo> <safetensors_file> <out_basename> "<Display Name>" "<orig license>" "<orig repo url>"
# Example:
#   scripts/build-sd-gguf.sh cagliostrolab/animagine-xl-4.0 animagine-xl-4.0.safetensors animagine-xl-4.0 "Animagine XL 4.0" "openrail++" "https://huggingface.co/cagliostrolab/animagine-xl-4.0"
set -euo pipefail

REPO="${1:?hf repo}"; SRC="${2:?safetensors filename}"; OUT="${3:?out basename}"
NAME="${4:-$OUT}"; LICENSE="${5:-creativeml-openrail-m}"; ORIG_URL="${6:-https://huggingface.co/$REPO}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SD="$ROOT/resources/bin/sd/sd-cli"
BUILD="$ROOT/build-sd-gguf/$OUT"
mkdir -p "$BUILD"
ST="$BUILD/$SRC"

echo "==> [1/4] download $REPO/$SRC"
if [ ! -s "$ST" ]; then
  curl -L --fail --retry 3 -o "$ST" "https://huggingface.co/$REPO/resolve/main/$SRC"
else
  echo "    (cached)"
fi

convert() { # <type> <suffix>
  local type="$1"
  local suf="$2"
  local out="$BUILD/$OUT-$suf.gguf"
  echo "==> convert $type -> $(basename "$out")"
  DYLD_LIBRARY_PATH="$ROOT/resources/bin/sd" "$SD" -M convert -m "$ST" -o "$out" --type "$type"
  echo "==> verify $(basename "$out") is sd.cpp-loadable"
  python3 "$ROOT/scripts/verify-gguf-compat.py" "$out"
}
echo "==> [2/5] convert q8_0"; convert q8_0 Q8_0
echo "==> [3/5] convert q4_K"; convert q4_K Q4_K

echo "==> [4/5] test-generate a real image with q8 (gate before publish)"
TIMG="$BUILD/_test.png"; rm -f "$TIMG"
DYLD_LIBRARY_PATH="$ROOT/resources/bin/sd" "$SD" -M img_gen -m "$BUILD/$OUT-Q8_0.gguf" \
  -p "a golden retriever on a beach, detailed, high quality" -n "lowres, blurry, deformed" \
  -o "$TIMG" -W 512 -H 512 --steps 8 --cfg-scale 4 --sampling-method euler -t 6 -s 42 >/dev/null 2>&1 || true
TSZ="$(stat -f%z "$TIMG" 2>/dev/null || echo 0)"
if [ ! -s "$TIMG" ] || [ "$TSZ" -lt 51200 ]; then
  echo "    TEST FAILED: no valid image produced ($TSZ bytes) — NOT publishing"; exit 3
fi
echo "    test image OK ($TSZ bytes)"; rm -f "$TIMG"

echo "==> [5/5] write model card"
cat > "$BUILD/README.md" <<EOF
---
license: $LICENSE
base_model: $REPO
tags: [gguf, stable-diffusion, sdxl, off-grid, text-to-image]
---

# $NAME — GGUF (Off Grid build)

GGUF conversions of [$NAME]($ORIG_URL) for on-device generation with
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) and
[Off Grid AI Desktop](https://offgridmobileai.co/). Converted with sd.cpp's \`-M convert\`
so the tensors are correctly named and load directly (the existing community GGUF
quants are mis-exported and fail \`get sd version from file\`).

- \`$OUT-Q8_0.gguf\` — best quality, ~3.5GB
- \`$OUT-Q4_K.gguf\` — lighter, ~2GB

**Original model:** $ORIG_URL — created by its respective authors.
**License:** $LICENSE (carried over from the original; use restrictions apply).
This is a format conversion only; all credit for the model belongs to the original creators.
EOF

echo "==> done. files in: $BUILD"
ls -la "$BUILD"
echo
echo "To publish (with your HF token):"
echo "  huggingface-cli upload offgrid/$OUT-GGUF \"$BUILD\" . --repo-type model"
