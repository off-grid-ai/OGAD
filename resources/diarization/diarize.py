#!/usr/bin/env python3
"""
Speaker diarization + embedding offload for the Off Grid gateway (Mac).

Two modes, both reading 16 kHz mono WAV and printing JSON on stdout:

  diarize <wav>   -> {"turns":[{"startMs","endMs","cluster","embedding":[...]}]}
     pyannote Community-1 finds the speaker turns ("who spoke when"); for each turn we compute a
     SpeechBrain ECAPA voiceprint so the app can put a name on each cluster.

  embed <wav>     -> {"embedding":[...]}
     One ECAPA voiceprint for a whole clip — used for enrollment, so enrolled profiles live in the
     SAME vector space as the diarized turns (this is the alignment the app needs).

Runtime is the user's own Mac (an accelerator, not something every user runs). Metal via MPS:
set PYTORCH_ENABLE_MPS_FALLBACK=1 so any op pyannote doesn't support on MPS quietly runs on CPU.
pyannote Community-1 is gated — export HF_TOKEN with a HuggingFace token that has accepted its terms.
"""
import json
import os
import sys

import torch
import torchaudio
from pyannote.audio import Pipeline
from speechbrain.inference.speaker import EncoderClassifier

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
_HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

_ecapa = None
_pipeline = None


def _load_ecapa():
    global _ecapa
    if _ecapa is None:
        _ecapa = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            run_opts={"device": DEVICE},
        )
    return _ecapa


def _load_pipeline():
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-community-1", token=_HF_TOKEN
        )
        try:
            _pipeline.to(torch.device(DEVICE))
        except Exception:
            pass  # CPU is fine if MPS placement fails
    return _pipeline


def _wav(path):
    wav, sr = torchaudio.load(path)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    if sr != 16000:
        wav = torchaudio.functional.resample(wav, sr, 16000)
        sr = 16000
    return wav, sr


def _embed(wav):
    # wav: [1, N] float. encode_batch -> [1, 1, 192]; L2-normalize for cosine.
    emb = _load_ecapa().encode_batch(wav).squeeze().detach().cpu()
    emb = torch.nn.functional.normalize(emb, dim=0)
    return emb.tolist()


def do_diarize(path):
    wav, sr = _wav(path)
    diar = _load_pipeline()(path)
    turns = []
    for turn, _, speaker in diar.itertracks(yield_label=True):
        s, e = int(turn.start * 1000), int(turn.end * 1000)
        seg = wav[:, int(turn.start * sr):int(turn.end * sr)]
        emb = _embed(seg) if seg.shape[1] >= sr // 4 else None  # skip <0.25s blips
        turns.append({"startMs": s, "endMs": e, "cluster": str(speaker), "embedding": emb})
    return {"turns": turns}


def do_embed(path):
    wav, _ = _wav(path)
    return {"embedding": _embed(wav)}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: diarize.py <diarize|embed> <wav>"}))
        sys.exit(2)
    mode, path = sys.argv[1], sys.argv[2]
    try:
        out = do_diarize(path) if mode == "diarize" else do_embed(path)
        print(json.dumps(out))
    except Exception as exc:  # surface a clean error to the gateway
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
