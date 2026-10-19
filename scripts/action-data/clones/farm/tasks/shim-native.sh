#!/usr/bin/env bash
# /dev/shm is mounted noexec, so native .node modules cannot load there. Replace them with pure-JS shims:
# bcrypt -> bcryptjs (same API, compatible hashes); sharp / lodepng -> stubs that throw only when used
# (image uploads: avatars, backgrounds, attachment thumbnails, favicons; not used by the farm tasks).
set -e
S=${1:-/dev/shm/clone-farm/opt/planka}
cd $S
[[ -d node_modules/bcryptjs ]] || npm install --no-save --ignore-scripts --no-audit --no-fund bcryptjs@2.4.3 >/dev/null
rm -rf node_modules/bcrypt && mkdir -p node_modules/bcrypt
echo '{"name":"bcrypt","version":"6.0.0-shim","main":"index.js"}' > node_modules/bcrypt/package.json
echo "module.exports = require('bcryptjs');" > node_modules/bcrypt/index.js
for m in sharp lodepng; do
  rm -rf node_modules/$m && mkdir -p node_modules/$m
  echo "{\"name\":\"$m\",\"version\":\"0.0.0-shim\",\"main\":\"index.js\"}" > node_modules/$m/package.json
  cat > node_modules/$m/index.js <<JS
const fail = () => { throw new Error('$m is not available on this farm host (noexec tmpfs)') };
module.exports = new Proxy(fail, { get: (t, k) => (k === 'then' ? undefined : fail), apply: fail });
JS
done
node -e "require('bcrypt').compare('a','\$2b\$10\$abcdefghijklmnopqrstuuG2ZBWo6CXyBG7/vPq0E.3lOIQgo7aZe').then(()=>console.log('shims ok'))"
