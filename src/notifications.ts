// Reads each account's notifications (without marking them read) to learn who has liked,
// replied to, reposted, quoted or mentioned you. Feeds the "has interacted with you" signal.
import { db, kvGet, kvSet } from './db.ts'
import { accounts, type Account } from './accounts.ts'

const INTERACTION_REASONS = ['like', 'repost', 'reply', 'quote', 'mention', 'like-via-repost', 'repost-via-repost']
const HISTORY_PAGES = 50 // first run: up to 5,000 notifications per account
const POLL_MS = 10 * 60_000

export const notifStatus: Record<number, { stored: number; oldestMs: number; error?: string }> = {}

const insert = db.prepare(
  'INSERT OR IGNORE INTO interactions (uri, account_did, author_did, reason, at_ms) VALUES (?, ?, ?, ?, ?)',
)

async function syncAccount(account: Account) {
  if (!account.ok || !account.did) return
  const key = `notif_newest_${account.did}`
  const newestSeen = Number(kvGet(key) ?? 0)
  let newest = newestSeen
  let cursor: string | undefined
  // After the first run, stop as soon as we reach notifications we already have
  const maxPages = newestSeen ? 20 : HISTORY_PAGES

  for (let page = 0; page < maxPages; page++) {
    const res = await account.agent.app.bsky.notification.listNotifications({
      limit: 100,
      cursor,
      reasons: INTERACTION_REASONS,
    })
    let reachedKnown = false
    for (const n of res.data.notifications) {
      const at = Date.parse(n.indexedAt)
      newest = Math.max(newest, at)
      if (newestSeen && at < newestSeen - 60_000) {
        reachedKnown = true
        continue
      }
      if (n.author.did === account.did) continue
      insert.run(n.uri, account.did, n.author.did, n.reason, at)
    }
    cursor = res.data.cursor
    if (reachedKnown || !cursor) break
  }
  if (newest) kvSet(key, String(newest))

  const row = db
    .prepare('SELECT COUNT(*) n, MIN(at_ms) oldest FROM interactions WHERE account_did = ?')
    .get(account.did) as { n: number; oldest: number | null }
  notifStatus[account.slot] = { stored: row.n, oldestMs: row.oldest ?? 0 }
}

export async function syncNotifications() {
  for (const a of accounts) {
    try {
      await syncAccount(a)
    } catch (err: any) {
      notifStatus[a.slot] = { ...(notifStatus[a.slot] ?? { stored: 0, oldestMs: 0 }), error: err?.message ?? String(err) }
      console.error(`Notifications for @${a.handle} failed: ${err?.message}`)
    }
  }
}

export function startNotificationSync() {
  syncNotifications()
  setInterval(syncNotifications, POLL_MS)
}
