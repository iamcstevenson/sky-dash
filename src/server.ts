import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.ts'
import { prune } from './db.ts'
import { accounts, signInAll, syncFollows, refreshProfileCounts } from './accounts.ts'
import { startCollector, stopCollector, refreshWanted } from './jetstream.ts'
import { runBackfill, startHeartbeat } from './backfill.ts'
import { handleApi, HttpError, startScheduler } from './api.ts'
import { startKeywordPolling } from './keywords.ts'
import { startFeedgen } from './feedgen.ts'
import { startNotificationSync } from './notifications.ts'
import { startDiscoverRefresh } from './discover.ts'
import { uploadVideo } from './video.ts'
import { receiveMedia, mediaFile } from './drafts.ts'
import { startProfileDetails } from './profileDetails.ts'
import { pruneAnalyses } from './analyze.ts'

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

// Pages travel over Tailscale, often from a phone, so text is compressed: JSON lists shrink to about a fifth.
// Brotli at a low quality is as fast as gzip and smaller; gzip is the fallback for clients without it.
const COMPRESS_MIN_BYTES = 1024

function pickEncoding(req: IncomingMessage) {
  const accepted = String(req.headers['accept-encoding'] ?? '')
  if (/\bbr\b/.test(accepted)) return 'br'
  if (/\bgzip\b/.test(accepted)) return 'gzip'
  return null
}

function compress(data: Buffer, encoding: 'br' | 'gzip', quality: number) {
  return encoding === 'br'
    ? brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: quality, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } })
    : gzipSync(data, { level: quality > 5 ? 9 : 6 })
}

function sendBody(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, data: Buffer) {
  const encoding = data.length >= COMPRESS_MIN_BYTES ? pickEncoding(req) : null
  const out = encoding ? compress(data, encoding, 4) : data
  res.writeHead(status, { ...headers, vary: 'accept-encoding', 'content-length': String(out.length), ...(encoding && { 'content-encoding': encoding }) })
  res.end(out)
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  sendBody(req, res, status, headers, Buffer.from(JSON.stringify(body)))
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

// Page files are sent once and then only checked: the browser asks with the ETag it has, and gets a
// 304 with no body until the file changes. Compressed copies are kept per file version.
type StaticEntry = { mtime: number; etag: string; type: string; raw: Buffer; encoded: Map<string, Buffer> }
const staticCache = new Map<string, StaticEntry>()

async function staticEntry(file: string) {
  const info = await stat(file)
  const hit = staticCache.get(file)
  if (hit && hit.mtime === info.mtimeMs) return hit
  const raw = await readFile(file)
  const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"`
  const entry = { mtime: info.mtimeMs, etag, type: TYPES[extname(file)] ?? 'application/octet-stream', raw, encoded: new Map() }
  staticCache.set(file, entry)
  return entry
}

async function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = normalize(join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR)) return send(req, res, 403, { error: 'Forbidden' })
  let entry: StaticEntry
  try {
    entry = await staticEntry(file)
  } catch {
    return send(req, res, 404, { error: 'Not found' })
  }
  const encoding = entry.raw.length >= COMPRESS_MIN_BYTES ? pickEncoding(req) : null
  const etag = encoding ? entry.etag.replace(/"$/, `-${encoding}"`) : entry.etag
  const headers: Record<string, string> = { 'content-type': entry.type, 'cache-control': 'no-cache', etag, vary: 'accept-encoding' }
  if (req.headers['if-none-match']?.split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, headers)
    return res.end()
  }
  let body = entry.raw
  if (encoding) {
    body = entry.encoded.get(encoding) ?? compress(entry.raw, encoding, 11)
    entry.encoded.set(encoding, body)
    headers['content-encoding'] = encoding
  }
  res.writeHead(200, { ...headers, 'content-length': String(body.length) })
  res.end(body)
}

const server = createServer(async (req, res) => {
  if (!hostAllowed(req)) return send(req, res, 421, { error: `Host ${req.headers.host} not allowed` })
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, req, res)

  try {
    let body
    if (req.method === 'POST') {
      const origin = req.headers.origin
      if (origin && !allowedHosts.has(new URL(origin).host)) throw new HttpError(403, 'Cross-site request blocked')
      // Video files are streamed through as-is. Like JSON, a video content type can't be sent
      // by another website without a CORS preflight, which this server never answers.
      if (url.pathname === '/api/video/upload') return send(req, res, 200, await uploadVideo(req, url))
      // A draft's photo or video, from Hub Agent. Same reasoning: these types need a preflight from other sites.
      if (url.pathname === '/api/drafts/media') return send(req, res, 200, await receiveMedia(req, url))
      // Blocks other websites from sending actions: they can't send JSON here without a CORS preflight
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON only')
      body = await readBody(req)
    }
    if (req.method === 'GET' && url.pathname === '/api/drafts/file') {
      const file = mediaFile(url.searchParams.get('id'), url.searchParams.get('name'))
      res.writeHead(200, { 'content-type': file.mime, 'content-length': String(file.size), 'cache-control': 'no-store' })
      return file.stream.pipe(res)
    }
    send(req, res, 200, await handleApi(req.method ?? 'GET', url, body))
  } catch (err: any) {
    // Network failures reach here with a status of 1 (the Bluesky library's "unknown"), which isn't a real
    // HTTP code and would crash the server if sent, so anything out of range is reported as a bad gateway
    const raw = err instanceof HttpError ? err.status : (err?.status ?? 500)
    const status = raw >= 400 && raw <= 599 ? raw : 502
    if (status >= 500) console.error(err)
    send(req, res, status, { error: err?.message ?? String(err) })
  }
})

async function main() {
  await signInAll()
  if (accounts.length === 0) console.log('No accounts yet: add them in the dashboard (Settings → Accounts).')
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
  startScheduler()
  refreshProfileCounts().catch(() => {})

  // Re-sync follow lists every 6 hours in case changes were missed, and prune old posts hourly
  setInterval(async () => {
    for (const a of accounts) await syncFollows(a).catch(() => {})
    refreshWanted()
    await refreshProfileCounts().catch(() => {})
  }, 6 * 3_600_000)
  setInterval(() => {
    prune(config.retentionDays)
    pruneAnalyses()
  }, 3_600_000)
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
