# Diarization offload (Mac)

The phone offloads Day recordings to this Mac for **speaker diarization + voiceprints** — the same
mesh path as STT offload. It runs `diarize.py` (pyannote Community-1 for "who spoke when" + SpeechBrain
ECAPA for the voiceprint per turn). This is the *accelerator* path; on-device (sherpa-onnx) is separate.

## One-time setup on the Mac

```bash
python3 -m venv ~/.offgrid-diarize && source ~/.offgrid-diarize/bin/activate
pip install "pyannote.audio>=3.1" speechbrain torch torchaudio
# pyannote Community-1 is gated — accept its terms on HuggingFace, then:
export HF_TOKEN=hf_xxx
```

Point the gateway at that interpreter (so it doesn't use the system python):

```bash
export OGRID_DIARIZE_PYTHON="$HOME/.offgrid-diarize/bin/python3"
```

Then launch Off Grid Desktop. The gateway exposes:
- `POST /v1/audio/diarize` (multipart `file`) → `{ turns: [{ startMs, endMs, cluster, embedding }] }`
- `POST /v1/audio/embed`   (JSON `{ audio: base64, format: "wav" }`) → `{ embedding: [...] }`

Metal is used via MPS with `PYTORCH_ENABLE_MPS_FALLBACK=1` (set automatically). A 10-min note
diarizes in well under a minute on an M-series chip.
