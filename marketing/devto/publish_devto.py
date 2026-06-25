#!/usr/bin/env python3
"""Publish the dev.to articles. Idempotent via publish-log.json (a slug already
logged is skipped, so re-running never double-posts). Sets cover_image to the
hosted raw URL and flips published:true in each file before posting."""
import os, re, json, time, glob, urllib.request, urllib.error

API_KEY = "2JTdsDT5bt9an4Sr8jXTg5j9"
RAW = "https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/{slug}.jpg"
LOG = "publish-log.json"
DELAY = 4  # seconds between posts

PRIORITY = [
    "how-to-run-llms-locally-mac", "how-to-run-llms-locally-windows",
    "how-to-run-local-ai-mac", "how-to-run-local-ai-windows",
    "how-to-generate-ai-images-locally-mac", "how-to-generate-ai-images-locally-windows",
    "ollama-alternative-local", "lm-studio-alternative", "local-chatgpt-alternative",
    "how-to-run-stable-diffusion-desktop", "how-to-run-gemma-locally", "how-to-run-qwen-locally",
    "only-local-multimodal-ai", "fully-open-source-private-ai", "local-openai-compatible-api",
]

def set_frontmatter(text, slug):
    """Force cover_image + published:true in the YAML frontmatter."""
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    fm, body = m.group(1), m.group(2)
    url = RAW.format(slug=slug)
    if re.search(r"^cover_image:", fm, re.M):
        fm = re.sub(r"^cover_image:.*$", f"cover_image: {url}", fm, flags=re.M)
    else:
        fm += f"\ncover_image: {url}"
    if re.search(r"^published:", fm, re.M):
        fm = re.sub(r"^published:.*$", "published: true", fm, flags=re.M)
    else:
        fm = "published: true\n" + fm
    return f"---\n{fm}\n---\n{body}"

def post(body_markdown):
    data = json.dumps({"article": {"body_markdown": body_markdown, "published": True}}).encode()
    req = urllib.request.Request("https://dev.to/api/articles", data=data,
        headers={"api-key": API_KEY, "Content-Type": "application/json",
                 "Accept": "application/vnd.forem.api-v1+json",
                 "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"})
    r = urllib.request.urlopen(req, timeout=60)
    return json.load(r)

log = json.load(open(LOG)) if os.path.exists(LOG) else {}
slugs = [os.path.basename(f)[:-3] for f in glob.glob("*.md") if os.path.basename(f) != "BRIEF.md"]
slugs = [s for s in PRIORITY if s in slugs] + sorted(s for s in slugs if s not in PRIORITY)

for slug in slugs:
    if slug in log and log[slug].get("url"):
        print(f"skip (done)  {slug}")
        continue
    path = slug + ".md"
    text = set_frontmatter(open(path).read(), slug)
    open(path, "w").write(text)  # persist cover_image + published:true
    for attempt in range(4):
        try:
            res = post(text)
            log[slug] = {"id": res.get("id"), "url": res.get("url")}
            json.dump(log, open(LOG, "w"), indent=2)
            print(f"PUBLISHED   {slug}  ->  {res.get('url')}")
            time.sleep(DELAY)
            break
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:200]
            if e.code == 429:
                wait = 30 * (attempt + 1)
                print(f"  429 rate-limited on {slug}; sleeping {wait}s")
                time.sleep(wait)
                continue
            print(f"  FAIL {slug}: HTTP {e.code} {msg}")
            log[slug] = {"error": f"{e.code} {msg}"}
            json.dump(log, open(LOG, "w"), indent=2)
            break
        except Exception as e:
            print(f"  ERROR {slug}: {str(e)[:160]}")
            time.sleep(10)
    else:
        print(f"  GAVE UP {slug}")

ok = sum(1 for v in log.values() if v.get("url"))
print(f"\n{ok}/{len(slugs)} live. log: {LOG}")
