// Read-only copy for the iPhone app, pushed to iCloud by the Hub agent on this Mac.
// It never includes sessions, kv, follow URIs or raw records, and keyword rules are applied here
// because they read the raw records.
import { db } from './db.ts'
import { accounts } from './accounts.ts'
import { collector } from './jetstream.ts'
import { listKeywords } from './keywords.ts'
import { listGroups } from './groups.ts'
import { listDrafts } from './drafts.ts'
import { groupRulesFor, judgeRow, rulesFor } from './rules.ts'

const WINDOW_DAYS = 30
const DAY_MS = 86_400_000
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// Everything that isn't tied to one day. Packs are compared by hash, so rows are sorted.
export function syncState() {
  const now = Date.now()
  return {
    formatVersion: 1,
    windowDays: WINDOW_DAYS,
    lastEventMs: Math.floor(collector.lastEventUs / 1000) || null,
    days: Array.from({ length: WINDOW_DAYS + 1 }, (_, i) => dayKey(now - i * DAY_MS)),
    accounts: accounts.filter((a) => a.did).map((a) => ({ slot: a.slot, did: a.did, handle: a.handle })),
    follows: db.prepare('SELECT account_did, subject_did, muted FROM follows ORDER BY account_did, subject_did').all(),
    profiles: db
      .prepare(
        `SELECT did, handle, display_name, avatar FROM profiles
         WHERE did IN (SELECT subject_did FROM follows) ORDER BY did`,
      )
      .all(),
    // Paused keywords too, so the phone can resume them. Only enabled ones match posts.
    keywords: listKeywords().map((k) => {
      const r = rulesFor(k.id)
      return { id: k.id, query: k.query, enabled: !!k.enabled, in_feed: !!k.in_feed, must: r.must, exclude: r.exclude }
    }),
    // Open drafts and ones finished in the last week, so each side sees what happened to the other's
    drafts: listDrafts(),
    groups: listGroups().map((g) => {
      const r = groupRulesFor(g.id)
      return { id: g.id, name: g.name, keyword_ids: g.keywordIds, must: r.must, exclude: r.exclude }
    }),
  }
}

type DayRow = {
  uri: string
  cid: string | null
  author_did: string
  text: string | null
  sort_at: number
  reply_parent: string | null
  reply_root: string | null
  embed: string | null
  is_en: number | null
  record: string | null
  kws: string | null
  followed: number
}

// One UTC day of what the phone shows: posts from people you follow, keyword matches your rules keep,
// and your own posts, so a reply sent from the phone shows up in its thread
export function syncDay(day: string) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN
  if (!Number.isFinite(start)) return null
  const rows = db
    .prepare(
      `SELECT p.uri, p.cid, p.author_did, p.text, p.sort_at, p.reply_parent, p.reply_root, p.embed, p.is_en, p.record,
        (SELECT GROUP_CONCAT(h.keyword_id) FROM keyword_hits h JOIN keywords k ON k.id = h.keyword_id
         WHERE h.uri = p.uri AND k.enabled = 1) kws,
        EXISTS (SELECT 1 FROM follows f WHERE f.subject_did = p.author_did) followed
       FROM posts p
       WHERE p.sort_at >= ? AND p.sort_at < ?
         AND p.author_did NOT IN (SELECT subject_did FROM follows WHERE muted = 1)
       ORDER BY p.uri`,
    )
    .all(start, start + DAY_MS) as DayRow[]

  const own = new Set(accounts.map((a) => a.did))
  const posts = []
  const authors = new Set<string>()
  for (const r of rows) {
    const keywords = r.kws ? judgeRow(r).kept.sort((a, b) => a - b) : []
    if (!r.followed && !keywords.length && !own.has(r.author_did)) continue
    authors.add(r.author_did)
    posts.push({
      uri: r.uri,
      cid: r.cid,
      author_did: r.author_did,
      text: r.text ?? '',
      sort_at: r.sort_at,
      reply_parent: r.reply_parent,
      reply_root: r.reply_root,
      embed: r.embed,
      is_en: r.is_en ?? 0,
      keyword_ids: keywords,
    })
  }
  const profile = db.prepare('SELECT did, handle, display_name, avatar FROM profiles WHERE did = ?')
  const profiles = [...authors].sort().map((did) => profile.get(did)).filter(Boolean)
  return { formatVersion: 1, day, posts, profiles }
}
