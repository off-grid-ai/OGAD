#!/usr/bin/env bash
# One training round: build data, train the three models at once, test base and trained models.
#   pipeline.sh <round> <actor_max> <evaluator_max> <run_dir> [<run_dir> ...]
# Results: /workspace/action-train/rounds/<round>/{data,runs,pred,scores}. Log: .../pipeline.log
set -euo pipefail
round="$1"; actor_max="$2"; eval_max="$3"; shift 3
T=/workspace/action-data-gen/scripts/train
W=/workspace/action-train
R="$W/rounds/$round"
TEST="$W/test/frozen1"
PY=/workspace/ogad-action-model-research/venv/bin/python
mkdir -p "$R"/{runs,pred,scores}
test -f "$TEST/actor.jsonl" || { echo "missing frozen test set $TEST"; exit 1; }
echo "[$(date -u +%FT%TZ)] build data"
$PY "$T/build_dataset.py" --runs "$@" --out "$R/data" --actor-max "$actor_max" --evaluator-max "$eval_max" > "$R/data.log"
for role in actor evaluator planner; do
  echo "[$(date -u +%FT%TZ)] start training $role"
  bash "$T/train_role.sh" "$role" "$R/data/$role.jsonl" "$R/runs/$role" > "$R/runs/$role.log" 2>&1 &
done
wait
echo "[$(date -u +%FT%TZ)] training done"
for role in actor evaluator planner; do
  ckpt=$(ls -d "$R"/runs/$role/v*/checkpoint-* | sort -V | tail -1)
  echo "[$(date -u +%FT%TZ)] test $role base and $ckpt"
  test -e "$W/base/$role.jsonl" || { mkdir -p "$W/base"; bash "$T/eval_role.sh" "$role" "$TEST/$role.jsonl" "$W/base/$role.jsonl" > "$W/base/$role.log" 2>&1; }
  bash "$T/eval_role.sh" "$role" "$TEST/$role.jsonl" "$R/pred/$role.jsonl" "$ckpt" > "$R/pred/$role.log" 2>&1
  $PY "$T/score.py" --role "$role" --meta "$TEST/$role.meta.jsonl" --pred "$W/base/$role.jsonl" --out "$R/scores/$role-base.json" > /dev/null
  $PY "$T/score.py" --role "$role" --meta "$TEST/$role.meta.jsonl" --pred "$R/pred/$role.jsonl" --out "$R/scores/$role-trained.json" > /dev/null
  echo "$ckpt" > "$R/scores/$role-checkpoint.txt"
done
echo "[$(date -u +%FT%TZ)] round $round complete"
