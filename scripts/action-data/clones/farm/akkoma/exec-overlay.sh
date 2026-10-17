#!/usr/bin/env bash
# /dev/shm is mounted noexec, but the Akkoma release lives there (lead's disk rule). Keep the few files that
# must be executed or dlopen'ed on /workspace (X) and symlink them back:
#   X/erts-*, X/releases  (ERTS resolves its root from its own path, so X/lib and X/bin link to the shm dirs)
#   X/nif/<path>          NIF .so dirs and port binaries under lib/
set -euo pipefail
R=${1:-/opt/clone-farm/akkoma/release}
X=/workspace/clone-farm/xbin/akkoma
mkdir -p "$X/nif"
cd "$R"
move() { # move $1 (relative to the release) to $2 and symlink it back
  local p=$1 to=$2
  [[ -L $p ]] && return 0
  mkdir -p "$(dirname "$to")"; [[ -e $to ]] && rm -r -- "$to"; cp -r "$p" "$to"; chmod -R a+x "$to" 2>/dev/null || true
  rm -r -- "$p"; ln -s "$to" "$p"
}
for d in erts-* releases; do move "$d" "$X/$d"; done
[[ -L $X/lib ]] || ln -s "$R/lib" "$X/lib"
[[ -L $X/bin ]] || ln -s "$R/bin" "$X/bin"
for d in $(find lib/ -name '*.so' | sed 's|/[^/]*$||' | sort -u); do move "$d" "$X/nif/$d"; done
for f in lib/fast_html-*/priv/fasthtml_worker lib/majic-*/priv/libmagic_port lib/eblurhash-*/priv/blurhash lib/os_mon-*/priv/bin lib/captcha-*/priv/captcha; do
  if [[ -e $f ]]; then move "$f" "$X/nif/$f"; fi
done
# Scripts that run sibling scripts directly: run them through bash instead.
sed -i 's|^\(\s*\)"\$SCRIPTPATH"/pleroma |\1bash "$SCRIPTPATH"/pleroma |' bin/pleroma_ctl
echo "exec overlay ready in $X"
