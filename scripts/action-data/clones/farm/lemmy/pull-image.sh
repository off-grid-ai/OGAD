#!/usr/bin/env bash
# Pull a Docker Hub image's filesystem without Docker: fetch the amd64 manifest and untar every layer.
#   pull-image.sh dessalines/lemmy 0.19.20 /workspace/clone-farm/src/lemmy-img
set -euo pipefail
repo=$1 tag=$2 dest=$3
tok=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
H=(-H "Authorization: Bearer $tok" -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json')
m=$(curl -sL "${H[@]}" "https://registry-1.docker.io/v2/$repo/manifests/$tag")
if echo "$m" | grep -q '"manifests"'; then
  d=$(echo "$m" | python3 -c 'import sys,json;print([x["digest"] for x in json.load(sys.stdin)["manifests"] if x.get("platform",{}).get("architecture")=="amd64"][0])')
  m=$(curl -sL "${H[@]}" "https://registry-1.docker.io/v2/$repo/manifests/$d")
fi
mkdir -p "$dest"
for l in $(echo "$m" | python3 -c 'import sys,json;[print(x["digest"]) for x in json.load(sys.stdin)["layers"]]'); do
  curl -sL "${H[@]}" "https://registry-1.docker.io/v2/$repo/blobs/$l" | tar -xz --no-same-owner -C "$dest" 2>/dev/null || true
done
echo "pulled $repo:$tag -> $dest"
