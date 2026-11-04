import { RichText } from '@atproto/api'
import { config } from './config.ts'
import { db, kvGet, kvSet } from './db.ts'
import { accounts, accountBySlot, followCounts } from './accounts.ts'
import { collector } from './jetstream.ts'
import { backfill } from './backfill.ts'
import { hydrate, forget, primaryAccount } from './hydrate.ts'
import { listKeywords, addKeyword, removeKeyword, pollKeywords, keywordStatus } from './keywords.ts'
import { followStats, unfollow, follow, mute, lists, createList, addToList, profileCard } from './follows.ts'
import { notifStatus } from './notifications.ts'
import { trending, postsForTopic } from './trending.ts'
import { isEnglish } from './lang.ts'
import { judgeRow, judge, rulesFor, groupRulesFor, saveRules, setAuthor, suggestedAuthors, suggestedForGroup, searchText, type Verdict } from './rules.ts'
import { listGroups, memberIds, setMembers, createGroup, removeGroup, updateGroup, setGroupAuthor, setKeywordGroups, moveKeyword, orderKeywords, orderGroups, groupHasRules } from './groups.ts'
import { discover, dismiss, audition, auditionList, refreshDiscover, discoverStatus, clearDiscoverCache } from './discover.ts'
import { uploadLimits, jobStatus, videoEmbed } from './video.ts'
import { groupedNotifications, unreadCounts, markSeen, profilesFor, recentChats, searchPeople, sendPostViaChat } from './notifs.ts'
import { syncState, syncDay } from './sync.ts'
import { listDrafts, getDraft, saveDraft, deleteDraft, dismissReplaced, startPosting, finishPosting, place } from './drafts.ts'

type Query = URLSearchParams
type Handler = (q: Query, body: any) => Promise<unknown>

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function account(slot: unknown) {
  const a = accountBySlot(Number(slot))
  if (!a) throw new HttpError(400, `Account ${slot} is not signed in`)
  return a
}

// Builds the WHERE clause shared by the feed and the "new posts" counter
function feedFilter(q: Query) {
  const author = q.get('author')
  const where = ['p.sort_at > ?']
  if (q.get('lang') === 'en') where.push('p.is_en = 1')
  // One person's posts (opened from the Follows tab) go back as far as the follow stats do
  const hours = author ? config.statsDays * 24 : config.feedHours
  const params: (string | number)[] = [Date.now() - hours * 3_600_000]
  if (author) {
    where.push('p.author_did = ?')
    params.push(author)
  }

  const type = q.get('type')
  if (type === 'posts') where.push('p.reply_parent IS NULL')
  if (type === 'replies') where.push('p.reply_parent IS NOT NULL')

  // One person's posts don't need to come from someone you follow (e.g. an account you're auditioning)
  if (author) return { where, params }

  const who = q.get('who') ?? 'all'
  const signedIn = accounts.filter((a) => a.ok && a.did)
  if (who === 'both' && signedIn.length === 2) {
    where.push(`p.author_did IN (SELECT subject_did FROM follows WHERE account_did IN (?, ?)
      GROUP BY subject_did HAVING COUNT(*) = 2)`)
    params.push(signedIn[0].did!, signedIn[1].did!)
  } else if (who === '1' || who === '2') {
    where.push('p.author_did IN (SELECT subject_did FROM follows WHERE account_did = ?)')
    params.push(account(who).did!)
  } else {
    where.push('p.author_did IN (SELECT subject_did FROM follows)')
  }
  return { where, params }
}

// WHERE clause for the keyword feed: ids=1,2 limits to some keywords; hideFollowed drops people you follow
function keywordFilter(q: Query) {
  const where = ['k.enabled = 1', 'h.sort_at > ?']
  const params: (string | number)[] = [Date.now() - config.keywordHours * 3_600_000]
  if (q.get('lang') === 'en') where.push('p.is_en = 1')
  const ids = (q.get('ids') ?? '').split(',').map(Number).filter((n) => n > 0)
  const group = Number(q.get('group')) || null
  // Viewing a group means its keywords (or the ones picked within it)
  const members = group ? memberIds(group) : null
  const wanted = members ? (ids.length ? ids.filter((i) => members.includes(i)) : members) : ids
  if (members && !wanted.length) where.push('1 = 0')
  if (wanted.length) {
    where.push(`h.keyword_id IN (${wanted.map(() => '?').join(',')})`)
    params.push(...wanted)
  }
  const type = q.get('type')
  if (type === 'posts') where.push('p.reply_parent IS NULL')
  if (type === 'replies') where.push('p.reply_parent IS NOT NULL')
  if (q.get('hideFollowed') === '1') where.push('p.author_did NOT IN (SELECT subject_did FROM follows)')
  return { where, params }
}

type FeedRow = {
  uri: string
  author_did: string
  sort_at: number
  reply_parent: string | null
  reply_root: string | null
  kws?: string | null
  verdicts?: Verdict[]
}

// Hydrates stored rows into feed items: the post, its reply context, and both accounts' state
async function buildItems(rows: FeedRow[], limit: number) {
  const context = rows.flatMap((r) => [r.reply_parent, r.reply_root]).filter((u): u is string => !!u)
  const { views, viewer } = await hydrate(
    rows.map((r) => r.uri),
    context,
  )

  const authorDids = [...new Set(rows.map((r) => r.author_did))]
  const followedBy = new Map<string, number[]>()
  if (authorDids.length) {
    const f = db
      .prepare(`SELECT subject_did, account_did FROM follows WHERE subject_did IN (${authorDids.map(() => '?').join(',')})`)
      .all(...authorDids) as { subject_did: string; account_did: string }[]
    const slotOf = new Map(accounts.map((a) => [a.did, a.slot]))
    for (const row of f) {
      const slot = slotOf.get(row.account_did)
      if (slot) followedBy.set(row.subject_did, [...(followedBy.get(row.subject_did) ?? []), slot].sort())
    }
  }

  const items = []
  for (const r of rows) {
    const post = views.get(r.uri)
    if (!post || post.author.viewer?.muted || post.author.viewer?.blocking || post.author.viewer?.blockedBy) continue
    items.push({
      post,
      parent: r.reply_parent ? (views.get(r.reply_parent) ?? { notFound: true, uri: r.reply_parent }) : undefined,
      root:
        r.reply_root && r.reply_root !== r.reply_parent
          ? (views.get(r.reply_root) ?? { notFound: true, uri: r.reply_root })
          : undefined,
      viewer: viewer.get(r.uri) ?? {},
      followedBy: followedBy.get(r.author_did) ?? [],
      keywords: r.kws ? r.kws.split(',').map(Number) : undefined,
      verdicts: r.verdicts,
      sortAt: r.sort_at,
    })
    if (items.length >= limit) break
  }
  // A full page continues from its last item. A short page continues from the oldest row looked at,
  // but only if the query returned more rows than a page (otherwise there's nothing older).
  const last = items.at(-1)
  const cursor = items.length >= limit && last ? last.sortAt : rows.length > limit ? rows.at(-1)!.sort_at : null
  return { items, cursor }
}

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 2_000_000 // Bluesky's limit per image
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const BATCH = 400
const MAX_SCAN = 4000

// Kept / hidden counts per keyword for the chips, cached briefly since the page refreshes them often
type Counts = { kept: number; hidden: number }
let countsCache: { at: number; value: Map<number, Counts>; groups: Map<number, Counts> } | null = null
function keywordCounts() {
  if (countsCache && Date.now() - countsCache.at < 30_000) return countsCache
  const rows = db
    .prepare(
      `SELECT h.keyword_id, p.uri, p.author_did, p.record FROM keyword_hits h JOIN posts p ON p.uri = h.uri
       WHERE h.sort_at > ?`,
    )
    .all(Date.now() - config.keywordHours * 3_600_000) as { keyword_id: number; uri: string; author_did: string; record: string | null }[]
  const value = new Map<number, Counts>()
  // A post counts once per group, however many of the group's keywords it matched
  const groupList = listGroups()
  const postsInGroup = new Map<number, Map<string, boolean>>(groupList.map((g) => [g.id, new Map()]))
  const groupsOfKeyword = new Map<number, number[]>()
  for (const g of groupList) for (const k of g.keywordIds) groupsOfKeyword.set(k, [...(groupsOfKeyword.get(k) ?? []), g.id])
  for (const r of rows) {
    const text = searchText(r.uri, r.record)
    const c = value.get(r.keyword_id) ?? { kept: 0, hidden: 0 }
    judge(r.keyword_id, r.author_did, text).kept ? c.kept++ : c.hidden++
    value.set(r.keyword_id, c)
    for (const g of groupsOfKeyword.get(r.keyword_id) ?? []) {
      const posts = postsInGroup.get(g)!
      posts.set(r.uri, posts.get(r.uri) || judge(r.keyword_id, r.author_did, text, g).kept)
    }
  }
  const groups = new Map<number, Counts>()
  for (const [g, posts] of postsInGroup) {
    const kept = [...posts.values()].filter(Boolean).length
    groups.set(g, { kept, hidden: posts.size - kept })
  }
  countsCache = { at: Date.now(), value, groups }
  return countsCache
}

function resetKeywordCaches() {
  countsCache = null
  clearDiscoverCache()
}

// Names for a list of accounts, for the rules panels
function handlesFor(dids: string[]) {
  if (!dids.length) return []
  const rows = db.prepare(`SELECT did, handle, display_name FROM profiles WHERE did IN (${dids.map(() => '?').join(',')})`).all(...dids) as {
    did: string
    handle: string | null
    display_name: string | null
  }[]
  const byDid = new Map(rows.map((x) => [x.did, x]))
  return dids.map((did) => ({ did, handle: byDid.get(did)?.handle ?? did, name: byDid.get(did)?.display_name ?? null }))
}

function feedgenInfo() {
  const uri = kvGet('feedgen_uri') || null
  const host = config.feedgenHostname
  return {
    hostname: host || null,
    port: config.feedgenPort,
    serviceDid: host ? `did:web:${host}` : null,
    uri,
    appUrl: uri ? `https://bsky.app/profile/${uri.split('/')[2]}/feed/${config.feedgenRkey}` : null,
  }
}

const routes: Record<string, Handler> = {
  'GET /api/status': async () => ({
    accounts: accounts.map((a) => ({ slot: a.slot, handle: a.handle, did: a.did, ok: a.ok, error: a.error })),
    configured: config.accounts.length,
    follows: followCounts(),
    collector: { ...collector, lastEventMs: Math.floor(collector.lastEventUs / 1000) },
    backfill,
    storedPosts: (db.prepare('SELECT COUNT(*) n FROM posts').get() as { n: number }).n,
    feedHours: config.feedHours,
  }),

  'GET /api/sync/state': async () => syncState(),
  'GET /api/sync/export': async (q) => {
    const day = syncDay(q.get('day') ?? '')
    if (!day) throw new HttpError(400, 'day must look like 2026-11-01')
    return day
  },

  'GET /api/feed': async (q) => {
    const limit = Math.min(Number(q.get('limit')) || 30, 60)
    const { where, params } = feedFilter(q)
    const before = Number(q.get('before'))
    if (before) {
      where.push('p.sort_at < ?')
      params.push(before)
    }
    // Over-fetch a little: some posts drop out during hydration (deleted, blocked, muted)
    const rows = db
      .prepare(
        `SELECT p.uri, p.author_did, p.sort_at, p.reply_parent, p.reply_root FROM posts p
         WHERE ${where.join(' AND ')} ORDER BY p.sort_at DESC LIMIT ?`,
      )
      .all(...params, limit + 10) as FeedRow[]
    return buildItems(rows, limit)
  },

  'GET /api/feed/new': async (q) => {
    const { where, params } = feedFilter(q)
    where.push('p.sort_at > ?')
    params.push(Number(q.get('after')) || Date.now())
    const row = db.prepare(`SELECT COUNT(*) n FROM posts p WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
    return { count: row.n }
  },

  // ---------- follows ----------

  'GET /api/profile': async (q) => {
    const actor = q.get('actor')
    if (!actor) throw new HttpError(400, 'actor is required')
    return profileCard(actor)
  },
  'GET /api/follows': async () => ({
    rows: followStats(),
    days: config.statsDays,
    history: { running: backfill.running, deep: backfill.deep, done: backfill.done, total: backfill.total },
    notifications: notifStatus,
  }),
  'POST /api/follows/unfollow': async (_q, b) => unfollow(b),
  'POST /api/follows/follow': async (_q, b) => follow(b),
  'POST /api/follows/mute': async (_q, b) => mute(b, true),
  'POST /api/follows/unmute': async (_q, b) => mute(b, false),
  'GET /api/lists': async (q) => lists(Number(q.get('slot'))),
  'POST /api/lists/create': async (_q, b) => createList(b),
  'POST /api/lists/add': async (_q, b) => addToList(b),

  // ---------- trending ----------

  'GET /api/trending': async (q) => {
    const hours = [6, 24, 72].includes(Number(q.get('hours'))) ? Number(q.get('hours')) : 24
    const english = q.get('lang') === 'en'
    const data = trending(hours, q.get('who') ?? 'all', english)
    // Hydrate the most-shared posts so they render like any other post
    const { views, viewer } = await hydrate(data.shared.map((s: any) => s.uri))
    const names = new Map<string, string>()
    const dids = [...new Set(data.shared.flatMap((s: any) => s.sharers))] as string[]
    if (dids.length) {
      for (const p of db.prepare(`SELECT did, handle FROM profiles WHERE did IN (${dids.map(() => '?').join(',')})`).all(...dids) as {
        did: string
        handle: string | null
      }[]) {
        if (p.handle) names.set(p.did, p.handle)
      }
    }
    const shared = data.shared
      .map((s: any) => ({
        post: views.get(s.uri),
        viewer: viewer.get(s.uri) ?? {},
        sharers: s.sharers.map((d: string) => ({ did: d, handle: names.get(d) ?? d })),
      }))
      .filter((s: any) => s.post && !s.post.author.viewer?.muted && !s.post.author.viewer?.blocking)
      // Shared posts are often by people you don't follow, so they may not be stored; judge from the post itself
      .filter((s: any) => !english || isEnglish(s.post.record?.langs, s.post.record?.text ?? ''))
      .slice(0, 10)
    return { ...data, shared }
  },

  'GET /api/trending/posts': async (q) => {
    const term = q.get('term')
    if (!term) throw new HttpError(400, 'term is required')
    const hours = [6, 24, 72].includes(Number(q.get('hours'))) ? Number(q.get('hours')) : 24
    const limit = Math.min(Number(q.get('limit')) || 30, 60)
    const rows = postsForTopic(term, hours, q.get('who') ?? 'all', Number(q.get('before')) || null, limit, q.get('lang') === 'en')
    return buildItems(rows, limit)
  },

  // ---------- notifications ----------

  'GET /api/notifications': async (q) =>
    groupedNotifications(q.get('slot'), q.get('feed') ?? 'all', q.get('cursor'), Number(q.get('limit')) || 30),
  'GET /api/notifications/unread': async () => unreadCounts(),
  'POST /api/notifications/seen': async (_q, b) => markSeen(b.slot, b.seenAt),
  'GET /api/notifications/profiles': async (q) => profilesFor(q.get('slot'), (q.get('dids') ?? '').split(',').filter(Boolean)),

  // ---------- send via chat ----------

  'GET /api/chat/recent': async (q) => recentChats(q.get('slot')),
  'GET /api/chat/search': async (q) => searchPeople(q.get('slot'), q.get('q') ?? ''),
  'POST /api/chat/send': async (_q, b) => sendPostViaChat(b),

  // ---------- video ----------

  'GET /api/video/limits': async (q) => uploadLimits(Number(q.get('slot'))),
  'GET /api/video/status': async (q) => jobStatus(String(q.get('jobId') ?? '')),

  // ---------- discover ----------

  'GET /api/discover': async (q) => {
    const kw = Number(q.get('kw')) || null
    const group = Number(q.get('group')) || null
    return { ...discover(kw, q.get('mode') ?? 'all', group), auditions: auditionList() }
  },
  'POST /api/discover/dismiss': async (_q, b) => {
    dismiss(String(b.did), !!b.undo)
    return { ok: true }
  },
  'POST /api/discover/audition': async (_q, b) => {
    audition(String(b.did), !!b.start)
    return { ok: true }
  },
  'POST /api/discover/refresh': async () => {
    refreshDiscover().catch(() => {})
    return { refreshing: true, ...discoverStatus }
  },

  // ---------- keywords ----------

  'GET /api/keywords': async () => {
    const counts = keywordCounts()
    const all = listKeywords()
    return {
      groups: listGroups().map((g) => {
        const members = all.filter((k) => g.keywordIds.includes(k.id))
        return {
          id: g.id,
          name: g.name,
          keywordIds: g.keywordIds,
          count: counts.groups.get(g.id)?.kept ?? 0,
          hidden: counts.groups.get(g.id)?.hidden ?? 0,
          hasRules: groupHasRules(g.id),
          enabled: members.some((k) => k.enabled),
          inFeed: members.some((k) => k.in_feed),
        }
      }),
      keywords: all.map((k) => ({
        id: k.id,
        query: k.query,
        enabled: !!k.enabled,
        inFeed: !!k.in_feed,
        lastPollMs: k.last_poll_ms,
        count: counts.value.get(k.id)?.kept ?? 0,
        hidden: counts.value.get(k.id)?.hidden ?? 0,
        hasRules: (() => {
          const r = rulesFor(k.id)
          return r.must.length + r.exclude.length + r.trusted.size + r.blocked.size > 0
        })(),
        error: keywordStatus.errors[k.id],
        capped: keywordStatus.capped[k.id] ?? false,
      })),
      polling: keywordStatus.polling,
      hours: config.keywordHours,
    }
  },

  // ifMissing (from Hub, which may resend after a crash): an existing keyword is returned instead of an error
  'POST /api/keywords/add': async (_q, b) => {
    const query = String(b.query ?? '').trim()
    if (!query) throw new HttpError(400, 'Enter a keyword or phrase')
    if (query.length > 200) throw new HttpError(400, 'Keep keywords under 200 characters')
    const existing = listKeywords().find((k) => k.query.toLowerCase() === query.toLowerCase())
    if (existing && b.ifMissing) return { id: existing.id, existed: true }
    if (existing) throw new HttpError(409, 'You already have that keyword')
    const kw = addKeyword(query)
    if (b.must !== undefined || b.exclude !== undefined) saveRules(kw.id, b.must, b.exclude)
    if (typeof b.inFeed === 'boolean') db.prepare('UPDATE keywords SET in_feed = ? WHERE id = ?').run(b.inFeed ? 1 : 0, kw.id)
    if (Array.isArray(b.groupIds) && b.groupIds.length) setKeywordGroups(kw.id, b.groupIds.map(Number))
    resetKeywordCaches()
    // Fill the last 48 hours in the background; the page polls for progress
    pollKeywords(kw.id).catch(() => {})
    return { id: kw.id }
  },

  'POST /api/keywords/update': async (_q, b) => {
    const id = Number(b.id)
    if (typeof b.enabled === 'boolean') db.prepare('UPDATE keywords SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, id)
    if (typeof b.inFeed === 'boolean') db.prepare('UPDATE keywords SET in_feed = ? WHERE id = ?').run(b.inFeed ? 1 : 0, id)
    if (b.enabled === true) pollKeywords(id).catch(() => {})
    return { ok: true }
  },

  'GET /api/keywords/rules': async (q) => {
    const id = Number(q.get('id'))
    const r = rulesFor(id)
    const suggested = suggestedAuthors(id, Date.now() - config.keywordHours * 3_600_000)
    const sugg = handlesFor(suggested.map((x) => x.did))
    return {
      must: r.must,
      exclude: r.exclude,
      trusted: handlesFor([...r.trusted]),
      blocked: handlesFor([...r.blocked]),
      suggested: suggested.map((x, i) => ({ ...sugg[i], kept: x.kept })),
      groupIds: listGroups().filter((g) => g.keywordIds.includes(id)).map((g) => g.id),
    }
  },

  'POST /api/keywords/rules': async (_q, b) => {
    saveRules(Number(b.id), b.must, b.exclude)
    if (Array.isArray(b.groupIds)) setKeywordGroups(Number(b.id), b.groupIds.map(Number))
    resetKeywordCaches()
    return { ok: true }
  },

  // ---------- keyword groups ----------

  // ifMissing (from Hub, which may resend after a crash): a group with the same name is updated instead
  'POST /api/groups/create': async (_q, b) => {
    const name = String(b.name ?? '').trim()
    const existing = b.ifMissing ? listGroups().find((g) => g.name.toLowerCase() === name.toLowerCase()) : undefined
    const res = existing ? { id: existing.id } : createGroup(b.name, Array.isArray(b.keywordIds) ? b.keywordIds.map(Number) : [])
    if (existing || b.must !== undefined || b.exclude !== undefined) {
      updateGroup(res.id, { must: b.must, exclude: b.exclude, ...(existing && Array.isArray(b.keywordIds) ? { keywordIds: b.keywordIds } : {}) })
    }
    resetKeywordCaches()
    return res
  },
  'GET /api/groups/rules': async (q) => {
    const id = Number(q.get('id'))
    const r = groupRulesFor(id)
    const suggested = suggestedForGroup(id, Date.now() - config.keywordHours * 3_600_000)
    const sugg = handlesFor(suggested.map((x) => x.did))
    return {
      name: r.name,
      must: r.must,
      exclude: r.exclude,
      trusted: handlesFor([...r.trusted]),
      blocked: handlesFor([...r.blocked]),
      suggested: suggested.map((x, i) => ({ ...sugg[i], kept: x.kept })),
      keywordIds: memberIds(id),
    }
  },
  'POST /api/groups/update': async (_q, b) => {
    updateGroup(Number(b.id), b)
    resetKeywordCaches()
    return { ok: true }
  },
  'POST /api/groups/remove': async (_q, b) => {
    removeGroup(Number(b.id))
    resetKeywordCaches()
    return { ok: true }
  },
  // Pauses or resumes every keyword in a group, or adds or removes them all from the custom feed
  'POST /api/groups/set': async (_q, b) => {
    const ids = memberIds(Number(b.id))
    for (const id of ids) {
      if (typeof b.enabled === 'boolean') db.prepare('UPDATE keywords SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, id)
      if (typeof b.inFeed === 'boolean') db.prepare('UPDATE keywords SET in_feed = ? WHERE id = ?').run(b.inFeed ? 1 : 0, id)
      if (b.enabled === true) pollKeywords(id).catch(() => {})
    }
    return { ok: true }
  },
  'POST /api/groups/author': async (_q, b) => {
    const verdict = b.verdict === 'trusted' || b.verdict === 'blocked' ? b.verdict : null
    setGroupAuthor(Number(b.id), String(b.did), verdict)
    resetKeywordCaches()
    return { ok: true }
  },
  'POST /api/groups/move': async (_q, b) => {
    moveKeyword(b)
    resetKeywordCaches()
    return { ok: true }
  },
  'POST /api/groups/order': async (_q, b) => {
    orderGroups((b.ids ?? []).map(Number))
    return { ok: true }
  },
  'POST /api/keywords/order': async (_q, b) => {
    orderKeywords((b.ids ?? []).map(Number))
    return { ok: true }
  },

  // verdict: 'trusted' (always show), 'blocked' (never show) or null (back to the word rules)
  'POST /api/keywords/author': async (_q, b) => {
    const verdict = b.verdict === 'trusted' || b.verdict === 'blocked' ? b.verdict : null
    setAuthor(Number(b.id), String(b.did), verdict)
    resetKeywordCaches()
    return { ok: true }
  },

  // Several keywords at once, from Hub: pause or resume, custom feed on or off, join or leave a group, or delete
  'POST /api/keywords/bulk': async (_q, b) => {
    const known = new Set(listKeywords().map((k) => k.id))
    const ids = (Array.isArray(b.ids) ? b.ids.map(Number) : []).filter((id: number) => known.has(id))
    if (b.remove === true) {
      for (const id of ids) removeKeyword(id)
      resetKeywordCaches()
      return { ok: true, count: ids.length }
    }
    for (const id of ids) {
      if (typeof b.enabled === 'boolean') db.prepare('UPDATE keywords SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, id)
      if (typeof b.inFeed === 'boolean') db.prepare('UPDATE keywords SET in_feed = ? WHERE id = ?').run(b.inFeed ? 1 : 0, id)
    }
    const groups = new Set(listGroups().map((g) => g.id))
    for (const [key, add] of [['addGroup', true], ['removeGroup', false]] as const) {
      const group = Number(b[key])
      if (!group) continue
      if (!groups.has(group)) throw new HttpError(404, 'That group no longer exists')
      const members = memberIds(group)
      setMembers(group, add ? [...members, ...ids.filter((id: number) => !members.includes(id))] : members.filter((id) => !ids.includes(id)))
    }
    if (b.enabled === true) for (const id of ids) pollKeywords(id).catch(() => {})
    resetKeywordCaches()
    return { ok: true, count: ids.length }
  },

  'POST /api/keywords/remove': async (_q, b) => {
    removeKeyword(Number(b.id))
    resetKeywordCaches()
    return { ok: true }
  },

  // show=filtered lists the posts the context rules hid, with the reason, instead of the kept ones
  'GET /api/keywords/feed': async (q) => {
    const limit = Math.min(Number(q.get('limit')) || 30, 60)
    const wantHidden = q.get('show') === 'filtered'
    const group = Number(q.get('group')) || null
    const picked: FeedRow[] = []
    let before = Number(q.get('before')) || Infinity
    let scanned = 0
    let exhausted = false
    // Read newest-first in batches, judging each post, until there's a page's worth
    while (picked.length < limit + 10 && scanned < MAX_SCAN) {
      const { where, params } = keywordFilter(q)
      if (before !== Infinity) {
        where.push('p.sort_at < ?')
        params.push(before)
      }
      const batch = db
        .prepare(
          `SELECT p.uri, p.author_did, p.sort_at, p.reply_parent, p.reply_root, p.record, GROUP_CONCAT(h.keyword_id) kws
           FROM keyword_hits h JOIN posts p ON p.uri = h.uri JOIN keywords k ON k.id = h.keyword_id
           WHERE ${where.join(' AND ')} GROUP BY p.uri ORDER BY p.sort_at DESC LIMIT ?`,
        )
        .all(...params, BATCH) as (FeedRow & { record: string | null })[]
      for (const row of batch) {
        const { verdicts, kept } = judgeRow(row, group)
        if (kept.length > 0 === !wantHidden) {
          picked.push({ ...row, kws: wantHidden ? row.kws : kept.join(','), verdicts })
          if (picked.length >= limit + 10) break
        }
      }
      scanned += batch.length
      if (batch.length < BATCH) {
        exhausted = true
        break
      }
      before = batch.at(-1)!.sort_at
    }
    const out = await buildItems(picked, limit)
    // A short page means either nothing older exists, or we stopped scanning; then continue from where we stopped
    if (picked.length <= limit) out.cursor = exhausted ? null : before === Infinity ? null : before
    return out
  },

  'GET /api/keywords/new': async (q) => {
    const { where, params } = keywordFilter(q)
    where.push('p.sort_at > ?')
    params.push(Number(q.get('after')) || Date.now())
    const rows = db
      .prepare(
        `SELECT p.uri, p.author_did, p.record, GROUP_CONCAT(h.keyword_id) kws
         FROM keyword_hits h JOIN posts p ON p.uri = h.uri JOIN keywords k ON k.id = h.keyword_id
         WHERE ${where.join(' AND ')} GROUP BY p.uri LIMIT 1000`,
      )
      .all(...params) as { uri: string; author_did: string; record: string | null; kws: string | null }[]
    const wantHidden = q.get('show') === 'filtered'
    const group = Number(q.get('group')) || null
    return { count: rows.filter((r) => judgeRow(r, group).kept.length > 0 === !wantHidden).length }
  },

  // ---------- custom Bluesky feed ----------

  'GET /api/feedgen': async () => feedgenInfo(),

  'POST /api/feedgen/publish': async (_q, b) => {
    if (!config.feedgenHostname) throw new HttpError(400, 'Set FEEDGEN_HOSTNAME in .env first')
    const acct = account(b.slot)
    const displayName = String(b.displayName ?? '').trim().slice(0, 24) || 'My keywords'
    const description = String(b.description ?? '').trim().slice(0, 300)
    const res = await acct.agent.com.atproto.repo.putRecord({
      repo: acct.did!,
      collection: 'app.bsky.feed.generator',
      rkey: config.feedgenRkey,
      record: {
        $type: 'app.bsky.feed.generator',
        did: `did:web:${config.feedgenHostname}`,
        displayName,
        description,
        createdAt: new Date().toISOString(),
      },
    })
    kvSet('feedgen_uri', res.data.uri)
    return feedgenInfo()
  },

  'POST /api/feedgen/unpublish': async () => {
    const uri = kvGet('feedgen_uri')
    if (!uri) return feedgenInfo()
    const publisher = accounts.find((a) => a.ok && uri.startsWith(`at://${a.did}/`))
    if (!publisher) throw new HttpError(400, 'The account that published the feed is not signed in')
    await publisher.agent.com.atproto.repo.deleteRecord({
      repo: publisher.did!,
      collection: 'app.bsky.feed.generator',
      rkey: config.feedgenRkey,
    })
    kvSet('feedgen_uri', '')
    return feedgenInfo()
  },

  'GET /api/thread': async (q) => {
    const uri = q.get('uri')
    if (!uri) throw new HttpError(400, 'uri is required')
    const primary = primaryAccount()
    if (!primary) throw new HttpError(503, 'No signed-in account')
    const res = await primary.agent.app.bsky.feed.getPostThread({ uri, depth: 6, parentHeight: 20 })
    return res.data.thread
  },

  // Returns a single post's view and every account's like/repost state, after an action
  'GET /api/post': async (q) => {
    const uri = q.get('uri')
    if (!uri) throw new HttpError(400, 'uri is required')
    forget(uri)
    const { views, viewer } = await hydrate([uri])
    return { post: views.get(uri), viewer: viewer.get(uri) ?? {} }
  },

  'POST /api/like': async (_q, b) => {
    const res = await account(b.slot).agent.like(b.uri, b.cid)
    forget(b.uri)
    return res
  },
  'POST /api/unlike': async (_q, b) => {
    await account(b.slot).agent.deleteLike(b.likeUri)
    forget(b.uri)
    return { ok: true }
  },
  'POST /api/repost': async (_q, b) => {
    const res = await account(b.slot).agent.repost(b.uri, b.cid)
    forget(b.uri)
    return res
  },
  'POST /api/unrepost': async (_q, b) => {
    await account(b.slot).agent.deleteRepost(b.repostUri)
    forget(b.uri)
    return { ok: true }
  },

  // New post, reply (replyTo) or quote (quote) from one of your accounts
  // images: up to 4 of { data (base64), mime, alt, width, height }, already resized in the browser
  'POST /api/compose': async (_q, b) => compose(b),

  // ---------- drafts (shared with the Hub iPhone app) ----------

  'GET /api/drafts': async () => ({ drafts: listDrafts() }),
  'GET /api/drafts/get': async (q) => getDraft(q.get('id')),
  // b: { id, slot, text, replyTo, media, baseUpdatedAt, editedAt, by }
  'POST /api/drafts/save': async (_q, b) => saveDraft(b),
  'POST /api/drafts/delete': async (_q, b) => deleteDraft(b),
  'POST /api/drafts/dismiss': async (_q, b) => {
    dismissReplaced(b.id)
    return { ok: true }
  },
  // Posts a saved draft. With save (Hub), saves that version first, and refuses if a newer edit from this page is there.
  'POST /api/drafts/post': async (_q, b) => {
    const by = b.by === 'iphone' ? 'iphone' : 'mac'
    if (b.save) {
      const saved = saveDraft({ ...b.save, by })
      if (saved.outcome === 'kept-newer') {
        throw new HttpError(409, `This draft was changed on ${place(saved.draft?.updated_by ?? 'mac')} after you posted it, so it wasn't posted. Open it again to check it, then post.`)
      }
      if (saved.outcome === 'deleted') throw new HttpError(404, `This draft was deleted on ${place(saved.draft?.deleted_by ?? 'mac')}, so it wasn't posted.`)
    }
    const id = String(b.id ?? b.save?.id ?? '')
    const post = await startPosting(id)
    let uri: string | null = null
    try {
      const res: any = await compose(post)
      uri = res?.uri ?? null
      return res
    } finally {
      finishPosting(id, by, uri)
    }
  },
}

// New post, reply (replyTo) or quote (quote) from one of your accounts
// images: up to 4 of { data (base64), mime, alt, width, height }, already resized
export async function compose(b: any) {
  const acct = account(b.slot)
  const text = String(b.text ?? '').trim()
  const images = Array.isArray(b.images) ? b.images : []
  if (!text && !images.length && !b.video) throw new HttpError(400, 'Write something or add an image or video')
  if (images.length && b.video) throw new HttpError(400, 'A post can have images or a video, not both')
  const videoMedia = b.video ? videoEmbed(b.video) : null
  if (images.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} images per post`)
  const decoded = images.map((img: any, i: number) => {
    const mime = String(img?.mime ?? '')
    if (!IMAGE_TYPES.has(mime)) throw new HttpError(400, `Image ${i + 1}: unsupported type ${mime || '(unknown)'}`)
    const bytes = Buffer.from(String(img?.data ?? ''), 'base64')
    if (!bytes.length) throw new HttpError(400, `Image ${i + 1} is empty`)
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, `Image ${i + 1} is over 2 MB after resizing`)
    const alt = String(img?.alt ?? '').trim().slice(0, 2000)
    const width = Math.round(Number(img?.width)) || 0
    const height = Math.round(Number(img?.height)) || 0
    return { bytes, mime, alt, width, height }
  })

  const rt = new RichText({ text })
  await rt.detectFacets(acct.agent)
  if (rt.graphemeLength > 300) throw new HttpError(400, `Post is ${rt.graphemeLength} characters; the limit is 300`)

  const record: any = { text: rt.text, facets: rt.facets }
  const targets = [b.replyTo, b.quote].filter(Boolean)
  const found = targets.length ? (await acct.agent.app.bsky.feed.getPosts({ uris: targets })).data.posts : []
  const byUri = new Map(found.map((p) => [p.uri, p]))

  if (b.replyTo) {
    const parent = byUri.get(b.replyTo)
    if (!parent) throw new HttpError(404, 'The post you are replying to no longer exists')
    const parentRef = { uri: parent.uri, cid: parent.cid }
    const root = (parent.record as any)?.reply?.root ?? parentRef
    record.reply = { root, parent: parentRef }
  }
  let media: any = null
  if (decoded.length) {
    // Upload each image to the account's server first; the post then refers to the uploaded files
    const uploaded = []
    for (const img of decoded) {
      const res = await acct.agent.uploadBlob(new Uint8Array(img.bytes), { encoding: img.mime })
      uploaded.push({
        image: res.data.blob,
        alt: img.alt,
        ...(img.width && img.height ? { aspectRatio: { width: img.width, height: img.height } } : {}),
      })
    }
    media = { $type: 'app.bsky.embed.images', images: uploaded }
  }
  if (videoMedia) media = videoMedia
  if (b.quote) {
    const quoted = byUri.get(b.quote)
    if (!quoted) throw new HttpError(404, 'The post you are quoting no longer exists')
    const quoteEmbed = { $type: 'app.bsky.embed.record', record: { uri: quoted.uri, cid: quoted.cid } }
    // A quote with images is a "record with media" embed
    record.embed = media ? { $type: 'app.bsky.embed.recordWithMedia', record: quoteEmbed, media } : quoteEmbed
  } else if (media) {
    record.embed = media
  }
  const res = await acct.agent.post(record)
  if (b.replyTo) forget(b.replyTo)
  return res
}

export async function handleApi(method: string, url: URL, body: any) {
  const handler = routes[`${method} ${url.pathname}`]
  if (!handler) throw new HttpError(404, 'Not found')
  return handler(url.searchParams, body ?? {})
}
