#!/usr/bin/env bash
# The LFM3 r16 web agent on the CPU only (cores 0-7, nice), on OGAD's default role ports, for
# sandbox bench runs that leave the GPU to training.  ./serve-cpu.sh start|stop
# Models: ~/agent-sandbox/models (copies of the r16 base GGUFs, LoRAs and llama-server b12415).
set -euo pipefail
M="$HOME/agent-sandbox/models"
S="$M/llama-b12415/llama-server"
L="$HOME/agent-sandbox/ogad/logs"
export LD_LIBRARY_PATH="$M/llama-b12415"
C=(-ngl 0 -t 8 -np 1 -c 32768 --jinja --reasoning-format none --host 127.0.0.1)
VL=(-m "$M/LFM3-VL-2B-Q4_K_M.gguf" --mmproj "$M/mmproj-LFM3-VL-2B-Q8_0.gguf" --no-mmproj-offload --image-max-tokens 640)
mkdir -p "$L"
run() {
  local port=$1
  shift
  CUDA_VISIBLE_DEVICES='' setsid nohup nice -n 10 taskset -c 0-7 "$S" "$@" --port "$port" > "$L/srv-$port.log" 2>&1 < /dev/null &
}
case "${1:-start}" in
  start)
    run 8471 -m "$M/LFM3-1.7B-Q4_K_M.gguf" --lora "$M/r16-planner-lora.gguf" --alias planner "${C[@]}"
    run 8472 "${VL[@]}" --lora "$M/r16-actor-lora.gguf" --alias actor "${C[@]}"
    run 8473 "${VL[@]}" --lora "$M/r16-evaluator-lora.gguf" --alias evaluator "${C[@]}"
    ;;
  stop) pkill -f "$S" || true ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
