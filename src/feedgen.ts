// Public custom-feed server. Bluesky calls this to get your keyword feed for the official app.
// It runs on its own port and answers only the three feed endpoints, so exposing it to the
// internet (e.g. with Tailscale Funnel) never exposes the dashboard, which can post as you.
import { createServer } from 'node:http'
import { config } from './config.ts'
import { db, kvGet } from './db.ts'
import { judgeRow } from './rules.ts'

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

// Cursor format: "<sort_at>::<uri>" so posts with the same timestamp aren't skipped.
// Only posts that pass a keyword's context rules are included.
function skeleton(limit: number, cursor: string | null) {
  const out: { uri: string; sort_at: number }[] = []
  let at = cursor ? Number(cursor.split('::')[0]) : null
  let afterUri = cursor ? (cursor.split('::')[1] ?? '') : ''
  let lastSeen: { uri: string; sort_at: number } | null = null
  for (let round = 0; round < 10 && out.length < limit; round++) {
    const where = ['k.enabled = 1', 'k.in_feed = 1', 'h.sort_at > ?']
    const params: (string | number)[] = [Date.now() - config.keywordHours * 3_600_000]
    if (at !== null) {
      where.push('(h.sort_at < ? OR (h.sort_at = ? AND h.uri < ?))')
      params.push(at, at, afterUri)
    }
    const rows = db
      .prepare(
        `SELECT h.uri, MAX(h.sort_at) sort_at, p.author_did, p.record, GROUP_CONCAT(h.keyword_id) kws
         FROM keyword_hits h JOIN keywords k ON k.id = h.keyword_id JOIN posts p ON p.uri = h.uri
         WHERE ${where.join(' AND ')} GROUP BY h.uri ORDER BY sort_at DESC, h.uri DESC LIMIT 300`,
      )
      .all(...params) as { uri: string; sort_at: number; author_did: string; record: string | null; kws: string }[]
    for (const r of rows) {
      lastSeen = r
      if (judgeRow(r).kept.length) out.push(r)
      if (out.length === limit) break
    }
    if (rows.length < 300 && out.length < limit) return { feed: out.map((r) => ({ post: r.uri })) } // nothing older
    if (lastSeen) {
      at = lastSeen.sort_at
      afterUri = lastSeen.uri
    }
  }
  return {
    feed: out.map((r) => ({ post: r.uri })),
    cursor: lastSeen ? `${lastSeen.sort_at}::${lastSeen.uri}` : undefined,
  }
}

export function startFeedgen() {
  const host = config.feedgenHostname
  if (!host) return
  const serviceDid = `did:web:${host}`

  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `https://${host}`)
    if (req.method !== 'GET') return json(res, 405, { error: 'MethodNotAllowed' })

    switch (url.pathname) {
      case '/.well-known/did.json':
        return json(res, 200, {
          '@context': ['https://www.w3.org/ns/did/v1'],
          id: serviceDid,
          service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: `https://${host}` }],
        })

      case '/xrpc/app.bsky.feed.describeFeedGenerator': {
        const uri = kvGet('feedgen_uri')
        return json(res, 200, { did: serviceDid, feeds: uri ? [{ uri }] : [] })
      }

      case '/xrpc/app.bsky.feed.getFeedSkeleton': {
        const feed = url.searchParams.get('feed')
        if (!feed || feed !== kvGet('feedgen_uri')) {
          return json(res, 400, { error: 'UnknownFeed', message: 'Unknown feed' })
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100)
        return json(res, 200, skeleton(limit, url.searchParams.get('cursor')))
      }

      default:
        return json(res, 404, { error: 'NotFound' })
    }
  })
    .on('error', (err) => console.error(`Custom feed server could not start on port ${config.feedgenPort}: ${err.message}`))
    .listen(config.feedgenPort, '127.0.0.1', () => {
      console.log(`Custom feed server on http://127.0.0.1:${config.feedgenPort} (public name: ${host})`)
    })
}
