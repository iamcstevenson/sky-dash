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

## Version 2 (November 2026)

### Problem

Skydash works, but it feels slow from the phone and the Mac, the phone layout wastes space and hides parts of the Follows table, and lists can only be created and filled in bulk, not managed.

### Must have

| Area | Requirement |
| --- | --- |
| Speed | Pages and data are compressed. The app code and styles are cached by the browser and only downloaded again when they change. The unread-notification count doesn't ask Bluesky on every refresh. The server is in New York (closer to Christian, on Eastern time) instead of San Francisco. |
| Phone layout | At iPhone width, posts start near the top of the screen: a compact header that hides while scrolling down, every tab reachable without sideways scrolling, and filters folded behind one button. Follows shows each account's key stats without sideways scrolling. Post headers fit on one or two lines. Desktop is unchanged. |
| Lists | A Lists tab for the acting account: see its curated lists, create, rename (with description) and delete them (with confirmation), see and remove members, add people from search, Follows or a profile card, read a list as a feed of its members' recent posts, and copy a list to the other account. |

### Follows, version 3 (November 2026)

### Problem

The Follows tab only looks at Christian's own follows, and lists can only be filled from it in bulk ("Move to list", which also unfollows). He wants to look through who another account follows, quickly follow and list the people he isn't already engaged with, and manage list membership from the same table. Rows for deleted or deactivated accounts show a bare `did:plc:…` and clutter the top of the "Last active" sort.

### Must have

| Area | Requirement |
| --- | --- |
| Another account's follows | Type a Bluesky handle on the Follows tab and see the accounts it follows with the same 14-day stats (posts, replies, reposts, repost %, last active, followers) and whether each follows that account back. A "You" column shows which of Christian's accounts follow each one. A "New to me" filter shows accounts neither of his accounts follows, that aren't on any of his lists, and that he hasn't muted. Each row has one-click Follow (as the acting account) and + List; selected rows can be followed or added to a list in bulk. A progress bar shows while it reads; results are kept for 24 hours with a Refresh button. Interacted is left blank (it needs the other person's notifications). |
| Lists on Follows | In both views: a Lists column with each account's lists, a filter for one list or "Not on any list", a per-row list button to tick lists on and off, and bulk Add to list and Remove from list. "Move to list" becomes Add to list with an "Also unfollow" option. |
| Deleted accounts | Rows whose profile can't be found are labelled "Deleted or deactivated" and have their own filter, so they can be selected and unfollowed together. |

### Follows, version 4 (November 2026)

### Problem

The single-account lookup works well, but finding people means repeating it account by account, the table sorts by one column at a time, selecting many rows is click by click, and bulk list changes go to one list at a time.

### Must have

| Area | Requirement |
| --- | --- |
| Group analysis | Select up to 10 of your follows and analyse them together: one table of everyone they follow, with a sortable "Followed by" count (and who, on hover) and a "Followed by at least N" filter. Same actions as the single lookup (New to me, one-click Follow and + List, bulk actions, progress, Refresh). Accounts analysed in the last 24 hours are reused. Groups appear in the recent list. The single-handle lookup stays. |
| Selection | Shift-click a row's checkbox to select the range from the last one clicked; "Select all that match" selects every filtered row, not just the ones shown. The bulk bar shows the count and says when it's over the 200-per-action limit. |
| Sorting | Click a header to sort by it alone; shift-click to add it as the next tiebreaker, and again to flip it. Headers show order and direction. A sort bar lists the sort keys with direction toggles and remove buttons, and replaces the phone sort menu. The sort is remembered for your follows and for analyses separately. |
| Several lists | Bulk Add to list and Remove from list take any number of your lists (grouped by account, plus new list on either account). Each list is changed by the account that owns it, skipping people already on it, and the result is reported per list. |

### Out of scope

- More than 10 accounts in one group, and keeping groups longer than 24 hours.

### How we know it works

- A group of 6 follows gives one table whose "Followed by" counts match the single lookups.
- Shift-click range selection and "Select all that match" work.
- Followers ascending then posts descending sorts correctly and survives a reload.
- 20 people added to 2 lists in one action show up in the Bluesky app.
- All of it works at 375 px wide.

## Out of scope

- Keeping analyses permanently, comparing two other accounts with each other, and the other account's interactions.

### How we know it works

- An account following about 1,000 people is analysed in under 3 minutes, and opening it again within a day is instant.
- Follow and + List each take one click from a row, and show up in the Bluesky app.
- The deleted-account filter finds the bare `did:plc` rows.
- The new controls work at 375 px wide.

## Out of scope

- Moderation lists (block and mute lists), and starter packs.
- Lists owned by other people, other than reading one shared as a link.

### How we know it works

- The dashboard's first load downloads at least 60% less than before, and a second visit doesn't download `app.js` or `style.css` again.
- From the Mac, a small request like `/api/status` takes clearly less time than the 0.3 s measured from San Francisco.
- At 375 px wide, the first post is visible without scrolling on Following, and every tab and every Follows stat is reachable.
- A list created in Skydash appears in the Bluesky app with the same members; renaming, removing a member and deleting show there too.

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
