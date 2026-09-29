#!/usr/bin/env bash
# EC2 user data for a fresh Ubuntu 24.04 x86_64 NVIDIA development VM.
# Run as root. Source checkout and GitHub login are separate user steps.
set -Eeuo pipefail
trap 'echo "Linux host setup failed at line $LINENO" >&2' ERR
[[ $EUID == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] || {
  echo 'Ubuntu 24.04 x86_64 is required.' >&2; exit 1;
}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y build-essential cmake ninja-build pkg-config git git-lfs gh \
  curl ca-certificates unzip xz-utils python3 python3-venv python3-dev \
  libgomp1 libvulkan1 libvulkan-dev glslc spirv-headers \
  libx11-dev libxext-dev libxfixes-dev libxi-dev libxtst-dev libxrandr-dev \
  libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libsecret-1-0 \
  xfce4 xfce4-terminal xrdp xorgxrdp dbus-x11 \
  pipewire-audio pipewire-module-xrdp ubuntu-drivers-common

# Use the official Node 22 distribution and verify its published checksum.
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
curl -fsSL --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$work/SHASUMS256.txt"
archive=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2 }' "$work/SHASUMS256.txt")
[[ -n $archive && $archive != *$'\n'* ]]
curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v22.x/$archive" -o "$work/$archive"
(cd "$work"; awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum -c -)
tar -xJf "$work/$archive" -C /usr/local --strip-components=1
node --version
npm --version

# Keep RDP on loopback. Connect through SSH; do not expose port 3389.
sed -i 's#^port=3389$#port=tcp://127.0.0.1:3389#' /etc/xrdp/xrdp.ini
grep -q '^port=tcp://127.0.0.1:3389$' /etc/xrdp/xrdp.ini
adduser xrdp ssl-cert
if [[ ! -e /home/ubuntu/.xsession ]]; then
  printf 'exec startxfce4\n' > /home/ubuntu/.xsession
  chown ubuntu:ubuntu /home/ubuntu/.xsession
fi
systemctl enable xrdp
systemctl restart xrdp

# Install the Ubuntu-supported NVIDIA compute driver. Reboot before CUDA tests.
ubuntu-drivers install --gpgpu
driver_major=$(dpkg-query -W -f='${Package}\n' | sed -nE 's/^nvidia-headless-no-dkms-([0-9]+)-server-open$/\1/p' | head -n 1)
[[ -n $driver_major ]] || { echo 'NVIDIA server driver package was not installed.' >&2; exit 1; }
apt-get install -y "nvidia-utils-${driver_major}-server"
touch /var/lib/ogad-host-setup-complete
echo 'Host packages installed. Reboot, then check nvidia-smi. Set the desktop password yourself with passwd.'
