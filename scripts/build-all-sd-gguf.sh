#!/usr/bin/env bash
# Batch: for each vetted SDXL checkpoint, convert -> verify -> publish to the
# offgrid-ai HF org, then free the disk. Sequential (one ~14GB working set at a
# time). Continues past a model that fails rather than aborting the whole run.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/build-sd-gguf/batch.log"
mkdir -p "$ROOT/build-sd-gguf"

# repo | safetensors file | out basename | Display Name | license | original repo url | sample prompt
MODELS=(
"OnomaAIResearch/Illustrious-XL-v2.0|Illustrious-XL-v2.0.safetensors|illustrious-xl-v2.0|Illustrious XL v2.0|creativeml-openrail-m|https://huggingface.co/OnomaAIResearch/Illustrious-XL-v2.0|a serene anime landscape, mountains and a lake at sunrise, lush detailed scenery, no humans, masterpiece, best quality"
"LyliaEngine/Pony_Diffusion_V6_XL|ponyDiffusionV6XL_v6StartWithThisOne.safetensors|pony-diffusion-v6-xl|Pony Diffusion V6 XL|creativeml-openrail-m|https://huggingface.co/AstraliteHeart/pony-diffusion-v6|score_9, a majestic griffin perched on a cliff at sunset, fantasy concept art, dramatic lighting, highly detailed, no humans"
"SG161222/RealVisXL_V5.0|RealVisXL_V5.0_fp16.safetensors|realvisxl-v5.0|RealVisXL V5.0|openrail++|https://huggingface.co/SG161222/RealVisXL_V5.0|a sleek modern sports car on a coastal mountain road, photorealistic, golden hour, sharp focus, ultra detailed"
"SG161222/RealVisXL_V5.0_Lightning|RealVisXL_V5.0_Lightning_fp16.safetensors|realvisxl-v5.0-lightning|RealVisXL V5.0 Lightning|openrail++|https://huggingface.co/SG161222/RealVisXL_V5.0_Lightning|a modern minimalist living room interior, photorealistic architectural photography, soft natural light, high detail"
"Lykon/dreamshaper-xl-v2-turbo|DreamShaperXL_Turbo_V2-SFW.safetensors|dreamshaper-xl-v2-turbo|DreamShaper XL v2 Turbo|openrail++|https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo|a majestic dragon over misty mountains at dawn, epic fantasy, highly detailed, cinematic, no humans"
"RunDiffusion/Juggernaut-XL-v9|Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors|juggernaut-xl-v9|Juggernaut XL v9|creativeml-openrail-m|https://huggingface.co/RunDiffusion/Juggernaut-XL-v9|a cinematic landscape, mountain lake at sunset, photorealistic, dramatic light, ultra detailed, no humans"
)

log(){ echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

for spec in "${MODELS[@]}"; do
  IFS='|' read -r repo file out name lic url prompt <<< "$spec"
  log "=== $name ($repo) ==="
  # Idempotent: skip if already published (repo has a Q8_0 gguf) — lets a re-run
  # retry only the models that failed without redoing finished ones.
  if python3 -c "import sys;from huggingface_hub import HfApi;sys.exit(0 if any(f.endswith('Q8_0.gguf') for f in HfApi().list_repo_files('offgrid-ai/$out-GGUF')) else 1)" 2>/dev/null; then
    log "already published: $out — skipping"; continue
  fi
  if "$ROOT/scripts/build-sd-gguf.sh" "$repo" "$file" "$out" "$name" "$lic" "$url" "$prompt" >>"$LOG" 2>&1; then
    log "converted+verified: $out — publishing offgrid-ai/$out-GGUF"
    if python3 "$ROOT/scripts/publish-sd-gguf.py" "$ROOT/build-sd-gguf/$out" "$out-GGUF" >>"$LOG" 2>&1; then
      log "PUBLISHED: https://huggingface.co/offgrid-ai/$out-GGUF"
    else
      log "PUBLISH FAILED: $out (see log)"
    fi
  else
    log "BUILD FAILED: $out (see log) — skipping"
  fi
  # Free disk: drop this model's working set (gguf is on HF / catalog points there)
  rm -rf "$ROOT/build-sd-gguf/$out"
  log "cleaned build dir for $out"
done
log "=== BATCH DONE ==="
