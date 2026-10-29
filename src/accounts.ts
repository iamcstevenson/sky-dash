import { AtpAgent, type AtpSessionData } from '@atproto/api'
import { config, type AccountConfig } from './config.ts'
import { db, saveProfile } from './db.ts'

export type Account = {
  slot: number
  handle: string
  did?: string
  agent: AtpAgent
  ok: boolean
  error?: string
  followCount: number
}

export const accounts: Account[] = []

export function accountBySlot(slot: number): Account | undefined {
  return accounts.find((a) => a.slot === slot && a.ok)
}

export function ownDids(): string[] {
  return accounts.filter((a) => a.did).map((a) => a.did!)
}

function storeSession(slot: number, session: AtpSessionData | undefined) {
  if (!session) {
    db.prepare('DELETE FROM sessions WHERE slot = ?').run(slot)
    return
  }
  db.prepare(`
    INSERT INTO sessions (slot, did, handle, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET did = excluded.did, handle = excluded.handle, data = excluded.data
  `).run(slot, session.did, session.handle, JSON.stringify(session))
}

async function signIn(cfg: AccountConfig): Promise<Account> {
  const agent = new AtpAgent({
    service: cfg.service,
    persistSession: (evt, session) => {
      if (evt === 'expired' || evt === 'create-failed') storeSession(cfg.slot, undefined)
      else if (session) storeSession(cfg.slot, session)
    },
  })
  const account: Account = { slot: cfg.slot, handle: cfg.handle, agent, ok: false, followCount: 0 }

  // Reuse the stored session when it belongs to the configured handle; Bluesky limits logins per day.
  const stored = db.prepare('SELECT handle, data FROM sessions WHERE slot = ?').get(cfg.slot) as
    | { handle: string; data: string }
    | undefined
  if (stored && stored.handle.toLowerCase() === cfg.handle.toLowerCase()) {
    try {
      await agent.resumeSession(JSON.parse(stored.data))
    } catch {
      // Fall through to a fresh login
    }
  }

  if (!agent.session) {
    try {
      await agent.login({ identifier: cfg.handle, password: cfg.appPassword })
    } catch (err: any) {
      account.error = `Sign-in failed: ${err?.message ?? err}`
      return account
    }
  }

  account.did = agent.session!.did
  account.handle = agent.session!.handle
  account.ok = true
  return account
}

export async function signInAll() {
  accounts.length = 0
  for (const cfg of config.accounts) {
    const account = await signIn(cfg)
    accounts.push(account)
    console.log(account.ok ? `Signed in as @${account.handle} (slot ${account.slot})` : `@${cfg.handle}: ${account.error}`)
  }
}

// Replaces the stored follow list for one account with what Bluesky reports now.
export async function syncFollows(account: Account) {
  if (!account.ok || !account.did) return
  const rows: { did: string; followUri?: string; followsBack: boolean; muted: boolean }[] = []
  let cursor: string | undefined
  do {
    const res = await account.agent.app.bsky.graph.getFollows({ actor: account.did, limit: 100, cursor })
    for (const p of res.data.follows) {
      rows.push({ did: p.did, followUri: p.viewer?.following, followsBack: !!p.viewer?.followedBy, muted: !!p.viewer?.muted })
      saveProfile(p)
    }
    cursor = res.data.cursor
  } while (cursor)

  const insert = db.prepare(
    'INSERT OR REPLACE INTO follows (account_did, subject_did, follow_uri, follows_back, muted) VALUES (?, ?, ?, ?, ?)',
  )
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM follows WHERE account_did = ?').run(account.did)
    for (const r of rows) insert.run(account.did, r.did, r.followUri ?? null, r.followsBack ? 1 : 0, r.muted ? 1 : 0)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  account.followCount = rows.length
  console.log(`@${account.handle} follows ${rows.length} accounts`)
}

// Post, follower and following totals for everyone you follow (25 profiles per request)
export async function refreshProfileCounts() {
  const account = accounts.find((a) => a.ok)
  if (!account) return
  const dids = followedDids()
  const update = db.prepare(`
    UPDATE profiles SET posts_count = ?, followers_count = ?, follows_count = ?, joined_at = ?,
      handle = ?, display_name = ?, avatar = ?, updated_at = ? WHERE did = ?`)
  for (let i = 0; i < dids.length; i += 25) {
    try {
      const res = await account.agent.app.bsky.actor.getProfiles({ actors: dids.slice(i, i + 25) })
      for (const p of res.data.profiles) {
        saveProfile(p)
        update.run(
          p.postsCount ?? null,
          p.followersCount ?? null,
          p.followsCount ?? null,
          p.createdAt ?? null,
          p.handle,
          p.displayName ?? null,
          p.avatar ?? null,
          Date.now(),
          p.did,
        )
      }
    } catch (err: any) {
      console.error(`Profile counts failed: ${err?.message}`)
    }
  }
}

export function followedDids(): string[] {
  const rows = db.prepare('SELECT DISTINCT subject_did FROM follows').all() as { subject_did: string }[]
  return rows.map((r) => r.subject_did)
}

export function followCounts() {
  const [a, b] = accounts.filter((x) => x.did)
  if (!a) return null
  const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n
  if (!b) return { only1: count('SELECT COUNT(*) n FROM follows WHERE account_did = ?', a.did!), only2: 0, both: 0 }
  const both = count(
    'SELECT COUNT(*) n FROM follows f1 JOIN follows f2 ON f1.subject_did = f2.subject_did WHERE f1.account_did = ? AND f2.account_did = ?',
    a.did!,
    b.did!,
  )
  return {
    [`only${a.slot}`]: count('SELECT COUNT(*) n FROM follows WHERE account_did = ?', a.did!) - both,
    [`only${b.slot}`]: count('SELECT COUNT(*) n FROM follows WHERE account_did = ?', b.did!) - both,
    both,
  }
}
