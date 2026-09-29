#!/usr/bin/env python3
"""Check a downloaded release package against its published checksum list."""

import hashlib
from pathlib import Path
import re
import sys


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: verify-release-package-sha256.py <checksums> <package>")
    checksum_file, package = map(Path, sys.argv[1:])
    expected = []
    for line in checksum_file.read_text().splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(.+)", line)
        if match and Path(match.group(2)).name == package.name:
            expected.append(match.group(1).lower())
    if len(expected) != 1:
        raise ValueError(f"Expected one checksum for {package.name}; found {len(expected)}")

    sha256 = hashlib.sha256()
    with package.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha256.update(block)
    actual = sha256.hexdigest()
    if actual != expected[0]:
        raise ValueError(f"Release package SHA256 mismatch: {package.name}")
    print(f"Verified {package.name}: {actual}")


if __name__ == "__main__":
    main()
