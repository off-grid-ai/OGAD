#!/usr/bin/env bash
# /dev/shm is noexec: native addons of lemmy-ui (sharp + libvips) must be dlopen'ed from /workspace.
set -euo pipefail
U=${1:-/opt/clone-farm/lemmy-ui}
X=/workspace/clone-farm/xbin/lemmy-ui
mkdir -p "$X"
cd "$U/node_modules/.pnpm"
for d in @img+sharp-*; do
  [[ -L $d ]] && continue
  [[ -e $X/$d ]] && rm -r -- "$X/$d"
  cp -r "$d" "$X/$d"; rm -r -- "$d"; ln -s "$X/$d" "$d"
done
echo "lemmy-ui exec overlay ready in $X"
