#!/usr/bin/env bash
# Train one model on its new-contract data with LoRA (same settings as the Codex runs, one epoch).
#   [BS=4 GA=2 GROUP_BY_LENGTH=true] train_role.sh <actor|evaluator|planner> <data.jsonl> <output_dir>
# GROUP_BY_LENGTH batches rows of similar length, so less compute goes to padding.
set -euo pipefail
role="$1"; data="$2"; out="$3"
R=/workspace/ogad-action-model-research
test -f "$data"
test ! -e "$out"
export CUDA_VISIBLE_DEVICES=${GPU:-0} OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONUNBUFFERED=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True TOKENIZERS_PARALLELISM=false
# Fewer image slices than the Codex runs (9): the AX snapshot carries the text, and fewer image
# tokens means faster prefill on the Mac. Inference must use the same value.
export DOWNSAMPLE_MODE=4x MAX_SLICE_NUMS=4
common=(--tuner_type lora --lora_rank 16 --lora_alpha 32 --lora_dropout 0.05
  --torch_dtype bfloat16 --attn_impl sdpa --dataset "$data" --split_dataset_ratio 0
  --max_length 16384 --truncation_strategy delete --packing false --padding_free false
  --per_device_train_batch_size "${BS:-2}" --gradient_accumulation_steps "${GA:-4}" --gradient_checkpointing "${GRAD_CKPT:-true}"
  --group_by_length "${GROUP_BY_LENGTH:-false}"
  --learning_rate 0.0001 --lr_scheduler_type cosine --warmup_ratio 0.02 --weight_decay 0.1
  --num_train_epochs 1 ${MAX_STEPS:+--max_steps $MAX_STEPS} --save_steps 250 --save_total_limit 3 --logging_steps 5 --eval_strategy no
  --dataset_num_proc "${DATA_PROCS:-4}" --dataloader_num_workers "${LOADERS:-2}" --report_to none --seed 42 --data_seed 42
  --output_dir "$out")
if [[ "$role" == planner ]]; then
  exec "$R/venv/bin/swift" sft --model "$R/planner/model" --model_type llama --template chatml \
    --target_modules q_proj k_proj v_proj o_proj gate_proj up_proj down_proj "${common[@]}"
fi
exec "$R/venv/bin/swift" sft --model "$R/models/MiniCPM-V-4.7-1B" --model_type minicpmv4_7 --template minicpmv4_7 \
  --add_non_thinking_prefix true --target_modules all-linear --freeze_llm false --freeze_vit true --freeze_aligner true \
  --loss_scale ignore_empty_think "${common[@]}"
