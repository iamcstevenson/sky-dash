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
  source: 'env' | 'dashboard' // where its handle and app password are kept
}

export const MAX_ACCOUNTS = 4
const APP_PASSWORD = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i

// .env accounts plus the ones added in the dashboard; a dashboard entry wins for the same slot
function accountConfigs(): (AccountConfig & { source: Account['source'] })[] {
  const saved = db.prepare('SELECT slot, handle, app_password, service FROM account_creds').all() as {
    slot: number
    handle: string
    app_password: string
    service: string
  }[]
  const bySlot = new Map<number, AccountConfig & { source: Account['source'] }>()
  for (const c of config.accounts) bySlot.set(c.slot, { ...c, source: 'env' })
  for (const r of saved) bySlot.set(r.slot, { slot: r.slot, handle: r.handle, appPassword: r.app_password, service: r.service, source: 'dashboard' })
  return [...bySlot.values()].filter((c) => c.slot >= 1 && c.slot <= MAX_ACCOUNTS).sort((a, b) => a.slot - b.slot)
}

export function configuredCount() {
  return accountConfigs().length
}

// systemd (server) and launchd (Mac) start Skydash again by themselves; a fresh start signs in every
// account and starts collecting, backfill and notifications for it exactly as at boot.
function restartSoon() {
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
}

// Settings → Accounts: checks the app password with Bluesky, saves it, then restarts
export async function addAccount(body: any) {
  const handle = String(body?.handle ?? '').trim().replace(/^@/, '').toLowerCase()
  const appPassword = String(body?.appPassword ?? '').trim()
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status })
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(handle)) throw fail(400, 'Enter a handle like name.bsky.social')
  if (!APP_PASSWORD.test(appPassword)) {
    throw fail(400, 'Use an app password (looks like xxxx-xxxx-xxxx-xxxx), not your real password: Bluesky → Settings → Privacy and Security → App Passwords')
  }
  const configs = accountConfigs()
  if (configs.some((c) => c.handle.toLowerCase() === handle) || accounts.some((a) => a.handle.toLowerCase() === handle)) {
    throw fail(400, `@${handle} is already added`)
  }
  const slot = [1, 2, 3, 4].find((s) => !configs.some((c) => c.slot === s))
  if (!slot) throw fail(400, `Skydash handles up to ${MAX_ACCOUNTS} accounts; remove one first`)
  const service = 'https://bsky.social'
  const acct = await signIn({ slot, handle, appPassword, service }, 'dashboard')
  if (!acct.ok) throw fail(400, acct.error ?? 'Sign-in failed')
  db.prepare('INSERT OR REPLACE INTO account_creds (slot, handle, app_password, service) VALUES (?, ?, ?, ?)').run(slot, handle, appPassword, service)
  console.log(`Added @${acct.handle} (slot ${slot}) from the dashboard; restarting`)
  restartSoon()
  return { slot, handle: acct.handle, restarting: true }
}

export async function removeAccount(body: any) {
  const slot = Number(body?.slot)
  const cfg = accountConfigs().find((c) => c.slot === slot)
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status })
  if (!cfg) throw fail(404, 'No such account')
  if (cfg.source !== 'dashboard') throw fail(400, 'This account is set in the server settings file (.env), so it is removed there')
  db.prepare('DELETE FROM account_creds WHERE slot = ?').run(slot)
  db.prepare('DELETE FROM sessions WHERE slot = ?').run(slot)
  console.log(`Removed @${cfg.handle} (slot ${slot}) from the dashboard; restarting`)
  restartSoon()
  return { restarting: true }
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

async function signIn(cfg: AccountConfig, source: Account['source']): Promise<Account> {
  const agent = new AtpAgent({
    service: cfg.service,
    persistSession: (evt, session) => {
      if (evt === 'expired' || evt === 'create-failed') storeSession(cfg.slot, undefined)
      else if (session) storeSession(cfg.slot, session)
    },
  })
  const account: Account = { slot: cfg.slot, handle: cfg.handle, agent, ok: false, followCount: 0, source }

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
  for (const cfg of accountConfigs()) {
    const account = await signIn(cfg, cfg.source)
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
  await refreshProfiles(followedDids())
}

// Reads profiles 25 at a time and stores names, avatars and counts. Accounts Bluesky leaves out of a
// successful answer are marked gone (deleted, deactivated or suspended) until they come back.
export async function refreshProfiles(dids: string[]) {
  const account = accounts.find((a) => a.ok)
  if (!account || !dids.length) return
  const update = db.prepare(`
    UPDATE profiles SET posts_count = ?, followers_count = ?, follows_count = ?, joined_at = ?,
      handle = ?, display_name = ?, avatar = ?, gone_at = NULL, updated_at = ? WHERE did = ?`)
  const markGone = db.prepare(`
    INSERT INTO profiles (did, gone_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET gone_at = COALESCE(profiles.gone_at, excluded.gone_at), updated_at = excluded.updated_at`)
  for (let i = 0; i < dids.length; i += 25) {
    const batch = dids.slice(i, i + 25)
    try {
      const res = await account.agent.app.bsky.actor.getProfiles({ actors: batch })
      const found = new Set<string>()
      for (const p of res.data.profiles) {
        found.add(p.did)
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
      for (const did of batch) if (!found.has(did)) markGone.run(did, Date.now(), Date.now())
    } catch (err: any) {
      console.error(`Profile counts failed: ${err?.message}`)
    }
  }
}

// New follows get their profile a few seconds later, in one batch, instead of at the next 6-hourly refresh
const profileQueue = new Set<string>()
let profileTimer: NodeJS.Timeout | null = null
export function loadProfileSoon(did: string) {
  profileQueue.add(did)
  profileTimer ??= setTimeout(() => {
    const dids = [...profileQueue]
    profileQueue.clear()
    profileTimer = null
    refreshProfiles(dids).catch(() => {})
  }, 3_000)
}

export function followedDids(): string[] {
  const rows = db.prepare('SELECT DISTINCT subject_did FROM follows').all() as { subject_did: string }[]
  return rows.map((r) => r.subject_did)
}

export function followCounts() {
  // only<slot>: followed by that account and no other; both: followed by every signed-in account
  const signed = accounts.filter((x) => x.did)
  if (!signed.length) return null
  const rows = db
    .prepare(`SELECT subject_did, GROUP_CONCAT(account_did) accts FROM follows WHERE account_did IN (${signed.map(() => '?').join(', ')}) GROUP BY subject_did`)
    .all(...signed.map((a) => a.did!)) as { accts: string }[]
  const out: Record<string, number> = { both: 0 }
  for (const a of signed) out[`only${a.slot}`] = 0
  for (const r of rows) {
    const dids = r.accts.split(',')
    if (signed.length > 1 && dids.length === signed.length) out.both++
    if (dids.length === 1) {
      const a = signed.find((x) => x.did === dids[0])
      if (a) out[`only${a.slot}`]++
    }
  }
  return out
}
