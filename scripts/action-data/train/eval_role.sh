#!/usr/bin/env bash
# Run one model (base, or base + adapter) over a frozen test file.
#   eval_role.sh <actor|evaluator|planner> <test.jsonl> <result.jsonl> [adapter_dir]
set -euo pipefail
role="$1"; data="$2"; out="$3"; adapter="${4:-}"
R=/workspace/ogad-action-model-research
test -f "$data"
test ! -e "$out"
export CUDA_VISIBLE_DEVICES=${GPU:-0} OMP_NUM_THREADS=2 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONUNBUFFERED=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True DOWNSAMPLE_MODE=4x MAX_SLICE_NUMS=4
extra=()
if [[ -n "$adapter" ]]; then extra=(--adapters "$adapter"); fi
common=(--infer_backend pt --val_dataset "$data" --max_batch_size 8 --max_length 16384
  --temperature 0 --stream false --result_path "$out")
if [[ "$role" == planner ]]; then
  exec "$R/venv/bin/swift" infer --model "$R/planner/model" --model_type llama --template chatml \
    --torch_dtype bfloat16 --attn_impl sdpa --max_new_tokens 400 "${common[@]}" "${extra[@]}"
fi
exec "$R/venv/bin/swift" infer --model "$R/models/MiniCPM-V-4.7-1B" --model_type minicpmv4_7 --template minicpmv4_7 \
  --add_non_thinking_prefix true --torch_dtype bfloat16 --attn_impl sdpa --max_new_tokens 48 "${common[@]}" "${extra[@]}"
