// Curated cross-platform model catalog + RAM-based recommendation. Spans the
// kinds Off Grid supports (text, vision, image, voice, transcription); more to
// come. Entries point at Hugging Face resolve URLs. This is editorial/default;
// the HF browser (hf.ts) lets users find anything else.

import type { ModelEntry, ModelKind, ModelRecommendationTier } from './types'
import { deriveKind } from './capabilities'

const HF = 'https://huggingface.co'
const resolve = (repo: string, file: string): string => `${HF}/${repo}/resolve/main/${file}`

// RAM tier -> max LLM size + quant (ported from mobile MODEL_RECOMMENDATIONS).
export const RECOMMENDATION_TIERS: ModelRecommendationTier[] = [
  { minRamGb: 3, maxRamGb: 4, maxParams: 1.5, quantization: 'Q4_K_M' },
  { minRamGb: 4, maxRamGb: 6, maxParams: 3, quantization: 'Q4_K_M' },
  { minRamGb: 6, maxRamGb: 8, maxParams: 4, quantization: 'Q4_K_M' },
  { minRamGb: 8, maxRamGb: 12, maxParams: 8, quantization: 'Q4_K_M' },
  { minRamGb: 12, maxRamGb: 16, maxParams: 13, quantization: 'Q4_K_M' },
  { minRamGb: 16, maxRamGb: Infinity, maxParams: 30, quantization: 'Q4_K_M' }
]

export function recommendForRam(ramGb: number): ModelRecommendationTier {
  return (
    RECOMMENDATION_TIERS.find((t) => ramGb >= t.minRamGb && ramGb < t.maxRamGb) ??
    RECOMMENDATION_TIERS[RECOMMENDATION_TIERS.length - 1]
  )
}

const RAW_CATALOG: ModelEntry[] = [
  // --- text (SLMs) — post-Jan-2026 only; the latest small-model challengers,
  // quantized for desktop. Dates are the source repo's HF createdAt. ---
  {
    id: 'unsloth/Qwen3.5-0.8B-GGUF',
    name: 'Qwen 3.5 0.8B',
    kind: 'text',
    org: 'Qwen',
    description: 'Tiny, very fast — runs on almost anything',
    params: 0.8,
    minRamGb: 3,
    quant: 'Q4_K_M',
    releaseDate: '2026-03-01',
    files: [
      {
        name: 'Qwen3.5-0.8B-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3.5-0.8B-GGUF', 'Qwen3.5-0.8B-Q4_K_M.gguf'),
        sizeBytes: 530000000,
        role: 'primary'
      },
      {
        name: 'mmproj-Qwen3.5-0.8B-BF16.gguf',
        url: resolve('unsloth/Qwen3.5-0.8B-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 207346528,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/Qwen3.5-2B-GGUF',
    name: 'Qwen 3.5 2B',
    kind: 'text',
    org: 'Qwen',
    description: 'Hybrid thinking + chat, long context',
    params: 2,
    minRamGb: 4,
    quant: 'Q4_K_M',
    releaseDate: '2026-02-28',
    files: [
      {
        name: 'Qwen3.5-2B-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_K_M.gguf'),
        sizeBytes: 1280000000,
        role: 'primary'
      },
      {
        name: 'mmproj-Qwen3.5-2B-BF16.gguf',
        url: resolve('unsloth/Qwen3.5-2B-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 671372992,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/Qwen3.5-4B-GGUF',
    name: 'Qwen 3.5 4B',
    kind: 'text',
    org: 'Qwen',
    description: 'Strong small general model — hybrid thinking + chat, long context',
    params: 4,
    minRamGb: 6,
    quant: 'Q4_K_M',
    tags: ['Challenger'],
    releaseDate: '2026-03-02',
    files: [
      {
        name: 'Qwen3.5-4B-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_K_M.gguf'),
        sizeBytes: 2740000000,
        role: 'primary'
      },
      {
        name: 'mmproj-Qwen3.5-4B-BF16.gguf',
        url: resolve('unsloth/Qwen3.5-4B-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 675569344,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/Qwen3.5-9B-GGUF',
    name: 'Qwen 3.5 9B',
    kind: 'text',
    org: 'Qwen',
    description: 'Higher-quality general reasoning; needs a bit more RAM',
    params: 9,
    minRamGb: 8,
    quant: 'Q4_K_M',
    tags: ['Challenger'],
    releaseDate: '2026-02-28',
    files: [
      {
        name: 'Qwen3.5-9B-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf'),
        sizeBytes: 5680000000,
        role: 'primary'
      },
      {
        name: 'mmproj-Qwen3.5-9B-BF16.gguf',
        url: resolve('unsloth/Qwen3.5-9B-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 921705024,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/Qwen3.5-27B-GGUF',
    name: 'Qwen 3.5 27B',
    kind: 'text',
    org: 'Qwen',
    description: 'Top Qwen3.5 quality — large; 24GB+ machines',
    params: 27,
    minRamGb: 24,
    quant: 'Q4_K_M',
    releaseDate: '2026-02-24',
    files: [
      {
        name: 'Qwen3.5-27B-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3.5-27B-GGUF', 'Qwen3.5-27B-Q4_K_M.gguf'),
        sizeBytes: 16740000000,
        role: 'primary'
      },
      {
        name: 'mmproj-Qwen3.5-27B-BF16.gguf',
        url: resolve('unsloth/Qwen3.5-27B-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 931145984,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/gemma-4-E2B-it-GGUF',
    name: 'Gemma 4 E2B',
    kind: 'vision',
    org: 'google',
    description: 'Google’s small efficient model — fast, capable, reads images',
    params: 2,
    minRamGb: 5,
    quant: 'Q4_K_M',
    releaseDate: '2026-04-01',
    files: [
      {
        name: 'gemma-4-E2B-it-Q4_K_M.gguf',
        url: resolve('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf'),
        sizeBytes: 3110000000,
        role: 'primary'
      },
      {
        name: 'mmproj-gemma-4-E2B-it-F16.gguf',
        url: resolve('unsloth/gemma-4-E2B-it-GGUF', 'mmproj-F16.gguf'),
        sizeBytes: 985654080,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/gemma-4-12b-it-GGUF',
    name: 'Gemma 4 12B',
    kind: 'text',
    org: 'google',
    description: 'Strong mid-size Gemma 4 — great general quality',
    params: 12,
    minRamGb: 12,
    quant: 'Q4_K_M',
    tags: ['Challenger'],
    releaseDate: '2026-05-29',
    files: [
      {
        name: 'gemma-4-12b-it-Q4_K_M.gguf',
        url: resolve('unsloth/gemma-4-12b-it-GGUF', 'gemma-4-12b-it-Q4_K_M.gguf'),
        sizeBytes: 7120000000,
        role: 'primary'
      },
      {
        name: 'mmproj-gemma-4-12b-it-BF16.gguf',
        url: resolve('unsloth/gemma-4-12b-it-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 175115840,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/gemma-4-26B-A4B-it-GGUF',
    name: 'Gemma 4 26B A4B (MoE)',
    kind: 'text',
    org: 'google',
    description: 'MoE — 26B quality at ~4B active speed; needs 20GB+',
    params: 26,
    minRamGb: 20,
    quant: 'Q4_K_M',
    tags: ['Challenger'],
    releaseDate: '2026-04-01',
    files: [
      {
        name: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
        url: resolve('unsloth/gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf'),
        sizeBytes: 16950000000,
        role: 'primary'
      },
      {
        name: 'mmproj-gemma-4-26B-A4B-it-BF16.gguf',
        url: resolve('unsloth/gemma-4-26B-A4B-it-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 1194828256,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/gemma-4-31B-it-GGUF',
    name: 'Gemma 4 31B',
    kind: 'text',
    org: 'google',
    description: 'Largest Gemma 4 dense — top quality; 24GB+ machines',
    params: 31,
    minRamGb: 24,
    quant: 'Q4_K_M',
    releaseDate: '2026-04-01',
    files: [
      {
        name: 'gemma-4-31B-it-Q4_K_M.gguf',
        url: resolve('unsloth/gemma-4-31B-it-GGUF', 'gemma-4-31B-it-Q4_K_M.gguf'),
        sizeBytes: 18320000000,
        role: 'primary'
      },
      {
        name: 'mmproj-gemma-4-31B-it-BF16.gguf',
        url: resolve('unsloth/gemma-4-31B-it-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 1200726496,
        role: 'mmproj'
      }
    ]
  },
  // --- vision (multimodal LLM) ---
  {
    id: 'unsloth/gemma-4-E4B-it-GGUF',
    name: 'Gemma 4 E4B',
    kind: 'vision',
    org: 'google',
    description: 'Thinking + vision, MoE',
    params: 4,
    minRamGb: 6,
    quant: 'Q4_K_M',
    tags: ['Challenger'],
    releaseDate: '2026-04-01',
    files: [
      {
        name: 'gemma-4-E4B-it-Q4_K_M.gguf',
        url: resolve('unsloth/gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf'),
        sizeBytes: 4980000000,
        role: 'primary'
      },
      {
        name: 'mmproj-gemma-4-E4B-it-F16.gguf',
        url: resolve('unsloth/gemma-4-E4B-it-GGUF', 'mmproj-F16.gguf'),
        sizeBytes: 990000000,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
    name: 'SmolVLM2 2.2B',
    kind: 'vision',
    org: 'HuggingFaceTB',
    description: 'Compact, fast vision-language model — great on modest RAM',
    params: 2.2,
    minRamGb: 6,
    quant: 'Q4_K_M',
    releaseDate: '2025-04-21',
    files: [
      {
        name: 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf',
        url: resolve('ggml-org/SmolVLM2-2.2B-Instruct-GGUF', 'SmolVLM2-2.2B-Instruct-Q4_K_M.gguf'),
        sizeBytes: 1110000000,
        role: 'primary'
      },
      {
        name: 'mmproj-SmolVLM2-2.2B-Instruct-f16.gguf',
        url: resolve(
          'ggml-org/SmolVLM2-2.2B-Instruct-GGUF',
          'mmproj-SmolVLM2-2.2B-Instruct-f16.gguf'
        ),
        sizeBytes: 870000000,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/Qwen3-VL-2B-Instruct-GGUF',
    name: 'Qwen3-VL 2B',
    kind: 'vision',
    org: 'Qwen',
    description: 'Small vision-language model — fast and capable',
    params: 2,
    minRamGb: 6,
    quant: 'Q4_K_M',
    releaseDate: '2025-10-30',
    files: [
      {
        name: 'Qwen3-VL-2B-Instruct-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3-VL-2B-Instruct-GGUF', 'Qwen3-VL-2B-Instruct-Q4_K_M.gguf'),
        sizeBytes: 1110000000,
        role: 'primary'
      },
      {
        name: 'mmproj-Qwen3-VL-2B-Instruct-F16.gguf',
        url: resolve('unsloth/Qwen3-VL-2B-Instruct-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 820000000,
        role: 'mmproj'
      }
    ]
  },
  {
    id: 'unsloth/Qwen3-VL-8B-Instruct-GGUF',
    name: 'Qwen3-VL 8B',
    kind: 'vision',
    org: 'Qwen',
    description: 'Stronger VLM — better detail + OCR; needs more RAM',
    params: 8,
    minRamGb: 10,
    quant: 'Q4_K_M',
    releaseDate: '2025-10-30',
    files: [
      {
        name: 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3-VL-8B-Instruct-GGUF', 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf'),
        sizeBytes: 5030000000,
        role: 'primary'
      },
      {
        name: 'mmproj-Qwen3-VL-8B-Instruct-F16.gguf',
        url: resolve('unsloth/Qwen3-VL-8B-Instruct-GGUF', 'mmproj-BF16.gguf'),
        sizeBytes: 1160000000,
        role: 'mmproj'
      }
    ]
  },
  {
    // The desktop vision-rail grounder (supervised computer use): reads a
    // screenshot and points at the control to act on. Qwen2.5-VL base,
    // Apache-2.0; GGUF + mmproj by mradermacher. ~6GB with the projector.
    id: 'mradermacher/UI-TARS-1.5-7B-GGUF',
    name: 'UI-TARS 1.5 7B',
    kind: 'vision',
    org: 'ByteDance',
    description: 'GUI grounding for supervised computer use — points at the control to click',
    params: 7,
    minRamGb: 10,
    quant: 'Q4_K_M',
    grounder: true,
    tags: ['Computer use'],
    releaseDate: '2025-04-17',
    files: [
      {
        name: 'UI-TARS-1.5-7B.Q4_K_M.gguf',
        url: resolve('mradermacher/UI-TARS-1.5-7B-GGUF', 'UI-TARS-1.5-7B.Q4_K_M.gguf'),
        sizeBytes: 4683073856,
        role: 'primary'
      },
      {
        name: 'UI-TARS-1.5-7B.mmproj-f16.gguf',
        url: resolve('mradermacher/UI-TARS-1.5-7B-GGUF', 'UI-TARS-1.5-7B.mmproj-f16.gguf'),
        sizeBytes: 1354162880,
        role: 'mmproj'
      }
    ]
  },
  // --- image generation — 2026 / fast few-step models only (open weight) ---
  {
    id: 'leejet/Z-Image-Turbo-GGUF',
    name: 'Z-Image Turbo (2026)',
    kind: 'image',
    // NOT tagged 'Fast': despite the "Turbo" name this is a FLUX-class diffusion
    // transformer (DiT + Qwen3-4B text encoder + FLUX VAE) — heavy and slow on
    // Apple Silicon via ggml, not a few-step SDXL distill. 'Fast' is reserved for
    // models verified fast on-device (dreamshaper-turbo, realvis-lightning).
    tags: ['Recommended', '2026', 'Top quality'],
    org: 'Alibaba Tongyi',
    description:
      'Flagship 2026 model — 1024px in ~8 steps, top quality-per-byte, strong bilingual text. Apache-2.0. (diffusion + Qwen3 encoder + VAE)',
    minRamGb: 12,
    imageModes: ['txt2img'],
    files: [
      {
        name: 'z_image_turbo-Q4_K.gguf',
        url: resolve('leejet/Z-Image-Turbo-GGUF', 'z_image_turbo-Q4_K.gguf'),
        role: 'primary',
        sizeBytes: 3860000000
      },
      {
        name: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        url: resolve('unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
        role: 'aux',
        sizeBytes: 2500000000
      },
      {
        name: 'ae.safetensors',
        url: resolve('second-state/FLUX.1-schnell-GGUF', 'ae.safetensors'),
        role: 'aux',
        sizeBytes: 340000000
      }
    ]
  },
  // NOTE: MLX/mflux image models are PARKED (2026-06-23) — the only non-gated
  // on-device MLX LoRA options are too large to ship (Z-Image ~13GB 8-bit / ~33GB
  // bf16; FLUX.1-schnell 4-bit ~10GB). No MLX catalog entry is exposed. The
  // dormant runtime plumbing lives in src/main/mflux.ts (re-enable by repopulating
  // MFLUX_MODELS + restoring an entry here with runtime:'mflux').
  {
    id: 'mzwing/SDXL-Lightning-GGUF',
    name: 'SDXL Lightning (4-step)',
    kind: 'image',
    tags: ['Recommended', 'Fast'],
    org: 'ByteDance',
    description:
      'Near-SDXL quality at 1024px in 4 steps (~7× faster). ~4GB model. Best balance — recommended.',
    minRamGb: 8,
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'sdxl_lightning_4step.q8_0.gguf',
        url: resolve('mzwing/SDXL-Lightning-GGUF', 'sdxl_lightning_4step.q8_0.gguf'),
        role: 'primary',
        sizeBytes: 4099000000
      }
    ]
  },
  {
    id: 'OlegSkutte/sdxl-turbo-GGUF',
    name: 'SDXL Turbo (fast drafts)',
    kind: 'image',
    tags: ['Fastest', 'Drafts'],
    org: 'Stability AI',
    description:
      'Distilled SDXL — 1-4 steps, ~10s drafts at 512px. Fastest option; lower fidelity.',
    minRamGb: 8,
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'sd_xl_turbo_1.0.q8_0.gguf',
        url: resolve('OlegSkutte/sdxl-turbo-GGUF', 'sd_xl_turbo_1.0.q8_0.gguf'),
        role: 'primary',
        sizeBytes: 4100000000
      }
    ]
  },
  // SDXL finetunes — Off Grid GGUF builds (q8). The community GGUF quants of these
  // are mis-exported and won't load in sd.cpp, so we converted the official
  // OpenRAIL checkpoints ourselves (offgrid-ai HF org) → correct, ~4GB, on-device.
  {
    id: 'offgrid-ai/realvisxl-v5.0-GGUF',
    name: 'RealVisXL v5.0 (photoreal)',
    kind: 'image',
    tags: ['High quality', 'Photoreal'],
    org: 'RealVis',
    description: 'Top photorealism SDXL — Off Grid GGUF build of SG161222/RealVisXL_V5.0.',
    minRamGb: 8,
    quant: 'Q8_0',
    releaseDate: '2024-08-05',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'realvisxl-v5.0-Q8_0.gguf',
        url: resolve('offgrid-ai/realvisxl-v5.0-GGUF', 'realvisxl-v5.0-Q8_0.gguf'),
        role: 'primary',
        sizeBytes: 4180000000
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, runs on a 16GB Mac. Tagged 'Light'
    // so the RAM-aware default + "Recommended" badge pick it on <= 16GB machines.
    id: 'offgrid-ai/realvisxl-v5.0-GGUF-Q4',
    name: 'RealVisXL v5.0 (Light)',
    kind: 'image',
    tags: ['Photoreal', 'Light'],
    org: 'RealVis',
    description:
      'Top photorealism SDXL. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of SG161222/RealVisXL_V5.0.',
    minRamGb: 8,
    quant: 'Q4_K',
    releaseDate: '2024-08-05',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'realvisxl-v5.0-Q4_K.gguf',
        url: resolve('offgrid-ai/realvisxl-v5.0-GGUF', 'realvisxl-v5.0-Q4_K.gguf'),
        role: 'primary',
        sizeBytes: 2800000000
      }
    ]
  },
  {
    id: 'offgrid-ai/realvisxl-v5.0-lightning-GGUF',
    name: 'RealVisXL v5.0 Lightning (photoreal)',
    kind: 'image',
    // Full Q8: few-step, but ~4.2GB pegs a 16GB Mac — 'Fast' is reserved for the
    // Light (Q4) sibling that's both few-step AND memory-safe.
    tags: ['Photoreal'],
    org: 'RealVis',
    description:
      'Photoreal SDXL, few-step (fast) — Off Grid GGUF build of SG161222/RealVisXL_V5.0_Lightning.',
    minRamGb: 8,
    quant: 'Q8_0',
    releaseDate: '2024-09-02',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'realvisxl-v5.0-lightning-Q8_0.gguf',
        url: resolve(
          'offgrid-ai/realvisxl-v5.0-lightning-GGUF',
          'realvisxl-v5.0-lightning-Q8_0.gguf'
        ),
        role: 'primary',
        sizeBytes: 4180000000
      }
    ]
  },
  {
    // Light (Q4_K) sibling — few-step photoreal, ~35% less memory, 16GB-friendly.
    id: 'offgrid-ai/realvisxl-v5.0-lightning-GGUF-Q4',
    name: 'RealVisXL v5.0 Lightning (Light)',
    kind: 'image',
    tags: ['Fast', 'Photoreal', 'Light'],
    org: 'RealVis',
    description:
      'Photoreal SDXL, few-step (fast). Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of SG161222/RealVisXL_V5.0_Lightning.',
    minRamGb: 8,
    quant: 'Q4_K',
    releaseDate: '2024-09-02',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'realvisxl-v5.0-lightning-Q4_K.gguf',
        url: resolve(
          'offgrid-ai/realvisxl-v5.0-lightning-GGUF',
          'realvisxl-v5.0-lightning-Q4_K.gguf'
        ),
        role: 'primary',
        sizeBytes: 2800000000
      }
    ]
  },
  {
    id: 'offgrid-ai/dreamshaper-xl-v2-turbo-GGUF',
    name: 'DreamShaper XL v2 Turbo (versatile)',
    kind: 'image',
    // Full Q8: few-step, but ~4.2GB pegs a 16GB Mac — 'Fast' is reserved for the
    // Light (Q4) sibling that's both few-step AND memory-safe.
    tags: ['Versatile'],
    org: 'Lykon',
    description:
      'The all-rounder — photoreal, art, fantasy, 3D. Off Grid GGUF build of Lykon/dreamshaper-xl-v2-turbo. Full Q8 quant (best quality); best on 24GB+ RAM.',
    minRamGb: 8,
    quant: 'Q8_0',
    releaseDate: '2024-02-07',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'dreamshaper-xl-v2-turbo-Q8_0.gguf',
        url: resolve(
          'offgrid-ai/dreamshaper-xl-v2-turbo-GGUF',
          'dreamshaper-xl-v2-turbo-Q8_0.gguf'
        ),
        role: 'primary',
        sizeBytes: 4180000000
      }
    ]
  },
  {
    // Lighter Q4_K quant of the same distilled turbo model — ~35% less memory
    // (~3.08GB peak vs ~4.7GB), so it runs on a 16GB Mac without pegging unified
    // memory. Same repo, distinct id + filename so download/active-tracking treat
    // it as a separate installable model. Tagged 'Light' → the RAM-aware default +
    // "Recommended" badge pick it on machines with <= 16GB RAM.
    id: 'offgrid-ai/dreamshaper-xl-v2-turbo-GGUF-Q4',
    name: 'DreamShaper XL v2 Turbo (Light)',
    kind: 'image',
    tags: ['Versatile', 'Fast', 'Light'],
    org: 'Lykon',
    description:
      'The all-rounder — photoreal, art, fantasy, 3D. Q4 quant: ~35% less memory than the full model, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of Lykon/dreamshaper-xl-v2-turbo.',
    minRamGb: 8,
    quant: 'Q4_K',
    releaseDate: '2024-02-07',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'dreamshaper-xl-v2-turbo-Q4_K.gguf',
        url: resolve(
          'offgrid-ai/dreamshaper-xl-v2-turbo-GGUF',
          'dreamshaper-xl-v2-turbo-Q4_K.gguf'
        ),
        role: 'primary',
        sizeBytes: 2800000000
      }
    ]
  },
  {
    id: 'offgrid-ai/juggernaut-xl-v9-GGUF',
    name: 'Juggernaut XL v9 (photoreal)',
    kind: 'image',
    tags: ['High quality', 'Photoreal'],
    org: 'RunDiffusion',
    description:
      'Versatile photoreal SDXL — cinematic, portraits, landscapes. Off Grid GGUF build of RunDiffusion/Juggernaut-XL-v9.',
    minRamGb: 8,
    quant: 'Q8_0',
    releaseDate: '2024-02-18',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'juggernaut-xl-v9-Q8_0.gguf',
        url: resolve('offgrid-ai/juggernaut-xl-v9-GGUF', 'juggernaut-xl-v9-Q8_0.gguf'),
        role: 'primary',
        sizeBytes: 4350000000
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: 'offgrid-ai/juggernaut-xl-v9-GGUF-Q4',
    name: 'Juggernaut XL v9 (Light)',
    kind: 'image',
    tags: ['Photoreal', 'Light'],
    org: 'RunDiffusion',
    description:
      'Versatile photoreal SDXL. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of RunDiffusion/Juggernaut-XL-v9.',
    minRamGb: 8,
    quant: 'Q4_K',
    releaseDate: '2024-02-18',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'juggernaut-xl-v9-Q4_K.gguf',
        url: resolve('offgrid-ai/juggernaut-xl-v9-GGUF', 'juggernaut-xl-v9-Q4_K.gguf'),
        role: 'primary',
        sizeBytes: 2900000000
      }
    ]
  },
  {
    id: 'offgrid-ai/animagine-xl-4.0-GGUF',
    name: 'Animagine XL 4.0 (anime)',
    kind: 'image',
    tags: ['High quality', 'Anime'],
    org: 'Cagliostro',
    description:
      'Leading anime SDXL — strong character knowledge. Off Grid GGUF build of cagliostrolab/animagine-xl-4.0.',
    minRamGb: 8,
    quant: 'Q8_0',
    releaseDate: '2025-01-10',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'animagine-xl-4.0-Q8_0.gguf',
        url: resolve('offgrid-ai/animagine-xl-4.0-GGUF', 'animagine-xl-4.0-Q8_0.gguf'),
        role: 'primary',
        sizeBytes: 4180000000
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: 'offgrid-ai/animagine-xl-4.0-GGUF-Q4',
    name: 'Animagine XL 4.0 (Light)',
    kind: 'image',
    tags: ['Anime', 'Light'],
    org: 'Cagliostro',
    description:
      'Leading anime SDXL — strong character knowledge. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of cagliostrolab/animagine-xl-4.0.',
    minRamGb: 8,
    quant: 'Q4_K',
    releaseDate: '2025-01-10',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'animagine-xl-4.0-Q4_K.gguf',
        url: resolve('offgrid-ai/animagine-xl-4.0-GGUF', 'animagine-xl-4.0-Q4_K.gguf'),
        role: 'primary',
        sizeBytes: 2800000000
      }
    ]
  },
  {
    id: 'offgrid-ai/illustrious-xl-v2.0-GGUF',
    name: 'Illustrious XL v2.0 (anime)',
    kind: 'image',
    tags: ['High quality', 'Anime'],
    org: 'OnomaAI',
    description:
      'Top anime / illustration SDXL base. Off Grid GGUF build of OnomaAIResearch/Illustrious-XL-v2.0.',
    minRamGb: 8,
    quant: 'Q8_0',
    releaseDate: '2025-04-18',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'illustrious-xl-v2.0-Q8_0.gguf',
        url: resolve('offgrid-ai/illustrious-xl-v2.0-GGUF', 'illustrious-xl-v2.0-Q8_0.gguf'),
        role: 'primary',
        sizeBytes: 4180000000
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: 'offgrid-ai/illustrious-xl-v2.0-GGUF-Q4',
    name: 'Illustrious XL v2.0 (Light)',
    kind: 'image',
    tags: ['Anime', 'Light'],
    org: 'OnomaAI',
    description:
      'Top anime / illustration SDXL base. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of OnomaAIResearch/Illustrious-XL-v2.0.',
    minRamGb: 8,
    quant: 'Q4_K',
    releaseDate: '2025-04-18',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'illustrious-xl-v2.0-Q4_K.gguf',
        url: resolve('offgrid-ai/illustrious-xl-v2.0-GGUF', 'illustrious-xl-v2.0-Q4_K.gguf'),
        role: 'primary',
        sizeBytes: 2800000000
      }
    ]
  },
  {
    id: 'offgrid-ai/pony-diffusion-v6-xl-GGUF',
    name: 'Pony Diffusion V6 XL (stylized)',
    kind: 'image',
    tags: ['High quality', 'Stylized'],
    org: 'PurpleSmartAI',
    description:
      'Dominant SDXL for stylized characters & illustration; highly promptable. Off Grid GGUF build of Pony Diffusion V6 XL.',
    minRamGb: 8,
    quant: 'Q8_0',
    releaseDate: '2024-05-25',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'pony-diffusion-v6-xl-Q8_0.gguf',
        url: resolve('offgrid-ai/pony-diffusion-v6-xl-GGUF', 'pony-diffusion-v6-xl-Q8_0.gguf'),
        role: 'primary',
        sizeBytes: 4180000000
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: 'offgrid-ai/pony-diffusion-v6-xl-GGUF-Q4',
    name: 'Pony Diffusion V6 XL (Light)',
    kind: 'image',
    tags: ['Stylized', 'Light'],
    org: 'PurpleSmartAI',
    description:
      'Dominant SDXL for stylized characters & illustration. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of Pony Diffusion V6 XL.',
    minRamGb: 8,
    quant: 'Q4_K',
    releaseDate: '2024-05-25',
    imageModes: ['txt2img', 'img2img'],
    files: [
      {
        name: 'pony-diffusion-v6-xl-Q4_K.gguf',
        url: resolve('offgrid-ai/pony-diffusion-v6-xl-GGUF', 'pony-diffusion-v6-xl-Q4_K.gguf'),
        role: 'primary',
        sizeBytes: 2800000000
      }
    ]
  },
  // --- voice (TTS); open models, ONNX runtime (no Python) ---
  {
    id: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    name: 'Kokoro TTS 82M',
    kind: 'voice',
    org: 'hexgrad',
    description: 'Lightweight, natural text-to-speech (ONNX); great default',
    minRamGb: 3,
    files: [
      {
        name: 'kokoro-82m-v1.0.onnx',
        url: resolve('onnx-community/Kokoro-82M-v1.0-ONNX', 'onnx/model_quantized.onnx'),
        role: 'primary',
        sizeBytes: 92361116
      }
    ]
  },
  {
    id: 'rhasspy/piper-voices/en_US-lessac-medium',
    name: 'Piper - Lessac (English)',
    kind: 'voice',
    org: 'rhasspy',
    description: 'Fast multi-voice text-to-speech (ONNX); many languages available',
    minRamGb: 2,
    files: [
      {
        name: 'en_US-lessac-medium.onnx',
        url: resolve('rhasspy/piper-voices', 'en/en_US/lessac/medium/en_US-lessac-medium.onnx'),
        role: 'primary',
        sizeBytes: 63201294
      },
      {
        name: 'en_US-lessac-medium.onnx.json',
        url: resolve(
          'rhasspy/piper-voices',
          'en/en_US/lessac/medium/en_US-lessac-medium.onnx.json'
        ),
        role: 'aux'
      }
    ]
  },
  // --- transcription (STT / whisper); all from ggerganov/whisper.cpp (ggml .bin) ---
  {
    id: 'ggerganov/whisper.cpp/tiny',
    name: 'Whisper Tiny',
    kind: 'transcription',
    org: 'ggerganov',
    description: 'Fastest, smallest — lowest accuracy',
    minRamGb: 2,
    files: [
      {
        name: 'ggml-tiny.bin',
        url: resolve('ggerganov/whisper.cpp', 'ggml-tiny.bin'),
        role: 'primary',
        sizeBytes: 77700000
      }
    ]
  },
  {
    id: 'ggerganov/whisper.cpp/base',
    name: 'Whisper Base',
    kind: 'transcription',
    org: 'ggerganov',
    description: 'Offline speech-to-text (base) — good speed/quality default',
    minRamGb: 3,
    files: [
      {
        name: 'ggml-base.bin',
        url: resolve('ggerganov/whisper.cpp', 'ggml-base.bin'),
        role: 'primary',
        sizeBytes: 147951000
      }
    ]
  },
  {
    id: 'ggerganov/whisper.cpp/small',
    name: 'Whisper Small',
    kind: 'transcription',
    org: 'ggerganov',
    description: 'Offline speech-to-text (higher accuracy)',
    minRamGb: 4,
    files: [
      {
        name: 'ggml-small.bin',
        url: resolve('ggerganov/whisper.cpp', 'ggml-small.bin'),
        role: 'primary',
        sizeBytes: 487601000
      }
    ]
  },
  {
    id: 'ggerganov/whisper.cpp/medium',
    name: 'Whisper Medium',
    kind: 'transcription',
    org: 'ggerganov',
    description: 'High accuracy; slower',
    minRamGb: 6,
    files: [
      {
        name: 'ggml-medium.bin',
        url: resolve('ggerganov/whisper.cpp', 'ggml-medium.bin'),
        role: 'primary',
        sizeBytes: 1533000000
      }
    ]
  },
  {
    id: 'ggerganov/whisper.cpp/large-v3-turbo',
    name: 'Whisper Large v3 Turbo',
    kind: 'transcription',
    org: 'ggerganov',
    description: 'Near-large accuracy, much faster — recommended',
    minRamGb: 6,
    files: [
      {
        name: 'ggml-large-v3-turbo.bin',
        url: resolve('ggerganov/whisper.cpp', 'ggml-large-v3-turbo.bin'),
        role: 'primary',
        sizeBytes: 1624000000
      }
    ]
  },
  {
    id: 'ggerganov/whisper.cpp/large-v3',
    name: 'Whisper Large v3',
    kind: 'transcription',
    org: 'ggerganov',
    description: 'Highest accuracy (large); needs more RAM',
    minRamGb: 8,
    files: [
      {
        name: 'ggml-large-v3.bin',
        url: resolve('ggerganov/whisper.cpp', 'ggml-large-v3.bin'),
        role: 'primary',
        sizeBytes: 3095000000
      }
    ]
  },
  // --- transcription (Parakeet, NVIDIA NeMo) — sherpa-onnx offline transducer (ONNX).
  // A model is 4 files (encoder/decoder/joiner/tokens); on-disk names are slug-prefixed
  // so multiple Parakeet models coexist in the flat models dir without colliding. Higher
  // accuracy than whisper; served by the bundled sherpa-onnx CLI (engine: 'parakeet'). ---
  {
    id: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    name: 'Parakeet TDT 0.6B v2',
    kind: 'transcription',
    engine: 'parakeet',
    org: 'nvidia',
    description: 'High-accuracy English STT (int8) - tops the open ASR leaderboard',
    minRamGb: 4,
    tags: ['Accurate', 'English'],
    files: [
      {
        name: 'parakeet-v2.encoder.int8.onnx',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'encoder.int8.onnx'),
        role: 'primary',
        sizeBytes: 652000000
      },
      {
        name: 'parakeet-v2.decoder.int8.onnx',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'decoder.int8.onnx'),
        role: 'aux',
        sizeBytes: 7260000
      },
      {
        name: 'parakeet-v2.joiner.int8.onnx',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'joiner.int8.onnx'),
        role: 'aux',
        sizeBytes: 1740000
      },
      {
        name: 'parakeet-v2.tokens.txt',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'tokens.txt'),
        role: 'tokenizer',
        sizeBytes: 9600
      }
    ]
  },
  {
    id: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    name: 'Parakeet TDT 0.6B v3',
    kind: 'transcription',
    engine: 'parakeet',
    org: 'nvidia',
    description: 'Multilingual STT (int8) - 25 European languages',
    minRamGb: 4,
    isNew: true,
    tags: ['Accurate', 'Multilingual'],
    files: [
      {
        name: 'parakeet-v3.encoder.int8.onnx',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'encoder.int8.onnx'),
        role: 'primary',
        sizeBytes: 652000000
      },
      {
        name: 'parakeet-v3.decoder.int8.onnx',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'decoder.int8.onnx'),
        role: 'aux',
        sizeBytes: 7260000
      },
      {
        name: 'parakeet-v3.joiner.int8.onnx',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'joiner.int8.onnx'),
        role: 'aux',
        sizeBytes: 1740000
      },
      {
        name: 'parakeet-v3.tokens.txt',
        url: resolve('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'tokens.txt'),
        role: 'tokenizer',
        sizeBytes: 9600
      }
    ]
  }
]

// Normalize every entry through the data-derived capability rule: an entry that lists
// a projector is vision, whatever its hand-typed `kind` said. So a future entry can't
// ship a projector while mislabeled text-only (the Gemma 4 E2B bug), and `kind` is
// always consistent with the files for every consumer.
export const CATALOG: ModelEntry[] = RAW_CATALOG.map((e) => ({
  ...e,
  kind: deriveKind(e.files, e.kind)
}))

export function modelsByKind(kind: ModelKind): ModelEntry[] {
  return CATALOG.filter((m) => m.kind === kind)
}

// GUI-grounding model families, for a user's own Hugging Face pick that is not in
// the catalog. For catalogued models the `grounder` flag is authoritative; this
// heuristic only decides the unknowns.
const GROUNDER_NAME =
  /ui[-_ ]?tars|holo(?:1|-|_| )|gui[-_ ]?owl|aguvis|show[-_ ]?ui|cogagent|os[-_ ]?atlas|ferret[-_ ]?ui|seeclick/i

/** Whether a model grounds GUI clicks (the desktop vision rail's ideal input).
 *  Catalogued models answer from their `grounder` flag - the single source of
 *  truth; an off-catalog id/name falls back to the known-family heuristic. Used
 *  to WARN, never to block: the vision rail stays model-agnostic. */
export function isGrounderModel(idOrName: string, catalog: ModelEntry[] = CATALOG): boolean {
  const entry = catalog.find((m) => m.id === idOrName || m.name === idOrName)
  if (entry) {
    return entry.grounder === true
  }
  return GROUNDER_NAME.test(idOrName)
}

export const MODEL_KINDS: ModelKind[] = ['text', 'vision', 'image', 'voice', 'transcription']
