// Bio and counts for everyone you follow, so the Hub iPhone app can show their profiles offline.
// Read from Bluesky's public servers, 25 at a time, every few hours.
import { config } from './config.ts'
import { db } from './db.ts'

db.exec(`
  CREATE TABLE IF NOT EXISTS profile_details (
    did TEXT PRIMARY KEY,
    description TEXT,
    followers INTEGER,
    follows INTEGER,
    posts INTEGER,
    fetched_at INTEGER NOT NULL
  )
`)

const REFRESH_MS = 6 * 3_600_000
const BATCH = 25

const save = db.prepare(`
  INSERT INTO profile_details (did, description, followers, follows, posts, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(did) DO UPDATE SET description = excluded.description, followers = excluded.followers,
    follows = excluded.follows, posts = excluded.posts, fetched_at = excluded.fetched_at
`)

export async function refreshProfileDetails() {
  const cutoff = Date.now() - REFRESH_MS
  const due = (
    db
      .prepare(
        `SELECT DISTINCT f.subject_did did FROM follows f LEFT JOIN profile_details d ON d.did = f.subject_did
         WHERE d.fetched_at IS NULL OR d.fetched_at < ? ORDER BY d.fetched_at`,
      )
      .all(cutoff) as { did: string }[]
  ).map((r) => r.did)
  for (let i = 0; i < due.length; i += BATCH) {
    const url = new URL(`${config.publicAppView}/xrpc/app.bsky.actor.getProfiles`)
    for (const did of due.slice(i, i + BATCH)) url.searchParams.append('actors', did)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Bluesky answered ${res.status} for profiles`)
    const data: any = await res.json()
    const now = Date.now()
    for (const p of data.profiles ?? []) {
      save.run(p.did, p.description ?? null, p.followersCount ?? null, p.followsCount ?? null, p.postsCount ?? null, now)
    }
  }
  return due.length
}

export function startProfileDetails() {
  const run = () => refreshProfileDetails().catch((err) => console.error(`Profile details: ${err?.message ?? err}`))
  run()
  setInterval(run, REFRESH_MS)
}
