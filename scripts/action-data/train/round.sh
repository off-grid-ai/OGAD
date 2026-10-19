#!/usr/bin/env bash
# One training round, one model at a time (each gets the whole GPU), each tested as soon as it ends.
#   round.sh <round> <actor_max> <evaluator_max> <run_dir> [<run_dir> ...]
# Output: /root/rounds/<round>/{data,runs,eval}. Tests: frozen generated set, plus the real-site
# actor set when it exists. Base-model results are computed once and reused.
set -uo pipefail
round="$1"; actor_max="$2"; eval_max="$3"; shift 3
# PLANNER_RUNS (space-separated) limits planner rows to runs with current plan labels.
T=/workspace/action-data-gen/scripts/train
PY=/workspace/ogad-action-model-research/venv/bin/python
TEST=${TEST:-/workspace/action-train/test/frozen2}
R=/root/rounds/$round
BASE=/root/base-eval
mkdir -p "$R"/{runs,eval} "$BASE"
log() { echo "[$(date -u +%FT%TZ)] $*"; }

log "build data from: $*"
$PY "$T/build_dataset.py" --runs "$@" --out "$R/data" --actor-max "$actor_max" --evaluator-max "$eval_max" ${PLANNER_RUNS:+--planner-runs $PLANNER_RUNS} ${BUILD_ARGS:-} > "$R/data.log" || { log "data build failed"; exit 1; }

# Requests are re-rendered with the current contract (snapshot compaction and focused cut).
NODE_T=/workspace/action-data-gen/scripts/train
node "$NODE_T/rerender.mjs" "$R/data/actor.jsonl" "$R/data/evaluator.jsonl" "$R/data/planner.jsonl" >> "$R/data.log"
# Test sets are re-rendered once per contract version (the marker holds the contract's hash).
CONTRACT_HASH=$(sha256sum /workspace/action-data-gen/scripts/contract.mjs | cut -c1-16)
# One writer at a time: rounds on two pods share these files on /workspace.
exec 9>/workspace/action-train/realsite/.rerender.lock; flock 9
for set in "$TEST" /workspace/action-train/realsite/*/; do
  set=${set%/}
  [[ "$(cat "$set/.rendered-with" 2>/dev/null)" == "$CONTRACT_HASH" ]] && continue
  files=(); for f in actor evaluator planner; do [[ -s "$set/$f.jsonl" ]] && files+=("$set/$f.jsonl"); done
  node "$NODE_T/rerender.mjs" "${files[@]}" >> "$R/data.log" && echo "$CONTRACT_HASH" > "$set/.rendered-with"
done
flock -u 9

test_role() {  # test_role <role> <test_name> <test.jsonl> <meta.jsonl> <adapter>
  local role=$1 name=$2 data=$3 meta=$4 ckpt=$5
  [[ -f "$data" ]] || return 0
  if [[ ! -f "$BASE/$role-$name-score.json" ]]; then
    bash "$T/eval_role.sh" "$role" "$data" "$BASE/$role-$name.jsonl" > "$BASE/$role-$name.log" 2>&1
    $PY "$T/score.py" --role "$role" --meta "$meta" --pred "$BASE/$role-$name.jsonl" --out "$BASE/$role-$name-score.json" > /dev/null
  fi
  bash "$T/eval_role.sh" "$role" "$data" "$R/eval/$role-$name.jsonl" "$ckpt" > "$R/eval/$role-$name.log" 2>&1
  $PY "$T/score.py" --role "$role" --meta "$meta" --pred "$R/eval/$role-$name.jsonl" --out "$R/eval/$role-$name-score.json" > /dev/null
  log "$role $name: base $($PY -c "import json;print(json.load(open('$BASE/$role-$name-score.json'))['rate'])") trained $($PY -c "import json;print(json.load(open('$R/eval/$role-$name-score.json'))['rate'])")"
}

# ROLES (space-separated) trains only some models, e.g. ROLES=actor.
for role in ${ROLES:-actor evaluator planner}; do
  log "train $role"
  BS=4 GA=2 GROUP_BY_LENGTH=true GRAD_CKPT=${GRAD_CKPT:-false} DATA_PROCS=8 LOADERS=4 bash "$T/train_role.sh" "$role" "$R/data/$role.jsonl" "$R/runs/$role" > "$R/runs/$role.log" 2>&1 || { log "$role training failed"; continue; }
  ckpt=$(ls -d "$R"/runs/$role/v*/checkpoint-* | sort -V | tail -1)
  echo "$ckpt" > "$R/eval/$role-checkpoint.txt"
  log "test $role ($ckpt)"
  test_role "$role" "$(basename "$TEST")" "$TEST/$role.jsonl" "$TEST/$role.meta.jsonl" "$ckpt"
  if [[ "$role" == actor ]]; then
    for real in /workspace/action-train/realsite/*/; do
      name=$(basename "$real")
      [[ -s "$real/actor.jsonl" && -f "$real/capture-summary.json" ]] && test_role actor "real-$name" "$real/actor.jsonl" "$real/actor.meta.jsonl" "$ckpt"
    done
  fi
done
log "round $round complete"
