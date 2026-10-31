// Discover: people you don't follow who regularly post or reply on your keyword topics.
// Signals, all collected locally:
//   - on-topic posts: their keyword matches that pass your context rules (how many, on how many days)
//   - focus: what share of everything they posted recently was on-topic (sampled from their profile feed)
//   - reshared by your follows: people you follow reposted or quoted them
//   - followed by your experts: your "always show" accounts and most on-topic follows follow them
// You can audition someone (their posts are collected without following) or dismiss them.
import { AtpAgent } from '@atproto/api'
import { config } from './config.ts'
import { db, kvGet, kvSet, saveProfile } from './db.ts'
import { accounts, ownDids } from './accounts.ts'
import { judgeRow } from './rules.ts'
import { refreshWanted } from './jetstream.ts'
import { backfillNewFollow } from './backfill.ts'

db.exec(`
  CREATE TABLE IF NOT EXISTS auditions (did TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS discover_dismissed (did TEXT PRIMARY KEY, at INTEGER NOT NULL);
  -- Who each of your topic experts follows, refreshed daily
  CREATE TABLE IF NOT EXISTS expert_follows (
    expert_did TEXT NOT NULL,
    subject_did TEXT NOT NULL,
    PRIMARY KEY (expert_did, subject_did)
  );
  CREATE INDEX IF NOT EXISTS expert_follows_subject ON expert_follows(subject_did);
  -- How many posts and replies an account made in the last 14 days (from one page of their feed)
  CREATE TABLE IF NOT EXISTS author_activity (
    did TEXT PRIMARY KEY,
    posts_14d INTEGER NOT NULL,
    capped INTEGER NOT NULL, -- 1 when the sample filled up, so the real number is at least this
    sampled_at INTEGER NOT NULL
  );
`)

const AUTOMATED = /(^|[^a-z])(bot|bots|rss|feed|feeds|do not follow|automated|autopost)([^a-z]|$)/i
const DAYS = 14
const DAY = 86_400_000
const MAX_EXPERTS = 25
const SAMPLE_TOP = 120 // posting volume is sampled for this many top candidates
const publicAgent = new AtpAgent({ service: config.publicAppView })

export const discoverStatus = { refreshing: false, lastRefreshMs: Number(kvGet('discover_refreshed') ?? 0), experts: 0 }

function followedSet() {
  return new Set((db.prepare('SELECT DISTINCT subject_did FROM follows').all() as { subject_did: string }[]).map((r) => r.subject_did))
}

export function auditionDids(): string[] {
  return (db.prepare('SELECT did FROM auditions').all() as { did: string }[]).map((r) => r.did)
}

type Tally = {
  did: string
  onTopic: number
  replies: number
  days: Set<string>
  lastMs: number
  keywords: Map<number, number>
}

// On-topic keyword matches per author over the last 14 days. kw limits to one keyword.
// Judging every match against the rules is the slow part, so results are kept for a minute.
const talliesCache = new Map<string, { at: number; tallies: Map<string, Tally>; kept: Set<string> }>()
export function clearDiscoverCache() {
  talliesCache.clear()
}
function topicTallies(kw: number | null, keptUris?: Set<string>, group: number | null = null): Map<string, Tally> {
  const key = group ? `g${group}` : String(kw ?? 'all')
  const hit = talliesCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) {
    if (keptUris) for (const u of hit.kept) keptUris.add(u)
    return hit.tallies
  }
  const kept = new Set<string>()
  const tallies = computeTallies(kw, kept, group)
  talliesCache.set(key, { at: Date.now(), tallies, kept })
  if (keptUris) for (const u of kept) keptUris.add(u)
  return tallies
}

function computeTallies(kw: number | null, keptUris?: Set<string>, group: number | null = null): Map<string, Tally> {
  const since = Date.now() - DAYS * DAY
  const members = group ? `AND h.keyword_id IN (SELECT keyword_id FROM keyword_group_members WHERE group_id = ${Number(group)})` : ''
  const rows = db
    .prepare(
      `SELECT p.uri, p.author_did, p.sort_at, p.reply_parent, p.record, GROUP_CONCAT(h.keyword_id) kws
       FROM keyword_hits h JOIN posts p ON p.uri = h.uri
       WHERE h.sort_at > ? ${kw ? 'AND h.keyword_id = ?' : ''} ${members} GROUP BY p.uri`,
    )
    .all(...(kw ? [since, kw] : [since])) as {
    uri: string
    author_did: string
    sort_at: number
    reply_parent: string | null
    record: string | null
    kws: string
  }[]
  const out = new Map<string, Tally>()
  for (const r of rows) {
    const { kept } = judgeRow(r, group)
    if (!kept.length) continue
    keptUris?.add(r.uri)
    let t = out.get(r.author_did)
    if (!t) out.set(r.author_did, (t = { did: r.author_did, onTopic: 0, replies: 0, days: new Set(), lastMs: 0, keywords: new Map() }))
    t.onTopic++
    if (r.reply_parent) t.replies++
    t.days.add(new Date(r.sort_at).toISOString().slice(0, 10))
    t.lastMs = Math.max(t.lastMs, r.sort_at)
    for (const id of kept) t.keywords.set(id, (t.keywords.get(id) ?? 0) + 1)
  }
  return out
}

// Experts: accounts you marked "always show", plus the followed accounts that post most on-topic
export function expertDids(kw: number | null = null, group: number | null = null): string[] {
  const trusted = marked('trusted', kw, group)
  const followed = followedSet()
  const topFollowed = [...topicTallies(kw, undefined, group).values()]
    .filter((t) => followed.has(t.did) && t.days.size >= 2)
    .sort((a, b) => b.days.size - a.days.size || b.onTopic - a.onTopic)
    .map((t) => t.did)
  return [...new Set([...trusted, ...topFollowed])].slice(0, MAX_EXPERTS)
}

// Accounts marked always or never show, for one keyword, one group and its keywords, or everything
function marked(verdict: 'trusted' | 'blocked', kw: number | null, group: number | null): string[] {
  const rows = group
    ? db
        .prepare(
          `SELECT author_did FROM group_authors WHERE verdict = ? AND group_id = ?
           UNION SELECT author_did FROM keyword_authors WHERE verdict = ?
             AND keyword_id IN (SELECT keyword_id FROM keyword_group_members WHERE group_id = ?)`,
        )
        .all(verdict, group, verdict, group)
    : kw
      ? db.prepare('SELECT DISTINCT author_did FROM keyword_authors WHERE verdict = ? AND keyword_id = ?').all(verdict, kw)
      : db.prepare('SELECT author_did FROM keyword_authors WHERE verdict = ? UNION SELECT author_did FROM group_authors WHERE verdict = ?').all(verdict, verdict)
  return (rows as { author_did: string }[]).map((r) => r.author_did)
}

export function discover(kw: number | null, mode: string, group: number | null = null) {
  const followed = followedSet()
  const own = new Set(ownDids())
  const dismissed = new Set((db.prepare('SELECT did FROM discover_dismissed').all() as { did: string }[]).map((r) => r.did))
  const auditioning = new Set(auditionDids())
  const blockedForKw = new Set(marked('blocked', kw, group))
  const skip = (did: string) => followed.has(did) || own.has(did) || dismissed.has(did) || auditioning.has(did) || blockedForKw.has(did)

  const onTopicUris = new Set<string>()
  const tallies = topicTallies(kw, onTopicUris, group)
  const since = Date.now() - DAYS * DAY

  // Reshared by people you follow (reposts and quotes), counted by distinct follower
  const reshares = new Map<string, Set<string>>()
  const addReshare = (author: string, by: string) => {
    let s = reshares.get(author)
    if (!s) reshares.set(author, (s = new Set()))
    s.add(by)
  }
  for (const r of db
    .prepare(`SELECT author_did, subject_uri FROM reposts WHERE sort_at > ? AND author_did IN (SELECT subject_did FROM follows)`)
    .all(since) as { author_did: string; subject_uri: string | null }[]) {
    // Only reshares of on-topic posts count; your follows resharing someone's other posts says nothing about the topic
    if (!r.subject_uri || !onTopicUris.has(r.subject_uri)) continue
    addReshare(r.subject_uri.split('/')[2], r.author_did)
  }
  for (const q of db
    .prepare(
      `SELECT author_did, COALESCE(json_extract(embed, '$.record.uri'), json_extract(embed, '$.record.record.uri')) quoted
       FROM posts WHERE sort_at > ? AND embed IS NOT NULL AND author_did IN (SELECT subject_did FROM follows)`,
    )
    .all(since) as { author_did: string; quoted: string | null }[]) {
    if (!q.quoted || !onTopicUris.has(q.quoted)) continue
    addReshare(q.quoted.split('/')[2], q.author_did)
  }

  // Followed by your experts
  const experts = expertDids(kw, group)
  const expertFollows = new Map<string, number>()
  if (experts.length) {
    for (const r of db
      .prepare(
        `SELECT subject_did, COUNT(*) n FROM expert_follows WHERE expert_did IN (${experts.map(() => '?').join(',')}) GROUP BY subject_did`,
      )
      .all(...experts) as { subject_did: string; n: number }[]) {
      expertFollows.set(r.subject_did, r.n)
    }
  }

  // Only people with on-topic posts; network signals rank them but can't stand in for posting about the topic
  const candidates = new Set<string>([...tallies.keys()])

  const activity = new Map(
    (db.prepare('SELECT did, posts_14d, capped FROM author_activity').all() as { did: string; posts_14d: number; capped: number }[]).map(
      (r) => [r.did, r],
    ),
  )

  const out = []
  for (const did of candidates) {
    if (skip(did)) continue
    const t = tallies.get(did)
    const onTopic = t?.onTopic ?? 0
    const replies = t?.replies ?? 0
    const days = t?.days.size ?? 0
    const resharedBy = [...(reshares.get(did) ?? [])].filter((x) => !own.has(x)).length
    const expertCount = expertFollows.get(did) ?? 0
    // "Regularly": on-topic on 2+ different days, or on one day with 3+ of your experts following them
    if (days < 2 && !(days === 1 && expertCount >= 3)) continue
    if (mode === 'replies' && (onTopic === 0 || replies / onTopic < 0.5)) continue
    if (mode === 'posts' && (onTopic === 0 || replies / onTopic >= 0.5)) continue

    const act = activity.get(did)
    // Focus: share of their recent posts that were on-topic. A filled sample means at least that many posts.
    const focus = act && act.posts_14d > 0 ? Math.min(1, onTopic / act.posts_14d) : null

    let score = 3 * days + 2 * Math.log2(1 + onTopic) + 2 * Math.min(resharedBy, 5) + 2 * Math.min(expertCount, 5)
    // Focus: people who mostly post about your topics beat big accounts that touch on them now and then
    if (focus !== null) score *= 0.4 + 0.6 * Math.min(1, focus * 4) // full credit from 25% on-topic
    // Dozens of on-topic posts a day is usually a bot or news feed
    const perDay = onTopic / Math.max(days, 1)
    const highVolume = perDay > 40
    if (highVolume) score *= 0.5

    out.push({
      did,
      onTopic,
      replies,
      days,
      lastMs: t?.lastMs ?? 0,
      keywords: t ? [...t.keywords].sort((a, b) => b[1] - a[1]).map(([id]) => id) : [],
      resharedBy,
      experts: expertCount,
      focus,
      focusCapped: !!act?.capped,
      highVolume,
      score: Math.round(score * 10) / 10,
    })
  }
  out.sort((a, b) => b.score - a.score)
  const top = out.slice(0, 100)

  // Names and avatars
  if (top.length) {
    const profiles = new Map(
      (db.prepare(`SELECT did, handle, display_name, avatar, followers_count FROM profiles WHERE did IN (${top.map(() => '?').join(',')})`).all(
        ...top.map((c) => c.did),
      ) as { did: string; handle: string | null; display_name: string | null; avatar: string | null; followers_count: number | null }[]).map(
        (p) => [p.did, p],
      ),
    )
    for (const c of top as any[]) {
      const p = profiles.get(c.did)
      c.handle = p?.handle ?? c.did
      c.displayName = p?.display_name ?? null
      c.avatar = p?.avatar ?? null
      // Accounts that say they're automated ("…-bot", "RSS feed", "Do not follow") rank lower
      c.automated = AUTOMATED.test(`${c.handle} ${c.displayName ?? ''}`)
      if (c.automated) c.score = Math.round(c.score * 0.5 * 10) / 10
    }
    top.sort((a, b) => b.score - a.score)
  }
  return {
    candidates: top,
    experts: experts.length,
    expertsFetched: discoverStatus.experts,
    days: DAYS,
    historyDays: historyDays(),
    refreshing: discoverStatus.refreshing,
    lastRefreshMs: discoverStatus.lastRefreshMs,
  }
}

function historyDays() {
  const row = db.prepare('SELECT MIN(sort_at) m FROM keyword_hits').get() as { m: number | null }
  return row.m ? Math.min(DAYS, Math.round(((Date.now() - row.m) / DAY) * 10) / 10) : 0
}

// ---------- background refresh: experts' follows and candidates' posting volume ----------

let nextSlot = 0
async function throttle(perSecond = 4) {
  const now = Date.now()
  const wait = Math.max(0, nextSlot - now)
  nextSlot = Math.max(now, nextSlot) + 1000 / perSecond
  if (wait) await new Promise((r) => setTimeout(r, wait))
}

async function fetchExpertFollows(expert: string) {
  const subjects: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    await throttle()
    const res = await publicAgent.app.bsky.graph.getFollows({ actor: expert, limit: 100, cursor })
    for (const f of res.data.follows) subjects.push(f.did)
    cursor = res.data.cursor
    if (!cursor) break
  }
  const insert = db.prepare('INSERT OR IGNORE INTO expert_follows (expert_did, subject_did) VALUES (?, ?)')
  db.exec('BEGIN')
  db.prepare('DELETE FROM expert_follows WHERE expert_did = ?').run(expert)
  for (const s of subjects) insert.run(expert, s)
  db.exec('COMMIT')
}

async function sampleActivity(did: string) {
  await throttle()
  const res = await publicAgent.app.bsky.feed.getAuthorFeed({ actor: did, limit: 100, filter: 'posts_with_replies' })
  const since = Date.now() - DAYS * DAY
  const own = res.data.feed.filter((i) => !i.reason && i.post.author.did === did)
  const recent = own.filter((i) => Date.parse(i.post.indexedAt) > since).length
  const capped = own.length >= 90 && recent === own.length ? 1 : 0
  db.prepare(
    `INSERT INTO author_activity (did, posts_14d, capped, sampled_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(did) DO UPDATE SET posts_14d = excluded.posts_14d, capped = excluded.capped, sampled_at = excluded.sampled_at`,
  ).run(did, recent, capped, Date.now())
}

export async function refreshDiscover() {
  if (discoverStatus.refreshing || !accounts.some((a) => a.ok)) return
  discoverStatus.refreshing = true
  try {
    const experts = expertDids()
    for (const e of experts) {
      try {
        await fetchExpertFollows(e)
      } catch {
        // Some accounts hide their follows from signed-out viewers; skip them
      }
    }
    discoverStatus.experts = experts.length
    // Names and avatars for candidates Skydash hasn't seen yet (e.g. found through experts' follows)
    const missing = discover(null, 'all').candidates.filter((c: any) => c.handle === c.did).map((c) => c.did)
    for (let i = 0; i < missing.length; i += 25) {
      try {
        await throttle()
        const res = await publicAgent.app.bsky.actor.getProfiles({ actors: missing.slice(i, i + 25) })
        for (const p of res.data.profiles) {
          saveProfile(p)
          db.prepare('UPDATE profiles SET followers_count = ? WHERE did = ?').run(p.followersCount ?? null, p.did)
        }
      } catch {}
    }
    // Sample posting volume for the top candidates whose sample is missing or older than a day
    const { candidates } = discover(null, 'all')
    const stale = db.prepare('SELECT sampled_at FROM author_activity WHERE did = ?')
    for (const c of candidates.slice(0, SAMPLE_TOP)) {
      const row = stale.get(c.did) as { sampled_at: number } | undefined
      if (row && Date.now() - row.sampled_at < DAY) continue
      try {
        await sampleActivity(c.did)
      } catch {}
    }
    discoverStatus.lastRefreshMs = Date.now()
    kvSet('discover_refreshed', String(discoverStatus.lastRefreshMs))
  } finally {
    discoverStatus.refreshing = false
  }
}

export function startDiscoverRefresh() {
  // First run a minute after startup (sign-in and follow sync go first), then every 6 hours
  setTimeout(() => refreshDiscover().catch(() => {}), 60_000)
  setInterval(() => refreshDiscover().catch(() => {}), 6 * 3_600_000)
}

// ---------- actions ----------

export function dismiss(did: string, undo = false) {
  if (undo) db.prepare('DELETE FROM discover_dismissed WHERE did = ?').run(did)
  else db.prepare('INSERT OR REPLACE INTO discover_dismissed (did, at) VALUES (?, ?)').run(did, Date.now())
}

// Auditioning collects someone's posts live (and their last 14 days) without following them
export function audition(did: string, start: boolean) {
  if (start) {
    db.prepare('INSERT OR IGNORE INTO auditions (did, started_at) VALUES (?, ?)').run(did, Date.now())
    backfillNewFollow(did)
  } else {
    db.prepare('DELETE FROM auditions WHERE did = ?').run(did)
  }
  refreshWanted()
}

// Each auditioned account: posts since the audition started, how many were on-topic, and 14-day totals
export function auditionList() {
  const rows = db
    .prepare(
      `SELECT a.did, a.started_at, p.handle, p.display_name, p.avatar FROM auditions a LEFT JOIN profiles p ON p.did = a.did
       ORDER BY a.started_at DESC`,
    )
    .all() as { did: string; started_at: number; handle: string | null; display_name: string | null; avatar: string | null }[]
  const followed = followedSet()
  return rows.map((r) => {
    const posts = db
      .prepare(
        `SELECT p.uri, p.author_did, p.record, (SELECT GROUP_CONCAT(keyword_id) FROM keyword_hits h WHERE h.uri = p.uri) kws
         FROM posts p WHERE p.author_did = ? AND p.sort_at > ?`,
      )
      .all(r.did, r.started_at) as { uri: string; author_did: string; record: string | null; kws: string | null }[]
    const onTopic = posts.filter((p) => p.kws && judgeRow(p).kept.length).length
    const recent = (db.prepare('SELECT COUNT(*) n FROM posts WHERE author_did = ? AND sort_at > ?').get(r.did, Date.now() - DAYS * DAY) as {
      n: number
    }).n
    return {
      did: r.did,
      handle: r.handle ?? r.did,
      displayName: r.display_name,
      avatar: r.avatar,
      startedAt: r.started_at,
      postsSince: posts.length,
      onTopicSince: onTopic,
      posts14d: recent,
      followed: followed.has(r.did),
    }
  })
}
