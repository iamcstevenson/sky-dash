# Decisions

Recorded after the fact (November 2026). Add new decisions at the bottom with a date.

### 1. Run locally, not hosted (October 2026) — replaced by #15
Zero cost and the user's data stays on their machine. Accepted cost: it only collects while the Mac is on, which backfill covers.

### 2. Collect with Jetstream plus backfill, not polling (October 2026)
Options were polling the API, a browser-only page, or a local collector on Jetstream. Follow stats need 14 days of posts from hundreds of accounts; polling would mean thousands of requests per refresh. Jetstream streams just the followed accounts for free, and startup backfill fills gaps. Chosen: local server + Jetstream + SQLite.

### 3. Node 23.6+ with built-in SQLite and TypeScript, one dependency (October 2026)
`node:sqlite`, global `WebSocket` and native type stripping remove native builds and a build step. The only package is the official `@atproto/api`. Page is plain JavaScript for the same reason.

### 4. App passwords, stored sessions (October 2026)
Never real passwords. Sessions are reused across restarts because Bluesky limits logins per day.

### 5. Localhost only, host and origin checks (October 2026)
The page can post as you and has no login, so it binds to `127.0.0.1`, refuses unknown `Host` headers and cross-site `POST`s. Phone access goes through `tailscale serve`, not opening the port.

### 6. Hydrate on view (October 2026)
Store raw records; fetch full views (counts, author, each account's like state) from Bluesky when shown, cached for a minute. Keeps counts fresh and enables the double-like warning.

### 7. Keyword feed through Bluesky search, not the full firehose (October 2026)
Search every 2 minutes is far less bandwidth than filtering all of Bluesky locally, and covers posts from before startup.

### 8. Custom feed on its own public port, via Tailscale Funnel (October 2026)
Bluesky must reach the feed server, so it must be public. Isolating it on port 4748 with three routes keeps the dashboard private. Funnel keeps a stable address; Cloudflare quick tunnels don't.

### 9. Trending counts distinct people, no AI (October 2026)
One prolific poster can't make a topic trend. Summaries are picked from the posts (headline or most representative sentence) to stay free and private.

### 10. Context rules and groups for keywords (October 2026)
Plain keyword search was too noisy ("cardinals"). Rules and groups let a keyword mean one thing, with per-account overrides.

### 11. Hub iPhone app reads a synced copy (November 2026)
Rather than exposing the dashboard to the phone, Hub Agent on the Mac reads read-only `/api/sync/*` routes and pushes to iCloud. The export never includes sessions, follow URIs or raw records. Drafts are the one two-way exchange; the newest edit wins and the replaced version is kept.

### 12. Work through branches and pull requests (November 2026)
`main` always works; features go on branches merged by PR. Backlog belongs in GitHub Issues.

### 13. Groups are one list of topic words (November 2026) — replaced by #14
Groups had keywords (searched) and "Must mention one of" (a filter on what the keywords found). For a topic, most words are specific enough to search, so the same words were typed twice, and an empty keyword list silently showed nothing. Now every word in a group is a searched topic word that also counts as context; vague ones (UK, wildcats) are ticked and need another unticked topic word or a context word. Considered: an "also search these" switch, or just renaming the two boxes; both kept the double list. Existing groups were migrated by marking their keywords vague, which gives identical results (checked on all stored matches). Words typed into a group editor skip the ready-made keyword rules, since the group defines their meaning, and are deleted when removed from their last group. Hub keeps sending `keywordIds`/`must`, which still work; `must` now means context words. Issue #10.

### 14. Groups are saved sets of keywords, with no rules (November 2026)
Topic words (#13) still felt too complex in use. A group is now just a named set of keywords: view their posts together, pause or 📡 them together, filter Discover and Trending by it. Group rules, vague words, context words, group accounts and drag-and-drop are gone; each keyword's own ⚙ rules remain. Existing group rules were dropped rather than copied onto keywords (Christian's choice). Keywords are added in bulk with a group picker, or selected and saved as a group. Multi-word plain text is quoted as a phrase, since unquoted words match anywhere in a post (12 results vs 1 for "Big Blue Nation" in a live check); search syntax is kept as typed. Keywords can be edited in place, which clears their old matches and searches again. Hub's older saves (`keywordIds`, `topics`, `must`/`exclude`) are still accepted, and the sync export keeps the rule fields, empty. Issue #12.

### 15. Host on one DigitalOcean droplet (November 2026)
Running on the Mac meant collecting only while it was on and its external drive was plugged in, and the Mac was short on disk space. Christian dropped the zero-cost rule to get an always-on private host that future projects can share. Options: Oracle Cloud's free tier (ruled out by Christian; it also halved its free allowance in 2026), Google Cloud's free e2-micro (1 GB of traffic a month, too tight), Hetzner (repeated 2026 price rises and reported stock shortages), Fly.io (works, but private Tailscale access and single-host volumes add setup), AWS Lightsail (a close equal), and a DigitalOcean droplet. Chosen: a DigitalOcean Basic droplet with weekly backups, about $7 a month at 1 GB. Flat pricing with transfer included means no surprise bills, it's a plain Linux server so nothing about Skydash changes, and it's an established US company. iCloud was rejected for running anything: it can't run code, its sync can corrupt a live SQLite database, and Linux has no supported way to reach it.

### 16. Private through Tailscale, no public ports (November 2026)
Skydash keeps listening on `127.0.0.1` (#5). `tailscale serve` puts the dashboard on the tailnet and SSH is reachable only over Tailscale, so the droplet's cloud firewall can drop all inbound traffic. The custom feed stays on Tailscale Funnel (#8), which also needs no open port. Considered: a public HTTPS site with a login, which would mean writing authentication for a page that can post as you.

### 17. Encrypted nightly database copies in Cloudflare R2 (November 2026)
DigitalOcean's weekly backups cover the whole server but stay with DigitalOcean and can lose up to a week. A nightly `sqlite3 .backup` uploaded through an `rclone` encrypted remote to R2 keeps 14 days off-site for free (under 10 GB) and lets the server be rebuilt anywhere. Encrypted because the database holds Bluesky sign-in sessions. Considered: DigitalOcean Spaces ($5 a month, same company as the server) and Litestream (continuous, but more moving parts than a daily copy of a database that backfill can catch up on).

### 18. systemd and a deploy script, no containers (November 2026)
One process with one dependency doesn't need Docker. A systemd unit mirrors the launchd agent, and deploying is `git pull`, `npm ci` and a restart through a script kept in the repo. Deploy-on-push with GitHub Actions is a later step, because it needs a Tailscale key stored in GitHub.

### 19. Plain SSH over Tailscale, not Tailscale SSH (November 2026)
Tailscale SSH's default policy asks for a browser re-check before root logins, which blocks scripted deploys. Instead OpenSSH keeps key-only logins (passwords off), and both firewalls only let it be reached through Tailscale. The droplet uses its own key without a passphrase, kept only on the Mac, so scripts can connect without unlocking a key.

### 20. Move the server to New York (November 2026)
Christian is on Eastern time, and from his Mac every request to San Francisco took at least 100 ms before Skydash did any work (most requests take under 15 ms on the server). DigitalOcean's NYC3 region offers the same 1 GB size at the same price. The server is rebuilt there from `deploy/setup.sh` and the latest R2 backups for both Skydash and Tubedash, keeps the Tailscale name `skydash` so no address changes, and the San Francisco droplet is deleted only after the new one has run cleanly for a day. Considered: staying put and relying on compression alone, which helps download size but not the round trip on every request.

### 21. Compression and browser caching built in, no proxy (November 2026)
Responses were sent uncompressed with `Cache-Control: no-cache`, so the phone downloaded about 500 KB on every load. Node's built-in `zlib` compresses text responses (gzip or Brotli, whichever the browser accepts), and static files get an `ETag` so the browser revalidates instead of downloading them again. Considered: putting Caddy or nginx in front, which adds a second service to run for something Node already has.

### 22. Lists tab manages curated lists only (November 2026)
The Bluesky lists Christian reads are curated lists. Moderation lists (mute and block) and starter packs act on accounts in ways that need their own confirmations and are left out. Lists are read and changed straight on the account's PDS, not stored in the database, so the Bluesky app and Skydash always agree. A list feed uses Bluesky's own `getListFeed`, so it includes members Skydash doesn't otherwise follow.

### 23. Another account's follows are read live and kept for a day, apart from the feeds (November 2026)
The 14-day stats for Christian's own follows come from posts Skydash already collects. For someone else's follows there's no such data, so Skydash reads each account's recent posts once from the public AppView (`getAuthorFeed`, up to two pages), four at a time, about 8 requests a second, well under its limit of about 3,000 per 5 minutes. About 1,000 accounts take about 2 minutes. The results go in their own tables (`ext_analyses`, `ext_stats`) and are kept for 24 hours, never in `posts`, so they don't appear in Following, Keywords or Trending, and they don't make the live stream watch more accounts. One analysis runs at a time. Considered: adding the accounts to the live stream, which only sees new posts and would take 14 days to fill in.

