// Another account's follows, with the same 14-day stats the Follows tab shows for your own (decision #23).
// Read from the public AppView, four accounts at a time and at most about 8 requests a second, kept for
// 24 hours in their own tables. Nothing here goes into `posts`, so it never shows up in your feeds.
import { config } from './config.ts'
import { db } from './db.ts'
import { accounts } from './accounts.ts'
import { createHash } from 'node:crypto'

const KEEP_MS = 24 * 3_600_000
const WORKERS = 4
const MIN_GAP_MS = 125 // between request starts, so at most 8 a second
const MAX_FOLLOWS = 10_000
const MAX_GROUP = 10

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

function addColumn(table: string, column: string, type: string) {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}
addColumn('ext_stats', 'capped', 'INTEGER NOT NULL DEFAULT 0')
// When this account's 14 days were read, so other analyses within the day can reuse them (decision #24)
addColumn('ext_stats', 'read_at', 'INTEGER')
// 0 when the analysis only ran as part of a group, so the recent list shows what you looked up yourself
addColumn('ext_analyses', 'solo', 'INTEGER NOT NULL DEFAULT 1')
db.exec(`
  CREATE TABLE IF NOT EXISTS ext_groups (
    id TEXT PRIMARY KEY,
    members TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS ext_stats_did ON ext_stats(did, read_at);
`)

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

// One account is read at a time; a group reads its members one after another
let running: string | null = null
let groupRunning: string | null = null

const fresh = (s: { finishedAt: number | null; error: string | null } | null) =>
  !!s?.finishedAt && !s.error && Date.now() - s.finishedAt < KEEP_MS

function status(did: string) {
  const a = db.prepare('SELECT * FROM ext_analyses WHERE target_did = ?').get(did) as any
  if (!a) return null
  return {
    kind: 'single' as const,
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

function busyError() {
  const other = running ? status(running) : null
  const what = groupRunning ? 'a group' : `@${other?.handle ?? 'another account'}`
  return new AnalyzeError(409, `Still reading ${what} (${other?.done ?? 0} of ${other?.total ?? '?'}); try again when it finishes`)
}

function checkSize(profile: any) {
  if ((profile.followsCount ?? 0) > MAX_FOLLOWS) {
    throw new AnalyzeError(400, `@${profile.handle} follows ${profile.followsCount.toLocaleString()} accounts; the limit is ${MAX_FOLLOWS.toLocaleString()}`)
  }
}

// Sets up the analysis row for one account and clears its old results
function prepare(profile: any, solo: boolean) {
  db.prepare(`INSERT INTO ext_analyses (target_did, handle, display_name, avatar, started_at, total, done, solo)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(target_did) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name, avatar = excluded.avatar,
      started_at = excluded.started_at, finished_at = NULL, total = excluded.total, done = 0, error = NULL,
      solo = MAX(ext_analyses.solo, excluded.solo)`)
    .run(profile.did, profile.handle, profile.displayName ?? null, profile.avatar ?? null, Date.now(), profile.followsCount ?? 0, solo ? 1 : 0)
  db.prepare('DELETE FROM ext_stats WHERE target_did = ?').run(profile.did)
}

async function runOne(did: string, handle: string) {
  running = did
  try {
    await run(did)
  } catch (err: any) {
    console.error(`Analysis of ${handle} failed`, err)
    db.prepare('UPDATE ext_analyses SET error = ?, finished_at = ? WHERE target_did = ?').run(err?.message ?? String(err), Date.now(), did)
  } finally {
    running = null
  }
}

function cleanActor(text: unknown) {
  return String(text ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/bsky\.app\/profile\//, '').replace(/\/.*$/, '')
}

export async function startAnalysis(body: any) {
  const actor = cleanActor(body.handle)
  if (!actor) throw new AnalyzeError(400, 'Type a Bluesky handle')
  const profile = await xrpc('app.bsky.actor.getProfile', { actor }).catch((err) => {
    throw new AnalyzeError(404, `Couldn't find @${actor}: ${err.message}`)
  })
  const prev = status(profile.did)
  if (prev?.running) return prev
  if (fresh(prev) && !body.refresh) {
    db.prepare('UPDATE ext_analyses SET solo = 1 WHERE target_did = ?').run(profile.did)
    return status(profile.did)
  }
  if (running || groupRunning) throw busyError()
  checkSize(profile)
  prepare(profile, true)
  runOne(profile.did, profile.handle)
  return status(profile.did)
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

  // 3. Each one's last 14 days, four at a time. Accounts another analysis read within the day are copied, not read again.
  const save = db.prepare(`UPDATE ext_stats SET posts = ?, replies = ?, reposts = ?, last_active_ms = ?, capped = ?, read_at = ?, read_ok = 1
    WHERE target_did = ? AND did = ?`)
  const known = db.prepare(`SELECT posts, replies, reposts, last_active_ms, capped, read_at FROM ext_stats
    WHERE did = ? AND read_ok = 1 AND read_at > ? AND target_did != ? ORDER BY read_at DESC LIMIT 1`)
  const progress = db.prepare('UPDATE ext_analyses SET done = done + 1 WHERE target_did = ?')
  let next = 0
  const worker = async () => {
    while (next < follows.length) {
      const f = follows[next++]
      try {
        const k = known.get(f.did, Date.now() - KEEP_MS, target) as any
        if (k) save.run(k.posts, k.replies, k.reposts, k.last_active_ms, k.capped, k.read_at, target, f.did)
        else {
          const a = await activity(f.did)
          save.run(a.posts, a.replies, a.reposts, a.last || null, a.capped ? 1 : 0, Date.now(), target, f.did)
        }
      } catch {
        // Deleted, deactivated or blocked from public view: leave its numbers empty
      }
      progress.run(target)
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
  db.prepare('UPDATE ext_analyses SET finished_at = ?, error = NULL WHERE target_did = ?').run(Date.now(), target)
}

// ---------- groups (decision #24) ----------

function groupMembers(id: string): string[] {
  const g = db.prepare('SELECT members FROM ext_groups WHERE id = ?').get(id) as any
  if (!g) throw new AnalyzeError(404, 'No analysis for that group')
  return JSON.parse(g.members)
}

function groupStatus(id: string) {
  const g = db.prepare('SELECT * FROM ext_groups WHERE id = ?').get(id) as any
  if (!g) return null
  const members = (JSON.parse(g.members) as string[]).map((d) => status(d) ?? { did: d, handle: d, total: 0, done: 0, finishedAt: null, error: 'Not read', running: false } as any)
  const errors = members.filter((m) => m.error).map((m) => `@${m.handle}: ${m.error}`)
  return {
    kind: 'group' as const,
    id: g.id,
    members: members.map((m) => ({ did: m.did, handle: m.handle, displayName: m.displayName, avatar: m.avatar, total: m.total, done: m.done, finishedAt: m.finishedAt, error: m.error })),
    startedAt: g.started_at,
    finishedAt: g.finished_at,
    total: members.reduce((n, m) => n + (m.total ?? 0), 0),
    done: members.reduce((n, m) => n + (fresh(m) ? m.total : m.done ?? 0), 0),
    error: groupRunning === id ? null : errors.join('; ') || null,
    running: groupRunning === id,
  }
}

// Up to 10 accounts analysed together. Members read within the day are reused; the rest are read in turn.
export async function startGroup(body: any) {
  const dids = [...new Set((Array.isArray(body.dids) ? body.dids : []).map(String))].filter((d) => d.startsWith('did:'))
  if (dids.length < 2) throw new AnalyzeError(400, 'Choose at least 2 accounts')
  if (dids.length > MAX_GROUP) throw new AnalyzeError(400, `Choose at most ${MAX_GROUP} accounts`)
  const id = 'g' + createHash('sha1').update([...dids].sort().join(',')).digest('hex').slice(0, 12)
  const prev = groupStatus(id)
  if (prev?.running) return prev
  const res = await xrpc('app.bsky.actor.getProfiles', { actors: dids })
  const profiles = res.profiles ?? []
  if (profiles.length < 2) throw new AnalyzeError(404, "Couldn't find those accounts")
  for (const p of profiles) checkSize(p)
  const todo = profiles.filter((p: any) => body.refresh || !fresh(status(p.did)))
  if (todo.length && (running || groupRunning)) throw busyError()
  const order = profiles.map((p: any) => p.did)
  db.prepare(`INSERT INTO ext_groups (id, members, started_at, finished_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET members = excluded.members, started_at = excluded.started_at, finished_at = excluded.finished_at`)
    .run(id, JSON.stringify(order), Date.now(), todo.length ? null : Date.now())
  if (!todo.length) return groupStatus(id)
  for (const p of todo) prepare(p, false)
  groupRunning = id
  ;(async () => {
    try {
      for (const p of todo) await runOne(p.did, p.handle)
    } finally {
      groupRunning = null
      db.prepare('UPDATE ext_groups SET finished_at = ? WHERE id = ?').run(Date.now(), id)
    }
  })()
  return groupStatus(id)
}

// ---------- reading results ----------

export function analysisStatus(did: unknown) {
  const s = status(String(did ?? ''))
  if (!s) throw new AnalyzeError(404, 'No analysis for that account')
  return s
}

export function analysisGroupStatus(id: unknown) {
  const s = groupStatus(String(id ?? ''))
  if (!s) throw new AnalyzeError(404, 'No analysis for that group')
  return s
}

// Analyses and groups still within their 24 hours, newest first
export function recentAnalyses() {
  const since = Date.now() - KEEP_MS
  const singles = (db.prepare('SELECT target_did FROM ext_analyses WHERE started_at > ? AND solo = 1').all(since) as any[]).map((r) => status(r.target_did)!)
  const groups = (db.prepare('SELECT id FROM ext_groups WHERE started_at > ?').all(since) as any[]).map((r) => groupStatus(r.id)!)
  return [...singles, ...groups].sort((a, b) => b.startedAt - a.startedAt)
}

// Rows in the same shape as the Follows tab's. "By" is which of your accounts follow them; "Interacted" is how
// often they've interacted with your accounts, from your notifications. For a group, `members` lists which of
// the group follow each one and `followsTargetCount` how many of the group they follow back.
function buildRows(targets: string[]) {
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
  const marks = targets.map(() => '?').join(',')
  const inter = new Map<string, { n: number; last: number; bySlot: Record<number, number> }>()
  for (const r of db.prepare(`SELECT author_did, account_did, COUNT(*) n, MAX(at_ms) last FROM interactions
      WHERE author_did IN (SELECT did FROM ext_stats WHERE target_did IN (${marks})) GROUP BY author_did, account_did`).all(...targets) as any[]) {
    const x = inter.get(r.author_did) ?? { n: 0, last: 0, bySlot: {} }
    x.n += r.n
    x.last = Math.max(x.last, r.last)
    const slot = slotOf.get(r.account_did)
    if (slot) x.bySlot[slot] = r.n
    inter.set(r.author_did, x)
  }
  const byDid = new Map<string, any>()
  for (const r of db.prepare(`SELECT * FROM ext_stats WHERE target_did IN (${marks})`).all(...targets) as any[]) {
    if (own.has(r.did)) continue
    const cur = byDid.get(r.did)
    if (!cur) {
      byDid.set(r.did, { ...r, members: [r.target_did], backCount: r.follows_target ? 1 : 0 })
      continue
    }
    cur.members.push(r.target_did)
    if (r.follows_target) cur.backCount++
    // Keep whichever copy has its numbers read
    if (!cur.read_ok && r.read_ok) Object.assign(cur, { ...r, members: cur.members, backCount: cur.backCount })
  }
  return [...byDid.values()].map((r) => {
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
      followsTarget: r.backCount > 0,
      followsTargetCount: r.backCount,
      members: r.members,
      groupCount: r.members.length,
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
}

export function analysisRows(did: unknown) {
  const s = analysisStatus(did)
  return { status: s, days: config.statsDays, rows: buildRows([s.did]) }
}

export function analysisGroupRows(id: unknown) {
  const s = analysisGroupStatus(id)
  return { status: s, days: config.statsDays, rows: buildRows(groupMembers(s.id)) }
}

// Old analyses and groups are dropped a day after they expire
export function pruneAnalyses() {
  const cutoff = Date.now() - 2 * KEEP_MS
  const old = db.prepare('SELECT target_did FROM ext_analyses WHERE started_at < ?').all(cutoff) as any[]
  for (const a of old) {
    if (a.target_did === running) continue
    db.prepare('DELETE FROM ext_stats WHERE target_did = ?').run(a.target_did)
    db.prepare('DELETE FROM ext_analyses WHERE target_did = ?').run(a.target_did)
  }
  if (!groupRunning) db.prepare('DELETE FROM ext_groups WHERE started_at < ?').run(cutoff)
}

// Anything cut short by a restart is marked as such, so it can be run again
db.prepare("UPDATE ext_analyses SET error = 'Interrupted by a restart', finished_at = ? WHERE finished_at IS NULL").run(Date.now())
db.prepare('UPDATE ext_groups SET finished_at = ? WHERE finished_at IS NULL').run(Date.now())
