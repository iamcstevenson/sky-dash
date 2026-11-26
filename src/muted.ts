// Muted words and phrases: posts that contain one are left out of Following, Keywords, Lists and Trending.
// Matching ignores case and goes by whole words ("art" doesn't hide "start"), and #hashtags count, so "trump"
// also hides "#Trump". Checked in SQL (an SQLite function) so muted posts don't use up a page, and again on the
// finished items for feeds read from Bluesky (lists) and for quoted posts and link cards.
import { db } from './db.ts'

db.exec(`
  CREATE TABLE IF NOT EXISTS muted_words (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  );
`)

let words: { id: number; text: string }[] = []
let pattern: RegExp | null = null
let countsAt = 0
let counts = new Map<number, number>()

function reload() {
  words = db.prepare('SELECT id, text FROM muted_words ORDER BY text COLLATE NOCASE').all() as typeof words
  const parts = words.map((w) => w.text.trim().replace(/^#/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  pattern = parts.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${parts.join('|')})(?![\\p{L}\\p{N}_])`, 'iu') : null
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
      re: new RegExp(`(?<![\\p{L}\\p{N}_])${w.text.trim().replace(/^#/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'iu'),
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
  return { words: words.map((w) => ({ ...w, hiddenToday: c.get(w.id) ?? 0 })) }
}

export function addMuted(body: any) {
  const text = String(body?.text ?? '').trim().replace(/\s+/g, ' ')
  if (!text || text.replace(/^#/, '').length < 2) throw Object.assign(new Error('Enter a word or phrase (2+ characters)'), { status: 400 })
  if (text.length > 100) throw Object.assign(new Error('Keep it under 100 characters'), { status: 400 })
  db.prepare('INSERT OR IGNORE INTO muted_words (text, created_at) VALUES (?, ?)').run(text, Date.now())
  reload()
  return listMuted()
}

export function removeMuted(body: any) {
  db.prepare('DELETE FROM muted_words WHERE id = ?').run(Number(body?.id))
  reload()
  return listMuted()
}
