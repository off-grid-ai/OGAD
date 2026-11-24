#!/usr/bin/env python3
"""Stage pinned Windows ONNX CUDA files for the optional performance pack."""

from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile
import hashlib
import json
import shutil
import sys
import tarfile

BINDING_SHA256 = "c658fdb8db34f3dda9c9a19db996858ac127db94999c10be777b93694c275515"
# ONNX Runtime 1.30.0's CUDA 12 build came only from microsoft/onnxruntime's GitHub release
# (onnxruntime-win-x64-gpu_cuda12-1.30.0.zip, sha256 d4667ea4...), which is gone; NuGet and PyPI carry
# CUDA 13 builds only. Every Windows pack since holds those files, so they come from the pack
# resources/performance-packs.json names, checked against its pinned sha256 as it streams.
ORT_PACK_FOLDER = "bin/onnx-cuda/"
# NVIDIA wheel versions and hashes live in resources/engine-pins.json (nvidia.win).
PINS = json.loads((Path(__file__).resolve().parent.parent / "resources" / "engine-pins.json").read_text())
WHEELS = {
    f"{name.replace('-', '_')}-{pin['version']}-py3-none-win_amd64.whl": pin["sha256"]
    for name, pin in PINS["nvidia"]["win"].items()
}
ORT_DLLS = (
    "onnxruntime.dll",
    "onnxruntime_providers_cuda.dll",
    "onnxruntime_providers_shared.dll",
)
REQUIRED_DLLS = (
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "cudart64_12.dll",
    "cudnn64_9.dll",
    "cufft64_11.dll",
    "nvrtc64_120_0.dll",
)


def verify(path: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise ValueError(f"SHA256 mismatch: {path}")


def extract_file(archive: ZipFile, member: str, destination: Path) -> None:
    with archive.open(member) as source, destination.open("wb") as target:
        shutil.copyfileobj(source, target)


class HashingReader:
    """A stream that hashes everything read through it."""

    def __init__(self, source) -> None:
        self.source = source
        self.digest = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        block = self.source.read(size)
        self.digest.update(block)
        return block


def ort_from_pack(packs_json: Path, output: Path) -> None:
    """Copy the ONNX Runtime files out of the pinned Windows pack, then check the whole pack's hash."""
    pack = json.loads(packs_json.read_text())["cuda"]["win32"]
    wanted = {f"{ORT_PACK_FOLDER}{name}": name for name in ORT_DLLS}
    wanted[f"{ORT_PACK_FOLDER}LICENSE-onnxruntime"] = "LICENSE-onnxruntime"
    staging = output / ".ort-from-pack"
    staging.mkdir(parents=True, exist_ok=True)
    # The store's CDN refuses Python's default User-Agent.
    with urlopen(Request(pack["url"], headers={"User-Agent": "offgrid-pack-builder"})) as response:
        reader = HashingReader(response)
        with tarfile.open(fileobj=reader, mode="r|gz") as archive:
            for member in archive:
                name = wanted.get(member.name)
                if name and member.isfile():
                    with archive.extractfile(member) as source, (staging / name).open("wb") as target:
                        shutil.copyfileobj(source, target)
        # Read to the end so the hash covers the whole archive.
        while reader.read(1024 * 1024):
            pass
    if reader.digest.hexdigest() != pack["sha256"]:
        shutil.rmtree(staging)
        raise ValueError(f"SHA256 mismatch: {pack['url']}")
    for name in wanted.values():
        source = staging / name
        if not source.is_file():
            raise FileNotFoundError(f"{name} is not in {pack['url']}")
        shutil.move(source, output / name)
    staging.rmdir()


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            "Usage: stage-win-onnx-cuda-pack.py <performance-packs.json> <wheel-dir> <binding.node> <output-dir>"
        )
    packs_json, wheel_dir, binding, output = map(Path, sys.argv[1:])
    verify(binding, BINDING_SHA256)
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(binding, output / "onnxruntime_binding.node")
    ort_from_pack(packs_json, output)

    for name, sha256 in WHEELS.items():
        wheel = wheel_dir / name
        verify(wheel, sha256)
        with ZipFile(wheel) as archive:
            for member in archive.namelist():
                if member.lower().endswith(".dll"):
                    extract_file(archive, member, output / Path(member).name)
                elif member.endswith("/License.txt"):
                    extract_file(archive, member, output / f"LICENSE-{name.removesuffix('.whl')}.txt")

    for name in ORT_DLLS + REQUIRED_DLLS:
        if not (output / name).is_file():
            raise FileNotFoundError(output / name)
    print(f"Windows ONNX CUDA files staged in {output}")


if __name__ == "__main__":
    main()
