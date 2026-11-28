// Videos tab: the newest videos from people you follow (or everyone on Bluesky), a cloud of the words
// they use, and search.
// - People I follow: read from the posts Skydash already stores, so it's instant and covers all accounts.
// - Everyone: Bluesky's newer search (app.bsky.feed.searchPostsV2, what bsky.app's search Filters use),
//   which can return only posts with a video.
import type { AppBskyFeedDefs } from '@atproto/api'
import { db } from './db.ts'
import { primaryAccount, remember } from './hydrate.ts'
import type { Account } from './accounts.ts'
import { extract, labelFor } from './trending.ts'
import { MUTED_SQL, anyMuted } from './muted.ts'

type PostView = AppBskyFeedDefs.PostView

export const HOURS = [3, 24, 72, 168, 720, 0] // 0 = any time
const MIN_FOLLOWING = 50 // People I follow, last 3 hours: always show at least the last 50 videos
const CLOUD_SIZE = 20
const CLOUD_SAMPLE = 500 // Everyone: the cloud comes from the newest 500 videos
const VIDEO = 'app.bsky.embed.video'

// ---------- what counts as a video ----------

// Sites whose links are videos (highlights are often posted as YouTube or Streamable links)
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'streamable.com', 'twitch.tv', 'tiktok.com', 'dailymotion.com', 'dai.ly']

function isVideoLink(uri: string | undefined): boolean {
  if (!uri) return false
  try {
    const host = new URL(uri).hostname.replace(/^(www|m)\./, '')
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

// A stored post record's embed: 'video' (in the post), 'link' (a video-site link card) or null
function storedKind(embedJson: unknown): 'video' | 'link' | null {
  if (typeof embedJson !== 'string' || !embedJson) return null
  try {
    const e = JSON.parse(embedJson)
    const media = e?.$type === 'app.bsky.embed.recordWithMedia' ? e.media : e
    if (media?.$type === VIDEO) return 'video'
    if (isVideoLink(media?.external?.uri)) return 'link'
  } catch {}
  return null
}
db.function('video_kind', { deterministic: true }, (embed: unknown) => storedKind(embed))

// ---------- word matching (People I follow, where Skydash searches its own posts) ----------

// "exact phrase", -word and plain words (all must appear), whole words, capitals ignored.
// Text, link card and video/image descriptions count.
type Matcher = (haystack: string) => boolean
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// "#tag" matches only the hashtag; a plain word also matches it as a hashtag
function wordRe(term: string) {
  const tag = term.startsWith('#')
  const t = term.replace(/^#/, '')
  return new RegExp(`(^|[^\\p{L}\\p{N}_#])${tag ? '#' : '#?'}${escapeRe(t)}($|[^\\p{L}\\p{N}_])`, 'iu')
}
function matcher(query: string): Matcher | null {
  const want: RegExp[] = []
  const not: RegExp[] = []
  for (const m of query.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const neg = m[1] === '-' || m[3] === '-'
    const term = (m[2] ?? m[4] ?? '').trim()
    if (!term || /^(AND|OR)$/.test(term)) continue
    ;(neg ? not : want).push(wordRe(term))
  }
  if (!want.length && !not.length) return null
  return (h) => want.every((re) => re.test(h)) && !not.some((re) => re.test(h))
}
function searchable(record: any): string {
  const parts = [record?.text ?? '']
  const e = record?.embed
  const ext = e?.external ?? e?.media?.external
  if (ext) parts.push(ext.title ?? '', ext.description ?? '')
  const media = e?.media ?? e
  if (media?.alt) parts.push(media.alt)
  for (const t of record?.tags ?? []) parts.push(`#${t}`)
  return parts.join(' ')
}

// ---------- adult content ----------

// Everyone on Bluesky includes a lot of adult video. Posts labeled adult (by Bluesky's moderation or by
// the poster) or tagged like it are left out of Everyone and of every cloud.
const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore'])
const ADULT_TAG = /^(nsfw\w*|porn\w*|18\+?|18plus|xxx|onlyfans|spicysky|nsfwbsky|sinventory|lewd\w*|nude\w*|hentai|cum\w*|sex\w*|horny\w*|gay(porn|nsfw)\w*|furry(nsfw|porn)\w*|bdsm\w*|kink\w*|fetish\w*)$/i
function isAdult(labels: any[] | undefined, record: any): boolean {
  if ((labels ?? []).some((l) => ADULT_LABELS.has(l?.val))) return true
  if ((record?.labels?.values ?? []).some((l: any) => ADULT_LABELS.has(l?.val))) return true
  const tags = [...(record?.tags ?? []), ...String(record?.text ?? '').matchAll(/#([\p{L}\p{N}_+]+)/gu)].map((t: any) => (typeof t === 'string' ? t : t[1]))
  return tags.some((t) => ADULT_TAG.test(t))
}

// ---------- the word cloud ----------

// Words common in video posts that say nothing about what's in them
const FILLER = new Set(('video videos clip clips watch watching watched link links check free live full new today tonight day days time ' +
  'got get two one three first second last next self play playing played drop dropped finish finished guys love follow following like ' +
  'see look make made need want going gonna know really people thing things way good great best better big little back done stream ' +
  'streaming twitch youtube tiktok channel subscribe share post posted posting thread enjoy fun moment moments part episode ' +
  'fuck fucking fucked shit damn hell wtf omg lol lmao lmfao rofl ass bitch crap yes yeah yep nope wow oh ok okay hey hi bro dude ' +
  'please thanks thank happy sorry true real holy jesus god').split(' '))

type CloudWord = { term: string; label: string; count: number }

// Up to 20 words, phrases and #tags used by the most videos (at least 2). A word mostly used inside a
// chosen phrase ("lebron" in "lebron james") gives way to the phrase.
function cloudOf(records: { record: any; langs: string | null; labels?: any[] }[]): CloudWord[] {
  const counts = new Map<string, number>()
  const named = new Map<string, number>() // uses of a word written like a name (capitalized mid-sentence, acronym)
  for (const r of records) {
    if (isAdult(r.labels, r.record)) continue
    for (const t of new Set(extract(r.record, r.langs))) {
      if (t.startsWith('c:')) named.set(`w:${t.slice(2)}`, (named.get(`w:${t.slice(2)}`) ?? 0) + 1)
      if (t.startsWith('cp:')) named.set(`p:${t.slice(3)}`, (named.get(`p:${t.slice(3)}`) ?? 0) + 1)
      if (!/^(w:|p:|#)/.test(t)) continue
      const words = t.replace(/^(w:|p:|#)/, '').split(' ')
      if (words.every((w) => FILLER.has(w))) continue
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  // Words and phrases only count when they're mostly written like names (Kentucky, NFL, LeBron James),
  // not "game" or "lakers beat"; #tags always count
  const ranked = [...counts]
    .filter(([t, n]) => n >= 2 && (t.startsWith('#') || ((named.get(t) ?? 0) * 2 >= n &&
      // every word of a phrase is written like a name somewhere ("LeBron James", not "behind LeBron")
      (!t.startsWith('p:') || t.slice(2).split(' ').every((w) => named.has(`w:${w}`)))))).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
  const picked: [string, number][] = []
  for (const [t, n] of ranked) {
    if (picked.length >= CLOUD_SIZE) break
    if (t.startsWith('w:')) {
      const w = t.slice(2)
      if (picked.some(([p, pn]) => p.startsWith('p:') && p.slice(2).split(' ').includes(w) && pn >= n * 0.7)) continue
    }
    if (t.startsWith('p:')) {
      // A phrase replaces its words when it accounts for most of their uses
      const words = t.slice(2).split(' ')
      for (let i = picked.length - 1; i >= 0; i--) {
        const [p, pn] = picked[i]
        if (p.startsWith('w:') && words.includes(p.slice(2)) && n >= pn * 0.7) picked.splice(i, 1)
      }
    }
    if (t.startsWith('#') && picked.some(([p]) => p === `w:${t.slice(1)}`)) continue
    picked.push([t, n])
  }
  return picked.map(([term, count]) => {
    const label = term.startsWith('#') ? term : labelFor(term).label
    // What clicking it searches for: a phrase in quotes, a word or #tag as is
    const q = term.startsWith('p:') ? `"${label}"` : label
    return { term: q, label, count }
  })
}

// ---------- Bluesky's newer search ----------

const SEARCH_V2 = 'app.bsky.feed.searchPostsV2'
const APPVIEW = 'did:web:api.bsky.app#bsky_appview'

// The installed @atproto/api predates searchPostsV2, so its definition is added here (only the
// parameters Skydash sends). The call then goes through each account's normal signed-in agent.
const SEARCH_V2_LEXICON = {
  lexicon: 1,
  id: SEARCH_V2,
  defs: {
    main: {
      type: 'query',
      parameters: {
        type: 'params',
        properties: {
          query: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          sort: { type: 'string', knownValues: ['recent', 'top'] },
          since: { type: 'string' },
          allTime: { type: 'boolean' },
          languages: { type: 'array', items: { type: 'string' } },
          hasVideo: { type: 'boolean' },
          excludeReplies: { type: 'boolean' },
          repliesOnly: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          cursor: { type: 'string' },
        },
      },
      output: {
        encoding: 'application/json',
        schema: {
          type: 'object',
          required: ['posts'],
          properties: {
            cursor: { type: 'string' },
            hitsTotal: { type: 'integer' },
            posts: { type: 'array', items: { type: 'ref', ref: 'lex:app.bsky.feed.defs#postView' } },
          },
        },
      },
    },
  },
} as const

function ensureLexicon(account: Account) {
  const lex = (account.agent as any).lex
  if (!lex.getDef(SEARCH_V2)) lex.add(SEARCH_V2_LEXICON)
}

async function searchV2(account: Account, params: Record<string, unknown>) {
  ensureLexicon(account)
  const res = await account.agent.call(SEARCH_V2, params, undefined, { headers: { 'atproto-proxy': APPVIEW } })
  return res.data as { posts: PostView[]; cursor?: string; hitsTotal?: number }
}

// A search that's only #tags counts as no search words to Bluesky, which then refuses a start time.
// Sending the tags as words plus a hashtag filter finds the same posts and takes a time range.
function queryParams(q: string): Record<string, unknown> {
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length && tokens.every((t) => /^#[\p{L}\p{N}_]+$/u.test(t))) {
    const tags = tokens.map((t) => t.slice(1))
    return { query: tags.join(' '), hashtags: tags }
  }
  return { query: q }
}

// ---------- the view ----------

export type VideoQuery = {
  scope: 'following' | 'everyone'
  q: string
  sort: 'latest' | 'top'
  hours: number
  links: boolean
  english: boolean
  type: string
  before?: string
  limit: number
}

type Row = { uri: string; author_did: string; sort_at: number; reply_parent: string | null; reply_root: string | null }

function signedIn() {
  const account = primaryAccount()
  if (!account) throw Object.assign(new Error('No account is signed in'), { status: 503 })
  return account
}

// Stored video posts by people you follow, newest first, from `sinceMs` (and before `beforeMs`)
function followingRows(v: VideoQuery, sinceMs: number, beforeMs = Infinity, max = 5000) {
  const where = ['p.sort_at > ?', 'p.author_did IN (SELECT subject_did FROM follows)', v.links ? "video_kind(p.embed) IN ('video', 'link')" : "video_kind(p.embed) = 'video'"]
  const params: (string | number)[] = [sinceMs]
  if (beforeMs !== Infinity) {
    where.push('p.sort_at < ?')
    params.push(beforeMs)
  }
  if (v.english) where.push('p.is_en = 1')
  if (v.type === 'posts') where.push('p.reply_parent IS NULL')
  if (v.type === 'replies') where.push('p.reply_parent IS NOT NULL')
  if (anyMuted()) where.push(MUTED_SQL)
  return db
    .prepare(
      `SELECT p.uri, p.author_did, p.sort_at, p.reply_parent, p.reply_root, p.record, p.langs FROM posts p
       WHERE ${where.join(' AND ')} ORDER BY p.sort_at DESC LIMIT ?`,
    )
    .all(...params, max) as (Row & { record: string | null; langs: string | null })[]
}

// Where the People I follow window starts: the chosen hours back, but for 3 hours at least the last 50 videos
function followingStart(v: VideoQuery) {
  const now = Date.now()
  if (!v.hours) return 0
  const start = now - v.hours * 3_600_000
  if (v.hours !== 3) return start
  const nth = followingRows({ ...v, q: '' }, 0, Infinity, MIN_FOLLOWING).at(-1)
  return nth ? Math.min(start, nth.sort_at - 1) : start
}

function parse(json: string | null) {
  try {
    return JSON.parse(json ?? '{}')
  } catch {
    return {}
  }
}

// One page of videos. Returns rows to hydrate, the cursor for the next page, and (on the first page of
// an unsearched view) the word cloud.
export async function videoPage(v: VideoQuery) {
  if (v.scope === 'following') {
    const start = followingStart(v)
    const before = Number(v.before) || Infinity
    const match = v.q ? matcher(v.q) : null
    const all = followingRows(v, start)
    const kept = match ? all.filter((r) => match(searchable(parse(r.record)))) : all
    const page = kept.filter((r) => r.sort_at < before).slice(0, v.limit)
    const more = kept.filter((r) => r.sort_at < before).length > v.limit
    const cloud = before === Infinity ? cloudOf(all.map((r) => ({ record: parse(r.record), langs: r.langs }))) : undefined
    return {
      rows: page as Row[],
      cursor: more ? String(page.at(-1)!.sort_at) : null,
      total: kept.length,
      sinceMs: start,
      cloud,
    }
  }

  // Everyone: Bluesky search, video only
  const account = signedIn()
  const params: Record<string, unknown> = {
    hasVideo: true,
    sort: v.sort === 'top' ? 'top' : 'recent',
    limit: Math.min(v.limit, 100),
  }
  // Bluesky only takes a start time alongside search words; without words, older posts are cut off here
  if (v.q) Object.assign(params, queryParams(v.q))
  if (v.q && v.hours) params.since = new Date(Date.now() - v.hours * 3_600_000).toISOString()
  if (!v.hours || v.hours > 168) params.allTime = true
  if (v.english) params.languages = ['en']
  if (v.type === 'posts') params.excludeReplies = true
  if (v.type === 'replies') params.repliesOnly = true
  if (v.before) params.cursor = v.before

  const res = await searchV2(account, params)
  const sinceMs = v.hours ? Date.now() - v.hours * 3_600_000 : 0
  const cut = !v.q && sinceMs > 0
  let cursor = res.cursor ?? null
  // Newest first: once a page reaches past the window, there's nothing more to read
  if (cut && params.sort === 'recent' && res.posts.length && Date.parse(res.posts.at(-1)!.indexedAt) < sinceMs) cursor = null
  const fresh = (cut ? res.posts.filter((p) => Date.parse(p.indexedAt) >= sinceMs) : res.posts).filter((p) => !isAdult(p.labels, p.record))

  // Cloud for the first page: the newest 500 videos in this time range, whatever the search words
  let cloud: CloudWord[] | undefined
  if (!v.before) {
    const { query: _q, since: _s, cursor: _c, ...base } = params
    cloud = await everyoneCloud(account, { ...base, sort: 'recent' }, sinceMs).catch(() => undefined)
  }

  remember(account, fresh)
  const rows = fresh.map((p) => {
    const rec = p.record as any
    const created = Date.parse(rec?.createdAt)
    const indexed = Date.parse(p.indexedAt)
    return {
      uri: p.uri,
      author_did: p.author.did,
      sort_at: Number.isFinite(created) ? Math.min(created, indexed) : indexed,
      reply_parent: rec?.reply?.parent?.uri ?? null,
      reply_root: rec?.reply?.root?.uri ?? null,
    }
  })
  return { rows, cursor, total: res.hitsTotal ?? null, sinceMs, cloud }
}

// The Everyone cloud is cached for 5 minutes per set of filters
const cloudCache = new Map<string, { at: number; cloud: CloudWord[] }>()
async function everyoneCloud(account: Account, params: Record<string, unknown>, sinceMs: number) {
  const key = JSON.stringify({ ...params, limit: undefined, hours: Math.round((Date.now() - sinceMs) / 3_600_000) })
  const hit = cloudCache.get(key)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.cloud
  const sample: PostView[] = []
  let cursor: string | undefined
  let pages = 0
  while (sample.length < CLOUD_SAMPLE && pages++ < 6 && (pages === 1 || cursor)) {
    const res = await searchV2(account, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }).catch((err) => {
      if (!sample.length) throw err
      return null // a later page failing still leaves a cloud from what was read
    })
    if (!res) break
    const inWindow = res.posts.filter((p) => !sinceMs || Date.parse(p.indexedAt) >= sinceMs)
    sample.push(...inWindow)
    cursor = inWindow.length < res.posts.length && params.sort === 'recent' ? undefined : res.cursor
  }
  const cloud = cloudOf(sample.map((p) => ({ record: p.record, labels: p.labels, langs: Array.isArray((p.record as any)?.langs) ? (p.record as any).langs.join(',') : null })))
  cloudCache.set(key, { at: Date.now(), cloud })
  if (cloudCache.size > 50) cloudCache.delete(cloudCache.keys().next().value!)
  return cloud
}
