# Requirements

Written after the fact (November 2026) to record what Skydash was built to do. Keep it current as features change.

## Problem

Christian runs two Bluesky accounts. The official app shows one account at a time, has no way to watch keywords across all of Bluesky over a fixed window, and gives no data for deciding whom to unfollow. He wants one place to read, act and tidy up across both accounts.

## Who it's for

Christian, on his own private server (originally his Mac), used from his Mac and from his iPhone through the Hub app. It's open source (MIT) so others can run it for their own one or two accounts, but nothing is hosted for them.

## Constraints

- **Low, predictable cost.** No paid APIs. Hosting may cost a small flat monthly amount (see [Cloud hosting](#cloud-hosting-november-2026)); anyone else can still run it locally for free.
- **Private.** Runs on a machine the user controls (their own computer, or their own private server). Data stays there.
- **Safe with credentials.** App passwords only, never real passwords. The dashboard can post as the user, so it must not be reachable from other computers or websites.
- **No AI services** for summaries or ranking (cost and privacy).

## Must have (built)

| Area | Requirement |
| --- | --- |
| Following | One feed of posts and replies from both accounts' follows over the last 72 hours, with replies shown in context and full threads on demand. |
| Acting | Like, repost, reply, quote and post from either account, chosen per action, with a warning before both accounts like or repost the same post. |
| Keywords | Public posts from anyone in the last 48 hours matching chosen keywords, with context rules so a keyword means one thing. Keywords can be edited in place, multi-word ones are searched as phrases, and groups are named, saved sets of keywords (issue #12). |
| Follows | Per-follow stats: posts, replies and reposts in 14 days, repost share, last active, follows back, has interacted, overlap between the accounts. Bulk unfollow, mute and move-to-list, each confirmed, with Undo where possible. |
| Trending | What's rising among the people followed, compared with the previous week, with a drill-down to the posts behind each topic. |
| Phone | Usable from the iPhone without public hosting (Tailscale, and the Hub app's synced copy). |

## Nice to have (built)

- Notifications tab modeled on Bluesky's grouped notifications.
- Discover: people not followed who regularly post on the keyword topics, and Audition to watch them without following.
- Custom Bluesky feed of the keyword matches, for the official app.
- Images, video, alt text and drafts when posting. Drafts are shared with the Hub app.
- English-only filter.
- Background service on macOS.

## Cloud hosting (November 2026)

### Problem

Skydash runs on Christian's Mac with its code and database on an external drive (Lacie). It only collects while the Mac is on and the drive is plugged in, and the Mac is short on disk space. He wants it to run all the time in a private cloud server that future always-on projects can share.

### Must have

| Area | Requirement |
| --- | --- |
| Always on | Runs around the clock without the Mac or Lacie, starts on boot and restarts if it stops. |
| Private | The dashboard is reachable only from Christian's own devices over Tailscale. The server accepts no public connections. |
| Data safety | A whole-server backup at least weekly and an encrypted copy of the database at least daily, stored off the server. A restore has been tested. |
| Same features | Everything in the tables above keeps working: Following, keywords, follows, trending and Hub sync. The custom feed stays off on the server (it was never published), so the server has no public route at all. |
| Cost | A flat monthly bill of about $7–15, with no per-request charges that could spike. |
| Rebuildable | A new server can be set up from the repository, the docs and the latest backup in about an hour. |

### Nice to have

- Deploy on push to `main` with GitHub Actions.
- Monitoring alerts for disk space and the service being down.
- Room on the same server for future always-on projects.

### Out of scope

- Changing how Skydash works. Running it locally on a Mac stays supported for anyone else.
- Kubernetes, containers or managed databases. One small server is enough.

### How we know it works

- With the Mac shut down for a day, new posts from follows still appear when it's turned back on, and the stream shows no gap.
- The dashboard opens from the Mac and iPhone through the server's Tailscale name, and from nowhere else (a check from outside the tailnet is refused).
- A port scan of the server's public address finds nothing open.
- Hub Agent syncs from the server.
- The database is restored from the off-server backup onto a fresh server and Skydash starts on it.

## Out of scope

- Hosting for other people, or any public web version.
- More than two accounts.
- Direct messages beyond "Send via chat" from the share menu.
- Paid or AI features.

## How we know it works

- Both accounts sign in, and the status line shows the live stream connected.
- New posts from follows appear in Following within a minute.
- After a restart, posts made while it was off appear (backfill).
- Liking from one account and then the other asks for confirmation.
- Follows stats match a spot check of a few profiles on bsky.app.
- Requests addressed to any host name not in the allowed list are refused.
- Nothing in the repository contains app passwords, sessions or the database.
