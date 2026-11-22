// Curated lists (not moderation lists or starter packs): see, create, rename, delete and copy your own,
// change who is on them, and read any list as a feed. Everything reads and writes the PDS directly, so
// changes show up in the Bluesky app at once. See decision #22.
import { accounts, accountBySlot, type Account } from './accounts.ts'

const CURATE = 'app.bsky.graph.defs#curatelist'
const LIST = 'app.bsky.graph.list'
const ITEM = 'app.bsky.graph.listitem'
const MAX_BATCH = 200
// applyWrites accepts up to 200 writes per call
const WRITE_CHUNK = 200

class ListError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function signedIn(slot: unknown): Account {
  const a = accountBySlot(Number(slot))
  if (!a?.did) throw new ListError(400, `Account ${slot} is not signed in`)
  return a
}

// Any signed-in account can read a list; the acting one is preferred so its mutes and blocks apply
function reader(slot?: unknown): Account {
  const a = accountBySlot(Number(slot)) ?? accounts.find((x) => x.ok && x.did)
  if (!a) throw new ListError(503, 'No signed-in account')
  return a
}

function parseUri(uri: unknown) {
  const m = /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/]+)$/.exec(String(uri ?? ''))
  if (!m) throw new ListError(400, 'Not a list address')
  return { did: m[1], collection: m[2], rkey: m[3] }
}

// The list must be a curated list owned by this account
function ownList(a: Account, listUri: unknown) {
  const p = parseUri(listUri)
  if (p.collection !== LIST) throw new ListError(400, 'Not a list address')
  if (p.did !== a.did) throw new ListError(403, 'That list belongs to a different account')
  return { ...p, uri: String(listUri) }
}

function cleanName(name: unknown) {
  const n = String(name ?? '').trim().slice(0, 64)
  if (!n) throw new ListError(400, 'Give the list a name')
  return n
}

function cleanDescription(text: unknown) {
  return String(text ?? '').trim().slice(0, 300)
}

const profile = (p: any) => ({ did: p.did, handle: p.handle, displayName: p.displayName ?? '', avatar: p.avatar ?? null })

async function chunked<T>(items: T[], fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += WRITE_CHUNK) await fn(items.slice(i, i + WRITE_CHUNK))
}

// ---------- reading ----------

// Curated lists owned by one account
export async function myLists(slot: number) {
  const a = signedIn(slot)
  const out = []
  let cursor: string | undefined
  do {
    const res = await a.agent.app.bsky.graph.getLists({ actor: a.did!, limit: 100, cursor })
    for (const l of res.data.lists) {
      if (l.purpose !== CURATE) continue
      out.push({ uri: l.uri, name: l.name, description: l.description ?? '', count: l.listItemCount ?? 0, avatar: l.avatar ?? null })
    }
    cursor = res.data.cursor
  } while (cursor)
  return out
}

// A list's details and one page of members. Works for anyone's list, as long as it isn't private to them.
export async function listMembers(listUri: unknown, slot: unknown, cursor?: string | null) {
  parseUri(listUri)
  const a = reader(slot)
  const res = await a.agent.app.bsky.graph.getList({ list: String(listUri), limit: 100, cursor: cursor || undefined })
  const l = res.data.list
  return {
    list: {
      uri: l.uri,
      name: l.name,
      description: l.description ?? '',
      purpose: l.purpose,
      count: l.listItemCount ?? null,
      creator: profile(l.creator),
      ownerSlot: accounts.find((x) => x.ok && x.did === l.creator.did)?.slot ?? null,
    },
    members: res.data.items.map((i) => ({ itemUri: i.uri, ...profile(i.subject) })),
    cursor: res.data.cursor ?? null,
  }
}

async function allMemberDids(a: Account, listUri: string) {
  const dids: string[] = []
  let cursor: string | undefined
  do {
    const res = await a.agent.app.bsky.graph.getList({ list: listUri, limit: 100, cursor })
    for (const i of res.data.items) dids.push(i.subject.did)
    cursor = res.data.cursor
  } while (cursor)
  return dids
}

// One page of the list's feed, as rows for the dashboard's usual post cards. Reposts are left out:
// a list feed is for what its members write.
export async function listFeedRows(listUri: unknown, slot: unknown, cursor?: string | null, limit = 30) {
  parseUri(listUri)
  const a = reader(slot)
  const res = await a.agent.app.bsky.feed.getListFeed({ list: String(listUri), limit, cursor: cursor || undefined })
  const rows = res.data.feed
    .filter((f) => !f.reason)
    .map((f) => {
      const rec = f.post.record as any
      return {
        uri: f.post.uri,
        author_did: f.post.author.did,
        sort_at: Date.parse(f.post.indexedAt) || Date.now(),
        reply_parent: rec?.reply?.parent?.uri ?? null,
        reply_root: rec?.reply?.root?.uri ?? null,
      }
    })
  return { rows, cursor: res.data.cursor ?? null }
}

// A shared link (https://bsky.app/profile/<handle or did>/lists/<rkey>) or an at:// address
export async function resolveListLink(link: unknown) {
  const text = String(link ?? '').trim()
  if (text.startsWith('at://')) return { uri: ownOrAny(text) }
  const m = /bsky\.app\/profile\/([^/?#]+)\/lists\/([^/?#]+)/.exec(text)
  if (!m) throw new ListError(400, 'Paste a list link from bsky.app, like https://bsky.app/profile/name/lists/…')
  let did = decodeURIComponent(m[1])
  if (!did.startsWith('did:')) {
    const res = await reader().agent.resolveHandle({ handle: did.replace(/^@/, '') })
    did = res.data.did
  }
  return { uri: `at://${did}/${LIST}/${m[2]}` }
}

function ownOrAny(uri: string) {
  const p = parseUri(uri)
  if (p.collection !== LIST) throw new ListError(400, 'Not a list address')
  return uri
}

// ---------- changing your lists ----------

export async function createList(body: any) {
  const a = signedIn(body.slot)
  const name = cleanName(body.name)
  const description = body.description === undefined ? 'Accounts to check on now and then (made with Skydash)' : cleanDescription(body.description)
  const res = await a.agent.com.atproto.repo.createRecord({
    repo: a.did!,
    collection: LIST,
    record: { $type: LIST, purpose: CURATE, name, description, createdAt: new Date().toISOString() },
  })
  return { uri: res.data.uri, name, description, count: 0 }
}

// Renames a list or changes its description, keeping everything else on the record (avatar, labels)
export async function updateList(body: any) {
  const a = signedIn(body.slot)
  const { rkey, uri } = ownList(a, body.listUri)
  const cur = await a.agent.com.atproto.repo.getRecord({ repo: a.did!, collection: LIST, rkey })
  const record = { ...(cur.data.value as any) }
  if (record.purpose !== CURATE) throw new ListError(400, 'Only curated lists can be changed here')
  if (body.name !== undefined) record.name = cleanName(body.name)
  if (body.description !== undefined) record.description = cleanDescription(body.description)
  await a.agent.com.atproto.repo.putRecord({ repo: a.did!, collection: LIST, rkey, record, swapRecord: cur.data.cid })
  return { uri, name: record.name, description: record.description ?? '' }
}

// Deletes the list and its member records, as the Bluesky app does
export async function deleteList(body: any) {
  const a = signedIn(body.slot)
  const { rkey, uri } = ownList(a, body.listUri)
  const itemKeys: string[] = []
  let cursor: string | undefined
  do {
    const res = await a.agent.com.atproto.repo.listRecords({ repo: a.did!, collection: ITEM, limit: 100, cursor })
    for (const r of res.data.records) if ((r.value as any)?.list === uri) itemKeys.push(r.uri.split('/').pop()!)
    cursor = res.data.records.length ? res.data.cursor : undefined
  } while (cursor)
  await chunked(itemKeys, (keys) =>
    a.agent.com.atproto.repo.applyWrites({
      repo: a.did!,
      writes: keys.map((k) => ({ $type: 'com.atproto.repo.applyWrites#delete', collection: ITEM, rkey: k })),
    }),
  )
  await a.agent.com.atproto.repo.deleteRecord({ repo: a.did!, collection: LIST, rkey })
  return { ok: true, removed: itemKeys.length }
}

// Adds accounts to one of your lists, skipping ones already on it
export async function addToList(body: any) {
  const a = signedIn(body.slot)
  const { uri } = ownList(a, body.listUri)
  if (!Array.isArray(body.dids) || !body.dids.length) throw new ListError(400, 'No accounts selected')
  if (body.dids.length > MAX_BATCH) throw new ListError(400, `At most ${MAX_BATCH} at a time`)
  const existing = new Set(await allMemberDids(a, uri))
  const toAdd = [...new Set(body.dids.map(String) as string[])].filter((d) => d.startsWith('did:') && !existing.has(d))
  const now = new Date().toISOString()
  await chunked(toAdd, (dids) =>
    a.agent.com.atproto.repo.applyWrites({
      repo: a.did!,
      writes: dids.map((did) => ({
        $type: 'com.atproto.repo.applyWrites#create',
        collection: ITEM,
        value: { $type: ITEM, subject: did, list: uri, createdAt: now },
      })),
    }),
  )
  return { done: toAdd.length, failed: [] }
}

export async function removeFromList(body: any) {
  const a = signedIn(body.slot)
  const p = parseUri(body.itemUri)
  if (p.collection !== ITEM || p.did !== a.did) throw new ListError(403, 'That entry belongs to a different account')
  await a.agent.com.atproto.repo.deleteRecord({ repo: a.did!, collection: ITEM, rkey: p.rkey })
  return { ok: true }
}

// Copies any list (yours or a shared one) to one of your accounts as a new curated list
export async function copyList(body: any) {
  const to = signedIn(body.toSlot)
  ownOrAny(String(body.listUri ?? ''))
  const from = reader(body.fromSlot)
  const src = await from.agent.app.bsky.graph.getList({ list: String(body.listUri), limit: 1 })
  const dids = (await allMemberDids(from, String(body.listUri))).filter((d) => d !== to.did)
  const created = await createList({ slot: to.slot, name: body.name ?? src.data.list.name, description: src.data.list.description ?? '' })
  const now = new Date().toISOString()
  await chunked(dids, (chunk) =>
    to.agent.com.atproto.repo.applyWrites({
      repo: to.did!,
      writes: chunk.map((did) => ({
        $type: 'com.atproto.repo.applyWrites#create',
        collection: ITEM,
        value: { $type: ITEM, subject: did, list: created.uri, createdAt: now },
      })),
    }),
  )
  return { ...created, count: dids.length }
}

// People search for "Add people", as the acting account sees it
export async function searchActors(slot: unknown, q: string) {
  if (!q.trim()) return []
  const res = await reader(slot).agent.app.bsky.actor.searchActorsTypeahead({ q, limit: 10 })
  return res.data.actors.map(profile)
}
