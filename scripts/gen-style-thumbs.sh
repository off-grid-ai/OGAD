#!/usr/bin/env bash
# Generate bundled style previews through the running Off Grid Desktop gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY="${OFFGRID_GATEWAY_URL:-http://127.0.0.1:7878}"
OUT="${STYLE_THUMB_DIR:-$ROOT/resources/style-thumbs}"
NEGATIVE="people, person, human, woman, women, girl, girls, man, men, boy, boys, face, portrait, hands, text, letters, logo, watermark, signature, low quality, blurry, distorted, deformed"

mkdir -p "$OUT"
curl --fail --silent --max-time 5 "$GATEWAY/health" >/dev/null || {
  echo "Off Grid Desktop gateway is not available at $GATEWAY." >&2
  exit 1
}

# key|seed|prompt. Every scene is people-free by design.
STYLES=(
  "Photoreal|4101|A premium editorial product photograph of a precision mechanical wristwatch on dark slate, empty studio, dramatic side light, realistic metal and glass, crisp micro-detail, restrained neutral palette, professional commercial photography"
  "Cinematic|4102|An empty classic sports car on a rain-dark coastal road at blue hour, cinematic film still, anamorphic light, deep contrast, atmospheric mist, sophisticated color grade, no driver, no people"
  "Anime|4103|A quiet futuristic botanical research station above the clouds, detailed anime background art, clean linework, luminous color, cinematic composition, no characters, no people"
  "Sketch|4104|A grand stone museum interior with a sweeping staircase, architectural graphite sketch, precise perspective, fine cross-hatching, archival paper texture, no people"
  "Watercolor|4105|A serene alpine lake with pine forest and distant snow peaks, refined watercolor painting, translucent washes, elegant pigment blooms, cold-pressed paper, no buildings, no people"
  "Oil_painting|4106|A museum-quality still life of pears, ceramic vessels, and folded linen on a dark table, classical oil painting, rich glazing, confident brushwork, controlled light, no people"
  "Monochrome|4107|An empty modern train platform after rain, fine-art black-and-white photography, graphic geometry, luminous reflections, deep tonal range, no people"
  "Neon|4108|A high-end electric motorcycle parked in an empty rain-soaked city alley at night, cyan and magenta neon reflections, precise industrial design, cinematic atmosphere, no rider, no people"
  "3D_render|4109|A premium modular desktop speaker on a sculpted pedestal, polished 3D product render, physically based materials, soft studio lighting, subtle shadows, clean art direction, no text, no people"
  "Steampunk|4110|An intricate brass astronomical observatory above the clouds, gears, copper pipes, glass lenses, Victorian engineering, dramatic warm light, detailed concept art, no people"
  "Surreal|4111|A monumental marble doorway floating above a silent ocean, impossible reflections, dreamlike scale, refined surrealist composition, soft dawn light, no people"
  "Vintage_film|4112|An empty mid-century roadside motel and parked convertible at dusk, vintage 1970s film photograph, authentic grain, faded color, understated composition, no people"
  "Minimal|4113|A single black ceramic vase and one green branch on an off-white surface, premium minimalist editorial composition, soft natural shadow, ample negative space, no text, no people"
  "Risograph|4114|A geometric arrangement of a bicycle, leaves, and sun shapes, professional risograph poster, limited emerald and coral inks, tactile halftone texture, precise registration, no text, no people"
  "Fantasy_art|4115|An ancient crystalline fortress on a remote mountain ridge beneath an aurora, epic fantasy environment art, intricate scale, dramatic atmosphere, sophisticated color, no people"
  "Studio_portrait|4116|A dignified black Labrador sitting against a charcoal studio backdrop, professional animal portrait, soft key light, detailed fur, natural expression, shallow depth of field, no people"
)

TOTAL="${#STYLES[@]}"
INDEX=0
for ENTRY in "${STYLES[@]}"; do
  INDEX=$((INDEX + 1))
  KEY="${ENTRY%%|*}"
  REST="${ENTRY#*|}"
  SEED="${REST%%|*}"
  PROMPT="${REST#*|}"
  DEST="$OUT/$KEY.png"

  if [[ -f "$DEST" && "${FORCE_STYLE_THUMBS:-0}" != "1" ]]; then
    echo "[$INDEX/$TOTAL] $KEY already exists."
    continue
  fi

  echo "[$INDEX/$TOTAL] Generating $KEY..."
  PAYLOAD="$(node -e '
    const [prompt, negative, seed] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({
      prompt, negative_prompt: negative, width: 512, height: 512,
      steps: 10, cfg_scale: 2, seed: Number(seed), response_format: "url"
    }))
  ' "$PROMPT" "$NEGATIVE" "$SEED")"

  RESPONSE="$(curl --fail --silent --show-error --max-time 300 \
    "$GATEWAY/v1/images/generations" -H 'Content-Type: application/json' \
    --data-binary "$PAYLOAD")"
  SOURCE="$(node -e '
    const { fileURLToPath } = require("node:url")
    let body = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", chunk => { body += chunk })
    process.stdin.on("end", () => {
      const value = JSON.parse(body).data?.[0]?.url
      if (typeof value !== "string" || !value.startsWith("file://")) process.exit(1)
      process.stdout.write(fileURLToPath(value))
    })
  ' <<<"$RESPONSE")"

  cp "$SOURCE" "$DEST"
  rm -f "$SOURCE"
  echo "[$INDEX/$TOTAL] Saved $DEST"
done

echo "Generated $(find "$OUT" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ') style previews."
