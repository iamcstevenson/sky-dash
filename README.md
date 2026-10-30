# Skydash

A free, local dashboard for two Bluesky accounts.

It runs on your Mac and collects posts from everyone your accounts follow, using Bluesky's free live stream (Jetstream). When it starts, it catches up on anything it missed while it was off. Everything is stored in `data/skydash.db`.

## Setup

1. Install Node.js 23.6 or newer (`node --version` to check).
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and fill in each account's handle and an **app password**
   (Bluesky → Settings → Privacy and Security → App Passwords). Never use your real password.
4. Open http://127.0.0.1:4747

## Running in the background

Skydash lives in `~/Skydash` and runs as a macOS background service (a LaunchAgent at
`~/Library/LaunchAgents/com.skydash.dashboard.plist`). macOS starts it when you log in and restarts it
within about 10 seconds if it ever stops, so you don't need a Terminal window open. Its log is
`~/Library/Logs/Skydash.log`.

Restart it (for example after changing `.env` or the code):

```
launchctl kickstart -k gui/$(id -u)/com.skydash.dashboard
```

Stop it until the next login:

```
launchctl bootout gui/$(id -u)/com.skydash.dashboard
```

Start it again without logging out:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.skydash.dashboard.plist
```

Remove it completely: run the stop command, then delete that `.plist` file.

Don't also run `npm start` while the service is running; both would try to use port 4747.

## What works now (phase 1)

- **Unified Following feed** from both accounts, covering the last 72 hours, with posts and replies. You can filter by type and by who follows the author (A, B or both).
- **Replies in context:** each reply shows the post it answers (and the thread's first post). Click **Thread** to see the whole conversation.
- **Act as:** choose which account likes, reposts, replies, quotes or posts. Each post shows A/B badges for who follows the author and who already liked or reposted it.
- **Double-action warning:** if your other account already liked or reposted a post, Skydash asks before doing it again.
- A **new posts** banner appears as posts arrive.
- **Profile cards:** hover over anyone's avatar or name in any feed (or tap it on a phone) to see their bio, follower counts, your 14-day stats on them, and whether they follow each of your accounts. From the card you can **Unfollow** or **Follow** from A or B (with Undo), **Mute**, see **Their posts**, or open them in Bluesky. Posts from someone you just unfollowed fade out in the Following feed.
- **Images:** new posts, replies and quotes can include up to 4 images. Click **Add images**, paste one into the text
  box, or drag files onto the compose box. Each image has its own **alt text** box; Skydash asks before posting an
  image without one. Images are resized to fit Bluesky's 2 MB limit, and hidden photo metadata (like GPS location) is
  removed before upload. GIFs post as a still image.
- **Video:** click **Add video** (or drop one on the compose box) to attach one video per post: MP4, MOV, WebM or MPEG,
  up to 3 minutes and 100 MB. It uploads straight away to Bluesky's video service, which converts it; the box shows
  upload and processing progress, and **Post** turns on when it's ready. Add alt text in the box beside the preview.
  A post can have images or a video, not both, and the "Posting as" account is locked while a video is attached
  (the upload belongs to that account). Bluesky allows each account a daily number of video uploads.
- **Theme:** the button at the top right cycles Auto (follows your Mac), Light and Dark.
- **English only** (on by default) hides posts in other languages in Following, Keywords and Trending. Posts go by
  their language label; for the roughly 10% with no label, Skydash looks at the text (non-Latin scripts, or more common
  Spanish/German/French/Portuguese/Italian/Dutch words than English ones). It errs toward keeping a post when unsure.

### Sharing a post

The share arrow on every post opens the same menu as bsky.app: **Copy link to post**, **Send via chat** (pick a recent
chat or search for someone, add an optional message, and send it from the account you're acting as), and **Embed post**
(wide screens only), which gives you Bluesky's embed code with a System, Light or Dark option. Posts whose authors hide
them from logged-out viewers only offer Send via chat, with a note explaining why.

Send via chat needs an app password created with "Allow access to your direct messages" turned on.

### Profile cards everywhere

Hovering over a name or avatar opens the profile card on every tab: posts, quoted posts, @mentions, notifications, the
Follows table, Trending, Discover and the keyword rules.

## Notifications tab

Modeled on Bluesky's new notifications beta, using the same grouped notifications from Bluesky's servers:

- **All, People I follow, Replies, Follows and Post alerts** tabs.
- **Grouped rows:** "Alex and 24 others liked your post" expands to list everyone. Replies, quotes and mentions show the
  post with its reply context and the usual like, reply, repost, quote and share buttons.
- **Today and Earlier** sections, with unread notifications tinted. Follows is a list of people with Follow buttons.
- **Unread counts** on the tab and on each account's button, and a **Load new notifications** button when more arrive.

Notifications belong to one account at a time, so the tab follows whichever account you're acting as. As on Bluesky,
opening **All** marks that account's notifications as seen on Bluesky itself; the other tabs don't. Rows stay tinted
until you reload the list, so you can see what was new. **Mark all as read** clears the tint and the counts straight
away, from any tab, here and in the Bluesky app. Notifications stay in the list afterwards, as they do on Bluesky.

## Keywords tab (phase 2)

- Add keywords, #hashtags or "exact phrases". Each one is searched across all of Bluesky, and Skydash keeps matches from the last 48 hours. It checks for new matches every 2 minutes.
- Bluesky search syntax works too: `lang:en`, `-word` to exclude, `from:handle`.
- Click a keyword to show only its posts. ❚❚ pauses a keyword, ✕ removes it, and 📡 controls whether it is part of your custom Bluesky feed.
- **Hide people I follow** shows only accounts you don't follow yet.
- Matches are highlighted, and like/repost/reply/quote work the same way as in the Following tab.
- Very common words are capped at the newest 2,000 matches per check (shown as "2,000+").

### Context rules: what a keyword should mean

Click **⚙** on a keyword to say what it should mean, e.g. "wildcats" = the Kentucky Wildcats:

- **Must mention one of:** a post is shown only if it also mentions one of these (Kentucky, BBN, Rupp, ...). Leave empty to show every match.
- **Hide if it mentions:** posts mentioning any of these are hidden (Arizona, Villanova, ...).
- **Always show / Never show accounts:** override the word rules for specific people. Skydash suggests accounts whose posts keep passing the rules, like team beat writers.

Words match whole words and ignore case, except words in ALL CAPS (UK, SEC, STL), which must match exactly.
The page checks a post's text, its link card, image descriptions and hashtags.

Ready-made rules fill in automatically for **cardinals** (St. Louis Cardinals), **wildcats**, **cats** and **uk**
(Kentucky) and **sec** (Southeastern Conference) the first time you add those keywords. You can edit them freely.

Each keyword chip shows how many matches are shown and hidden. Tick **Show hidden posts** to see what the rules hid
and why ("Mentions 'Labour'", "No context words"), with an **Always show @someone here** button on each. Shown posts
have a **Never show @someone** button for the occasional off-topic account. Your custom Bluesky feed follows the same rules.

### Read the keyword feed in the Bluesky app (optional)

Bluesky's servers have to reach your Mac for this, so it needs a public address. Tailscale Funnel is free and keeps the same address. (A free Cloudflare quick tunnel gets a new address every restart, which would break the feed.)

1. Install Tailscale, then run `tailscale funnel --bg 4748`.
2. Put the name it prints in `.env` as `FEEDGEN_HOSTNAME=your-mac.tail1234.ts.net`, then restart.
3. In the Keywords tab, open **Read this feed in the Bluesky app** and click **Publish feed**.

Only the feed server on port 4748 is public, and it answers just the three requests Bluesky makes. The dashboard on port 4747 stays private. The feed only updates while Skydash is running.

## Follows tab (phase 3)

One row per account that either of your accounts follows, with:

- **By:** which of your accounts follows them. The filters at the top show Both, A only and B only.
- **Posts, Replies and Reposts** in the last 14 days, plus **Repost %** (how much of their activity is reposts).
- **Last active:** days since their last post or repost, even if that was more than 14 days ago.
- **Follows you:** whether they follow each of your accounts back (✕ means they don't).
- **Interacted:** how many times they've liked, replied to, reposted, quoted or mentioned you. This comes from your notifications, read without marking them as read. The note at the top shows how far back that history goes.
- **Followers** count.

Click a column to sort. The quick filters (Quiet 14+ days, At most N posts + replies, Doesn't follow back, Never interacted, Mostly reposts, Muted) can be combined. **Posts** opens that person's last 14 days in the Following tab.

Select rows to act on them. Every action shows who will be affected and from which account, and waits for you to confirm:

- **Unfollow** from A, B or both, with an **Undo** button for 10 seconds afterwards.
- **Move to list:** adds them to one of your lists (or a new one) and optionally unfollows them from that account.
- **Mute** from either account, with Undo. They aren't told.
- **Follow from…** to copy follows between your two accounts.

The first start after updating reads 14 days of history for everyone you follow. That takes 5 to 10 minutes, and the counts fill in while it runs. After that, the live stream keeps them current, and anyone you newly follow gets their history read straight away.

## Trending tab (phase 4)

Topics from posts by people you follow, counted by how many **different people** used them, so one prolific poster can't make something trend.

The page shows three sections, each with its top 5 (click **Show all** for the rest):

- **Rising:** topics used by noticeably more people than usual. "Usual" is the average for a window of the same length over the week before. **new** means it wasn't used at all that week.
- **Most talked about:** the biggest topics in the window, rising or not.
- **Most shared:** posts that 2 or more people you follow reposted or quoted. Click one to open its thread.

Under each topic is a one-line summary of what it's about, picked from the posts behind it (no AI involved): the
headline of an article several of them link to (marked **Headline**), otherwise the sentence that best represents what
people are saying. "Also" lists other names that come up alongside it.
- Choose a window of 6 hours, 24 hours or 3 days, and Everyone, A follows, B follows or Both.
- Click a topic to see every post behind it, with the topic highlighted. Like, reply, repost and quote work as usual.

Topics are hashtags, shared links, mentioned accounts, and names: words and two-word phrases that people write capitalized mid-sentence (Michigan, World Series, NASA). Ordinary words like "game" only show up as part of a phrase. Words and phrases are only read from English (or unlabeled) posts. Hashtags, links and mentions count in any language.

The 6- and 24-hour windows work best. A week holds only two earlier 3-day windows, so "usual" is rougher for the 3-day view.

## Discover tab

Finds people you don't follow who **regularly** post or reply about your keywords. Over the last 14 days it ranks them by:

- **On-topic days and posts:** how many different days they posted matches that pass your context rules, and how many of those were replies.
- **Focus:** what share of everything they post is on-topic (sampled from their recent posts), so specialists beat big accounts that mention a topic once.
- **Reshared by people you follow:** your follows reposted or quoted their on-topic posts.
- **Followed by your experts:** your "Always show" accounts and your most on-topic follows follow them.

Filter by keyword (paused keywords included; their history still counts) and by Mostly posts / Mostly replies.
Accounts posting dozens of matches a day are marked **high volume**, and ones calling themselves bots or feeds are
marked **automated**; both rank lower. Every suggestion shows why it's there.

Actions on each person:

- **Their posts** opens their last 14 days in the Following tab, even though you don't follow them.
- **Audition** collects their posts live without following them (they aren't notified). The Auditioning list shows how
  many of their posts since then were on-topic, so you can **Follow** or **Drop** them later.
- **Follow** from A or B (with Undo), or **Not interested** to stop suggesting them (with Undo).

Network signals (experts' follows and posting volume) refresh a minute after startup and every 6 hours, or with
**Refresh signals**. Rankings need history: they firm up once a week or more of keyword matches is stored.

## Phone access with Tailscale (free)

Keep `HOST=127.0.0.1`, install Tailscale on the Mac and your phone, then run:

```
tailscale serve --bg 4747
```

Add your Mac's Tailscale name to `.env`, for example `ALLOWED_HOSTS=my-mac.tailnet-name.ts.net`, and restart. The dashboard refuses requests addressed to any other host name, because it can post as you.

## License

MIT. See [LICENSE](LICENSE).
