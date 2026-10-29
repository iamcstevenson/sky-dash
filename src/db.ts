import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.ts'
import { isEnglish } from './lang.ts'

mkdirSync(dirname(config.dbPath), { recursive: true })

export const db = new DatabaseSync(config.dbPath)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Signed-in sessions, so restarts don't burn the login rate limit
  CREATE TABLE IF NOT EXISTS sessions (
    slot INTEGER PRIMARY KEY,
    did TEXT,
    handle TEXT,
    data TEXT
  );

  -- Who each of your accounts follows. follow_uri is needed to unfollow.
  CREATE TABLE IF NOT EXISTS follows (
    account_did TEXT NOT NULL,
    subject_did TEXT NOT NULL,
    follow_uri TEXT,
    PRIMARY KEY (account_did, subject_did)
  );
  CREATE INDEX IF NOT EXISTS follows_subject ON follows(subject_did);
  CREATE INDEX IF NOT EXISTS follows_uri ON follows(follow_uri);

  CREATE TABLE IF NOT EXISTS profiles (
    did TEXT PRIMARY KEY,
    handle TEXT,
    display_name TEXT,
    avatar TEXT,
    updated_at INTEGER
  );

  -- Raw posts from people you follow (and your own accounts).
  -- sort_at = min(createdAt, indexed time) in ms, like Bluesky does, so backdated posts don't jump the queue.
  CREATE TABLE IF NOT EXISTS posts (
    uri TEXT PRIMARY KEY,
    cid TEXT,
    author_did TEXT NOT NULL,
    text TEXT,
    created_at TEXT,
    sort_at INTEGER NOT NULL,
    reply_parent TEXT,
    reply_root TEXT,
    embed TEXT,
    langs TEXT,
    record TEXT
  );
  CREATE INDEX IF NOT EXISTS posts_sort ON posts(sort_at DESC);
  CREATE INDEX IF NOT EXISTS posts_author ON posts(author_did, sort_at DESC);
  CREATE INDEX IF NOT EXISTS posts_parent ON posts(reply_parent);

  -- Reposts by people you follow (used later for the "mostly reposts" signal)
  CREATE TABLE IF NOT EXISTS reposts (
    uri TEXT PRIMARY KEY,
    author_did TEXT NOT NULL,
    subject_uri TEXT,
    sort_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reposts_author ON reposts(author_did, sort_at DESC);

  -- Keyword searches. in_feed = include in the published Bluesky custom feed.
  CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    in_feed INTEGER NOT NULL DEFAULT 1,
    last_poll_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Which stored posts matched which keyword. The posts themselves live in posts.
  CREATE TABLE IF NOT EXISTS keyword_hits (
    keyword_id INTEGER NOT NULL,
    uri TEXT NOT NULL,
    sort_at INTEGER NOT NULL,
    PRIMARY KEY (keyword_id, uri)
  );
  CREATE INDEX IF NOT EXISTS keyword_hits_sort ON keyword_hits(sort_at DESC);
  CREATE INDEX IF NOT EXISTS keyword_hits_uri ON keyword_hits(uri);

  -- Things other people did to your accounts (likes, replies, reposts, quotes, mentions),
  -- read from your notifications. Used for the "has interacted with you" signal.
  CREATE TABLE IF NOT EXISTS interactions (
    uri TEXT NOT NULL,
    account_did TEXT NOT NULL,
    author_did TEXT NOT NULL,
    reason TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    PRIMARY KEY (uri, account_did, reason)
  );
  CREATE INDEX IF NOT EXISTS interactions_author ON interactions(author_did);
`)

// Adds a column to an existing database if it isn't there yet
function addColumn(table: string, column: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}
addColumn('follows', 'follows_back', 'INTEGER NOT NULL DEFAULT 0')
addColumn('follows', 'muted', 'INTEGER NOT NULL DEFAULT 0')
addColumn('profiles', 'posts_count', 'INTEGER')
addColumn('profiles', 'followers_count', 'INTEGER')
addColumn('profiles', 'follows_count', 'INTEGER')
addColumn('profiles', 'joined_at', 'TEXT')
// Newest post or repost seen for this account, even if older than the 14-day window
addColumn('profiles', 'last_active_ms', 'INTEGER')
// 1 when the post is English (by its language label, or by its text when unlabeled)
addColumn('posts', 'is_en', 'INTEGER')
db.exec('CREATE INDEX IF NOT EXISTS posts_en_sort ON posts(is_en, sort_at DESC)')

// Fill in is_en for posts stored before language filtering existed
{
  const pending = db.prepare('SELECT uri, langs, text FROM posts WHERE is_en IS NULL').all() as {
    uri: string
    langs: string | null
    text: string | null
  }[]
  if (pending.length) {
    const set = db.prepare('UPDATE posts SET is_en = ? WHERE uri = ?')
    db.exec('BEGIN')
    for (const r of pending) set.run(isEnglish(r.langs, r.text ?? '') ? 1 : 0, r.uri)
    db.exec('COMMIT')
  }
}

export function kvGet(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function kvSet(key: string, value: string) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

const insertPost = db.prepare(`
  INSERT INTO posts (uri, cid, author_did, text, created_at, sort_at, reply_parent, reply_root, embed, langs, record, is_en)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, text = excluded.text, record = excluded.record, is_en = excluded.is_en,
    sort_at = MIN(posts.sort_at, excluded.sort_at)
`)

// Stores an app.bsky.feed.post record. indexedMs is when the network saw it.
export function savePost(uri: string, cid: string, authorDid: string, record: any, indexedMs: number) {
  const createdMs = Date.parse(record?.createdAt)
  const sortAt = Number.isFinite(createdMs) ? Math.min(createdMs, indexedMs) : indexedMs
  insertPost.run(
    uri,
    cid,
    authorDid,
    typeof record?.text === 'string' ? record.text : '',
    record?.createdAt ?? null,
    sortAt,
    record?.reply?.parent?.uri ?? null,
    record?.reply?.root?.uri ?? null,
    record?.embed ? JSON.stringify(record.embed) : null,
    Array.isArray(record?.langs) ? record.langs.join(',') : null,
    JSON.stringify(record ?? {}),
    isEnglish(record?.langs, typeof record?.text === 'string' ? record.text : '') ? 1 : 0,
  )
}

export function deletePost(uri: string) {
  db.prepare('DELETE FROM posts WHERE uri = ?').run(uri)
}

const insertRepost = db.prepare(`
  INSERT INTO reposts (uri, author_did, subject_uri, sort_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(uri) DO NOTHING
`)

export function saveRepost(uri: string, authorDid: string, subjectUri: string | undefined, sortAt: number) {
  insertRepost.run(uri, authorDid, subjectUri ?? null, sortAt)
}

const upsertProfile = db.prepare(`
  INSERT INTO profiles (did, handle, display_name, avatar, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
    avatar = excluded.avatar, updated_at = excluded.updated_at
`)

export function saveProfile(p: { did: string; handle?: string; displayName?: string; avatar?: string }) {
  upsertProfile.run(p.did, p.handle ?? null, p.displayName ?? null, p.avatar ?? null, Date.now())
}

const bumpActive = db.prepare(`
  INSERT INTO profiles (did, last_active_ms, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(did) DO UPDATE SET last_active_ms = MAX(COALESCE(profiles.last_active_ms, 0), excluded.last_active_ms)
`)

export function noteActivity(did: string, atMs: number) {
  bumpActive.run(did, atMs, Date.now())
}

export function prune(retentionDays: number) {
  const cutoff = Date.now() - retentionDays * 86_400_000
  db.prepare('DELETE FROM posts WHERE sort_at < ?').run(cutoff)
  db.prepare('DELETE FROM reposts WHERE sort_at < ?').run(cutoff)
  db.prepare('DELETE FROM keyword_hits WHERE sort_at < ?').run(cutoff)
}
