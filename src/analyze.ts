// Another account's follows, with the same 14-day stats the Follows tab shows for your own (decision #23).
// Read from the public AppView, four accounts at a time and at most about 8 requests a second, kept for
// 24 hours in their own tables. Nothing here goes into `posts`, so it never shows up in your feeds.
import { config } from './config.ts'
import { db } from './db.ts'
import { accounts } from './accounts.ts'

const KEEP_MS = 24 * 3_600_000
const WORKERS = 4
const MIN_GAP_MS = 125 // between request starts, so at most 8 a second
const MAX_FOLLOWS = 10_000

db.exec(`
  CREATE TABLE IF NOT EXISTS ext_analyses (
    target_did TEXT PRIMARY KEY,
    handle TEXT,
    display_name TEXT,
    avatar TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS ext_stats (
    target_did TEXT NOT NULL,
    did TEXT NOT NULL,
    handle TEXT,
    display_name TEXT,
    avatar TEXT,
    followers_count INTEGER,
    follows_target INTEGER,
    posts INTEGER,
    replies INTEGER,
    reposts INTEGER,
    last_active_ms INTEGER,
    read_ok INTEGER NOT NULL DEFAULT 0,
    capped INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (target_did, did)
  );
`)

if (!(db.prepare('PRAGMA table_info(ext_stats)').all() as { name: string }[]).some((c) => c.name === 'capped')) {
  db.exec('ALTER TABLE ext_stats ADD COLUMN capped INTEGER NOT NULL DEFAULT 0')
}

class AnalyzeError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------- public AppView, rate-limited ----------

let nextSlot = 0
async function xrpc(method: string, params: Record<string, string | string[] | number | undefined>) {
  const url = new URL(`${config.publicAppView}/xrpc/${method}`)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(one))
  }
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, nextSlot - Date.now())
    nextSlot = Math.max(nextSlot, Date.now()) + MIN_GAP_MS
    if (wait) await new Promise((r) => setTimeout(r, wait))
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (res.ok) {
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        // Some posts carry raw control characters that strict JSON refuses
        return JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '))
      }
    }
    // Rate limited or a hiccup: back off and try again a couple of times
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)))
      continue
    }
    const body = await res.json().catch(() => ({}))
    throw new AnalyzeError(res.status === 400 ? 404 : 502, body.message || `Bluesky answered ${res.status}`)
  }
}

// ---------- one account's last 14 days ----------

async function activity(did: string) {
  const since = Date.now() - config.statsDays * 86_400_000
  let posts = 0
  let replies = 0
  let reposts = 0
  let last = 0
  let capped = false
  let cursor: string | undefined
  for (let page = 0; page < 2; page++) {
    const res = await xrpc('app.bsky.feed.getAuthorFeed', { actor: did, filter: 'posts_with_replies', limit: 100, cursor })
    let older = false
    for (const item of res.feed ?? []) {
      const reason = item.reason?.$type
      if (reason === 'app.bsky.feed.defs#reasonPin') continue
      const at = Date.parse(reason ? item.reason.indexedAt : item.post?.indexedAt) || 0
      last = Math.max(last, at)
      if (at < since) {
        older = true
        continue
      }
      if (reason === 'app.bsky.feed.defs#reasonRepost') reposts++
      else if (item.post?.author?.did === did) item.post.record?.reply ? replies++ : posts++
    }
    cursor = res.cursor
    if (older || !cursor) break
    // Two full pages still inside the 14 days: the real numbers are higher than these
    if (page === 1) capped = true
  }
  return { posts, replies, reposts, last, capped }
}

// ---------- running an analysis ----------

let running: string | null = null

function status(did: string) {
  const a = db.prepare('SELECT * FROM ext_analyses WHERE target_did = ?').get(did) as any
  if (!a) return null
  return {
    did: a.target_did,
    handle: a.handle,
    displayName: a.display_name,
    avatar: a.avatar,
    startedAt: a.started_at,
    finishedAt: a.finished_at,
    total: a.total,
    done: a.done,
    error: a.error,
    running: running === did,
  }
}

export async function startAnalysis(body: any) {
  const actor = String(body.handle ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/bsky\.app\/profile\//, '').replace(/\/.*$/, '')
  if (!actor) throw new AnalyzeError(400, 'Type a Bluesky handle')
  const profile = await xrpc('app.bsky.actor.getProfile', { actor }).catch((err) => {
    throw new AnalyzeError(404, `Couldn't find @${actor}: ${err.message}`)
  })
  const did = profile.did as string
  const prev = status(did)
  const fresh = prev?.finishedAt && !prev.error && Date.now() - prev.finishedAt < KEEP_MS
  if (prev?.running || (fresh && !body.refresh)) return prev
  if (running) {
    const other = status(running)
    throw new AnalyzeError(409, `Still reading @${other?.handle ?? 'another account'} (${other?.done ?? 0} of ${other?.total ?? '?'}); try again when it finishes`)
  }
  if ((profile.followsCount ?? 0) > MAX_FOLLOWS) {
    throw new AnalyzeError(400, `@${profile.handle} follows ${profile.followsCount.toLocaleString()} accounts; the limit is ${MAX_FOLLOWS.toLocaleString()}`)
  }
  db.prepare(`INSERT OR REPLACE INTO ext_analyses (target_did, handle, display_name, avatar, started_at, total, done)
    VALUES (?, ?, ?, ?, ?, ?, 0)`).run(did, profile.handle, profile.displayName ?? null, profile.avatar ?? null, Date.now(), profile.followsCount ?? 0)
  db.prepare('DELETE FROM ext_stats WHERE target_did = ?').run(did)
  running = did
  run(did).catch((err) => {
    console.error(`Analysis of ${profile.handle} failed`, err)
    db.prepare('UPDATE ext_analyses SET error = ?, finished_at = ? WHERE target_did = ?').run(err?.message ?? String(err), Date.now(), did)
  }).finally(() => {
    running = null
  })
  return status(did)
}

async function run(target: string) {
  // 1. Who they follow
  const follows: { did: string; handle: string; displayName?: string; avatar?: string }[] = []
  let cursor: string | undefined
  do {
    const res = await xrpc('app.bsky.graph.getFollows', { actor: target, limit: 100, cursor })
    for (const p of res.follows ?? []) follows.push({ did: p.did, handle: p.handle, displayName: p.displayName, avatar: p.avatar })
    cursor = res.cursor
  } while (cursor && follows.length < MAX_FOLLOWS)
  db.prepare('UPDATE ext_analyses SET total = ? WHERE target_did = ?').run(follows.length, target)
  const insert = db.prepare(`INSERT OR REPLACE INTO ext_stats (target_did, did, handle, display_name, avatar) VALUES (?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  for (const f of follows) insert.run(target, f.did, f.handle, f.displayName ?? null, f.avatar ?? null)
  db.exec('COMMIT')

  // 2. Follower counts (25 a call) and whether each follows them back (30 a call)
  const counts = db.prepare('UPDATE ext_stats SET followers_count = ? WHERE target_did = ? AND did = ?')
  for (let i = 0; i < follows.length; i += 25) {
    const res = await xrpc('app.bsky.actor.getProfiles', { actors: follows.slice(i, i + 25).map((f) => f.did) })
    for (const p of res.profiles ?? []) counts.run(p.followersCount ?? null, target, p.did)
  }
  const back = db.prepare('UPDATE ext_stats SET follows_target = ? WHERE target_did = ? AND did = ?')
  for (let i = 0; i < follows.length; i += 30) {
    const res = await xrpc('app.bsky.graph.getRelationships', { actor: target, others: follows.slice(i, i + 30).map((f) => f.did) })
    for (const r of res.relationships ?? []) if (r.did) back.run(r.followedBy ? 1 : 0, target, r.did)
  }

  // 3. Each one's last 14 days, four at a time
  const save = db.prepare(`UPDATE ext_stats SET posts = ?, replies = ?, reposts = ?, last_active_ms = ?, capped = ?, read_ok = 1
    WHERE target_did = ? AND did = ?`)
  const progress = db.prepare('UPDATE ext_analyses SET done = done + 1 WHERE target_did = ?')
  let next = 0
  const worker = async () => {
    while (next < follows.length) {
      const f = follows[next++]
      try {
        const a = await activity(f.did)
        save.run(a.posts, a.replies, a.reposts, a.last || null, a.capped ? 1 : 0, target, f.did)
      } catch {
        // Deleted, deactivated or blocked from public view: leave its numbers empty
      }
      progress.run(target)
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
  db.prepare('UPDATE ext_analyses SET finished_at = ?, error = NULL WHERE target_did = ?').run(Date.now(), target)
}

// ---------- reading results ----------

export function analysisStatus(did: unknown) {
  const s = status(String(did ?? ''))
  if (!s) throw new AnalyzeError(404, 'No analysis for that account')
  return s
}

// Analyses still within their 24 hours, newest first
export function recentAnalyses() {
  const rows = db.prepare('SELECT target_did FROM ext_analyses WHERE started_at > ? ORDER BY started_at DESC').all(Date.now() - KEEP_MS) as any[]
  return rows.map((r) => status(r.target_did))
}

// Rows in the same shape as the Follows tab's, plus followsTarget. "By" is which of your accounts follow them;
// "Interacted" is how often they've interacted with your accounts, from your notifications.
export function analysisRows(did: unknown) {
  const target = String(did ?? '')
  const s = analysisStatus(target)
  const own = new Set(accounts.map((a) => a.did).filter(Boolean))
  const slotOf = new Map(accounts.filter((a) => a.did).map((a) => [a.did!, a.slot]))
  const mine = new Map<string, { followedBy: number[]; followsBack: number[]; muted: number[] }>()
  for (const f of db.prepare('SELECT account_did, subject_did, follows_back, muted FROM follows').all() as any[]) {
    const slot = slotOf.get(f.account_did)
    if (!slot) continue
    const m = mine.get(f.subject_did) ?? { followedBy: [], followsBack: [], muted: [] }
    m.followedBy.push(slot)
    if (f.follows_back) m.followsBack.push(slot)
    if (f.muted) m.muted.push(slot)
    mine.set(f.subject_did, m)
  }
  const inter = new Map<string, { n: number; last: number; bySlot: Record<number, number> }>()
  for (const r of db.prepare(`SELECT i.author_did, i.account_did, COUNT(*) n, MAX(i.at_ms) last FROM interactions i
      JOIN ext_stats e ON e.did = i.author_did AND e.target_did = ? GROUP BY i.author_did, i.account_did`).all(target) as any[]) {
    const x = inter.get(r.author_did) ?? { n: 0, last: 0, bySlot: {} }
    x.n += r.n
    x.last = Math.max(x.last, r.last)
    const slot = slotOf.get(r.account_did)
    if (slot) x.bySlot[slot] = r.n
    inter.set(r.author_did, x)
  }
  const rows = (db.prepare('SELECT * FROM ext_stats WHERE target_did = ?').all(target) as any[])
    .filter((r) => !own.has(r.did))
    .map((r) => {
      const m = mine.get(r.did) ?? { followedBy: [], followsBack: [], muted: [] }
      const i = inter.get(r.did)
      const total = (r.posts ?? 0) + (r.replies ?? 0) + (r.reposts ?? 0)
      return {
        did: r.did,
        handle: r.handle,
        displayName: r.display_name,
        avatar: r.avatar,
        followersCount: r.followers_count,
        followedBy: m.followedBy.sort(),
        followsBack: m.followsBack,
        muted: m.muted,
        followsTarget: !!r.follows_target,
        read: !!r.read_ok,
        capped: !!r.capped,
        posts: r.posts ?? 0,
        replies: r.replies ?? 0,
        reposts: r.reposts ?? 0,
        repostShare: r.read_ok && total ? r.reposts / total : null,
        lastActiveMs: r.last_active_ms ?? 0,
        interactions: i?.n ?? 0,
        interactionsBySlot: i?.bySlot ?? {},
        lastInteractionMs: i?.last ?? 0,
        gone: false,
      }
    })
  return { status: s, days: config.statsDays, rows }
}

// Old analyses are dropped a day after they expire
export function pruneAnalyses() {
  const old = db.prepare('SELECT target_did FROM ext_analyses WHERE started_at < ?').all(Date.now() - 2 * KEEP_MS) as any[]
  for (const a of old) {
    if (a.target_did === running) continue
    db.prepare('DELETE FROM ext_stats WHERE target_did = ?').run(a.target_did)
    db.prepare('DELETE FROM ext_analyses WHERE target_did = ?').run(a.target_did)
  }
}

// An analysis cut short by a restart is marked as such, so it can be run again
db.prepare("UPDATE ext_analyses SET error = 'Interrupted by a restart', finished_at = ? WHERE finished_at IS NULL").run(Date.now())
