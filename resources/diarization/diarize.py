#!/usr/bin/env python3
"""
Speaker diarization + embedding offload for the Off Grid gateway (Mac) — via sherpa-onnx.

No HuggingFace account or token: uses the same ungated ONNX models as the on-device path
(pyannote-segmentation-3.0 + a speaker embedding), downloaded once from sherpa-onnx's GitHub releases.

Two modes, both reading a WAV and printing JSON on stdout:
  diarize <wav> -> {"turns":[{"startMs","endMs","cluster","embedding":[...]}]}
  embed   <wav> -> {"embedding":[...]}

Models are looked up in OGRID_DIARIZE_MODELS (default ~/.offgrid-diarize/models):
  <dir>/sherpa-onnx-pyannote-segmentation-3-0/model.onnx   (segmentation)
  <dir>/campplus.onnx                                       (embedding)
"""
import json
import os
import sys

import numpy as np
import sherpa_onnx  # deps: sherpa-onnx soundfile numpy scipy (no torch, no HF)


def _models_dir():
    return os.environ.get(
        "OGRID_DIARIZE_MODELS", os.path.join(os.path.expanduser("~"), ".offgrid-diarize", "models")
    )


def _seg_path():
    return os.path.join(_models_dir(), "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")


def _emb_path():
    return os.path.join(_models_dir(), "campplus.onnx")


def _read_wav_16k(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)  # [N]
    if sr != 16000:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(sr, 16000)
        mono = resample_poly(mono, 16000 // g, sr // g).astype(np.float32)
    return np.ascontiguousarray(mono, dtype=np.float32)


_extractor = None


def _get_extractor():
    global _extractor
    if _extractor is None:
        _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=_emb_path())
        )
    return _extractor


def _embed(samples):
    ext = _get_extractor()
    stream = ext.create_stream()
    stream.accept_waveform(16000, samples)
    stream.input_finished()
    emb = np.asarray(ext.compute(stream), dtype=np.float32)
    n = np.linalg.norm(emb)
    if n > 0:
        emb = emb / n
    return emb.tolist()


def do_diarize(path):
    samples = _read_wav_16k(path)
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=_seg_path())
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=_emb_path()),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    result = sd.process(samples).sort_by_start_time()
    turns = []
    for seg in result:
        s0, s1 = int(seg.start * 16000), int(seg.end * 16000)
        chunk = samples[s0:s1]
        emb = _embed(chunk) if chunk.shape[0] >= 4000 else None  # skip <0.25s blips
        turns.append(
            {"startMs": int(seg.start * 1000), "endMs": int(seg.end * 1000),
             "cluster": f"spk{seg.speaker}", "embedding": emb}
        )
    return {"turns": turns}


def do_embed(path):
    return {"embedding": _embed(_read_wav_16k(path))}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: diarize.py <diarize|embed> <wav>"}))
        sys.exit(2)
    mode, path = sys.argv[1], sys.argv[2]
    try:
        print(json.dumps(do_diarize(path) if mode == "diarize" else do_embed(path)))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
