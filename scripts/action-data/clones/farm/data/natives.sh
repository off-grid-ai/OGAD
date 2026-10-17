#!/usr/bin/env bash
# /dev/shm is noexec: move every native file (ELF executables, .node addons, .so) of an app tree in /dev/shm to
# /workspace/clone-farm/native/<app>/ (exec allowed) and leave a symlink in its place.  natives.sh <app> <tree>
set -e
APP=$1; TREE=$(readlink -f "$2"); N=/workspace/clone-farm/native/$APP
mkdir -p $N
find "$TREE" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -perm -u+x \) -size +8k 2>/dev/null | while read -r f; do
  [[ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" == '177ELF' ]] || continue
  rel=${f#$TREE/}; mkdir -p "$N/$(dirname "$rel")"
  { cmp -s "$f" "$N/$rel" || cp "$f" "$N/$rel"; } && chmod +x "$N/$rel" && ln -sf "$N/$rel" "$f" && echo "native: $rel"
done
