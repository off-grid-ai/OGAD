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
SAMPLE_PROMPT="${7:-a golden retriever on a beach, detailed, high quality}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SD="$ROOT/resources/bin/sd/sd-cli"
BUILD="$ROOT/build-sd-gguf/$OUT"
mkdir -p "$BUILD"
ST="$BUILD/$SRC"

echo "==> [1/5] download $REPO/$SRC"
if [ ! -s "$ST" ]; then
  # hf_hub_download resumes partial transfers and retries HF connection resets —
  # plain curl restarts from 0 on a reset and re-fails on big checkpoints.
  python3 - "$REPO" "$SRC" "$BUILD" <<'PY'
import sys
from huggingface_hub import hf_hub_download
repo, src, build = sys.argv[1], sys.argv[2], sys.argv[3]
hf_hub_download(repo_id=repo, filename=src, local_dir=build)
PY
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

# Sample image — doubles as the publish gate (must produce a valid PNG) AND the
# card showcase. Few-step models (lightning/turbo) need low steps + low cfg;
# full models use more steps. Sized 768 for a crisp-but-fast sample.
case "$OUT" in
  *lightning*|*turbo*) S_STEPS=6;  S_CFG=1.5; S_SAMP=euler;;
  *)                   S_STEPS=24; S_CFG=5;   S_SAMP="dpm++2m";;
esac
echo "==> [4/5] generate sample with q8 (gate + card showcase)"
SAMPLE="$BUILD/sample.png"; rm -f "$SAMPLE"
DYLD_LIBRARY_PATH="$ROOT/resources/bin/sd" "$SD" -M img_gen -m "$BUILD/$OUT-Q8_0.gguf" \
  -p "$SAMPLE_PROMPT" -n "lowres, blurry, deformed, watermark, text" \
  -o "$SAMPLE" -W 768 -H 768 --steps "$S_STEPS" --cfg-scale "$S_CFG" --sampling-method "$S_SAMP" -t 6 -s 7 >/dev/null 2>&1 || true
SSZ="$(stat -f%z "$SAMPLE" 2>/dev/null || echo 0)"
if [ ! -s "$SAMPLE" ] || [ "$SSZ" -lt 51200 ]; then
  echo "    SAMPLE/TEST FAILED: no valid image ($SSZ bytes) — NOT publishing"; exit 3
fi
echo "    sample OK ($SSZ bytes)"

echo "==> [5/5] write model card"
cat > "$BUILD/README.md" <<EOF
---
license: $LICENSE
base_model: $REPO
base_model_relation: quantized
pipeline_tag: text-to-image
tags: [gguf, stable-diffusion, sdxl, image-generation, quantized, off-grid]
---

# $NAME — GGUF (Off Grid build)

GGUF conversions of [$NAME]($ORIG_URL) for **on-device** image generation with
[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp). Converted with
sd.cpp's \`-M convert\` so the tensors are correctly named and load directly — the
community GGUF quants of this model are mis-exported and fail \`get sd version from file\`.

![sample](sample.png)

## Files
- \`$OUT-Q8_0.gguf\` — best quality
- \`$OUT-Q4_K.gguf\` — lighter / lower RAM

## Use with stable-diffusion.cpp
\`\`\`bash
sd -M img_gen -m $OUT-Q8_0.gguf -p "your prompt" -o out.png \\
  -W 1024 -H 1024 --steps $S_STEPS --cfg-scale $S_CFG --sampling-method $S_SAMP
\`\`\`
Built for **Off Grid AI Desktop** — a private, fully on-device AI app ([offgridmobileai.co](https://offgridmobileai.co/)).

## Credit & license
**Original model:** $ORIG_URL — created by its respective authors.
**License:** \`$LICENSE\` (carried over from the original; its use restrictions apply).
This is a format conversion (quantization) only; all credit for the model belongs to the original creators.
EOF

echo "==> done. files in: $BUILD"
ls -la "$BUILD"
echo
echo "To publish (with your HF token):"
echo "  huggingface-cli upload offgrid/$OUT-GGUF \"$BUILD\" . --repo-type model"
