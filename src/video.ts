// Video uploads go to Bluesky's video service rather than the account's own server:
// 1. ask the account's server for a short-lived token that lets the video service store a file for it,
// 2. stream the video to the video service, which converts it to MP4 and checks it,
// 3. poll the job until it's done; the result is a blob reference the post can embed.
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { AtpAgent } from '@atproto/api'
import { accountBySlot } from './accounts.ts'

const VIDEO_SERVICE = 'https://video.bsky.app'
const VIDEO_DID = 'did:web:video.bsky.app'
export const MAX_VIDEO_BYTES = 100_000_000
export const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg'])

const videoAgent = new AtpAgent({ service: VIDEO_SERVICE })

class VideoError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function signedIn(slot: number) {
  const a = accountBySlot(slot)
  if (!a) throw new VideoError(400, `Account ${slot} is not signed in`)
  return a
}

async function serviceToken(slot: number, aud: string, lxm: string) {
  const a = signedIn(slot)
  const res = await a.agent.com.atproto.server.getServiceAuth({ aud, lxm, exp: Math.floor(Date.now() / 1000) + 30 * 60 })
  return { token: res.data.token, account: a }
}

// How many more videos (and bytes) this account may upload today, and whether it can at all
export async function uploadLimits(slot: number) {
  const { token } = await serviceToken(slot, VIDEO_DID, 'app.bsky.video.getUploadLimits')
  const res = await fetch(`${VIDEO_SERVICE}/xrpc/app.bsky.video.getUploadLimits`, { headers: { Authorization: `Bearer ${token}` } })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new VideoError(502, data.message ?? `Video service error (${res.status})`)
  return {
    canUpload: !!data.canUpload,
    remainingDailyVideos: data.remainingDailyVideos ?? null,
    remainingDailyBytes: data.remainingDailyBytes ?? null,
    message: data.message ?? data.error ?? null,
  }
}

// Streams the request body (the video file) straight to the video service and returns its job
export async function uploadVideo(req: IncomingMessage, url: URL) {
  const slot = Number(url.searchParams.get('slot'))
  const type = String(req.headers['content-type'] ?? '').split(';')[0]
  const size = Number(req.headers['content-length'])
  if (!VIDEO_TYPES.has(type)) throw new VideoError(415, 'Videos must be MP4, MOV, WebM or MPEG')
  if (!size) throw new VideoError(411, 'Missing video size')
  if (size > MAX_VIDEO_BYTES) throw new VideoError(413, 'Videos can be at most 100 MB')

  const account = signedIn(slot)
  // The token is for the account's own server, which stores the finished file
  const { token } = await serviceToken(slot, `did:web:${account.agent.dispatchUrl.host}`, 'com.atproto.repo.uploadBlob')
  const name = (url.searchParams.get('name') || 'video').replace(/[^\w.\- ]+/g, '_').slice(0, 100)
  const target = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`)
  target.searchParams.set('did', account.did!)
  target.searchParams.set('name', name)

  const res = await fetch(target, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type, 'Content-Length': String(size) },
    body: Readable.toWeb(req) as any,
    duplex: 'half',
  } as any)
  const data: any = await res.json().catch(() => ({}))
  // Uploading the same file twice returns the earlier job, which is fine to reuse
  const job = data.jobStatus ?? data
  if (!res.ok && !job?.jobId) throw new VideoError(res.status === 413 ? 413 : 502, data.message ?? `Video service error (${res.status})`)
  return { jobId: job.jobId, state: job.state, blob: job.blob ?? null }
}

export async function jobStatus(jobId: string) {
  if (!jobId) throw new VideoError(400, 'jobId is required')
  const res = await videoAgent.app.bsky.video.getJobStatus({ jobId })
  const s = res.data.jobStatus
  return {
    state: s.state,
    progress: s.progress ?? null,
    blob: s.blob ?? null,
    error: s.error ?? null,
    message: s.message ?? null,
  }
}

// Checks a blob reference the page sends back with the post, before it goes into the record
export function videoEmbed(v: any) {
  const blob = v?.blob
  if (!blob || blob.$type !== 'blob' || !blob.ref?.$link || blob.mimeType !== 'video/mp4') {
    throw new VideoError(400, 'The video is not ready yet')
  }
  const width = Math.round(Number(v.width)) || 0
  const height = Math.round(Number(v.height)) || 0
  return {
    $type: 'app.bsky.embed.video',
    video: blob,
    alt: String(v.alt ?? '').trim().slice(0, 1000),
    ...(width && height ? { aspectRatio: { width, height } } : {}),
  }
}
