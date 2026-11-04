import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { prune } from './db.ts'
import { accounts, signInAll, syncFollows, refreshProfileCounts } from './accounts.ts'
import { startCollector, stopCollector, refreshWanted } from './jetstream.ts'
import { runBackfill, startHeartbeat } from './backfill.ts'
import { handleApi, HttpError } from './api.ts'
import { startKeywordPolling } from './keywords.ts'
import { startFeedgen } from './feedgen.ts'
import { startNotificationSync } from './notifications.ts'
import { startDiscoverRefresh } from './discover.ts'
import { uploadVideo } from './video.ts'
import { receiveMedia, mediaFile } from './drafts.ts'
import { startProfileDetails } from './profileDetails.ts'

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url))
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

// This page can post as you, so only answer requests addressed to this machine by name.
// Extra names (e.g. a Tailscale hostname) can be added with ALLOWED_HOSTS=name1,name2
const allowedHosts = new Set([
  `127.0.0.1:${config.port}`,
  `localhost:${config.port}`,
  ...(process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
])

function hostAllowed(req: IncomingMessage) {
  const host = req.headers.host ?? ''
  return allowedHosts.has(host) || allowedHosts.has(host.replace(/:\d+$/, ''))
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// Posts with 4 images (base64) can approach 11 MB; anything far beyond that isn't from this page
const MAX_BODY_BYTES = 16 * 1024 * 1024

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large')
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = normalize(join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' })
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
    res.end(data)
  } catch {
    send(res, 404, { error: 'Not found' })
  }
}

const server = createServer(async (req, res) => {
  if (!hostAllowed(req)) return send(res, 421, { error: `Host ${req.headers.host} not allowed` })
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)

  try {
    let body
    if (req.method === 'POST') {
      const origin = req.headers.origin
      if (origin && !allowedHosts.has(new URL(origin).host)) throw new HttpError(403, 'Cross-site request blocked')
      // Video files are streamed through as-is. Like JSON, a video content type can't be sent
      // by another website without a CORS preflight, which this server never answers.
      if (url.pathname === '/api/video/upload') return send(res, 200, await uploadVideo(req, url))
      // A draft's photo or video, from Hub Agent. Same reasoning: these types need a preflight from other sites.
      if (url.pathname === '/api/drafts/media') return send(res, 200, await receiveMedia(req, url))
      // Blocks other websites from sending actions: they can't send JSON here without a CORS preflight
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON only')
      body = await readBody(req)
    }
    if (req.method === 'GET' && url.pathname === '/api/drafts/file') {
      const file = mediaFile(url.searchParams.get('id'), url.searchParams.get('name'))
      res.writeHead(200, { 'content-type': file.mime, 'content-length': String(file.size), 'cache-control': 'no-store' })
      return file.stream.pipe(res)
    }
    send(res, 200, await handleApi(req.method ?? 'GET', url, body))
  } catch (err: any) {
    // Network failures reach here with a status of 1 (the Bluesky library's "unknown"), which isn't a real
    // HTTP code and would crash the server if sent, so anything out of range is reported as a bad gateway
    const raw = err instanceof HttpError ? err.status : (err?.status ?? 500)
    const status = raw >= 400 && raw <= 599 ? raw : 502
    if (status >= 500) console.error(err)
    send(res, status, { error: err?.message ?? String(err) })
  }
})

async function main() {
  if (config.accounts.length === 0) {
    console.log('No accounts configured yet. Copy .env.example to .env and add your app passwords.')
  }
  await signInAll()
  for (const a of accounts) {
    try {
      await syncFollows(a)
    } catch (err: any) {
      console.error(`Could not load follows for @${a.handle}: ${err?.message}`)
    }
  }
  startCollector()
  startHeartbeat()
  runBackfill().catch((err) => console.error('Backfill failed', err))
  startKeywordPolling()
  startProfileDetails()
  startFeedgen()
  startNotificationSync()
  startDiscoverRefresh()
  refreshProfileCounts().catch(() => {})

  // Re-sync follow lists every 6 hours in case changes were missed, and prune old posts hourly
  setInterval(async () => {
    for (const a of accounts) await syncFollows(a).catch(() => {})
    refreshWanted()
    await refreshProfileCounts().catch(() => {})
  }, 6 * 3_600_000)
  setInterval(() => prune(config.retentionDays), 3_600_000)
  prune(config.retentionDays)

  server.listen(config.port, config.host, () => {
    console.log(`\nSkydash is running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}\n`)
  })
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopCollector()
    server.close()
    process.exit(0)
  })
}

main()
