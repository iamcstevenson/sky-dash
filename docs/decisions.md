# Decisions

Recorded after the fact (November 2026). Add new decisions at the bottom with a date.

### 1. Run locally, not hosted (October 2026)
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

### 13. Groups are one list of topic words (November 2026)
Groups had keywords (searched) and "Must mention one of" (a filter on what the keywords found). For a topic, most words are specific enough to search, so the same words were typed twice, and an empty keyword list silently showed nothing. Now every word in a group is a searched topic word that also counts as context; vague ones (UK, wildcats) are ticked and need another unticked topic word or a context word. Considered: an "also search these" switch, or just renaming the two boxes; both kept the double list. Existing groups were migrated by marking their keywords vague, which gives identical results (checked on all stored matches). Words typed into a group editor skip the ready-made keyword rules, since the group defines their meaning, and are deleted when removed from their last group. Hub keeps sending `keywordIds`/`must`, which still work; `must` now means context words. Issue #10.
