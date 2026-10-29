// Turns stored post URIs into full post views (author, counts, embeds) and records
// whether each of your accounts has liked or reposted them.
import type { AppBskyFeedDefs } from '@atproto/api'
import { accounts, type Account } from './accounts.ts'

type PostView = AppBskyFeedDefs.PostView
type Cached = { at: number; view: PostView | null }

const CACHE_MS = 60_000
const cache = new Map<string, Cached>()

export function primaryAccount(): Account | undefined {
  return accounts.find((a) => a.ok)
}

export function forget(uri: string) {
  for (const key of cache.keys()) if (key.endsWith(`|${uri}`)) cache.delete(key)
}

async function fetchViews(account: Account, uris: string[]): Promise<Map<string, PostView>> {
  const out = new Map<string, PostView>()
  const missing: string[] = []
  const now = Date.now()
  for (const uri of new Set(uris)) {
    const hit = cache.get(`${account.slot}|${uri}`)
    if (hit && now - hit.at < CACHE_MS) {
      if (hit.view) out.set(uri, hit.view)
    } else missing.push(uri)
  }

  const chunks: string[][] = []
  for (let i = 0; i < missing.length; i += 25) chunks.push(missing.slice(i, i + 25))
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await account.agent.app.bsky.feed.getPosts({ uris: chunk })
        const found = new Map(res.data.posts.map((p) => [p.uri, p]))
        for (const uri of chunk) {
          const view = found.get(uri) ?? null
          cache.set(`${account.slot}|${uri}`, { at: now, view })
          if (view) out.set(uri, view)
        }
      } catch (err) {
        console.error(`getPosts failed for @${account.handle}:`, (err as Error).message)
      }
    }),
  )
  return out
}

export type ViewerState = Record<number, { like?: string; repost?: string }>

export type Hydrated = {
  views: Map<string, PostView>
  viewer: Map<string, ViewerState>
}

// `mainUris` get viewer state from every account; `contextUris` (parents, roots) only need the post itself.
export async function hydrate(mainUris: string[], contextUris: string[] = []): Promise<Hydrated> {
  const primary = primaryAccount()
  const views = new Map<string, PostView>()
  const viewer = new Map<string, ViewerState>()
  if (!primary) return { views, viewer }

  const others = accounts.filter((a) => a.ok && a !== primary)
  const [primaryViews, ...otherViews] = await Promise.all([
    fetchViews(primary, [...mainUris, ...contextUris]),
    ...others.map((a) => fetchViews(a, mainUris)),
  ])

  for (const [uri, v] of primaryViews) views.set(uri, v)
  for (const uri of mainUris) {
    const state: ViewerState = {}
    const pv = primaryViews.get(uri)
    if (pv) state[primary.slot] = { like: pv.viewer?.like, repost: pv.viewer?.repost }
    others.forEach((a, i) => {
      const v = otherViews[i].get(uri)
      if (v) state[a.slot] = { like: v.viewer?.like, repost: v.viewer?.repost }
    })
    viewer.set(uri, state)
  }
  return { views, viewer }
}
