"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  CATALOG: () => CATALOG,
  CREDIBILITY_LABELS: () => CREDIBILITY_LABELS,
  CREDIBILITY_OPTIONS: () => CREDIBILITY_OPTIONS,
  LIGHT_MODEL_RAM_CEILING_GB: () => LIGHT_MODEL_RAM_CEILING_GB,
  MODEL_KINDS: () => MODEL_KINDS,
  MODEL_TYPE_OPTIONS: () => MODEL_TYPE_OPTIONS,
  ModelDownloader: () => ModelDownloader,
  OFFICIAL_MODEL_AUTHORS: () => OFFICIAL_MODEL_AUTHORS,
  ProviderRegistry: () => ProviderRegistry,
  QUANTIZATION_INFO: () => QUANTIZATION_INFO,
  RECOMMENDATION_TIERS: () => RECOMMENDATION_TIERS,
  SIZE_OPTIONS: () => SIZE_OPTIONS,
  SORT_OPTIONS: () => SORT_OPTIONS,
  VERIFIED_QUANTIZERS: () => VERIFIED_QUANTIZERS,
  applyFilters: () => applyFilters,
  applySort: () => applySort,
  bestFitScore: () => bestFitScore,
  createProvider: () => createProvider,
  deriveKind: () => deriveKind,
  determineCredibility: () => determineCredibility,
  extractQuantization: () => extractQuantization,
  filterAndSort: () => filterAndSort,
  formatFileSize: () => formatFileSize,
  getModelFiles: () => getModelFiles,
  getModelType: () => getModelType,
  hasActiveFilters: () => hasActiveFilters,
  hasVisionProjector: () => hasVisionProjector,
  initialFilterState: () => initialFilterState,
  isGrounderModel: () => isGrounderModel,
  isMMProjFile: () => isMMProjFile,
  modelsByKind: () => modelsByKind,
  ollamaProvider: () => ollamaProvider,
  openAICompatibleProvider: () => openAICompatibleProvider,
  parseParamCount: () => parseParamCount,
  recommendForRam: () => recommendForRam,
  recommendedImageModelId: () => recommendedImageModelId,
  resolveHuggingFaceModel: () => resolveHuggingFaceModel,
  searchHuggingFace: () => searchHuggingFace,
  supportsMode: () => supportsMode,
  validateImageGenRequest: () => validateImageGenRequest
});
module.exports = __toCommonJS(index_exports);

// src/capabilities.ts
function hasVisionProjector(files) {
  return files.some((f) => f.role === "mmproj");
}
function deriveKind(files, declared) {
  if ((declared === "text" || declared === "vision") && hasVisionProjector(files)) {
    return "vision";
  }
  return declared;
}

// src/catalog.ts
var HF = "https://huggingface.co";
var resolve = (repo, file) => `${HF}/${repo}/resolve/main/${file}`;
var RECOMMENDATION_TIERS = [
  { minRamGb: 3, maxRamGb: 4, maxParams: 1.5, quantization: "Q4_K_M" },
  { minRamGb: 4, maxRamGb: 6, maxParams: 3, quantization: "Q4_K_M" },
  { minRamGb: 6, maxRamGb: 8, maxParams: 4, quantization: "Q4_K_M" },
  { minRamGb: 8, maxRamGb: 12, maxParams: 8, quantization: "Q4_K_M" },
  { minRamGb: 12, maxRamGb: 16, maxParams: 13, quantization: "Q4_K_M" },
  { minRamGb: 16, maxRamGb: Infinity, maxParams: 30, quantization: "Q4_K_M" }
];
function recommendForRam(ramGb) {
  return RECOMMENDATION_TIERS.find((t) => ramGb >= t.minRamGb && ramGb < t.maxRamGb) ?? RECOMMENDATION_TIERS[RECOMMENDATION_TIERS.length - 1];
}
var RAW_CATALOG = [
  // --- text (SLMs) — post-Jan-2026 only; the latest small-model challengers,
  // quantized for desktop. Dates are the source repo's HF createdAt. ---
  {
    id: "unsloth/Qwen3.5-0.8B-GGUF",
    name: "Qwen 3.5 0.8B",
    kind: "text",
    org: "Qwen",
    description: "Tiny, very fast \u2014 runs on almost anything",
    params: 0.8,
    minRamGb: 3,
    quant: "Q4_K_M",
    releaseDate: "2026-03-01",
    files: [
      {
        name: "Qwen3.5-0.8B-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3.5-0.8B-GGUF", "Qwen3.5-0.8B-Q4_K_M.gguf"),
        sizeBytes: 53e7,
        role: "primary"
      },
      {
        name: "mmproj-Qwen3.5-0.8B-BF16.gguf",
        url: resolve("unsloth/Qwen3.5-0.8B-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 207346528,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/Qwen3.5-2B-GGUF",
    name: "Qwen 3.5 2B",
    kind: "text",
    org: "Qwen",
    description: "Hybrid thinking + chat, long context",
    params: 2,
    minRamGb: 4,
    quant: "Q4_K_M",
    releaseDate: "2026-02-28",
    files: [
      {
        name: "Qwen3.5-2B-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3.5-2B-GGUF", "Qwen3.5-2B-Q4_K_M.gguf"),
        sizeBytes: 128e7,
        role: "primary"
      },
      {
        name: "mmproj-Qwen3.5-2B-BF16.gguf",
        url: resolve("unsloth/Qwen3.5-2B-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 671372992,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/Qwen3.5-4B-GGUF",
    name: "Qwen 3.5 4B",
    kind: "text",
    org: "Qwen",
    description: "Strong small general model \u2014 hybrid thinking + chat, long context",
    params: 4,
    minRamGb: 6,
    quant: "Q4_K_M",
    tags: ["Challenger"],
    releaseDate: "2026-03-02",
    files: [
      {
        name: "Qwen3.5-4B-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf"),
        sizeBytes: 274e7,
        role: "primary"
      },
      {
        name: "mmproj-Qwen3.5-4B-BF16.gguf",
        url: resolve("unsloth/Qwen3.5-4B-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 675569344,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/Qwen3.5-9B-GGUF",
    name: "Qwen 3.5 9B",
    kind: "text",
    org: "Qwen",
    description: "Higher-quality general reasoning; needs a bit more RAM",
    params: 9,
    minRamGb: 8,
    quant: "Q4_K_M",
    tags: ["Challenger"],
    releaseDate: "2026-02-28",
    files: [
      {
        name: "Qwen3.5-9B-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3.5-9B-GGUF", "Qwen3.5-9B-Q4_K_M.gguf"),
        sizeBytes: 568e7,
        role: "primary"
      },
      {
        name: "mmproj-Qwen3.5-9B-BF16.gguf",
        url: resolve("unsloth/Qwen3.5-9B-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 921705024,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/Qwen3.5-27B-GGUF",
    name: "Qwen 3.5 27B",
    kind: "text",
    org: "Qwen",
    description: "Top Qwen3.5 quality \u2014 large; 24GB+ machines",
    params: 27,
    minRamGb: 24,
    quant: "Q4_K_M",
    releaseDate: "2026-02-24",
    files: [
      {
        name: "Qwen3.5-27B-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3.5-27B-GGUF", "Qwen3.5-27B-Q4_K_M.gguf"),
        sizeBytes: 1674e7,
        role: "primary"
      },
      {
        name: "mmproj-Qwen3.5-27B-BF16.gguf",
        url: resolve("unsloth/Qwen3.5-27B-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 931145984,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/gemma-4-E2B-it-GGUF",
    name: "Gemma 4 E2B",
    kind: "vision",
    org: "google",
    description: "Google\u2019s small efficient model \u2014 fast, capable, reads images",
    params: 2,
    minRamGb: 5,
    quant: "Q4_K_M",
    releaseDate: "2026-04-01",
    files: [
      {
        name: "gemma-4-E2B-it-Q4_K_M.gguf",
        url: resolve("unsloth/gemma-4-E2B-it-GGUF", "gemma-4-E2B-it-Q4_K_M.gguf"),
        sizeBytes: 311e7,
        role: "primary"
      },
      {
        name: "mmproj-gemma-4-E2B-it-F16.gguf",
        url: resolve("unsloth/gemma-4-E2B-it-GGUF", "mmproj-F16.gguf"),
        sizeBytes: 985654080,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/gemma-4-12b-it-GGUF",
    name: "Gemma 4 12B",
    kind: "text",
    org: "google",
    description: "Strong mid-size Gemma 4 \u2014 great general quality",
    params: 12,
    minRamGb: 12,
    quant: "Q4_K_M",
    tags: ["Challenger"],
    releaseDate: "2026-05-29",
    files: [
      {
        name: "gemma-4-12b-it-Q4_K_M.gguf",
        url: resolve("unsloth/gemma-4-12b-it-GGUF", "gemma-4-12b-it-Q4_K_M.gguf"),
        sizeBytes: 712e7,
        role: "primary"
      },
      {
        name: "mmproj-gemma-4-12b-it-BF16.gguf",
        url: resolve("unsloth/gemma-4-12b-it-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 175115840,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/gemma-4-26B-A4B-it-GGUF",
    name: "Gemma 4 26B A4B (MoE)",
    kind: "text",
    org: "google",
    description: "MoE \u2014 26B quality at ~4B active speed; needs 20GB+",
    params: 26,
    minRamGb: 20,
    quant: "Q4_K_M",
    tags: ["Challenger"],
    releaseDate: "2026-04-01",
    files: [
      {
        name: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
        url: resolve("unsloth/gemma-4-26B-A4B-it-GGUF", "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf"),
        sizeBytes: 1695e7,
        role: "primary"
      },
      {
        name: "mmproj-gemma-4-26B-A4B-it-BF16.gguf",
        url: resolve("unsloth/gemma-4-26B-A4B-it-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 1194828256,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/gemma-4-31B-it-GGUF",
    name: "Gemma 4 31B",
    kind: "text",
    org: "google",
    description: "Largest Gemma 4 dense \u2014 top quality; 24GB+ machines",
    params: 31,
    minRamGb: 24,
    quant: "Q4_K_M",
    releaseDate: "2026-04-01",
    files: [
      {
        name: "gemma-4-31B-it-Q4_K_M.gguf",
        url: resolve("unsloth/gemma-4-31B-it-GGUF", "gemma-4-31B-it-Q4_K_M.gguf"),
        sizeBytes: 1832e7,
        role: "primary"
      },
      {
        name: "mmproj-gemma-4-31B-it-BF16.gguf",
        url: resolve("unsloth/gemma-4-31B-it-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 1200726496,
        role: "mmproj"
      }
    ]
  },
  // --- vision (multimodal LLM) ---
  {
    id: "unsloth/gemma-4-E4B-it-GGUF",
    name: "Gemma 4 E4B",
    kind: "vision",
    org: "google",
    description: "Thinking + vision, MoE",
    params: 4,
    minRamGb: 6,
    quant: "Q4_K_M",
    tags: ["Challenger"],
    releaseDate: "2026-04-01",
    files: [
      {
        name: "gemma-4-E4B-it-Q4_K_M.gguf",
        url: resolve("unsloth/gemma-4-E4B-it-GGUF", "gemma-4-E4B-it-Q4_K_M.gguf"),
        sizeBytes: 498e7,
        role: "primary"
      },
      {
        name: "mmproj-gemma-4-E4B-it-F16.gguf",
        url: resolve("unsloth/gemma-4-E4B-it-GGUF", "mmproj-F16.gguf"),
        sizeBytes: 99e7,
        role: "mmproj"
      }
    ]
  },
  {
    id: "ggml-org/SmolVLM2-2.2B-Instruct-GGUF",
    name: "SmolVLM2 2.2B",
    kind: "vision",
    org: "HuggingFaceTB",
    description: "Compact, fast vision-language model \u2014 great on modest RAM",
    params: 2.2,
    minRamGb: 6,
    quant: "Q4_K_M",
    releaseDate: "2025-04-21",
    files: [
      {
        name: "SmolVLM2-2.2B-Instruct-Q4_K_M.gguf",
        url: resolve("ggml-org/SmolVLM2-2.2B-Instruct-GGUF", "SmolVLM2-2.2B-Instruct-Q4_K_M.gguf"),
        sizeBytes: 111e7,
        role: "primary"
      },
      {
        name: "mmproj-SmolVLM2-2.2B-Instruct-f16.gguf",
        url: resolve(
          "ggml-org/SmolVLM2-2.2B-Instruct-GGUF",
          "mmproj-SmolVLM2-2.2B-Instruct-f16.gguf"
        ),
        sizeBytes: 87e7,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/Qwen3-VL-2B-Instruct-GGUF",
    name: "Qwen3-VL 2B",
    kind: "vision",
    org: "Qwen",
    description: "Small vision-language model \u2014 fast and capable",
    params: 2,
    minRamGb: 6,
    quant: "Q4_K_M",
    releaseDate: "2025-10-30",
    files: [
      {
        name: "Qwen3-VL-2B-Instruct-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3-VL-2B-Instruct-GGUF", "Qwen3-VL-2B-Instruct-Q4_K_M.gguf"),
        sizeBytes: 111e7,
        role: "primary"
      },
      {
        name: "mmproj-Qwen3-VL-2B-Instruct-F16.gguf",
        url: resolve("unsloth/Qwen3-VL-2B-Instruct-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 82e7,
        role: "mmproj"
      }
    ]
  },
  {
    id: "unsloth/Qwen3-VL-8B-Instruct-GGUF",
    name: "Qwen3-VL 8B",
    kind: "vision",
    org: "Qwen",
    description: "Stronger VLM \u2014 better detail + OCR; needs more RAM",
    params: 8,
    minRamGb: 10,
    quant: "Q4_K_M",
    releaseDate: "2025-10-30",
    files: [
      {
        name: "Qwen3-VL-8B-Instruct-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3-VL-8B-Instruct-GGUF", "Qwen3-VL-8B-Instruct-Q4_K_M.gguf"),
        sizeBytes: 503e7,
        role: "primary"
      },
      {
        name: "mmproj-Qwen3-VL-8B-Instruct-F16.gguf",
        url: resolve("unsloth/Qwen3-VL-8B-Instruct-GGUF", "mmproj-BF16.gguf"),
        sizeBytes: 116e7,
        role: "mmproj"
      }
    ]
  },
  {
    // The desktop vision-rail grounder (supervised computer use): reads a
    // screenshot and points at the control to act on. Qwen2.5-VL base,
    // Apache-2.0; GGUF + mmproj by mradermacher. ~6GB with the projector.
    id: "mradermacher/UI-TARS-1.5-7B-GGUF",
    name: "UI-TARS 1.5 7B",
    kind: "vision",
    org: "ByteDance",
    description: "GUI grounding for supervised computer use \u2014 points at the control to click",
    params: 7,
    minRamGb: 10,
    quant: "Q4_K_M",
    grounder: true,
    tags: ["Computer use"],
    releaseDate: "2025-04-17",
    files: [
      {
        name: "UI-TARS-1.5-7B.Q4_K_M.gguf",
        url: resolve("mradermacher/UI-TARS-1.5-7B-GGUF", "UI-TARS-1.5-7B.Q4_K_M.gguf"),
        sizeBytes: 4683073856,
        role: "primary"
      },
      {
        name: "UI-TARS-1.5-7B.mmproj-f16.gguf",
        url: resolve("mradermacher/UI-TARS-1.5-7B-GGUF", "UI-TARS-1.5-7B.mmproj-f16.gguf"),
        sizeBytes: 1354162880,
        role: "mmproj"
      }
    ]
  },
  // --- image generation — 2026 / fast few-step models only (open weight) ---
  {
    id: "leejet/Z-Image-Turbo-GGUF",
    name: "Z-Image Turbo (2026)",
    kind: "image",
    // NOT tagged 'Fast': despite the "Turbo" name this is a FLUX-class diffusion
    // transformer (DiT + Qwen3-4B text encoder + FLUX VAE) — heavy and slow on
    // Apple Silicon via ggml, not a few-step SDXL distill. 'Fast' is reserved for
    // models verified fast on-device (dreamshaper-turbo, realvis-lightning).
    tags: ["Recommended", "2026", "Top quality"],
    org: "Alibaba Tongyi",
    description: "Flagship 2026 model \u2014 1024px in ~8 steps, top quality-per-byte, strong bilingual text. Apache-2.0. (diffusion + Qwen3 encoder + VAE)",
    minRamGb: 12,
    imageModes: ["txt2img"],
    files: [
      {
        name: "z_image_turbo-Q4_K.gguf",
        url: resolve("leejet/Z-Image-Turbo-GGUF", "z_image_turbo-Q4_K.gguf"),
        role: "primary",
        sizeBytes: 386e7
      },
      {
        name: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: resolve("unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"),
        role: "aux",
        sizeBytes: 25e8
      },
      {
        name: "ae.safetensors",
        url: resolve("second-state/FLUX.1-schnell-GGUF", "ae.safetensors"),
        role: "aux",
        sizeBytes: 34e7
      }
    ]
  },
  // NOTE: MLX/mflux image models are PARKED (2026-06-23) — the only non-gated
  // on-device MLX LoRA options are too large to ship (Z-Image ~13GB 8-bit / ~33GB
  // bf16; FLUX.1-schnell 4-bit ~10GB). No MLX catalog entry is exposed. The
  // dormant runtime plumbing lives in src/main/mflux.ts (re-enable by repopulating
  // MFLUX_MODELS + restoring an entry here with runtime:'mflux').
  {
    id: "mzwing/SDXL-Lightning-GGUF",
    name: "SDXL Lightning (4-step)",
    kind: "image",
    tags: ["Recommended", "Fast"],
    org: "ByteDance",
    description: "Near-SDXL quality at 1024px in 4 steps (~7\xD7 faster). ~4GB model. Best balance \u2014 recommended.",
    minRamGb: 8,
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "sdxl_lightning_4step.q8_0.gguf",
        url: resolve("mzwing/SDXL-Lightning-GGUF", "sdxl_lightning_4step.q8_0.gguf"),
        role: "primary",
        sizeBytes: 4099e6
      }
    ]
  },
  {
    id: "OlegSkutte/sdxl-turbo-GGUF",
    name: "SDXL Turbo (fast drafts)",
    kind: "image",
    tags: ["Fastest", "Drafts"],
    org: "Stability AI",
    description: "Distilled SDXL \u2014 1-4 steps, ~10s drafts at 512px. Fastest option; lower fidelity.",
    minRamGb: 8,
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "sd_xl_turbo_1.0.q8_0.gguf",
        url: resolve("OlegSkutte/sdxl-turbo-GGUF", "sd_xl_turbo_1.0.q8_0.gguf"),
        role: "primary",
        sizeBytes: 41e8
      }
    ]
  },
  // SDXL finetunes — Off Grid GGUF builds (q8). The community GGUF quants of these
  // are mis-exported and won't load in sd.cpp, so we converted the official
  // OpenRAIL checkpoints ourselves (offgrid-ai HF org) → correct, ~4GB, on-device.
  {
    id: "offgrid-ai/realvisxl-v5.0-GGUF",
    name: "RealVisXL v5.0 (photoreal)",
    kind: "image",
    tags: ["High quality", "Photoreal"],
    org: "RealVis",
    description: "Top photorealism SDXL \u2014 Off Grid GGUF build of SG161222/RealVisXL_V5.0.",
    minRamGb: 8,
    quant: "Q8_0",
    releaseDate: "2024-08-05",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "realvisxl-v5.0-Q8_0.gguf",
        url: resolve("offgrid-ai/realvisxl-v5.0-GGUF", "realvisxl-v5.0-Q8_0.gguf"),
        role: "primary",
        sizeBytes: 418e7
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, runs on a 16GB Mac. Tagged 'Light'
    // so the RAM-aware default + "Recommended" badge pick it on <= 16GB machines.
    id: "offgrid-ai/realvisxl-v5.0-GGUF-Q4",
    name: "RealVisXL v5.0 (Light)",
    kind: "image",
    tags: ["Photoreal", "Light"],
    org: "RealVis",
    description: "Top photorealism SDXL. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of SG161222/RealVisXL_V5.0.",
    minRamGb: 8,
    quant: "Q4_K",
    releaseDate: "2024-08-05",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "realvisxl-v5.0-Q4_K.gguf",
        url: resolve("offgrid-ai/realvisxl-v5.0-GGUF", "realvisxl-v5.0-Q4_K.gguf"),
        role: "primary",
        sizeBytes: 28e8
      }
    ]
  },
  {
    id: "offgrid-ai/realvisxl-v5.0-lightning-GGUF",
    name: "RealVisXL v5.0 Lightning (photoreal)",
    kind: "image",
    // Full Q8: few-step, but ~4.2GB pegs a 16GB Mac — 'Fast' is reserved for the
    // Light (Q4) sibling that's both few-step AND memory-safe.
    tags: ["Photoreal"],
    org: "RealVis",
    description: "Photoreal SDXL, few-step (fast) \u2014 Off Grid GGUF build of SG161222/RealVisXL_V5.0_Lightning.",
    minRamGb: 8,
    quant: "Q8_0",
    releaseDate: "2024-09-02",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "realvisxl-v5.0-lightning-Q8_0.gguf",
        url: resolve(
          "offgrid-ai/realvisxl-v5.0-lightning-GGUF",
          "realvisxl-v5.0-lightning-Q8_0.gguf"
        ),
        role: "primary",
        sizeBytes: 418e7
      }
    ]
  },
  {
    // Light (Q4_K) sibling — few-step photoreal, ~35% less memory, 16GB-friendly.
    id: "offgrid-ai/realvisxl-v5.0-lightning-GGUF-Q4",
    name: "RealVisXL v5.0 Lightning (Light)",
    kind: "image",
    tags: ["Fast", "Photoreal", "Light"],
    org: "RealVis",
    description: "Photoreal SDXL, few-step (fast). Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of SG161222/RealVisXL_V5.0_Lightning.",
    minRamGb: 8,
    quant: "Q4_K",
    releaseDate: "2024-09-02",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "realvisxl-v5.0-lightning-Q4_K.gguf",
        url: resolve(
          "offgrid-ai/realvisxl-v5.0-lightning-GGUF",
          "realvisxl-v5.0-lightning-Q4_K.gguf"
        ),
        role: "primary",
        sizeBytes: 28e8
      }
    ]
  },
  {
    id: "offgrid-ai/dreamshaper-xl-v2-turbo-GGUF",
    name: "DreamShaper XL v2 Turbo (versatile)",
    kind: "image",
    // Full Q8: few-step, but ~4.2GB pegs a 16GB Mac — 'Fast' is reserved for the
    // Light (Q4) sibling that's both few-step AND memory-safe.
    tags: ["Versatile"],
    org: "Lykon",
    description: "The all-rounder \u2014 photoreal, art, fantasy, 3D. Off Grid GGUF build of Lykon/dreamshaper-xl-v2-turbo. Full Q8 quant (best quality); best on 24GB+ RAM.",
    minRamGb: 8,
    quant: "Q8_0",
    releaseDate: "2024-02-07",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "dreamshaper-xl-v2-turbo-Q8_0.gguf",
        url: resolve(
          "offgrid-ai/dreamshaper-xl-v2-turbo-GGUF",
          "dreamshaper-xl-v2-turbo-Q8_0.gguf"
        ),
        role: "primary",
        sizeBytes: 418e7
      }
    ]
  },
  {
    // Lighter Q4_K quant of the same distilled turbo model — ~35% less memory
    // (~3.08GB peak vs ~4.7GB), so it runs on a 16GB Mac without pegging unified
    // memory. Same repo, distinct id + filename so download/active-tracking treat
    // it as a separate installable model. Tagged 'Light' → the RAM-aware default +
    // "Recommended" badge pick it on machines with <= 16GB RAM.
    id: "offgrid-ai/dreamshaper-xl-v2-turbo-GGUF-Q4",
    name: "DreamShaper XL v2 Turbo (Light)",
    kind: "image",
    tags: ["Versatile", "Fast", "Light"],
    org: "Lykon",
    description: "The all-rounder \u2014 photoreal, art, fantasy, 3D. Q4 quant: ~35% less memory than the full model, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of Lykon/dreamshaper-xl-v2-turbo.",
    minRamGb: 8,
    quant: "Q4_K",
    releaseDate: "2024-02-07",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "dreamshaper-xl-v2-turbo-Q4_K.gguf",
        url: resolve(
          "offgrid-ai/dreamshaper-xl-v2-turbo-GGUF",
          "dreamshaper-xl-v2-turbo-Q4_K.gguf"
        ),
        role: "primary",
        sizeBytes: 28e8
      }
    ]
  },
  {
    id: "offgrid-ai/juggernaut-xl-v9-GGUF",
    name: "Juggernaut XL v9 (photoreal)",
    kind: "image",
    tags: ["High quality", "Photoreal"],
    org: "RunDiffusion",
    description: "Versatile photoreal SDXL \u2014 cinematic, portraits, landscapes. Off Grid GGUF build of RunDiffusion/Juggernaut-XL-v9.",
    minRamGb: 8,
    quant: "Q8_0",
    releaseDate: "2024-02-18",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "juggernaut-xl-v9-Q8_0.gguf",
        url: resolve("offgrid-ai/juggernaut-xl-v9-GGUF", "juggernaut-xl-v9-Q8_0.gguf"),
        role: "primary",
        sizeBytes: 435e7
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: "offgrid-ai/juggernaut-xl-v9-GGUF-Q4",
    name: "Juggernaut XL v9 (Light)",
    kind: "image",
    tags: ["Photoreal", "Light"],
    org: "RunDiffusion",
    description: "Versatile photoreal SDXL. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of RunDiffusion/Juggernaut-XL-v9.",
    minRamGb: 8,
    quant: "Q4_K",
    releaseDate: "2024-02-18",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "juggernaut-xl-v9-Q4_K.gguf",
        url: resolve("offgrid-ai/juggernaut-xl-v9-GGUF", "juggernaut-xl-v9-Q4_K.gguf"),
        role: "primary",
        sizeBytes: 29e8
      }
    ]
  },
  {
    id: "offgrid-ai/animagine-xl-4.0-GGUF",
    name: "Animagine XL 4.0 (anime)",
    kind: "image",
    tags: ["High quality", "Anime"],
    org: "Cagliostro",
    description: "Leading anime SDXL \u2014 strong character knowledge. Off Grid GGUF build of cagliostrolab/animagine-xl-4.0.",
    minRamGb: 8,
    quant: "Q8_0",
    releaseDate: "2025-01-10",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "animagine-xl-4.0-Q8_0.gguf",
        url: resolve("offgrid-ai/animagine-xl-4.0-GGUF", "animagine-xl-4.0-Q8_0.gguf"),
        role: "primary",
        sizeBytes: 418e7
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: "offgrid-ai/animagine-xl-4.0-GGUF-Q4",
    name: "Animagine XL 4.0 (Light)",
    kind: "image",
    tags: ["Anime", "Light"],
    org: "Cagliostro",
    description: "Leading anime SDXL \u2014 strong character knowledge. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of cagliostrolab/animagine-xl-4.0.",
    minRamGb: 8,
    quant: "Q4_K",
    releaseDate: "2025-01-10",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "animagine-xl-4.0-Q4_K.gguf",
        url: resolve("offgrid-ai/animagine-xl-4.0-GGUF", "animagine-xl-4.0-Q4_K.gguf"),
        role: "primary",
        sizeBytes: 28e8
      }
    ]
  },
  {
    id: "offgrid-ai/illustrious-xl-v2.0-GGUF",
    name: "Illustrious XL v2.0 (anime)",
    kind: "image",
    tags: ["High quality", "Anime"],
    org: "OnomaAI",
    description: "Top anime / illustration SDXL base. Off Grid GGUF build of OnomaAIResearch/Illustrious-XL-v2.0.",
    minRamGb: 8,
    quant: "Q8_0",
    releaseDate: "2025-04-18",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "illustrious-xl-v2.0-Q8_0.gguf",
        url: resolve("offgrid-ai/illustrious-xl-v2.0-GGUF", "illustrious-xl-v2.0-Q8_0.gguf"),
        role: "primary",
        sizeBytes: 418e7
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: "offgrid-ai/illustrious-xl-v2.0-GGUF-Q4",
    name: "Illustrious XL v2.0 (Light)",
    kind: "image",
    tags: ["Anime", "Light"],
    org: "OnomaAI",
    description: "Top anime / illustration SDXL base. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of OnomaAIResearch/Illustrious-XL-v2.0.",
    minRamGb: 8,
    quant: "Q4_K",
    releaseDate: "2025-04-18",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "illustrious-xl-v2.0-Q4_K.gguf",
        url: resolve("offgrid-ai/illustrious-xl-v2.0-GGUF", "illustrious-xl-v2.0-Q4_K.gguf"),
        role: "primary",
        sizeBytes: 28e8
      }
    ]
  },
  {
    id: "offgrid-ai/pony-diffusion-v6-xl-GGUF",
    name: "Pony Diffusion V6 XL (stylized)",
    kind: "image",
    tags: ["High quality", "Stylized"],
    org: "PurpleSmartAI",
    description: "Dominant SDXL for stylized characters & illustration; highly promptable. Off Grid GGUF build of Pony Diffusion V6 XL.",
    minRamGb: 8,
    quant: "Q8_0",
    releaseDate: "2024-05-25",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "pony-diffusion-v6-xl-Q8_0.gguf",
        url: resolve("offgrid-ai/pony-diffusion-v6-xl-GGUF", "pony-diffusion-v6-xl-Q8_0.gguf"),
        role: "primary",
        sizeBytes: 418e7
      }
    ]
  },
  {
    // Light (Q4_K) sibling — ~35% less memory, 16GB-friendly.
    id: "offgrid-ai/pony-diffusion-v6-xl-GGUF-Q4",
    name: "Pony Diffusion V6 XL (Light)",
    kind: "image",
    tags: ["Stylized", "Light"],
    org: "PurpleSmartAI",
    description: "Dominant SDXL for stylized characters & illustration. Q4 quant: ~35% less memory, small quality trade-off. Runs on a 16GB Mac. Off Grid GGUF build of Pony Diffusion V6 XL.",
    minRamGb: 8,
    quant: "Q4_K",
    releaseDate: "2024-05-25",
    imageModes: ["txt2img", "img2img"],
    files: [
      {
        name: "pony-diffusion-v6-xl-Q4_K.gguf",
        url: resolve("offgrid-ai/pony-diffusion-v6-xl-GGUF", "pony-diffusion-v6-xl-Q4_K.gguf"),
        role: "primary",
        sizeBytes: 28e8
      }
    ]
  },
  // --- voice (TTS); open models, ONNX runtime (no Python) ---
  {
    id: "onnx-community/Kokoro-82M-v1.0-ONNX",
    name: "Kokoro TTS 82M",
    kind: "voice",
    org: "hexgrad",
    description: "Lightweight, natural text-to-speech (ONNX); great default",
    minRamGb: 3,
    files: [
      {
        name: "kokoro-82m-v1.0.onnx",
        url: resolve("onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model_quantized.onnx"),
        role: "primary",
        sizeBytes: 92361116
      }
    ]
  },
  {
    id: "rhasspy/piper-voices/en_US-lessac-medium",
    name: "Piper - Lessac (English)",
    kind: "voice",
    org: "rhasspy",
    description: "Fast multi-voice text-to-speech (ONNX); many languages available",
    minRamGb: 2,
    files: [
      {
        name: "en_US-lessac-medium.onnx",
        url: resolve("rhasspy/piper-voices", "en/en_US/lessac/medium/en_US-lessac-medium.onnx"),
        role: "primary",
        sizeBytes: 63201294
      },
      {
        name: "en_US-lessac-medium.onnx.json",
        url: resolve(
          "rhasspy/piper-voices",
          "en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
        ),
        role: "aux"
      }
    ]
  },
  // --- transcription (STT / whisper); all from ggerganov/whisper.cpp (ggml .bin) ---
  {
    id: "ggerganov/whisper.cpp/tiny",
    name: "Whisper Tiny",
    kind: "transcription",
    org: "ggerganov",
    description: "Fastest, smallest \u2014 lowest accuracy",
    minRamGb: 2,
    files: [
      {
        name: "ggml-tiny.bin",
        url: resolve("ggerganov/whisper.cpp", "ggml-tiny.bin"),
        role: "primary",
        sizeBytes: 777e5
      }
    ]
  },
  {
    id: "ggerganov/whisper.cpp/base",
    name: "Whisper Base",
    kind: "transcription",
    org: "ggerganov",
    description: "Offline speech-to-text (base) \u2014 good speed/quality default",
    minRamGb: 3,
    files: [
      {
        name: "ggml-base.bin",
        url: resolve("ggerganov/whisper.cpp", "ggml-base.bin"),
        role: "primary",
        sizeBytes: 147951e3
      }
    ]
  },
  {
    id: "ggerganov/whisper.cpp/small",
    name: "Whisper Small",
    kind: "transcription",
    org: "ggerganov",
    description: "Offline speech-to-text (higher accuracy)",
    minRamGb: 4,
    files: [
      {
        name: "ggml-small.bin",
        url: resolve("ggerganov/whisper.cpp", "ggml-small.bin"),
        role: "primary",
        sizeBytes: 487601e3
      }
    ]
  },
  {
    id: "ggerganov/whisper.cpp/medium",
    name: "Whisper Medium",
    kind: "transcription",
    org: "ggerganov",
    description: "High accuracy; slower",
    minRamGb: 6,
    files: [
      {
        name: "ggml-medium.bin",
        url: resolve("ggerganov/whisper.cpp", "ggml-medium.bin"),
        role: "primary",
        sizeBytes: 1533e6
      }
    ]
  },
  {
    id: "ggerganov/whisper.cpp/large-v3-turbo",
    name: "Whisper Large v3 Turbo",
    kind: "transcription",
    org: "ggerganov",
    description: "Near-large accuracy, much faster \u2014 recommended",
    minRamGb: 6,
    files: [
      {
        name: "ggml-large-v3-turbo.bin",
        url: resolve("ggerganov/whisper.cpp", "ggml-large-v3-turbo.bin"),
        role: "primary",
        sizeBytes: 1624e6
      }
    ]
  },
  {
    id: "ggerganov/whisper.cpp/large-v3",
    name: "Whisper Large v3",
    kind: "transcription",
    org: "ggerganov",
    description: "Highest accuracy (large); needs more RAM",
    minRamGb: 8,
    files: [
      {
        name: "ggml-large-v3.bin",
        url: resolve("ggerganov/whisper.cpp", "ggml-large-v3.bin"),
        role: "primary",
        sizeBytes: 3095e6
      }
    ]
  },
  // --- transcription (Parakeet, NVIDIA NeMo) — sherpa-onnx offline transducer (ONNX).
  // A model is 4 files (encoder/decoder/joiner/tokens); on-disk names are slug-prefixed
  // so multiple Parakeet models coexist in the flat models dir without colliding. Higher
  // accuracy than whisper; served by the bundled sherpa-onnx CLI (engine: 'parakeet'). ---
  {
    id: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    name: "Parakeet TDT 0.6B v2",
    kind: "transcription",
    engine: "parakeet",
    org: "nvidia",
    description: "High-accuracy English STT (int8) - tops the open ASR leaderboard",
    minRamGb: 4,
    tags: ["Accurate", "English"],
    files: [
      {
        name: "parakeet-v2.encoder.int8.onnx",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "encoder.int8.onnx"),
        role: "primary",
        sizeBytes: 652e6
      },
      {
        name: "parakeet-v2.decoder.int8.onnx",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "decoder.int8.onnx"),
        role: "aux",
        sizeBytes: 726e4
      },
      {
        name: "parakeet-v2.joiner.int8.onnx",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "joiner.int8.onnx"),
        role: "aux",
        sizeBytes: 174e4
      },
      {
        name: "parakeet-v2.tokens.txt",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "tokens.txt"),
        role: "tokenizer",
        sizeBytes: 9600
      }
    ]
  },
  {
    id: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    name: "Parakeet TDT 0.6B v3",
    kind: "transcription",
    engine: "parakeet",
    org: "nvidia",
    description: "Multilingual STT (int8) - 25 European languages",
    minRamGb: 4,
    isNew: true,
    tags: ["Accurate", "Multilingual"],
    files: [
      {
        name: "parakeet-v3.encoder.int8.onnx",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"),
        role: "primary",
        sizeBytes: 652e6
      },
      {
        name: "parakeet-v3.decoder.int8.onnx",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx"),
        role: "aux",
        sizeBytes: 726e4
      },
      {
        name: "parakeet-v3.joiner.int8.onnx",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx"),
        role: "aux",
        sizeBytes: 174e4
      },
      {
        name: "parakeet-v3.tokens.txt",
        url: resolve("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "tokens.txt"),
        role: "tokenizer",
        sizeBytes: 9600
      }
    ]
  }
];
var CATALOG = RAW_CATALOG.map((e) => ({
  ...e,
  kind: deriveKind(e.files, e.kind)
}));
function modelsByKind(kind) {
  return CATALOG.filter((m) => m.kind === kind);
}
var GROUNDER_NAME = /ui[-_ ]?tars|holo(?:1|-|_| )|gui[-_ ]?owl|aguvis|show[-_ ]?ui|cogagent|os[-_ ]?atlas|ferret[-_ ]?ui|seeclick/i;
function isGrounderModel(idOrName, catalog = CATALOG) {
  const entry = catalog.find((m) => m.id === idOrName || m.name === idOrName);
  if (entry) {
    return entry.grounder === true;
  }
  return GROUNDER_NAME.test(idOrName);
}
var MODEL_KINDS = ["text", "vision", "image", "voice", "transcription"];

// src/download.ts
var ModelDownloader = class {
  constructor(bridge, store) {
    this.bridge = bridge;
    this.store = store;
  }
  bridge;
  store;
  aborts = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  onProgress(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  isInstalled(modelId) {
    return this.store.isInstalled(modelId);
  }
  cancel(modelId) {
    this.aborts.get(modelId)?.abort();
  }
  emit(p) {
    for (const l of this.listeners) l(p);
  }
  async download(entry) {
    const controller = new AbortController();
    this.aborts.set(entry.id, controller);
    const totalKnown = entry.files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
    let basePrev = 0;
    try {
      for (const file of entry.files) {
        const dest = this.bridge.pathFor(file.name);
        if (await this.bridge.exists(dest, file.sizeBytes)) {
          basePrev += file.sizeBytes ?? 0;
          continue;
        }
        await this.bridge.download(file.url, dest, {
          signal: controller.signal,
          onProgress: (written, total) => {
            const totalBytes = totalKnown || basePrev + total;
            const bytesDownloaded = basePrev + written;
            this.emit({
              modelId: entry.id,
              status: "downloading",
              bytesDownloaded,
              totalBytes,
              progress: totalBytes ? Math.min(1, bytesDownloaded / totalBytes) : 0,
              currentFile: file.name
            });
          }
        });
        basePrev += file.sizeBytes ?? 0;
      }
      this.store.markInstalled(entry);
      this.emit({
        modelId: entry.id,
        status: "completed",
        progress: 1,
        bytesDownloaded: totalKnown,
        totalBytes: totalKnown
      });
      return true;
    } catch (err) {
      const aborted = controller.signal.aborted;
      this.emit({
        modelId: entry.id,
        status: aborted ? "paused" : "failed",
        progress: 0,
        bytesDownloaded: 0,
        totalBytes: totalKnown,
        error: aborted ? void 0 : err instanceof Error ? err.message : String(err)
      });
      return false;
    } finally {
      this.aborts.delete(entry.id);
    }
  }
};

// src/quant.ts
var QUANTIZATION_INFO = {
  Q2_K: {
    bitsPerWeight: 2.625,
    quality: "Low",
    description: "Extreme compression, noticeable quality loss",
    recommended: false
  },
  Q3_K_S: {
    bitsPerWeight: 3.4375,
    quality: "Low-Medium",
    description: "High compression, some quality loss",
    recommended: false
  },
  Q3_K_M: {
    bitsPerWeight: 3.4375,
    quality: "Medium",
    description: "Good compression with acceptable quality",
    recommended: false
  },
  Q4_0: {
    bitsPerWeight: 4,
    quality: "Medium",
    description: "Basic 4-bit quantization",
    recommended: false
  },
  Q4_K_S: {
    bitsPerWeight: 4.5,
    quality: "Medium-Good",
    description: "Good balance of size and quality",
    recommended: true
  },
  Q4_K_M: {
    bitsPerWeight: 4.5,
    quality: "Good",
    description: "Optimal balance - best for most devices",
    recommended: true
  },
  Q5_K_S: {
    bitsPerWeight: 5.5,
    quality: "Good-High",
    description: "Higher quality, larger size",
    recommended: false
  },
  Q5_K_M: {
    bitsPerWeight: 5.5,
    quality: "High",
    description: "Near original quality",
    recommended: false
  },
  Q6_K: {
    bitsPerWeight: 6.5,
    quality: "Very High",
    description: "Minimal quality loss",
    recommended: false
  },
  Q8_0: {
    bitsPerWeight: 8,
    quality: "Excellent",
    description: "Best quality, largest size",
    recommended: false
  }
};
function extractQuantization(fileName) {
  const upper = fileName.toUpperCase();
  for (const quant of Object.keys(QUANTIZATION_INFO)) {
    if (upper.includes(quant.replace("_", "")) || upper.includes(quant)) return quant;
  }
  const match = fileName.match(/[QqFf]\d+[_]?[KkMmSs]*/);
  return match ? match[0].toUpperCase() : "Unknown";
}
function isMMProjFile(fileName) {
  const lower = fileName.toLowerCase();
  return lower.includes("mmproj") || lower.includes("projector") || lower.includes("clip") && lower.endsWith(".gguf");
}
function formatFileSize(bytes) {
  if (!bytes) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// src/credibility.ts
var OFFGRID_AUTHORS = ["offgrid-ai", "offgrid"];
var OFFICIAL_MODEL_AUTHORS = {
  "meta-llama": "Meta",
  microsoft: "Microsoft",
  google: "Google",
  Qwen: "Alibaba",
  mistralai: "Mistral AI",
  HuggingFaceTB: "Hugging Face",
  HuggingFaceH4: "Hugging Face",
  bigscience: "BigScience",
  EleutherAI: "EleutherAI",
  tiiuae: "TII UAE",
  stabilityai: "Stability AI",
  databricks: "Databricks",
  THUDM: "Tsinghua University",
  "baichuan-inc": "Baichuan",
  internlm: "InternLM",
  "01-ai": "01.AI",
  "deepseek-ai": "DeepSeek",
  CohereForAI: "Cohere",
  allenai: "Allen AI",
  nvidia: "NVIDIA",
  apple: "Apple"
};
var VERIFIED_QUANTIZERS = {
  TheBloke: "TheBloke",
  bartowski: "bartowski",
  QuantFactory: "QuantFactory",
  mradermacher: "mradermacher",
  "second-state": "Second State",
  MaziyarPanahi: "Maziyar Panahi",
  Triangle104: "Triangle104",
  unsloth: "Unsloth",
  "ggml-org": "GGML (HuggingFace)",
  ggerganov: "Georgi Gerganov",
  // Strong community quantizers (formerly badged separately) — trusted GGUFs.
  "lmstudio-community": "Community GGUF",
  "lmstudio-ai": "Community GGUF"
};
var CREDIBILITY_LABELS = {
  offgrid: {
    label: "Off Grid",
    description: "Curated & converted by Off Grid \u2014 verified to run on-device",
    color: "#34D399"
  },
  official: { label: "Official", description: "From the original model creator", color: "#22C55E" },
  "verified-quantizer": {
    label: "Verified",
    description: "From a trusted quantization provider",
    color: "#A78BFA"
  },
  community: { label: "Community", description: "Community contributed model", color: "#64748B" }
};
function determineCredibility(author) {
  if (OFFGRID_AUTHORS.includes(author)) return "offgrid";
  if (author in OFFICIAL_MODEL_AUTHORS) return "official";
  if (author in VERIFIED_QUANTIZERS) return "verified-quantizer";
  return "community";
}

// src/filters.ts
var initialFilterState = {
  orgs: [],
  type: "all",
  source: "all",
  size: "all",
  quant: "all",
  sort: "recommended"
};
var SIZE_OPTIONS = [
  { key: "tiny", label: "Tiny (<2B)", min: 0, max: 2 },
  { key: "small", label: "Small (2-5B)", min: 2, max: 5 },
  { key: "medium", label: "Medium (5-15B)", min: 5, max: 15 },
  { key: "large", label: "Large (15B+)", min: 15, max: Infinity }
];
var MODEL_TYPE_OPTIONS = [
  { key: "text", label: "Text" },
  { key: "vision", label: "Vision" },
  { key: "code", label: "Code" },
  { key: "image-gen", label: "Image" }
];
var CREDIBILITY_OPTIONS = [
  { key: "offgrid", label: "Off Grid" },
  { key: "official", label: "Official" },
  { key: "verified-quantizer", label: "Verified" },
  { key: "community", label: "Community" }
];
var SORT_OPTIONS = [
  { key: "recommended", label: "Recommended" },
  { key: "bestfit", label: "Best fit" },
  { key: "downloads", label: "Downloads" },
  { key: "size", label: "Size" },
  { key: "recency", label: "Recent" }
];
var PARAM_RE = /\b(\d+(?:\.\d+)?)\s?([BbMm])\b/;
function parseParamCount(nameOrId) {
  const m = PARAM_RE.exec(nameOrId);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return /[Mm]/.test(m[2]) ? n / 1e3 : n;
}
function getModelType(name, tags = []) {
  const n = name.toLowerCase();
  const t = tags.map((x) => x.toLowerCase());
  if (t.some(
    (x) => x.includes("diffusion") || x.includes("text-to-image") || x.includes("image-generation") || x.includes("diffusers")
  ) || n.includes("stable-diffusion") || n.includes("sd-") || n.includes("sdxl") || n.includes("flux"))
    return "image-gen";
  if (t.some((x) => x.includes("vision") || x.includes("multimodal") || x.includes("image-text")) || n.includes("vision") || n.includes("vlm") || n.includes("-vl") || n.includes("llava"))
    return "vision";
  if (t.some((x) => x.includes("code")) || n.includes("code") || n.includes("coder")) return "code";
  return "text";
}
function bestFitScore(m, ramGb) {
  const params = m.params ?? parseParamCount(m.name) ?? parseParamCount(m.id) ?? 0;
  const minRam = m.minRamGb ?? params * 0.75;
  const ratio = ramGb ? minRam / ramGb : 0;
  const penalty = ratio > 0.75 ? (ratio - 0.75) * 4 : 0;
  return Math.abs(ratio - 0.4) + penalty;
}
function hasActiveFilters(state) {
  return state.orgs.length > 0 || state.type !== "all" || state.source !== "all" || state.size !== "all" || state.quant !== "all";
}
function applyFilters(models, state) {
  return models.filter((m) => {
    if (state.source !== "all" && m.credibility !== state.source) return false;
    if (state.type !== "all" && getModelType(m.name, m.tags) !== state.type) return false;
    if (state.orgs.length > 0 && !state.orgs.includes(m.org)) return false;
    if (state.size !== "all") {
      const p = m.params ?? parseParamCount(m.name) ?? parseParamCount(m.id);
      const opt = SIZE_OPTIONS.find((s) => s.key === state.size);
      if (opt && (p == null || p < opt.min || p >= opt.max)) return false;
    }
    if (state.quant !== "all" && m.files && m.files.length > 0) {
      if (!m.files.some((f) => f.quant === state.quant)) return false;
    }
    return true;
  });
}
function applySort(models, sort, ramGb = 0) {
  if (sort === "recommended") return models;
  const arr = [...models];
  const p = (m) => m.params ?? parseParamCount(m.name) ?? 0;
  switch (sort) {
    case "bestfit":
      return arr.sort((a, b) => bestFitScore(a, ramGb) - bestFitScore(b, ramGb));
    case "size":
      return arr.sort((a, b) => p(a) - p(b));
    case "downloads":
      return arr.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
    case "recency":
      return arr.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
    default:
      return arr;
  }
}
function filterAndSort(models, state, ramGb = 0) {
  return applySort(applyFilters(models, state), state.sort, ramGb);
}

// src/hf.ts
var KIND_PIPELINE = {
  text: "text-generation",
  vision: "image-text-to-text",
  image: "text-to-image",
  voice: "text-to-speech",
  transcription: "automatic-speech-recognition"
};
var GGUF_KINDS = /* @__PURE__ */ new Set(["text", "vision", "image"]);
var HF2 = "https://huggingface.co";
var HF_API = "https://huggingface.co/api";
var defaultFetch = (url, init) => fetch(url, init);
var isMmproj = (name) => /mmproj|clip/i.test(name);
var baseName = (p) => p.split("/").pop() ?? p;
async function searchHuggingFace(query, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const kind = opts.kind;
  const params = new URLSearchParams({
    sort: opts.sort ?? "downloads",
    direction: "-1",
    // Over-fetch so post-filtering by detected type still leaves a full page.
    limit: String((opts.limit ?? 30) * 2)
  });
  if (!kind || GGUF_KINDS.has(kind)) params.set("filter", "gguf");
  else if (kind) params.set("pipeline_tag", KIND_PIPELINE[kind]);
  if (query) params.set("search", query);
  const res = await fetchImpl(`${HF_API}/models?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`Hugging Face search failed: HTTP ${res.status}`);
  const data = await res.json();
  let out = data.map((m) => {
    const id = m.id ?? m.modelId ?? "";
    const org = id.split("/")[0] ?? "";
    return {
      id,
      name: baseName(id),
      org,
      downloads: m.downloads,
      likes: m.likes,
      lastModified: m.lastModified,
      credibility: determineCredibility(org)
    };
  });
  if (kind === "text")
    out = out.filter((m) => {
      const t = getModelType(m.name);
      return t === "text" || t === "code";
    });
  else if (kind === "vision") out = out.filter((m) => getModelType(m.name) === "vision");
  else if (kind === "image") out = out.filter((m) => getModelType(m.name) === "image-gen");
  return out.slice(0, opts.limit ?? 30);
}
async function getModelFiles(repoId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const res = await fetchImpl(`${HF_API}/models/${repoId}`, {
    headers: { Accept: "application/json" }
  });
  if (!res.ok) return [];
  const data = await res.json();
  const gguf = (data.siblings ?? []).filter((f) => f.rfilename.endsWith(".gguf"));
  const mmprojFiles = gguf.filter((f) => isMMProjFile(f.rfilename));
  const weights = gguf.filter((f) => !isMMProjFile(f.rfilename));
  const url = (rf) => `${HF2}/${repoId}/resolve/main/${rf}`;
  const matchMmproj = (weightName) => {
    if (mmprojFiles.length === 0) return void 0;
    const wq = extractQuantization(weightName);
    const exact = wq !== "Unknown" ? mmprojFiles.find((f) => extractQuantization(f.rfilename) === wq) : void 0;
    const f16 = mmprojFiles.find((f) => {
      const l = f.rfilename.toLowerCase();
      return (l.includes("f16") || l.includes("fp16")) && !l.includes("bf16");
    });
    const pick = exact ?? f16 ?? mmprojFiles[0];
    return { fileName: baseName(pick.rfilename), url: url(pick.rfilename), sizeBytes: pick.size };
  };
  return weights.map((f) => {
    const quant = extractQuantization(f.rfilename);
    const info = QUANTIZATION_INFO[quant];
    return {
      fileName: baseName(f.rfilename),
      quant,
      quality: info?.quality ?? "Unknown",
      recommended: info?.recommended ?? false,
      sizeBytes: f.size ?? 0,
      downloadUrl: url(f.rfilename),
      mmproj: matchMmproj(f.rfilename)
    };
  }).sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.sizeBytes - b.sizeBytes);
}
async function resolveHuggingFaceModel(repoId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const res = await fetchImpl(`${HF_API}/models/${repoId}`, {
    headers: { Accept: "application/json" }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const siblings = data.siblings ?? [];
  const url = (rf) => `${HF2}/${repoId}/resolve/main/${rf}`;
  const org = repoId.split("/")[0];
  const ggml = siblings.filter((f) => /ggml.*\.bin$/i.test(f.rfilename));
  if (ggml.length > 0) {
    const pick = ggml.find((f) => /ggml-base\.bin$/i.test(f.rfilename)) ?? [...ggml].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0];
    return {
      id: repoId,
      name: baseName(repoId),
      kind: "transcription",
      org,
      files: [
        {
          name: baseName(pick.rfilename),
          url: url(pick.rfilename),
          sizeBytes: pick.size,
          role: "primary"
        }
      ]
    };
  }
  const onnx = siblings.filter((f) => /\.onnx$/i.test(f.rfilename));
  if (onnx.length > 0 && siblings.every((f) => !f.rfilename.endsWith(".gguf"))) {
    const pick = onnx.find((f) => /quant/i.test(f.rfilename)) ?? onnx[0];
    const files2 = [
      {
        name: baseName(pick.rfilename),
        url: url(pick.rfilename),
        sizeBytes: pick.size,
        role: "primary"
      }
    ];
    const cfg = siblings.find((f) => f.rfilename === `${pick.rfilename}.json`);
    if (cfg)
      files2.push({
        name: baseName(cfg.rfilename),
        url: url(cfg.rfilename),
        sizeBytes: cfg.size,
        role: "aux"
      });
    return { id: repoId, name: baseName(repoId), kind: "voice", org, files: files2 };
  }
  const gguf = siblings.filter((f) => f.rfilename.endsWith(".gguf"));
  if (gguf.length === 0) return null;
  const weights = gguf.filter((f) => !isMmproj(f.rfilename));
  const mmprojFiles = gguf.filter((f) => isMmproj(f.rfilename));
  const primary = weights.find((f) => /q4_k_m/i.test(f.rfilename)) ?? weights[0] ?? gguf[0];
  if (!primary) return null;
  const files = [
    {
      name: baseName(primary.rfilename),
      url: url(primary.rfilename),
      sizeBytes: primary.size,
      role: "primary"
    }
  ];
  if (mmprojFiles[0]) {
    files.push({
      name: baseName(mmprojFiles[0].rfilename),
      url: url(mmprojFiles[0].rfilename),
      sizeBytes: mmprojFiles[0].size,
      role: "mmproj"
    });
  }
  return {
    id: repoId,
    name: baseName(repoId),
    // Same data-derived rule as the curated catalog: a projector ⇒ vision.
    kind: deriveKind(files, opts.kind ?? "text"),
    org,
    files
  };
}

// src/providers.ts
var defaultFetch2 = (url, init) => fetch(url, init);
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
async function* lines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) yield line;
  }
  if (buf.trim()) yield buf;
}
function openAICompatibleProvider(cfg) {
  const f = cfg.fetchImpl ?? defaultFetch2;
  return {
    id: cfg.id,
    name: cfg.name,
    async listModels() {
      const res = await f(`${cfg.endpoint}/models`, {
        headers: { Accept: "application/json", ...authHeaders(cfg.apiKey) }
      });
      if (!res.ok) throw new Error(`listModels failed: HTTP ${res.status}`);
      const data = await res.json();
      return (data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
    },
    async *chat(messages, opts) {
      const res = await f(`${cfg.endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(cfg.apiKey) },
        body: JSON.stringify({
          model: opts?.model,
          messages,
          stream: true,
          temperature: opts?.temperature,
          max_tokens: opts?.maxTokens
        }),
        signal: opts?.signal
      });
      if (!res.ok || !res.body) throw new Error(`chat failed: HTTP ${res.status}`);
      for await (const line of lines(res.body)) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const j = JSON.parse(data);
          const c = j.choices?.[0]?.delta?.content;
          if (c) yield c;
        } catch {
        }
      }
    }
  };
}
function ollamaProvider(cfg) {
  const f = cfg.fetchImpl ?? defaultFetch2;
  return {
    id: cfg.id,
    name: cfg.name,
    async listModels() {
      const res = await f(`${cfg.endpoint}/api/tags`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`listModels failed: HTTP ${res.status}`);
      const data = await res.json();
      return (data.models ?? []).map((m) => ({ id: m.name, name: m.name }));
    },
    async *chat(messages, opts) {
      const res = await f(`${cfg.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: opts?.model, messages, stream: true }),
        signal: opts?.signal
      });
      if (!res.ok || !res.body) throw new Error(`chat failed: HTTP ${res.status}`);
      for await (const line of lines(res.body)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (j.message?.content) yield j.message.content;
          if (j.done) return;
        } catch {
        }
      }
    }
  };
}
function createProvider(server, fetchImpl) {
  if (server.kind === "ollama") {
    return ollamaProvider({
      id: server.id,
      name: server.name,
      endpoint: server.endpoint,
      fetchImpl
    });
  }
  return openAICompatibleProvider({
    id: server.id,
    name: server.name,
    endpoint: server.endpoint,
    apiKey: server.apiKey,
    fetchImpl
  });
}
var ProviderRegistry = class {
  providers = /* @__PURE__ */ new Map();
  activeId = null;
  register(provider) {
    this.providers.set(provider.id, provider);
    if (!this.activeId) this.activeId = provider.id;
  }
  unregister(id) {
    this.providers.delete(id);
    if (this.activeId === id) this.activeId = this.providers.keys().next().value ?? null;
  }
  list() {
    return [...this.providers.values()];
  }
  setActive(id) {
    if (this.providers.has(id)) this.activeId = id;
  }
  active() {
    return this.activeId ? this.providers.get(this.activeId) ?? null : null;
  }
};

// src/imagegen.ts
function supportsMode(provider, mode) {
  return provider.modes.includes(mode);
}
function validateImageGenRequest(provider, req) {
  if (!supportsMode(provider, req.mode)) return `provider does not support ${req.mode}`;
  if (req.mode === "img2img" && !req.initImage) return "img2img requires an initImage";
  if (!req.prompt.trim()) return "prompt is required";
  return null;
}

// src/recommend-image.ts
var LIGHT_MODEL_RAM_CEILING_GB = 16;
var hasLightTag = (m) => (m.tags ?? []).some((t) => /^light$/i.test(t));
var isVersatile = (m) => (m.tags ?? []).some((t) => /^versatile$/i.test(t));
var pickVersatileFirst = (candidates) => candidates.find(isVersatile) ?? candidates[0];
var familyKey = (m) => m.id.replace(/-Q\d[\w]*$/i, "");
function recommendedImageModelId(models, ramGb) {
  if (!ramGb || !Number.isFinite(ramGb)) return null;
  const images = models.filter((m) => m.kind === "image");
  if (!images.length) return null;
  const light = images.filter(hasLightTag);
  const lightFamilies = new Set(light.map(familyKey));
  const fullOfLightFamily = images.filter((m) => !hasLightTag(m) && lightFamilies.has(familyKey(m)));
  if (ramGb <= LIGHT_MODEL_RAM_CEILING_GB) {
    return (pickVersatileFirst(light) ?? images[0]).id;
  }
  return (pickVersatileFirst(fullOfLightFamily) ?? images.find((m) => !hasLightTag(m)) ?? images[0]).id;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CATALOG,
  CREDIBILITY_LABELS,
  CREDIBILITY_OPTIONS,
  LIGHT_MODEL_RAM_CEILING_GB,
  MODEL_KINDS,
  MODEL_TYPE_OPTIONS,
  ModelDownloader,
  OFFICIAL_MODEL_AUTHORS,
  ProviderRegistry,
  QUANTIZATION_INFO,
  RECOMMENDATION_TIERS,
  SIZE_OPTIONS,
  SORT_OPTIONS,
  VERIFIED_QUANTIZERS,
  applyFilters,
  applySort,
  bestFitScore,
  createProvider,
  deriveKind,
  determineCredibility,
  extractQuantization,
  filterAndSort,
  formatFileSize,
  getModelFiles,
  getModelType,
  hasActiveFilters,
  hasVisionProjector,
  initialFilterState,
  isGrounderModel,
  isMMProjFile,
  modelsByKind,
  ollamaProvider,
  openAICompatibleProvider,
  parseParamCount,
  recommendForRam,
  recommendedImageModelId,
  resolveHuggingFaceModel,
  searchHuggingFace,
  supportsMode,
  validateImageGenRequest
});
