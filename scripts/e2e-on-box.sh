#!/usr/bin/env bash
# Run the Playwright e2e on the TEST BOX instead of this Mac.
#
# Why a second machine at all: the e2e drives the real app, and Playwright has no headless mode for
# Electron. Running it here means ~25 app launches fighting the developer for the keyboard, which is why
# the gate kept getting skipped with OFFGRID_SKIP_E2E=1. Headless fixed the interruption; the box is
# better still - a clean machine, nothing else holding :8439/:7878, and a real display.
#
# In order:
#   1. Is the box reachable over ssh with key auth? If not, exit 20 so the caller can fall back.
#   2. Mirror the working tree there (source only - node_modules and dist belong to the box).
#   3. Install only when the lockfile actually changed, so a normal run costs seconds.
#   4. Run the suite, and bring the raw V8 coverage back so the coverage gate still counts it.
#
# Any arguments are passed straight to Playwright, so a single spec can be iterated on the box:
#   bash scripts/e2e-on-box.sh devices-sync.spec.ts
#   bash scripts/e2e-on-box.sh tour.spec.ts -g "locked Pro"
#
# Exit codes: 0 suite passed | 1 suite failed | 20 box unavailable (NOT a test failure).
set -uo pipefail

BOX_HOST="${E2E_BOX_HOST:-192.168.1.64}"
BOX_USER="${E2E_BOX_USER:-admin}"
BOX_DIR="${E2E_BOX_DIR:-/Users/${BOX_USER}/ogad-e2e}"
BOX="${BOX_USER}@${BOX_HOST}"
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=8"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_URL="https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz"

say() { echo "[e2e-box] $*"; }

if ! ssh $SSH_OPTS "$BOX" 'exit 0' 2>/dev/null; then
  say "$BOX_HOST is not reachable with key auth - falling back to a local run."
  exit 20
fi
say "using $BOX ($BOX_DIR)"

# node from a tarball under $HOME: never a system install, so this cannot disturb whatever else that
# machine is for.
ssh $SSH_OPTS "$BOX" "set -e
  if [ ! -x \"\$HOME/node/bin/node\" ]; then
    curl -sSL -o /tmp/node.tar.gz '$NODE_URL'
    mkdir -p \"\$HOME/node\" && tar -xzf /tmp/node.tar.gz -C \"\$HOME/node\" --strip-components=1
    rm -f /tmp/node.tar.gz
  fi" || { say "could not provision node on the box"; exit 20; }

# Source only. node_modules is built ON the box (native modules are per-machine) and dist/out are
# rebuilt there, so shipping either would be slow and wrong.
say "syncing the working tree"
ssh $SSH_OPTS "$BOX" "mkdir -p '$BOX_DIR'" || exit 20
# The excludes are ANCHORED with a leading slash on purpose. An unanchored "dist" matches at every
# depth, which silently stripped packages/*/dist - and those are tracked build outputs the app resolves
# @offgrid/models through, so the box failed with "Failed to resolve entry for package".
rsync -a --delete \
  --exclude /node_modules --exclude /.git --exclude /dist --exclude /out \
  --exclude '/coverage*' --exclude /.claude --exclude /outputs \
  --exclude '/e2e/screenshots' --exclude /.offgrid --exclude '*/node_modules' \
  -e "ssh $SSH_OPTS" "$REPO_ROOT/" "$BOX:$BOX_DIR/" || { say "rsync of the app failed"; exit 20; }
# @offgrid/sync is a file: dep pointing at ../shared, so the sibling has to exist there too.
rsync -a --delete --exclude node_modules --exclude .git \
  -e "ssh $SSH_OPTS" "$REPO_ROOT/../shared/" "$BOX:$(dirname "$BOX_DIR")/shared/" \
  || { say "rsync of shared failed"; exit 20; }

# Install only when the lockfile moved. A gate that reinstalls on every push is a gate people bypass.
say "installing if the lockfile moved"
ssh $SSH_OPTS "$BOX" "set -e
  export PATH=\"\$HOME/node/bin:\$PATH\"
  cd '$BOX_DIR'
  stamp=node_modules/.lock-stamp
  if [ ! -d node_modules ] || [ ! -f \"\$stamp\" ] || ! cmp -s package-lock.json \"\$stamp\"; then
    echo '[e2e-box] npm ci (first run or lockfile changed)'
    (cd ../shared && npm ci --no-audit --no-fund >/dev/null 2>&1 || true)
    npm ci --no-audit --no-fund
    cp package-lock.json \"\$stamp\"
  else
    echo '[e2e-box] node_modules is current'
  fi" || { say "install on the box failed"; exit 20; }

# Headless there too: the box has a display, but a run nothing can disturb is also a run that disturbs
# nothing - including whatever is already on that screen.
# Default to ONLY what this branch touched. Running 25 spec files to check a one-line change wastes
# minutes per push and trains everyone to skip the gate; CI runs the whole suite anyway. Explicit args
# always win, and E2E_FULL=1 forces everything when that is what you actually want.
PW_ARGS="$*"
if [ -z "$PW_ARGS" ] && [ "${E2E_FULL:-0}" != "1" ]; then
  base="$(git -C "$REPO_ROOT" merge-base HEAD origin/main 2>/dev/null || echo '')"
  if [ -n "$base" ]; then
    changed_specs="$(git -C "$REPO_ROOT" diff --name-only "$base"...HEAD -- 'e2e/*.spec.ts' 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
    # A change under src/ or pro/ can break any surface, so that still earns the full suite. A change
    # confined to specs only needs those specs.
    touched_app="$(git -C "$REPO_ROOT" diff --name-only "$base"...HEAD -- src pro shared 2>/dev/null | head -1)"
    if [ -n "$changed_specs" ] && [ -z "$touched_app" ]; then
      PW_ARGS="$changed_specs"
      say "only the specs this branch changed: $PW_ARGS (E2E_FULL=1 for everything)"
    fi
  fi
fi
say "running the suite${PW_ARGS:+ (playwright args: $PW_ARGS)}"
ssh $SSH_OPTS "$BOX" "bash -o pipefail -c '
  export PATH=\"\$HOME/node/bin:\$PATH\"
  cd \"$BOX_DIR\"
  rm -rf coverage-e2e-raw && mkdir -p coverage-e2e-raw
  OFFGRID_E2E_COVERAGE=\"$BOX_DIR/coverage-e2e-raw\" npm run --silent test:e2e -- $PW_ARGS 2>&1 | tee /tmp/ogad-e2e.log | tail -40
'"
suite=$?

# Bring coverage home even on failure: the gate should count what DID run.
if ssh $SSH_OPTS "$BOX" "[ -n \"\$(ls -A '$BOX_DIR/coverage-e2e-raw' 2>/dev/null)\" ]"; then
  rm -rf "$REPO_ROOT/coverage-e2e-raw" && mkdir -p "$REPO_ROOT/coverage-e2e-raw"
  if scp -q $SSH_OPTS "$BOX:$BOX_DIR/coverage-e2e-raw/*" "$REPO_ROOT/coverage-e2e-raw/" 2>/dev/null; then
    # V8 records the ABSOLUTE path of the machine that ran it, so every entry says
    # file:///Users/admin/ogad-e2e/... and c8 can map none of it to this checkout - the whole e2e
    # contribution silently disappears from the coverage gate (measured: 3823 box paths vs 69 local, and
    # the gate fell from 72.8% to 63.5% the first time this ran). Rewrite the prefix on the way in.
    node -e '
      const fs = require("fs"), path = require("path");
      const dir = process.argv[1], from = process.argv[2], to = process.argv[3];
      let files = 0, rewritten = 0;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(dir, name);
        const before = fs.readFileSync(file, "utf8");
        const after = before.split(from).join(to);
        if (after !== before) { fs.writeFileSync(file, after); rewritten++; }
        files++;
      }
      console.log(`[e2e-box] remapped box paths in ${rewritten}/${files} coverage files`);
    ' "$REPO_ROOT/coverage-e2e-raw" "$BOX_DIR" "$REPO_ROOT"
    say "coverage returned from the box"
  fi
fi
# And the screenshots, which are the evidence a person actually looks at.
rsync -a -e "ssh $SSH_OPTS" "$BOX:$BOX_DIR/e2e/screenshots/" "$REPO_ROOT/e2e/screenshots/" 2>/dev/null || true

if [ "$suite" -eq 0 ]; then say "suite passed on $BOX_HOST"; else say "suite reported failures on $BOX_HOST"; fi
exit "$suite"
