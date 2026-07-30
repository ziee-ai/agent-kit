#!/usr/bin/env node
/**
 * serve-rig.mjs — the target the explorer explores.
 *
 * A static file server for a built UI, with `/api` reverse-proxied to a running
 * backend. Two reasons this exists rather than pointing the explorer at a Vite
 * dev server:
 *
 *  - A dev server rebuilds on file change, so an audit run could silently swap
 *    the code under itself mid-cycle. This serves a FIXED build directory, so a
 *    cycle audits exactly one commit.
 *  - SSE has to stream. `pipe` alone does not abort the upstream request when a
 *    browser navigates away, so every stream a cycle opens would leak a socket
 *    on the backend. The abort wiring below is load-bearing, not incidental.
 *
 * Everything is a flag or an env var: nothing here knows about a particular
 * machine, which is the point — this used to be a loose script in a scratch
 * directory with three absolute paths baked in, so nobody else could stand the
 * rig up.
 *
 *   node serve-rig.mjs --dist <built-ui-dir> [--backend-port 29500] [--port 1520]
 */
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const arg = (n, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`))
  if (hit) return hit.slice(n.length + 3)
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const DIST = arg('dist', process.env.RIG_DIST)
const BACKEND = { host: arg('backend-host', '127.0.0.1'), port: Number(arg('backend-port', process.env.RIG_BACKEND_PORT || 29500)) }
const PORT = Number(arg('port', process.env.RIG_PORT || 1520))

if (!DIST) {
  console.error('serve-rig: --dist <built-ui-dir> is required (or RIG_DIST).')
  process.exit(2)
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.map': 'application/json',
}

const server = http.createServer(async (req, res) => {
  // ---- API + SSE: proxy straight through, streamed
  if (req.url.startsWith('/api')) {
    const proxyReq = http.request(
      { host: BACKEND.host, port: BACKEND.port, path: req.url, method: req.method,
        headers: { ...req.headers, host: `${BACKEND.host}:${BACKEND.port}` } },
      proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers)
        // `pipe` alone does NOT abort `proxyReq`, so every SSE stream a browser
        // walks away from would sit open on the backend until it timed out. An
        // audit loop opens hundreds of those per hour.
        res.on('close', () => { proxyRes.destroy(); proxyReq.destroy() })
        proxyRes.pipe(res)
      },
    )
    req.on('aborted', () => proxyReq.destroy())
    proxyReq.on('error', e => { if (!res.headersSent) res.writeHead(502); res.end('proxy error ' + e.message) })
    req.pipe(proxyReq)
    return
  }

  // ---- static, with SPA fallback
  const clean = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, clean)
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    // Unknown path -> index.html. A client-side router owns these routes, and
    // answering 404 would make every deep link look like a broken page to an
    // explorer that cannot tell the difference.
    file = join(DIST, 'index.html')
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})

server.listen(PORT, () => {
  console.log(`serve-rig: :${PORT} -> ${DIST}  (api -> ${BACKEND.host}:${BACKEND.port})`)
})
