#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import blockmap from 'app-builder-lib/out/targets/blockmap/blockmap.js'
import yaml from 'js-yaml'

const [, , dmgPath, feedPath] = process.argv

if (!dmgPath || !feedPath) {
  console.error('usage: refresh-mac-dmg-update-info.mjs <dmg-path> <latest-mac.yml>')
  process.exit(2)
}

for (const file of [dmgPath, feedPath]) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`release input does not exist: ${file}`)
  }
}

const feed = yaml.load(fs.readFileSync(feedPath, 'utf8'))
if (!feed || typeof feed !== 'object' || !Array.isArray(feed.files)) {
  throw new Error('update metadata has no files list')
}

const dmgName = path.basename(dmgPath)
const records = feed.files.filter(
  (file) => file && typeof file === 'object' && file.url === dmgName
)
if (records.length !== 1) {
  throw new Error(`expected one update metadata record for ${dmgName}, found ${records.length}`)
}

const updateInfo = await blockmap.buildBlockMap(dmgPath, 'gzip', `${dmgPath}.blockmap`)
records[0].sha512 = updateInfo.sha512
records[0].size = updateInfo.size

fs.writeFileSync(feedPath, yaml.dump(feed, { lineWidth: -1, noRefs: true }), 'utf8')
console.log(`[release-assets] refreshed notarized DMG metadata for ${dmgName}`)
