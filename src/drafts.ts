// Drafts for new posts and replies, shared by this page and the Hub iPhone app (through Hub Agent on this Mac).
// Media files live in data/drafts/<id>/ until the draft is posted or deleted.
//
// When both places edit the same draft before syncing, the most recent edit wins and the other version is kept in
// `replaced`, so each side can see that a newer edit from the other one replaced it. A posted or deleted draft stays
// for a week so the other side can see what happened to it.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage } from 'node:http'
import { config } from './config.ts'
import { db } from './db.ts'
import { accountBySlot } from './accounts.ts'
import { VIDEO_TYPES, MAX_VIDEO_BYTES, uploadVideoFile, waitForVideo } from './video.ts'

db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    slot INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    media TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    -- The version a newer edit from the other device replaced: { by, at, text, deleted? }
    replaced TEXT,
    posting INTEGER NOT NULL DEFAULT 0,
    posted_at INTEGER,
    posted_uri TEXT,
    posted_by TEXT,
    deleted_at INTEGER,
    deleted_by TEXT
  );
`)

const KEEP_FINISHED_MS = 7 * 86_400_000
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 2_000_000
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_THUMB_CHARS = 80_000
const DRAFTS_DIR = join(dirname(config.dbPath), 'drafts')

export type Device = 'mac' | 'iphone'
export type DraftMedia = { name: string; kind: 'image' | 'video'; mime: string; alt: string; width: number; height: number; thumb: string | null }

type Row = {
  id: string
  slot: number
  text: string
  reply_to: string | null
  media: string
  created_at: number
  updated_at: number
  updated_by: Device
  replaced: string | null
  posting: number
  posted_at: number | null
  posted_uri: string | null
  posted_by: Device | null
  deleted_at: number | null
  deleted_by: Device | null
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status })
}

export const place = (by: string | null) => (by === 'iphone' ? 'your iPhone' : 'your Mac')

function cleanId(id: unknown): string {
  const s = String(id ?? '')
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s)) fail(400, 'Bad draft id')
  return s
}

function cleanName(name: unknown): string {
  const s = String(name ?? '')
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/.test(s)) fail(400, 'Bad media name')
  return s
}

const device = (by: unknown): Device => (by === 'iphone' ? 'iphone' : 'mac')
const dirFor = (id: string) => join(DRAFTS_DIR, id)
const fileFor = (id: string, name: string) => join(dirFor(id), name)

function row(id: string) {
  return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined
}

function mediaOf(r: Row): DraftMedia[] {
  try {
    return JSON.parse(r.media)
  } catch {
    return []
  }
}

function view(r: Row) {
  return {
    id: r.id,
    slot: r.slot,
    text: r.text,
    reply_to: r.reply_to,
    media: mediaOf(r),
    created_at: r.created_at,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
    replaced: r.replaced ? JSON.parse(r.replaced) : null,
    posting: !!r.posting,
    posted_at: r.posted_at,
    posted_uri: r.posted_uri,
    posted_by: r.posted_by,
    deleted_at: r.deleted_at,
    deleted_by: r.deleted_by,
  }
}
export type DraftView = ReturnType<typeof view>

// Open drafts, newest edit first, plus ones posted or deleted in the last week. Older finished ones are removed.
export function listDrafts(): DraftView[] {
  const cutoff = Date.now() - KEEP_FINISHED_MS
  const old = db
    .prepare('SELECT id FROM drafts WHERE COALESCE(posted_at, deleted_at) < ?')
    .all(cutoff) as { id: string }[]
  for (const { id } of old) {
    rmSync(dirFor(id), { recursive: true, force: true })
    db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }
  return (db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC, id').all() as Row[]).map(view)
}

export function getDraft(id: unknown) {
  const r = row(cleanId(id))
  if (!r) fail(404, 'No such draft')
  return view(r)
}

// Checks the media list and writes any images sent inline (base64). Files sent separately must already be there.
function cleanMedia(id: string, list: unknown): DraftMedia[] {
  const items = Array.isArray(list) ? list : []
  const videos = items.filter((m: any) => m?.kind === 'video').length
  if (videos > 1) fail(400, 'A post can have one video')
  if (videos && items.length > 1) fail(400, 'A post can have images or a video, not both')
  if (items.length > MAX_IMAGES) fail(400, `At most ${MAX_IMAGES} images per post`)
  return items.map((m: any, i: number) => {
    const name = cleanName(m?.name)
    const kind = m?.kind === 'video' ? 'video' : 'image'
    const mime = String(m?.mime ?? '')
    if (!(kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES).has(mime)) fail(400, `Item ${i + 1}: unsupported type ${mime || '(unknown)'}`)
    if (m?.data) {
      if (kind !== 'image') fail(400, 'Send videos with the media upload')
      const bytes = Buffer.from(String(m.data), 'base64')
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail(400, `Image ${i + 1} is empty or over 2 MB`)
      mkdirSync(dirFor(id), { recursive: true })
      // Written whole, so a half-written file is never read as the image
      const tmp = `${fileFor(id, name)}.part`
      writeFileSync(tmp, bytes)
      renameSync(tmp, fileFor(id, name))
    }
    if (!existsSync(fileFor(id, name))) fail(409, `Item ${i + 1} hasn't arrived yet`)
    const thumb = typeof m?.thumb === 'string' && /^data:image\/(jpeg|png);base64,/.test(m.thumb) && m.thumb.length <= MAX_THUMB_CHARS ? m.thumb : null
    return {
      name,
      kind,
      mime,
      alt: String(m?.alt ?? '').trim().slice(0, kind === 'video' ? 1000 : 2000),
      width: Math.round(Number(m?.width)) || 0,
      height: Math.round(Number(m?.height)) || 0,
      thumb,
    }
  })
}

// Removes files in the draft's folder that the kept version doesn't use
function prune(id: string, keep: DraftMedia[]) {
  const dir = dirFor(id)
  if (!existsSync(dir)) return
  const names = new Set(keep.map((m) => m.name))
  for (const f of readdirSync(dir)) if (!names.has(f)) rmSync(join(dir, f), { force: true })
}

export type SaveOutcome = 'saved' | 'kept-newer' | 'deleted'

// b: { id, slot, text, replyTo, media, baseUpdatedAt (the version this edit started from, null for a new draft), editedAt, by }
export function saveDraft(b: any): { outcome: SaveOutcome; draft: DraftView | null } {
  const id = cleanId(b?.id)
  const by = device(b?.by)
  const editedAt = Math.round(Number(b?.editedAt)) || Date.now()
  const base = b?.baseUpdatedAt == null ? null : Number(b.baseUpdatedAt)
  const slot = Number(b?.slot)
  if (!accountBySlot(slot)) fail(400, 'Pick one of your accounts')
  const text = String(b?.text ?? '').slice(0, 3000)
  const replyTo = b?.replyTo ? String(b.replyTo) : null
  if (replyTo && !replyTo.startsWith('at://')) fail(400, 'Bad reply target')
  const media = cleanMedia(id, b?.media)
  const cur = row(id)

  if (cur?.posted_at) fail(409, `This draft was already posted from ${place(cur.posted_by)}`)
  if (cur?.deleted_at && cur.deleted_at >= editedAt) {
    prune(id, [])
    return { outcome: 'deleted', draft: view(cur) }
  }
  const write = (replaced: unknown) => {
    db.prepare(
      `INSERT INTO drafts (id, slot, text, reply_to, media, created_at, updated_at, updated_by, replaced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET slot = excluded.slot, text = excluded.text, reply_to = excluded.reply_to,
         media = excluded.media, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
         replaced = excluded.replaced, deleted_at = NULL, deleted_by = NULL`,
    ).run(id, slot, text, replyTo, JSON.stringify(media), cur?.created_at ?? editedAt, editedAt, by, replaced ? JSON.stringify(replaced) : null)
    prune(id, media)
  }
  if (!cur || cur.deleted_at) {
    write(null)
    return { outcome: 'saved', draft: view(row(id)!) }
  }
  // Edited from the version that's there now, or a resend of this same edit: no conflict
  const sameEdit = cur.updated_by === by && cur.updated_at === editedAt
  if (base === cur.updated_at || sameEdit) {
    write(sameEdit ? (cur.replaced ? JSON.parse(cur.replaced) : null) : null)
    return { outcome: 'saved', draft: view(row(id)!) }
  }
  if (editedAt >= cur.updated_at) {
    // Ours is newer: it wins, and the other device's version is kept to show it was replaced
    write(cur.updated_by === by ? null : { by: cur.updated_by, at: cur.updated_at, text: cur.text, media: mediaOf(cur).length })
    return { outcome: 'saved', draft: view(row(id)!) }
  }
  // Theirs is newer: keep it, and note that this older edit was replaced
  db.prepare('UPDATE drafts SET replaced = ? WHERE id = ?').run(
    JSON.stringify({ by, at: editedAt, text, media: media.length }),
    id,
  )
  prune(id, mediaOf(cur))
  return { outcome: 'kept-newer', draft: view(row(id)!) }
}

// b: { id, editedAt, by }
export function deleteDraft(b: any): { outcome: 'deleted' | 'kept-newer' | 'posted' } {
  const id = cleanId(b?.id)
  const by = device(b?.by)
  const editedAt = Math.round(Number(b?.editedAt)) || Date.now()
  const cur = row(id)
  if (cur?.posted_at) return { outcome: 'posted' }
  if (cur && !cur.deleted_at && cur.updated_at > editedAt && cur.updated_by !== by) {
    db.prepare('UPDATE drafts SET replaced = ? WHERE id = ?').run(JSON.stringify({ by, at: editedAt, text: '', deleted: true }), id)
    return { outcome: 'kept-newer' }
  }
  if (!cur) {
    // Remembered, so a late save of this draft from the other device doesn't bring it back
    db.prepare(
      `INSERT INTO drafts (id, slot, created_at, updated_at, updated_by, deleted_at, deleted_by) VALUES (?, 0, ?, ?, ?, ?, ?)`,
    ).run(id, editedAt, editedAt, by, editedAt, by)
  } else if (!cur.deleted_at) {
    db.prepare('UPDATE drafts SET deleted_at = ?, deleted_by = ?, media = ? WHERE id = ?').run(editedAt, by, '[]', id)
  }
  rmSync(dirFor(id), { recursive: true, force: true })
  return { outcome: 'deleted' }
}

export function dismissReplaced(id: unknown) {
  db.prepare('UPDATE drafts SET replaced = NULL WHERE id = ?').run(cleanId(id))
}

// Turns a draft into what /api/compose takes, uploading its video first. Marks it as posting, so a second
// request can't post it twice; call finishPosting afterwards either way.
export async function startPosting(idIn: unknown) {
  const id = cleanId(idIn)
  const cur = row(id)
  if (!cur || cur.deleted_at) fail(404, `This draft was deleted${cur ? ` on ${place(cur.deleted_by)}` : ''}`)
  if (cur.posted_at) fail(409, `This draft was already posted from ${place(cur.posted_by)}`)
  const claimed = db.prepare('UPDATE drafts SET posting = 1 WHERE id = ? AND posting = 0').run(id)
  if (!claimed.changes) fail(409, 'This draft is already being posted')
  try {
    const media = mediaOf(cur)
    const images = media
      .filter((m) => m.kind === 'image')
      .map((m) => ({ data: readFileSync(fileFor(id, m.name)).toString('base64'), mime: m.mime, alt: m.alt, width: m.width, height: m.height }))
    let video
    const v = media.find((m) => m.kind === 'video')
    if (v) {
      const path = fileFor(id, v.name)
      const job = await uploadVideoFile(cur.slot, path, v.mime, statSync(path).size, v.name)
      const blob = job.blob ?? (await waitForVideo(job.jobId))
      video = { blob, alt: v.alt, width: v.width, height: v.height }
    }
    return { slot: cur.slot, text: cur.text, replyTo: cur.reply_to ?? undefined, images, video }
  } catch (err) {
    db.prepare('UPDATE drafts SET posting = 0 WHERE id = ?').run(id)
    throw err
  }
}

export function finishPosting(id: string, by: Device, postedUri: string | null) {
  if (postedUri) {
    db.prepare('UPDATE drafts SET posting = 0, posted_at = ?, posted_uri = ?, posted_by = ?, media = ? WHERE id = ?').run(
      Date.now(),
      postedUri,
      by,
      '[]',
      id,
    )
    rmSync(dirFor(id), { recursive: true, force: true })
  } else {
    db.prepare('UPDATE drafts SET posting = 0 WHERE id = ?').run(id)
  }
}

// A photo or video for a draft, streamed as the request body. Hub Agent sends the phone's files this way.
export async function receiveMedia(req: IncomingMessage, url: URL) {
  const id = cleanId(url.searchParams.get('id'))
  const name = cleanName(url.searchParams.get('name'))
  const type = String(req.headers['content-type'] ?? '').split(';')[0]
  const size = Number(req.headers['content-length'])
  const isVideo = VIDEO_TYPES.has(type)
  if (!isVideo && !IMAGE_TYPES.has(type)) fail(415, 'Photos must be JPEG, PNG, WebP or GIF, and videos MP4, MOV, WebM or MPEG')
  if (!size) fail(411, 'Missing size')
  if (size > (isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) fail(413, isVideo ? 'Videos can be at most 100 MB' : 'Photos can be at most 2 MB')
  if (row(id)?.posted_at) fail(409, 'This draft was already posted')
  mkdirSync(dirFor(id), { recursive: true })
  const tmp = `${fileFor(id, name)}.part`
  let received = 0
  req.on('data', (c: Buffer) => {
    received += c.length
    if (received > size) req.destroy(new Error('Body longer than its size'))
  })
  await pipeline(req, createWriteStream(tmp))
  if (received !== size) {
    rmSync(tmp, { force: true })
    fail(400, 'The upload was cut short')
  }
  renameSync(tmp, fileFor(id, name))
  return { ok: true, name, size }
}

// For this page to show a draft's photos and video
export function mediaFile(idIn: unknown, nameIn: unknown) {
  const id = cleanId(idIn)
  const name = cleanName(nameIn)
  const r = row(id)
  const item = r ? mediaOf(r).find((m) => m.name === name) : undefined
  const path = fileFor(id, name)
  if (!item || !existsSync(path)) fail(404, 'No such file')
  return { stream: createReadStream(path), mime: item.mime, size: statSync(path).size }
}
