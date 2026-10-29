// Live collector: subscribes to Bluesky's Jetstream for posts, reposts and follows
// by the accounts you follow plus your own two accounts, and writes them to SQLite.
import { config } from './config.ts'
import { db, kvGet, kvSet, savePost, deletePost, saveRepost, noteActivity } from './db.ts'
import { followedDids, ownDids } from './accounts.ts'
import { backfillNewFollow } from './backfill.ts'

const COLLECTIONS = ['app.bsky.feed.post', 'app.bsky.feed.repost', 'app.bsky.graph.follow']
const MAX_WANTED_DIDS = 10_000

export const collector = {
  connected: false,
  host: '',
  events: 0,
  lastEventUs: Number(kvGet('jetstream_cursor') ?? 0),
  error: '' as string,
}

let ws: WebSocket | null = null
let hostIndex = 0
let retryMs = 1000
let wanted = new Set<string>()
let own = new Set<string>()
let stopped = false

function computeWanted() {
  own = new Set(ownDids())
  // Accounts you're auditioning in Discover are collected too, without following them
  let auditioning: string[] = []
  try {
    auditioning = (db.prepare('SELECT did FROM auditions').all() as { did: string }[]).map((r) => r.did)
  } catch {
    // table not created yet on first start
  }
  const dids = [...new Set([...own, ...followedDids(), ...auditioning])]
  wanted = new Set(dids.slice(0, MAX_WANTED_DIDS))
  if (dids.length > MAX_WANTED_DIDS) {
    collector.error = `Following more than ${MAX_WANTED_DIDS} accounts; only the first ${MAX_WANTED_DIDS} are collected live.`
  }
}

function sendOptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(
    JSON.stringify({
      type: 'options_update',
      payload: { wantedCollections: COLLECTIONS, wantedDids: [...wanted], maxMessageSizeBytes: 0 },
    }),
  )
}

let refreshTimer: NodeJS.Timeout | undefined
// Called when your follow list changes, so the subscription picks up new accounts.
export function refreshWanted() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    computeWanted()
    sendOptions()
  }, 2000)
}

function handleFollow(did: string, commit: any) {
  if (!own.has(did)) return
  const uri = `at://${did}/app.bsky.graph.follow/${commit.rkey}`
  if (commit.operation === 'create' && commit.record?.subject) {
    const subject = commit.record.subject
    const known = db.prepare('SELECT 1 FROM follows WHERE subject_did = ?').get(subject)
    db.prepare(`INSERT INTO follows (account_did, subject_did, follow_uri) VALUES (?, ?, ?)
      ON CONFLICT(account_did, subject_did) DO UPDATE SET follow_uri = excluded.follow_uri`).run(did, subject, uri)
    // Someone neither account followed before has no stored history; fetch their last 14 days
    if (!known) backfillNewFollow(subject)
    refreshWanted()
  } else if (commit.operation === 'delete') {
    db.prepare('DELETE FROM follows WHERE follow_uri = ?').run(uri)
    refreshWanted()
  }
}

function handleEvent(evt: any) {
  if (evt.kind !== 'commit' || !evt.commit) return
  collector.events++
  collector.lastEventUs = evt.time_us
  const { did, commit } = evt
  const uri = `at://${did}/${commit.collection}/${commit.rkey}`
  const indexedMs = Math.floor(evt.time_us / 1000)

  switch (commit.collection) {
    case 'app.bsky.feed.post':
      if (commit.operation === 'delete') deletePost(uri)
      else if (commit.record) {
        savePost(uri, commit.cid, did, commit.record, indexedMs)
        noteActivity(did, indexedMs)
      }
      break
    case 'app.bsky.feed.repost':
      if (commit.operation === 'delete') db.prepare('DELETE FROM reposts WHERE uri = ?').run(uri)
      else if (commit.operation === 'create') {
        saveRepost(uri, did, commit.record?.subject?.uri, indexedMs)
        noteActivity(did, indexedMs)
      }
      break
    case 'app.bsky.graph.follow':
      handleFollow(did, commit)
      break
  }
}

function connect() {
  if (stopped) return
  const host = config.jetstreamHosts[hostIndex % config.jetstreamHosts.length]
  const params = new URLSearchParams({ requireHello: 'true' })
  for (const c of COLLECTIONS) params.append('wantedCollections', c)
  // Rewind a few seconds past the last event we saw so nothing falls in the gap. Duplicates are harmless.
  if (collector.lastEventUs) params.set('cursor', String(collector.lastEventUs - 5_000_000))

  collector.host = host
  ws = new WebSocket(`wss://${host}/subscribe?${params}`)

  ws.addEventListener('open', () => {
    collector.connected = true
    collector.error = ''
    retryMs = 1000
    sendOptions()
    console.log(`Jetstream connected (${host}), watching ${wanted.size} accounts`)
  })

  ws.addEventListener('message', (msg) => {
    try {
      handleEvent(JSON.parse(String(msg.data)))
    } catch (err) {
      console.error('Bad Jetstream event', err)
    }
  })

  ws.addEventListener('close', () => {
    collector.connected = false
    if (stopped) return
    hostIndex++
    console.log(`Jetstream disconnected; retrying in ${retryMs / 1000}s`)
    setTimeout(connect, retryMs)
    retryMs = Math.min(retryMs * 2, 60_000)
  })

  ws.addEventListener('error', () => {
    collector.error = `Could not reach ${host}`
  })
}

export function startCollector() {
  computeWanted()
  // An empty wantedDids list means "everyone on Bluesky", so never connect without one
  if (wanted.size === 0) {
    collector.error = 'No signed-in accounts, so nothing to collect.'
    return
  }
  connect()
  // Save the cursor regularly so a restart resumes where it left off
  setInterval(() => {
    if (collector.lastEventUs) kvSet('jetstream_cursor', String(collector.lastEventUs))
  }, 5000)
}

export function stopCollector() {
  stopped = true
  if (collector.lastEventUs) kvSet('jetstream_cursor', String(collector.lastEventUs))
  ws?.close()
}
