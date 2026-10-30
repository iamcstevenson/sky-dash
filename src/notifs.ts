// The Notifications tab, modeled on Bluesky's new notifications beta: grouped notifications from
// app.bsky.notification.getGroupedNotifications, with each reference resolved to a full view.
// Also "Send via chat" from the share menu.
import { accountBySlot, accounts, type Account } from './accounts.ts'

const FEEDS = new Set(['all', 'people-i-follow', 'conversations', 'followers', 'activity'])
const PREFIX = 'app.bsky.notification.getGroupedNotifications#'

class NotifError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function signedIn(slot: unknown): Account {
  const a = accountBySlot(Number(slot))
  if (!a) throw new NotifError(400, `Account ${slot} is not signed in`)
  return a
}

// relatedViews lists everything the groups refer to: profiles by DID, the rest by URI
function buildLookup(views: any[] = []) {
  const profiles = new Map<string, any>()
  const byUri = new Map<string, any>()
  for (const v of views) {
    if (v.$type === 'app.bsky.actor.defs#profileViewBasic' || (v.did && !v.uri)) profiles.set(v.did, v)
    else if (v.uri) byUri.set(v.uri, v)
  }
  return { profiles, byUri }
}

const isPost = (v: any) => !!v?.record && !!v?.author
const hidden = (p: any) => !!(p?.viewer?.muted || p?.viewer?.blocking || p?.viewer?.blockedBy)

function parentOf(uri: string | undefined, byUri: Map<string, any>) {
  if (!uri) return undefined
  const v = byUri.get(uri)
  if (isPost(v)) return { type: 'post', post: v }
  return { type: v?.$type?.endsWith('#blockedPost') ? 'blocked' : 'notFound' }
}

// Turns one API group into what the page draws, or null for kinds or posts that can't be shown
function normalize(g: any, { profiles, byUri }: ReturnType<typeof buildLookup>) {
  const base = { id: g.id, isRead: g.isRead, indexedAt: g.indexedAt, count: g.count }
  const kind = g.kind ?? {}
  const name = String(kind.$type ?? '').replace(PREFIX, '')

  // Everyone in a group, newest first. Only the newest 10 come with a profile; the rest load on demand.
  const group = () => {
    const actorDids = (kind.items ?? []).map((i: any) => i.actor).filter((d: string) => !hidden(profiles.get(d)))
    const actors = actorDids.map((d: string) => profiles.get(d)).filter(Boolean)
    return actors.length ? { actors, actorDids } : null
  }
  const single = () => {
    const actor = profiles.get(kind.actor)
    return actor && !hidden(actor) ? { actor } : null
  }
  const multi = (type: string) => {
    const who = single()
    const posts = (kind.items ?? []).map((i: any) => byUri.get(i.post)).filter(isPost)
    return who && posts.length ? { ...base, type, ...who, posts } : null
  }
  const onPost = (type: string) => {
    const who = group()
    const post = byUri.get(kind.post)
    return who && isPost(post) ? { ...base, type, ...who, post } : null
  }
  const aboutPost = (type: string) => {
    const post = byUri.get(kind.post)
    if (!isPost(post) || hidden(post.author)) return null
    return { ...base, type, post, parent: parentOf(kind.parent, byUri) }
  }
  const person = (type: string, extra: object = {}) => {
    const who = single()
    return who ? { ...base, type, ...who, ...extra } : null
  }

  switch (name) {
    case 'likeGroup': return onPost('like')
    case 'repostGroup': return onPost('repost')
    case 'likeViaRepostGroup': return onPost('likeViaRepost')
    case 'repostViaRepostGroup': return onPost('repostViaRepost')
    case 'multiPostLikeGroup': return multi('multiPostLike')
    case 'multiPostRepostGroup': return multi('multiPostRepost')
    case 'multiPostLikeViaRepostGroup': return multi('multiPostLikeViaRepost')
    case 'multiPostRepostViaRepostGroup': return multi('multiPostRepostViaRepost')
    case 'replyNotification': return aboutPost('reply')
    case 'quoteNotification': return aboutPost('quote')
    case 'mentionNotification': return aboutPost('mention')
    case 'followGroup': {
      const who = group()
      if (!who) return null
      // A starter pack is only named when every follow in the group came through the same one
      const packs = new Set((kind.items ?? []).map((i: any) => i.starterPack))
      const pack = packs.size === 1 ? byUri.get([...packs][0] as string) : undefined
      return { ...base, type: 'follow', ...who, starterPack: pack }
    }
    case 'followBackNotification': return person('followBack', { starterPack: byUri.get(kind.starterPack) })
    case 'verifiedNotification': return person('verified')
    case 'unverifiedNotification': return person('unverified')
    case 'contactMatchNotification': return person('contactMatch')
    case 'starterPackJoinedNotification': return person('starterPackJoined', { starterPack: byUri.get(kind.starterPack) })
    case 'generatorLikeGroup': {
      const who = group()
      const generator = byUri.get(kind.generator)
      return who && generator ? { ...base, type: 'generatorLike', ...who, generator } : null
    }
    case 'subscribedPostGroup': {
      const items = (kind.items ?? [])
        .map((i: any) => ({ actor: profiles.get(i.actor), post: byUri.get(i.post), parent: parentOf(i.parent, byUri) }))
        .filter((i: any) => i.actor && isPost(i.post) && !hidden(i.actor))
      return items.length ? { ...base, type: 'subscribedPost', items } : null
    }
    default:
      return null // "Clients should ignore kinds they do not recognize"
  }
}

export async function groupedNotifications(slot: unknown, feed: string, cursor: string | null, limit: number) {
  const a = signedIn(slot)
  if (!FEEDS.has(feed)) throw new NotifError(400, 'Unknown notifications feed')
  const res = await a.agent.app.bsky.notification.getGroupedNotifications({
    feed,
    limit: Math.min(Math.max(limit, 1), 50),
    cursor: cursor || undefined,
  })
  const lookup = buildLookup(res.data.relatedViews as any[])
  return {
    groups: res.data.groups.map((g) => normalize(g, lookup)).filter(Boolean),
    // Counts groups that couldn't be drawn, so "new notifications" and "seen" stay accurate
    newestAt: res.data.groups[0]?.indexedAt ?? null,
    seenAt: res.data.seenAt ?? null,
    cursor: res.data.cursor ?? null,
  }
}

export async function unreadCounts() {
  const out: Record<number, number> = {}
  await Promise.all(
    accounts
      .filter((a) => a.ok)
      .map(async (a) => {
        try {
          out[a.slot] = (await a.agent.app.bsky.notification.getUnreadCount({})).data.count
        } catch {
          // Leave this account's badge off for now
        }
      }),
  )
  return out
}

// Marks notifications as seen on Bluesky, as opening the All tab does there
export async function markSeen(slot: unknown, seenAt: unknown) {
  const at = new Date(String(seenAt))
  if (Number.isNaN(at.getTime())) throw new NotifError(400, 'Invalid time')
  await signedIn(slot).agent.app.bsky.notification.updateSeen({ seenAt: at.toISOString() })
  return { ok: true }
}

// The rest of a group's people, for "Show more"
export async function profilesFor(slot: unknown, dids: string[]) {
  const a = signedIn(slot)
  if (!dids.length) return []
  const res = await a.agent.app.bsky.actor.getProfiles({ actors: dids.slice(0, 25) })
  return res.data.profiles
}

// ---------- Send via chat ----------

function chatAgent(a: Account) {
  return a.agent.withProxy('bsky_chat', 'did:web:api.bsky.chat')
}

// App passwords can't reach messages unless they were created with that permission
function friendlyChatError(err: any): NotifError {
  const msg = String(err?.message ?? err)
  if (/scope|forbidden|not enough/i.test(msg) || err?.status === 401 || err?.status === 403) {
    return new NotifError(
      403,
      "This account's app password can't access messages. In Bluesky, create a new app password with “Allow access to your direct messages” turned on, then update .env and restart Skydash.",
    )
  }
  if (/disabled|recipient|block|not allowed|cannot/i.test(msg)) return new NotifError(400, `Can't message this person: ${msg}`)
  return new NotifError(502, msg)
}

const person = (p: any) => ({
  did: p.did,
  handle: p.handle,
  displayName: p.displayName ?? null,
  avatar: p.avatar ?? null,
  // "following" here means they accept messages only from people they follow
  allowIncoming: p.associated?.chat?.allowIncoming ?? 'following',
  followedBy: !!p.viewer?.followedBy,
})

export async function recentChats(slot: unknown) {
  const a = signedIn(slot)
  try {
    const res = await chatAgent(a).chat.bsky.convo.listConvos({ limit: 20 })
    return res.data.convos
      .map((c: any) => {
        const others = c.members.filter((m: any) => m.did !== a.did)
        return { convoId: c.id, members: others.map(person) }
      })
      .filter((c: any) => c.members.length)
  } catch (err) {
    throw friendlyChatError(err)
  }
}

export async function searchPeople(slot: unknown, q: string) {
  const a = signedIn(slot)
  if (!q.trim()) return []
  const res = await a.agent.app.bsky.actor.searchActorsTypeahead({ q, limit: 10 })
  return res.data.actors.filter((p) => p.did !== a.did).map(person)
}

// Sends the post, with an optional message, to an existing chat or to one person
export async function sendPostViaChat(b: any) {
  const a = signedIn(b.slot)
  if (!b.uri || !b.cid) throw new NotifError(400, 'No post to send')
  const text = String(b.text ?? '').trim().slice(0, 1000)
  try {
    const chat = chatAgent(a).chat.bsky.convo
    const convoId = b.convoId || (await chat.getConvoForMembers({ members: [String(b.did)] })).data.convo.id
    await chat.sendMessage({
      convoId,
      message: { text, embed: { $type: 'app.bsky.embed.record', record: { uri: b.uri, cid: b.cid } } },
    })
    return { ok: true }
  } catch (err) {
    throw friendlyChatError(err)
  }
}
