#!/usr/bin/env bash
# Start the source app with the CUDA 13 libraries used by ONNX Runtime.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
workspace="$(dirname "$root")"
python="$workspace/build-python/bin/python"
[[ -x $python ]] || { echo 'Run Setup-OGAD-Source.sh first.' >&2; exit 1; }

site="$("$python" -c 'import site; print(site.getsitepackages()[0])')"
# The pinned CUDA 13 runtime, cuBLAS, and cuRAND wheels use cu13/lib;
# the pinned cuDNN wheel uses cudnn/lib.
cuda_lib="$site/nvidia/cu13/lib"
cudnn_lib="$site/nvidia/cudnn/lib"
for library in "$cuda_lib/libcublas.so.13" "$cuda_lib/libcublasLt.so.13" "$cuda_lib/libcudart.so.13" \
  "$cuda_lib/libcurand.so.10" "$cudnn_lib/libcudnn.so.9"; do
  [[ -f $library ]] || { echo "Missing ONNX CUDA library: $library" >&2; exit 1; }
done

export LD_LIBRARY_PATH="$cuda_lib:$cudnn_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export OFFGRID_FORCE_CORE=0
cd "$root"
exec npm run dev
