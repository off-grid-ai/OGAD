#!/usr/bin/env python3
"""Replace a source pack's Whisper engine with the pinned CUDA 12.4 build."""

import hashlib
import pathlib
import shutil
import sys
import zipfile

EXPECTED_SHA256 = "af520ddd034d985b55dfeea3e465ed93653ba2aee1a55e865033edc548c272a7"
REQUIRED = {
    "whisper-cli.exe",
    "ggml-cuda.dll",
    "cudart64_12.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "nvrtc64_120_0.dll",
}


def main() -> None:
    archive = pathlib.Path(sys.argv[1])
    destination = pathlib.Path(sys.argv[2])
    sha256 = hashlib.sha256()
    with archive.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha256.update(block)
    digest = sha256.hexdigest()
    if digest != EXPECTED_SHA256:
        raise ValueError(f"Whisper CUDA archive SHA256 mismatch: {digest}")

    destination.mkdir(parents=True, exist_ok=True)
    for old_file in destination.iterdir():
        if old_file.is_file() and old_file.suffix.lower() in {".dll", ".exe"}:
            old_file.unlink()

    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            name = pathlib.PurePosixPath(member.filename).name
            if member.is_dir() or pathlib.Path(name).suffix.lower() not in {".dll", ".exe"}:
                continue
            with source.open(member) as input_file, (destination / name).open("wb") as output_file:
                shutil.copyfileobj(input_file, output_file)

    if not (destination / "whisper-cli.exe").exists() and (destination / "main.exe").exists():
        shutil.copyfile(destination / "main.exe", destination / "whisper-cli.exe")

    missing = REQUIRED - {file.name for file in destination.iterdir()}
    if missing:
        raise RuntimeError(f"Whisper CUDA archive is missing: {sorted(missing)}")
    print(f"Pinned Whisper CUDA 12.4 staged in {destination}")


if __name__ == "__main__":
    main()
