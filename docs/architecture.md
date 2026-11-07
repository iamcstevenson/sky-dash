# Architecture

## Overview

One Node.js process (`src/server.ts`) on the user's Mac. It signs in to both accounts, collects posts into a local SQLite database, and serves a plain HTML/JavaScript page. There's no build step: Node 23.6+ runs the TypeScript files directly, and the page is vanilla JavaScript.

```
Bluesky Jetstream (live) ──┐
Bluesky public AppView ────┤   collectors   ┌──> data/skydash.db (SQLite)
Each account's PDS ────────┘                │
                                            ▼
              Browser / Tailscale  <── dashboard :4747 (private)
              Bluesky app          <── feed server :4748 (public, optional)
              Hub iPhone app       <── Hub Agent on the Mac reads /api/sync/* and pushes to iCloud
```

## Components

| File | Job |
| --- | --- |
| `server.ts` | HTTP server, static files, host and cross-site checks, startup and timers. |
| `config.ts` | Settings from `.env`. |
| `db.ts` | SQLite schema and shared read/write helpers. |
| `accounts.ts` | Sign-in with app passwords, stored sessions, follow lists. |
| `jetstream.ts` | Live stream of posts, reposts and follows by followed accounts and your own. |
| `backfill.ts` | On startup, reads what was missed while off (14 days on first run). |
| `hydrate.ts` | Turns stored post URIs into full post views, with each account's like/repost state. |
| `api.ts` | All `/api/*` routes the page uses. |
| `keywords.ts`, `rules.ts`, `groups.ts` | Keyword search every 2 minutes, context rules, keyword groups. |
| `follows.ts`, `notifications.ts` | Follow stats and follow-graph actions; interaction history from notifications. |
| `notifs.ts` | Notifications tab and Send via chat. |
| `trending.ts` | Topic extraction and rising/popular/shared scoring. |
| `discover.ts` | Suggestions and Audition. |
| `drafts.ts`, `video.ts` | Drafts (shared with Hub) and video upload. |
| `feedgen.ts` | Optional public custom-feed server. |
| `sync.ts`, `profileDetails.ts` | Read-only data for the Hub iPhone app. |
| `lang.ts` | English detection. |
| `public/` | The dashboard page: `index.html`, `app.js`, `style.css`. |

## Data

Everything lives in `data/skydash.db` (ignored by git). Main tables:

- `posts`, `reposts`: raw records from follows and keyword matches, kept about 15 days.
- `follows`, `profiles`, `profile_details`, `author_activity`, `interactions`: follow stats.
- `keywords`, `keyword_hits`, `keyword_groups`, `keyword_group_members`, `keyword_authors`, `group_authors`: keywords and rules.
- `auditions`, `discover_dismissed`, `expert_follows`: Discover.
- `drafts`: drafts; their media files live in `data/drafts/<id>/`.
- `sessions`, `kv`: sign-in sessions, stream cursor and other state.

## Outside services and risks

| Service | Used for | Risk |
| --- | --- | --- |
| Jetstream (`jetstream*.bsky.network`) | Live posts from up to 10,000 followed accounts. | Free and unofficial in SLA terms; may change or go down. The collector rotates between 4 hosts and resumes from a saved cursor. |
| Public AppView (`public.api.bsky.app`) | Backfill, profiles. | Rate limit of about 3,000 requests per 5 minutes per IP; backfill is throttled to 8 per second. |
| Each account's PDS | Sign-in, posting, likes, notifications, search, video tokens. | Login limits per day, so sessions are stored and reused. |
| Bluesky video service | Video uploads. | Daily upload limits and email verification per account. |
| Tailscale (optional) | Private phone access; Funnel for the public feed. | Third-party account needed. |

## Security

- Listens on `127.0.0.1` only. Requests whose `Host` isn't in the allowed list are refused (stops DNS rebinding).
- `POST` requests must be JSON and same-origin (stops other websites from posting as you).
- The public feed server is a separate port with three read-only routes.
- `.env`, `data/` and screenshots are ignored by git.
