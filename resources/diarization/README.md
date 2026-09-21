# Diarization offload (Mac) — sherpa-onnx, no HuggingFace

The phone offloads Day recordings here for **speaker diarization + voiceprints**, over the same mesh as
STT offload. It runs `diarize.py` using **sherpa-onnx** with the *same ungated ONNX models as the
on-device path* — no HuggingFace account, no token, no gated licences.

## One-time setup on the Mac

```bash
python3 -m venv ~/.offgrid-diarize
~/.offgrid-diarize/bin/pip install sherpa-onnx soundfile numpy scipy   # light: no torch, no pyannote

# download the ungated models (pyannote-segmentation-3.0 + CAM++ embedding)
mkdir -p ~/.offgrid-diarize/models && cd ~/.offgrid-diarize/models
curl -L -O https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
tar xjf sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
curl -L -o campplus.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
```

That's it. The gateway auto-detects `~/.offgrid-diarize/bin/python3` and looks for the models in
`~/.offgrid-diarize/models` (override with `OGRID_DIARIZE_PYTHON` / `OGRID_DIARIZE_MODELS`).

## Routes (exposed once the desktop app runs)
- `POST /v1/audio/diarize` (multipart `file`) → `{ turns: [{ startMs, endMs, cluster, embedding }] }`
- `POST /v1/audio/embed`   (JSON `{ audio: base64, format: "wav" }`) → `{ embedding: [...] }`

Same models power the on-device path, so a voice enrolled via the Mac and one enrolled on-device live
in the same vector space. A 10-minute note diarizes in well under a minute.
