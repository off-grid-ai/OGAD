#!/usr/bin/env python3
"""Publish a converted SD-GGUF build dir to the offgrid-ai HF org.

Uploads <build_dir> (the *.gguf + README.md the build script produced) to
offgrid-ai/<repo_name>. Uses the cached HF token (run `login()` first). Only
uploads .gguf and README.md — never the giant source .safetensors.

Usage: publish-sd-gguf.py <build_dir> <repo_name>
"""
import sys, os
from huggingface_hub import HfApi

build_dir, repo_name = sys.argv[1], sys.argv[2]
repo_id = f"offgrid-ai/{repo_name}"
api = HfApi()
api.create_repo(repo_id, repo_type="model", exist_ok=True)
print(f"==> uploading {build_dir} -> {repo_id}")
api.upload_folder(
    folder_path=build_dir,
    repo_id=repo_id,
    repo_type="model",
    allow_patterns=["*.gguf", "README.md", "*.png"],  # never the source safetensors
    commit_message="Add Off Grid GGUF conversions (q8_0, q4_K)",
)
print(f"==> published: https://huggingface.co/{repo_id}")
