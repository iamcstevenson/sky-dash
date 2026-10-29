// Follow stats (14-day activity, overlap, follow-back, interactions) and the actions
// that change your follow graph: unfollow, follow, mute, add to list.
import { config } from './config.ts'
import { db } from './db.ts'
import { accounts, type Account } from './accounts.ts'
import { refreshWanted } from './jetstream.ts'
import { backfillNewFollow } from './backfill.ts'

const MAX_BATCH = 200

type Row = Record<string, any>

export function followStats() {
  const since = Date.now() - config.statsDays * 86_400_000
  const slotOf = new Map(accounts.filter((a) => a.did).map((a) => [a.did!, a.slot]))
  const byDid = new Map<string, Row>()

  const follows = db
    .prepare(
      `SELECT f.account_did, f.subject_did, f.follows_back, f.muted,
        p.handle, p.display_name, p.avatar, p.posts_count, p.followers_count, p.follows_count, p.joined_at, p.last_active_ms
       FROM follows f LEFT JOIN profiles p ON p.did = f.subject_did`,
    )
    .all() as Row[]
  for (const f of follows) {
    const slot = slotOf.get(f.account_did)
    if (!slot) continue
    let r = byDid.get(f.subject_did)
    if (!r) {
      r = {
        did: f.subject_did,
        handle: f.handle,
        displayName: f.display_name,
        avatar: f.avatar,
        postsCount: f.posts_count,
        followersCount: f.followers_count,
        followsCount: f.follows_count,
        joinedAt: f.joined_at,
        lastActiveMs: f.last_active_ms ?? 0,
        followedBy: [],
        followsBack: [],
        muted: [],
        posts: 0,
        replies: 0,
        reposts: 0,
        interactions: 0,
        interactionsBySlot: {},
        lastInteractionMs: 0,
      }
      byDid.set(f.subject_did, r)
    }
    r.followedBy.push(slot)
    if (f.follows_back) r.followsBack.push(slot)
    if (f.muted) r.muted.push(slot)
  }

  const activity = db
    .prepare(
      `SELECT author_did, SUM(reply_parent IS NULL) posts, SUM(reply_parent IS NOT NULL) replies, MAX(sort_at) last
       FROM posts WHERE sort_at > ? AND author_did IN (SELECT subject_did FROM follows) GROUP BY author_did`,
    )
    .all(since) as Row[]
  for (const a of activity) {
    const r = byDid.get(a.author_did)
    if (!r) continue
    r.posts = a.posts
    r.replies = a.replies
    r.lastActiveMs = Math.max(r.lastActiveMs, a.last)
  }

  const reposts = db
    .prepare(
      `SELECT author_did, COUNT(*) n, MAX(sort_at) last FROM reposts
       WHERE sort_at > ? AND author_did IN (SELECT subject_did FROM follows) GROUP BY author_did`,
    )
    .all(since) as Row[]
  for (const a of reposts) {
    const r = byDid.get(a.author_did)
    if (!r) continue
    r.reposts = a.n
    r.lastActiveMs = Math.max(r.lastActiveMs, a.last)
  }

  const inter = db
    .prepare(
      `SELECT author_did, account_did, COUNT(*) n, MAX(at_ms) last FROM interactions
       WHERE author_did IN (SELECT subject_did FROM follows) GROUP BY author_did, account_did`,
    )
    .all() as Row[]
  for (const i of inter) {
    const r = byDid.get(i.author_did)
    const slot = slotOf.get(i.account_did)
    if (!r || !slot) continue
    r.interactions += i.n
    r.interactionsBySlot[slot] = i.n
    r.lastInteractionMs = Math.max(r.lastInteractionMs, i.last)
  }

  for (const r of byDid.values()) {
    r.followedBy.sort()
    const total = r.posts + r.replies + r.reposts
    r.repostShare = total ? r.reposts / total : null
  }
  return [...byDid.values()]
}

function signedIn(slots: number[]): Account[] {
  const list = accounts.filter((a) => a.ok && a.did && slots.includes(a.slot))
  if (!list.length) throw Object.assign(new Error('Choose at least one signed-in account'), { status: 400 })
  return list
}

function checkBatch(dids: unknown): string[] {
  if (!Array.isArray(dids) || !dids.length) throw Object.assign(new Error('No accounts selected'), { status: 400 })
  if (dids.length > MAX_BATCH) throw Object.assign(new Error(`At most ${MAX_BATCH} at a time`), { status: 400 })
  return dids.map(String)
}

// Runs one write per (did, account) pair, one at a time, collecting failures instead of stopping
async function each(dids: string[], accts: Account[], fn: (a: Account, did: string) => Promise<boolean>) {
  let done = 0
  const failed: { did: string; slot: number; error: string }[] = []
  for (const did of dids) {
    for (const a of accts) {
      try {
        if (await fn(a, did)) done++
      } catch (err: any) {
        failed.push({ did, slot: a.slot, error: err?.message ?? String(err) })
      }
    }
  }
  return { done, failed }
}

export async function unfollow(body: any) {
  const dids = checkBatch(body.dids)
  const result = await each(dids, signedIn(body.slots ?? []), async (a, did) => {
    const row = db.prepare('SELECT follow_uri FROM follows WHERE account_did = ? AND subject_did = ?').get(a.did!, did) as
      | { follow_uri: string | null }
      | undefined
    let followUri = row?.follow_uri
    if (!followUri) {
      // Not in the local list yet (e.g. followed moments ago in the Bluesky app); ask Bluesky
      const res = await a.agent.getProfile({ actor: did })
      followUri = res.data.viewer?.following
    }
    if (!followUri) return false // this account doesn't follow them
    await a.agent.deleteFollow(followUri)
    db.prepare('DELETE FROM follows WHERE account_did = ? AND subject_did = ?').run(a.did!, did)
    return true
  })
  refreshWanted()
  return result
}

export async function follow(body: any) {
  const dids = checkBatch(body.dids)
  const result = await each(dids, signedIn(body.slots ?? []), async (a, did) => {
    if (db.prepare('SELECT 1 FROM follows WHERE account_did = ? AND subject_did = ?').get(a.did!, did)) return false
    const known = db.prepare('SELECT 1 FROM follows WHERE subject_did = ?').get(did)
    const res = await a.agent.follow(did)
    db.prepare('INSERT OR REPLACE INTO follows (account_did, subject_did, follow_uri) VALUES (?, ?, ?)').run(a.did!, did, res.uri)
    if (!known) backfillNewFollow(did)
    return true
  })
  refreshWanted()
  return result
}

export async function mute(body: any, muted: boolean) {
  const dids = checkBatch(body.dids)
  return each(dids, signedIn(body.slots ?? []), async (a, did) => {
    if (muted) await a.agent.mute(did)
    else await a.agent.unmute(did)
    db.prepare('UPDATE follows SET muted = ? WHERE account_did = ? AND subject_did = ?').run(muted ? 1 : 0, a.did!, did)
    return true
  })
}

// Curated (not moderation) lists owned by one account
export async function lists(slot: number) {
  const [a] = signedIn([slot])
  const out = []
  let cursor: string | undefined
  do {
    const res = await a.agent.app.bsky.graph.getLists({ actor: a.did!, limit: 100, cursor })
    for (const l of res.data.lists) {
      if (l.purpose === 'app.bsky.graph.defs#curatelist') out.push({ uri: l.uri, name: l.name, count: l.listItemCount ?? 0 })
    }
    cursor = res.data.cursor
  } while (cursor)
  return out
}

export async function createList(body: any) {
  const [a] = signedIn([Number(body.slot)])
  const name = String(body.name ?? '').trim().slice(0, 64)
  if (!name) throw Object.assign(new Error('Give the list a name'), { status: 400 })
  const res = await a.agent.com.atproto.repo.createRecord({
    repo: a.did!,
    collection: 'app.bsky.graph.list',
    record: {
      $type: 'app.bsky.graph.list',
      purpose: 'app.bsky.graph.defs#curatelist',
      name,
      description: 'Accounts to check on now and then (made with Skydash)',
      createdAt: new Date().toISOString(),
    },
  })
  return { uri: res.data.uri, name, count: 0 }
}

// Adds accounts to one of your lists, skipping ones already on it
export async function addToList(body: any) {
  const dids = checkBatch(body.dids)
  const [a] = signedIn([Number(body.slot)])
  const listUri = String(body.listUri ?? '')
  if (!listUri.startsWith(`at://${a.did}/app.bsky.graph.list/`)) {
    throw Object.assign(new Error('That list belongs to a different account'), { status: 400 })
  }
  const existing = new Set<string>()
  let cursor: string | undefined
  do {
    const res = await a.agent.app.bsky.graph.getList({ list: listUri, limit: 100, cursor })
    for (const item of res.data.items) existing.add(item.subject.did)
    cursor = res.data.cursor
  } while (cursor)

  return each(dids, [a], async (acct, did) => {
    if (existing.has(did)) return false
    await acct.agent.com.atproto.repo.createRecord({
      repo: acct.did!,
      collection: 'app.bsky.graph.listitem',
      record: { $type: 'app.bsky.graph.listitem', subject: did, list: listUri, createdAt: new Date().toISOString() },
    })
    return true
  })
}

// Everything the profile card shows: the profile, each account's relationship, and local stats
export async function profileCard(actor: string) {
  const signed = accounts.filter((a) => a.ok && a.did)
  if (!signed.length) throw Object.assign(new Error('No signed-in account'), { status: 503 })
  let lastError: any = null
  const lookup = () =>
    Promise.all(
      signed.map((a) =>
        a.agent
          .getProfile({ actor })
          .then((r) => r.data)
          .catch((err) => {
            lastError = err
            return null
          }),
      ),
    )
  let views = await lookup()
  // One retry: a lookup can fail while a session is being refreshed
  if (!views.some(Boolean)) views = await lookup()
  const profile = views.find(Boolean)
  if (!profile) {
    const notFound = /not found|could not locate/i.test(lastError?.message ?? '')
    throw Object.assign(new Error(notFound ? 'Profile not found' : `Couldn't load profile: ${lastError?.message ?? 'unknown error'}`), {
      status: notFound ? 404 : 502,
    })
  }

  const relationship: Record<number, any> = {}
  signed.forEach((a, i) => {
    const v = views[i]?.viewer
    relationship[a.slot] = {
      following: !!v?.following,
      followedBy: !!v?.followedBy,
      muted: !!v?.muted,
      blocking: !!v?.blocking,
      blockedBy: !!v?.blockedBy,
      self: a.did === profile.did,
    }
    // Keep the local follow list in step with what Bluesky just told us
    if (v?.following) {
      db.prepare(`INSERT INTO follows (account_did, subject_did, follow_uri) VALUES (?, ?, ?)
        ON CONFLICT(account_did, subject_did) DO UPDATE SET follow_uri = excluded.follow_uri`).run(a.did!, profile.did, v.following)
    }
  })

  const since = Date.now() - config.statsDays * 86_400_000
  const act = db
    .prepare('SELECT SUM(reply_parent IS NULL) posts, SUM(reply_parent IS NOT NULL) replies, MAX(sort_at) last FROM posts WHERE author_did = ? AND sort_at > ?')
    .get(profile.did, since) as { posts: number | null; replies: number | null; last: number | null }
  const rep = db.prepare('SELECT COUNT(*) n FROM reposts WHERE author_did = ? AND sort_at > ?').get(profile.did, since) as { n: number }
  const seen = db.prepare('SELECT last_active_ms FROM profiles WHERE did = ?').get(profile.did) as { last_active_ms: number | null } | undefined
  const inter = db.prepare('SELECT COUNT(*) n, MAX(at_ms) last FROM interactions WHERE author_did = ?').get(profile.did) as {
    n: number
    last: number | null
  }

  return {
    did: profile.did,
    handle: profile.handle,
    displayName: profile.displayName,
    avatar: profile.avatar,
    description: profile.description,
    followersCount: profile.followersCount,
    followsCount: profile.followsCount,
    postsCount: profile.postsCount,
    createdAt: profile.createdAt,
    relationship,
    stats: {
      days: config.statsDays,
      posts: act.posts ?? 0,
      replies: act.replies ?? 0,
      reposts: rep.n,
      lastActiveMs: Math.max(act.last ?? 0, seen?.last_active_ms ?? 0),
      interactions: inter.n,
      lastInteractionMs: inter.last ?? 0,
    },
  }
}
