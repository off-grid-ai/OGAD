import fs from 'node:fs'

const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

function readGlb(path) {
  const file = fs.readFileSync(path)
  if (file.readUInt32LE(0) !== 0x46546c67 || file.readUInt32LE(4) !== 2) {
    throw new Error(`${path} is not a glTF 2 binary file.`)
  }
  const jsonLength = file.readUInt32LE(12)
  if (file.readUInt32LE(16) !== JSON_CHUNK) throw new Error(`${path} has no JSON chunk.`)
  const json = JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8'))
  const binHeader = 20 + jsonLength
  const binLength = file.readUInt32LE(binHeader)
  if (file.readUInt32LE(binHeader + 4) !== BIN_CHUNK) throw new Error(`${path} has no BIN chunk.`)
  return { json, bin: file.subarray(binHeader + 8, binHeader + 8 + binLength) }
}

function aligned(buffer, byte = 0) {
  const padding = (4 - (buffer.length % 4)) % 4
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, byte)]) : buffer
}

function writeGlb(path, json, bin) {
  const jsonBuffer = aligned(Buffer.from(JSON.stringify(json)), 0x20)
  const binBuffer = aligned(bin)
  json.buffers[0].byteLength = binBuffer.length
  const finalJson = aligned(Buffer.from(JSON.stringify(json)), 0x20)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + finalJson.length + 8 + binBuffer.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(finalJson.length, 0)
  jsonHeader.writeUInt32LE(JSON_CHUNK, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binBuffer.length, 0)
  binHeader.writeUInt32LE(BIN_CHUNK, 4)
  fs.writeFileSync(path, Buffer.concat([header, jsonHeader, finalJson, binHeader, binBuffer]))
}

const [targetPath, sourcePath, outputPath] = process.argv.slice(2)
if (!targetPath || !sourcePath || !outputPath) {
  throw new Error('Usage: node merge-gltf-animations.mjs target.glb motions.glb output.glb')
}

const target = readGlb(targetPath)
const source = readGlb(sourcePath)
target.json.accessors ??= []
target.json.bufferViews ??= []
target.json.animations ??= []

const targetNodesByName = new Map(
  target.json.nodes.map((node, index) => [node.name, index]).filter(([name]) => Boolean(name))
)
const skinnedMeshNode = target.json.nodes.find((node) => node.mesh !== undefined && node.skin !== undefined)
const activeJoints = new Set(
  skinnedMeshNode?.skin === undefined ? [] : target.json.skins[skinnedMeshNode.skin].joints
)

function activeTargetNode(name) {
  const nodeIndex = targetNodesByName.get(name)
  return nodeIndex !== undefined && activeJoints.has(nodeIndex) ? nodeIndex : undefined
}
const accessorMap = new Map()
const bufferViewMap = new Map()
let targetBin = aligned(target.bin)

function copyBufferView(sourceIndex) {
  if (bufferViewMap.has(sourceIndex)) return bufferViewMap.get(sourceIndex)
  const view = source.json.bufferViews[sourceIndex]
  const start = view.byteOffset ?? 0
  const bytes = source.bin.subarray(start, start + view.byteLength)
  const targetIndex = target.json.bufferViews.length
  target.json.bufferViews.push({ ...view, buffer: 0, byteOffset: targetBin.length })
  targetBin = aligned(Buffer.concat([targetBin, bytes]))
  bufferViewMap.set(sourceIndex, targetIndex)
  return targetIndex
}

function copyAccessor(sourceIndex) {
  if (accessorMap.has(sourceIndex)) return accessorMap.get(sourceIndex)
  const accessor = source.json.accessors[sourceIndex]
  const targetIndex = target.json.accessors.length
  target.json.accessors.push({
    ...accessor,
    ...(accessor.bufferView === undefined
      ? {}
      : { bufferView: copyBufferView(accessor.bufferView) })
  })
  accessorMap.set(sourceIndex, targetIndex)
  return targetIndex
}

const existing = new Set(target.json.animations.map((animation) => animation.name))
for (const animation of source.json.animations ?? []) {
  if (existing.has(animation.name)) continue
  const copied = structuredClone(animation)
  for (const sampler of copied.samplers) {
    sampler.input = copyAccessor(sampler.input)
    sampler.output = copyAccessor(sampler.output)
  }
  for (const channel of copied.channels) {
    const sourceNode = source.json.nodes[channel.target.node]
    const targetNode = activeTargetNode(sourceNode?.name)
    if (targetNode === undefined) throw new Error(`Target bone is missing: ${sourceNode?.name}`)
    channel.target.node = targetNode
  }
  target.json.animations.push(copied)
}

writeGlb(outputPath, target.json, targetBin)
console.log(target.json.animations.map((animation) => animation.name).join('\n'))
