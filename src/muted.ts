// Muted words and phrases: posts that contain one are left out of Following, Keywords, Lists and Trending.
// Matching ignores case and goes by whole words ("art" doesn't hide "start"), and #hashtags count, so "trump"
// also hides "#Trump". Checked in SQL (an SQLite function) so muted posts don't use up a page, and again on the
// finished items for feeds read from Bluesky (lists) and for quoted posts and link cards.
//
// Kept in step with the muted words in Bluesky's own settings for every signed-in account (see syncMuted):
// one shared list, so adding or removing a word anywhere does the same everywhere.
import { db } from './db.ts'
import { accounts } from './accounts.ts'

db.exec(`
  CREATE TABLE IF NOT EXISTS muted_words (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  );
`)
// synced: DIDs of the accounts whose Bluesky settings are known to have the word, so a word that later goes
// missing there was removed in the Bluesky app (not just never sent). expires_at: from a Bluesky mute "for 7 days".
for (const [col, type] of [['synced', "TEXT NOT NULL DEFAULT '[]'"], ['expires_at', 'INTEGER']]) {
  const cols = db.prepare('PRAGMA table_info(muted_words)').all() as { name: string }[]
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE muted_words ADD COLUMN ${col} ${type}`)
}

let words: { id: number; text: string; expires_at: number | null }[] = []

// A word or phrase matches as a whole word, also as a hashtag ("trump" hides "#Trump");
// an entry written as "#tag" matches only the hashtag
function wordSource(text: string) {
  const t = text.trim()
  const body = t.replace(/^#/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return t.startsWith('#') ? `(?<![\\p{L}\\p{N}_])#${body}(?![\\p{L}\\p{N}_])` : `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`
}
let pattern: RegExp | null = null
let countsAt = 0
let counts = new Map<number, number>()

function reload() {
  db.prepare('DELETE FROM muted_words WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now())
  words = db.prepare('SELECT id, text, expires_at FROM muted_words ORDER BY text COLLATE NOCASE').all() as typeof words
  pattern = words.length ? new RegExp(words.map((w) => wordSource(w.text)).join('|'), 'iu') : null
  countsAt = 0
}
reload()

// Link card titles and descriptions count as part of the post
function embedText(embed: string | null): string {
  if (!embed) return ''
  try {
    const e = JSON.parse(embed)
    const ext = e?.external ?? e?.media?.external
    return ext ? `${ext.title ?? ''} ${ext.description ?? ''}` : ''
  } catch {
    return ''
  }
}

export function isMuted(text: string | null | undefined, extra = ''): boolean {
  return !!pattern && pattern.test(`${text ?? ''} ${extra}`)
}

// muted(text, embed) in SQL: 1 when the post should be hidden
db.function('muted', { deterministic: true }, (text: unknown, embed: unknown) =>
  pattern && isMuted(String(text ?? ''), embedText(embed == null ? null : String(embed))) ? 1 : 0,
)
export const MUTED_SQL = 'muted(p.text, p.embed) = 0'
export const anyMuted = () => !!pattern

// A hydrated post view: its text, link card and quoted post
export function postViewMuted(post: any): boolean {
  if (!pattern || !post) return false
  const parts = [post.record?.text ?? '']
  const ext = post.embed?.external ?? post.embed?.media?.external
  if (ext) parts.push(ext.title ?? '', ext.description ?? '')
  const quoted = post.embed?.record?.record ?? post.embed?.record
  if (quoted?.value?.text) parts.push(quoted.value.text)
  return isMuted(parts.join(' '))
}

// How many stored posts from the last day each word hides, so the list shows it's working (cached 5 minutes)
function hiddenCounts() {
  if (Date.now() - countsAt < 5 * 60_000) return counts
  counts = new Map()
  if (words.length) {
    const one = words.map((w) => ({
      id: w.id,
      re: new RegExp(wordSource(w.text), 'iu'),
    }))
    const rows = db.prepare('SELECT text, embed FROM posts WHERE sort_at > ?').all(Date.now() - 86_400_000) as { text: string | null; embed: string | null }[]
    for (const r of rows) {
      const s = `${r.text ?? ''} ${embedText(r.embed)}`
      for (const w of one) if (w.re.test(s)) counts.set(w.id, (counts.get(w.id) ?? 0) + 1)
    }
  }
  countsAt = Date.now()
  return counts
}

export function listMuted() {
  const c = hiddenCounts()
  return {
    words: words.map((w) => ({ id: w.id, text: w.text, expiresAt: w.expires_at, hiddenToday: c.get(w.id) ?? 0 })),
    sync: { ...syncState, accounts: accounts.filter((a) => a.ok).length },
  }
}

export async function addMuted(body: any) {
  const text = String(body?.text ?? '').trim().replace(/\s+/g, ' ')
  if (!text || text.replace(/^#/, '').length < 2) throw Object.assign(new Error('Enter a word or phrase (2+ characters)'), { status: 400 })
  if (text.length > 100) throw Object.assign(new Error('Keep it under 100 characters'), { status: 400 })
  if (!words.some((w) => keyOf(w.text) === keyOf(text))) db.prepare('INSERT INTO muted_words (text, created_at) VALUES (?, ?)').run(text, Date.now())
  reload()
  await syncMuted() // sends it to Bluesky for every account
  return listMuted()
}

export async function removeMuted(body: any) {
  const w = words.find((x) => x.id === Number(body?.id))
  db.prepare('DELETE FROM muted_words WHERE id = ?').run(Number(body?.id))
  reload()
  if (w) await removeFromBluesky(keyOf(w.text))
  return listMuted()
}

// ---------- keeping Bluesky's muted words in step ----------
// Words match ignoring capitals and a leading #. A Skydash "#tag" goes to Bluesky as tags only and a plain word
// as text and tags (how Skydash matches them); a Bluesky tags-only word comes back as "#word".

const keyOf = (text: string) => text.trim().replace(/^#/, '').replace(/\s+/g, ' ').toLowerCase()
const syncState = { lastMs: 0, error: '' as string }
let syncing: Promise<void> | null = null

type BskyWord = { id?: string; value: string; targets: string[]; actorTarget: string; expiresAt?: string }

async function blueskyWords(a: (typeof accounts)[number]): Promise<BskyWord[]> {
  const prefs = await a.agent.getPreferences()
  return ((prefs.moderationPrefs?.mutedWords ?? []) as BskyWord[]).filter((w) => !w.expiresAt || Date.parse(w.expiresAt) > Date.now())
}

async function removeFromBluesky(key: string) {
  const errors: string[] = []
  for (const a of accounts.filter((x) => x.ok)) {
    try {
      for (const w of (await blueskyWords(a)).filter((x) => keyOf(x.value) === key)) await a.agent.removeMutedWord(w as any)
    } catch (err: any) {
      errors.push(`@${a.handle}: ${err?.message ?? err}`)
    }
  }
  syncState.error = errors.join('; ')
}

// One shared list. A Bluesky word Skydash doesn't have is added here; a word Skydash had sent to an account
// that's now missing there was removed in the Bluesky app, so it's removed here and from the other accounts;
// any Skydash word an account lacks is sent to it.
export function syncMuted(): Promise<void> {
  syncing ??= (async () => {
    const signed = accounts.filter((a) => a.ok && a.did)
    if (!signed.length) return
    const lists = new Map<string, BskyWord[]>()
    const errors: string[] = []
    for (const a of signed) {
      try {
        lists.set(a.did!, await blueskyWords(a))
      } catch (err: any) {
        errors.push(`@${a.handle}: ${err?.message ?? err}`)
      }
    }
    const has = (did: string, key: string) => lists.get(did)!.some((w) => keyOf(w.value) === key)
    const local = db.prepare('SELECT id, text, synced FROM muted_words').all() as { id: number; text: string; synced: string }[]

    // Removed in the Bluesky app
    const removed: string[] = []
    for (const w of local) {
      const key = keyOf(w.text)
      const synced: string[] = JSON.parse(w.synced || '[]')
      if (synced.some((did) => lists.has(did) && !has(did, key))) {
        db.prepare('DELETE FROM muted_words WHERE id = ?').run(w.id)
        removed.push(key)
      }
    }
    for (const [did, list] of lists) {
      const a = signed.find((x) => x.did === did)!
      for (const w of list.filter((x) => removed.includes(keyOf(x.value)))) {
        try {
          await a.agent.removeMutedWord(w as any)
        } catch (err: any) {
          errors.push(`@${a.handle}: ${err?.message ?? err}`)
        }
      }
    }

    // Added in the Bluesky app
    const known = new Set(local.map((w) => keyOf(w.text)))
    for (const list of lists.values()) {
      for (const w of list) {
        const key = keyOf(w.value)
        if (known.has(key) || removed.includes(key)) continue
        known.add(key)
        const tagOnly = w.targets.length === 1 && w.targets[0] === 'tag'
        db.prepare('INSERT OR IGNORE INTO muted_words (text, created_at, expires_at) VALUES (?, ?, ?)').run(
          `${tagOnly ? '#' : ''}${w.value.replace(/^#/, '')}`,
          Date.now(),
          w.expiresAt ? Date.parse(w.expiresAt) : null,
        )
      }
    }

    // Send what each account is missing, and record who has what
    const now = db.prepare('SELECT id, text, expires_at, synced FROM muted_words').all() as { id: number; text: string; expires_at: number | null; synced: string }[]
    for (const w of now) {
      const key = keyOf(w.text)
      // An account whose settings couldn't be read this time keeps what was known about it
      const synced: string[] = (JSON.parse(w.synced || '[]') as string[]).filter((did) => !lists.has(did))
      for (const a of signed) {
        if (!lists.has(a.did!)) continue
        if (!has(a.did!, key)) {
          try {
            await a.agent.addMutedWord({
              value: w.text.trim().replace(/^#/, ''),
              targets: w.text.trim().startsWith('#') ? ['tag'] : ['content', 'tag'],
              actorTarget: 'all',
              ...(w.expires_at ? { expiresAt: new Date(w.expires_at).toISOString() } : {}),
            })
          } catch (err: any) {
            errors.push(`@${a.handle}: ${err?.message ?? err}`)
            continue
          }
        }
        synced.push(a.did!)
      }
      db.prepare('UPDATE muted_words SET synced = ? WHERE id = ?').run(JSON.stringify(synced), w.id)
    }
    syncState.lastMs = Date.now()
    syncState.error = errors.join('; ')
    if (errors.length) console.error(`Muted words sync: ${syncState.error}`)
    reload()
  })().finally(() => {
    syncing = null
  })
  return syncing
}

// At startup and every 10 minutes, so words added or removed in the Bluesky app show up here
export function startMutedSync() {
  setTimeout(() => syncMuted().catch(() => {}), 15_000)
  setInterval(() => syncMuted().catch(() => {}), 10 * 60_000)
}
