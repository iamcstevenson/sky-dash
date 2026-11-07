// Keyword feed collector: runs each keyword through Bluesky search every few minutes
// and stores matching public posts from anyone.
import { config } from './config.ts'
import { db, savePost, saveProfile } from './db.ts'
import { primaryAccount } from './hydrate.ts'
import { applyPresets, forgetRules } from './rules.ts'

const MAX_PAGES = 20 // 2,000 posts per keyword per poll

export type Keyword = {
  id: number
  query: string
  enabled: number
  in_feed: number
  last_poll_ms: number
  created_at: number
}

export const keywordStatus = {
  polling: false,
  lastRunMs: 0,
  errors: {} as Record<number, string>,
  capped: {} as Record<number, boolean>,
}

export function listKeywords(): Keyword[] {
  return db.prepare('SELECT * FROM keywords ORDER BY COALESCE(position, 1e9), created_at').all() as Keyword[]
}

const saveHit = db.prepare('INSERT OR IGNORE INTO keyword_hits (keyword_id, uri, sort_at) VALUES (?, ?, ?)')

async function pollKeyword(kw: Keyword) {
  const account = primaryAccount()
  if (!account) return
  const now = Date.now()
  const windowStart = now - config.keywordHours * 3_600_000
  // Overlap the previous poll by 5 minutes: search indexing can lag a little
  const sinceMs = Math.max(windowStart, kw.last_poll_ms - 5 * 60_000)

  let cursor: string | undefined
  let pages = 0
  keywordStatus.capped[kw.id] = false
  do {
    const res = await account.agent.app.bsky.feed.searchPosts({
      q: kw.query,
      sort: 'latest',
      since: new Date(sinceMs).toISOString(),
      limit: 100,
      cursor,
    })
    for (const p of res.data.posts) {
      const indexedMs = Date.parse(p.indexedAt)
      savePost(p.uri, p.cid, p.author.did, p.record, indexedMs)
      saveProfile(p.author)
      const row = db.prepare('SELECT sort_at FROM posts WHERE uri = ?').get(p.uri) as { sort_at: number }
      saveHit.run(kw.id, p.uri, row.sort_at)
    }
    cursor = res.data.cursor
    pages++
  } while (cursor && pages < MAX_PAGES)

  if (cursor) keywordStatus.capped[kw.id] = true
  db.prepare('UPDATE keywords SET last_poll_ms = ? WHERE id = ?').run(now, kw.id)
  delete keywordStatus.errors[kw.id]
}

async function pollRun(onlyId?: number) {
  keywordStatus.polling = true
  try {
    for (const kw of listKeywords()) {
      if (!kw.enabled || (onlyId !== undefined && kw.id !== onlyId)) continue
      try {
        await pollKeyword(kw)
      } catch (err: any) {
        keywordStatus.errors[kw.id] = err?.message ?? String(err)
        console.error(`Keyword "${kw.query}" search failed: ${keywordStatus.errors[kw.id]}`)
      }
    }
    keywordStatus.lastRunMs = Date.now()
  } finally {
    keywordStatus.polling = false
  }
}

let running: Promise<void> | null = null

// Polls every enabled keyword (or just one). Concurrent calls wait for the run in progress.
export async function pollKeywords(onlyId?: number) {
  while (running) await running
  const run = pollRun(onlyId)
  running = run
  try {
    await run
  } finally {
    if (running === run) running = null
  }
}

// Plain words with spaces are searched as a phrase: without quotes, Bluesky finds the words anywhere in a
// post (issue #12). Anything using search syntax (quotes, #tag, @handle, -word, field:value, AND/OR/NOT)
// is kept as typed.
export function normalizeQuery(raw: string): string {
  const q = raw.trim().replace(/\s+/g, ' ')
  const words = q.split(' ')
  if (words.length < 2) return q
  const syntax = /["“”:]/.test(q) || words.some((w) => /^[-#@]/.test(w) || /^(AND|OR|NOT)$/.test(w))
  return syntax ? q : `"${q}"`
}

export function addKeyword(query: string): Keyword {
  db.prepare('INSERT INTO keywords (query, created_at) VALUES (?, ?)').run(query, Date.now())
  applyPresets() // ready-made context rules for keywords like "cardinals" or "sec"
  return db.prepare('SELECT * FROM keywords WHERE query = ?').get(query) as Keyword
}

// Changes what a keyword searches for. Its old matches belong to the old text, so they're cleared and
// the next poll searches the whole window again. Rules, pause, 📡 and groups stay with the keyword.
export function renameKeyword(id: number, raw: string): string {
  const query = normalizeQuery(raw).slice(0, 200)
  if (!query) throw Object.assign(new Error('Enter a keyword or phrase'), { status: 400 })
  const other = listKeywords().find((k) => k.id !== id && k.query.toLowerCase() === query.toLowerCase())
  if (other) throw Object.assign(new Error(`You already have “${other.query}”`), { status: 409 })
  db.prepare('UPDATE keywords SET query = ?, last_poll_ms = 0 WHERE id = ?').run(query, id)
  db.prepare('DELETE FROM keyword_hits WHERE keyword_id = ?').run(id)
  delete keywordStatus.errors[id]
  delete keywordStatus.capped[id]
  return query
}

export function removeKeyword(id: number) {
  db.prepare('DELETE FROM keyword_hits WHERE keyword_id = ?').run(id)
  forgetRules(id)
  db.prepare('DELETE FROM keywords WHERE id = ?').run(id)
}

export function startKeywordPolling() {
  applyPresets()
  pollKeywords().catch(() => {})
  setInterval(() => pollKeywords().catch(() => {}), config.keywordPollMinutes * 60_000)
}
