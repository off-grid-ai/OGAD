#!/usr/bin/env bash
# One-time batch: generate on-device style-preset thumbnails with SDXL-Lightning.
# Runs sd-cli once per style (model reloads each time, but no LLM is resident so
# it's freeze-safe on 16GB). No --vae-tiling (that forced a 69s tiled VAE decode).
set -u
ROOT="/Users/user/wednesday/off-grid-ai/desktop"
MODELS="$HOME/Library/Application Support/Off Grid AI Desktop/models"
THUMBS="$HOME/Library/Application Support/Off Grid AI Desktop/style-thumbs"
SD="$ROOT/resources/bin/sd/sd-cli"
MODEL="$MODELS/sdxl_lightning_4step.q8_0.gguf"
NEG="lowres, blurry, deformed, watermark, text, low quality"
mkdir -p "$THUMBS"

# Keep the LLM dead so the image model has the RAM to itself.
pkill -f "sd/sd-server" 2>/dev/null
pkill -f "llama/llama-server" 2>/dev/null
sleep 2

# key|prompt  (key matches the renderer's styleKey sanitization)
# Each style gets a DIFFERENT subject (landscape / animal / object / vehicle /
# architecture) so the grid showcases the *style*, not a gallery of faces.
STYLES=(
  "Photoreal|a red fox standing in a misty forest, photorealistic, sharp focus, high detail, 50mm photo"
  "Cinematic|a lone car on a coastal highway at sunset, cinematic film still, dramatic lighting, shallow depth of field, color graded"
  "Anime|a bustling futuristic city street with cherry blossoms, anime illustration, clean lineart, vibrant colors"
  "Sketch|an old european cathedral, detailed pencil sketch on paper, monochrome line art"
  "Watercolor|a serene mountain lake with pine trees, watercolor painting, soft washes, paper texture"
  "Oil_painting|a still life of fruit and a wine bottle on a table, oil painting, visible brushstrokes, classical, rich color"
  "Monochrome|a rainy city street with umbrellas, black and white, high contrast, monochrome"
  "Neon|a rain-soaked alley in a cyberpunk city, neon-lit, glowing lights, night, moody"
  "3D_render|a cute friendly robot character, 3D render, octane, soft studio lighting, subsurface detail"
  "Steampunk|a flying steampunk airship above the clouds, brass and gears, victorian, intricate"
  "Surreal|floating islands with waterfalls in a dreamlike sky, surreal, imaginative composition"
  "Vintage_film|a vintage convertible car on a desert road, vintage film photograph, faded colors, grain, 1970s"
  "Minimal|a single sailboat on calm water, minimal flat design, clean, simple shapes, lots of negative space"
  "Risograph|a bicycle leaning against a wall, risograph print, halftone texture, limited palette"
  "Fantasy_art|a majestic dragon perched on a mountain peak, epic fantasy concept art, dramatic, highly detailed"
  "Studio_portrait|a golden retriever dog, studio portrait, soft key light, bokeh background"
)

n=0; total=${#STYLES[@]}
for entry in "${STYLES[@]}"; do
  n=$((n+1))
  key="${entry%%|*}"
  style="${entry#*|}"
  out="$THUMBS/$key.png"
  echo "[$n/$total] $key -> $out"
  DYLD_LIBRARY_PATH="$ROOT/resources/bin/sd" "$SD" \
    -M img_gen \
    -m "$MODEL" \
    -p "$style" \
    -n "$NEG" \
    -o "$out" \
    -W 768 -H 768 --steps 4 --cfg-scale 1.0 --sampling-method euler \
    --diffusion-fa -t 6 -s 42 > "/tmp/thumb-$key.log" 2>&1
  if [ -f "$out" ]; then echo "    ok ($(wc -c < "$out") bytes)"; else echo "    FAILED (see /tmp/thumb-$key.log)"; fi
done
echo "=== DONE: $(ls "$THUMBS"/*.png 2>/dev/null | wc -l) thumbnails ==="
