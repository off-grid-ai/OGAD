export interface ImageStylePreset {
  name: string
  prompt: string
}

export const IMAGE_STYLE_PRESETS: readonly ImageStylePreset[] = [
  { name: 'Photoreal', prompt: 'photorealistic, sharp focus, high detail, 50mm photo' },
  {
    name: 'Cinematic',
    prompt: 'cinematic film still, dramatic lighting, shallow depth of field, color graded'
  },
  { name: 'Anime', prompt: 'anime illustration, clean lineart, vibrant colors' },
  { name: 'Sketch', prompt: 'detailed pencil sketch on paper, monochrome line art' },
  { name: 'Watercolor', prompt: 'watercolor painting, soft washes, paper texture' },
  { name: 'Oil painting', prompt: 'oil painting, visible brushstrokes, classical, rich color' },
  { name: 'Monochrome', prompt: 'black and white, high contrast, monochrome' },
  { name: 'Neon', prompt: 'neon-lit cyberpunk, glowing lights, night, moody' },
  { name: '3D render', prompt: '3D render, octane, soft studio lighting, subsurface detail' },
  { name: 'Steampunk', prompt: 'steampunk, brass and gears, victorian, intricate' },
  { name: 'Surreal', prompt: 'surreal, dreamlike, imaginative composition' },
  { name: 'Vintage film', prompt: 'vintage film photograph, faded colors, grain, 1970s' },
  {
    name: 'Minimal',
    prompt: 'minimal flat design, clean, simple shapes, lots of negative space'
  },
  { name: 'Risograph', prompt: 'risograph print, halftone texture, limited palette' },
  { name: 'Fantasy art', prompt: 'epic fantasy concept art, dramatic, highly detailed' },
  { name: 'Studio portrait', prompt: 'studio portrait, soft key light, bokeh background' }
]

export function imageStylePrompt(name: string | null): string | null {
  return IMAGE_STYLE_PRESETS.find((style) => style.name === name)?.prompt ?? null
}
