# Requirements

Written after the fact (November 2026) to record what Skydash was built to do. Keep it current as features change.

## Problem

Christian runs two Bluesky accounts. The official app shows one account at a time, has no way to watch keywords across all of Bluesky over a fixed window, and gives no data for deciding whom to unfollow. He wants one place to read, act and tidy up across both accounts.

## Who it's for

Christian, on his own Mac, and on his iPhone through the Hub app. It's open source (MIT) so others can run it for their own one or two accounts, but nothing is hosted for them.

## Constraints

- **Zero cost.** No paid services, hosting or APIs. Only Bluesky's free public services.
- **Local.** Runs on the user's computer. Data stays there.
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
