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
  local type="$1" suf="$2" out="$BUILD/$OUT-$suf.gguf"
  echo "==> convert $type -> $(basename "$out")"
  DYLD_LIBRARY_PATH="$ROOT/resources/bin/sd" "$SD" -M convert -m "$ST" -o "$out" --type "$type"
  echo "==> verify $(basename "$out") is sd.cpp-loadable"
  python3 "$ROOT/scripts/verify-gguf-compat.py" "$out"
}
echo "==> [2/4] convert q8_0"; convert q8_0 Q8_0
echo "==> [3/4] convert q4_K"; convert q4_K Q4_K

echo "==> [4/4] write model card"
cat > "$BUILD/README.md" <<EOF
---
license: $LICENSE
base_model: $REPO
tags: [gguf, stable-diffusion, sdxl, off-grid, text-to-image]
---

# $NAME — GGUF (Off Grid build)

GGUF conversions of [$NAME]($ORIG_URL) for on-device generation with
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) and
[Off Grid AI Desktop](https://offgrid.ai). Converted with sd.cpp's \`-M convert\`
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
