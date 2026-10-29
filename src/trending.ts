// Trending topics within posts by people you follow: hashtags, words, two-word phrases,
// shared links and mentioned accounts, scored by how many different people used them
// recently compared with their usual rate.
import { db } from './db.ts'
import { accounts } from './accounts.ts'

const BASELINE_DAYS = 7
// Words and phrases need 3 people; a link, hashtag or mention shared by 2 already says something
const MIN_PEOPLE = 3
const MIN_PEOPLE_SHARED = 2
// Share of a word's uses that must be capitalized mid-sentence for it to count as a name
const NAME_SHARE = 0.5
const CACHE_MS = 2 * 60_000

// Common English words that never make interesting topics
const STOP = new Set(
  `a about above actually after again against all almost also always am an and any anyone anything are aren't around as at
  back be became because become been before being below best better between big both but by came can can't cannot could
  couldn't day days did didn't do does doesn't doing don't done down during each else enough even ever every everyone
  everything few find first for from full further get gets getting give go goes going gone good got great had hadn't has
  hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll
  i'm i've if in into is isn't it it's its itself just keep know last least less let let's like little look lot lots made
  make many may maybe me might mine more most much must my myself need never new next no nor not nothing now of off oh ok
  okay old on once one only or other others our ours ourselves out over own part people per please pretty put quite rather
  really right said same saw say says see seem seems seen she she'd she'll she's should shouldn't since so some someone
  something still such sure take than thank thanks that that's the their theirs them themselves then there there's these
  they they'd they'll they're they've thing things think this those though thought through time times to today too took
  under until up upon us use used very via want wanted was wasn't way we we'd we'll we're we've well went were weren't what
  what's when when's where where's whether which while who who's whole whom whose why why's will with within without won't
  would wouldn't yeah yes yet you you'd you'll you're you've your yours yourself yourselves year years week weeks morning
  night tonight tomorrow yesterday lol omg yep nope gonna wanna gotta got kinda sorta also anyway literally definitely
  probably totally basically thing stuff ever bit bunch already able feel feels felt hope love lmao tbh imo fwiw btw
  post posts posted posting bluesky bsky skeet thread reply replies
  monday tuesday wednesday thursday friday saturday sunday january february march april june july august
  september october november december`.split(/\s+/),
)

type Row = { uri: string; author_did: string; sort_at: number; reply_parent: string | null; reply_root: string | null }

// uri -> topic keys found in that post (posts don't change, so this is cached for the session)
const termsByUri = new Map<string, string[]>()
// uri -> the text and linked-article title of the post, for picking summary statements
const infoByUri = new Map<string, { text: string; title?: string; desc?: string }>()
// topic key -> display label (link titles, handles)
const labels = new Map<string, string>()

function normalizeLink(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (!/^https?:$/.test(u.protocol)) return null
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|s$|share)/i.test(k)) u.searchParams.delete(k)
    }
    u.hash = ''
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    const path = u.pathname.replace(/\/+$/, '')
    const search = u.searchParams.toString()
    return `${host}${path}${search ? `?${search}` : ''}`
  } catch {
    return null
  }
}

// Text with links, mentions and hashtags removed, using the facets' byte ranges
function plainText(text: string, facets: any[]): string {
  if (!facets?.length) return text
  const bytes = new TextEncoder().encode(text)
  const dec = new TextDecoder()
  let out = ''
  let pos = 0
  for (const f of [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart)) {
    const { byteStart, byteEnd } = f.index ?? {}
    if (!(byteStart >= pos) || byteEnd > bytes.length) continue
    out += dec.decode(bytes.slice(pos, byteStart)) + ' '
    pos = byteEnd
  }
  return out + dec.decode(bytes.slice(pos))
}

function extract(record: any, langs: string | null): string[] {
  const terms = new Set<string>()
  const facets: any[] = Array.isArray(record?.facets) ? record.facets : []

  for (const f of facets) {
    for (const feat of f.features ?? []) {
      if (feat.$type === 'app.bsky.richtext.facet#tag' && feat.tag) terms.add(`#${String(feat.tag).toLowerCase()}`)
      if (feat.$type === 'app.bsky.richtext.facet#mention' && feat.did) terms.add(`@${feat.did}`)
      if (feat.$type === 'app.bsky.richtext.facet#link') {
        const key = normalizeLink(feat.uri)
        if (key) terms.add(`link:${key}`)
      }
    }
  }
  for (const t of record?.tags ?? []) terms.add(`#${String(t).toLowerCase()}`)

  const ext = record?.embed?.external ?? record?.embed?.media?.external
  if (ext?.uri) {
    const key = normalizeLink(ext.uri)
    if (key) {
      terms.add(`link:${key}`)
      if (ext.title && !labels.has(`link:${key}`)) labels.set(`link:${key}`, String(ext.title).slice(0, 140))
    }
  }

  // Words and phrases only for English (or unlabeled) posts; the stopword list is English
  const lang = (langs ?? '').toLowerCase()
  if (!lang || lang.split(',').some((l) => l.startsWith('en'))) {
    const text = plainText(String(record?.text ?? ''), facets)
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[’']/g, "'")
    // A word counts as name-like when it's capitalized somewhere other than the start of a sentence
    // (or is an acronym). Name-like uses are recorded as "c:" / "cp:" keys alongside the topic.
    let prev: string | null = null
    let prevRaw = ''
    let prevCap = false
    for (const m of text.matchAll(/[\p{L}][\p{L}\p{N}'-]*/gu)) {
      const raw = m[0].replace(/^'+|'+$/g, '').replace(/'s$/i, '')
      const w = raw.toLowerCase()
      let i = m.index - 1
      while (i >= 0 && text[i] === ' ') i--
      // Mid-sentence only when it follows a word, number or comma, not an emoji, dash or bullet ("🎧 Listen")
      const sentenceStart = i < 0 || !/[\p{L}\p{N},;]/u.test(text[i])
      // Short all-caps words are acronyms (NFL, NASA); longer ones are usually shouting
      const acronym = /^\p{Lu}{2,4}$/u.test(raw)
      const cap = acronym || (/^\p{Lu}\p{Ll}/u.test(raw) && !sentenceStart)
      const keep = (w.length >= 3 || acronym) && !STOP.has(w) && !/^\d+$/.test(w)
      if (keep) {
        terms.add(`w:${w}`)
        if (cap) {
          terms.add(`c:${w}`)
          if (!labels.has(`w:${w}`)) labels.set(`w:${w}`, raw)
        }
        if (prev) {
          terms.add(`p:${prev} ${w}`)
          if (cap || prevCap) {
            terms.add(`cp:${prev} ${w}`)
            if (cap && prevCap && !labels.has(`p:${prev} ${w}`)) labels.set(`p:${prev} ${w}`, `${prevRaw} ${raw}`)
          }
        }
      }
      prev = keep ? w : null
      prevRaw = raw
      prevCap = keep && cap
    }
  }
  return [...terms]
}

// Loads the posts by people you follow since `sinceMs`, extracting topics for any not seen before
function corpus(sinceMs: number, who: string, english = false): Row[] {
  const params: (string | number)[] = [sinceMs]
  let authorFilter = 'author_did IN (SELECT subject_did FROM follows)'
  const signedIn = accounts.filter((a) => a.ok && a.did)
  if (who === 'both' && signedIn.length === 2) {
    authorFilter = `author_did IN (SELECT subject_did FROM follows WHERE account_did IN (?, ?)
      GROUP BY subject_did HAVING COUNT(*) = 2)`
    params.push(signedIn[0].did!, signedIn[1].did!)
  } else if (who === '1' || who === '2') {
    const acct = signedIn.find((a) => a.slot === Number(who))
    if (acct) {
      authorFilter = 'author_did IN (SELECT subject_did FROM follows WHERE account_did = ?)'
      params.push(acct.did!)
    }
  }
  const rows = db
    .prepare(
      `SELECT uri, author_did, sort_at, reply_parent, reply_root FROM posts
       WHERE sort_at > ? AND ${authorFilter}${english ? ' AND is_en = 1' : ''} ORDER BY sort_at DESC`,
    )
    .all(...params) as Row[]

  // Old posts get pruned from the database; start the cache over now and then so it can't grow forever
  if (termsByUri.size > 200_000) {
    termsByUri.clear()
    infoByUri.clear()
  }
  const missing = rows.filter((r) => !termsByUri.has(r.uri)).map((r) => r.uri)
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500)
    const recs = db
      .prepare(`SELECT uri, record, langs FROM posts WHERE uri IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as { uri: string; record: string; langs: string | null }[]
    for (const r of recs) {
      let record = {}
      try {
        record = JSON.parse(r.record)
      } catch {}
      termsByUri.set(r.uri, extract(record, r.langs))
      const rec: any = record
      const ext = rec?.embed?.external ?? rec?.embed?.media?.external
      infoByUri.set(r.uri, {
        text: typeof rec?.text === 'string' ? rec.text : '',
        title: ext?.title ? String(ext.title) : undefined,
        desc: ext?.description ? String(ext.description) : undefined,
      })
    }
  }
  return rows
}

function labelFor(term: string): { kind: string; label: string } {
  if (term.startsWith('#')) return { kind: 'tag', label: term }
  if (term.startsWith('w:')) return { kind: 'word', label: labels.get(term) ?? term.slice(2) }
  if (term.startsWith('p:')) return { kind: 'phrase', label: labels.get(term) ?? term.slice(2) }
  if (term.startsWith('link:')) return { kind: 'link', label: labels.get(term) ?? term.slice(5) }
  if (term.startsWith('@')) {
    const did = term.slice(1)
    const p = db.prepare('SELECT handle, display_name FROM profiles WHERE did = ?').get(did) as
      | { handle: string | null; display_name: string | null }
      | undefined
    return { kind: 'mention', label: p?.display_name || (p?.handle ? `@${p.handle}` : did) }
  }
  return { kind: 'other', label: term }
}

export type Topic = {
  term: string
  kind: string
  label: string
  handle?: string
  url?: string
  people: number
  posts: number
  prevPeople: number
  usual: number
  ratio: number
  isNew: boolean
  score: number
}

const cache = new Map<string, { at: number; value: any }>()

export function trending(hours: number, who: string, english = false) {
  const key = `${hours}|${who}|${english}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const now = Date.now()
  const H = hours * 3_600_000
  const windowStart = now - H
  const baselineStart = windowStart - BASELINE_DAYS * 86_400_000
  const rows = corpus(baselineStart, who, english)

  // Pass 1: who used each topic in the current window
  const nowPeople = new Map<string, Set<string>>()
  const nowPosts = new Map<string, number>()
  let windowPosts = 0
  for (const r of rows) {
    if (r.sort_at <= windowStart) break // rows are newest first
    windowPosts++
    for (const t of termsByUri.get(r.uri) ?? []) {
      let s = nowPeople.get(t)
      if (!s) nowPeople.set(t, (s = new Set()))
      s.add(r.author_did)
      nowPosts.set(t, (nowPosts.get(t) ?? 0) + 1)
    }
  }
  const isMarker = (t: string) => t.startsWith('c:') || t.startsWith('cp:')
  const isText = (t: string) => t.startsWith('w:') || t.startsWith('p:')
  const nameLike = (t: string) => {
    const marker = t.startsWith('w:') ? `c:${t.slice(2)}` : `cp:${t.slice(2)}`
    return (nowPosts.get(marker) ?? 0) >= NAME_SHARE * (nowPosts.get(t) ?? 1)
  }
  const candidates = new Set(
    [...nowPeople]
      .filter(([t, s]) => !isMarker(t) && s.size >= (isText(t) ? MIN_PEOPLE : MIN_PEOPLE_SHARED))
      // Ordinary words ("game", "win") only count when people write them as names ("Michigan", "NASA")
      .filter(([t]) => !isText(t) || nameLike(t))
      .map(([t]) => t),
  )

  // Pass 2: the same topics in earlier windows of the same length. Bucket 0 is the window just before.
  const buckets = Math.max(1, Math.floor((BASELINE_DAYS * 24) / hours))
  const before = new Map<string, Set<string>[]>()
  const bucketHasPosts = new Array(buckets).fill(false)
  for (const r of rows) {
    if (r.sort_at > windowStart) continue
    const b = Math.floor((windowStart - r.sort_at) / H)
    if (b >= buckets) continue
    bucketHasPosts[b] = true
    for (const t of termsByUri.get(r.uri) ?? []) {
      if (!candidates.has(t)) continue
      let arr = before.get(t)
      if (!arr) before.set(t, (arr = []))
      ;(arr[b] ??= new Set()).add(r.author_did)
    }
  }
  // Only average over earlier windows we actually have posts for (history may be short)
  const coveredBuckets = bucketHasPosts.filter(Boolean).length

  const topics: Topic[] = []
  for (const t of candidates) {
    const people = nowPeople.get(t)!.size
    const arr = before.get(t) ?? []
    let total = 0
    arr.forEach((s, i) => {
      if (s && bucketHasPosts[i]) total += s.size
    })
    const usual = coveredBuckets ? total / coveredBuckets : 0
    const ratio = (people + 1) / (usual + 1)
    const { kind, label } = labelFor(t)
    topics.push({
      term: t,
      kind,
      label,
      people,
      posts: nowPosts.get(t) ?? 0,
      prevPeople: arr[0]?.size ?? 0,
      usual: Math.round(usual * 10) / 10,
      ratio: Math.round(ratio * 10) / 10,
      isNew: coveredBuckets > 0 && total === 0,
      score: people * Math.log2(1 + ratio),
      ...(kind === 'link' ? { url: `https://${t.slice(5)}` } : {}),
    })
  }

  // A word is redundant when most of its uses are inside repeated name-like phrases ("State" in
  // "Ohio State", "Michigan State"...), even if each phrase is too small to trend by itself.
  // Summing over phrases overcounts a little, which errs toward hiding fragments.
  const inPhrases = new Map<string, number>()
  for (const [t, people] of nowPeople) {
    if (!t.startsWith('cp:') || people.size < 2) continue
    for (const w of t.slice(3).split(' ')) inPhrases.set(w, (inPhrases.get(w) ?? 0) + people.size)
  }
  const redundant = new Set<string>()
  for (const w of topics.filter((x) => x.kind === 'word')) {
    if ((inPhrases.get(w.term.slice(2)) ?? 0) >= 0.6 * w.people) redundant.add(w.term)
  }
  const kept = topics.filter((x) => !redundant.has(x.term))

  const windowRows = rows.filter((r) => r.sort_at > windowStart)
  const rising = kept
    .filter((x) => x.ratio >= 1.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
  const popular = [...kept].sort((a, b) => b.people - a.people || b.posts - a.posts).slice(0, 40)

  const value = {
    hours,
    windowPosts,
    historyDays: Math.round(((coveredBuckets * hours) / 24) * 10) / 10,
    rising: withSummaries(rising, windowRows),
    popular: withSummaries(popular, windowRows),
    shared: mostShared(windowStart, rows),
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

// Posts that several people you follow reposted or quoted in the window
function mostShared(windowStart: number, rows: Row[]) {
  const authors = new Set(rows.map((r) => r.author_did))
  const sharers = new Map<string, Set<string>>()
  const add = (uri: string | null, did: string) => {
    if (!uri) return
    let s = sharers.get(uri)
    if (!s) sharers.set(uri, (s = new Set()))
    s.add(did)
  }
  const reposts = db
    .prepare('SELECT author_did, subject_uri FROM reposts WHERE sort_at > ?')
    .all(windowStart) as { author_did: string; subject_uri: string | null }[]
  for (const r of reposts) if (authors.has(r.author_did)) add(r.subject_uri, r.author_did)

  const quotes = db
    .prepare(
      `SELECT author_did, COALESCE(json_extract(embed, '$.record.uri'), json_extract(embed, '$.record.record.uri')) quoted
       FROM posts WHERE sort_at > ? AND embed IS NOT NULL`,
    )
    .all(windowStart) as { author_did: string; quoted: string | null }[]
  for (const q of quotes) if (authors.has(q.author_did) && q.quoted?.includes('/app.bsky.feed.post/')) add(q.quoted, q.author_did)

  return [...sharers]
    .filter(([, s]) => s.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 15)
    .map(([uri, s]) => ({ uri, sharers: [...s] }))
}

// Posts in the window that contain a topic, newest first, for the drill-down
export function postsForTopic(term: string, hours: number, who: string, before: number | null, limit: number, english = false) {
  const windowStart = Date.now() - hours * 3_600_000
  const rows = corpus(windowStart, who, english)
  const matched = rows.filter((r) => (!before || r.sort_at < before) && termsByUri.get(r.uri)?.includes(term))
  return matched.slice(0, limit + 10)
}

// ---------- summaries ----------
// A one-line statement of what each topic is about, picked from the posts behind it (no AI involved):
// the headline of an article several of those posts link to, otherwise the sentence that best
// represents what people are saying, plus other names that come up alongside it.

const SUMMARY_FOR = 15 // per list; enough for the top 5 plus some of "show all"

function trim(text: string, max = 170): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

function sentencesOf(text: string): string[] {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 30 && x.length <= 260)
}

function summarize(topic: Topic, windowRows: Row[]) {
  const posts = windowRows.filter((r) => termsByUri.get(r.uri)?.includes(topic.term))
  if (!posts.length) return {}

  // How many of these posts each other topic appears in
  const co = new Map<string, number>()
  for (const r of posts) {
    for (const t of termsByUri.get(r.uri) ?? []) if (t !== topic.term) co.set(t, (co.get(t) ?? 0) + 1)
  }

  // Other names that come up with it: name-like words/phrases, hashtags or mentions in 2+ of the posts
  const ownWords = new Set(topic.term.replace(/^(w:|p:|#)/, '').split(' '))
  const related = [...co]
    .filter(([t, n]) => n >= 2 && n >= posts.length * 0.15)
    .filter(([t]) => {
      if (t.startsWith('#') || t.startsWith('@')) return true
      if (t.startsWith('w:')) return !ownWords.has(t.slice(2)) && (co.get(`c:${t.slice(2)}`) ?? 0) >= 0.5 * (co.get(t) ?? 0)
      if (t.startsWith('p:')) return (co.get(`cp:${t.slice(2)}`) ?? 0) >= 0.5 * (co.get(t) ?? 0)
      return false
    })
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => labelFor(t).label)
  // Drop fragments of longer names in the same list ("Tech" when "Texas Tech" is there)
  const contains = (long: string, short: string) =>
    long !== short && new RegExp(`(^|\\s)${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(long)
  const relatedNames = related
    .filter((label, i) => !related.some((other, j) => j !== i && contains(other, label)))
    .filter((label) => !contains(label, topic.label.replace(/^#/, '')))
    .filter((label, i, all) => all.findIndex((x) => x.toLowerCase() === label.toLowerCase()) === i)
    .slice(0, 3)

  // 1. A linked article's headline, if 2+ posts share it (or it's a link topic)
  if (topic.kind === 'link') {
    const info = posts.map((r) => infoByUri.get(r.uri)).find((i) => i?.desc)
    if (info?.desc) return { summary: trim(info.desc), source: 'article', related: relatedNames }
  }
  const titles = new Map<string, number>()
  for (const r of posts) {
    const title = infoByUri.get(r.uri)?.title?.trim()
    if (title && title.length >= 20) titles.set(title, (titles.get(title) ?? 0) + 1)
  }
  const [bestTitle, titleCount] = [...titles].sort((a, b) => b[1] - a[1])[0] ?? []
  if (bestTitle && titleCount! >= 2) return { summary: trim(bestTitle), source: 'article', related: relatedNames }

  // 2. The sentence whose words show up most across the posts about this topic
  const needle = topic.label.replace(/^#/, '').toLowerCase()
  let best = ''
  let bestScore = 0
  for (const r of posts) {
    for (const sentence of sentencesOf(infoByUri.get(r.uri)?.text ?? '')) {
      const words = new Set(sentence.toLowerCase().match(/[\p{L}][\p{L}\p{N}'-]*/gu) ?? [])
      let score = 0
      for (const w of words) score += co.get(`w:${w}`) ?? 0
      score /= Math.sqrt(words.size || 1)
      if (sentence.toLowerCase().includes(needle)) score *= 1.5
      if (score > bestScore) {
        bestScore = score
        best = sentence
      }
    }
  }
  if (best) return { summary: trim(best), source: 'post', related: relatedNames }
  if (bestTitle) return { summary: trim(bestTitle), source: 'article', related: relatedNames }
  return { related: relatedNames }
}

function withSummaries(list: Topic[], windowRows: Row[]) {
  return list.map((t, i) => (i < SUMMARY_FOR ? { ...t, ...summarize(t, windowRows) } : t))
}
