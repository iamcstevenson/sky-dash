// A quick read of one person from their last 100 posts, for deciding whether to follow them (Discover side panel):
// what they post about, what kind of poster they are, the sites they link, who they talk with, how often they
// post and how their posts land. Read straight from Bluesky, so it works for people you don't follow.
import { AtpAgent } from '@atproto/api'
import { config } from './config.ts'
import { db } from './db.ts'
import { ownDids } from './accounts.ts'
import { extract, labelFor } from './trending.ts'

const publicAgent = new AtpAgent({ service: config.publicAppView })
const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; data: unknown }>()
// Contractions typed without the apostrophe, which the shared stopword list doesn't catch
const EXTRA_STOP = new Set('dont cant wont im ive id ill thats didnt doesnt isnt wasnt arent youre theyre weve whats theres lets looks yall'.split(' '))

type Person = { did: string; handle: string; displayName?: string; avatar?: string; replies: number; reposts: number }

export async function profileSnapshot(actor: string) {
  const hit = cache.get(actor)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data
  const res = await publicAgent.app.bsky.feed.getAuthorFeed({ actor, limit: 100, filter: 'posts_with_replies' })
  const items = res.data.feed.filter((i: any) => i.reason?.$type !== 'app.bsky.feed.defs#reasonPin')
  const own = new Set(ownDids())

  const mix = { posts: 0, replies: 0, quotes: 0, reposts: 0 }
  let withMedia = 0
  const reception = { likes: 0, replies: 0, reposts: 0, n: 0 }
  const topicCount = new Map<string, number>()
  const domains = new Map<string, number>()
  const people = new Map<string, Person>()
  const times: number[] = []
  const posts: { kind: string; post: unknown; replyTo?: string }[] = []
  const person = (a: any) => {
    let p = people.get(a.did)
    if (!p) people.set(a.did, (p = { did: a.did, handle: a.handle, displayName: a.displayName, avatar: a.avatar, replies: 0, reposts: 0 }))
    return p
  }

  for (const item of items as any[]) {
    const post = item.post
    const record = post.record ?? {}
    const at = Date.parse(item.reason?.indexedAt ?? record.createdAt ?? post.indexedAt) || 0
    if (at) times.push(Math.min(at, Date.now()))

    if (item.reason?.$type === 'app.bsky.feed.defs#reasonRepost') {
      mix.reposts++
      if (post.author?.did && post.author.did !== item.reason.by?.did) person(post.author).reposts++
      continue
    }
    const isReply = !!record.reply
    const isQuote = /^app\.bsky\.embed\.record(WithMedia)?$/.test(record.embed?.$type ?? '')
    const kind = isReply ? 'reply' : isQuote ? 'quote' : 'post'
    mix[isReply ? 'replies' : isQuote ? 'quotes' : 'posts']++
    const parent = item.reply?.parent?.author
    if (isReply && parent?.did && parent.did !== post.author.did) person(parent).replies++
    if (/images|video/.test(record.embed?.$type ?? '') || /images|video/.test(record.embed?.media?.$type ?? '')) withMedia++
    if (!isReply) {
      reception.likes += post.likeCount ?? 0
      reception.replies += post.replyCount ?? 0
      reception.reposts += post.repostCount ?? 0
      reception.n++
    }
    // Each topic counts once per post
    for (const term of extract(record, (record.langs ?? []).join(',') || null)) {
      if (term.startsWith('link:')) {
        const host = term.slice(5).split('/')[0]
        if (host && host !== 'bsky.app') domains.set(host, (domains.get(host) ?? 0) + 1)
      } else if (term.startsWith('#') || term.startsWith('w:') || term.startsWith('p:')) {
        if (term.slice(2).split(' ').some((w) => EXTRA_STOP.has(w))) continue
        topicCount.set(term, (topicCount.get(term) ?? 0) + 1)
      }
    }
    if (posts.length < 60) posts.push({ kind, post, replyTo: isReply ? parent?.handle : undefined })
  }

  // Topics used in 2+ posts. A word is left out when a phrase containing it is used about as often.
  const ranked = [...topicCount].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
  const phrases = ranked.filter(([t]) => t.startsWith('p:'))
  const topics = ranked
    .filter(([t, n]) => !t.startsWith('w:') || !phrases.some(([p, pn]) => pn >= n * 0.7 && p.slice(2).split(' ').includes(t.slice(2))))
    .slice(0, 20)
    .map(([t, n]) => ({ label: labelFor(t).label, kind: t.startsWith('#') ? 'tag' : t.startsWith('p:') ? 'phrase' : 'word', count: n }))

  const followed = db.prepare('SELECT 1 FROM follows WHERE subject_did = ? LIMIT 1')
  const talksWith = [...people.values()]
    .filter((p) => p.did !== actor)
    .sort((a, b) => b.replies + b.reposts - (a.replies + a.reposts))
    .slice(0, 6)
    .map((p) => ({ ...p, you: own.has(p.did), followed: !!followed.get(p.did) }))

  const oldest = times.length ? Math.min(...times) : Date.now()
  const days = Math.max(1, (Date.now() - oldest) / 86_400_000)
  const originals = mix.posts + mix.quotes + mix.replies
  const data = {
    count: items.length,
    days: Math.round(days * 10) / 10,
    perDay: Math.round((items.length / days) * 10) / 10,
    mix,
    mediaShare: originals ? Math.round((withMedia / originals) * 100) : 0,
    reception: reception.n
      ? { likes: Math.round((reception.likes / reception.n) * 10) / 10, replies: Math.round((reception.replies / reception.n) * 10) / 10, reposts: Math.round((reception.reposts / reception.n) * 10) / 10 }
      : null,
    topics,
    domains: [...domains].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([host, count]) => ({ host, count })),
    talksWith,
    times, // the browser turns these into active hours in your own time zone
    posts,
  }
  cache.set(actor, { at: Date.now(), data })
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  return data
}
