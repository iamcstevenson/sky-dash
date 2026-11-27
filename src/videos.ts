// Videos tab: searches all of Bluesky and keeps only posts with a video, for finding clips of games,
// races and matches. Nothing is saved: each search goes straight to Bluesky.
import type { AppBskyFeedDefs } from '@atproto/api'
import { primaryAccount, remember } from './hydrate.ts'
import { isEnglish } from './lang.ts'

type PostView = AppBskyFeedDefs.PostView

const PAGES_PER_REQUEST = 10 // up to 1,000 search results looked at per page of videos
const VIDEO = 'app.bsky.embed.video#view'

// Sites whose links are videos (highlights are often posted as YouTube or Streamable links)
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'streamable.com', 'twitch.tv', 'tiktok.com', 'dailymotion.com']

function isVideoLink(uri: string | undefined): boolean {
  if (!uri) return false
  try {
    const host = new URL(uri).hostname.replace(/^(www|m)\./, '')
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

// 'video' for a Bluesky video (in the post or a post it quotes), 'link' for a video-site link card, else null
export function videoKind(post: any): 'video' | 'link' | null {
  const e = post?.embed
  if (!e) return null
  const media = e.$type === 'app.bsky.embed.recordWithMedia#view' ? e.media : e
  if (media?.$type === VIDEO) return 'video'
  const quoted = e.$type === 'app.bsky.embed.record#view' ? e.record : e.$type === 'app.bsky.embed.recordWithMedia#view' ? e.record?.record : null
  if ((quoted?.embeds ?? []).some((x: any) => x?.$type === VIDEO || x?.media?.$type === VIDEO)) return 'video'
  if (media?.$type === 'app.bsky.embed.external#view' && isVideoLink(media.external?.uri)) return 'link'
  return null
}

export const HOURS = [24, 72, 168, 720, 0] // 0 = any time

export type VideoSearch = {
  q: string
  sort: 'latest' | 'top'
  hours: number
  links: boolean
  english: boolean
  type: string
  cursor?: string
  limit: number
}

// One page of video posts for a search, reading Bluesky's results until there's a page's worth.
// cursor is Bluesky's own, so the next page carries on where this one stopped looking.
export async function searchVideos(s: VideoSearch) {
  const account = primaryAccount()
  if (!account) throw Object.assign(new Error('No account is signed in'), { status: 503 })
  const found: PostView[] = []
  let cursor = s.cursor
  let pages = 0
  let scanned = 0
  do {
    const res = await account.agent.app.bsky.feed.searchPosts({
      q: s.q,
      sort: s.sort,
      ...(s.hours ? { since: new Date(Date.now() - s.hours * 3_600_000).toISOString() } : {}),
      limit: 100,
      cursor,
    })
    scanned += res.data.posts.length
    for (const p of res.data.posts) {
      const kind = videoKind(p)
      if (!kind || (kind === 'link' && !s.links)) continue
      const rec = p.record as any
      if (s.type === 'posts' && rec?.reply) continue
      if (s.type === 'replies' && !rec?.reply) continue
      if (s.english && !isEnglish(rec?.langs, typeof rec?.text === 'string' ? rec.text : '')) continue
      found.push(p)
    }
    cursor = res.data.cursor
    pages++
  } while (cursor && found.length < s.limit && pages < PAGES_PER_REQUEST)

  // The search already returned full post views; keep them so hydrating doesn't fetch them again
  remember(account, found)
  const rows = found.map((p) => {
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
  return { rows, cursor: cursor ?? null, scanned }
}
