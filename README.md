# Skydash

A free, self-hosted dashboard for one or two Bluesky accounts. It runs on your own computer, and your data stays there.

**What it does**

- **Following:** one feed for both accounts, with replies shown in context.
- **Notifications:** grouped notifications, modeled on Bluesky's new notifications beta.
- **Keywords:** feeds of public posts from anyone, with rules that pin down what a keyword means ("cardinals" = the St. Louis Cardinals).
- **Follows:** 14-day stats for everyone you follow, with bulk unfollow, mute and move-to-list.
- **Trending:** what's rising among the people you follow, with a summary of each topic.
- **Discover:** people you don't follow who regularly post about your topics.
- **Posting:** like, repost, reply and quote from either account, with images, video and alt text. Share any post the way bsky.app does.

Developed and run on macOS. It should work anywhere Node.js runs, but only macOS has been tried, and the background service below is macOS only.

## Setup

1. Install [Node.js](https://nodejs.org) 23.6 or newer (`node --version` to check).
2. Download this repository, and in its folder run:

   ```bash
   npm install
   ```

3. Create your settings file:

   ```bash
   cp .env.example .env
   ```

4. Edit `.env` and fill in each account's handle and an **app password**. Create one in Bluesky under Settings → Privacy and Security → App Passwords. Never use your real password. Turn on "Allow access to your direct messages" if you want Send via chat to work. With one account, leave the second account's lines as they are.
5. Start it:

   ```bash
   npm start
   ```

6. Open http://127.0.0.1:4747

The first start reads the last 14 days of posts from everyone you follow, which takes 5 to 10 minutes for several hundred follows. The dashboard works while that runs, and the numbers fill in. After that, it follows a live stream and catches up on anything it missed while it was off.

## Privacy and security

- **Your data stays on your computer.** Posts, stats and sign-in sessions are stored in `data/skydash.db`. Skydash only talks to Bluesky's own services, and there's no analytics or outside server.
- **App passwords are stored unencrypted** in `.env`, and sign-in sessions in the database. Keep both private; `.gitignore` keeps them out of git. You can revoke an app password in Bluesky at any time.
- **The dashboard has no login, and anyone who can reach it can post as you.** It only listens on your own computer (`127.0.0.1`) and refuses requests addressed to any other host name. Don't put it on the public internet. For phone access, use the private Tailscale setup below.
- **The optional custom feed is public** by design, on its own port, and can't reach the dashboard.

## Run it in the background (macOS)

This has macOS start Skydash when you log in and restart it within about 10 seconds if it stops, so no Terminal window needs to stay open.

Keep Skydash on your internal disk: external drives can power down while the Mac sleeps, which stops it. Then, from the Skydash folder:

```bash
sed -e "s#__NODE__#$(command -v node)#" -e "s#__SKYDASH_DIR__#$PWD#" -e "s#__HOME__#$HOME#g" launchd/com.skydash.dashboard.plist.example > ~/Library/LaunchAgents/com.skydash.dashboard.plist
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.skydash.dashboard.plist
```

Its log is `~/Library/Logs/Skydash.log`. Don't also run `npm start` while the service is running, because both would use port 4747.

Restart it, for example after changing `.env` or updating the code:

```bash
launchctl kickstart -k gui/$(id -u)/com.skydash.dashboard
```

Stop it until the next login:

```bash
launchctl bootout gui/$(id -u)/com.skydash.dashboard
```

To remove it completely, run the stop command, then delete `~/Library/LaunchAgents/com.skydash.dashboard.plist`.

## Using it

The **Act as** buttons at the top choose which account likes, reposts, replies, quotes and posts. The theme button at the top right cycles Auto, Light and Dark.

### On every post

- **Double-action warning:** if your other account already liked or reposted a post, Skydash asks before doing it again.
- **Profile cards:** hover over a name or avatar on any tab, or tap it on a phone, to see their bio, follower counts, your 14-day stats on them, and whether they follow each of your accounts. From the card you can **Unfollow** or **Follow** from either account (with Undo), **Mute**, see **Their posts**, or open them in Bluesky.
- **Share:** the arrow opens the same menu as bsky.app: **Copy link to post**, **Send via chat** (pick a recent chat or search for someone, and add a message if you like), and **Embed post** on wide screens, with a System, Light or Dark option. Posts whose authors hide them from logged-out viewers only offer Send via chat, with a note explaining why.
- **English only** (on by default) hides posts in other languages in Following, Keywords and Trending. Posts go by their language label. For those with no label, Skydash looks at the text and keeps the post when unsure.

### Posting

- **Images:** up to 4 per post. Click **Add images**, paste one into the text box, or drag files onto the compose box. Each has its own **alt text** box, and Skydash asks before posting an image without one. Images are resized to fit Bluesky's 2 MB limit, and hidden photo metadata like GPS location is removed before upload. GIFs post as a still image.
- **Video:** one per post, in MP4, MOV, WebM or MPEG, up to 3 minutes and 100 MB. It uploads as soon as you pick it, and **Post** turns on when Bluesky has finished processing it. Add alt text beside the preview. A post can have images or a video, not both. The "Posting as" account is locked while a video is attached, because the upload belongs to that account. Bluesky limits daily video uploads per account and requires a verified email.
- **Drafts:** **Save draft** in the compose box keeps a post or reply, with its images or video, for later. **Drafts** next to **New post** lists them to edit, post or delete. Drafts are shared with the Hub iPhone app through Hub Agent. If both change the same draft before syncing, the newest edit wins, and the draft notes which version it replaced so you can still see it. Posted and deleted drafts stay listed for a week, so each side can see what happened to them.

### Following

One feed of posts and replies from the last 72 hours, filtered by type and by which account follows the author. Each reply shows the post it answers, and **Thread** opens the whole conversation. A banner appears when new posts arrive.

### Notifications

- **All, People I follow, Replies, Follows and Post alerts** tabs, using the same grouped notifications as Bluesky's beta.
- **Grouped rows:** "Alex and 24 others liked your post" expands to list everyone. Replies, quotes and mentions show the post, what it replied to, and the usual buttons.
- **Today and Earlier** sections, with unread notifications tinted. Follows is a list of people with Follow buttons.
- **Unread counts** on the tab and on each account's button, and a **Load new notifications** button when more arrive.

The tab shows one account at a time, following whichever account you're acting as. As on Bluesky, opening **All** marks that account's notifications as seen on Bluesky itself; the other tabs don't. **Mark all as read** clears the tint and counts straight away, from any tab, here and in the Bluesky app. Notifications stay in the list afterwards, as they do on Bluesky.

### Keywords

- Add keywords, #hashtags or "exact phrases". Each is searched across all of Bluesky every 2 minutes, and the last 48 hours of matches are shown.
- Bluesky search syntax works too: `lang:en`, `-word` to exclude, `from:handle`.
- Click a keyword to show only its posts. ❚❚ pauses it, ✕ removes it, and 📡 controls whether it's in your custom Bluesky feed.
- **Hide people I follow** shows only accounts you don't follow yet.
- Very common words are capped at the newest 2,000 matches per check (shown as "2,000+").

**Groups** are topics defined by one list of **topic words**, like a "UK Athletics" group of `"Big Blue Nation"`, `#BBN`, `"Rupp Arena"`, `UK` and `wildcats`:

- Click **+ New group**, then type its topic words in ⚙. Each topic word is a keyword: it's searched every 2 minutes and its posts show in the group. You can also drag loose keywords into a group, and hold Option to keep one in two groups.
- **Vague words:** tick topic words that mean other things too, like `UK` or `wildcats` (marked **?** in the group). Their posts only show if they also mention another topic word that isn't ticked, or one of the group's **context words**. Keep the unticked words specific: a broad one like `cfb` lets a vague word through for any team.
- **Context words** aren't searched; they only vouch for vague words. **Move these to topic words** turns them into searched topic words in one click, quoting phrases for you.
- **Hide if it mentions** and **Always/Never show** accounts work as before, and each keyword's own rules still apply on top.
- Click a group's name to see posts from all its topic words, with each post listed once. Clicking one inside the group narrows that view.
- A keyword can be in several groups, each giving it a different meaning. In the overall view, a post shows if it passes at least one of them.
- Pausing a group or changing its 📡 applies to all its topic words, including where they're also in other groups.
- Removing a topic word in ⚙ deletes it if it was typed into a group and isn't in another one; any other keyword is only taken out of the group. Removing a group never deletes keywords.
- The group shows a warning when it has no topic words, or all of them are paused.

**Context rules** say what a keyword should mean. Click **⚙** on a keyword:

- **Must mention one of:** a post only shows if it also mentions one of these (Kentucky, BBN, Rupp, ...). Leave it empty to show every match.
- **Hide if it mentions:** posts mentioning any of these are hidden (Arizona, Villanova, ...).
- **Always show / Never show accounts:** override the word rules for specific people. Skydash suggests accounts whose posts keep passing the rules.

Words match whole words and ignore case, except words in ALL CAPS (UK, SEC, STL), which must match exactly. Rules check a post's text, link card, image descriptions and hashtags.

Ready-made rules fill in the first time you add **cardinals** (St. Louis Cardinals), **wildcats**, **cats** or **uk** (Kentucky), or **sec** (Southeastern Conference). You can edit them freely.

Each keyword shows how many matches are shown and hidden. **Show hidden posts** lists what the rules hid and why, with an **Always show** button on each. Shown posts have a **Never show** button for the occasional off-topic account.

**Read your keyword feed in the Bluesky app (optional).** Bluesky's servers have to reach your computer for this, so it needs a public address. Tailscale Funnel is free and keeps the same address, while a free Cloudflare quick tunnel changes on every restart, which would break the feed.

1. Install Tailscale, then run `tailscale funnel --bg 4748`.
2. Put the name it prints in `.env` as `FEEDGEN_HOSTNAME=your-mac.tail1234.ts.net`, then restart Skydash.
3. In the Keywords tab, open **Read this feed in the Bluesky app** and click **Publish feed**.

Only the feed server on port 4748 is public, and it answers just the three requests Bluesky makes. The feed follows your context rules, and it only updates while Skydash is running.

### Follows

One row for each account you follow:

- **By:** which of your accounts follows them, with filters for Both, A only and B only.
- **Posts, Replies, Reposts** in the last 14 days, and **Repost %**.
- **Last active:** days since their last post or repost.
- **Follows you:** whether they follow each of your accounts back.
- **Interacted:** how many times they've liked, replied to, reposted, quoted or mentioned you, from your notification history. Collecting this doesn't mark anything as read.
- **Followers** count.

Click a column to sort. Quick filters can be combined: Quiet 14+ days, At most N posts + replies, Doesn't follow back, Never interacted, Mostly reposts, Muted. **Posts** opens that person's last 14 days.

Select rows to act on them. Each action shows who's affected and from which account, and waits for you to confirm:

- **Unfollow** from either or both accounts, with Undo for 10 seconds.
- **Move to list:** add them to one of your lists or a new one, and optionally unfollow.
- **Mute** from either account, with Undo. They aren't told.
- **Follow from…** to copy follows between your accounts.

### Trending

Topics from posts by people you follow, counted by how many **different people** used them, so one prolific poster can't make something trend. Three sections show their top 5, with **Show all** for the rest:

- **Rising:** used by noticeably more people than usual, meaning the average for a window of the same length over the week before. **new** means it wasn't used at all that week.
- **Most talked about:** the biggest topics, rising or not.
- **Most shared:** posts that 2 or more people you follow reposted or quoted.

Choose 6 hours, 24 hours or 3 days, and Everyone, A follows, B follows or Both. Click a topic to see every post behind it, with the topic highlighted.

Each topic has a one-line summary picked from the posts behind it, with no AI involved: the headline of an article several of them link to (marked **Headline**), otherwise the sentence that best represents what people are saying. "Also" lists other names that come up alongside it. A topic that's really two stories can get an odd summary.

Topics are hashtags, shared links, mentioned accounts, and names: words and two-word phrases written capitalized mid-sentence (Michigan, World Series, NASA). Ordinary words like "game" only appear as part of a phrase. Words and phrases come only from English or unlabeled posts. The 6- and 24-hour windows work best; a week holds only two earlier 3-day windows, so "usual" is rougher for 3 days.

### Discover

People you don't follow who **regularly** post or reply about your keywords, ranked over the last 14 days by:

- **On-topic days and posts:** how many different days they posted matches that pass your context rules. At least 2 days are needed, or 1 day with 3 or more of your experts following them.
- **Focus:** what share of everything they post is on-topic, so specialists beat big accounts that mention a topic once.
- **Reshared by people you follow:** your follows reposted or quoted their on-topic posts.
- **Followed by your experts:** your "Always show" accounts and your most on-topic follows follow them.

Filter by group or keyword (paused ones included, since their history still counts) and by Mostly posts or Mostly replies. Accounts posting dozens of matches a day are marked **high volume**, and ones calling themselves bots or feeds are marked **automated**; both rank lower. Every suggestion shows why it's there.

- **Their posts** opens their last 14 days, even though you don't follow them.
- **Audition** collects their posts live without following them, and they aren't notified. The Auditioning list shows how many were on-topic, so you can **Follow** or **Drop** them later.
- **Follow** from either account, or **Not interested** to stop suggesting them. Both have Undo.

Network signals refresh a minute after startup and every 6 hours, or with **Refresh signals**. Rankings need history, so they firm up after a week or more of keyword matches.

## Phone access with Tailscale (free)

Keep `HOST=127.0.0.1`, install Tailscale on your computer and your phone, then run:

```bash
tailscale serve --bg 4747
```

Add your computer's Tailscale name to `.env`, for example `ALLOWED_HOSTS=my-mac.tailnet-name.ts.net`, and restart Skydash.

## Troubleshooting

- **The page won't load:** check that Skydash is running. If you use the background service, look in `~/Library/Logs/Skydash.log`.
- **"Sign-in problem" on the page:** check the handle and app password in `.env`, then restart.
- **`EADDRINUSE` in the log:** the port is taken, usually by another copy of Skydash. Stop it first, or change `PORT` in `.env`.
- **Send via chat says the password can't access messages:** create a new app password with direct messages allowed, and update `.env`.

## License

MIT. See [LICENSE](LICENSE). This is an independent project, not affiliated with Bluesky.
