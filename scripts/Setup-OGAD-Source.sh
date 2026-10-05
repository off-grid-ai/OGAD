#!/usr/bin/env bash
# Guided source setup for Ubuntu 24.04 x86_64 on AWS.
# Run as ubuntu: bash "$HOME/Downloads/Setup-OGAD-Source.sh"
# Run this file again after a restart or failure.
set -Eeuo pipefail

branch=${OGAD_BRANCH:-feature/linux-core-chat-release}
workspace=${OGAD_WORKSPACE:-$HOME/offgrid-dev}
speech_ref=e3b471e6ea8504f3877cd9f27a11bfe98ce3b3b5
stage=Start
trap 'printf "\nSetup stopped at: %s (line %s). Fix the error, then run this file again.\n" "$stage" "$LINENO" >&2' ERR
step() { stage=$1; printf '\n=== %s ===\n' "$stage"; }

[[ $(uname -s) == Linux && $(uname -m) == x86_64 && $EUID != 0 ]] || {
  echo 'Run as a regular user on Linux x86_64.' >&2; exit 1;
}
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || {
  echo 'Ubuntu 24.04 is required.' >&2; exit 1;
}

step '1 of 6: Check host tools and NVIDIA GPU'
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential cmake ninja-build pkg-config git git-lfs gh curl ca-certificates \
  unzip xz-utils python3 python3-venv python3-dev file docker.io \
  libgomp1 libvulkan1 libvulkan-dev glslc spirv-headers \
  libx11-dev libxext-dev libxfixes-dev libxi-dev libxtst-dev libxrandr-dev \
  libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libsecret-1-0 \
  pipewire-audio pipewire-module-xrdp ubuntu-drivers-common \
  python3-gi geoclue-2.0 gir1.2-atspi-2.0 gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
  gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-pulseaudio
sudo systemctl start docker
if ! command -v nvidia-smi >/dev/null || ! nvidia-smi >/dev/null 2>&1; then
  echo 'Installing the Ubuntu NVIDIA compute driver. A reboot is needed after this step.'
  sudo ubuntu-drivers install --gpgpu
  driver_major=$(dpkg-query -W -f='${Package}\n' |
    sed -nE 's/^nvidia-headless-no-dkms-([0-9]+)-server-open$/\1/p' | head -n 1)
  [[ -n $driver_major ]] || { echo 'NVIDIA driver install did not complete.' >&2; exit 1; }
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "nvidia-utils-${driver_major}-server"
  echo 'Reboot the VM, reconnect, and run this same file again.'
  exit 0
fi
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
driver_major=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader |
  head -n 1 | cut -d. -f1)
[[ $driver_major =~ ^[0-9]+$ && $driver_major -ge 580 ]] || {
  echo 'NVIDIA driver 580 or newer is required for ONNX CUDA 13.' >&2; exit 1;
}
if [[ -z ${OFFGRID_CUDA_ARCHITECTURES:-} ]]; then
  gpu_arches=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader |
    sed 's/\.//g' | sort -u | paste -sd ';' -)
  [[ $gpu_arches =~ ^[0-9]+(\;[0-9]+)*$ ]] || {
    echo 'Could not read the NVIDIA GPU compute capability.' >&2; exit 1;
  }
  export OFFGRID_CUDA_ARCHITECTURES=$gpu_arches
fi
echo "NVIDIA GPU architecture: $OFFGRID_CUDA_ARCHITECTURES"

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') != 22 ]]; then
  echo 'Installing Node 22 from nodejs.org.'
  temp=$(mktemp -d)
  trap 'rm -rf -- "$temp"' EXIT
  curl -fsSL --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$temp/SHASUMS256.txt"
  archive=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2 }' "$temp/SHASUMS256.txt")
  [[ -n $archive && $archive != *$'\n'* ]]
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$temp/$archive"
  (cd "$temp"; awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum -c -)
  sudo tar -xJf "$temp/$archive" -C /usr/local --strip-components=1
  rm -rf -- "$temp"
  trap - EXIT
fi
node --version
npm --version

step '2 of 6: Sign in to GitHub'
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo 'GitHub will show a code and a URL. Open that URL and enter the code.'
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git --hostname github.com
gh api user --jq .login
for repo in OGAD shared desktop-pro executorch-speech; do
  gh repo view "off-grid-ai/$repo" --json nameWithOwner --jq .nameWithOwner
done

step '3 of 6: Get source'
mkdir -p "$workspace"
sync_repo() {
  local repo=$1 dest=$2 ref=$3 remote
  if [[ ! -e $dest ]]; then
    GIT_LFS_SKIP_SMUDGE=1 gh repo clone "$repo" "$dest" -- --branch "$ref"
  else
    [[ -d $dest/.git ]] || { echo "Not a Git checkout: $dest" >&2; return 1; }
    remote=$(git -C "$dest" remote get-url origin)
    [[ $remote == *"$repo" || $remote == *"$repo.git" ]] || {
      echo "Unexpected repository at $dest. Use another OGAD_WORKSPACE." >&2; return 1;
    }
    if [[ -n $(git -C "$dest" status --porcelain) ]]; then
      echo "Local changes in $dest. Keeping this checkout and skipping its source update."
      return 0
    fi
    git -C "$dest" fetch origin "$ref"
    git -C "$dest" switch "$ref"
    git -C "$dest" pull --ff-only origin "$ref"
  fi
}
sync_repo off-grid-ai/OGAD "$workspace/desktop" "$branch"
sync_repo off-grid-ai/shared "$workspace/shared" "$branch"
GIT_LFS_SKIP_SMUDGE=1 git -C "$workspace/desktop" submodule update --init pro
if [[ ! -e $workspace/executorch-speech ]]; then
  GIT_LFS_SKIP_SMUDGE=1 gh repo clone off-grid-ai/executorch-speech "$workspace/executorch-speech"
fi
[[ -d $workspace/executorch-speech/.git ]] || { echo 'Speech source is not a Git checkout.' >&2; exit 1; }
speech_remote=$(git -C "$workspace/executorch-speech" remote get-url origin)
[[ $speech_remote == *off-grid-ai/executorch-speech || $speech_remote == *off-grid-ai/executorch-speech.git ]] || {
  echo 'Unexpected speech repository. Use another OGAD_WORKSPACE.' >&2; exit 1;
}
if [[ -n $(git -C "$workspace/executorch-speech" status --porcelain) ]]; then
  echo 'Local changes in speech source. Keeping this checkout and skipping its source update.'
else
  git -C "$workspace/executorch-speech" fetch origin "$speech_ref"
  git -C "$workspace/executorch-speech" checkout --detach "$speech_ref"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$workspace/executorch-speech" submodule update --init --recursive
fi

step '4 of 6: Install source dependencies'
cd "$workspace/desktop"
git lfs install --local --skip-repo
git lfs pull --include='resources/bin/kev-local-server.py' --exclude=''
npm --prefix "$workspace/shared" ci
for package in models sync use automation speech ui rag design; do
  npm --prefix "$workspace/shared/packages/$package" run build
done
npm ci
# npm ci extracts Electron's sandbox helper without the ownership and mode
# required for a sandboxed Linux GUI launch. Reapply them on every setup run.
sandbox="$workspace/desktop/node_modules/electron/dist/chrome-sandbox"
[[ -f $sandbox ]] || { echo 'Electron sandbox helper is missing.' >&2; exit 1; }
sudo chown root:root "$sandbox"
sudo chmod 4755 "$sandbox"
python3 -m venv "$workspace/build-python"
"$workspace/build-python/bin/pip" install --no-cache-dir 'torch==2.11.0+cpu' PyYAML Jinja2 \
  --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple
"$workspace/build-python/bin/python" -c 'import torchgen, yaml, jinja2'
"$workspace/build-python/bin/pip" install --no-cache-dir --no-deps \
  'nvidia-cuda-runtime==13.2.86' 'nvidia-cublas==13.2.2.2' \
  'nvidia-curand==10.4.2.66' 'nvidia-cudnn-cu13==9.23.1.3'

step '5 of 6: Build Linux app'
export PATH="$workspace/build-python/bin:$PATH"
export OFFGRID_FORCE_CORE=0
npm run typecheck:node
npm run build:linux
for executable in build/linux-bin/llama-cuda/llama-server \
  build/linux-bin/llama-prism-cuda/llama-server \
  build/linux-bin/whisper-cuda/whisper-cli \
  build/linux-bin/sd-cuda/sd-cli \
  build/linux-bin/whisper/whisper-cli; do
  test -x "$executable"
done
for executable in dist/linux-unpacked/resources/bin/llama-cuda/llama-server \
  dist/linux-unpacked/resources/bin/whisper-cuda/whisper-cli \
  dist/linux-unpacked/resources/bin/sd-cuda/sd-cli; do
  test -x "$executable"
done
for library in libcudart.so.12 libcublas.so.12 libcublasLt.so.12; do
  test -f "dist/linux-unpacked/resources/bin/cuda-runtime/$library"
done
test -n "$(find dist -maxdepth 1 -name '*.AppImage' -print -quit)"
test -n "$(find dist -maxdepth 1 -name '*.deb' -print -quit)"
echo "Build complete: $workspace/desktop/dist"

step '6 of 6: Start from source'
if [[ -n ${DISPLAY:-} && ${1:-} != --setup-only ]]; then
  read -r -p 'Press Enter to start OGAD. Keep this terminal open. ' _
  npm run dev
else
  echo "To start from the Linux desktop terminal: cd '$workspace/desktop' && npm run dev"
fi
