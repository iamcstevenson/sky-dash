// Fills the gap since the dashboard last ran by reading each followed account's recent posts
// from the public AppView. The first run reads 14 days so the follow stats are complete.
import { AtpAgent } from '@atproto/api'
import { config } from './config.ts'
import { kvGet, kvSet, savePost, saveRepost, saveProfile, noteActivity } from './db.ts'
import { accounts, followedDids, ownDids } from './accounts.ts'

const CONCURRENCY = 6
// Bluesky allows 3,000 AppView requests per 5 minutes per IP; stay well under it
const REQUESTS_PER_SECOND = 8
const SKIP_IF_GAP_UNDER_MS = 30 * 60_000
// Bump this to force a fresh 14-day history read for everyone
const DEEP_KEY = 'deep_backfill_v1'

export const backfill = {
  running: false,
  done: 0,
  total: 0,
  sinceMs: 0,
  errors: 0,
  deep: false,
}

const publicAgent = new AtpAgent({ service: config.publicAppView })

let nextSlot = 0
async function throttle() {
  const now = Date.now()
  const wait = Math.max(0, nextSlot - now)
  nextSlot = Math.max(now, nextSlot) + 1000 / REQUESTS_PER_SECOND
  if (wait) await new Promise((r) => setTimeout(r, wait))
}

async function backfillAuthor(actor: string, sinceMs: number) {
  let cursor: string | undefined
  let sawNewest = false
  for (let page = 0; page < 20; page++) {
    await throttle()
    let res
    try {
      res = await publicAgent.app.bsky.feed.getAuthorFeed({ actor, limit: 100, cursor, filter: 'posts_with_replies' })
    } catch {
      // Some accounts hide their posts from signed-out viewers; ask as a signed-in account instead
      const signedIn = accounts.find((a) => a.ok)
      if (!signedIn) throw new Error('no signed-in account')
      res = await signedIn.agent.app.bsky.feed.getAuthorFeed({ actor, limit: 100, cursor, filter: 'posts_with_replies' })
    }

    let reachedEnd = false
    for (const item of res.data.feed) {
      const reason: any = item.reason
      if (reason?.$type === 'app.bsky.feed.defs#reasonPin') continue // pinned posts can be any age

      const isRepost = reason?.$type === 'app.bsky.feed.defs#reasonRepost'
      const at = Date.parse(isRepost ? reason.indexedAt : item.post.indexedAt)
      // The first item is their newest activity, even if it's older than the window
      if (!sawNewest) {
        noteActivity(actor, at)
        sawNewest = true
      }
      if (at < sinceMs) {
        reachedEnd = true
        continue
      }
      if (isRepost) {
        if (reason.uri) saveRepost(reason.uri, actor, item.post.uri, at)
        continue
      }
      if (item.post.author.did !== actor) continue
      saveProfile(item.post.author)
      savePost(item.post.uri, item.post.cid, actor, item.post.record, at)
    }
    cursor = res.data.cursor
    if (reachedEnd || !cursor) return
  }
}

// Which of your accounts the stored data was collected for; changing accounts means starting over
function accountKey() {
  return ownDids().sort().join(',')
}

async function runFor(actors: string[], sinceMs: number) {
  Object.assign(backfill, { running: true, done: 0, total: actors.length, sinceMs, errors: 0 })
  let next = 0
  const worker = async () => {
    while (next < actors.length) {
      const actor = actors[next++]
      try {
        await backfillAuthor(actor, sinceMs)
      } catch {
        backfill.errors++
      }
      backfill.done++
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  backfill.running = false
}

export async function runBackfill() {
  if (!accountKey()) return
  const now = Date.now()
  const sameAccounts = kvGet('backfill_accounts') === accountKey()
  const deepDone = kvGet(DEEP_KEY) === accountKey()
  const lastRun = sameAccounts ? Number(kvGet('last_seen_ms') ?? 0) : 0
  const windowStart = now - config.statsDays * 86_400_000

  if (deepDone && lastRun && now - lastRun < SKIP_IF_GAP_UNDER_MS) {
    console.log('Backfill skipped: the live collector covers the short gap since last run')
    return
  }
  // Overlap the last run by 10 minutes so nothing slips through
  const sinceMs = deepDone ? Math.max(windowStart, lastRun - 10 * 60_000) : windowStart
  backfill.deep = !deepDone

  const actors = [...new Set([...ownDids(), ...followedDids()])]
  console.log(
    `${deepDone ? 'Backfilling' : `Reading ${config.statsDays} days of history for`} ${actors.length} accounts since ${new Date(sinceMs).toLocaleString()}`,
  )
  await runFor(actors, sinceMs)
  kvSet('last_seen_ms', String(now))
  kvSet('backfill_accounts', accountKey())
  kvSet(DEEP_KEY, accountKey())
  backfill.deep = false
  console.log(`Backfill finished (${backfill.errors} accounts could not be read)`)
}

// A newly followed account has no history yet; read its last 14 days
export async function backfillNewFollow(did: string) {
  try {
    await backfillAuthor(did, Date.now() - config.statsDays * 86_400_000)
  } catch {
    // Stats for this account fill in from the live stream instead
  }
}

// While running, keep recording that we're alive so the next start knows how big the gap is
export function startHeartbeat() {
  setInterval(() => {
    if (!backfill.running && kvGet('backfill_accounts') === accountKey()) kvSet('last_seen_ms', String(Date.now()))
  }, 60_000)
}
