// Keyword groups: a named, saved set of keywords (issue #12). A group has no rules of its own; it lets you
// see its keywords' posts together, pause or 📡 them together, and filter Discover and Trending by them.
// A keyword can be in several groups. Removing a group, or taking a keyword out of one, keeps the keyword,
// except when a keyword typed into a group's list is removed from that list and is in no other group.
import { db } from './db.ts'
import { addKeyword, listKeywords, normalizeQuery, removeKeyword } from './keywords.ts'

export type Group = { id: number; name: string; position: number | null; keywordIds: number[] }

export function listGroups(): Group[] {
  const groups = db.prepare('SELECT id, name, position FROM keyword_groups ORDER BY COALESCE(position, 1e9), id').all() as Omit<Group, 'keywordIds'>[]
  const members = db
    .prepare('SELECT group_id, keyword_id FROM keyword_group_members ORDER BY COALESCE(position, 1e9), keyword_id')
    .all() as { group_id: number; keyword_id: number }[]
  return groups.map((g) => ({ ...g, keywordIds: members.filter((m) => m.group_id === g.id).map((m) => m.keyword_id) }))
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
  const n = cleanName(name)
  if (listGroups().some((g) => g.name.toLowerCase() === n.toLowerCase())) {
    throw Object.assign(new Error(`You already have a group called “${n}”`), { status: 409 })
  }
  const res = db.prepare('INSERT INTO keyword_groups (name, created_at) VALUES (?, ?)').run(n, Date.now())
  const id = Number(res.lastInsertRowid)
  setMembers(id, keywordIds)
  return { id }
}

// A keyword left in no group is an ordinary keyword from then on, so editing a group's list later never deletes it
export function keepLooseKeywords() {
  db.exec('UPDATE keywords SET group_made = 0 WHERE group_made = 1 AND id NOT IN (SELECT keyword_id FROM keyword_group_members)')
}

export function removeGroup(id: number) {
  db.prepare('DELETE FROM keyword_group_members WHERE group_id = ?').run(id)
  keepLooseKeywords()
  db.prepare('DELETE FROM group_authors WHERE group_id = ?').run(id)
  db.prepare('DELETE FROM keyword_groups WHERE id = ?').run(id)
}

// Replaces a group's keywords, in the order given
export function setMembers(id: number, keywordIds: number[]) {
  db.prepare('DELETE FROM keyword_group_members WHERE group_id = ?').run(id)
  const add = db.prepare('INSERT OR IGNORE INTO keyword_group_members (group_id, keyword_id, position) VALUES (?, ?, ?)')
  keywordIds.forEach((k, i) => add.run(id, k, i))
}

// Adds keywords to a group, after the ones it has
export function addMembers(id: number, keywordIds: number[]) {
  const current = memberIds(id)
  setMembers(id, [...current, ...keywordIds.filter((k) => !current.includes(k))])
}

// Finds or creates a keyword for each search text. Multi-word plain text is quoted first, so
// `Big Blue Nation` and `"Big Blue Nation"` are the same keyword. `fromGroup` marks new ones as typed into a
// group's list. Returns every keyword id in order, and which ones are new and need searching.
export function keywordsFor(queries: unknown[], fromGroup = false): { ids: number[]; created: number[] } {
  const byQuery = new Map(listKeywords().map((k) => [k.query.toLowerCase(), k.id]))
  const ids: number[] = []
  const created: number[] = []
  for (const raw of queries) {
    const query = normalizeQuery(String(raw ?? '')).slice(0, 200)
    if (!query) continue
    let kid = byQuery.get(query.toLowerCase())
    if (kid === undefined) {
      kid = addKeyword(query).id
      if (fromGroup) db.prepare('UPDATE keywords SET group_made = 1 WHERE id = ?').run(kid)
      byQuery.set(query.toLowerCase(), kid)
      created.push(kid)
    }
    if (!ids.includes(kid)) ids.push(kid)
  }
  return { ids, created }
}

// Sets a group's keywords from its list in ⚙. A keyword that was typed into a group's list and is now in
// no group is deleted, since it only existed for the group; any other keyword just leaves the group.
function setGroupQueries(id: number, queries: unknown[]): number[] {
  const { ids, created } = keywordsFor(queries, true)
  const dropped = memberIds(id).filter((k) => !ids.includes(k))
  setMembers(id, ids)
  for (const k of dropped) {
    const row = db.prepare('SELECT group_made FROM keywords WHERE id = ?').get(k) as { group_made: number } | undefined
    const inGroups = (db.prepare('SELECT COUNT(*) n FROM keyword_group_members WHERE keyword_id = ?').get(k) as { n: number }).n
    if (row?.group_made && !inGroups) removeKeyword(k)
  }
  return created
}

// queries: the page's keyword list. topics (Hub build 5, topic words) are read as queries; their vague
// marks no longer mean anything. keywordIds (older Hub) sets members directly. must/exclude are ignored:
// groups have no rules. Returns new keyword ids to search.
export function updateGroup(id: number, b: { name?: unknown; keywordIds?: unknown; queries?: unknown; topics?: unknown }): number[] {
  if (b.name !== undefined) {
    const n = cleanName(b.name)
    if (listGroups().some((g) => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) {
      throw Object.assign(new Error(`You already have a group called “${n}”`), { status: 409 })
    }
    db.prepare('UPDATE keyword_groups SET name = ? WHERE id = ?').run(n, id)
  }
  if (Array.isArray(b.queries)) return setGroupQueries(id, b.queries)
  if (Array.isArray(b.topics)) return setGroupQueries(id, b.topics.map((t: any) => t?.query))
  if (Array.isArray(b.keywordIds)) {
    setMembers(id, b.keywordIds.map(Number))
    keepLooseKeywords()
  }
  return []
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
    if (!current.includes(g)) addMembers(g, [keywordId])
  }
  keepLooseKeywords()
}

export function removeFromGroup(groupId: number, keywordId: number) {
  db.prepare('DELETE FROM keyword_group_members WHERE group_id = ? AND keyword_id = ?').run(groupId, keywordId)
  keepLooseKeywords()
}

export function orderKeywords(ids: number[]) {
  const set = db.prepare('UPDATE keywords SET position = ? WHERE id = ?')
  ids.forEach((id, i) => set.run(i, id))
}

export function orderGroups(ids: number[]) {
  const set = db.prepare('UPDATE keyword_groups SET position = ? WHERE id = ?')
  ids.forEach((id, i) => set.run(i, id))
}
