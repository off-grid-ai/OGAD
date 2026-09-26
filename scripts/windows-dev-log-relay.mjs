import { createServer } from 'node:http'
import { createWriteStream, readFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const logPath = join(tmpdir(), 'offgrid-desktop-dev.log')
const token = randomBytes(16).toString('hex')
const port = Number(process.env.OFFGRID_LOG_PORT || 8765)
const log = createWriteStream(logPath, { flags: 'w' })

function write(chunk, destination) {
  destination.write(chunk)
  log.write(chunk)
}

const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run dev'], {
  cwd: root,
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
})

child.stdout.on('data', (chunk) => write(chunk, process.stdout))
child.stderr.on('data', (chunk) => write(chunk, process.stderr))
child.on('error', (error) => write(`\nCould not start the development app: ${error.message}\n`, process.stderr))
child.on('exit', (code) => write(`\nDevelopment app exited with code ${code ?? 'unknown'}.\n`, process.stdout))

const server = createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://localhost').pathname
  if (path !== `/${token}`) {
    response.writeHead(404).end('Not found')
    return
  }

  let body = 'The log is not ready yet.'
  try {
    body = readFileSync(logPath, 'utf8')
    if (body.length > 5_000_000) body = body.slice(-5_000_000)
  } catch {}

  response.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(body)
})

server.listen(port, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry?.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}/${token}`)

  process.stdout.write(`\nLive development log:\n${addresses.join('\n')}\n`)
  process.stdout.write('If Windows asks, allow Node.js on private networks.\n\n')
})

function stop() {
  child.kill()
  server.close()
  log.end()
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
