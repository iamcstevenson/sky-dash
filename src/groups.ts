// Keyword groups: a named set of keywords with its own context rules on top of each keyword's.
// A keyword can be in several groups, and groups only organize keywords, so removing a group or
// taking a keyword out of one never deletes the keyword or its history.
import { db } from './db.ts'
import { cleanTerms, clearGroupRules, forgetRuleCache, groupRulesFor } from './rules.ts'
import { addKeyword, listKeywords, removeKeyword } from './keywords.ts'

export type Group = { id: number; name: string; position: number | null; keywordIds: number[]; needsContextIds: number[] }

export function listGroups(): Group[] {
  const groups = db.prepare('SELECT id, name, position FROM keyword_groups ORDER BY COALESCE(position, 1e9), id').all() as Omit<Group, 'keywordIds'>[]
  const members = db
    .prepare('SELECT group_id, keyword_id, needs_context FROM keyword_group_members ORDER BY COALESCE(position, 1e9), keyword_id')
    .all() as { group_id: number; keyword_id: number; needs_context: number }[]
  return groups.map((g) => {
    const mine = members.filter((m) => m.group_id === g.id)
    return { ...g, keywordIds: mine.map((m) => m.keyword_id), needsContextIds: mine.filter((m) => m.needs_context).map((m) => m.keyword_id) }
  })
}

export function memberIds(groupId: number): number[] {
  return (db.prepare('SELECT keyword_id FROM keyword_group_members WHERE group_id = ? ORDER BY COALESCE(position, 1e9), keyword_id').all(groupId) as { keyword_id: number }[]).map(
    (r) => r.keyword_id,
  )
}

function cleanName(name: unknown): string {
  const n = String(name ?? '').trim().slice(0, 60)
  if (!n) throw Object.assign(new Error('Give the group a name'), { status: 400 })
  return n
}

export function createGroup(name: unknown, keywordIds: number[] = []) {
  const res = db.prepare('INSERT INTO keyword_groups (name, created_at) VALUES (?, ?)').run(cleanName(name), Date.now())
  const id = Number(res.lastInsertRowid)
  setMembers(id, keywordIds)
  return { id }
}

export function removeGroup(id: number) {
  db.prepare('DELETE FROM keyword_group_members WHERE group_id = ?').run(id)
  db.prepare('DELETE FROM group_authors WHERE group_id = ?').run(id)
  db.prepare('DELETE FROM keyword_groups WHERE id = ?').run(id)
  clearGroupRules()
}

// Replaces a group's keywords, in the order given. Keywords already in the group keep their needs-context mark
// unless `needsContext` says otherwise.
export function setMembers(id: number, keywordIds: number[], needsContext?: Set<number>) {
  const before = new Map(
    (db.prepare('SELECT keyword_id, needs_context FROM keyword_group_members WHERE group_id = ?').all(id) as {
      keyword_id: number
      needs_context: number
    }[]).map((r) => [r.keyword_id, r.needs_context]),
  )
  db.prepare('DELETE FROM keyword_group_members WHERE group_id = ?').run(id)
  const add = db.prepare('INSERT OR IGNORE INTO keyword_group_members (group_id, keyword_id, position, needs_context) VALUES (?, ?, ?, ?)')
  keywordIds.forEach((k, i) => add.run(id, k, i, needsContext ? (needsContext.has(k) ? 1 : 0) : (before.get(k) ?? 0)))
  clearGroupRules()
}

export type Topic = { query: string; needsContext: boolean }

// Sets a group's topic words from the group editor. Each one is a keyword: an existing keyword with the same
// text is reused, otherwise one is created. A keyword this editor created is deleted once it's in no group,
// since it was only ever part of the group; other keywords are just taken out. Returns new keyword ids to search.
export function setTopics(id: number, topics: unknown): number[] {
  if (!Array.isArray(topics)) return []
  const byQuery = new Map(listKeywords().map((k) => [k.query.toLowerCase(), k.id]))
  const ids: number[] = []
  const vague = new Set<number>()
  const created: number[] = []
  for (const t of topics as Topic[]) {
    const query = String(t?.query ?? '').trim().slice(0, 200)
    if (!query) continue
    let kid = byQuery.get(query.toLowerCase())
    if (kid === undefined) {
      kid = addKeyword(query).id
      // The group says what its words mean, so skip the ready-made rules addKeyword fills in ("UK" = Kentucky)
      db.prepare("UPDATE keywords SET group_made = 1, must_terms = '[]', exclude_terms = '[]' WHERE id = ?").run(kid)
      forgetRuleCache(kid)
      byQuery.set(query.toLowerCase(), kid)
      created.push(kid)
    }
    if (ids.includes(kid)) continue
    ids.push(kid)
    if (t.needsContext) vague.add(kid)
  }
  const dropped = memberIds(id).filter((k) => !ids.includes(k))
  setMembers(id, ids, vague)
  for (const k of dropped) {
    const row = db.prepare('SELECT group_made FROM keywords WHERE id = ?').get(k) as { group_made: number } | undefined
    const inGroups = (db.prepare('SELECT COUNT(*) n FROM keyword_group_members WHERE keyword_id = ?').get(k) as { n: number }).n
    if (row?.group_made && !inGroups) removeKeyword(k)
  }
  return created
}

export function updateGroup(id: number, b: { name?: unknown; must?: unknown; exclude?: unknown; keywordIds?: unknown; topics?: unknown }): number[] {
  if (b.name !== undefined) db.prepare('UPDATE keyword_groups SET name = ? WHERE id = ?').run(cleanName(b.name), id)
  if (b.must !== undefined || b.exclude !== undefined) {
    db.prepare('UPDATE keyword_groups SET must_terms = ?, exclude_terms = ? WHERE id = ?').run(
      JSON.stringify(cleanTerms(b.must)),
      JSON.stringify(cleanTerms(b.exclude)),
      id,
    )
  }
  let created: number[] = []
  if (Array.isArray(b.topics)) created = setTopics(id, b.topics)
  else if (Array.isArray(b.keywordIds)) setMembers(id, b.keywordIds.map(Number))
  clearGroupRules()
  return created
}

export function setGroupAuthor(id: number, did: string, verdict: 'trusted' | 'blocked' | null) {
  if (verdict) {
    db.prepare(
      `INSERT INTO group_authors (group_id, author_did, verdict) VALUES (?, ?, ?)
       ON CONFLICT(group_id, author_did) DO UPDATE SET verdict = excluded.verdict`,
    ).run(id, did, verdict)
  } else {
    db.prepare('DELETE FROM group_authors WHERE group_id = ? AND author_did = ?').run(id, did)
  }
  clearGroupRules()
}

// Which groups one keyword belongs to, from its own settings panel
export function setKeywordGroups(keywordId: number, groupIds: number[]) {
  const current = (db.prepare('SELECT group_id FROM keyword_group_members WHERE keyword_id = ?').all(keywordId) as { group_id: number }[]).map(
    (r) => r.group_id,
  )
  for (const g of current) {
    if (!groupIds.includes(g)) db.prepare('DELETE FROM keyword_group_members WHERE group_id = ? AND keyword_id = ?').run(g, keywordId)
  }
  for (const g of groupIds) {
    if (!current.includes(g)) db.prepare('INSERT OR IGNORE INTO keyword_group_members (group_id, keyword_id) VALUES (?, ?)').run(g, keywordId)
  }
  clearGroupRules()
}

// A drag: add to `to` (optionally at a position among its ids), and take it out of `from` for a move
export function moveKeyword(b: { keywordId: unknown; from?: unknown; to?: unknown; order?: unknown }) {
  const keywordId = Number(b.keywordId)
  const from = Number(b.from) || null
  const to = Number(b.to) || null
  if (from && from !== to) db.prepare('DELETE FROM keyword_group_members WHERE group_id = ? AND keyword_id = ?').run(from, keywordId)
  if (to) {
    db.prepare('INSERT OR IGNORE INTO keyword_group_members (group_id, keyword_id) VALUES (?, ?)').run(to, keywordId)
    if (Array.isArray(b.order)) {
      const set = db.prepare('UPDATE keyword_group_members SET position = ? WHERE group_id = ? AND keyword_id = ?')
      b.order.forEach((k, i) => set.run(i, to, Number(k)))
    }
  } else if (Array.isArray(b.order)) {
    orderKeywords(b.order.map(Number))
  }
  clearGroupRules()
}

export function orderKeywords(ids: number[]) {
  const set = db.prepare('UPDATE keywords SET position = ? WHERE id = ?')
  ids.forEach((id, i) => set.run(i, id))
}

export function orderGroups(ids: number[]) {
  const set = db.prepare('UPDATE keyword_groups SET position = ? WHERE id = ?')
  ids.forEach((id, i) => set.run(i, id))
}

export function groupHasRules(id: number) {
  const r = groupRulesFor(id)
  return r.must.length + r.exclude.length + r.trusted.size + r.blocked.size > 0
}
