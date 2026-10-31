// Context rules for keywords: what a keyword should mean ("cardinals" = the St. Louis Cardinals).
// A matching post is kept or hidden per keyword:
//   1. author marked "never show" for this keyword  -> hidden
//   2. author marked "always show" for this keyword -> kept
//   3. mentions an "exclude" word                   -> hidden
//   4. no "must mention" words set                  -> kept
//   5. mentions one of the "must mention" words     -> kept
//   6. otherwise                                    -> hidden (no context)
// Words match whole words, ignoring case, except words written in ALL CAPS ("UK", "SEC", "STL"),
// which must match exactly so "uk" in a URL or "sec" in "30 sec" don't count.
import { db } from './db.ts'

db.exec(`
  CREATE TABLE IF NOT EXISTS keyword_authors (
    keyword_id INTEGER NOT NULL,
    author_did TEXT NOT NULL,
    verdict TEXT NOT NULL, -- 'trusted' (always show) or 'blocked' (never show)
    PRIMARY KEY (keyword_id, author_did)
  );
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS keyword_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    must_terms TEXT,
    exclude_terms TEXT,
    position INTEGER,
    created_at INTEGER
  );
  -- A keyword can be in any number of groups
  CREATE TABLE IF NOT EXISTS keyword_group_members (
    group_id INTEGER NOT NULL,
    keyword_id INTEGER NOT NULL,
    position INTEGER,
    PRIMARY KEY (group_id, keyword_id)
  );
  CREATE INDEX IF NOT EXISTS group_members_keyword ON keyword_group_members(keyword_id);
  CREATE TABLE IF NOT EXISTS group_authors (
    group_id INTEGER NOT NULL,
    author_did TEXT NOT NULL,
    verdict TEXT NOT NULL,
    PRIMARY KEY (group_id, author_did)
  );
`)
for (const col of ['must_terms', 'exclude_terms', 'position']) {
  const cols = db.prepare('PRAGMA table_info(keywords)').all() as { name: string }[]
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE keywords ADD COLUMN ${col} ${col === 'position' ? 'INTEGER' : 'TEXT'}`)
}

// ---------- ready-made rules ----------

const KENTUCKY = ['Kentucky', 'UK', 'BBN', '#BBN', 'Big Blue', 'Big Blue Nation', 'Rupp', 'Rupp Arena', 'Lexington', 'Kroger Field', 'Mark Pope', 'Wildcats', 'Cats', 'SEC', '#WeAreUK', '#GoCats']
const SEC_TEAMS = [
  'Southeastern Conference', 'SEC', 'football', 'basketball', 'baseball', 'CFB', '#CFB', '#SECFootball', '#SEC',
  'Alabama', 'Auburn', 'Georgia', 'Florida', 'LSU', 'Tennessee', 'Kentucky', 'Missouri', 'Mississippi State', 'Ole Miss',
  'Arkansas', 'South Carolina', 'Texas A&M', 'Texas', 'Oklahoma', 'Vanderbilt', 'Crimson Tide', 'Gators', 'Bulldogs',
  'Volunteers', 'Vols', 'Razorbacks', 'Gamecocks', 'Aggies', 'Longhorns', 'Sooners', 'Commodores', 'Rebels', 'Wildcats', 'Tigers',
]

export const PRESETS: Record<string, { must: string[]; exclude: string[] }> = {
  cardinals: {
    must: ['St. Louis', 'St Louis', 'STL', 'Busch Stadium', 'MLB', 'baseball', '#STLCards', 'Cards', 'Redbirds', 'Marmol', 'NL Central'],
    exclude: ['Arizona', 'NFL', 'Louisville', 'Catholic', 'Vatican', 'pope', 'conclave', 'College of Cardinals', 'bird', 'birds', 'birding', 'feeder', 'Stanford', 'Ball State'],
  },
  wildcats: {
    must: KENTUCKY.filter((t) => t !== 'Wildcats'),
    exclude: ['Arizona', 'Villanova', 'K-State', 'Kansas State', 'Northwestern', 'Weber State', 'New Hampshire', 'Bethune-Cookman', 'Abilene Christian', 'Linfield'],
  },
  cats: {
    // "UK" can mean Britain next to "cats", so it doesn't count here
    must: KENTUCKY.filter((t) => t !== 'Cats' && t !== 'UK'),
    exclude: ['kitten', 'kittens', 'kitty', 'cat food', 'litter', 'litter box', 'purr', 'meow', 'adopt', 'adoption', 'shelter', 'vet', 'pet', 'pets', 'dog', 'dogs', 'Broadway', 'musical', 'Arizona', 'Villanova', 'K-State'],
  },
  uk: {
    // Only Kentucky-specific words: "football", "basketball" or "cats" show up in British posts too
    must: ['Kentucky', 'Wildcats', 'BBN', '#BBN', 'Big Blue', 'Big Blue Nation', 'Rupp', 'Rupp Arena', 'Lexington', 'Kroger Field', 'Mark Pope', 'SEC', '#GoCats', '#WeAreUK'],
    exclude: ['London', 'Britain', 'British', 'England', 'English', 'Scotland', 'Wales', 'Northern Ireland', 'Labour', 'Tory', 'Tories', 'Conservatives', 'Reform UK', 'Starmer', 'Farage', 'NHS', 'Parliament', 'Westminster', 'Brexit', '£', 'pounds', 'BBC', 'Premier League', 'King Charles'],
  },
  sec: {
    // The keyword itself can't count as its own context
    must: SEC_TEAMS.filter((t) => t !== 'SEC' && t !== '#SEC'),
    exclude: ['Securities and Exchange Commission', 'Securities', 'filing', 'filings', 'crypto', 'bitcoin', 'ETF', 'stock', 'stocks', 'enforcement', 'Wall Street', 'investors', 'Atkins', 'Gensler', '10-K', 'insider trading', 'regulators', 'seconds'],
  },
}

// Fill in ready-made rules for keywords that have none yet
export function applyPresets() {
  const rows = db.prepare('SELECT id, query, must_terms, exclude_terms FROM keywords').all() as {
    id: number
    query: string
    must_terms: string | null
    exclude_terms: string | null
  }[]
  for (const k of rows) {
    const preset = PRESETS[k.query.trim().toLowerCase()]
    if (preset && k.must_terms === null && k.exclude_terms === null) saveRules(k.id, preset.must, preset.exclude)
  }
}

// ---------- storage ----------

type Rules = {
  must: string[]
  exclude: string[]
  mustRe: RegExp | null
  excludeRe: RegExp[] // one per term, so we can say which word excluded a post
  trusted: Set<string>
  blocked: Set<string>
}

const cache = new Map<number, Rules>()

export function cleanTerms(list: unknown): string[] {
  const arr = Array.isArray(list) ? list : String(list ?? '').split(/[\n,]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of arr) {
    const t = String(raw).trim().slice(0, 80)
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase())
      out.push(t)
    }
  }
  return out.slice(0, 200)
}

export function saveRules(id: number, must: unknown, exclude: unknown) {
  db.prepare('UPDATE keywords SET must_terms = ?, exclude_terms = ? WHERE id = ?').run(
    JSON.stringify(cleanTerms(must)),
    JSON.stringify(cleanTerms(exclude)),
    id,
  )
  cache.delete(id)
}

export function setAuthor(id: number, did: string, verdict: 'trusted' | 'blocked' | null) {
  if (verdict) {
    db.prepare(
      `INSERT INTO keyword_authors (keyword_id, author_did, verdict) VALUES (?, ?, ?)
       ON CONFLICT(keyword_id, author_did) DO UPDATE SET verdict = excluded.verdict`,
    ).run(id, did, verdict)
  } else {
    db.prepare('DELETE FROM keyword_authors WHERE keyword_id = ? AND author_did = ?').run(id, did)
  }
  cache.delete(id)
}

export function forgetRules(id: number) {
  db.prepare('DELETE FROM keyword_authors WHERE keyword_id = ?').run(id)
  db.prepare('DELETE FROM keyword_group_members WHERE keyword_id = ?').run(id)
  cache.delete(id)
  clearGroupRules()
}

// Whole-word matcher. \b doesn't work for words like "#BBN" or "£", so check the characters around instead.
function termPattern(term: string): string {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`
}

function isAllCaps(term: string) {
  const letters = term.replace(/[^\p{L}]/gu, '')
  return letters.length >= 2 && letters === letters.toUpperCase()
}

function compile(terms: string[]): RegExp | null {
  if (!terms.length) return null
  // Case-sensitive terms (ALL CAPS) and the rest need different flags, so build one regex for each group
  const exact = terms.filter(isAllCaps).map(termPattern)
  const loose = terms.filter((t) => !isAllCaps(t)).map(termPattern)
  const parts = [...exact.map((p) => `(?-i:${p})`), ...loose] // (?-i:) = case-sensitive inside
  return new RegExp(parts.join('|'), 'iu')
}

export function rulesFor(id: number): Rules {
  const hit = cache.get(id)
  if (hit) return hit
  const row = db.prepare('SELECT must_terms, exclude_terms FROM keywords WHERE id = ?').get(id) as
    | { must_terms: string | null; exclude_terms: string | null }
    | undefined
  const must = row?.must_terms ? (JSON.parse(row.must_terms) as string[]) : []
  const exclude = row?.exclude_terms ? (JSON.parse(row.exclude_terms) as string[]) : []
  const trusted = new Set<string>()
  const blocked = new Set<string>()
  for (const a of db.prepare('SELECT author_did, verdict FROM keyword_authors WHERE keyword_id = ?').all(id) as {
    author_did: string
    verdict: string
  }[]) {
    ;(a.verdict === 'trusted' ? trusted : blocked).add(a.author_did)
  }
  const rules: Rules = {
    must,
    exclude,
    mustRe: compile(must),
    excludeRe: exclude.map((t) => compile([t])!),
    trusted,
    blocked,
  }
  cache.set(id, rules)
  return rules
}

// Group rules work the same way as a keyword's, and are read the same way
type GroupRules = Rules & { name: string }
const groupCache = new Map<number, GroupRules>()
let groupsByKeyword: Map<number, number[]> | null = null

export function clearGroupRules() {
  groupCache.clear()
  groupsByKeyword = null
}

export function groupRulesFor(id: number): GroupRules {
  const hit = groupCache.get(id)
  if (hit) return hit
  const row = db.prepare('SELECT name, must_terms, exclude_terms FROM keyword_groups WHERE id = ?').get(id) as
    | { name: string; must_terms: string | null; exclude_terms: string | null }
    | undefined
  const must = row?.must_terms ? (JSON.parse(row.must_terms) as string[]) : []
  const exclude = row?.exclude_terms ? (JSON.parse(row.exclude_terms) as string[]) : []
  const trusted = new Set<string>()
  const blocked = new Set<string>()
  for (const a of db.prepare('SELECT author_did, verdict FROM group_authors WHERE group_id = ?').all(id) as {
    author_did: string
    verdict: string
  }[]) {
    ;(a.verdict === 'trusted' ? trusted : blocked).add(a.author_did)
  }
  const rules = { name: row?.name ?? '', must, exclude, mustRe: compile(must), excludeRe: exclude.map((t) => compile([t])!), trusted, blocked }
  groupCache.set(id, rules)
  return rules
}

function groupsOf(keywordId: number): number[] {
  if (!groupsByKeyword) {
    groupsByKeyword = new Map()
    for (const m of db.prepare('SELECT group_id, keyword_id FROM keyword_group_members').all() as { group_id: number; keyword_id: number }[]) {
      groupsByKeyword.set(m.keyword_id, [...(groupsByKeyword.get(m.keyword_id) ?? []), m.group_id])
    }
  }
  return groupsByKeyword.get(keywordId) ?? []
}

// ---------- judging posts ----------

// The text rules look at: the post, its link card, image descriptions and hashtags
const textCache = new Map<string, string>()
export function searchText(uri: string, recordJson: string | null): string {
  const hit = textCache.get(uri)
  if (hit !== undefined) return hit
  if (textCache.size > 100_000) textCache.clear()
  let r: any = {}
  try {
    r = JSON.parse(recordJson ?? '{}')
  } catch {}
  const ext = r.embed?.external ?? r.embed?.media?.external
  const images = r.embed?.images ?? r.embed?.media?.images ?? []
  const tags = [
    ...(r.tags ?? []),
    ...(r.facets ?? []).flatMap((f: any) => (f.features ?? []).filter((x: any) => x.tag).map((x: any) => x.tag)),
  ]
  const text = [r.text, ext?.title, ext?.description, ...images.map((i: any) => i.alt), ...tags.map((t: string) => `#${t}`)]
    .filter(Boolean)
    .join('\n')
  textCache.set(uri, text)
  return text
}

// groupId is set when a group's rules decided the result, so the page can offer the right button
export type Verdict = { id: number; kept: boolean; reason: string; groupId?: number; groupName?: string }

function judgeWords(r: Rules, text: string): { kept: boolean; reason: string } {
  for (let i = 0; i < r.excludeRe.length; i++) {
    if (r.excludeRe[i].test(text)) return { kept: false, reason: `Mentions “${r.exclude[i]}”` }
  }
  if (!r.mustRe) return { kept: true, reason: 'No rules set' }
  const m = text.match(r.mustRe)
  if (m) return { kept: true, reason: `Mentions “${m[0].trim()}”` }
  return { kept: false, reason: 'No context words' }
}

// Whether a post that matched keyword `id` should show. Viewing a group applies that group's rules.
// Otherwise a keyword in groups needs to pass at least one of them, since each group gives it a meaning.
// An account you've marked for the keyword or group decides it, whatever the words say.
export function judge(id: number, authorDid: string, text: string, viewingGroup: number | null = null): Verdict {
  const r = rulesFor(id)
  if (r.blocked.has(authorDid)) return { id, kept: false, reason: 'You hid this account for this keyword' }
  if (r.trusted.has(authorDid)) return { id, kept: true, reason: 'You always show this account for this keyword' }

  const groups = viewingGroup ? [viewingGroup] : groupsOf(id)
  const own = judgeWords(r, text)
  if (!groups.length) return { id, ...own }

  let firstHidden: Verdict | null = null
  let passedGroup: Verdict | null = null
  for (const g of groups) {
    const gr = groupRulesFor(g)
    const tag = { groupId: g, groupName: gr.name }
    if (gr.trusted.has(authorDid)) return { id, kept: true, reason: `You always show this account in ${gr.name}`, ...tag }
    if (gr.blocked.has(authorDid)) {
      firstHidden ??= { id, kept: false, reason: `You hid this account in ${gr.name}`, ...tag }
      continue
    }
    const words = judgeWords(gr, text)
    if (words.kept) passedGroup ??= { id, kept: true, reason: gr.mustRe ? words.reason : own.reason, ...tag }
    else firstHidden ??= { id, kept: false, reason: `${gr.name}: ${words.reason}`, ...tag }
  }
  if (!own.kept) return { id, ...own }
  return passedGroup ?? firstHidden!
}

// Judges a post against each keyword it matched. kept = matched keywords it passed.
export function judgeRow(row: { uri: string; author_did: string; record: string | null; kws: string | null }, viewingGroup: number | null = null) {
  const text = searchText(row.uri, row.record)
  const verdicts = (row.kws ?? '').split(',').filter(Boolean).map((id) => judge(Number(id), row.author_did, text, viewingGroup))
  return { verdicts, kept: verdicts.filter((v) => v.kept).map((v) => v.id) }
}

// Accounts whose posts keep passing a group's rules, as "always show" suggestions
export function suggestedForGroup(groupId: number, sinceMs: number) {
  const rows = db
    .prepare(
      `SELECT p.uri, p.author_did, p.record, GROUP_CONCAT(h.keyword_id) kws
       FROM keyword_hits h JOIN posts p ON p.uri = h.uri JOIN keyword_group_members m ON m.keyword_id = h.keyword_id
       WHERE m.group_id = ? AND h.sort_at > ? GROUP BY p.uri`,
    )
    .all(groupId, sinceMs) as { uri: string; author_did: string; record: string | null; kws: string | null }[]
  const r = groupRulesFor(groupId)
  const tally = new Map<string, { kept: number; hidden: number }>()
  for (const row of rows) {
    if (r.trusted.has(row.author_did) || r.blocked.has(row.author_did)) continue
    const t = tally.get(row.author_did) ?? { kept: 0, hidden: 0 }
    judgeRow(row, groupId).kept.length ? t.kept++ : t.hidden++
    tally.set(row.author_did, t)
  }
  return [...tally]
    .filter(([, t]) => t.kept >= 3 && t.kept >= 2 * t.hidden)
    .sort((a, b) => b[1].kept - a[1].kept)
    .slice(0, 8)
    .map(([did, t]) => ({ did, ...t }))
}

// Accounts whose posts keep passing the rules for this keyword, as "always show" suggestions
export function suggestedAuthors(id: number, sinceMs: number) {
  const rows = db
    .prepare(
      `SELECT p.uri, p.author_did, p.record FROM keyword_hits h JOIN posts p ON p.uri = h.uri
       WHERE h.keyword_id = ? AND h.sort_at > ?`,
    )
    .all(id, sinceMs) as { uri: string; author_did: string; record: string | null }[]
  const r = rulesFor(id)
  const tally = new Map<string, { kept: number; hidden: number }>()
  for (const row of rows) {
    if (r.trusted.has(row.author_did) || r.blocked.has(row.author_did)) continue
    const v = judge(id, row.author_did, searchText(row.uri, row.record))
    const t = tally.get(row.author_did) ?? { kept: 0, hidden: 0 }
    v.kept ? t.kept++ : t.hidden++
    tally.set(row.author_did, t)
  }
  return [...tally]
    .filter(([, t]) => t.kept >= 3 && t.kept >= 2 * t.hidden)
    .sort((a, b) => b[1].kept - a[1].kept)
    .slice(0, 8)
    .map(([did, t]) => ({ did, ...t }))
}
