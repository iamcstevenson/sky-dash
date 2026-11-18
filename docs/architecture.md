# Architecture

## Overview

One Node.js process (`src/server.ts`) on the user's Mac, or on a private server (see [Hosting](#hosting-planned-november-2026)). It signs in to both accounts, collects posts into a local SQLite database, and serves a plain HTML/JavaScript page. There's no build step: Node 23.6+ runs the TypeScript files directly, and the page is vanilla JavaScript.

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
| `keywords.ts`, `rules.ts`, `groups.ts` | Keyword search every 2 minutes (multi-word text quoted as a phrase), per-keyword context rules, keyword groups as saved sets. |
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

## Hosting (planned, November 2026)

Skydash moves from the Mac to one small DigitalOcean server ("droplet"). The code doesn't change: the same process runs under systemd instead of launchd. See decisions #15–#18, the requirements' Cloud hosting section, and issues #14–#19 for the steps.

```
                    DigitalOcean droplet (Ubuntu LTS, 1 GB, US region)
                    ┌───────────────────────────────────────────────┐
Bluesky services ◄──┤ skydash.service (Node LTS, user "skydash")    │
                    │   dashboard 127.0.0.1:4747                    │
                    │   feed server 127.0.0.1:4748                  │
                    │   /var/lib/skydash/skydash.db (+ drafts/)     │
                    │ tailscaled                                    │
                    │   serve  :443 → 4747  (tailnet only)          │
                    │   funnel :443 → 4748  (public, custom feed)   │
                    │ nightly backup timer ─────────────────────────┼──► Cloudflare R2 (encrypted)
                    └───────────────────────────────────────────────┘
                       ▲ Tailscale only            DigitalOcean weekly backups
   Mac, iPhone, Hub Agent ─┘                        (whole server)
```

| Piece | Choice |
| --- | --- |
| Server | DigitalOcean Basic droplet, 1 vCPU / 1 GB / 25 GB disk, Ubuntu LTS, US region. Skydash uses about 100 MB of memory and a 550 MB database. Resize to 2 GB when another project moves onto it. |
| Runtime | Node LTS (24 or newer) from the official Node.js packages. |
| Process | A systemd unit runs `node --env-file-if-exists=.env src/server.ts` as user `skydash` from `/opt/skydash`, with `Restart=always`, matching the launchd agent. |
| Data | `DB_PATH=/var/lib/skydash/skydash.db`. Drafts sit beside it in `drafts/`, as they do now. |
| Settings | `/opt/skydash/.env`, readable only by `skydash`. Adds `ALLOWED_HOSTS=<droplet's Tailscale name>` and the new `FEEDGEN_HOSTNAME`. |
| Private access | `tailscale serve` publishes the dashboard on the tailnet only. SSH goes over Tailscale SSH. |
| Public access | None, apart from `tailscale funnel` for the custom feed. A DigitalOcean Cloud Firewall drops all inbound public traffic; Tailscale works outbound, so it needs no open ports. |
| Backups | DigitalOcean weekly backups of the whole droplet. A nightly systemd timer runs `sqlite3 .backup`, compresses the copy and uploads it with `rclone` through an encrypted remote to a private Cloudflare R2 bucket, keeping 14 days. The database holds sign-in sessions, so it is never uploaded unencrypted. |
| Updates | Ubuntu unattended security upgrades. Skydash is deployed by pulling `main` and restarting the service (a script in the repo); GitHub Actions can run it later. |
| Monitoring | DigitalOcean's free monitoring with alerts for disk over 80% and high memory; systemd restarts the process if it stops. |

**Moving the data:** stop Skydash on the Mac, copy `data/` (database, WAL and drafts) to the droplet, start the service. Backfill on startup covers the few minutes it was off.

**Custom feed:** its address is `did:web:<FEEDGEN_HOSTNAME>`, so a new host name means publishing the feed again from the dashboard. Giving the droplet the Mac's current Tailscale machine name (after renaming the Mac) would keep the old address instead.

**Hub Agent:** still runs on the Mac and reads `/api/sync/*`, now from the droplet's Tailscale address instead of localhost. Collection no longer depends on the Mac; only syncing to iCloud does.

**Outside services added:** DigitalOcean (hosting, billed monthly; an outage stops collection until it returns, and backfill fills the gap) and Cloudflare R2 (backups, free under 10 GB).

## Security

- Listens on `127.0.0.1` only. Requests whose `Host` isn't in the allowed list are refused (stops DNS rebinding).
- `POST` requests must be JSON and same-origin (stops other websites from posting as you).
- The public feed server is a separate port with three read-only routes.
- `.env`, `data/` and screenshots are ignored by git.
