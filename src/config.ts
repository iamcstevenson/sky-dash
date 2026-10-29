import { fileURLToPath } from 'node:url'

export type AccountConfig = {
  slot: number
  handle: string
  appPassword: string
  service: string
}

const env = process.env

function readAccount(slot: number): AccountConfig | null {
  const handle = env[`ACCOUNT_${slot}_HANDLE`]?.trim().replace(/^@/, '')
  const appPassword = env[`ACCOUNT_${slot}_APP_PASSWORD`]?.trim()
  if (!handle || !appPassword || appPassword.startsWith('xxxx')) return null
  return {
    slot,
    handle,
    appPassword,
    service: env[`ACCOUNT_${slot}_SERVICE`]?.trim() || 'https://bsky.social',
  }
}

export const config = {
  accounts: [readAccount(1), readAccount(2)].filter((a): a is AccountConfig => a !== null),
  port: Number(env.PORT) || 4747,
  host: env.HOST || '127.0.0.1',
  feedHours: Number(env.FEED_HOURS) || 72,
  // Follow stats look back this many days; posts are kept at least one day longer
  statsDays: 14,
  retentionDays: Math.max(Number(env.RETENTION_DAYS) || 15, 15),
  keywordHours: Number(env.KEYWORD_HOURS) || 48,
  keywordPollMinutes: Number(env.KEYWORD_POLL_MINUTES) || 2,
  // Public custom-feed server (optional). Only runs when FEEDGEN_HOSTNAME is set.
  feedgenHostname: env.FEEDGEN_HOSTNAME?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '') || '',
  feedgenPort: Number(env.FEEDGEN_PORT) || 4748,
  feedgenRkey: 'skydash-keywords',
  publicAppView: 'https://public.api.bsky.app',
  jetstreamHosts: [
    'jetstream2.us-east.bsky.network',
    'jetstream1.us-east.bsky.network',
    'jetstream2.us-west.bsky.network',
    'jetstream1.us-west.bsky.network',
  ],
  dbPath: env.DB_PATH || fileURLToPath(new URL('../data/skydash.db', import.meta.url)),
}
