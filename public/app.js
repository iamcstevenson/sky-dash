'use strict'

const $ = (sel, root = document) => root.querySelector(sel)
const LETTERS = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' }

const state = {
  accounts: [], // signed-in accounts: { slot, handle, did }
  actAs: Number(safeGet('actAs')) || 1,
  view: ['keywords', 'videos', 'follows', 'lists', 'trending', 'discover', 'notifications'].includes(safeGet('view')) ? safeGet('view') : 'following',
  author: null, // { did, handle } when the Following tab shows one person's posts
  englishOnly: safeGet('englishOnly') !== '0', // on unless turned off
  kw: { list: [], groups: [], group: null, selected: new Set(), hideFollowed: false, videosOnly: false, showHidden: false, hours: 48, polling: false },
  type: 'all',
  who: 'all',
  cursor: null,
  newest: 0,
  loading: false,
  done: false,
  posts: new Map(), // uri -> { post, viewer } for every rendered card
}

function safeGet(k) { try { return localStorage.getItem(k) } catch { return null } }
function safeSet(k, v) { try { localStorage.setItem(k, v) } catch {} }

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

// An open dialog is drawn above the rest of the page, so pop-ups have to live inside it to be seen
function topLayerHost() {
  return [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body
}

// action: optional { label, run } shown as a button (e.g. Undo); the toast then stays up longer
function toast(msg, action) {
  const t = $('#toast')
  if (t.parentElement !== topLayerHost()) topLayerHost().append(t)
  t.textContent = msg
  if (action) {
    const b = document.createElement('button')
    b.textContent = action.label
    b.onclick = () => {
      t.hidden = true
      action.run()
    }
    t.append(b)
  }
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (t.hidden = true), action ? 10_000 : 3500)
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function acctName(slot) {
  const a = state.accounts.find((x) => x.slot === Number(slot))
  return a ? `@${a.handle}` : `account ${LETTERS[slot] ?? slot}`
}

// "Followed by every account": "Both" with two accounts, "All 3" with three
function allLabel() {
  return state.accounts.length === 2 ? 'Both' : `All ${state.accounts.length}`
}

// A badge that says you follow someone from that account; click to unfollow (with Undo) or follow again.
// label: optional word after the badge ("following"), as in the Discover panel.
function followPill(did, slot, on = true, label = '') {
  const title = on ? `You follow them from ${acctName(slot)}. Click to unfollow.` : `Click to follow from ${acctName(slot)}`
  return `<button type="button" class="follow-pill ${on ? 'on' : ''} ${label ? 'pc-tag' : ''}" data-follow-pill data-did="${esc(did)}" data-slot="${slot}" data-label="${esc(label)}" title="${esc(title)}" aria-pressed="${on}">${badge(slot, title)}${label ? ` ${on ? esc(label) : 'follow'}` : ''}</button>`
}

function badge(slot, title) {
  return `<span class="acct-badge acct-${slot}" title="${esc(title ?? acctName(slot))}">${LETTERS[slot] ?? slot}</span>`
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function postUrl(post) {
  const rkey = post.uri.split('/').pop()
  return `https://bsky.app/profile/${post.author.handle || post.author.did}/post/${rkey}`
}

// Rich text: facets index into the UTF-8 bytes of the text, not JS string positions
const enc = new TextEncoder()
const dec = new TextDecoder()
function renderText(text, facets) {
  if (!text) return ''
  if (!facets?.length) return esc(text)
  const bytes = enc.encode(text)
  let out = ''
  let pos = 0
  for (const f of [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart)) {
    const { byteStart, byteEnd } = f.index
    if (byteStart < pos || byteEnd > bytes.length) continue
    out += esc(dec.decode(bytes.slice(pos, byteStart)))
    const inner = esc(dec.decode(bytes.slice(byteStart, byteEnd)))
    const feat = f.features?.[0] ?? {}
    let href = null
    if (feat.$type === 'app.bsky.richtext.facet#link') href = feat.uri
    else if (feat.$type === 'app.bsky.richtext.facet#mention') href = `https://bsky.app/profile/${feat.did}`
    else if (feat.$type === 'app.bsky.richtext.facet#tag') href = `https://bsky.app/hashtag/${encodeURIComponent(feat.tag)}`
    const profile = feat.$type === 'app.bsky.richtext.facet#mention' ? ` data-profile="${esc(feat.did)}"` : ''
    out += href && /^https?:/i.test(href) ? `<a href="${esc(href)}"${profile} target="_blank" rel="noopener">${inner}</a>` : inner
    pos = byteEnd
  }
  return out + esc(dec.decode(bytes.slice(pos)))
}

const ADULT = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore'])
function isSensitive(labels) {
  return (labels ?? []).some((l) => ADULT.has(l.val))
}

function renderImages(images, blur) {
  if (!images?.length) return ''
  return `<div class="images ${images.length === 1 ? 'one' : ''}">${images
    .map((i) => `<a href="${esc(i.fullsize)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(i.thumb)}" alt="${esc(i.alt)}" title="${esc(i.alt)}" class="${blur ? 'blurred' : ''}"></a>`)
    .join('')}</div>`
}

// Links to video sites play in the post, like Bluesky videos. Returns the site's embeddable player
// (loaded only when you press play) and the video's shape, or null for any other link.
function videoLinkPlayer(uri) {
  let u
  try { u = new URL(uri) } catch { return null }
  const host = u.hostname.replace(/^(www|m)\./, '')
  const path = u.pathname.split('/').filter(Boolean)
  const id = (x) => (x && /^[\w-]+$/.test(x) ? x : null)
  const seconds = (t) => {
    if (!t) return 0
    if (/^\d+$/.test(t)) return Number(t)
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
    return m ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : 0
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    const v = host === 'youtu.be' ? id(path[0])
      : ['shorts', 'live', 'embed'].includes(path[0]) ? id(path[1])
      : path[0] === 'watch' ? id(u.searchParams.get('v')) : null
    if (!v) return null
    const start = seconds(u.searchParams.get('t') ?? u.searchParams.get('start'))
    return { src: `https://www.youtube-nocookie.com/embed/${v}?autoplay=1&playsinline=1${start ? `&start=${start}` : ''}`, ar: path[0] === 'shorts' ? '9 / 16' : '16 / 9' }
  }
  if (host === 'vimeo.com' && /^\d+$/.test(path[0] ?? '')) return { src: `https://player.vimeo.com/video/${path[0]}?autoplay=1`, ar: '16 / 9' }
  if (host === 'dailymotion.com' && path[0] === 'video' && id(path[1])) return { src: `https://www.dailymotion.com/embed/video/${path[1]}?autoplay=1`, ar: '16 / 9' }
  if (host === 'dai.ly' && id(path[0])) return { src: `https://www.dailymotion.com/embed/video/${path[0]}?autoplay=1`, ar: '16 / 9' }
  if (host === 'streamable.com' && id(path[0]) && path.length === 1) return { src: `https://streamable.com/e/${path[0]}?autoplay=1`, ar: '16 / 9' }
  const clip = host === 'clips.twitch.tv' ? id(path[0]) : host === 'twitch.tv' && path[1] === 'clip' ? id(path[2]) : null
  if (clip) return { src: `https://clips.twitch.tv/embed?clip=${clip}&parent=${location.hostname}&autoplay=true`, ar: '16 / 9' }
  if (host === 'tiktok.com' && path[1] === 'video' && /^\d+$/.test(path[2] ?? '')) return { src: `https://www.tiktok.com/player/v1/${path[2]}?autoplay=1`, ar: '9 / 16' }
  return null
}

function renderMedia(embed, blur, post, small = false) {
  if (!embed) return ''
  switch (embed.$type) {
    case 'app.bsky.embed.images#view':
      return renderImages(embed.images, blur)
    case 'app.bsky.embed.external#view': {
      const e = embed.external
      let host = ''
      try { host = new URL(e.uri).hostname } catch {}
      const player = !small && videoLinkPlayer(e.uri)
      if (player) {
        // Full-width preview that plays here; the caption still links to the site
        return `<div class="video vlink ${player.ar === '9 / 16' ? 'portrait' : ''}" data-embed="${esc(player.src)}" data-alt="${esc(e.title || 'Video')}" style="--ar: ${player.ar}">
          <div class="vlink-media">${e.thumb ? `<img loading="lazy" src="${esc(e.thumb)}" alt="${esc(e.title ?? '')}" class="${blur ? 'blurred' : ''}">` : '<div class="video-blank"></div>'}
          <button type="button" class="video-play" aria-label="Play video">▶</button></div>
          <a class="vlink-cap" href="${esc(e.uri)}" target="_blank" rel="noopener" title="Open on ${esc(host.replace(/^www\./, ''))}"><b>${esc(e.title || e.uri)}</b><small>${esc(host.replace(/^www\./, ''))} ↗</small></a></div>`
      }
      return `<a class="ext" href="${esc(e.uri)}" target="_blank" rel="noopener">
        ${e.thumb ? `<img loading="lazy" src="${esc(e.thumb)}" alt="">` : ''}
        <div><b>${esc(e.title || e.uri)}</b><small>${esc(e.description)}</small><small>${esc(host)}</small></div></a>`
    }
    case 'app.bsky.embed.video#view': {
      // Plays here (see "video player"); the time link on the post still opens it on bsky.app
      const ar = embed.aspectRatio?.width && embed.aspectRatio?.height ? `${embed.aspectRatio.width} / ${embed.aspectRatio.height}` : '16 / 9'
      return `<div class="video" data-video="${esc(embed.playlist)}" data-alt="${esc(embed.alt ?? '')}" style="--ar: ${ar}">
        ${embed.thumbnail ? `<img loading="lazy" src="${esc(embed.thumbnail)}" alt="${esc(embed.alt ?? '')}" class="${blur ? 'blurred' : ''}">` : '<div class="video-blank"></div>'}
        <button type="button" class="video-play" aria-label="Play video">▶</button>
        <button type="button" class="video-expand" aria-label="Play in a large viewer" title="Large viewer">⤢</button></div>`
    }
    default:
      return ''
  }
}

function renderQuote(rec) {
  if (!rec) return ''
  if (rec.$type === 'app.bsky.embed.record#viewRecord') {
    const media = (rec.embeds ?? []).map((e) => renderMedia(e, isSensitive(rec.labels), { uri: rec.uri, author: rec.author })).join('')
    return `<div class="quote" data-open-thread="${esc(rec.uri)}">
      <div class="meta"><img class="avatar" data-profile="${esc(rec.author.did)}" style="width:18px;height:18px" src="${esc(rec.author.avatar ?? '')}" alt="">
        <span class="name" data-profile="${esc(rec.author.did)}">${esc(rec.author.displayName || rec.author.handle)}</span>
        <span class="handle" data-profile="${esc(rec.author.did)}">@${esc(rec.author.handle)}</span><span class="time">· ${ago(rec.indexedAt)}</span></div>
      <div class="text">${renderText(rec.value?.text, rec.value?.facets)}</div>${media}</div>`
  }
  if (rec.$type === 'app.bsky.embed.record#viewNotFound') return '<div class="quote missing">Quoted post was deleted</div>'
  if (rec.$type === 'app.bsky.embed.record#viewBlocked') return '<div class="quote missing">Quoted post is from a blocked account</div>'
  if (rec.$type === 'app.bsky.embed.record#viewDetached') return '<div class="quote missing">The author removed this quote</div>'
  if (rec.$type === 'app.bsky.feed.defs#generatorView') return `<div class="quote">Feed: <b>${esc(rec.displayName)}</b></div>`
  if (rec.$type === 'app.bsky.graph.defs#listView') return `<div class="quote">List: <b>${esc(rec.name)}</b></div>`
  return ''
}

// small: reply context and previews, where a video link stays a compact link card
function renderEmbed(post, small = false) {
  const embed = post.embed
  if (!embed) return ''
  const blur = isSensitive(post.labels)
  if (embed.$type === 'app.bsky.embed.record#view') return renderQuote(embed.record)
  if (embed.$type === 'app.bsky.embed.recordWithMedia#view') return renderMedia(embed.media, blur, post, small) + renderQuote(embed.record?.record)
  return renderMedia(embed, blur, post, small)
}

// One post's header, text and embeds. `small` is used for reply context above a post.
function renderPost(post, { small = false, followedBy = [] } = {}) {
  if (!post || post.notFound) return `<div class="missing">Post not available (deleted or hidden)</div>`
  const a = post.author
  return `<div class="post ${small ? 'small' : ''}">
    <button class="avatar-btn" data-profile="${esc(a.did)}" aria-label="Profile of ${esc(a.displayName || a.handle)}"><img class="avatar" loading="lazy" src="${esc(a.avatar ?? '')}" alt=""></button>
    <div class="post-body">
      <div class="meta">
        <span class="name" data-profile="${esc(a.did)}">${esc(a.displayName || a.handle)}</span>
        <span class="handle" data-profile="${esc(a.did)}">@${esc(a.handle)}</span>
        ${followedBy.length ? `<span class="badges">${followedBy.map((s) => followPill(a.did, s)).join('')}</span>` : ''}
        <a class="time" href="${esc(postUrl(post))}" target="_blank" rel="noopener" title="${esc(new Date(post.indexedAt).toLocaleString())}">· ${ago(post.record?.createdAt ?? post.indexedAt)}</a>
      </div>
      <div class="text">${renderText(post.record?.text, post.record?.facets)}</div>
      ${renderEmbed(post, small)}
    </div></div>`
}

function whoDid(viewer, key) {
  return Object.entries(viewer ?? {}).filter(([, v]) => v?.[key]).map(([slot]) => Number(slot))
}

// Bluesky's read servers take a moment to reflect a like or repost, so asking right after one often
// still says "not liked". What you just did is remembered here and wins until they've caught up.
const LOCAL_ACTION_MS = 2 * 60_000
const localActions = new Map() // "slot|uri|kind" -> { value: record uri or null if removed, at }
const COUNT_FIELD = { like: 'likeCount', repost: 'repostCount' }

function applyLocalActions(post, viewer) {
  for (const kind of ['like', 'repost']) {
    for (const { slot } of state.accounts) {
      const key = `${slot}|${post.uri}|${kind}`
      const rec = localActions.get(key)
      if (!rec) continue
      if (Date.now() - rec.at > LOCAL_ACTION_MS) {
        localActions.delete(key)
        continue
      }
      const known = viewer[slot]
      const have = known?.[kind]
      if (!!rec.value === !!have) {
        if (rec.value) viewer[slot] = { ...known, [kind]: rec.value }
        continue
      }
      viewer[slot] = { ...known, [kind]: rec.value ?? undefined }
      // Only adjust the count when this view knew this account's state; otherwise it can't tell
      if (known) post[COUNT_FIELD[kind]] = Math.max(0, (post[COUNT_FIELD[kind]] ?? 0) + (rec.value ? 1 : -1))
    }
  }
}

function renderActions(post, viewer) {
  applyLocalActions(post, viewer)
  const likedBy = whoDid(viewer, 'like')
  const repostedBy = whoDid(viewer, 'repost')
  const mine = viewer?.[state.actAs] ?? {}
  const dots = (slots) => (slots.length ? `<span class="who">${slots.map((s) => badge(s)).join('')}</span>` : '')
  return `<div class="actions" data-uri="${esc(post.uri)}">
    <button class="act" data-act="reply" title="Reply">💬 ${post.replyCount ?? 0}</button>
    <button class="act ${mine.repost ? 'reposted' : ''}" data-act="repost" title="Repost as ${esc(acctName(state.actAs))}">🔁 ${post.repostCount ?? 0}${dots(repostedBy)}</button>
    <button class="act" data-act="quote" title="Quote">❝ ${post.quoteCount ?? 0}</button>
    <button class="act ${mine.like ? 'liked' : ''}" data-act="like" title="Like as ${esc(acctName(state.actAs))}">${mine.like ? '♥' : '♡'} ${post.likeCount ?? 0}${dots(likedBy)}</button>
    <button class="act" data-act="share" title="Share" aria-label="Share"><svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4.5 21 12l-8 7.5V15c-4.5 0-7.5 1.5-10 5 .5-5.500 3.500-10 10-10.500z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>
    <button class="act right" data-act="thread" title="Show whole thread">Thread</button>
  </div>`
}

function renderCard(item) {
  state.posts.set(item.post.uri, { post: item.post, viewer: item.viewer, followedBy: item.followedBy ?? [] })
  let ctx = ''
  if (item.root) {
    ctx += `<div class="ctx">${renderPost(item.root, { small: true })}</div>`
    ctx += `<div class="ctx-gap"><button data-open-thread="${esc(item.post.uri)}">⋯ view full thread</button></div>`
  }
  if (item.parent) ctx += `<div class="ctx">${renderPost(item.parent, { small: true })}</div>`
  const tags = item.verdicts?.length ? renderVerdicts(item) : item.keywords?.length
    ? `<div class="kw-tags">${item.keywords.map((id) => state.kw.list.find((k) => k.id === id)).filter(Boolean)
        .map((k) => `<span class="kw-tag">${esc(k.query)}</span>`).join('')}</div>`
    : ''
  return `<article class="card" data-card="${esc(item.post.uri)}">
    ${tags}${ctx}${renderPost(item.post, { followedBy: item.followedBy })}
    <div class="acts">${renderActions(item.post, item.viewer)}</div></article>`
}

// Words and "quoted phrases" from a search query, minus operators like lang:en or -word
function searchTerms(query) {
  const terms = []
  const rest = query.replace(/"([^"]+)"/g, (_, phrase) => (terms.push(phrase), ' '))
  for (const w of rest.split(/\s+/)) {
    if (!w || w.startsWith('-') || w.includes(':') || /^(AND|OR|NOT)$/.test(w)) continue
    terms.push(w.replace(/^#/, ''))
  }
  return terms.filter((t) => t.length > 1)
}

// Wraps keyword matches in <mark> inside the post text (not in links or the reply context)
function highlight(card, ids) {
  highlightTerms(card, ids.flatMap((id) => searchTerms(state.kw.list.find((k) => k.id === id)?.query ?? '')))
}

// Wraps each of `terms` (whole words, any case) in <mark> inside the post text
function highlightTerms(card, terms) {
  if (!terms.length) return
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const textEl = card?.querySelector(':scope > .post .text')
  if (!textEl) return
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    if (!re.test(node.nodeValue)) continue
    re.lastIndex = 0
    const span = document.createElement('span')
    span.innerHTML = esc(node.nodeValue).replace(re, '<mark>$1</mark>')
    node.replaceWith(...span.childNodes)
  }
}

// ---------- feed ----------

const VIEWS = {
  following: {
    feed: '/api/feed',
    count: '/api/feed/new',
    query: () => {
      const q = new URLSearchParams({ type: state.type, who: state.who })
      if (state.author) q.set('author', state.author.did)
      if (state.englishOnly) q.set('lang', 'en')
      return q
    },
    done: () => state.author
      ? `That's everything from @${state.author.handle} in the last 14 days.`
      : `That's everything from the last ${state.feedHours ?? 72} hours.`,
    empty: () => 'No posts yet. If the dashboard just started, the backfill may still be running.',
  },
  keywords: {
    feed: '/api/keywords/feed',
    count: '/api/keywords/new',
    query: () => new URLSearchParams({
      type: state.type,
      ids: [...state.kw.selected].join(','),
      ...(state.kw.group ? { group: state.kw.group } : {}),
      hideFollowed: state.kw.hideFollowed ? '1' : '0',
      ...(state.kw.videosOnly ? { media: 'video' } : {}),
      ...(state.kw.showHidden ? { show: 'filtered' } : {}),
      ...(state.englishOnly ? { lang: 'en' } : {}),
    }),
    done: () => `That's every match from the last ${state.kw.hours} hours.`,
    empty: () => state.kw.list.length
      ? (viewedGroupProblem() ?? (state.kw.polling ? 'Searching…' : state.kw.showHidden ? 'Nothing was hidden by your context rules.' : `No matches in the last ${state.kw.hours} hours.`))
      : 'Add a keyword above to start.',
  },
}
VIEWS.videos = {
  feed: '/api/videos/search',
  count: null,
  query: () => new URLSearchParams({
    q: vd.q, sort: vd.sort, hours: vd.hours, type: state.type,
    ...(vd.links ? { links: '1' } : {}),
    ...(state.englishOnly ? { lang: 'en' } : {}),
  }),
  done: () => `That's every video Bluesky found for “${vd.q}”${vd.hours ? ` in the last ${vdHoursLabel(vd.hours)}` : ''}.`,
  empty: () => vd.q ? `No videos found for “${vd.q}”${vd.hours ? ` in the last ${vdHoursLabel(vd.hours)}` : ''}. Try a longer time or fewer words.` : 'Search above to find videos.',
}
function viewedGroupProblem() {
  const g = state.kw.group && state.kw.groups.find((x) => x.id === state.kw.group)
  return g ? groupProblem(g.keywordIds) : null
}
VIEWS.trending = {
  feed: '/api/trending/posts',
  count: null,
  query: () => new URLSearchParams({ term: tr.topic?.term ?? '', hours: tr.hours, who: tr.who, ...(state.englishOnly ? { lang: 'en' } : {}) }),
  done: () => `That's every post about this from the last ${hoursLabel(tr.hours)}.`,
  empty: () => 'No posts found.',
}
const view = () => VIEWS[state.view]

let loadSeq = 0
async function loadFeed(reset = false) {
  if (!reset && (state.loading || state.done)) return
  // A reset (tab or filter change) supersedes any page still loading; its result is dropped
  const seq = ++loadSeq
  state.loading = true
  const end = $('#feedEnd')
  if (reset) {
    state.cursor = null
    state.done = false
    state.posts.clear()
    $('#feed').innerHTML = ''
    $('#newBanner').hidden = true
  }
  end.textContent = state.view === 'videos' ? 'Searching Bluesky for videos…' : 'Loading…'
  try {
    const v = view()
    if (state.view === 'videos' && !vd.q) {
      state.done = true
      end.textContent = v.empty()
      return
    }
    const q = v.query()
    if (state.cursor) q.set('before', state.cursor)
    const data = await api(`${v.feed}?${q}`)
    if (seq !== loadSeq) return
    if (reset) state.newest = data.items[0]?.sortAt ?? Date.now()
    const feed = $('#feed')
    const before = feed.children.length
    feed.insertAdjacentHTML('beforeend', data.items.map(renderCard).join(''))
    data.items.forEach((item, i) => item.keywords && highlight(feed.children[before + i], item.keywords))
    if (state.view === 'trending' && tr.topic) {
      const terms = topicTerms(tr.topic)
      data.items.forEach((_, i) => highlightTerms(feed.children[before + i], terms))
    }
    state.cursor = data.cursor
    state.done = !data.cursor
    end.textContent = state.done ? (feed.children.length ? v.done() : v.empty()) : ''
    // A page can come back empty while older results remain (e.g. a search with few videos):
    // scrolling won't fire again, so offer to keep looking
    if (!state.done && !data.items.length) {
      end.innerHTML = `${data.scanned ? `Looked through ${data.scanned.toLocaleString()} more posts without a video. ` : ''}<button type="button" class="link-btn" id="feedMore">Keep looking</button>`
      $('#feedMore').onclick = () => loadFeed()
    }
  } catch (err) {
    if (seq === loadSeq) end.textContent = `Couldn't load posts: ${err.message}`
  } finally {
    if (seq === loadSeq) state.loading = false
  }
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && state.cursor) loadFeed()
}, { rootMargin: '800px' }).observe($('#feedEnd'))

async function checkNew() {
  if (!state.newest || document.hidden || !view().count) return
  try {
    const v = view()
    const q = v.query()
    q.set('after', state.newest)
    const { count } = await api(`${v.count}?${q}`)
    if (v !== view()) return
    const b = $('#newBanner')
    b.hidden = count === 0
    b.textContent = `Show ${count} new post${count === 1 ? '' : 's'}`
  } catch {}
}
$('#newBanner').addEventListener('click', () => {
  loadFeed(true)
  window.scrollTo({ top: 0, behavior: 'smooth' })
})

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]')
    if (!btn) return
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn))
    if (!seg.dataset.filter) return // segments with their own handlers (Trending, Videos, …)
    state[seg.dataset.filter] = btn.dataset.value
    loadFeed(true)
  })
})

// ---------- phone layout ----------

// On a phone the post filters fold behind one button
$('#filtersToggle').addEventListener('click', (e) => {
  const open = $('#filters').classList.toggle('open')
  e.target.setAttribute('aria-expanded', String(open))
})

// On a phone the header slides away while scrolling down and comes back when scrolling up
{
  let lastY = window.scrollY
  let queued = false
  window.addEventListener('scroll', () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const y = window.scrollY
      if (Math.abs(y - lastY) < 8) return
      document.body.classList.toggle('scrolled-down', y > lastY && y > 80)
      lastY = y
    })
  }, { passive: true })
}

// ---------- tabs ----------

function showView(name) {
  state.view = name
  safeSet('view', name)
  if (name !== 'following') state.author = null
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  const isKeywords = name === 'keywords'
  const isFollows = name === 'follows'
  const isTrending = name === 'trending'
  const isDiscover = name === 'discover'
  const isNotifications = name === 'notifications'
  const isLists = name === 'lists'
  const isVideos = name === 'videos'
  $('#videoPanel').hidden = !isVideos
  $('#listsView').hidden = !isLists
  $('#notifView').hidden = !isNotifications
  $('#discoverView').hidden = !isDiscover
  $('#kwPanel').hidden = !isKeywords
  $('#followsView').hidden = !isFollows
  $('#trendPanel').hidden = !isTrending
  $('#mutedBox').hidden = !(name === 'following' || isKeywords || isTrending || isLists) || !state.accounts.length
  document.body.classList.toggle('wide', isFollows)
  // Trending shows its own controls; its post list only appears once a topic is picked
  $('#filters').hidden = isFollows || isTrending || isDiscover || isNotifications || isLists
  const showFeed = !isFollows && !isDiscover && !isNotifications && !isLists && !(isTrending && !tr.topic)
  $('#feed').hidden = !showFeed
  $('#feedEnd').hidden = !showFeed
  if (isFollows || isTrending || isDiscover || isNotifications || isLists) $('#newBanner').hidden = true
  $('#hideFollowedWrap').hidden = !isKeywords
  $('#showHiddenWrap').hidden = !isKeywords
  $('#videosOnlyWrap').hidden = !isKeywords
  $('#whoFilter').hidden = isKeywords || isVideos || !!state.author || state.accounts.length < 2
  renderAuthorChip()
  if (isLists) {
    if (ls.current) setLsMode(ls.mode)
    else showLsDetail(false)
    return loadLists()
  }
  if (isFollows) return loadFollows()
  if (isDiscover) return loadDiscover()
  if (isNotifications) return loadNotifications(true)
  if (isTrending) {
    loadTrending()
    if (tr.topic) loadFeed(true)
    return
  }
  if (isKeywords) loadKeywords()
  if (isVideos) {
    renderVideoControls()
    if (!state.kw.list.length) loadKeywords().then(renderVideoControls).catch(() => {})
  }
  loadFeed(true)
}

// Following tab narrowed to one person, opened from the Follows tab
function showAuthor(did, handle) {
  state.author = { did, handle }
  showView('following')
  window.scrollTo({ top: 0 })
}

function renderAuthorChip() {
  const chip = $('#authorChip')
  chip.hidden = !state.author
  if (state.author) {
    chip.innerHTML = `Only @${esc(state.author.handle)} <button aria-label="Show everyone">✕</button>`
    chip.querySelector('button').onclick = () => {
      state.author = null
      showView('following')
    }
  }
}
document.querySelectorAll('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => {
  state.author = null
  if (t.dataset.tab !== 'trending' || state.view === 'trending') tr.topic = null
  showView(t.dataset.tab)
}))

// ---------- keywords ----------

// Why a group can't find new posts, or null
function groupProblem(keywordIds) {
  const members = keywordIds.map((id) => state.kw.list.find((k) => k.id === id)).filter(Boolean)
  if (!members.length) return 'This group has no keywords, so it won’t show any posts. Add some with ⚙.'
  if (members.every((k) => !k.enabled)) return `Every keyword in this group is paused, so no new posts are coming in. Resume ${members.length === 1 ? 'it' : 'them'} with ▶.`
  return null
}

function keywordChip(k, groupId) {
  const status = k.error
    ? `<span class="warn" title="${esc(k.error)}">⚠</span>`
    : k.lastPollMs === 0 && k.enabled ? '<span class="n">searching…</span>'
    : `<span class="n" title="${k.capped ? 'Very common keyword: only the newest 2,000 matches per check are kept. ' : ''}${k.count.toLocaleString()} shown, ${k.hidden.toLocaleString()} hidden by your context rules (last ${state.kw.hours} hours)">${k.count.toLocaleString()}${k.capped ? '+' : ''}${k.hidden ? `<span class="hid"> · ${k.hidden.toLocaleString()} hidden</span>` : ''}</span>`
  const selected = state.kw.selected.has(k.id) && state.kw.group === groupId
  return `<span class="kw-chip ${selected ? 'selected' : ''} ${k.enabled ? '' : 'off'}" data-kw="${k.id}" ${groupId ? `data-group="${groupId}"` : ''}>
    <button class="kw-name" data-kw-act="select" title="${esc(k.query)}: click to show only this keyword, double-click to edit it">${esc(k.query)}</button>${status}
    <button data-kw-act="rules" class="${k.hasRules ? 'has-rules' : ''}" title="${k.hasRules ? 'Edit' : 'Set'} what “${esc(k.query)}” should mean">⚙</button>
    <button data-kw-act="toggle" title="${k.enabled ? 'Pause' : 'Resume'} this keyword">${k.enabled ? '❚❚' : '▶'}</button>
    <button data-kw-act="feed" title="${k.inFeed ? 'Included in' : 'Left out of'} your Bluesky custom feed">${k.inFeed ? '📡' : '<span style="opacity:.35">📡</span>'}</button>
    ${groupId ? '<button data-kw-act="ungroup" title="Take out of this group (keeps the keyword)">−</button>' : ''}
    <button data-kw-act="remove" title="Delete this keyword">✕</button></span>`
}

function collapsedGroups() {
  try { return new Set(JSON.parse(safeGet('kwCollapsed') ?? '[]')) } catch { return new Set() }
}

function renderKeywords() {
  const el = $('#kwList')
  const { list, groups } = state.kw
  // The fold's heading says what the posts below are from, for when the list is folded away
  const group = state.kw.group && groups.find((g) => g.id === state.kw.group)
  const picked = list.filter((k) => state.kw.selected.has(k.id)).map((k) => k.query)
  const showing = [group?.name, picked.join(', ')].filter(Boolean).join(': ')
  $('#kwFoldSum').textContent = `Your keywords and groups (${list.length})${showing ? ` · showing ${showing}` : ''}`
  const inAGroup = new Set(groups.flatMap((g) => g.keywordIds))
  const collapsed = collapsedGroups()
  const byId = new Map(list.map((k) => [k.id, k]))
  const groupHtml = groups.map((g) => {
    const isCollapsed = collapsed.has(g.id)
    const members = g.keywordIds.map((id) => byId.get(id)).filter(Boolean)
    return `<section class="kw-group ${state.kw.group === g.id ? 'selected' : ''} ${g.enabled ? '' : 'off'}" data-group-box="${g.id}">
      <header class="kw-group-head" data-group-head="${g.id}">
        <button data-grp="collapse" aria-expanded="${!isCollapsed}" title="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '▸' : '▾'}</button>
        <button class="kw-group-name" data-grp="select" title="Show this group's posts">${esc(g.name)}</button>
        <span class="n" title="${g.count.toLocaleString()} posts shown, ${g.hidden.toLocaleString()} hidden by keyword rules (last ${state.kw.hours} hours)">${members.length} keyword${members.length === 1 ? '' : 's'} · ${g.count.toLocaleString()}${g.hidden ? `<span class="hid"> · ${g.hidden.toLocaleString()} hidden</span>` : ''}</span>
        <span class="kw-group-acts">
          <button data-grp="rules" title="Rename this group or edit its keywords">⚙</button>
          <button data-grp="toggle" title="${g.enabled ? 'Pause' : 'Resume'} every keyword in this group (also where they're in other groups)">${g.enabled ? '❚❚' : '▶'}</button>
          <button data-grp="feed" title="${g.inFeed ? 'Take this group’s keywords out of' : 'Add this group’s keywords to'} your Bluesky custom feed">${g.inFeed ? '📡' : '<span style="opacity:.35">📡</span>'}</button>
          <button data-grp="remove" title="Delete this group (keeps its keywords)">✕</button>
        </span>
      </header>
      ${!isCollapsed && members.length && groupProblem(g.keywordIds) ? `<div class="group-warn">${esc(groupProblem(g.keywordIds))}</div>` : ''}
      ${isCollapsed ? '' : `<div class="kw-group-tags" data-drop-group="${g.id}">${members.map((k) => keywordChip(k, g.id)).join('') || '<span class="kw-empty">No keywords yet. Add some with ⚙.</span>'}</div>`}
    </section>`
  }).join('')
  const loose = list.filter((k) => !inAGroup.has(k.id))
  const looseHtml = loose.map((k) => keywordChip(k, null)).join('')
  el.innerHTML = `${groupHtml}
    ${groups.length && loose.length ? '<div class="kw-loose-label">Not in a group</div>' : ''}
    <div class="kw-loose">${looseHtml}${list.length ? '' : '<span class="kw-empty">No keywords yet.</span>'}</div>
    ${saveSelectionBar()}
    ${list.length ? '<button type="button" class="link-btn kw-new-group" data-grp="new">+ New group</button>' : ''}`
  renderGroupPicker()
}

async function refreshKeywordView() {
  await loadKeywords()
  loadFeed(true)
}

// Handles clicks on group controls. Returns true when the click was one of them.
async function handleGroupAction(e) {
  const btn = e.target.closest('[data-grp]')
  if (!btn) return false
  const action = btn.dataset.grp
  try {
    if (action === 'new') {
      const name = prompt('Name this group (for example, UK Athletics):')?.trim()
      if (!name) return true
      const { id } = await api('/api/groups/create', { name })
      await loadKeywords()
      openGroup(id)
      return true
    }
    const id = Number(btn.closest('[data-group-box]').dataset.groupBox)
    const g = state.kw.groups.find((x) => x.id === id)
    switch (action) {
      case 'collapse': {
        const c = collapsedGroups()
        c.has(id) ? c.delete(id) : c.add(id)
        safeSet('kwCollapsed', JSON.stringify([...c]))
        renderKeywords()
        return true
      }
      case 'select':
        state.kw.group = state.kw.group === id ? null : id
        state.kw.selected.clear()
        renderKeywords()
        loadFeed(true)
        return true
      case 'rules':
        openGroup(id)
        return true
      case 'toggle':
        await api('/api/groups/set', { id, enabled: !g.enabled })
        break
      case 'feed':
        await api('/api/groups/set', { id, inFeed: !g.inFeed })
        toast(g.inFeed ? `“${g.name}” left out of your Bluesky feed` : `“${g.name}” added to your Bluesky feed`)
        break
      case 'remove':
        if (!confirm(`Delete the group “${g.name}”? Its keywords stay.`)) return true
        await api('/api/groups/remove', { id })
        break
    }
    await refreshKeywordView()
  } catch (err) {
    toast(err.message)
  }
  return true
}

// ---------- saving keywords to groups ----------

// The "Save to" menu next to the add box, rebuilt when groups change; keeps the current choice
function renderGroupPicker() {
  const sel = $('#kwGroup')
  const was = sel.value
  sel.innerHTML = `<option value="">No group</option>
    ${state.kw.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}
    <option value="new">New group…</option>`
  sel.value = [...sel.options].some((o) => o.value === was) ? was : ''
}

// Loose keywords picked by clicking can be saved as a group in one go
function saveSelectionBar() {
  if (state.kw.group || !state.kw.selected.size) return ''
  const n = state.kw.selected.size
  return `<div class="kw-save-sel">${n} selected <button type="button" class="link-btn" data-save-sel>Save as group…</button></div>`
}

// Asks for a group: an existing group's name adds to it; any other name makes a new group
async function saveToGroupByName(ids) {
  const names = state.kw.groups.map((g) => g.name).join(', ')
  const name = prompt(`Name a new group${names ? `, or type an existing one (${names})` : ''}:`)?.trim()
  if (!name) return
  const existing = state.kw.groups.find((g) => g.name.toLowerCase() === name.toLowerCase())
  if (existing) await api('/api/keywords/bulk', { ids, addGroup: existing.id })
  else await api('/api/groups/create', { name, keywordIds: ids })
  state.kw.selected.clear()
  toast(existing ? `Added to “${existing.name}”` : `Saved as “${name}”`)
  await refreshKeywordView()
}

$('#kwList').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-save-sel]')) return
  try {
    await saveToGroupByName([...state.kw.selected])
  } catch (err) {
    toast(err.message)
  }
})

// Double-click a keyword to change what it searches for, right there in its chip
$('#kwList').addEventListener('dblclick', (e) => {
  const name = e.target.closest('.kw-name')
  if (!name) return
  const chip = name.closest('[data-kw]')
  const k = state.kw.list.find((x) => x.id === Number(chip.dataset.kw))
  if (!k) return
  e.preventDefault()
  // The two clicks of a double-click toggled the selection twice; leave it as it was
  const input = Object.assign(document.createElement('input'), { type: 'text', value: k.query, className: 'kw-edit', maxLength: 200 })
  input.size = Math.max(8, k.query.length + 2)
  name.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (save) => {
    if (done) return
    done = true
    const query = input.value.trim()
    if (!save || !query || query === k.query) return renderKeywords()
    try {
      const r = await api('/api/keywords/rename', { id: k.id, query })
      toast(`Now searching for ${r.query}…`)
      await refreshKeywordView()
    } catch (err) {
      toast(err.message)
      renderKeywords()
    }
  }
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') finish(true)
    if (ev.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
})

async function loadKeywords() {
  try {
    const data = await api('/api/keywords')
    state.kw.list = data.keywords
    state.kw.groups = data.groups
    state.kw.hours = data.hours
    if (state.kw.group && !data.groups.some((g) => g.id === state.kw.group)) state.kw.group = null
    const wasPolling = state.kw.polling
    state.kw.polling = data.polling || data.keywords.some((k) => k.enabled && k.lastPollMs === 0)
    for (const id of state.kw.selected) if (!data.keywords.some((k) => k.id === id)) state.kw.selected.delete(id)
    renderKeywords()
    // When a search finishes while the feed is empty, show the results
    if (wasPolling && !state.kw.polling && state.view === 'keywords' && !$('#feed').children.length) loadFeed(true)
  } catch (err) {
    $('#kwList').textContent = `Couldn't load keywords: ${err.message}`
  }
}

$('#kwForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('#kwInput')
  const queries = input.value.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean)
  if (!queries.length) return
  const pick = $('#kwGroup').value
  let groupName = null
  if (pick === 'new') {
    groupName = prompt('Name the new group (for example, UK Athletics):')?.trim()
    if (!groupName) return
  }
  try {
    const r = await api('/api/keywords/addMany', { queries, ...(pick === 'new' ? { groupName } : pick ? { groupId: Number(pick) } : {}) })
    input.value = ''
    await loadKeywords()
    const group = r.groupId ? state.kw.groups.find((g) => g.id === r.groupId) : null
    if (group) $('#kwGroup').value = String(group.id)
    const parts = [r.created.length ? `Searching the last ${state.kw.hours} hours for ${r.created.length} new keyword${r.created.length === 1 ? '' : 's'}` : 'Nothing new to search']
    if (r.existed) parts.push(`${r.existed} you already had`)
    toast(parts.join(', ') + (group ? ` — saved to “${group.name}”` : '') + '.')
  } catch (err) {
    toast(err.message)
  }
})

$('#kwList').addEventListener('click', async (e) => {
  if (await handleGroupAction(e)) return
  const btn = e.target.closest('[data-kw-act]')
  if (!btn) return
  const id = Number(btn.closest('[data-kw]').dataset.kw)
  const k = state.kw.list.find((x) => x.id === id)
  try {
    switch (btn.dataset.kwAct) {
      case 'select':
        {
          // Picking a tag inside a group narrows that group's view; outside one, it uses the tag alone
          const groupId = Number(btn.closest('[data-kw]').dataset.group) || null
          if (state.kw.group !== groupId) {
            state.kw.group = groupId
            state.kw.selected.clear()
          }
          state.kw.selected.has(id) ? state.kw.selected.delete(id) : state.kw.selected.add(id)
        }
        renderKeywords()
        return loadFeed(true)
      case 'ungroup':
        await api('/api/groups/takeOut', { keywordId: id, groupId: Number(btn.closest('[data-kw]').dataset.group) })
        toast(`Took “${k.query}” out of the group`)
        break
      case 'toggle':
        await api('/api/keywords/update', { id, enabled: !k.enabled })
        break
      case 'feed':
        await api('/api/keywords/update', { id, inFeed: !k.inFeed })
        toast(k.inFeed ? `"${k.query}" left out of your Bluesky feed` : `"${k.query}" added to your Bluesky feed`)
        break
      case 'rules':
        return openRules(k)
      case 'remove':
        if (!confirm(`Remove "${k.query}" and its saved matches?`)) return
        await api('/api/keywords/remove', { id })
        break
    }
    await loadKeywords()
    loadFeed(true)
  } catch (err) {
    toast(err.message)
  }
})

$('#hideFollowed').addEventListener('change', (e) => {
  state.kw.hideFollowed = e.target.checked
  loadFeed(true)
})

$('#videosOnly').addEventListener('change', (e) => {
  state.kw.videosOnly = e.target.checked
  loadFeed(true)
})

// ---------- folding sections ----------

// details.fold with an id remember whether they were left open
document.querySelectorAll('details.fold[id]').forEach((d) => {
  const saved = safeGet(`fold:${d.id}`)
  if (saved !== null) d.open = saved === '1'
  d.addEventListener('toggle', () => safeSet(`fold:${d.id}`, d.open ? '1' : '0'))
})

// ---------- videos ----------

// Searches all of Bluesky for posts with a video. Recent searches and your keywords are one click away.
const vd = {
  q: '',
  sort: safeGet('vdSort') === 'top' ? 'top' : 'latest',
  hours: [24, 72, 168, 720, 0].includes(Number(safeGet('vdHours') ?? 72)) ? Number(safeGet('vdHours') ?? 72) : 72,
  links: safeGet('vdLinks') === '1',
}
function vdHoursLabel(h) {
  return { 24: 'day', 72: '3 days', 168: 'week', 720: 'month' }[h] ?? `${h} hours`
}
function recentVideoSearches() {
  try { return JSON.parse(safeGet('vdRecent') ?? '[]').filter((x) => typeof x === 'string') } catch { return [] }
}

function renderVideoControls() {
  document.querySelectorAll('#vdSort button').forEach((b) => b.classList.toggle('on', b.dataset.value === vd.sort))
  document.querySelectorAll('#vdHours button').forEach((b) => b.classList.toggle('on', Number(b.dataset.value) === vd.hours))
  $('#vdLinks').checked = vd.links
  if (document.activeElement !== $('#vdInput')) $('#vdInput').value = vd.q
  const recent = recentVideoSearches()
  const lower = new Set(recent.map((r) => r.toLowerCase()))
  const keywords = state.kw.list.map((k) => k.query).filter((k) => !lower.has(k.toLowerCase()))
  // Plain text links, small, so the results stay close to the search box
  const link = (q) => `<button type="button" class="vd-link ${q.toLowerCase() === vd.q.toLowerCase() ? 'on' : ''}" data-vd-q="${esc(q)}" title="Search videos for ${esc(q)}">${esc(q)}</button>`
  $('#vdChips').innerHTML =
    (recent.length ? `<div class="vd-row"><span class="dim">Recent:</span> ${recent.map(link).join('<span class="vd-sep">·</span>')} <button type="button" class="vd-clear" data-vd-clear title="Forget recent searches">clear</button></div>` : '') +
    (keywords.length ? `<div class="vd-row"><span class="dim">Your keywords:</span> ${keywords.map(link).join('<span class="vd-sep">·</span>')}</div>` : '')
  $('#vdSaved').hidden = !recent.length && !keywords.length
  $('#vdSavedSum').textContent = recent.length && keywords.length ? 'Recent searches and your keywords' : recent.length ? 'Recent searches' : 'Your keywords'
}

function searchVideosFor(q) {
  vd.q = q.trim()
  if (vd.q) safeSet('vdRecent', JSON.stringify([vd.q, ...recentVideoSearches().filter((r) => r.toLowerCase() !== vd.q.toLowerCase())].slice(0, 8)))
  $('#vdInput').value = vd.q
  renderVideoControls()
  loadFeed(true)
}

$('#vdForm').addEventListener('submit', (e) => {
  e.preventDefault()
  searchVideosFor($('#vdInput').value)
})
$('#vdChips').addEventListener('click', (e) => {
  if (e.target.closest('[data-vd-clear]')) {
    safeSet('vdRecent', '[]')
    return renderVideoControls()
  }
  const pick = e.target.closest('[data-vd-q]')
  if (pick) searchVideosFor(pick.dataset.vdQ)
})
for (const [id, key] of [['#vdSort', 'sort'], ['#vdHours', 'hours']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]')
    if (!b) return
    vd[key] = key === 'hours' ? Number(b.dataset.value) : b.dataset.value
    safeSet(key === 'hours' ? 'vdHours' : 'vdSort', vd[key])
    renderVideoControls()
    if (vd.q) loadFeed(true)
  })
}
$('#vdLinks').addEventListener('change', (e) => {
  vd.links = e.target.checked
  safeSet('vdLinks', vd.links ? '1' : '0')
  if (vd.q) loadFeed(true)
})

// ---------- keyword context rules ----------

// Under a keyword post: why it's shown or hidden for each keyword, with buttons to always/never show the author
function renderVerdicts(item) {
  const handle = item.post.author.handle
  const did = item.post.author.did
  const rows = item.verdicts
    .filter((v) => state.kw.showHidden ? !v.kept : v.kept)
    .map((v) => {
      const k = state.kw.list.find((x) => x.id === v.id)
      if (!k) return ''
      const scope = k.query
      const attrs = `data-kw-id="${k.id}" data-scope="${esc(scope)}" data-did="${esc(did)}" data-handle="${esc(handle)}"`
      const btn = v.kept
        ? `<button class="link-btn bad" data-kwauthor="blocked" ${attrs} title="Hide posts by @${esc(handle)} from “${esc(scope)}”">Not about ${esc(scope)}? Never show @${esc(handle)}</button>`
        : `<button class="link-btn" data-kwauthor="trusted" ${attrs} title="Always show posts by @${esc(handle)} for “${esc(scope)}”">Always show @${esc(handle)} here</button>`
      return `<div class="kw-verdict"><span class="kw-tag ${v.kept ? '' : 'hidden-tag'}">${esc(k.query)}</span>
        <span class="why">${v.kept ? '' : 'Hidden: '}${esc(v.reason)}</span>${btn}</div>`
    })
    .join('')
  return rows ? `<div class="kw-tags kw-verdicts">${rows}</div>` : ''
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-kwauthor]')
  if (!b) return
  const id = Number(b.dataset.kwId)
  const url = '/api/keywords/author'
  const scope = b.dataset.scope
  const verdict = b.dataset.kwauthor
  b.disabled = true
  try {
    await api(url, { id, did: b.dataset.did, verdict })
    toast(verdict === 'trusted' ? `Always showing @${b.dataset.handle} for “${scope}”` : `Hiding @${b.dataset.handle} from “${scope}”`, {
      label: 'Undo',
      run: async () => {
        await api(url, { id, did: b.dataset.did, verdict: null })
        await loadKeywords()
        loadFeed(true)
      },
    })
    await loadKeywords()
    loadFeed(true)
  } catch (err) {
    toast(err.message)
    b.disabled = false
  }
})

$('#showHidden').addEventListener('change', (e) => {
  state.kw.showHidden = e.target.checked
  loadFeed(true)
})

// ⚙ on a keyword: what it searches for, and what it should mean (its context rules)
async function openRules(k) {
  const dlg = $('#actionDialog')
  const body = $('#adBody')
  $('#adTitle').textContent = `Edit “${k.query}”`
  body.innerHTML = '<div class="dim">Loading…</div>'
  dlg.showModal()
  let r
  try {
    r = await api(`/api/keywords/rules?id=${k.id}`)
  } catch (err) {
    body.innerHTML = `<div class="error">${esc(err.message)}</div>`
    return
  }
  const people = (list, verdict) => list.length
    ? list.map((p) => `<span class="person"><span data-profile="${esc(p.did)}">@${esc(p.handle)}</span> <button class="link-btn" data-rule-person="${esc(p.did)}" data-verdict="${verdict}" title="Remove">✕</button></span>`).join('')
    : '<span class="dim">None yet</span>'
  const suggested = r.suggested.length
    ? `<div class="rules-block"><b>Suggested “always show” accounts</b><small>Their recent posts keep passing your rules</small>
        <div class="people">${r.suggested.map((p) => `<span class="person"><span data-profile="${esc(p.did)}">@${esc(p.handle)}</span> <span class="dim">(${p.kept})</span>
          <button class="link-btn" data-rule-trust="${esc(p.did)}">Always show</button></span>`).join('')}</div></div>`
    : ''
  const memberOf = state.kw.groups.length
    ? `<div class="rules-block"><b>Groups</b><small>A keyword can be in several.</small>
         <div class="rules-checks">${state.kw.groups.map((g) => `<label class="chip"><input type="checkbox" name="group" value="${g.id}" ${r.groupIds.includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('')}</div></div>`
    : ''
  body.innerHTML = `
    <label class="rules-block"><b>Search for</b><small>Changing this clears its matches and searches the last ${state.kw.hours} hours again. Words with spaces are searched as an exact phrase.</small>
      <input id="kwQuery" type="text" maxlength="200" value="${esc(k.query)}"></label>
    <p class="dim rules-intro">Posts matching it are shown only if they mention one of the first list and none of the second.
      Separate words with commas or new lines. Words in ALL CAPS (like UK or SEC) must match exactly; others ignore case.</p>
    <label class="rules-block"><b>Must mention one of</b><small>Leave empty to keep every match</small>
      <textarea id="rulesMust" rows="4">${esc(r.must.join(', '))}</textarea></label>
    <label class="rules-block"><b>Hide if it mentions</b>
      <textarea id="rulesExclude" rows="4">${esc(r.exclude.join(', '))}</textarea></label>
    <div class="rules-block"><b>Always show these accounts</b><div class="people">${people(r.trusted, 'trusted')}</div></div>
    <div class="rules-block"><b>Never show these accounts</b><div class="people">${people(r.blocked, 'blocked')}</div></div>
    ${suggested}
    ${memberOf}
    <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="rulesSave">Save</button></div>`

  body.querySelectorAll('[data-rule-person]').forEach((x) => (x.onclick = async () => {
    await api('/api/keywords/author', { id: k.id, did: x.dataset.rulePerson, verdict: null })
    x.closest('.person').remove()
    refreshKeywordView()
  }))
  body.querySelectorAll('[data-rule-trust]').forEach((x) => (x.onclick = async () => {
    await api('/api/keywords/author', { id: k.id, did: x.dataset.ruleTrust, verdict: 'trusted' })
    x.replaceWith(Object.assign(document.createElement('span'), { className: 'dim', textContent: 'added' }))
    refreshKeywordView()
  }))
  $('#rulesSave').onclick = async () => {
    try {
      const query = $('#kwQuery').value.trim()
      let renamed = null
      if (query && query !== k.query) renamed = (await api('/api/keywords/rename', { id: k.id, query })).query
      const groupIds = [...body.querySelectorAll('input[name="group"]:checked')].map((i) => Number(i.value))
      await api('/api/keywords/rules', { id: k.id, must: $('#rulesMust').value, exclude: $('#rulesExclude').value, ...(state.kw.groups.length ? { groupIds } : {}) })
      dlg.close()
      toast(renamed ? `Now searching for ${renamed}…` : `Saved “${k.query}”`)
      refreshKeywordView()
    } catch (err) {
      toast(err.message)
    }
  }
}

// ⚙ on a group: its name and its keywords, one per line
async function openGroup(id) {
  const dlg = $('#actionDialog')
  const body = $('#adBody')
  body.innerHTML = '<div class="dim">Loading…</div>'
  dlg.showModal()
  let g
  try {
    g = await api(`/api/groups/get?id=${id}`)
  } catch (err) {
    body.innerHTML = `<div class="error">${esc(err.message)}</div>`
    return
  }
  $('#adTitle').textContent = `Edit group “${g.name}”`
  try {
    const k = await api('/api/keywords') // current list, so every saved keyword can be ticked
    state.kw.list = k.keywords
    state.kw.groups = k.groups
  } catch {}
  // Every saved keyword, ticked when it's in this group, plus a box for new ones
  const inGroup = new Set(g.keywords.map((k) => k.query.toLowerCase()))
  const otherGroups = (k) => state.kw.groups.filter((x) => x.id !== id && x.keywordIds?.includes(k.id)).map((x) => x.name)
  const all = [...state.kw.list].sort((a, b) => Number(inGroup.has(b.query.toLowerCase())) - Number(inGroup.has(a.query.toLowerCase())) || a.query.localeCompare(b.query))
  body.innerHTML = `
    <label class="rules-block"><b>Group name</b><input id="groupName" type="text" maxlength="60" value="${esc(g.name)}"></label>
    <div class="rules-block"><b>Keywords</b><small>Tick the saved keywords this group should show. Unticking one takes it out of this group; it’s deleted only if it was made for this group and is in no other group.</small>
      ${all.length > 8 ? '<input id="groupFilter" type="search" placeholder="Find a keyword" autocomplete="off">' : ''}
      <div class="group-picks" id="groupPicks">${all.length ? all.map((k) => {
        const others = otherGroups(k)
        return `<label class="group-pick" data-q="${esc(k.query.toLowerCase())}"><input type="checkbox" value="${esc(k.query)}" ${inGroup.has(k.query.toLowerCase()) ? 'checked' : ''}>
          <span>${esc(k.query)}${k.enabled ? '' : ' <small class="dim">paused</small>'}${others.length ? ` <small class="dim">· in ${esc(others.join(', '))}</small>` : ''}</span></label>`
      }).join('') : '<p class="dim">No saved keywords yet.</p>'}</div></div>
    <label class="rules-block"><b>Add new keywords</b><small>One per line (or separated by commas). They're searched straight away.</small>
      <textarea id="groupQueries" rows="3" placeholder="Big Blue Nation, #BBN"></textarea></label>
    <div class="group-warn" id="groupWarn" hidden></div>
    <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="groupSave">Save</button></div>`
  const queries = () => {
    const picked = [...body.querySelectorAll('#groupPicks input:checked')].map((c) => c.value)
    const typed = $('#groupQueries').value.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean)
    const seen = new Set()
    return [...picked, ...typed].filter((q) => !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
  }
  $('#groupFilter')?.addEventListener('input', (e) => {
    const f = e.target.value.trim().toLowerCase()
    body.querySelectorAll('.group-pick').forEach((el) => (el.hidden = !!f && !el.dataset.q.includes(f)))
  })
  $('#groupPicks').addEventListener('change', () => update())
  const known = new Map(state.kw.list.map((x) => [x.query.toLowerCase(), x]))
  const update = () => {
    const words = queries()
    const problem = !words.length
      ? 'This group has no keywords, so it won’t show any posts.'
      : words.every((w) => known.get(w.toLowerCase()) && !known.get(w.toLowerCase()).enabled)
        ? 'Every keyword here is paused, so no new posts are coming in. Resume the group with ▶ after saving.'
        : null
    $('#groupWarn').hidden = !problem
    $('#groupWarn').textContent = problem ?? ''
  }
  $('#groupQueries').addEventListener('input', update)
  update()
  $('#groupSave').onclick = async () => {
    try {
      const { created } = await api('/api/groups/update', { id, name: $('#groupName').value, queries: queries() })
      dlg.close()
      toast(created?.length
        ? `Searching the last ${state.kw.hours} hours for ${created.length} new keyword${created.length === 1 ? '' : 's'}…`
        : `Saved “${$('#groupName').value.trim()}”`)
      refreshKeywordView()
    } catch (err) {
      toast(err.message)
    }
  }
}

// ---------- custom Bluesky feed ----------

async function renderFeedgen() {
  const body = $('#feedgenBody')
  let info
  try {
    info = await api('/api/feedgen')
  } catch (err) {
    body.textContent = err.message
    return
  }
  if (!info.hostname) {
    body.innerHTML = `<p>Publish the keywords marked 📡 as a custom feed you can pin in the official Bluesky app. Bluesky's servers need to reach this Mac, so it needs a public address. The free option that keeps the same address is Tailscale Funnel:</p>
      <ol>
        <li>Install Tailscale and sign in.</li>
        <li>Run <code>tailscale funnel --bg ${info.port}</code>. It prints an address like <code>your-mac.tail1234.ts.net</code>.</li>
        <li>Add <code>FEEDGEN_HOSTNAME=your-mac.tail1234.ts.net</code> to <code>.env</code> and restart Skydash.</li>
      </ol>
      <p>Only the feed is made public, on port ${info.port}. The dashboard stays private. Anyone with the feed link can see which posts match your keywords.</p>`
    return
  }
  if (info.uri) {
    body.innerHTML = `<p>Your feed is published. Open it in Bluesky and pin it: <a href="${esc(info.appUrl)}" target="_blank" rel="noopener">${esc(info.appUrl)}</a></p>
      <p>It includes the keywords marked 📡 and only works while Skydash and the Funnel are running.</p>
      <div class="row"><button class="secondary" id="fgUnpublish">Unpublish</button></div>`
    $('#fgUnpublish').onclick = async () => {
      if (!confirm('Remove the custom feed from your Bluesky profile?')) return
      try { await api('/api/feedgen/unpublish', {}); toast('Feed removed'); renderFeedgen() } catch (err) { toast(err.message) }
    }
    return
  }
  body.innerHTML = `<p>Ready to publish from <code>${esc(info.hostname)}</code>. This adds a feed to the chosen account's profile that anyone can find.</p>
    <div class="row">
      <input id="fgName" maxlength="24" value="My keywords" aria-label="Feed name">
      <select id="fgAs">${state.accounts.map((a) => `<option value="${a.slot}" ${a.slot === state.actAs ? 'selected' : ''}>@${esc(a.handle)}</option>`).join('')}</select>
      <button class="primary" id="fgPublish">Publish feed</button>
    </div>
    <input id="fgDesc" maxlength="300" placeholder="Description (optional)" style="width:100%;margin-top:8px" aria-label="Feed description">`
  $('#fgPublish').onclick = async () => {
    const slot = Number($('#fgAs').value)
    if (!confirm(`Publish "${$('#fgName').value}" as a public custom feed on ${acctName(slot)}?`)) return
    try {
      await api('/api/feedgen/publish', { slot, displayName: $('#fgName').value, description: $('#fgDesc').value })
      toast('Feed published')
      renderFeedgen()
    } catch (err) { toast(err.message) }
  }
}
$('#feedgenBox').addEventListener('toggle', (e) => e.target.open && renderFeedgen())

// ---------- trending ----------

const tr = {
  hours: Number(safeGet('trHours')) || 24,
  who: 'all',
  topic: null, // the topic being drilled into
  data: null,
  expanded: new Set(), // sections showing all items instead of the top 5
}
const TOP_N = 5

function hoursLabel(h) {
  return h === 72 ? '3 days' : `${h} hours`
}

// Text to highlight in drill-down posts. Links and mentions have nothing visible to mark.
function topicTerms(t) {
  if (t.kind === 'word' || t.kind === 'phrase') return [t.label]
  if (t.kind === 'tag') return [t.label]
  return []
}

const KIND_ICON = { tag: '#', word: 'Aa', phrase: 'Aa', link: '🔗', mention: '@' }

function renderTrendControls() {
  document.querySelectorAll('#trHours button').forEach((b) => b.classList.toggle('on', b.dataset.value === String(tr.hours)))
  const who = $('#trWho')
  who.hidden = state.accounts.length < 2
  const opts = [['all', 'Everyone']]
  for (const a of state.accounts) opts.push([String(a.slot), `${LETTERS[a.slot]} follows`])
  if (state.accounts.length >= 2) opts.push(['both', allLabel()])
  who.innerHTML = opts.map(([v, l]) => `<button data-value="${v}" class="${tr.who === v ? 'on' : ''}">${esc(l)}</button>`).join('')
}

async function loadTrending() {
  renderTrendControls()
  renderTrendHead()
  if (tr.topic) return // drilling in: the feed shows the posts
  $('#trList').innerHTML = '<div class="feed-end">Finding topics…</div>'
  try {
    tr.data = await api(`/api/trending?hours=${tr.hours}&who=${tr.who}${state.englishOnly ? '&lang=en' : ''}`)
    renderTrending()
  } catch (err) {
    $('#trList').innerHTML = `<div class="feed-end">Couldn't load trends: ${esc(err.message)}</div>`
  }
}

function renderTopic(t, list, i) {
  let rise
  if (t.isNew) rise = '<span class="rise new" title="Not seen in the week before">new</span>'
  else if (t.ratio >= 1.5) rise = `<span class="rise" title="About ${t.usual} people in a usual ${hoursLabel(tr.hours)}">↑ ${t.ratio}×</span>`
  else rise = `<span class="rise flat" title="About ${t.usual} people in a usual ${hoursLabel(tr.hours)}">usual</span>`
  const summary = t.summary
    ? `<span class="summary">${t.source === 'article' ? '<span class="src" title="Headline of an article people linked">Headline</span> ' : ''}${esc(t.summary)}</span>`
    : ''
  const related = t.related?.length ? `<span class="related">Also: ${t.related.map(esc).join(', ')}</span>` : ''
  return `<button class="topic" data-list="${list}" data-i="${i}">
    <span class="kind" title="${esc(t.kind)}">${KIND_ICON[t.kind] ?? '•'}</span>
    <span class="t"><b ${t.kind === 'mention' ? `data-profile="${esc(t.term.slice(1))}"` : ''}>${esc(t.label)}</b>${summary}${related}
      <small>${t.people} people · ${t.posts} posts · previous ${hoursLabel(tr.hours)}: ${t.prevPeople}</small></span>
    ${rise}</button>`
}

// The first sentence (or linked article's title) of a shared post, as its summary
function postSummary(post) {
  const ext = post.embed?.external ?? post.embed?.media?.external
  const text = (post.record?.text ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  const first = text.split(/(?<=[.!?])\s/)[0] ?? ''
  const pick = first.length >= 20 ? first : text || ext?.title || 'Post with media'
  return pick.length > 170 ? pick.slice(0, 170).replace(/\s+\S*$/, '') + '…' : pick
}

function renderShared(s, i) {
  const a = s.post.author
  const names = s.sharers.slice(0, 4).map((x) => `<span data-profile="${esc(x.did)}">@${esc(x.handle)}</span>`).join(', ') + (s.sharers.length > 4 ? ` +${s.sharers.length - 4}` : '')
  return `<button class="topic" data-list="shared" data-i="${i}">
    <img class="kind avatar-mini" data-profile="${esc(a.did)}" src="${esc(a.avatar ?? '')}" alt="">
    <span class="t"><b data-profile="${esc(a.did)}">${esc(a.displayName || a.handle)}</b><span class="summary">${esc(postSummary(s.post))}</span>
      <small>Shared by ${names}</small></span>
    <span class="rise">${s.sharers.length}×</span></button>`
}

const SECTIONS = [
  { key: 'rising', title: 'Rising', hint: 'More people than usual are talking about these', empty: 'Nothing is rising faster than usual right now.' },
  { key: 'popular', title: 'Most talked about', hint: 'The most people are talking about these', empty: 'Not enough posts in this window.' },
  { key: 'shared', title: 'Most shared', hint: 'Posts that several people you follow reposted or quoted', empty: 'Nothing was shared by 2 or more people you follow.' },
]

function renderTrending() {
  const d = tr.data
  if (!d) return
  const history = d.historyDays < 7 ? ` Only ${d.historyDays} days of history are stored so far, so "usual" is based on that.` : ''
  $('#trNote').textContent = `From ${d.windowPosts.toLocaleString()} posts by people you follow in the last ${hoursLabel(d.hours)}, compared with their usual rate over the week before.${history}`

  $('#trList').innerHTML = SECTIONS.map(({ key, title, hint, empty }) => {
    const list = d[key] ?? []
    const all = tr.expanded.has(key)
    const shown = all ? list : list.slice(0, TOP_N)
    const items = shown.map((x, i) => (key === 'shared' ? renderShared(x, i) : renderTopic(x, key, i))).join('')
    const more = list.length > TOP_N
      ? `<button class="link-btn" data-more="${key}">${all ? 'Show top 5' : `Show all ${list.length}`}</button>`
      : ''
    return `<section class="trend-section">
      <div class="trend-section-head"><h3>${title}</h3><small>${hint}</small></div>
      ${items || `<div class="feed-end">${empty}</div>`}
      ${more}</section>`
  }).join('')
}

function renderTrendHead() {
  const head = $('#trHead')
  head.hidden = !tr.topic
  $('#trList').hidden = !!tr.topic
  $('#trNote').hidden = !!tr.topic
  if (!tr.topic) return
  const t = tr.topic
  const link = t.url ? ` <a href="${esc(t.url)}" target="_blank" rel="noopener">open link ↗</a>` : ''
  head.innerHTML = `<button class="secondary" id="trBack">← Topics</button>
    <h2>${esc(t.label)}</h2><small>${t.people} people · ${t.posts} posts in the last ${hoursLabel(tr.hours)}${link}</small>
    ${t.summary ? `<p class="trend-head-summary">${esc(t.summary)}</p>` : ''}`
  $('#trBack').onclick = () => {
    tr.topic = null
    showView('trending')
  }
}

$('#trList').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]')
  if (more) {
    const key = more.dataset.more
    tr.expanded.has(key) ? tr.expanded.delete(key) : tr.expanded.add(key)
    return renderTrending()
  }
  const b = e.target.closest('.topic')
  if (!b) return
  if (b.dataset.list === 'shared') return showThread(tr.data.shared[Number(b.dataset.i)].post.uri)
  tr.topic = tr.data[b.dataset.list][Number(b.dataset.i)]
  showView('trending')
  window.scrollTo({ top: 0 })
})

for (const [id, key] of [['#trHours', 'hours'], ['#trWho', 'who']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]')
    if (!b) return
    tr[key] = key === 'hours' ? Number(b.dataset.value) : b.dataset.value
    if (key === 'hours') safeSet('trHours', tr.hours)
    tr.topic = null
    showView('trending')
  })
}

// ---------- discover ----------

const dv = { pick: '0', mode: 'all', data: null, shown: 30 } // pick: '0' all, '12' a keyword, 'g3' a group

async function loadDiscover() {
  // Keywords list feeds the keyword switcher
  if (!state.kw.list.length) {
    try {
      const k = await api('/api/keywords')
      state.kw.list = k.keywords
      state.kw.groups = k.groups
    } catch {}
  }
  // Paused keywords still have their recent history, so they're useful for finding people too
  const kws = state.kw.list
  const groups = state.kw.groups
  const known = dv.pick === '0' || (dv.pick.startsWith('g') ? groups.some((g) => `g${g.id}` === dv.pick) : kws.some((k) => String(k.id) === dv.pick))
  if (!known) dv.pick = '0'
  $('#dvKeyword').innerHTML = [
    ['0', 'All keywords', true],
    ...groups.map((g) => [`g${g.id}`, `📁 ${g.name}`, g.enabled]),
    ...kws.map((k) => [String(k.id), k.query, k.enabled]),
  ]
    .map(([v, l, on]) => `<button data-value="${v}" class="${dv.pick === v ? 'on' : ''} ${on ? '' : 'paused'}" title="${on ? '' : 'Paused (still has recent history)'}">${esc(l)}</button>`).join('')
  document.querySelectorAll('#dvMode button').forEach((b) => b.classList.toggle('on', b.dataset.value === dv.mode))
  $('#dvList').innerHTML = '<div class="feed-end">Ranking…</div>'
  try {
    const scope = dv.pick === '0' ? '' : dv.pick.startsWith('g') ? `&group=${dv.pick.slice(1)}` : `&kw=${dv.pick}`
    dv.data = await api(`/api/discover?mode=${dv.mode}${scope}`)
    renderDiscover()
  } catch (err) {
    $('#dvList').innerHTML = `<div class="feed-end">Couldn't rank accounts: ${esc(err.message)}</div>`
  }
}

function kwName(id) {
  return state.kw.list.find((k) => k.id === id)?.query ?? ''
}

function followButtons(did) {
  return state.accounts.map((a) => `<button class="pc-btn follow" data-dv="follow" data-slot="${a.slot}" data-did="${esc(did)}">${badge(a.slot)} Follow</button>`).join('')
}

function renderDiscover() {
  const d = dv.data
  const thin = d.historyDays < 7 ? ` Your keyword history covers ${d.historyDays} days so far, so "regularly" will get more reliable over the next week.` : ''
  const refreshed = d.refreshing ? 'Refreshing network signals now…' : d.lastRefreshMs ? `Network signals updated ${ago(new Date(d.lastRefreshMs).toISOString())} ago.` : 'Network signals not read yet; they fill in a minute after startup.'
  $('#dvNote').textContent = `People you don't follow, ranked by how regularly they post about your keywords over the last ${d.days} days (after your context rules), how much of what they post is on-topic, and whether people you follow and your ${d.experts} topic experts reshare or follow them. ${refreshed}${thin}`
  $('#dvRefresh').disabled = d.refreshing

  $('#dvAuditions').innerHTML = d.auditions.length
    ? `<section class="trend-section"><div class="trend-section-head"><h3>Auditioning</h3><small>Their posts are collected without following them. Follow or drop when you've seen enough.</small></div>
      ${d.auditions.map((a) => `<div class="dv-row" data-did="${esc(a.did)}">
        <button class="avatar-btn" data-profile="${esc(a.did)}"><img class="avatar" src="${esc(a.avatar ?? '')}" alt=""></button>
        <div class="dv-main">
          <div><b data-profile="${esc(a.did)}">${esc(a.displayName || a.handle)}</b> <span class="dim">@${esc(a.handle)}</span></div>
          <div class="dv-why">Since ${new Date(a.startedAt).toLocaleDateString()}: ${a.postsSince} posts, ${a.onTopicSince} on your topics · ${a.posts14d} posts in the last 14 days</div>
          <div class="dv-actions">
            <button class="pc-btn" data-dv="posts" data-did="${esc(a.did)}" data-handle="${esc(a.handle)}">Their posts</button>
            ${a.followed ? '<span class="dim">Following</span>' : followButtons(a.did)}
            <button class="pc-btn" data-dv="unaudition" data-did="${esc(a.did)}">${a.followed ? 'Done' : 'Drop'}</button>
          </div></div></div>`).join('')}</section>`
    : ''

  const list = d.candidates.slice(0, dv.shown)
  $('#dvList').innerHTML = list.length
    ? `<section class="trend-section"><div class="trend-section-head"><h3>Suggested</h3><small>${d.candidates.length} people</small></div>
      ${list.map((c) => {
        const why = [
          `On topic on <b>${c.days}</b> of the last ${d.days} days`,
          `${c.onTopic} post${c.onTopic === 1 ? '' : 's'}${c.replies ? ` (${c.replies} replies)` : ''}`,
          c.focus !== null ? `${c.focusCapped ? '≤' : ''}${Math.round(c.focus * 100)}% of what they post` : null,
          c.resharedBy ? `reshared by ${c.resharedBy} you follow` : null,
          c.experts ? `followed by ${c.experts} of your experts` : null,
        ].filter(Boolean).join(' · ')
        return `<div class="dv-row" data-did="${esc(c.did)}">
          <button class="avatar-btn" data-profile="${esc(c.did)}"><img class="avatar" loading="lazy" src="${esc(c.avatar ?? '')}" alt=""></button>
          <div class="dv-main">
            <div><b data-profile="${esc(c.did)}">${esc(c.displayName || c.handle)}</b> <span class="dim">@${esc(c.handle)}</span>
              ${c.keywords.slice(0, 3).map((id) => `<span class="kw-tag">${esc(kwName(id))}</span>`).join(' ')}
              ${c.highVolume ? '<span class="kw-tag hidden-tag" title="Dozens of on-topic posts a day; often a bot or news feed">high volume</span>' : ''}
              ${c.automated ? '<span class="kw-tag hidden-tag" title="Its name or handle says it is a bot or feed">automated</span>' : ''}</div>
            <div class="dv-why">${why}</div>
            <div class="dv-actions">
              <button class="pc-btn" data-dv="posts" data-did="${esc(c.did)}" data-handle="${esc(c.handle)}">Their posts</button>
              <button class="pc-btn" data-dv="audition" data-did="${esc(c.did)}" data-handle="${esc(c.handle)}" title="Collect their posts for a while without following">Audition</button>
              ${followButtons(c.did)}
              <button class="link-btn" data-dv="dismiss" data-did="${esc(c.did)}" data-handle="${esc(c.handle)}">Not interested</button>
            </div></div>
          <span class="dv-score" title="Ranking score">${c.score}</span></div>`
      }).join('')}</section>`
    : `<div class="feed-end">No one yet. People need on-topic posts on at least 2 different days to show up here.</div>`
  $('#dvMore').innerHTML = d.candidates.length > dv.shown ? `<button class="link-btn" id="dvShowMore">Show more</button>` : ''
  $('#dvShowMore')?.addEventListener('click', () => { dv.shown += 30; renderDiscover() })
}

$('#dvKeyword').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]')
  if (!b) return
  dv.pick = b.dataset.value
  dv.shown = 30
  loadDiscover()
})
$('#dvMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]')
  if (!b) return
  dv.mode = b.dataset.value
  dv.shown = 30
  loadDiscover()
})
$('#dvRefresh').addEventListener('click', async () => {
  await api('/api/discover/refresh', {})
  toast('Refreshing network signals; this takes a minute or two')
  loadDiscover()
})

$('#discoverView').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dv]')
  if (b) discoverAction(b)
})

// Follow, Audition, Not interested… from a Discover row or the side panel
async function discoverAction(b) {
  const did = b.dataset.did
  const handle = b.dataset.handle
  const removeRow = () => document.querySelector(`#discoverView .dv-row[data-did="${CSS.escape(did)}"]`)?.remove()
  const inPanel = !!b.closest('#profilePanel')
  b.disabled = true
  try {
    switch (b.dataset.dv) {
      case 'posts':
        return openProfilePanel(did)
      case 'follow': {
        const slot = Number(b.dataset.slot)
        const res = await api('/api/follows/follow', { dids: [did], slots: [slot] })
        if (res.failed?.length) throw new Error(res.failed[0].error)
        toast(`Followed from ${acctName(slot)}`, {
          label: 'Undo',
          run: async () => {
            await api('/api/follows/unfollow', { dids: [did], slots: [slot] })
            loadDiscover()
            if (sp.did === did) renderPanel()
          },
        })
        if (inPanel) renderPanel(true)
        return loadDiscover()
      }
      case 'audition':
        await api('/api/discover/audition', { did, start: true })
        toast(`Auditioning @${handle}: their posts will be collected without following`)
        if (inPanel) b.replaceWith(Object.assign(document.createElement('span'), { className: 'dim', textContent: 'Auditioning' }))
        return loadDiscover()
      case 'unaudition':
        await api('/api/discover/audition', { did, start: false })
        return loadDiscover()
      case 'dismiss':
        await api('/api/discover/dismiss', { did })
        // In the panel, move on to the next person (the list is read before this row goes)
        if (inPanel) panelStep(1, true)
        removeRow()
        toast(`Won't suggest @${handle} again`, {
          label: 'Undo',
          run: async () => {
            await api('/api/discover/dismiss', { did, undo: true })
            loadDiscover()
          },
        })
        return
    }
  } catch (err) {
    toast(err.message)
  } finally {
    b.disabled = false
  }
}

// ---------- profile side panel (Discover's "Their posts") ----------
// A snapshot of someone from their last 100 posts, plus their recent posts, without leaving your place.
// ← / → step through the Discover list; Esc closes.

const sp = { did: null, list: [], replies: false, shown: 5, snap: null, profile: null }

function panelList() {
  return [...new Set([...document.querySelectorAll('#discoverView [data-dv="posts"]')].map((b) => b.dataset.did))]
}

function openProfilePanel(did) {
  sp.list = state.view === 'discover' ? panelList() : []
  showPanelFor(did)
}

function showPanelFor(did) {
  sp.did = did
  sp.shown = 5
  sp.snap = null
  sp.profile = null
  $('#profilePanel').hidden = false
  document.body.classList.add('panel-open')
  document.querySelectorAll('.dv-row.dv-current').forEach((r) => r.classList.remove('dv-current'))
  const row = document.querySelector(`#discoverView .dv-row[data-did="${CSS.escape(did)}"]`)
  row?.classList.add('dv-current')
  row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  const i = sp.list.indexOf(did)
  $('#spPos').textContent = i >= 0 ? `${i + 1} of ${sp.list.length}` : ''
  $('#spPrev').disabled = i <= 0
  $('#spNext').disabled = i < 0 || i >= sp.list.length - 1
  $('#spBody').innerHTML = '<p class="dim">Reading their last 100 posts…</p>'
  $('#spBody').scrollTop = 0
  renderPanel(true)
}

// fresh: read the profile again (after a follow); the snapshot is cached on the server for 10 minutes
async function renderPanel(fresh = false) {
  const did = sp.did
  try {
    const [profile, snap] = await Promise.all([fetchProfile(did, fresh), sp.snap ? Promise.resolve(sp.snap) : api(`/api/snapshot?actor=${encodeURIComponent(did)}`)])
    if (sp.did !== did) return
    sp.profile = profile
    sp.snap = snap
    $('#spBody').innerHTML = panelHeader(profile) + panelSnapshot(snap) + panelPosts(snap)
    loadPanelActions()
  } catch (err) {
    if (sp.did === did) $('#spBody').innerHTML = `<p class="error">Couldn't load this profile: ${esc(err.message)}</p>`
  }
}

function panelHeader(p) {
  const rel = p.relationship ?? {}
  const following = state.accounts.filter((a) => rel[a.slot]?.following)
  const follows = state.accounts.map((a) => rel[a.slot]?.following
    ? followPill(p.did, a.slot, true, 'following')
    : `<button class="pc-btn follow" data-dv="follow" data-slot="${a.slot}" data-did="${esc(p.did)}">${badge(a.slot)} Follow</button>`).join('')
  const inDiscover = !!document.querySelector(`#discoverView .dv-row[data-did="${CSS.escape(p.did)}"]`)
  const auditioning = !!document.querySelector(`#dvAuditions .dv-row[data-did="${CSS.escape(p.did)}"]`)
  const followsYou = state.accounts.filter((a) => rel[a.slot]?.followedBy)
  return `<div class="sp-head">
      <img class="pc-avatar" src="${esc(p.avatar ?? '')}" alt="">
      <div><b>${esc(p.displayName || p.handle)}</b><div class="dim">@${esc(p.handle)}</div>
        <div class="pc-tags">${followsYouTag(followsYou.map((a) => a.slot))}</div></div>
    </div>
    ${p.description ? `<div class="pc-bio">${linkify(p.description)}</div>` : ''}
    <div class="pc-counts"><span><b>${fmtCount(p.followersCount)}</b> followers</span><span><b>${fmtCount(p.followsCount)}</b> following</span><span><b>${fmtCount(p.postsCount)}</b> posts</span>${p.createdAt ? `<span class="dim">joined ${new Date(p.createdAt).toLocaleDateString([], { month: 'short', year: 'numeric' })}</span>` : ''}</div>
    <div class="pc-actions">
      ${follows}
      ${inDiscover && !auditioning && !following.length ? `<button class="pc-btn" data-dv="audition" data-did="${esc(p.did)}" data-handle="${esc(p.handle)}" title="Collect their posts for a while without following">Audition</button>` : ''}
      ${inDiscover && !auditioning ? `<button class="link-btn" data-dv="dismiss" data-did="${esc(p.did)}" data-handle="${esc(p.handle)}">Not interested</button>` : ''}
      ${following.length ? `<button class="pc-btn" data-sp="following" title="Their posts in your Following feed">In Following ›</button>` : ''}
      <a class="pc-btn" href="https://bsky.app/profile/${esc(p.handle)}" target="_blank" rel="noopener">Bluesky ↗</a>
    </div>`
}

function panelSnapshot(s) {
  if (!s.count) return '<div class="sp-section"><p class="dim">No posts yet.</p></div>'
  const total = s.mix.posts + s.mix.replies + s.mix.quotes + s.mix.reposts || 1
  const pct = (n) => Math.round((n / total) * 100)
  const parts = [['own', 'Own posts', s.mix.posts], ['reply', 'Replies', s.mix.replies], ['quote', 'Quotes', s.mix.quotes], ['repost', 'Reposts', s.mix.reposts]]
  const top = parts.slice().sort((a, b) => b[2] - a[2])[0]
  const style = { own: 'mostly writes their own posts', reply: 'mostly talks in replies', quote: 'mostly quote-posts others', repost: 'mostly reposts others' }[top[0]]
  // Active hours, in your time zone
  const hours = new Array(24).fill(0)
  for (const t of s.times) hours[new Date(t).getHours()]++
  const peak = Math.max(...hours, 1)
  const best = hours.indexOf(peak)
  const hourName = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })
  const maxTopic = Math.max(...s.topics.map((t) => t.count), 1)
  return `<div class="sp-section">
      <h4>What they post about</h4>
      ${s.topics.length
        ? `<div class="sp-topics">${s.topics.map((t) => `<span class="sp-topic ${t.kind}" style="font-size:${(0.85 + 0.65 * (t.count / maxTopic)).toFixed(2)}em" title="In ${t.count} posts">${esc(t.label)}</span>`).join('')}</div>`
        : '<p class="dim">No repeated topics in their recent posts.</p>'}
    </div>
    <div class="sp-section">
      <h4>Kind of poster <small class="dim">· ${esc(style)}</small></h4>
      <div class="sp-mix">${parts.filter((p) => p[2]).map(([k, l, n]) => `<span class="mix-${k}" style="flex:${n}" title="${l}: ${n} (${pct(n)}%)"></span>`).join('')}</div>
      <div class="sp-legend">${parts.filter((p) => p[2]).map(([k, l, n]) => `<span><i class="mix-${k}"></i>${l} ${pct(n)}%</span>`).join('')}</div>
      <div class="dim">${s.mediaShare}% of their own posts have photos or video</div>
    </div>
    <div class="sp-section">
      <h4>How often</h4>
      <div>About <b>${s.perDay}</b> a day <span class="dim">(last ${s.count} posts over ${s.days} days)</span>${s.perDay >= 20 ? ' <span class="kw-tag hidden-tag">busy</span>' : ''}</div>
      <div class="sp-hours" title="When they post, in your time zone">${hours.map((n, h) => `<span style="height:${Math.round((n / peak) * 100)}%" title="${hourName(h)}: ${n}"></span>`).join('')}</div>
      <div class="sp-hours-axis dim"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span></span></div>
      <div class="dim">Busiest around ${hourName(best)}</div>
    </div>
    ${s.reception ? `<div class="sp-section"><h4>How their posts land</h4><div>Per post, on average: <b>${s.reception.likes}</b> likes · <b>${s.reception.replies}</b> replies · <b>${s.reception.reposts}</b> reposts</div></div>` : ''}
    ${s.domains.length ? `<div class="sp-section"><h4>Sites they link</h4><div class="sp-topics">${s.domains.map((d) => `<span class="sp-topic link">${esc(d.host)} <small class="dim">${d.count}</small></span>`).join('')}</div></div>` : ''}
    ${s.talksWith.length ? `<div class="sp-section"><h4>Who they talk with</h4><div class="sp-people">${s.talksWith.map((p) => `<button class="sp-person" data-profile="${esc(p.did)}">
        <img class="avatar" src="${esc(p.avatar ?? '')}" alt=""><span><b>${esc(p.displayName || p.handle)}</b>
        <small class="dim">${[p.replies ? `${p.replies} repl${p.replies === 1 ? 'y' : 'ies'}` : '', p.reposts ? `${p.reposts} repost${p.reposts === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}${p.you ? ' · <b>you</b>' : p.followed ? ' · you follow' : ''}</small></span></button>`).join('')}</div></div>` : ''}`
}

function panelPosts(s) {
  const list = s.posts.filter((p) => sp.replies || p.kind !== 'reply')
  const shown = list.slice(0, sp.shown)
  return `<div class="sp-section">
      <h4>Recent posts</h4>
      <div class="seg sp-seg"><button data-sp="originals" class="${sp.replies ? '' : 'on'}">Posts</button><button data-sp="replies" class="${sp.replies ? 'on' : ''}">Posts &amp; replies</button></div>
      ${shown.length ? shown.map((p) => {
        const known = state.posts.get(p.post.uri)
        return `<div class="card sp-post">${p.kind === 'reply' ? `<div class="dim sp-replyto">↩ Replying to @${esc(p.replyTo ?? 'someone')}</div>` : ''}${renderPost(known?.post ?? p.post)}
          ${known ? renderActions(known.post, known.viewer) : `<div class="actions-pending" data-pending-uri="${esc(p.post.uri)}"></div>`}</div>`
      }).join('')
        : '<p class="dim">Nothing here in their last 100.</p>'}
      ${list.length > sp.shown ? '<button class="link-btn" data-sp="more">Show 5 more</button>' : ''}
    </div>`
}

// Like / repost / reply / quote on the panel's posts: each account's state is read from Bluesky
// (the snapshot is read logged out), then the buttons are drawn the same as in the feed
async function loadPanelActions() {
  const pending = [...document.querySelectorAll('#spBody [data-pending-uri]')]
  if (!pending.length) return
  const did = sp.did
  try {
    const { items } = await api(`/api/posts?uris=${encodeURIComponent(pending.map((el) => el.dataset.pendingUri).join(','))}`)
    if (sp.did !== did) return
    const followedBy = state.accounts.filter((a) => sp.profile?.relationship?.[a.slot]?.following).map((a) => a.slot)
    for (const it of items) {
      applyLocalActions(it.post, it.viewer)
      state.posts.set(it.post.uri, { post: it.post, viewer: it.viewer, followedBy })
      document.querySelectorAll(`#spBody [data-pending-uri="${CSS.escape(it.post.uri)}"]`).forEach((el) => (el.outerHTML = renderActions(it.post, it.viewer)))
    }
  } catch {}
}

function panelStep(dir, afterRemove = false) {
  const i = sp.list.indexOf(sp.did)
  const next = sp.list[i + dir]
  if (afterRemove) sp.list.splice(i, 1)
  if (next) showPanelFor(next)
  else if (afterRemove) closePanel()
}

function closePanel() {
  $('#profilePanel').hidden = true
  document.body.classList.remove('panel-open')
  sp.did = null
  document.querySelectorAll('.dv-row.dv-current').forEach((r) => r.classList.remove('dv-current'))
}

$('#spPrev').addEventListener('click', () => panelStep(-1))
$('#spNext').addEventListener('click', () => panelStep(1))
$('#spClose').addEventListener('click', closePanel)
$('#profilePanel').addEventListener('click', (e) => {
  const dvBtn = e.target.closest('[data-dv]')
  if (dvBtn) return discoverAction(dvBtn)
  const b = e.target.closest('[data-sp]')
  if (!b) return
  if (b.dataset.sp === 'originals' || b.dataset.sp === 'replies') {
    sp.replies = b.dataset.sp === 'replies'
    sp.shown = 5
  } else if (b.dataset.sp === 'more') {
    sp.shown += 5
  } else if (b.dataset.sp === 'following') {
    const p = sp.profile
    closePanel()
    return showAuthor(p.did, p.handle)
  }
  const section = $('#spBody .sp-section:last-child')
  if (section && sp.snap) section.outerHTML = panelPosts(sp.snap)
  loadPanelActions()
})
document.addEventListener('keydown', (e) => {
  if ($('#profilePanel').hidden || e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return
  if (e.key === 'Escape') closePanel()
  else if (e.key === 'ArrowRight' && !$('#spNext').disabled) panelStep(1)
  else if (e.key === 'ArrowLeft' && !$('#spPrev').disabled) panelStep(-1)
  else return
  e.preventDefault()
})

// ---------- "Like as" menu ----------

async function openLikeAs(btn, uri) {
  closeLikeAs()
  const r = btn.getBoundingClientRect() // before the refresh redraws the button
  const fresh = await refreshPost(uri)
  if (!fresh) return toast('That post is no longer available')
  const known = state.posts.get(uri)
  const followers = new Set(known?.followedBy ?? [])
  const accts = [...state.accounts].sort((a, b) => Number(followers.has(b.slot)) - Number(followers.has(a.slot)) || a.slot - b.slot)
  const menu = document.createElement('div')
  menu.id = 'likeAsMenu'
  menu.className = 'share-menu like-as'
  menu.setAttribute('role', 'menu')
  menu.innerHTML = `<div class="dim like-as-title">Like as…</div>` + accts.map((a) => {
    const liked = !!fresh.viewer?.[a.slot]?.like
    return `<button type="button" role="menuitem" data-like-as="${a.slot}">${badge(a.slot)} <span>${liked ? 'Remove like' : 'Like'} as @${esc(a.handle)}</span>${liked ? ' <span class="liked">♥</span>' : ''}${followers.has(a.slot) ? '' : ' <small class="dim">not following</small>'}</button>`
  }).join('')
  topLayerHost().append(menu)
  menu.style.left = `${Math.min(Math.max(8, r.left), innerWidth - menu.offsetWidth - 8)}px`
  const below = r.bottom + 4
  menu.style.top = `${below + menu.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 4) : below}px`
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-like-as]')
    if (!b) return
    e.stopPropagation()
    closeLikeAs()
    try {
      await toggle(uri, 'like', Number(b.dataset.likeAs), true)
    } catch (err) {
      toast(err.message)
    }
  })
}
function closeLikeAs() {
  document.getElementById('likeAsMenu')?.remove()
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#likeAsMenu') && !e.target.closest('[data-act="like"]')) closeLikeAs()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLikeAs()
})

// ---------- follow pills ----------

async function setFollow(did, slot, on) {
  const res = await api(`/api/follows/${on ? 'follow' : 'unfollow'}`, { dids: [did], slots: [slot] })
  if (res.failed?.length) throw new Error(res.failed[0].error)
  pc.cache.delete(did)
  document.querySelectorAll(`[data-follow-pill][data-did="${CSS.escape(did)}"][data-slot="${slot}"]`).forEach((b) => {
    b.outerHTML = followPill(did, slot, on, b.dataset.label)
  })
  markUnfollowed(did, on || state.accounts.some((a) => a.slot !== slot && document.querySelector(`[data-follow-pill].on[data-did="${CSS.escape(did)}"][data-slot="${a.slot}"]`)))
}

// Capture phase, so the click doesn't also open the post or the profile card underneath
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-follow-pill]')
  if (!b) return
  e.preventDefault()
  e.stopPropagation()
  const { did } = b.dataset
  const slot = Number(b.dataset.slot)
  const on = !b.classList.contains('on')
  b.disabled = true
  try {
    await setFollow(did, slot, on)
    toast(on ? `Followed from ${acctName(slot)}` : `Unfollowed from ${acctName(slot)}`, {
      label: 'Undo',
      run: () => setFollow(did, slot, !on).catch((err) => toast(err.message)),
    })
  } catch (err) {
    b.disabled = false
    toast(err.message)
  }
}, true)

// ---------- muted words ----------

const mutedOpenKey = 'mutedOpen'
function mutedOpen() {
  const saved = safeGet(mutedOpenKey)
  return saved === null ? matchMedia('(min-width: 1280px)').matches : saved === '1'
}
function setMutedOpen(open) {
  $('#mbBody').hidden = !open
  $('#mbToggle').setAttribute('aria-expanded', String(open))
  $('#mutedBox').classList.toggle('open', open)
}

function renderMuted({ words, sync }) {
  $('#mbCount').textContent = words.length ? `(${words.length})` : ''
  $('#mbSync').innerHTML = !sync?.accounts ? ''
    : sync.error ? `<span class="err" title="${esc(sync.error)}">Couldn't sync with Bluesky; trying again in a few minutes</span>`
    : `Shared with Bluesky's muted words on your ${sync.accounts === 1 ? 'account' : `${sync.accounts} accounts`}${sync.lastMs ? ` · synced ${ago(new Date(sync.lastMs).toISOString())} ago` : ''}`
  $('#mbList').innerHTML = words.length
    ? words.map((w) => `<li><span class="mb-word">${esc(w.text)}${w.expiresAt ? ` <small class="dim">until ${esc(new Date(w.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</small>` : ''}</span>
        <small class="dim" title="Posts from the last day that this hides">${w.hiddenToday ? `${w.hiddenToday} today` : ''}</small>
        <button type="button" class="icon-btn" data-unmute="${w.id}" aria-label="Unmute ${esc(w.text)}" title="Unmute">✕</button></li>`).join('')
    : '<li class="dim">Nothing muted.</li>'
}

async function loadMuted() {
  try {
    renderMuted(await api('/api/muted'))
  } catch {}
}

// After a change, show the current view again without the muted posts (or with the unmuted ones)
function refreshAfterMute() {
  if (['following', 'keywords', 'trending', 'lists'].includes(state.view)) showView(state.view)
}

$('#mbToggle').addEventListener('click', () => {
  const open = $('#mbBody').hidden
  safeSet(mutedOpenKey, open ? '1' : '0')
  setMutedOpen(open)
})
$('#mbForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('#mbInput').value.trim()
  if (!text) return
  const btn = $('#mbForm button')
  btn.disabled = true
  try {
    renderMuted(await api('/api/muted/add', { text }))
    $('#mbInput').value = ''
    toast(`Muted “${text}”`)
    refreshAfterMute()
  } catch (err) {
    toast(err.message)
  } finally {
    btn.disabled = false
  }
})
$('#mbList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-unmute]')
  if (!b) return
  const text = b.closest('li')?.querySelector('.mb-word')?.textContent ?? ''
  try {
    b.disabled = true
    renderMuted(await api('/api/muted/remove', { id: Number(b.dataset.unmute) }))
    toast(`Unmuted “${text}”`, {
      label: 'Undo',
      run: async () => {
        renderMuted(await api('/api/muted/add', { text }))
        refreshAfterMute()
      },
    })
    refreshAfterMute()
  } catch (err) {
    toast(err.message)
  }
})
setMutedOpen(mutedOpen())
loadMuted()
// Words added or removed in the Bluesky app reach the server every 10 minutes; pick them up here too
setInterval(loadMuted, 5 * 60_000)

// ---------- video player ----------
// Bluesky videos are HLS streams. Safari plays them itself; other browsers use hls.js, loaded the first
// time a video is played (public/vendor). Click to play in place; ⤢ opens a large viewer.

let hlsReady = null
function loadHls() {
  hlsReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'vendor/hls.light.min.js'
    s.onload = () => resolve(window.Hls)
    s.onerror = () => {
      hlsReady = null
      reject(new Error("Couldn't load the video player"))
    }
    document.head.append(s)
  })
  return hlsReady
}

// Safari's own HLS playback is the best there (AirPlay, battery). Chrome and Edge also claim HLS support,
// but it isn't reliable everywhere, so they use hls.js; built-in playback that fails falls back to it too.
const SAFARI = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Android|Firefox/.test(navigator.userAgent)

async function attachStream(video, url) {
  video._hls?.destroy()
  video._hls = null
  if (SAFARI && video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
    video.addEventListener('error', () => attachHls(video, url).catch((err) => toast(err.message)), { once: true })
    return
  }
  await attachHls(video, url)
}

async function attachHls(video, url) {
  video.removeAttribute('src')
  const Hls = await loadHls()
  if (!Hls?.isSupported()) throw new Error("This browser can't play Bluesky videos")
  const hls = new Hls({ capLevelToPlayerSize: true })
  hls.loadSource(url)
  hls.attachMedia(video)
  video._hls = hls
}

async function playInline(box) {
  if (box.querySelector('video')) return
  const v = document.createElement('video')
  v.controls = true
  v.playsInline = true
  v.preload = 'auto'
  v.setAttribute('aria-label', box.dataset.alt || 'Video')
  v.poster = box.querySelector('img')?.src ?? ''
  box.querySelector('img, .video-blank')?.replaceWith(v)
  box.querySelector('.video-play')?.remove()
  box.classList.add('playing')
  try {
    await attachStream(v, box.dataset.video)
    await v.play().catch(() => {}) // the controls are there if the browser blocks autoplay
  } catch (err) {
    toast(err.message)
  }
}

async function openBigVideo(box) {
  const inline = box.querySelector('video')
  const at = inline?.currentTime ?? 0
  inline?.pause()
  const big = $('#videoBig')
  big.setAttribute('aria-label', box.dataset.alt || 'Video')
  $('#videoDialog').showModal()
  try {
    await attachStream(big, box.dataset.video)
    if (at) big.addEventListener('loadedmetadata', () => (big.currentTime = at), { once: true })
    await big.play().catch(() => {})
  } catch (err) {
    toast(err.message)
  }
}
$('#videoDialog').addEventListener('close', () => {
  const big = $('#videoBig')
  big.pause()
  big._hls?.destroy()
  big._hls = null
  big.removeAttribute('src')
  big.load()
})

// A video-site link: swap the preview for the site's own player. Only one plays at a time, so any
// other site player goes back to its preview and Bluesky videos pause.
function stopLinkPlayers(except) {
  for (const box of document.querySelectorAll('.vlink.playing')) {
    if (box === except) continue
    box.querySelector('iframe')?.replaceWith(box._preview ?? document.createElement('div'))
    box.classList.remove('playing')
    if (!box.querySelector('.video-play')) box.querySelector('.vlink-media').insertAdjacentHTML('beforeend', '<button type="button" class="video-play" aria-label="Play video">▶</button>')
  }
}
function playLink(box) {
  if (box.querySelector('iframe')) return
  stopLinkPlayers(box)
  for (const v of document.querySelectorAll('video')) if (!v.paused) v.pause()
  const f = document.createElement('iframe')
  f.src = box.dataset.embed
  f.title = box.dataset.alt || 'Video'
  f.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
  f.allowFullscreen = true
  f.referrerPolicy = 'strict-origin-when-cross-origin'
  const preview = box.querySelector('img, .video-blank')
  box._preview = preview
  preview?.replaceWith(f)
  box.querySelector('.video-play')?.remove()
  box.classList.add('playing')
}
document.addEventListener('click', (e) => {
  const box = e.target.closest('.vlink[data-embed]')
  if (!box || e.target.closest('.vlink-cap, iframe')) return
  e.preventDefault()
  e.stopPropagation()
  const blurred = box.querySelector('img.blurred')
  if (blurred) return blurred.classList.remove('blurred')
  playLink(box)
}, true)

// Capture phase, so a click on a video doesn't also open the thread or quote it sits in
document.addEventListener('click', (e) => {
  const box = e.target.closest('.video[data-video]')
  if (!box) return
  const blurred = box.querySelector('img.blurred')
  e.preventDefault()
  e.stopPropagation()
  if (blurred) return blurred.classList.remove('blurred') // first click shows a sensitive video's picture
  if (e.target.closest('.video-expand')) return openBigVideo(box)
  if (!e.target.closest('video')) playInline(box)
}, true)

// Only one video plays at a time
document.addEventListener('play', (e) => {
  for (const v of document.querySelectorAll('video')) if (v !== e.target && !v.paused) v.pause()
  stopLinkPlayers()
}, true)

// ---------- follows ----------

const DAY = 86_400_000
const fv = {
  rows: [],
  days: 14,
  overlap: 'all',
  search: '',
  quick: new Set(),
  lowN: 3,
  // Sort columns in order; the first decides, the rest break ties. Kept per view (your follows, analyses).
  sorts: [],
  selected: new Set(),
  shown: 150,
  // Your curated lists (both accounts) and who is on each: { lists: [{ uri, name, slot, count }], byDid: { did: [uri] } }
  lists: { lists: [], byDid: {} },
  listFilter: '', // '' any, 'none' not on any list, or a list's uri
  // 'mine' = your follows; 'ext' = the follows of another account (fv.target), from /api/analyze
  mode: 'mine',
  target: null,
  pollTimer: null,
}
// 'ext' is one other account's follows, 'group' several accounts' together
const isExt = () => fv.mode === 'ext' || fv.mode === 'group'
const isGroup = () => fv.mode === 'group'
const targetKey = (t) => (t?.kind === 'group' ? t.id : t?.did)
const groupSize = () => fv.target?.members?.length ?? 0
fv.atLeastN = 2
// Reopen the last analysis after a reload (if it's gone, the Follows tab falls back to your own follows)
{
  const key = safeGet('fvTarget')
  if (key) {
    fv.target = key.startsWith('did:') ? { kind: 'single', did: key } : { kind: 'group', id: key }
    fv.mode = fv.target.kind === 'group' ? 'group' : 'ext'
  }
}

const listsOf = (did) => fv.lists.byDid[did] ?? []
const listByUri = (uri) => fv.lists.lists.find((l) => l.uri === uri)

async function refreshMemberships() {
  try {
    fv.lists = await api('/api/lists/memberships')
  } catch (err) {
    toast(`Couldn't read your lists: ${err.message}`)
  }
  renderListFilter()
}

function renderListFilter() {
  const sel = $('#fvListSel')
  if (fv.listFilter && fv.listFilter !== 'none' && !listByUri(fv.listFilter)) fv.listFilter = ''
  sel.innerHTML = `<option value="">Any list</option><option value="none">Not on any list</option>` +
    fv.lists.lists.map((l) => `<option value="${esc(l.uri)}">On ${LETTERS[l.slot]} · ${esc(l.name)} (${l.count})</option>`).join('')
  sel.value = fv.listFilter
}

function listChips(did) {
  const uris = listsOf(did)
  if (!uris.length) return '<span class="dim">—</span>'
  const chips = uris.slice(0, 2).map((u) => {
    const l = listByUri(u)
    return l ? `<span class="list-chip acct-${l.slot}" title="${esc(acctName(l.slot))}'s list">${esc(l.name)}</span>` : ''
  }).join('')
  return chips + (uris.length > 2 ? `<span class="dim"> +${uris.length - 2}</span>` : '')
}

function daysAgo(ms) {
  if (!ms) return null
  return Math.floor((Date.now() - ms) / DAY)
}

async function loadFollows() {
  renderRecentAnalyses()
  if (isExt()) return loadAnalysis()
  setFollowsMode('mine')
  try {
    const [data] = await Promise.all([api('/api/follows'), refreshMemberships()])
    fv.rows = data.rows
    fv.days = data.days
    const known = new Set(fv.rows.map((r) => r.did))
    for (const did of fv.selected) if (!known.has(did)) fv.selected.delete(did)
    renderFollowsNote(data)
    renderOverlap()
    renderFollows()
  } catch (err) {
    $('#fvNote').textContent = `Couldn't load follows: ${err.message}`
  }
}

function renderFollowsNote(data) {
  const parts = []
  if (data.history.running && data.history.deep) {
    parts.push(`<b>Reading ${data.days} days of history: ${data.history.done} of ${data.history.total} accounts.</b> Post counts will keep rising until this finishes.`)
  }
  const notes = Object.entries(data.notifications ?? {})
    .map(([slot, n]) => n.error ? `${LETTERS[slot]}: couldn't read notifications` : n.oldestMs ? `${LETTERS[slot]} back to ${new Date(n.oldestMs).toLocaleDateString()}` : null)
    .filter(Boolean)
  if (notes.length) parts.push(`"Interacted" comes from your notifications (${notes.join(', ')}).`)
  else parts.push('"Interacted" fills in once your notifications have been read.')
  $('#fvNote').innerHTML = parts.join(' ')
}

function renderOverlap() {
  const n = (f) => fv.rows.filter(f).length
  const opts = [['all', `All ${fv.rows.length}`]]
  if (isExt()) {
    if (!['all', 'new', 'mine'].includes(fv.overlap)) fv.overlap = 'all'
    opts.push(['new', `New to me ${n(isNewToMe)}`])
    opts.push(['mine', `You follow ${n((r) => r.followedBy.length > 0)}`])
  } else if (state.accounts.length >= 2) {
    if (['new', 'mine'].includes(fv.overlap)) fv.overlap = 'all'
    const all = state.accounts.length
    opts.push(['both', `${allLabel()} ${n((r) => r.followedBy.length === all)}`])
    for (const { slot } of state.accounts) {
      opts.push([`only${slot}`, `${LETTERS[slot]} only ${n((r) => r.followedBy.length === 1 && r.followedBy[0] === slot)}`])
    }
  }
  $('#fvOverlap').innerHTML = opts.map(([v, l]) => `<button data-value="${v}" class="${fv.overlap === v ? 'on' : ''}">${esc(l)}</button>`).join('')
}

function filteredFollows() {
  const q = fv.search.toLowerCase()
  const quietMs = Date.now() - fv.days * DAY
  return fv.rows.filter((r) => {
    if (fv.overlap === 'new' && !isNewToMe(r)) return false
    if (fv.overlap === 'mine' && !r.followedBy.length) return false
    if (fv.overlap === 'both' && r.followedBy.length !== state.accounts.length) return false
    if (fv.overlap.startsWith('only') && !(r.followedBy.length === 1 && r.followedBy[0] === Number(fv.overlap.slice(4)))) return false
    if (q && !`${r.handle ?? ''} ${r.displayName ?? ''}`.toLowerCase().includes(q)) return false
    if (fv.quick.has('quiet') && r.lastActiveMs > quietMs) return false
    if (fv.quick.has('low') && r.posts + r.replies > fv.lowN) return false
    // "Doesn't follow back" means not back to any account of yours that follows them
    if (!isExt() && fv.quick.has('noback') && r.followedBy.some((s) => r.followsBack.includes(s))) return false
    if (fv.quick.has('never') && r.interactions > 0) return false
    if (fv.quick.has('reposty') && !(r.repostShare >= 0.8 && r.posts + r.replies + r.reposts >= 5)) return false
    if (fv.quick.has('muted') && !r.muted.length) return false
    if (fv.quick.has('gone') && !r.gone) return false
    if (isGroup() && fv.quick.has('atleast') && (r.groupCount ?? 0) < fv.atLeastN) return false
    if (fv.listFilter === 'none' && listsOf(r.did).length) return false
    if (fv.listFilter && fv.listFilter !== 'none' && !listsOf(r.did).includes(fv.listFilter)) return false
    return true
  })
}

function sortValue(r, key) {
  switch (key) {
    case 'name': return (r.displayName || r.handle || '').toLowerCase()
    case 'followedBy': return r.followedBy.join('')
    case 'followsBack': return isExt() ? (r.followsTarget ? 1 : 0) : r.followsBack.length
    case 'lists': return listsOf(r.did).length
    case 'repostShare': return r.repostShare ?? -1
    default: return r[key] ?? -1
  }
}

function renderFollows() {
  const rows = filteredFollows()
  if (!fv.sorts.length) fv.sorts = loadSorts(fv.mode)
  updateFvQuickToggle()
  rows.sort((a, b) => {
    for (const { key, dir } of fv.sorts) {
      const x = sortValue(a, key)
      const y = sortValue(b, key)
      if (x < y) return -dir
      if (x > y) return dir
    }
    return 0
  })
  fv.visible = rows
  renderSortHeaders()

  const quietMs = Date.now() - fv.days * DAY
  $('#fvBody').innerHTML = rows.slice(0, fv.shown).map((r) => {
    const d = daysAgo(r.lastActiveMs)
    const last = d === null ? `<span class="dim" title="No posts seen">—</span>` : d === 0 ? 'today' : `${d}d`
    const share = r.repostShare === null ? '<span class="dim">—</span>' : `${Math.round(r.repostShare * 100)}%`
    const back = isGroup()
      ? (r.followsTargetCount ? `${r.followsTargetCount} of ${groupSize()}` : '<span class="dim">0</span>')
      : isExt()
      ? (r.followsTarget ? `<span title="Follows @${esc(fv.target?.handle ?? '')}">✓</span>` : `<span class="dim" title="Doesn't follow @${esc(fv.target?.handle ?? '')}">✕</span>`)
      : r.followedBy.map((s) => r.followsBack.includes(s) ? badge(s, `Follows ${acctName(s)}`) : `<span class="dim" title="Doesn't follow ${esc(acctName(s))}">${LETTERS[s]}✕</span>`).join(' ')
    // In another account's view, numbers not read yet show a dash, and capped ones a "+"
    // Only the largest count is cut off when an account posts more than two pages in the period
    const top = Math.max(r.posts, r.replies, r.reposts)
    const num = (v) => isExt() && !r.read ? '<span class="dim">…</span>' : `${v}${r.capped && v === top && v > 0 ? '+' : ''}`
    const inter = r.interactions
      ? `<span title="${Object.entries(r.interactionsBySlot).map(([s, n]) => `${n} with ${acctName(s)}`).join(', ')}; last ${new Date(r.lastInteractionMs).toLocaleDateString()}">${r.interactions.toLocaleString()}</span>`
      : '<span class="dim">0</span>'
    return `<tr data-did="${esc(r.did)}" class="${fv.selected.has(r.did) ? 'sel' : ''}">
      <td class="pick-td"><input type="checkbox" data-pick ${fv.selected.has(r.did) ? 'checked' : ''} aria-label="Select ${esc(r.handle)}"></td>
      <td class="who-td"><div class="who-cell"><img loading="lazy" data-profile="${esc(r.did)}" src="${esc(r.avatar ?? '')}" alt="">
        <div>${r.gone
          ? `<b class="gone" title="Bluesky no longer shows this profile">Deleted or deactivated</b><small>${esc(r.handle ? '@' + r.handle : r.did)}</small>`
          : `<b data-profile="${esc(r.did)}">${esc(r.displayName || r.handle || r.did)}</b><small data-profile="${esc(r.did)}">${r.handle ? '@' + esc(r.handle) : 'Loading profile…'}${r.muted.length ? ' · muted' : ''}</small>`}</div></div></td>
      <td data-label="${isExt() ? 'You' : 'By'}">${r.followedBy.map((s) => followPill(r.did, s)).join(' ') || (isExt() ? '<span class="dim">—</span>' : '')}</td>
      ${isGroup() ? `<td class="num" data-label="Followed by" title="${esc(groupWho(r))}">${r.groupCount} of ${groupSize()}</td>` : ''}
      <td class="num" data-label="Posts">${num(r.posts)}</td>
      <td class="num" data-label="Replies">${num(r.replies)}</td>
      <td class="num" data-label="Reposts">${num(r.reposts)}</td>
      <td class="num" data-label="Repost %">${share}</td>
      <td class="num ${r.lastActiveMs && r.lastActiveMs < quietMs ? 'dim' : ''}" data-label="Last active">${last}</td>
      <td data-label="${isExt() ? 'Follows them' : 'Follows you'}">${back}</td>
      <td class="lists-td" data-label="Lists" data-row="lists" title="Change which lists they're on">${listChips(r.did)}</td>
      <td class="num" data-label="Interacted">${inter}</td>
      <td class="num" data-label="Followers">${r.followersCount?.toLocaleString() ?? '<span class="dim">—</span>'}</td>
      <td class="acts-cell"><div class="row-acts">${isExt() ? `
        ${r.followedBy.includes(state.actAs)
          ? `<span class="dim row-following">Following</span>`
          : `<button data-row="follow" class="good" title="Follow as ${esc(acctName(state.actAs))}">Follow</button>`}
        <button data-row="lists" title="Add to or remove from your lists">+ List</button>
        <a class="row-acts-link" href="https://bsky.app/profile/${esc(r.handle || r.did)}" target="_blank" rel="noopener" title="Open profile on bsky.app">↗</a>` : `
        <button data-row="posts" title="See their posts from the last ${fv.days} days">Posts</button>
        <button data-row="lists" title="Add to or remove from your lists">+ List</button>
        <a class="row-acts-link" href="https://bsky.app/profile/${esc(r.handle || r.did)}" target="_blank" rel="noopener" title="Open profile on bsky.app">↗</a>
        <button data-row="unfollow" class="bad" title="Unfollow">Unfollow</button>`}
      </div></td></tr>`
  }).join('')

  $('#fvMore').innerHTML = rows.length > fv.shown
    ? `Showing ${fv.shown} of ${rows.length}. <button class="link-btn" id="fvShowMore">Show more</button>`
    : rows.length ? `${rows.length} account${rows.length === 1 ? '' : 's'}` : 'No accounts match these filters.'
  $('#fvShowMore')?.addEventListener('click', () => { fv.shown += 300; renderFollows() })

  const shownDids = rows.slice(0, fv.shown).map((r) => r.did)
  $('#fvAll').checked = shownDids.length > 0 && shownDids.every((d) => fv.selected.has(d))
  renderBulk()
}

function renderBulk() {
  const n = fv.selected.size
  $('#fvBulk').hidden = n === 0
  $('#fvCount').textContent = `${n.toLocaleString()} selected`
  // Offer every row that matches the filters, not just the ones drawn so far
  const more = fv.visible.filter((r) => !fv.selected.has(r.did)).length
  $('#fvSelectAll').hidden = !n || !more
  $('#fvSelectAll').textContent = `Select all ${fv.visible.length.toLocaleString()} that match`
}

$('#fvOverlap').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]')
  if (!b) return
  fv.overlap = b.dataset.value
  fv.shown = 150
  renderOverlap()
  renderFollows()
})
$('#fvSearch').addEventListener('input', (e) => { fv.search = e.target.value.trim(); fv.shown = 150; renderFollows() })
$('#fvQuick').addEventListener('change', (e) => {
  if (e.target.id === 'fvAtLeastN') {
    fv.atLeastN = Math.min(10, Math.max(1, Number(e.target.value) || 1))
    if (!fv.quick.has('atleast')) return
  } else if (e.target.id === 'fvLowN') {
    fv.lowN = Math.max(0, Number(e.target.value) || 0)
    if (!fv.quick.has('low')) return
  } else if (e.target.dataset.q) {
    e.target.checked ? fv.quick.add(e.target.dataset.q) : fv.quick.delete(e.target.dataset.q)
  }
  fv.shown = 150
  renderFollows()
})
$('#fvLowN').addEventListener('click', (e) => e.preventDefault()) // typing in it shouldn't toggle the chip
$('#fvAtLeastN').addEventListener('click', (e) => e.preventDefault())
$('#fvAtLeastN').addEventListener('focus', (e) => e.target.select())
$('#fvLowN').addEventListener('focus', (e) => e.target.select())

// ---------- sorting by several columns ----------

const DEFAULT_SORTS = {
  mine: [{ key: 'lastActiveMs', dir: 1 }], // quietest first, for tidying up
  ext: [{ key: 'posts', dir: -1 }], // most active first, for finding people
  group: [{ key: 'groupCount', dir: -1 }, { key: 'posts', dir: -1 }], // followed by most of the group, then most active
}
const MAX_SORTS = 4
// Numbers sort high-to-low first, except name and "last active" (oldest, i.e. quietest, first)
const firstDir = (key) => (['name', 'lastActiveMs'].includes(key) ? 1 : -1)

function loadSorts(mode) {
  try {
    const saved = JSON.parse(safeGet(`fvSort:${mode}`) || 'null')
    if (Array.isArray(saved) && saved.length && saved.every((s) => s && typeof s.key === 'string' && (s.dir === 1 || s.dir === -1))) return saved.slice(0, MAX_SORTS)
  } catch {}
  return DEFAULT_SORTS[mode].map((s) => ({ ...s }))
}

function saveSorts() {
  safeSet(`fvSort:${fv.mode}`, JSON.stringify(fv.sorts))
}

// Click: sort by this column alone (again: flip). Shift-click: add it as the next tiebreaker (again: flip).
function setSort(key, add) {
  const i = fv.sorts.findIndex((s) => s.key === key)
  if (add) {
    if (i >= 0) fv.sorts[i].dir = -fv.sorts[i].dir
    else if (fv.sorts.length < MAX_SORTS) fv.sorts.push({ key, dir: firstDir(key) })
    else return toast(`Sort by at most ${MAX_SORTS} columns`)
  } else if (fv.sorts.length === 1 && i === 0) {
    fv.sorts[0].dir = -fv.sorts[0].dir
  } else {
    fv.sorts = [{ key, dir: firstDir(key) }]
  }
  saveSorts()
  renderFollows()
}

function sortLabel(key) {
  const th = document.querySelector(`.fv-table th[data-sort="${key}"]`)
  return th?.dataset.base ?? th?.textContent ?? key
}

function renderSortHeaders() {
  const many = fv.sorts.length > 1
  document.querySelectorAll('.fv-table th[data-sort]').forEach((th) => {
    th.dataset.base ??= th.textContent.replace(/ [▲▼]\d?$/, '')
    const i = fv.sorts.findIndex((s) => s.key === th.dataset.sort)
    th.classList.toggle('sorted', i >= 0)
    th.textContent = th.dataset.base + (i >= 0 ? ` ${fv.sorts[i].dir === 1 ? '▲' : '▼'}${many ? i + 1 : ''}` : '')
  })
  $('#fvSortBar').innerHTML = `<span class="dim">Sorted by</span>` + fv.sorts.map((s, i) => `<span class="sort-chip">
      ${many ? `<b>${i + 1}</b>` : ''}${esc(sortLabel(s.key))}
      <button type="button" data-sort-flip="${s.key}" title="${s.dir === 1 ? 'Ascending: click for descending' : 'Descending: click for ascending'}">${s.dir === 1 ? '▲' : '▼'}</button>
      ${fv.sorts.length > 1 ? `<button type="button" data-sort-rm="${s.key}" title="Stop sorting by this">×</button>` : ''}
    </span>`).join('') + `<span class="dim sort-hint">Shift-click a column to add a tiebreaker</span>`
  $('#fvSortSel').value = ''
}

document.querySelector('.fv-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]')
  if (!th) return
  window.getSelection()?.removeAllRanges() // shift-click would otherwise select the header text
  setSort(th.dataset.sort, e.shiftKey)
})

$('#fvSortBar').addEventListener('click', (e) => {
  const flip = e.target.closest('[data-sort-flip]')?.dataset.sortFlip
  const rm = e.target.closest('[data-sort-rm]')?.dataset.sortRm
  if (flip) {
    const s = fv.sorts.find((x) => x.key === flip)
    if (s) s.dir = -s.dir
  }
  if (rm) fv.sorts = fv.sorts.filter((x) => x.key !== rm)
  if (!flip && !rm) return
  saveSorts()
  renderFollows()
})

// On a phone the table becomes cards with no header row: this menu adds a column to the sort
$('#fvSortSel').addEventListener('change', (e) => {
  const key = e.target.value
  if (!key) return
  if (fv.sorts.some((s) => s.key === key)) setSort(key, false)
  else setSort(key, true)
})

function updateFvQuickToggle() {
  const n = document.querySelectorAll('#fvQuick input[type=checkbox]:checked').length
  $('#fvQuickToggle').textContent = n ? `Filters (${n})` : 'Filters'
}
$('#fvQuickToggle').addEventListener('click', (e) => {
  const open = $('#fvQuick').classList.toggle('open')
  e.target.setAttribute('aria-expanded', String(open))
})
$('#fvQuick').addEventListener('change', updateFvQuickToggle)

$('#fvAll').addEventListener('change', (e) => {
  for (const r of fv.visible.slice(0, fv.shown)) e.target.checked ? fv.selected.add(r.did) : fv.selected.delete(r.did)
  renderFollows()
})

$('#fvBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-did]')
  if (!tr) return
  const did = tr.dataset.did
  const row = fv.rows.find((r) => r.did === did)
  if (e.target.matches('[data-pick]')) {
    const on = e.target.checked
    // Shift-click: the same choice for every row between this one and the last one clicked
    const from = e.shiftKey && fv.lastPick ? fv.visible.findIndex((r) => r.did === fv.lastPick) : -1
    const to = fv.visible.findIndex((r) => r.did === did)
    if (from >= 0 && to >= 0) {
      const [a, b] = from < to ? [from, to] : [to, from]
      for (const r of fv.visible.slice(a, b + 1)) on ? fv.selected.add(r.did) : fv.selected.delete(r.did)
      fv.lastPick = did
      return renderFollows()
    }
    on ? fv.selected.add(did) : fv.selected.delete(did)
    tr.classList.toggle('sel', on)
    fv.lastPick = did
    renderBulk()
    return
  }
  const act = e.target.closest('[data-row]')?.dataset.row
  if (act === 'posts') showAuthor(did, row.handle)
  if (act === 'unfollow') openAction('unfollow', [did])
  if (act === 'lists') openListToggle(did)
  if (act === 'follow') quickFollow(did, e.target.closest('button'))
})

// One click: follow as the acting account, and update the row in place
async function quickFollow(did, btn) {
  const row = fv.rows.find((r) => r.did === did)
  const slot = state.actAs
  btn.disabled = true
  try {
    const res = await api('/api/follows/follow', { dids: [did], slots: [slot] })
    if (res.failed?.length) throw new Error(res.failed[0].error)
    if (row && !row.followedBy.includes(slot)) row.followedBy = [...row.followedBy, slot].sort()
    toast(`Followed @${row?.handle ?? did} as ${acctName(slot)}`)
    renderOverlap()
    renderFollows()
  } catch (err) {
    toast(err.message)
    btn.disabled = false
  }
}

// "New to me": neither of your accounts follows them, they're on none of your lists, and you haven't muted them
function isNewToMe(r) {
  return !r.followedBy.length && !listsOf(r.did).length && !r.muted.length
}

// ---------- another account's follows ----------

function setFollowsMode(mode) {
  if (fv.mode !== mode || !fv.sorts.length) fv.sorts = loadSorts(mode)
  fv.mode = mode
  const ext = mode !== 'mine'
  document.querySelectorAll('#followsView [data-mine-only], #followsView [data-group-only]').forEach((el) => {
    const show = el.hasAttribute('data-group-only') ? mode === 'group' : !ext
    el.hidden = !show
    const box = el.querySelector('input[data-q]')
    if (box && !show && box.checked) {
      box.checked = false
      fv.quick.delete(box.dataset.q)
    }
  })
  const th = (key) => document.querySelector(`.fv-table th[data-sort="${key}"]`)
  th('followedBy').dataset.base = ext ? 'You' : 'By'
  th('followsBack').dataset.base = ext ? 'Follows them' : 'Follows you'
  th('followsBack').title = mode === 'group' ? 'How many of the group they follow back' : ext ? `Whether they follow @${fv.target?.handle ?? ''} back` : 'Which of your accounts they follow'
  th('interactions').title = ext ? 'Their likes, replies, reposts, quotes and mentions of your accounts' : 'Likes, replies, reposts, quotes and mentions of your accounts'
  if (mode === 'mine') {
    clearTimeout(fv.pollTimer)
    fv.target = null
    $('#fvTargetBar').hidden = true
    safeSet('fvTarget', '')
  }
}

// Who in the group follows this row, for the "Followed by" tooltip
function groupWho(r) {
  const names = new Map((fv.target?.members ?? []).map((m) => [m.did, `@${m.handle}`]))
  return (r.members ?? []).map((d) => names.get(d) ?? d).join(', ')
}

function openTarget(t) {
  fv.target = t
  fv.selected.clear()
  fv.overlap = 'new'
  fv.shown = 150
  safeSet('fvTarget', targetKey(t))
  return loadAnalysis()
}

async function startAnalysis(handle, refresh = false) {
  try {
    const s = await api('/api/analyze', { handle, refresh })
    $('#fvAnalyzeInput').value = ''
    await openTarget(s)
  } catch (err) {
    toast(err.message)
  }
}

async function startGroup(dids, refresh = false) {
  try {
    const s = await api('/api/analyze/group', { dids, refresh })
    await openTarget(s)
    window.scrollTo({ top: 0 })
  } catch (err) {
    toast(err.message)
  }
}

let analysisSeq = 0
async function loadAnalysis() {
  const t = fv.target
  if (!targetKey(t)) return setFollowsMode('mine'), loadFollows()
  const group = t.kind === 'group'
  const seq = ++analysisSeq
  setFollowsMode(group ? 'group' : 'ext')
  clearTimeout(fv.pollTimer)
  try {
    const url = group ? `/api/analyze/group/rows?id=${encodeURIComponent(t.id)}` : `/api/analyze/rows?did=${encodeURIComponent(t.did)}`
    const [data] = await Promise.all([api(url), fv.lists.lists.length ? null : refreshMemberships()])
    if (seq !== analysisSeq || !isExt()) return
    fv.target = data.status
    fv.rows = data.rows
    fv.days = data.days
    const known = new Set(fv.rows.map((r) => r.did))
    for (const d of fv.selected) if (!known.has(d)) fv.selected.delete(d)
    $('#fvAtLeastN').max = String(groupSize() || 10)
    $('#fvNote').innerHTML = ''
    renderTargetBar()
    renderOverlap()
    renderFollows()
    // While it's still reading, show progress every few seconds and fill in the rows as they come
    if (data.status.running) fv.pollTimer = setTimeout(() => state.view === 'follows' && isExt() && loadAnalysis(), 4_000)
    else renderRecentAnalyses()
  } catch (err) {
    toast(`Couldn't load the analysis: ${err.message}`)
    setFollowsMode('mine')
    loadFollows()
  }
}

function renderTargetBar() {
  const t = fv.target
  const group = t.kind === 'group'
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0
  const when = t.finishedAt ? `read ${timeAgo(t.finishedAt)}` : ''
  const head = group
    ? `<div class="fv-target-avatars">${t.members.slice(0, 5).map((m) => `<img src="${esc(m.avatar ?? '')}" alt="" title="@${esc(m.handle)}" data-profile="${esc(m.did)}">`).join('')}</div>
      <div class="fv-target-names"><b>Who these ${t.members.length} accounts follow</b>
        <small>${t.members.map((m) => `@${esc(m.handle)}`).join(', ')} · ${fv.rows.length.toLocaleString()} accounts${when ? ` · ${when}` : ''}</small></div>`
    : `<img src="${esc(t.avatar ?? '')}" alt="" data-profile="${esc(t.did)}">
      <div class="fv-target-names"><b>Who ${esc(t.displayName || t.handle)} follows</b><small>@${esc(t.handle)} · ${t.total.toLocaleString()} accounts${when ? ` · ${when}` : ''}</small></div>`
  const reading = group ? t.members.find((m) => !m.finishedAt) : null
  $('#fvTargetBar').hidden = false
  $('#fvTargetBar').innerHTML = `
    <div class="fv-target-head">${head}
      <div class="fv-target-acts">
        ${t.running ? '' : '<button type="button" class="secondary" data-target="refresh">Refresh</button>'}
        <button type="button" class="secondary" data-target="back">Back to my follows</button>
      </div>
    </div>
    ${t.running ? `<div class="fv-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <div class="fv-note">${reading ? `Reading @${esc(reading.handle)}'s follows (${t.members.indexOf(reading) + 1} of ${t.members.length}). ` : ''}Each account's last ${fv.days} days: ${t.done.toLocaleString()} of ${t.total.toLocaleString()}. At most about ${Math.max(1, Math.ceil((t.total - t.done) / 400))} min left (less where they follow the same people); you can use the rows already read.</div>` : ''}
    ${t.error ? `<div class="error">${esc(t.error)}. <button type="button" class="link-btn" data-target="refresh">Try again</button></div>` : ''}
    ${!t.running && !t.error ? `<div class="fv-note">${group ? '"Followed by" is how many of the group follow them; "Follows them" how many of the group they follow back. ' : ''}"Interacted" counts their likes, replies, reposts, quotes and mentions of your accounts. Numbers with a + are higher than shown (very active accounts).</div>` : ''}`
}

function timeAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

async function renderRecentAnalyses() {
  let recent = []
  try {
    recent = await api('/api/analyze/recent')
  } catch {}
  const current = targetKey(fv.target)
  $('#fvRecent').innerHTML = recent.filter((r) => r && targetKey(r) !== current).slice(0, 6).map((r) => {
    const label = r.kind === 'group'
      ? `Group: ${r.members.slice(0, 2).map((m) => `@${esc(m.handle)}`).join(', ')}${r.members.length > 2 ? ` +${r.members.length - 2}` : ''}`
      : `@${esc(r.handle)}`
    return `<button type="button" class="chip" data-recent="${esc(targetKey(r))}" data-kind="${r.kind}" title="Read ${r.finishedAt ? timeAgo(r.finishedAt) : 'now'}">${label}${r.running ? ' (reading…)' : ''}</button>`
  }).join('')
}

$('#fvAnalyzeForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const handle = $('#fvAnalyzeInput').value.trim()
  if (handle) startAnalysis(handle)
})
$('#fvRecent').addEventListener('click', (e) => {
  const b = e.target.closest('[data-recent]')
  if (!b) return
  openTarget(b.dataset.kind === 'group' ? { kind: 'group', id: b.dataset.recent } : { kind: 'single', did: b.dataset.recent })
})
$('#fvTargetBar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-target]')?.dataset.target
  if (act === 'back') {
    fv.selected.clear()
    fv.overlap = 'all'
    setFollowsMode('mine')
    loadFollows()
  }
  if (act === 'refresh') {
    if (fv.target.kind === 'group') startGroup(fv.target.members.map((m) => m.did), true)
    else startAnalysis(fv.target.handle, true)
  }
})

$('#fvListSel').addEventListener('change', (e) => {
  fv.listFilter = e.target.value
  fv.shown = 150
  renderFollows()
})

// One person's lists: tick or untick each of your lists, or start a new one. Changes apply at once.
function openListToggle(did) {
  const row = fv.rows.find((r) => r.did === did)
  const who = row ? (row.displayName || row.handle || did) : did
  $('#adTitle').textContent = `Lists for ${who}`
  const draw = () => {
    const on = new Set(listsOf(did))
    const groups = state.accounts.map((a) => {
      const mine = fv.lists.lists.filter((l) => l.slot === a.slot)
      return `<div class="lt-group"><div class="lt-acct">${badge(a.slot)} @${esc(a.handle)}</div>
        ${mine.map((l) => `<label class="lt-row"><input type="checkbox" data-lt="${esc(l.uri)}" data-slot="${l.slot}" ${on.has(l.uri) ? 'checked' : ''}> ${esc(l.name)} <span class="dim">(${l.count})</span></label>`).join('') || '<div class="dim lt-row">No lists yet</div>'}
        <form class="lt-new" data-slot="${a.slot}"><input maxlength="64" placeholder="New list on ${LETTERS[a.slot]}…" aria-label="New list name"><button class="secondary">Create and add</button></form>
      </div>`
    }).join('')
    $('#adBody').innerHTML = `${groups}<div class="ad-foot"><button class="secondary" data-close>Done</button></div>`
  }
  draw()
  $('#adBody').onchange = async (e) => {
    const box = e.target.closest('[data-lt]')
    if (!box) return
    box.disabled = true
    const slot = Number(box.dataset.slot)
    const listUri = box.dataset.lt
    try {
      if (box.checked) await api('/api/lists/add', { slot, listUri, dids: [did] })
      else await api('/api/lists/remove-many', { slot, listUri, dids: [did] })
      applyMembership([did], listUri, box.checked)
      renderFollows()
    } catch (err) {
      box.checked = !box.checked
      toast(err.message)
    } finally {
      box.disabled = false
    }
  }
  $('#adBody').onsubmit = async (e) => {
    const form = e.target.closest('.lt-new')
    if (!form) return
    e.preventDefault()
    const name = form.querySelector('input').value.trim()
    if (!name) return
    const slot = Number(form.dataset.slot)
    try {
      const l = await api('/api/lists/create', { slot, name })
      await api('/api/lists/add', { slot, listUri: l.uri, dids: [did] })
      fv.lists.lists.push({ uri: l.uri, name: l.name, slot, count: 0 })
      applyMembership([did], l.uri, true)
      renderListFilter()
      renderFollows()
      draw()
    } catch (err) {
      toast(err.message)
    }
  }
  $('#actionDialog').showModal()
}

// Updates the local copy of who is on which list after a change, so the table redraws without a reload
function applyMembership(dids, listUri, on) {
  const l = listByUri(listUri)
  for (const did of dids) {
    const cur = new Set(listsOf(did))
    const had = cur.has(listUri)
    if (on && !had) { cur.add(listUri); if (l) l.count++ }
    if (!on && had) { cur.delete(listUri); if (l) l.count-- }
    fv.lists.byDid[did] = [...cur]
  }
  renderListFilter()
}

$('#fvBulk').addEventListener('click', (e) => {
  const act = e.target.closest('[data-bulk]')?.dataset.bulk
  if (!act) return
  if (act === 'clear') {
    fv.selected.clear()
    return renderFollows()
  }
  if (act === 'all') {
    for (const r of fv.visible) fv.selected.add(r.did)
    return renderFollows()
  }
  if (act === 'analyze') {
    const dids = [...fv.selected]
    if (dids.length > 10) return toast('Analyze at most 10 accounts at a time')
    if (dids.length === 1) return startAnalysis(fv.rows.find((r) => r.did === dids[0])?.handle ?? dids[0])
    return startGroup(dids)
  }
  openAction(act, [...fv.selected])
})

// ---------- follow actions (confirm dialog) ----------

function rowsFor(dids) {
  return dids.map((d) => fv.rows.find((r) => r.did === d)).filter(Boolean)
}

function nameList(rows) {
  const names = rows.slice(0, 8).map((r) => `<li>${esc(r.displayName || r.handle)} <span class="dim">@${esc(r.handle ?? '')}</span></li>`).join('')
  return `<ul class="ad-list">${names}${rows.length > 8 ? `<li>…and ${rows.length - 8} more</li>` : ''}</ul>`
}

// Checkboxes for which of your accounts to act from; `count(slot)` = how many selected accounts it affects
function acctChoices(count, checkedIf) {
  return `<div class="ad-accts">${state.accounts.map((a) => {
    const n = count(a.slot)
    return `<label><input type="checkbox" name="slot" value="${a.slot}" ${n && checkedIf(a.slot) ? 'checked' : ''} ${n ? '' : 'disabled'}>
      ${badge(a.slot)} @${esc(a.handle)} <span class="dim">(${n})</span></label>`
  }).join('')}</div>`
}

function chosenSlots() {
  return [...document.querySelectorAll('#adBody input[name=slot]:checked')].map((i) => Number(i.value))
}

function openAction(kind, dids) {
  const rows = rowsFor(dids)
  if (!rows.length) return
  const dlg = $('#actionDialog')
  const body = $('#adBody')
  const n = rows.length
  const label = `${n} account${n === 1 ? '' : 's'}`
  const follows = (slot) => rows.filter((r) => r.followedBy.includes(slot)).length

  if (kind === 'unfollow') {
    $('#adTitle').textContent = `Unfollow ${label}`
    body.innerHTML = `${nameList(rows)}<p>Unfollow from:</p>${acctChoices(follows, () => true)}
      <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="danger-btn" id="adGo">Unfollow</button></div>`
  } else if (kind === 'mute') {
    const unmuted = (slot) => rows.filter((r) => !r.muted.includes(slot)).length
    $('#adTitle').textContent = `Mute ${label}`
    body.innerHTML = `${nameList(rows)}<p>Muting hides their posts in Bluesky without unfollowing. They aren't told. Mute from:</p>
      ${acctChoices(unmuted, (s) => s === state.actAs)}
      <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="adGo">Mute</button></div>`
  } else if (kind === 'follow') {
    const notYet = (slot) => rows.filter((r) => !r.followedBy.includes(slot)).length
    $('#adTitle').textContent = `Follow ${label}`
    body.innerHTML = `${nameList(rows)}<p>Follow from:</p>${acctChoices(notYet, () => true)}
      <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="adGo">Follow</button></div>`
  } else if (kind === 'list') {
    // Any number of your lists, on either account; each list is changed by the account that owns it
    const onList = (uri) => rows.filter((r) => listsOf(r.did).includes(uri)).length
    $('#adTitle').textContent = `Add ${label} to lists`
    body.innerHTML = `${nameList(rows)}
      ${state.accounts.map((a) => {
        const mine = fv.lists.lists.filter((l) => l.slot === a.slot)
        return `<div class="lt-group"><div class="lt-acct">${badge(a.slot)} @${esc(a.handle)}'s lists</div>
          ${mine.map((l) => {
            const already = onList(l.uri)
            return `<label class="lt-row"><input type="checkbox" name="adLists" value="${esc(l.uri)}" data-slot="${l.slot}" ${already === rows.length ? 'disabled' : ''}>
              ${esc(l.name)} <span class="dim">(${l.count}${already ? `; ${already === rows.length ? 'all' : already} of these already on it` : ''})</span></label>`
          }).join('') || '<div class="dim lt-row">No lists yet</div>'}
          <label class="lt-row"><input type="checkbox" class="ad-new-tick" data-slot="${a.slot}"> New list: <input type="text" class="ad-new-name" data-slot="${a.slot}" maxlength="64" placeholder="Name"></label>
        </div>`
      }).join('')}
      <label class="ad-row"><input type="checkbox" id="adAlsoUnfollow"> Also unfollow them from the accounts that own the ticked lists</label>
      <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="adGo">Add</button></div>`
    // Typing a new list's name ticks it
    body.querySelectorAll('.ad-new-name').forEach((inp) => inp.addEventListener('input', () => {
      body.querySelector(`.ad-new-tick[data-slot="${inp.dataset.slot}"]`).checked = !!inp.value.trim()
    }))
  } else if (kind === 'unlist') {
    const counts = new Map()
    for (const r of rows) for (const u of listsOf(r.did)) counts.set(u, (counts.get(u) ?? 0) + 1)
    const opts = fv.lists.lists.filter((l) => counts.has(l.uri))
    $('#adTitle').textContent = `Remove ${label} from lists`
    body.innerHTML = opts.length
      ? `${nameList(rows)}<p>Take them off:</p>
        ${opts.map((l) => `<label class="lt-row"><input type="checkbox" name="adLists" value="${esc(l.uri)}" data-slot="${l.slot}">
          ${badge(l.slot)} ${esc(l.name)} <span class="dim">(${counts.get(l.uri)} of these on it)</span></label>`).join('')}
        <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="adGo">Remove</button></div>`
      : `${nameList(rows)}<p>None of them are on any of your lists.</p><div class="ad-foot"><button class="secondary" data-close>Close</button><button hidden id="adGo"></button></div>`
  }

  $('#adGo').onclick = async (e) => {
    const go = e.target
    go.disabled = true
    try {
      await runAction(kind, rows)
      dlg.close()
    } catch (err) {
      toast(err.message)
    } finally {
      go.disabled = false
    }
  }
  dlg.showModal()
}

// Bulk actions take at most 200 accounts per request, so bigger selections go in batches
async function bulkApi(path, body) {
  const out = { done: 0, failed: [] }
  for (let i = 0; i < body.dids.length; i += 200) {
    const res = await api(path, { ...body, dids: body.dids.slice(i, i + 200) })
    out.done += res.done ?? 0
    out.failed.push(...(res.failed ?? []))
  }
  return out
}

function summarize(verb, res) {
  const failed = res.failed?.length ? ` (${res.failed.length} failed: ${res.failed[0].error})` : ''
  return `${verb} ${res.done}${failed}`
}

async function runAction(kind, rows) {
  const dids = rows.map((r) => r.did)
  if (kind === 'unfollow') {
    const slots = chosenSlots()
    if (!slots.length) throw new Error('Choose an account')
    // Remember exactly which follows we remove so Undo can restore them
    const removed = slots.map((s) => [s, rows.filter((r) => r.followedBy.includes(s)).map((r) => r.did)])
    const res = await bulkApi('/api/follows/unfollow', { dids, slots })
    const failedPairs = new Set((res.failed ?? []).map((f) => `${f.slot}|${f.did}`))
    fv.selected.clear()
    await loadFollows()
    toast(summarize('Unfollowed', res), {
      label: 'Undo',
      run: async () => {
        let n = 0
        for (const [slot, list] of removed) {
          const back = list.filter((d) => !failedPairs.has(`${slot}|${d}`))
          if (back.length) n += (await bulkApi('/api/follows/follow', { dids: back, slots: [slot] })).done
        }
        toast(`Followed ${n} again`)
        loadFollows()
      },
    })
  } else if (kind === 'mute') {
    const slots = chosenSlots()
    if (!slots.length) throw new Error('Choose an account')
    const res = await bulkApi('/api/follows/mute', { dids, slots })
    await loadFollows()
    toast(summarize('Muted', res), {
      label: 'Undo',
      run: async () => {
        await bulkApi('/api/follows/unmute', { dids, slots })
        toast('Unmuted')
        loadFollows()
      },
    })
  } else if (kind === 'follow') {
    const slots = chosenSlots()
    if (!slots.length) throw new Error('Choose an account')
    const res = await bulkApi('/api/follows/follow', { dids, slots })
    await loadFollows()
    toast(summarize('Followed', res))
  } else if (kind === 'list') {
    const targets = [...document.querySelectorAll('#adBody input[name=adLists]:checked')].map((b) => ({ uri: b.value, slot: Number(b.dataset.slot) }))
    for (const tick of document.querySelectorAll('#adBody .ad-new-tick:checked')) {
      const slot = Number(tick.dataset.slot)
      const name = document.querySelector(`#adBody .ad-new-name[data-slot="${slot}"]`).value.trim()
      if (!name) throw new Error(`Give the new list on ${LETTERS[slot]} a name`)
      targets.push({ name, slot })
    }
    if (!targets.length) throw new Error('Tick at least one list')
    const report = []
    for (const t of targets) {
      if (!t.uri) {
        const created = await api('/api/lists/create', { slot: t.slot, name: t.name })
        t.uri = created.uri
        fv.lists.lists.push({ uri: created.uri, name: created.name, slot: t.slot, count: 0 })
      }
      const res = await bulkApi('/api/lists/add', { slot: t.slot, listUri: t.uri, dids })
      const name = listByUri(t.uri)?.name ?? t.name ?? 'list'
      report.push(`${name}: ${res.done} added${dids.length - res.done ? `, ${dids.length - res.done} already there` : ''}`)
    }
    await refreshMemberships()
    let msg = report.join(' · ')
    if ($('#adAlsoUnfollow').checked) {
      const slots = [...new Set(targets.map((t) => t.slot))]
      const res = await bulkApi('/api/follows/unfollow', { dids, slots })
      msg += ` · unfollowed ${res.done}`
    }
    fv.selected.clear()
    await loadFollows()
    toast(msg)
  } else if (kind === 'unlist') {
    const targets = [...document.querySelectorAll('#adBody input[name=adLists]:checked')].map((b) => ({ uri: b.value, slot: Number(b.dataset.slot) }))
    if (!targets.length) throw new Error('Tick at least one list')
    const report = []
    for (const t of targets) {
      const res = await bulkApi('/api/lists/remove-many', { slot: t.slot, listUri: t.uri, dids })
      applyMembership(dids, t.uri, false)
      report.push(`${listByUri(t.uri)?.name ?? 'list'}: ${res.done} removed`)
    }
    fv.selected.clear()
    renderFollows()
    toast(report.join(' · '))
  }
}

// ---------- lists ----------

// Curated lists for one account at a time: see them, read one as a feed, change who's on it.
// Lists other people made can be opened from a shared link (read and copy only).
const ls = { slot: null, lists: [], current: null, mode: 'posts', members: [], cursor: null, loadingMembers: false, searchSeq: 0 }
const lsOwned = () => ls.current?.ownerSlot != null

VIEWS.lists = {
  feed: '/api/lists/feed',
  count: null,
  query: () => new URLSearchParams({ list: ls.current?.uri ?? '', slot: state.actAs }),
  done: () => "That's as far back as this list's feed goes.",
  empty: () => 'No posts from the people on this list yet.',
}

function renderLsAccount() {
  if (ls.slot == null || !state.accounts.some((a) => a.slot === ls.slot)) ls.slot = state.actAs
  $('#lsAccount').hidden = state.accounts.length < 2
  $('#lsAccount').innerHTML = state.accounts.map((a) =>
    `<button type="button" data-slot="${a.slot}" class="${a.slot === ls.slot ? 'on' : ''}">${badge(a.slot)}<span class="h">@${esc(a.handle)}</span></button>`).join('')
}

async function loadLists() {
  renderLsAccount()
  const box = $('#lsList')
  if (!ls.current) box.innerHTML = '<p class="dim">Loading lists…</p>'
  try {
    ls.lists = await api(`/api/lists?slot=${ls.slot}`)
  } catch (err) {
    box.innerHTML = `<p class="error">Couldn't load lists: ${esc(err.message)}</p>`
    return
  }
  renderLists()
}

function renderLists() {
  const box = $('#lsList')
  box.innerHTML = ls.lists.length
    ? ls.lists.map((l) => `<button type="button" class="card ls-item" data-open-list="${esc(l.uri)}">
        <span class="ls-text"><b>${esc(l.name)}</b>${l.description ? `<small>${esc(l.description)}</small>` : ''}</span>
        <span class="ls-count">${l.count} ${l.count === 1 ? 'person' : 'people'}</span></button>`).join('')
    : `<p class="dim">${esc(acctName(ls.slot))} has no lists yet. <b>New list</b> starts one; you can also add people from the Follows tab or a profile card.</p>`
}

function showLsDetail(open) {
  $('#lsList').hidden = open
  $('#lsOpenForm').hidden = open
  $('.ls-head').hidden = open
  $('#lsDetail').hidden = !open
  const posts = open && ls.mode === 'posts'
  $('#lsMembers').hidden = !open || ls.mode !== 'members'
  $('#feed').hidden = !posts
  $('#feedEnd').hidden = !posts
}

async function openList(uri) {
  ls.current = { uri }
  ls.members = []
  ls.cursor = null
  $('#lsInfo').innerHTML = '<p class="dim">Loading…</p>'
  $('#lsMemberList').innerHTML = ''
  showLsDetail(true)
  try {
    const data = await api(`/api/lists/members?list=${encodeURIComponent(uri)}&slot=${ls.slot}`)
    if (ls.current?.uri !== uri) return
    ls.current = data.list
    ls.members = data.members
    ls.cursor = data.cursor
  } catch (err) {
    $('#lsInfo').innerHTML = `<p class="error">Couldn't open this list: ${esc(err.message)}</p>`
    return
  }
  if (ls.current.purpose !== 'app.bsky.graph.defs#curatelist') {
    $('#lsInfo').innerHTML = '<p>This is a moderation list. Skydash only shows curated lists.</p>'
    $('#lsMode').hidden = true
    $('#lsMembers').hidden = true
    $('#feed').hidden = true
    $('#feedEnd').hidden = true
    return
  }
  $('#lsMode').hidden = false
  renderLsInfo()
  setLsMode(ls.mode)
}

function renderLsInfo() {
  const l = ls.current
  const others = state.accounts.filter((a) => a.slot !== l.ownerSlot)
  const copyBtns = others.map((a) => `<button type="button" class="pc-btn" data-ls="copy" data-slot="${a.slot}">Copy to ${badge(a.slot)} @${esc(a.handle)}</button>`).join('')
  const byline = lsOwned() ? `Your list on ${badge(l.ownerSlot)} ${esc(acctName(l.ownerSlot))}` : `By @${esc(l.creator.handle)}`
  $('#lsInfo').innerHTML = `<h2>${esc(l.name)}</h2>
    <div class="dim">${byline} · ${l.count ?? ls.members.length} ${(l.count ?? ls.members.length) === 1 ? 'person' : 'people'}</div>
    ${l.description ? `<p>${esc(l.description)}</p>` : ''}
    <div class="ls-acts">
      ${lsOwned() ? '<button type="button" class="pc-btn" data-ls="edit">Rename or describe</button>' : ''}
      ${copyBtns}
      <a class="pc-btn" href="${esc(listWebUrl(l))}" target="_blank" rel="noopener">Open in Bluesky ↗</a>
      ${lsOwned() ? '<button type="button" class="pc-btn unfollow" data-ls="delete">Delete list</button>' : ''}
    </div>`
  $('#lsAddWrap').hidden = !lsOwned()
}

function listWebUrl(l) {
  return `https://bsky.app/profile/${l.creator?.handle || l.creator?.did}/lists/${l.uri.split('/').pop()}`
}

function setLsMode(mode) {
  ls.mode = mode
  $('#lsMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode))
  showLsDetail(true)
  if (mode === 'posts') loadFeed(true)
  else renderLsMembers()
}

function renderLsMembers() {
  $('#lsMemberList').innerHTML = ls.members.map((m) => `<div class="ls-person">
      <img loading="lazy" src="${esc(m.avatar ?? '')}" alt="" data-profile="${esc(m.did)}">
      <span class="ls-text" data-profile="${esc(m.did)}"><b>${esc(m.displayName || m.handle)}</b><small>@${esc(m.handle)}</small></span>
      ${lsOwned() ? `<button type="button" class="link-btn bad" data-ls-remove="${esc(m.itemUri)}" data-did="${esc(m.did)}" title="Take them off this list">Remove</button>` : ''}
    </div>`).join('')
  $('#lsMembersMore').innerHTML = ls.cursor
    ? '<button type="button" class="secondary" id="lsMoreMembers">Show more</button>'
    : ls.members.length ? '' : (lsOwned() ? 'Nobody on this list yet. Search above to add people.' : 'Nobody on this list.')
}

async function moreMembers() {
  if (!ls.cursor || ls.loadingMembers) return
  ls.loadingMembers = true
  try {
    const data = await api(`/api/lists/members?list=${encodeURIComponent(ls.current.uri)}&slot=${ls.slot}&cursor=${encodeURIComponent(ls.cursor)}`)
    ls.members.push(...data.members)
    ls.cursor = data.cursor
    renderLsMembers()
  } catch (err) {
    toast(err.message)
  } finally {
    ls.loadingMembers = false
  }
}

// Re-reads the open list after a change, keeping the current view
async function refreshOpenList() {
  const data = await api(`/api/lists/members?list=${encodeURIComponent(ls.current.uri)}&slot=${ls.slot}`)
  ls.current = data.list
  ls.members = data.members
  ls.cursor = data.cursor
  renderLsInfo()
  if (ls.mode === 'members') renderLsMembers()
}

function editListDialog() {
  const l = ls.current
  $('#adTitle').textContent = 'Rename or describe list'
  $('#adBody').innerHTML = `
    <label class="ad-field">Name <input id="lsEditName" maxlength="64" value="${esc(l.name)}"></label>
    <label class="ad-field">Description <textarea id="lsEditDesc" rows="3" maxlength="300">${esc(l.description)}</textarea></label>
    <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="lsEditSave">Save</button></div>`
  $('#lsEditSave').onclick = async (e) => {
    e.target.disabled = true
    try {
      await api('/api/lists/update', { slot: l.ownerSlot, listUri: l.uri, name: $('#lsEditName').value, description: $('#lsEditDesc').value })
      $('#actionDialog').close()
      toast('List updated')
      await refreshOpenList()
    } catch (err) {
      toast(err.message)
    } finally {
      e.target.disabled = false
    }
  }
  $('#actionDialog').showModal()
}

function newListDialog() {
  $('#adTitle').textContent = `New list for ${acctName(ls.slot)}`
  $('#adBody').innerHTML = `
    <label class="ad-field">Name <input id="lsNewName" maxlength="64" placeholder="e.g. Cardinals writers"></label>
    <label class="ad-field">Description (optional) <textarea id="lsNewDesc" rows="3" maxlength="300"></textarea></label>
    <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="lsNewSave">Create</button></div>`
  $('#lsNewSave').onclick = async (e) => {
    e.target.disabled = true
    try {
      const l = await api('/api/lists/create', { slot: ls.slot, name: $('#lsNewName').value, description: $('#lsNewDesc').value })
      $('#actionDialog').close()
      toast(`Created “${l.name}”`)
      ls.mode = 'members'
      openList(l.uri)
    } catch (err) {
      toast(err.message)
    } finally {
      e.target.disabled = false
    }
  }
  $('#actionDialog').showModal()
  $('#lsNewName').focus()
}

// "Add to list…" from a profile card: pick the account and list (or start a new one)
function openAddToList(did, handle) {
  const first = state.actAs
  $('#adTitle').textContent = `Add @${handle} to a list`
  $('#adBody').innerHTML = `
    <label class="ad-field">Account <select id="atlAcct">${state.accounts.map((a) => `<option value="${a.slot}" ${a.slot === first ? 'selected' : ''}>${LETTERS[a.slot]} · @${esc(a.handle)}</option>`).join('')}</select></label>
    <label class="ad-field">List <select id="atlList"><option>Loading…</option></select></label>
    <label class="ad-field" id="atlNewWrap" hidden>New list name <input id="atlNew" maxlength="64"></label>
    <div class="ad-foot"><button class="secondary" data-close>Cancel</button><button class="primary" id="atlGo">Add</button></div>`
  const fill = async () => {
    const sel = $('#atlList')
    sel.innerHTML = '<option>Loading…</option>'
    try {
      const lists = await api(`/api/lists?slot=${$('#atlAcct').value}`)
      sel.innerHTML = lists.map((l) => `<option value="${esc(l.uri)}">${esc(l.name)} (${l.count})</option>`).join('') + '<option value="__new">+ New list…</option>'
    } catch (err) {
      sel.innerHTML = '<option value="__new">+ New list…</option>'
      toast(err.message)
    }
    sel.dispatchEvent(new Event('change'))
  }
  $('#atlAcct').onchange = fill
  $('#atlList').onchange = () => ($('#atlNewWrap').hidden = $('#atlList').value !== '__new')
  $('#atlGo').onclick = async (e) => {
    e.target.disabled = true
    try {
      const slot = Number($('#atlAcct').value)
      let listUri = $('#atlList').value
      if (listUri === '__new') listUri = (await api('/api/lists/create', { slot, name: $('#atlNew').value })).uri
      const res = await api('/api/lists/add', { slot, listUri, dids: [did] })
      $('#actionDialog').close()
      toast(res.done ? `Added @${handle} to the list` : `@${handle} is already on that list`)
      if (state.view === 'lists' && ls.current?.uri === listUri) refreshOpenList()
    } catch (err) {
      toast(err.message)
    } finally {
      e.target.disabled = false
    }
  }
  fill()
  $('#actionDialog').showModal()
}

$('#lsAccount').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-slot]')
  if (!b) return
  ls.slot = Number(b.dataset.slot)
  ls.current = null
  showLsDetail(false)
  loadLists()
})
$('#lsNew').addEventListener('click', newListDialog)
$('#lsList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open-list]')
  if (b) openList(b.dataset.openList)
})
$('#lsBack').addEventListener('click', () => {
  ls.current = null
  showLsDetail(false)
  loadLists()
})
$('#lsMode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]')
  if (b && b.dataset.mode !== ls.mode) setLsMode(b.dataset.mode)
})
$('#lsOpenForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const link = $('#lsLink').value.trim()
  if (!link) return
  try {
    const { uri } = await api(`/api/lists/resolve?link=${encodeURIComponent(link)}`)
    $('#lsLink').value = ''
    openList(uri)
  } catch (err) {
    toast(err.message)
  }
})
$('#lsMembersMore').addEventListener('click', (e) => {
  if (e.target.closest('#lsMoreMembers')) moreMembers()
})
$('#lsInfo').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ls]')
  if (!b) return
  const l = ls.current
  if (b.dataset.ls === 'edit') return editListDialog()
  if (b.dataset.ls === 'delete') {
    const n = l.count ?? ls.members.length
    if (!confirm(`Delete the list “${l.name}” (${n} ${n === 1 ? 'person' : 'people'})? This removes it from Bluesky and can't be undone.`)) return
    b.disabled = true
    try {
      await api('/api/lists/delete', { slot: l.ownerSlot, listUri: l.uri })
      toast(`Deleted “${l.name}”`)
      ls.current = null
      showLsDetail(false)
      loadLists()
    } catch (err) {
      toast(err.message)
      b.disabled = false
    }
  }
  if (b.dataset.ls === 'copy') {
    const to = Number(b.dataset.slot)
    if (!confirm(`Make a copy of “${l.name}” on ${acctName(to)}?`)) return
    b.disabled = true
    try {
      const copy = await api('/api/lists/copy', { listUri: l.uri, fromSlot: ls.slot, toSlot: to })
      toast(`Copied “${copy.name}” with ${copy.count} ${copy.count === 1 ? 'person' : 'people'} to ${acctName(to)}`)
    } catch (err) {
      toast(err.message)
    } finally {
      b.disabled = false
    }
  }
})
$('#lsMemberList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ls-remove]')
  if (!b) return
  b.disabled = true
  try {
    await api('/api/lists/remove', { slot: ls.current.ownerSlot, listUri: ls.current.uri, itemUri: b.dataset.lsRemove, did: b.dataset.did })
    ls.members = ls.members.filter((m) => m.itemUri !== b.dataset.lsRemove)
    if (ls.current.count != null) ls.current.count--
    renderLsMembers()
    renderLsInfo()
  } catch (err) {
    toast(err.message)
    b.disabled = false
  }
})
{
  let timer
  $('#lsAdd').addEventListener('input', (e) => {
    clearTimeout(timer)
    const q = e.target.value.trim()
    if (!q) return ($('#lsAddResults').innerHTML = '')
    timer = setTimeout(async () => {
      const seq = ++ls.searchSeq
      try {
        const people = await api(`/api/lists/search?slot=${ls.current.ownerSlot}&q=${encodeURIComponent(q)}`)
        if (seq !== ls.searchSeq) return
        const on = new Set(ls.members.map((m) => m.did))
        $('#lsAddResults').innerHTML = people.map((p) => `<div class="ls-person">
            <img src="${esc(p.avatar ?? '')}" alt="">
            <span class="ls-text"><b>${esc(p.displayName || p.handle)}</b><small>@${esc(p.handle)}</small></span>
            ${on.has(p.did) ? '<span class="dim">On the list</span>' : `<button type="button" class="secondary" data-ls-add="${esc(p.did)}">Add</button>`}
          </div>`).join('') || '<div class="ls-person dim">No one found</div>'
      } catch (err) {
        toast(err.message)
      }
    }, 250)
  })
  $('#lsAddResults').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ls-add]')
    if (!b) return
    b.disabled = true
    try {
      await api('/api/lists/add', { slot: ls.current.ownerSlot, listUri: ls.current.uri, dids: [b.dataset.lsAdd] })
      b.replaceWith(Object.assign(document.createElement('span'), { className: 'dim', textContent: 'Added' }))
      await refreshOpenList()
    } catch (err) {
      toast(err.message)
      b.disabled = false
    }
  })
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#lsAddWrap')) $('#lsAddResults').innerHTML = ''
  })
}

// ---------- actions ----------

async function refreshPost(uri) {
  const fresh = await api(`/api/post?uri=${encodeURIComponent(uri)}`)
  if (!fresh.post) return null
  applyLocalActions(fresh.post, fresh.viewer)
  state.posts.set(uri, { ...state.posts.get(uri), ...fresh }) // keeps who follows the author
  document.querySelectorAll(`.actions[data-uri="${CSS.escape(uri)}"]`).forEach((el) => {
    el.outerHTML = renderActions(fresh.post, fresh.viewer)
  })
  return fresh
}

// Like or repost as the selected account, warning if the other account already did
const togglesRunning = new Set()

// slot: an account picked from the "Like as" menu; otherwise the Act as account
async function toggle(uri, kind, slot = state.actAs, picked = false) {
  // Redrawing replaces the button, so a quick second click could otherwise start a second like
  const running = `${uri}|${kind}`
  if (togglesRunning.has(running)) return
  togglesRunning.add(running)
  try {
    const fresh = await refreshPost(uri)
    if (!fresh) return toast('That post is no longer available')
    const { post, viewer } = fresh
    const existing = viewer[slot]?.[kind]
    const verb = kind === 'like' ? 'liked' : 'reposted'
    const key = `${slot}|${uri}|${kind}`

    if (existing) {
      await api(`/api/un${kind}`, { slot, uri, [`${kind}Uri`]: existing })
      localActions.set(key, { value: null, at: Date.now() })
      toast(`Removed ${kind} from ${acctName(slot)}`)
    } else {
      const others = whoDid(viewer, kind).filter((s) => s !== slot)
      if (others.length && !picked && !confirm(`Already ${verb} by ${others.map(acctName).join(' and ')}.\n\n${kind === 'like' ? 'Like' : 'Repost'} it from ${acctName(slot)} too?`)) return
      const res = await api(`/api/${kind}`, { slot, uri, cid: post.cid })
      localActions.set(key, { value: res.uri, at: Date.now() })
      toast(`${kind === 'like' ? 'Liked' : 'Reposted'} as ${acctName(slot)}`)
    }
    // Draw the result now rather than asking Bluesky again, which may not have caught up yet
    document.querySelectorAll(`.actions[data-uri="${CSS.escape(uri)}"]`).forEach((el) => {
      el.outerHTML = renderActions(post, viewer)
    })
  } finally {
    togglesRunning.delete(running)
  }
}

document.addEventListener('click', async (e) => {
  const blurred = e.target.closest('img.blurred')
  if (blurred) {
    e.preventDefault()
    blurred.classList.remove('blurred')
    return
  }
  const openThread = e.target.closest('[data-open-thread]')
  if (openThread && !e.target.closest('a')) return showThread(openThread.dataset.openThread)

  const btn = e.target.closest('.act')
  if (!btn) return
  const uri = btn.closest('.actions').dataset.uri
  const known = state.posts.get(uri)
  btn.disabled = true
  try {
    switch (btn.dataset.act) {
      case 'like':
        // Followed from more than one of your accounts: choose which one likes it
        if ((known?.followedBy?.length ?? 0) > 1) await openLikeAs(btn, uri)
        else await toggle(uri, 'like')
        break
      case 'repost': await toggle(uri, 'repost'); break
      case 'reply': openCompose({ replyTo: known?.post }); break
      case 'quote': openCompose({ quote: known?.post }); break
      case 'thread': await showThread(uri); break
      case 'share': openShareMenu(known?.post, btn); break
    }
  } catch (err) {
    toast(err.message)
  } finally {
    btn.disabled = false
  }
})

// ---------- thread ----------

function renderThreadNode(node, focusUri, depth = 0) {
  if (!node) return ''
  if (node.$type === 'app.bsky.feed.defs#notFoundPost') return '<div class="thread-item missing">Deleted post</div>'
  if (node.$type === 'app.bsky.feed.defs#blockedPost') return '<div class="thread-item missing">Post from a blocked account</div>'
  if (!node.post) return ''
  const p = node.post
  // Only the first signed-in account's like/repost state is known here until you act on it
  const primary = state.accounts[0]?.slot
  const viewer = primary ? { [primary]: { like: p.viewer?.like, repost: p.viewer?.repost } } : {}
  state.posts.set(p.uri, { post: p, viewer })
  const replies = (node.replies ?? [])
    .filter((r) => r.post)
    .map((r) => renderThreadNode(r, focusUri, depth + 1))
    .join('')
  return `<div class="thread-item ${p.uri === focusUri ? 'focus' : ''}">${renderPost(p)}${renderActions(p, viewer)}</div>
    ${replies ? `<div class="thread-replies">${replies}</div>` : ''}`
}

async function showThread(uri) {
  const dlg = $('#threadDialog')
  const body = $('#threadBody')
  body.innerHTML = '<div class="missing">Loading thread…</div>'
  if (!dlg.open) dlg.showModal()
  try {
    const thread = await api(`/api/thread?uri=${encodeURIComponent(uri)}`)
    const parents = []
    for (let n = thread.parent; n; n = n.parent) parents.unshift(n)
    body.innerHTML = parents.map((p) => renderThreadNode({ ...p, replies: [] }, uri)).join('') + renderThreadNode(thread, uri)
    body.querySelector('.focus')?.scrollIntoView({ block: 'center' })
  } catch (err) {
    body.innerHTML = `<div class="error">Couldn't load thread: ${esc(err.message)}</div>`
  }
}

// ---------- compose ----------

let composeTarget = {}

// draft: a saved draft to keep editing (see "drafts" below)
function openCompose({ replyTo, quote, draft } = {}) {
  composeTarget = { replyTo: replyTo?.uri ?? draft?.reply_to ?? undefined, quote: quote?.uri ?? draft?.quote ?? undefined }
  composeDraft = draft ? { id: draft.id, updatedAt: draft.updated_at } : null
  composeSent = false
  setScheduleMode(false)
  $('#composeTitle').textContent = composeTarget.replyTo ? (draft ? 'Reply draft' : 'Reply') : composeTarget.quote ? (draft ? 'Quote draft' : 'Quote post') : draft ? 'Draft' : 'New post'
  const ctx = replyTo || quote
  $('#composeContext').innerHTML = ctx ? `<div class="card">${renderPost(ctx, { small: true })}</div>` : ''
  $('#composeAs').innerHTML = state.accounts
    .map((a) => `<option value="${a.slot}" ${a.slot === state.actAs ? 'selected' : ''}>${LETTERS[a.slot]} · @${esc(a.handle)}</option>`)
    .join('')
  $('#composeText').value = draft?.text ?? ''
  $('#composeError').textContent = ''
  composeImages.length = 0
  clearVideo()
  if (draft) {
    if (state.accounts.some((a) => a.slot === draft.slot)) $('#composeAs').value = String(draft.slot)
    for (const m of draft.media) {
      const url = `/api/drafts/file?id=${encodeURIComponent(draft.id)}&name=${encodeURIComponent(m.name)}`
      if (m.kind === 'video') {
        composeVideo = { existing: m.name, url, state: 'ready', progress: 100, alt: m.alt, width: m.width, height: m.height, mime: m.mime, thumb: m.thumb, slot: draft.slot }
      } else {
        composeImages.push({ id: ++imageSeq, existing: m.name, url, mime: m.mime, width: m.width, height: m.height, alt: m.alt, thumb: m.thumb })
      }
    }
    renderComposeVideo()
  }
  renderDraftNote(draft)
  // Waiting to post: hold it while you edit. Post sends it in 2 minutes; closing keeps its time.
  if (draft?.post_at) {
    composeDraft.resumeAt = draft.post_at
    api('/api/drafts/schedule', { id: draft.id, postAt: null }).catch(() => {})
    const note = $('#composeDraftNote')
    note.hidden = false
    note.innerHTML = `On hold while you edit (it was set for ${esc(when(draft.post_at))}). <b>Post</b> sends it in 2 minutes; closing keeps the time it had.`
  }
  if (draft?.post_error) {
    const note = $('#composeDraftNote')
    note.hidden = false
    note.insertAdjacentHTML('beforeend', `<div class="err">Last try failed: ${esc(draft.post_error)}</div>`)
  }
  $('#composeSaveDraft').hidden = false
  renderComposeImages()
  updateCount()
  $('#composeDialog').showModal()
  $('#composeText').focus()
  // The post being replied to or quoted, when the draft only knows its address
  if (draft?.reply_to || draft?.quote) {
    api(`/api/post?uri=${encodeURIComponent(draft.reply_to || draft.quote)}`)
      .then(({ post }) => {
        if (post && composeDraft?.id === draft.id) $('#composeContext').innerHTML = `<div class="card">${renderPost(post, { small: true })}</div>`
      })
      .catch(() => {})
  }
}

// Approximate grapheme count; the server does the exact check
const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter() : null
function updateCount() {
  const text = $('#composeText').value
  const n = segmenter ? [...segmenter.segment(text)].length : text.length
  const el = $('#composeCount')
  el.textContent = 300 - n
  el.classList.toggle('over', n > 300)
}
$('#composeText').addEventListener('input', updateCount)
$('#composeText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#composeForm').requestSubmit()
})
$('#composeBtn').addEventListener('click', () => openCompose())

$('#composeForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const send = $('#composeSend')
  send.disabled = true
  $('#composeError').textContent = ''
  const slot = Number($('#composeAs').value)
  try {
    if (composeImages.some((img) => img.processing)) throw new Error('Still preparing images; try again in a moment')
    if (composeVideo && composeVideo.state !== 'ready') {
      throw new Error(composeVideo.state === 'error' ? 'The video failed; remove it or try another' : 'The video is still uploading or processing')
    }
    if (composeVideo && !composeVideo.alt.trim() && !confirm("The video has no alt text. People using screen readers won't know what it shows.\n\nPost anyway?")) return
    const missingAlt = composeImages.filter((img) => !img.alt.trim()).length
    if (missingAlt && !confirm(`${missingAlt === 1 ? '1 image has' : `${missingAlt} images have`} no alt text. People using screen readers won't know what ${missingAlt === 1 ? 'it shows' : 'they show'}.\n\nPost anyway?`)) return
    // Everything goes out through a draft that the server posts later: in 2 minutes (time to fix typos),
    // or at the scheduled time. The box closes right away.
    let postAt = Date.now() + POST_DELAY_MS
    if (scheduling) {
      postAt = new Date($('#composeWhen').value).getTime()
      if (!postAt || postAt < Date.now() + 60_000) throw new Error('Pick a time at least a minute from now')
    }
    if (!$('#composeText').value.trim() && !composeImages.length && !composeVideo) throw new Error('Write something or add an image or video')
    send.textContent = composeImages.length || composeVideo ? 'Saving…' : 'Queueing…'
    const saved = await saveComposeDraft()
    if (saved.outcome !== 'saved') return
    const id = composeDraft.id
    await api('/api/drafts/schedule', { id, postAt })
    composeSent = true
    $('#composeDialog').close()
    refreshDraftCount()
    toast(scheduling ? `Scheduled for ${when(postAt)} as ${acctName(slot)}` : `Posting in 2 minutes as ${acctName(slot)}`, { label: 'Edit', run: () => editDraftById(id) })
  } catch (err) {
    $('#composeError').textContent = err.message
  } finally {
    send.disabled = false
    send.textContent = scheduling ? 'Schedule' : 'Post'
  }
})

// ---------- Post in 2 minutes / Schedule ----------

const POST_DELAY_MS = 2 * 60_000
let scheduling = false
let composeSent = false

function setScheduleMode(on) {
  scheduling = on
  $('#composeWhenRow').hidden = !on
  $('#composeScheduleBtn').hidden = on
  $('#composeSend').textContent = on ? 'Schedule' : 'Post'
  $('#composeHint').hidden = on
  if (on && !$('#composeWhen').value) {
    // Default: the next whole hour, at least 30 minutes away, in local time
    const d = new Date(Date.now() + 30 * 60_000)
    d.setMinutes(0, 0, 0)
    d.setHours(d.getHours() + 1)
    const pad = (n) => String(n).padStart(2, '0')
    $('#composeWhen').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  if (!on) $('#composeWhen').value = ''
}
$('#composeScheduleBtn').addEventListener('click', () => setScheduleMode(true))
$('#composeWhenCancel').addEventListener('click', () => setScheduleMode(false))

// Closing a post that was waiting (opened to edit) keeps your edits and puts it back in line
$('#composeDialog').addEventListener('close', async () => {
  const d = composeDraft
  if (!d?.resumeAt || composeSent) return
  composeSent = true
  try {
    await saveComposeDraft()
  } catch {}
  const postAt = Math.max(d.resumeAt, Date.now() + 30_000)
  await api('/api/drafts/schedule', { id: d.id, postAt }).catch((err) => toast(err.message))
  refreshDraftCount()
  toast(`Still set to post ${postAt - Date.now() < 5 * 60_000 ? 'shortly' : `at ${when(postAt)}`}`)
})

async function editDraftById(id) {
  try {
    openCompose({ draft: await api(`/api/drafts/get?id=${encodeURIComponent(id)}`) })
  } catch (err) {
    toast(err.message)
  }
}

// ---------- drafts (shared with the Hub iPhone app) ----------

// { id, updatedAt } while the compose box holds a saved draft
let composeDraft = null

const place = (by) => (by === 'iphone' ? 'your iPhone' : 'your Mac')
const when = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// What a newer edit replaced, shown on the draft so each side can see what happened to its version
function replacedNote(d) {
  const r = d.replaced
  if (!r) return ''
  const what = r.deleted
    ? `Deleting this draft on ${place(r.by)} (${when(r.at)}) was skipped, because this edit from ${place(d.updated_by)} is newer.`
    : `This newer edit from ${place(d.updated_by)} replaced the version from ${place(r.by)} saved ${when(r.at)}.`
  const old = !r.deleted && (r.text || r.media)
    ? `<details><summary>Show the replaced version</summary><pre>${esc(r.text || '(no text)')}</pre>${r.media ? `<small class="dim">It had ${r.media} photo${r.media === 1 ? '' : 's'} or video.</small>` : ''}</details>`
    : ''
  return `${esc(what)} <button type="button" class="secondary" data-dismiss-replaced="${esc(d.id)}">Dismiss</button>${old}`
}

function renderDraftNote(draft) {
  const el = $('#composeDraftNote')
  const html = draft ? replacedNote(draft) : ''
  el.hidden = !html
  el.innerHTML = html
}

// A small JPEG of a photo or the first second of a video, so the iPhone can show the draft without its files
async function makeThumb(url, isVideo) {
  try {
    let source, width, height
    if (isVideo) {
      const v = document.createElement('video')
      v.muted = true
      v.preload = 'auto'
      v.src = url
      await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = reject })
      v.currentTime = Math.min(1, (v.duration || 0) / 2)
      await new Promise((resolve) => { v.onseeked = resolve; setTimeout(resolve, 1500) })
      source = v
      width = v.videoWidth
      height = v.videoHeight
    } else {
      source = await createImageBitmap(await (await fetch(url)).blob())
      width = source.width
      height = source.height
    }
    const scale = Math.min(1, 240 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return null
  }
}

const extFor = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/mpeg': 'mpeg' })[mime] ?? 'bin'

// Saves what's in the compose box as a draft. New photos go inline; a new video is uploaded as a file first.
async function saveComposeDraft() {
  if (composeImages.some((img) => img.processing)) throw new Error('Still preparing images; try again in a moment')
  const id = composeDraft?.id ?? crypto.randomUUID()
  const stamp = Date.now().toString(36)
  const media = []
  for (const img of composeImages) {
    const base = { kind: 'image', mime: img.mime, alt: img.alt, width: img.width, height: img.height }
    if (img.existing) {
      media.push({ ...base, name: img.existing, thumb: img.thumb ?? null })
    } else {
      media.push({ ...base, name: `photo-${stamp}-${img.id}.${extFor(img.mime)}`, data: img.data, thumb: await makeThumb(img.url, false) })
    }
  }
  const v = composeVideo
  if (v) {
    const base = { kind: 'video', alt: v.alt, width: v.width, height: v.height }
    if (v.existing) {
      media.push({ ...base, name: v.existing, mime: v.mime, thumb: v.thumb ?? null })
    } else {
      const mime = v.file.type || 'video/mp4'
      const name = `video-${stamp}.${extFor(mime)}`
      const res = await fetch(`/api/drafts/media?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': mime },
        body: v.file,
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Video upload failed (${res.status})`)
      media.push({ ...base, name, mime, thumb: await makeThumb(v.url, true) })
    }
  }
  const res = await api('/api/drafts/save', {
    id,
    slot: Number($('#composeAs').value),
    text: $('#composeText').value,
    replyTo: composeTarget.replyTo ?? null,
    quote: composeTarget.quote ?? null,
    media,
    baseUpdatedAt: composeDraft?.updatedAt ?? null,
    editedAt: Date.now(),
    by: 'mac',
  })
  composeDraft = { id, updatedAt: res.draft?.updated_at ?? null }
  if (res.outcome === 'kept-newer') {
    $('#composeError').textContent = `A newer edit from ${place(res.draft.updated_by)} is already saved, so this one was kept only as the replaced version. Open the draft again to see it.`
  } else if (res.outcome === 'deleted') {
    $('#composeError').textContent = `This draft was deleted on ${place(res.draft.deleted_by)} after you opened it.`
  }
  refreshDraftCount()
  return res
}

$('#composeSaveDraft').addEventListener('click', async () => {
  const btn = $('#composeSaveDraft')
  btn.disabled = true
  $('#composeError').textContent = ''
  try {
    const wasWaiting = !!composeDraft?.resumeAt
    const res = await saveComposeDraft()
    if (res.outcome === 'saved') {
      composeSent = true // a post that was waiting stays a draft: Save draft means "don't post it yet"
      $('#composeDialog').close()
      toast(wasWaiting ? "Saved as a draft; it won't post until you post it" : 'Draft saved')
    }
  } catch (err) {
    $('#composeError').textContent = err.message
  } finally {
    btn.disabled = false
  }
})

$('#composeDraftNote').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-dismiss-replaced]')?.dataset.dismissReplaced
  if (!id) return
  await api('/api/drafts/dismiss', { id }).catch(() => {})
  renderDraftNote(null)
})

// Ids waiting to post at the last check, to say when one goes out (or fails)
let queuedIds = null

async function refreshDraftCount() {
  try {
    const { drafts } = await api('/api/drafts')
    const queued = drafts.filter((d) => d.post_at && !d.posted_at && !d.deleted_at)
    const open = drafts.filter((d) => !d.posted_at && !d.deleted_at && !d.post_at).length
    $('#draftsBtn').textContent = [open ? `Drafts (${open})` : 'Drafts', queued.length ? `⏳ ${queued.length}` : ''].filter(Boolean).join(' · ')
    $('#draftsBtn').title = queued.length ? `${queued.length} waiting to post` : ''
    if (queuedIds) {
      for (const d of drafts) {
        if (!queuedIds.has(d.id)) continue
        if (d.posted_at) toast(`Posted as ${acctName(d.slot)}`)
        else if (d.post_error && !d.post_at) toast(`Couldn't post: ${d.post_error}`, { label: 'Open', run: () => editDraftById(d.id) })
      }
    }
    queuedIds = new Set(queued.map((d) => d.id))
    return drafts
  } catch {
    return null
  }
}

function draftRow(d) {
  const thumbs = d.media.map((m) => m.thumb
    ? `<img src="${esc(m.thumb)}" alt="${esc(m.alt || (m.kind === 'video' ? 'Video' : 'Photo'))}">`
    : `<span class="thumb-missing">${m.kind === 'video' ? 'Video' : 'Photo'}</span>`).join('')
  const meta = [
    badge(d.slot),
    d.reply_to ? 'Reply' : d.quote ? 'Quote' : 'Post',
    d.post_at ? `<b>posts ${esc(postsIn(d.post_at))}</b>` : `edited ${when(d.updated_at)} on ${place(d.updated_by)}`,
  ].join(' · ')
  const note = replacedNote(d) + (d.post_error ? `<div class="err">Couldn't post: ${esc(d.post_error)}</div>` : '')
  if (d.post_at) {
    return `<div class="card draft-row draft-queued" data-draft="${esc(d.id)}">
      <div class="draft-meta">${meta}</div>
      <div class="draft-text ${d.text.trim() ? '' : 'empty'}">${esc(d.text.trim() || '(no text)')}</div>
      ${thumbs ? `<div class="draft-thumbs">${thumbs}</div>` : ''}
      <div class="draft-actions">
        <button class="secondary" data-draft-unqueue title="Don't post it; keep it as a draft">Cancel</button>
        <button class="secondary" data-draft-edit>Edit</button>
        <button class="primary" data-draft-postnow ${d.posting ? 'disabled' : ''}>${d.posting ? 'Posting…' : 'Post now'}</button>
      </div>
    </div>`
  }
  return `<div class="card draft-row" data-draft="${esc(d.id)}">
    <div class="draft-meta">${meta}</div>
    ${note ? `<div class="draft-note">${note}</div>` : ''}
    <div class="draft-text ${d.text.trim() ? '' : 'empty'}">${esc(d.text.trim() || '(no text)')}</div>
    ${thumbs ? `<div class="draft-thumbs">${thumbs}</div>` : ''}
    <div class="draft-actions">
      <button class="secondary" data-draft-delete>Delete</button>
      <button class="secondary" data-draft-edit>Edit</button>
      <button class="primary" data-draft-post ${d.posting ? 'disabled' : ''}>${d.posting ? 'Posting…' : 'Post'}</button>
    </div>
  </div>`
}

function doneRow(d) {
  const what = d.posted_at
    ? `Posted ${when(d.posted_at)} from ${place(d.posted_by)}${d.posted_uri ? ` · <a href="https://bsky.app/profile/${esc(d.posted_uri.split('/')[2])}/post/${esc(d.posted_uri.split('/').pop())}" target="_blank" rel="noopener">View</a>` : ''}`
    : `Deleted ${when(d.deleted_at)} on ${place(d.deleted_by)}`
  return `<div class="card draft-row draft-done">
    <div class="draft-meta">${what}</div>
    ${d.text ? `<div class="draft-text">${esc(d.text)}</div>` : ''}
  </div>`
}

let draftsById = new Map()

async function openDrafts() {
  $('#adTitle').textContent = 'Drafts'
  $('#adBody').innerHTML = '<p class="dim">Loading…</p>'
  if (!$('#actionDialog').open) $('#actionDialog').showModal()
  const drafts = (await refreshDraftCount()) ?? []
  draftsById = new Map(drafts.map((d) => [d.id, d]))
  const queued = drafts.filter((d) => d.post_at && !d.posted_at && !d.deleted_at).sort((a, b) => a.post_at - b.post_at)
  const open = drafts.filter((d) => !d.posted_at && !d.deleted_at && !d.post_at)
  // A deleted draft that was never saved here has no account or text worth showing
  const done = drafts.filter((d) => (d.posted_at || d.deleted_at) && d.slot)
  $('#adBody').innerHTML = `
    ${queued.length ? `<div class="draft-section">Waiting to post</div><div class="draft-list">${queued.map(draftRow).join('')}</div><div class="draft-section">Drafts</div>` : ''}
    <p class="dim">Drafts are shared with Hub on your iPhone. If both change the same draft, the newest edit wins and the other is noted on it.</p>
    <div class="draft-list">${open.length ? open.map(draftRow).join('') : '<p class="dim">No drafts. Use “Save draft” in the post box.</p>'}</div>
    ${done.length ? `<div class="draft-section">Finished in the last week</div><div class="draft-list">${done.map(doneRow).join('')}</div>` : ''}`
}

$('#draftsBtn').addEventListener('click', () => openDrafts().catch((err) => toast(err.message)))
$('#adBody').addEventListener('click', async (e) => {
  const dismiss = e.target.closest('[data-dismiss-replaced]')?.dataset.dismissReplaced
  if (dismiss) {
    await api('/api/drafts/dismiss', { id: dismiss }).catch(() => {})
    return openDrafts()
  }
  const row = e.target.closest('[data-draft]')
  const d = row && draftsById.get(row.dataset.draft)
  if (!d) return
  try {
    if (e.target.closest('[data-draft-edit]')) {
      $('#actionDialog').close()
      openCompose({ draft: d })
    } else if (e.target.closest('[data-draft-delete]')) {
      if (!confirm('Delete this draft? It will also disappear from Hub on your iPhone.')) return
      const res = await api('/api/drafts/delete', { id: d.id, by: 'mac', editedAt: Date.now() })
      if (res.outcome === 'kept-newer') toast(`Not deleted: it was edited on ${place(d.updated_by)} more recently`)
      openDrafts()
    } else if (e.target.closest('[data-draft-post]')) {
      if (!d.text.trim() && !d.media.length) return toast('This draft is empty')
      await api('/api/drafts/schedule', { id: d.id, postAt: Date.now() + POST_DELAY_MS })
      toast(`Posting in 2 minutes as ${acctName(d.slot)}`)
      openDrafts()
    } else if (e.target.closest('[data-draft-unqueue]')) {
      await api('/api/drafts/schedule', { id: d.id, postAt: null })
      toast('Not posted; kept as a draft')
      openDrafts()
    } else if (e.target.closest('[data-draft-postnow]')) {
      e.target.disabled = true
      e.target.textContent = 'Posting…'
      await api('/api/drafts/post', { id: d.id, by: 'mac' })
      queuedIds?.delete(d.id)
      toast(`Posted as ${acctName(d.slot)}`)
      openDrafts()
    }
  } catch (err) {
    toast(err.message)
    openDrafts()
  }
})
refreshDraftCount()
// Keeps the ⏳ count current and says when a waiting post goes out
setInterval(() => refreshDraftCount(), 15_000)

// "in 1 min", "at 3:40 PM" etc. for a waiting post
function postsIn(ms) {
  const left = ms - Date.now()
  if (left <= 30_000) return 'any moment'
  if (left < 60 * 60_000) return `in ${Math.ceil(left / 60_000)} min`
  return `at ${when(ms)}`
}

// ---------- images in the compose box ----------

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 1_900_000 // Bluesky allows 2 MB; leave a little room
const MAX_SIDE = 2000 // Bluesky shows images at most this size anyway
const composeImages = [] // { id, url, data (base64), mime, width, height, alt, processing, note }

// Every image is redrawn before upload. That shrinks big photos to fit Bluesky's limit and
// removes hidden metadata such as the GPS location your phone stores in photos.
async function prepareImage(file) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file) // applies the photo's rotation
  } catch {
    throw new Error(`${file.name}: this browser can't read that image type`)
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality))
  let blob = null
  let note = ''
  // Keep PNGs as PNG (screenshots, transparency) when they fit; everything else becomes JPEG
  if (file.type === 'image/png') blob = await toBlob('image/png')
  if (!blob || blob.size > MAX_IMAGE_BYTES) {
    for (const q of [0.92, 0.85, 0.75, 0.65, 0.5]) {
      blob = await toBlob('image/jpeg', q)
      if (blob && blob.size <= MAX_IMAGE_BYTES) break
    }
  }
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error(`${file.name}: couldn't shrink it under 2 MB`)
  if (file.type === 'image/gif') note = 'GIFs are posted as a still image'
  const data = await new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.readAsDataURL(blob)
  })
  return { data, mime: blob.type, width, height, url: URL.createObjectURL(blob), note }
}

let imageSeq = 0
async function addImages(files) {
  const video = [...files].find((f) => f.type.startsWith('video/'))
  if (video) return addVideo(video)
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))
  if (!list.length) return
  if (composeVideo) return toast('A post can have images or a video, not both')
  const room = MAX_IMAGES - composeImages.length
  if (room <= 0) return toast(`Bluesky allows ${MAX_IMAGES} images per post`)
  if (list.length > room) toast(`Only the first ${room} added; Bluesky allows ${MAX_IMAGES} images per post`)
  await Promise.all(list.slice(0, room).map(async (file) => {
    const item = { id: ++imageSeq, alt: '', processing: true, name: file.name }
    composeImages.push(item)
    renderComposeImages()
    try {
      Object.assign(item, await prepareImage(file), { processing: false })
    } catch (err) {
      composeImages.splice(composeImages.indexOf(item), 1)
      toast(err.message)
    }
    renderComposeImages()
  }))
}

function renderComposeImages() {
  const el = $('#composeImages')
  el.hidden = composeImages.length === 0
  el.innerHTML = composeImages.map((img, i) => `<div class="cimg" data-img="${img.id}">
      <div class="cimg-thumb">${img.processing ? '<span class="dim">Preparing…</span>' : `<img src="${img.url}" alt="">`}
        <button type="button" class="cimg-remove" data-remove="${img.id}" aria-label="Remove image ${i + 1}">✕</button></div>
      <textarea class="cimg-alt" data-alt="${img.id}" rows="3" maxlength="2000"
        placeholder="Alt text: describe the image for people who can't see it">${esc(img.alt)}</textarea>
      ${img.note ? `<small class="dim">${esc(img.note)}</small>` : ''}
    </div>`).join('')
  $('.add-images').classList.toggle('disabled', composeImages.length >= MAX_IMAGES || !!composeVideo)
  $('.add-video').classList.toggle('disabled', composeImages.length > 0 || !!composeVideo)
  updateCount()
}

// ---------- video in the compose box ----------

const MAX_VIDEO_BYTES = 100_000_000
const MAX_VIDEO_SECONDS = 180
// { file, url, state: checking|uploading|processing|ready|error, progress, xhr, jobId, blob, alt, width, height, duration, error, slot }
let composeVideo = null
let videoPoll = 0

function clearVideo() {
  if (composeVideo) {
    composeVideo.xhr?.abort()
    if (composeVideo.url) URL.revokeObjectURL(composeVideo.url)
  }
  clearTimeout(videoPoll)
  composeVideo = null
  $('#composeAs').disabled = false
  renderComposeVideo()
}

function readVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration })
    v.onerror = () => reject(new Error("This browser can't read that video"))
    v.src = url
  })
}

async function addVideo(file) {
  if (composeImages.length) return toast('A post can have images or a video, not both')
  if (composeVideo) return toast('One video per post')
  if (file.size > MAX_VIDEO_BYTES) return toast(`${file.name} is ${(file.size / 1e6).toFixed(0)} MB; videos can be at most 100 MB`)
  const slot = Number($('#composeAs').value)
  const v = (composeVideo = { file, url: URL.createObjectURL(file), state: 'checking', progress: 0, alt: '', slot })
  // The uploaded file belongs to this account, so the account can't change while a video is attached
  $('#composeAs').disabled = true
  renderComposeVideo()
  const fail = (message) => {
    if (composeVideo !== v) return
    v.state = 'error'
    v.error = message
    renderComposeVideo()
  }
  try {
    Object.assign(v, await readVideoInfo(v.url))
    if (v.duration > MAX_VIDEO_SECONDS + 0.5) return fail(`This video is ${Math.round(v.duration)} seconds; Bluesky allows up to 3 minutes`)
    const limits = await api(`/api/video/limits?slot=${slot}`)
    if (!limits.canUpload) return fail(limits.message || "Bluesky isn't allowing video uploads for this account right now. Video needs a verified email address.")
    if (limits.remainingDailyBytes !== null && file.size > limits.remainingDailyBytes) return fail("This video is bigger than what's left of today's upload allowance")
  } catch (err) {
    return fail(err.message)
  }
  if (composeVideo !== v) return

  // Upload with progress, then wait for Bluesky to process it
  v.state = 'uploading'
  renderComposeVideo()
  const xhr = (v.xhr = new XMLHttpRequest())
  xhr.open('POST', `/api/video/upload?slot=${slot}&name=${encodeURIComponent(file.name)}`)
  xhr.setRequestHeader('content-type', file.type || 'video/mp4')
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable && composeVideo === v) {
      v.progress = Math.round((e.loaded / e.total) * 100)
      renderVideoStatus()
    }
  }
  xhr.onerror = () => fail('Upload failed; check your connection')
  xhr.onload = () => {
    let data = {}
    try { data = JSON.parse(xhr.responseText) } catch {}
    if (xhr.status !== 200) return fail(data.error || `Upload failed (${xhr.status})`)
    v.jobId = data.jobId
    v.state = 'processing'
    v.progress = 0
    renderComposeVideo()
    if (data.blob) return ready(data.blob)
    pollVideo(v)
  }
  xhr.send(file)

  function ready(blob) {
    if (composeVideo !== v) return
    v.blob = blob
    v.state = 'ready'
    renderComposeVideo()
  }
  async function pollVideo() {
    if (composeVideo !== v) return
    try {
      const st = await api(`/api/video/status?jobId=${encodeURIComponent(v.jobId)}`)
      if (st.state === 'JOB_STATE_COMPLETED' && st.blob) return ready(st.blob)
      if (st.state === 'JOB_STATE_FAILED') return fail(st.message || st.error || "Bluesky couldn't process this video")
      v.progress = st.progress ?? v.progress
      renderVideoStatus()
    } catch (err) {
      // A brief hiccup while polling isn't fatal; keep trying
    }
    videoPoll = setTimeout(pollVideo, 1500)
  }
}

function videoStatusText(v) {
  switch (v.state) {
    case 'checking': return 'Checking video…'
    case 'uploading': return `Uploading… ${v.progress}%`
    case 'processing': return `Processing on Bluesky… ${v.progress ? `${v.progress}%` : ''}`
    case 'ready': {
      if (v.existing) return 'Saved with the draft'
      const size = v.file.size >= 1e6 ? `${(v.file.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(v.file.size / 1e3))} KB`
      return `Ready · ${Math.round(v.duration)}s · ${size}`
    }
    case 'error': return v.error
  }
}

function renderVideoStatus() {
  const v = composeVideo
  const el = $('#composeVideo .cvid-status')
  if (!v || !el) return
  el.textContent = videoStatusText(v)
  el.classList.toggle('error', v.state === 'error')
  const bar = $('#composeVideo .cvid-bar span')
  if (bar) bar.style.width = `${v.state === 'ready' ? 100 : v.progress}%`
}

function renderComposeVideo() {
  const el = $('#composeVideo')
  const v = composeVideo
  el.hidden = !v
  if (!v) {
    el.innerHTML = ''
  } else {
    el.innerHTML = `<div class="cvid-preview"><video src="${v.url}" controls muted playsinline preload="metadata"></video>
        <button type="button" class="cimg-remove" id="cvidRemove" aria-label="Remove video">✕</button></div>
      <div class="cvid-side">
        <div class="cvid-status"></div>
        ${v.state === 'error' ? '' : '<div class="cvid-bar"><span></span></div>'}
        <textarea class="cimg-alt" id="cvidAlt" rows="3" maxlength="1000"
          placeholder="Alt text: describe the video for people who can't see it">${esc(v.alt)}</textarea>
      </div>`
    $('#cvidRemove').onclick = () => {
      clearVideo()
      renderComposeImages()
    }
    $('#cvidAlt').oninput = (e) => (v.alt = e.target.value)
    renderVideoStatus()
  }
  const send = $('#composeSend')
  if (send) send.disabled = !!v && v.state !== 'ready' && v.state !== 'error'
  renderComposeImagesButtons()
}

function renderComposeImagesButtons() {
  $('.add-images').classList.toggle('disabled', composeImages.length >= MAX_IMAGES || !!composeVideo)
  $('.add-video').classList.toggle('disabled', composeImages.length > 0 || !!composeVideo)
}

$('#composeVideoFile').addEventListener('change', (e) => {
  if (e.target.files[0]) addVideo(e.target.files[0])
  e.target.value = ''
})
// Closing the compose box cancels an upload in progress
$('#composeDialog').addEventListener('close', () => clearVideo())

$('#composeImages').addEventListener('input', (e) => {
  const id = Number(e.target.dataset.alt)
  const img = composeImages.find((x) => x.id === id)
  if (img) img.alt = e.target.value
})
$('#composeImages').addEventListener('click', (e) => {
  const id = Number(e.target.closest('[data-remove]')?.dataset.remove)
  if (!id) return
  const i = composeImages.findIndex((x) => x.id === id)
  if (i >= 0) {
    if (composeImages[i].url) URL.revokeObjectURL(composeImages[i].url)
    composeImages.splice(i, 1)
  }
  renderComposeImages()
})
$('#composeFiles').addEventListener('change', (e) => {
  addImages(e.target.files)
  e.target.value = '' // so choosing the same file again still works
})
// Paste a screenshot or copied image straight into the text box
$('#composeText').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) {
    e.preventDefault()
    addImages(files)
  }
})
// Drag and drop images anywhere on the compose box
const composeBox = $('#composeForm')
composeBox.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
    e.preventDefault()
    composeBox.classList.add('dropping')
  }
})
composeBox.addEventListener('dragleave', (e) => {
  if (!composeBox.contains(e.relatedTarget)) composeBox.classList.remove('dropping')
})
composeBox.addEventListener('drop', (e) => {
  composeBox.classList.remove('dropping')
  if (e.dataTransfer?.files?.length) {
    e.preventDefault()
    addImages(e.dataTransfer.files)
  }
})

document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close()
  })
})

// ---------- profile card ----------

const pc = {
  cache: new Map(), // did -> { at, data }
  did: null, // profile currently shown
  anchor: null, // element it's attached to
  showTimer: 0,
  hideTimer: 0,
}
const PC_CACHE_MS = 5 * 60_000

async function fetchProfile(did, fresh = false) {
  const hit = pc.cache.get(did)
  if (!fresh && hit && Date.now() - hit.at < PC_CACHE_MS) return hit.data
  const data = await api(`/api/profile?actor=${encodeURIComponent(did)}`)
  pc.cache.set(did, { at: Date.now(), data })
  return data
}

function linkify(text) {
  return esc(text ?? '').replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
}

function fmtCount(n) {
  if (n == null) return '—'
  return n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString()
}

// Whether they follow you, at a glance: which of your accounts they follow, or that they follow none.
// (Who you follow is already on the Follow / Unfollow buttons.)
function followsYouTag(slots) {
  return slots.length
    ? `<span class="pc-tag follows-you">Follows you ${slots.map((s) => badge(s, `Follows ${acctName(s)}`)).join('')}</span>`
    : `<span class="pc-tag not-following-you">Doesn't follow you</span>`
}

function renderProfileCard(p) {
  const rel = p.relationship
  const slots = state.accounts.map((a) => a.slot)
  const isSelf = slots.some((s) => rel[s]?.self)
  const followsYou = slots.filter((s) => rel[s]?.followedBy)
  const following = slots.filter((s) => rel[s]?.following)
  const st = p.stats
  const lastDays = st.lastActiveMs ? Math.floor((Date.now() - st.lastActiveMs) / 86_400_000) : null
  const last = lastDays === null ? 'no recent activity seen' : lastDays === 0 ? 'active today' : `last active ${lastDays}d ago`

  const buttons = isSelf ? '' : slots.map((s) => {
    const r = rel[s] ?? {}
    if (r.blocking || r.blockedBy) return `<span class="dim">${LETTERS[s]}: blocked</span>`
    return r.following
      ? `<button class="pc-btn unfollow" data-pc="unfollow" data-slot="${s}" title="Unfollow from ${esc(acctName(s))}">${badge(s)} Unfollow</button>`
      : `<button class="pc-btn follow" data-pc="follow" data-slot="${s}" title="Follow from ${esc(acctName(s))}">${badge(s)} Follow</button>`
  }).join('')
  const actSlot = state.actAs
  const muted = rel[actSlot]?.muted
  const muteBtn = isSelf ? '' : `<button class="pc-btn" data-pc="${muted ? 'unmute' : 'mute'}" data-slot="${actSlot}" title="${muted ? 'Unmute' : 'Mute'} as ${esc(acctName(actSlot))}">${muted ? 'Unmute' : 'Mute'}</button>`

  return `<div class="pc-head">
      <img class="pc-avatar" src="${esc(p.avatar ?? '')}" alt="">
      <div class="pc-names">
        <b>${esc(p.displayName || p.handle)}</b>
        <span class="dim">@${esc(p.handle)}</span>
        <div class="pc-tags">
          ${isSelf ? '<span class="pc-tag">This is you</span>' : ''}
          ${isSelf ? '' : followsYouTag(followsYou)}
          ${muted ? '<span class="pc-tag">Muted</span>' : ''}
        </div>
      </div>
    </div>
    ${p.description ? `<div class="pc-bio">${linkify(p.description)}</div>` : ''}
    <div class="pc-counts"><span><b>${fmtCount(p.followersCount)}</b> followers</span><span><b>${fmtCount(p.followsCount)}</b> following</span><span><b>${fmtCount(p.postsCount)}</b> posts</span></div>
    <div class="pc-stats">Last ${st.days} days: ${st.posts} posts · ${st.replies} replies · ${st.reposts} reposts · ${last}${st.interactions ? ` · interacted with you ${st.interactions}×` : ''}</div>
    <div class="pc-actions">
      ${buttons}${muteBtn}
      ${following.length ? '<button class="pc-btn" data-pc="posts">Their posts</button>' : ''}
      ${isSelf ? '' : '<button class="pc-btn" data-pc="list">Add to list…</button>'}
      <a class="pc-btn" href="https://bsky.app/profile/${esc(p.handle || p.did)}" target="_blank" rel="noopener">Open in Bluesky ↗</a>
    </div>`
}

function placeCard(card, anchor) {
  if (innerWidth < 560) {
    card.classList.add('sheet-mode') // bottom sheet on phones
    card.style.left = card.style.top = ''
    return
  }
  card.classList.remove('sheet-mode')
  const r = anchor.getBoundingClientRect()
  const w = card.offsetWidth
  const h = card.offsetHeight
  let left = Math.min(Math.max(8, r.left), innerWidth - w - 8)
  let top = r.bottom + 6
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6) // flip above when there's no room below
  card.style.left = `${left}px`
  card.style.top = `${top}px`
}

async function openProfileCard(did, anchor) {
  const card = $('#profileCard')
  clearTimeout(pc.hideTimer)
  // An open dialog (e.g. a thread) is drawn above everything else, so the card has to live inside it
  const host = topLayerHost()
  if (card.parentElement !== host) host.append(card)
  pc.did = did
  pc.anchor = anchor
  card.innerHTML = '<div class="dim pc-loading">Loading…</div>'
  card.hidden = false
  placeCard(card, anchor)
  try {
    const p = await fetchProfile(did)
    if (pc.did !== did) return
    card.innerHTML = renderProfileCard(p)
    placeCard(card, anchor)
  } catch (err) {
    if (pc.did === did) card.innerHTML = `<div class="error">${esc(err.message)}</div>`
  }
}

function closeProfileCard() {
  clearTimeout(pc.showTimer)
  clearTimeout(pc.hideTimer)
  $('#profileCard').hidden = true
  pc.did = null
}

// Hover with a short delay so the card doesn't flash while moving the mouse across the feed
const canHover = matchMedia('(hover: hover)').matches
document.addEventListener('mouseover', (e) => {
  if (!canHover) return
  const t = e.target.closest('[data-profile]')
  if (t) {
    clearTimeout(pc.hideTimer)
    if (pc.did === t.dataset.profile && !$('#profileCard').hidden) return
    clearTimeout(pc.showTimer)
    pc.showTimer = setTimeout(() => openProfileCard(t.dataset.profile, t), 450)
  } else if (e.target.closest('#profileCard')) {
    clearTimeout(pc.hideTimer)
  }
})
document.addEventListener('mouseout', (e) => {
  if (!canHover) return
  const from = e.target.closest('[data-profile], #profileCard')
  const to = e.relatedTarget?.closest?.('[data-profile], #profileCard')
  if (!from || to) return
  clearTimeout(pc.showTimer)
  // Moving between the name and the card is allowed; leaving both closes it
  pc.hideTimer = setTimeout(() => {
    if (!$('#profileCard').matches(':hover')) closeProfileCard()
  }, 300)
})
// Click/tap opens it straight away (touch screens have no hover)
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-profile]')
  if (t && !t.closest('#profileCard')) {
    if (t.tagName === 'A') return // an @mention link still opens normally
    e.preventDefault()
    e.stopPropagation() // not the quote or row it's sitting in
    clearTimeout(pc.showTimer)
    openProfileCard(t.dataset.profile, t)
    return
  }
  if (!$('#profileCard').hidden && !e.target.closest('#profileCard')) closeProfileCard()
}, true)
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('close', () => {
  closeProfileCard()
  closeShareMenu()
  // Back to the next dialog down, or the page
  topLayerHost().append($('#profileCard'), $('#toast'), $('#shareMenu'))
}))
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeProfileCard())
addEventListener('scroll', () => !$('#profileCard').classList.contains('sheet-mode') && closeProfileCard(), { passive: true })

// Dims cards from an author no longer followed by any account, in the Following feed
function markUnfollowed(did, followingNow) {
  if (state.view !== 'following') return
  document.querySelectorAll(`#feed .card`).forEach((card) => {
    if (card.querySelector(`:scope > .post [data-profile="${CSS.escape(did)}"]`)) card.classList.toggle('unfollowed', !followingNow)
  })
}

$('#profileCard').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-pc]')
  if (!b || !pc.did) return
  const did = pc.did
  const p = pc.cache.get(did)?.data
  const slot = Number(b.dataset.slot)
  const who = `@${p?.handle ?? did}`
  b.disabled = true
  try {
    switch (b.dataset.pc) {
      case 'unfollow': {
        if (!confirm(`Unfollow ${who} from ${acctName(slot)}?`)) return
        const res = await api('/api/follows/unfollow', { dids: [did], slots: [slot] })
        if (res.failed?.length) throw new Error(res.failed[0].error)
        toast(`Unfollowed ${who} from ${acctName(slot)}`, {
          label: 'Undo',
          run: async () => {
            await api('/api/follows/follow', { dids: [did], slots: [slot] })
            toast(`Following ${who} again`)
            const again = await fetchProfile(did, true)
            markUnfollowed(did, true)
            if (pc.did === did) $('#profileCard').innerHTML = renderProfileCard(again)
          },
        })
        break
      }
      case 'follow': {
        const res = await api('/api/follows/follow', { dids: [did], slots: [slot] })
        if (res.failed?.length) throw new Error(res.failed[0].error)
        toast(`Followed ${who} from ${acctName(slot)}`)
        break
      }
      case 'mute':
      case 'unmute': {
        const muting = b.dataset.pc === 'mute'
        if (muting && !confirm(`Mute ${who} as ${acctName(slot)}? Their posts are hidden in Bluesky; they aren't told.`)) return
        await api(`/api/follows/${b.dataset.pc}`, { dids: [did], slots: [slot] })
        toast(`${muting ? 'Muted' : 'Unmuted'} ${who} as ${acctName(slot)}`)
        break
      }
      case 'posts':
        closeProfileCard()
        return openProfilePanel(did)
      case 'list':
        closeProfileCard()
        return openAddToList(did, p?.handle ?? did)
    }
    const fresh = await fetchProfile(did, true)
    markUnfollowed(did, Object.values(fresh.relationship).some((r) => r.following))
    if (pc.did === did) {
      $('#profileCard').innerHTML = renderProfileCard(fresh)
      placeCard($('#profileCard'), pc.anchor)
    }
  } catch (err) {
    toast(err.message)
  } finally {
    b.disabled = false
  }
})

// ---------- share menu (same choices as bsky.app) ----------

function closeShareMenu() {
  $('#shareMenu').hidden = true
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const box = document.createElement('textarea')
    box.value = text
    topLayerHost().append(box)
    box.select()
    document.execCommand('copy')
    box.remove()
  }
}

function openShareMenu(post, anchor) {
  if (!post) return toast('That post is no longer available')
  const menu = $('#shareMenu')
  if (!menu.hidden && menu.dataset.uri === post.uri) return closeShareMenu()
  // Authors can hide their posts from logged-out viewers; a link or embed wouldn't work for most people
  const loggedInOnly = (post.author.labels ?? []).some((l) => l.val === '!no-unauthenticated')
  const canEmbed = innerWidth >= 800 && !loggedInOnly
  menu.dataset.uri = post.uri
  menu.innerHTML = `
    ${loggedInOnly ? '' : '<button data-share="copy">Copy link to post <span>🔗</span></button>'}
    <button data-share="chat">Send via chat <span>✉</span></button>
    ${canEmbed ? '<button data-share="embed">Embed post <span>&lt;/&gt;</span></button>' : ''}
    ${loggedInOnly ? '<p class="dim">Note: This post is only visible to logged-in users.</p>' : ''}`
  menu._post = post
  const host = topLayerHost()
  if (menu.parentElement !== host) host.append(menu)
  menu.hidden = false
  const r = anchor.getBoundingClientRect()
  menu.style.left = `${Math.min(Math.max(8, r.left), innerWidth - menu.offsetWidth - 8)}px`
  const below = r.bottom + 4
  menu.style.top = `${below + menu.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 4) : below}px`
}

$('#shareMenu').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-share]')?.dataset.share
  if (!action) return
  const post = $('#shareMenu')._post
  closeShareMenu()
  if (action === 'copy') {
    await copyText(postUrl(post))
    toast('Copied to clipboard')
  }
  if (action === 'chat') openSendViaChat(post)
  if (action === 'embed') openEmbedDialog(post)
})
document.addEventListener('click', (e) => {
  if (!e.target.closest('#shareMenu') && !e.target.closest('[data-act="share"]')) closeShareMenu()
}, true)
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeShareMenu())
addEventListener('scroll', closeShareMenu, { passive: true })

// Same snippet as Bluesky's "Embed post", which their embed script turns into a post card
function embedSnippet(post, colorMode) {
  const html = (v) => String(v ?? '').replace(/["'&<>]/g, (c) => ({ '"': '&quot;', '&': '&amp;', "'": '&#x27;', '<': '&lt;', '>': '&gt;' })[c])
  const rec = post.record ?? {}
  const rkey = post.uri.split('/').pop()
  const profileHref = `https://bsky.app/profile/${post.author.did}?ref_src=embed`
  const href = `https://bsky.app/profile/${post.author.did}/post/${rkey}?ref_src=embed`
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(post.indexedAt))
  return `<blockquote class="bluesky-embed" data-bluesky-uri="${html(post.uri)}" data-bluesky-cid="${html(post.cid)}" data-bluesky-embed-color-mode="${html(colorMode)}"><p lang="${html(rec.langs?.[0] ?? '')}">${html(rec.text)}${rec.embed ? `<br><br><a href="${html(href)}">[image or embed]</a>` : ''}</p>&mdash; ${html(post.author.displayName || post.author.handle)} (<a href="${html(profileHref)}">@${html(post.author.handle)}</a>) <a href="${html(href)}">${html(date)}</a></blockquote><script async src="https://embed.bsky.app/static/embed.js" charset="utf-8"></script>`
}

function openEmbedDialog(post) {
  let mode = 'system'
  $('#adTitle').textContent = 'Embed post'
  const body = $('#adBody')
  body.innerHTML = `<p class="dim">Embed this post in your website. Simply copy the following snippet and paste it into the HTML code of your website.</p>
    <details class="embed-options"><summary>Customization options</summary>
      <div class="embed-theme"><b>Color theme</b>
        <div class="seg" id="embedMode">${['system', 'light', 'dark'].map((m) => `<button type="button" data-value="${m}" class="${m === mode ? 'on' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div></div></details>
    <div class="embed-copy"><input id="embedCode" readonly aria-label="Embed HTML code" value=""><button type="button" class="primary" id="embedCopy">Copy code</button></div>`
  const code = $('#embedCode')
  const draw = () => (code.value = embedSnippet(post, mode))
  draw()
  code.onfocus = () => code.select()
  $('#embedMode').onclick = (e) => {
    const b = e.target.closest('button[data-value]')
    if (!b) return
    mode = b.dataset.value
    $('#embedMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
    draw()
  }
  $('#embedCopy').onclick = async (e) => {
    await copyText(code.value)
    e.target.textContent = '✓ Copied!'
    setTimeout(() => (e.target.textContent = 'Copy code'), 2000)
  }
  $('#actionDialog').showModal()
}

// "Send post to…": pick a recent chat or find someone, then send
async function openSendViaChat(post) {
  const slot = state.actAs
  $('#adTitle').textContent = 'Send post to…'
  const body = $('#adBody')
  body.innerHTML = `<p class="dim chat-as">Sending as ${esc(acctName(slot))}</p>
    <input id="chatSearch" class="chat-search" type="search" placeholder="Search for someone" autocomplete="off" aria-label="Search for someone">
    <div id="chatList" class="chat-list"><div class="dim">Loading your chats…</div></div>`
  $('#actionDialog').showModal()

  const canMessage = (p) => p.allowIncoming === 'all' || (p.allowIncoming === 'following' && p.followedBy)
  const row = (p, attrs, enabled = true) => `<button type="button" class="chat-row" ${attrs} ${enabled ? '' : 'disabled'}>
      <img src="${esc(p.avatar ?? '')}" alt=""><span><b>${esc(p.displayName || p.handle)}</b><small>@${esc(p.handle)}${enabled ? '' : ' · can\'t be messaged'}</small></span></button>`
  const list = $('#chatList')
  let recent = []
  const drawRecent = () => {
    list.innerHTML = recent.length
      ? recent.map((c, i) => row(c.members[0], `data-convo="${i}"`)).join('')
      : '<div class="dim">No recent chats. Search for someone above.</div>'
  }
  try {
    recent = await api(`/api/chat/recent?slot=${slot}`)
    drawRecent()
  } catch (err) {
    list.innerHTML = `<div class="error">${esc(err.message)}</div>`
    $('#chatSearch').hidden = true
    return
  }

  let found = []
  let timer = 0
  $('#chatSearch').oninput = (e) => {
    clearTimeout(timer)
    const q = e.target.value.trim()
    if (!q) return drawRecent()
    timer = setTimeout(async () => {
      try {
        found = await api(`/api/chat/search?slot=${slot}&q=${encodeURIComponent(q)}`)
        list.innerHTML = found.length
          ? found.map((p, i) => row(p, `data-person="${i}"`, canMessage(p))).join('')
          : '<div class="dim">No one found.</div>'
      } catch (err) {
        list.innerHTML = `<div class="error">${esc(err.message)}</div>`
      }
    }, 250)
  }
  list.onclick = (e) => {
    const b = e.target.closest('.chat-row')
    if (!b || b.disabled) return
    if (b.dataset.convo !== undefined) {
      const c = recent[Number(b.dataset.convo)]
      confirmSend(post, slot, c.members[0], { convoId: c.convoId })
    } else {
      const p = found[Number(b.dataset.person)]
      confirmSend(post, slot, p, { did: p.did })
    }
  }
}

function confirmSend(post, slot, person, target) {
  const body = $('#adBody')
  body.innerHTML = `<p>To <b>${esc(person.displayName || person.handle)}</b> <span class="dim">@${esc(person.handle)}</span>, from ${esc(acctName(slot))}</p>
    <div class="card chat-preview">${renderPost(post, { small: true })}</div>
    <textarea id="chatText" class="chat-text" rows="3" maxlength="1000" placeholder="Add a message (optional)"></textarea>
    <div class="ad-foot"><button type="button" class="secondary" data-close>Cancel</button><button type="button" class="primary" id="chatSend">Send</button></div>`
  $('#chatText').focus()
  $('#chatSend').onclick = async (e) => {
    e.target.disabled = true
    try {
      await api('/api/chat/send', { slot, uri: post.uri, cid: post.cid, text: $('#chatText').value, ...target })
      $('#actionDialog').close()
      toast(`Sent to @${person.handle}`)
    } catch (err) {
      toast(err.message)
      e.target.disabled = false
    }
  }
}

// ---------- notifications (modeled on Bluesky's new notifications beta) ----------

const NF_TABS = [['all', 'All'], ['people-i-follow', 'People I follow'], ['conversations', 'Replies'], ['followers', 'Follows'], ['activity', 'Post alerts']]
const nf = { feed: 'all', groups: [], cursor: null, newestAt: null, loading: false, seq: 0, unread: {}, clearedAt: {}, expanded: new Set(), extraActors: new Map() }
const NF_ICONS = { like: ['♥', 'like'], repost: ['🔁', 'repost'], likeViaRepost: ['♥', 'like'], repostViaRepost: ['🔁', 'repost'],
  multiPostLike: ['♥', 'like'], multiPostRepost: ['🔁', 'repost'], multiPostLikeViaRepost: ['♥', 'like'], multiPostRepostViaRepost: ['🔁', 'repost'],
  follow: ['+', 'follow'], followBack: ['+', 'follow'], reply: ['↩', 'talk'], quote: ['❝', 'talk'], mention: ['@', 'talk'], subscribedPost: ['🔔', 'follow'],
  verified: ['✓', 'follow'], unverified: ['✕', 'muted'], starterPackJoined: ['+', 'follow'], contactMatch: ['+', 'follow'], generatorLike: ['♥', 'like'] }

async function refreshUnread() {
  if (!state.accounts.length) return
  try {
    nf.unread = await api('/api/notifications/unread')
  } catch {
    return
  }
  // Bluesky can take a moment to reflect "seen", so don't let an old count bring a cleared badge back
  for (const slot of Object.keys(nf.clearedAt)) {
    if (Date.now() - nf.clearedAt[slot] < 20_000) nf.unread[slot] = 0
  }
  renderUnreadBadges()
}

function renderUnreadBadges() {
  const total = Object.values(nf.unread).reduce((a, b) => a + b, 0)
  const badgeEl = $('#notifBadge')
  badgeEl.hidden = total === 0
  badgeEl.textContent = total > 99 ? '99+' : total
  renderNotifHeader()
}

// Marks everything up to `at` as seen on Bluesky, which clears it in the Bluesky app too
async function markNotificationsSeen(slot, at) {
  nf.clearedAt[slot] = Date.now()
  nf.unread[slot] = 0
  renderUnreadBadges()
  await api('/api/notifications/seen', { slot, seenAt: new Date(at).toISOString() })
}

$('#nfMarkRead').addEventListener('click', async (e) => {
  const slot = state.actAs
  e.target.disabled = true
  try {
    await markNotificationsSeen(slot, Date.now())
    if (slot === state.actAs) {
      for (const g of nf.groups) g.isRead = true
      renderNotifications()
    }
    toast(`Marked all as read for ${acctName(slot)}`)
  } catch (err) {
    delete nf.clearedAt[slot]
    refreshUnread()
    toast(err.message)
  } finally {
    e.target.disabled = false
  }
})

function renderNotifHeader() {
  $('#nfAccount').hidden = state.accounts.length < 2
  $('#nfAccount').innerHTML = state.accounts.map((a) => {
    const n = nf.unread[a.slot] ?? 0
    return `<button type="button" data-slot="${a.slot}" class="${a.slot === state.actAs ? 'on' : ''}" title="@${esc(a.handle)}">${badge(a.slot)} ${n ? `<span class="nf-count">${n > 99 ? '99+' : n}</span>` : ''}</button>`
  }).join('')
  $('#nfTabs').innerHTML = NF_TABS.map(([k, l]) => `<button type="button" data-value="${k}" class="${nf.feed === k ? 'on' : ''}">${l}</button>`).join('')
}

async function loadNotifications(reset = false) {
  if (!reset && (nf.loading || !nf.cursor)) return
  const seq = ++nf.seq
  nf.loading = true
  const slot = state.actAs
  const end = $('#nfEnd')
  if (reset) {
    nf.groups = []
    nf.cursor = null
    nf.expanded.clear()
    nf.extraActors.clear()
    $('#nfPill').hidden = true
    $('#nfList').innerHTML = ''
    renderNotifHeader()
  }
  end.textContent = 'Loading…'
  try {
    const q = new URLSearchParams({ slot, feed: nf.feed })
    if (nf.cursor) q.set('cursor', nf.cursor)
    const data = await api(`/api/notifications?${q}`)
    if (seq !== nf.seq) return
    nf.groups.push(...data.groups)
    nf.cursor = data.cursor
    if (reset) {
      nf.newestAt = data.newestAt
      // As on Bluesky, only "All" marks notifications as seen, since the other tabs leave things out.
      // What's already drawn stays tinted until the next refresh.
      // Bluesky counts a notification as unread when its time equals the seen time, so go just past it.
      const hasUnread = data.groups.some((g) => !g.isRead)
      if (nf.feed === 'all' && data.newestAt && (hasUnread || (nf.unread[slot] ?? 0) > 0)) {
        markNotificationsSeen(slot, Date.parse(data.newestAt) + 1).catch(() => {})
      }
    }
    renderNotifications()
    end.textContent = nf.cursor ? '' : nf.groups.length ? "That's all your notifications." : ''
  } catch (err) {
    if (seq === nf.seq) end.textContent = `Couldn't load notifications: ${err.message}`
  } finally {
    if (seq === nf.seq) nf.loading = false
  }
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && state.view === 'notifications' && nf.cursor) loadNotifications()
}, { rootMargin: '600px' }).observe($('#nfEnd'))

async function checkNewNotifications() {
  if (state.view !== 'notifications' || document.hidden || !nf.newestAt) return
  try {
    const q = new URLSearchParams({ slot: state.actAs, feed: nf.feed, limit: 1 })
    const { newestAt } = await api(`/api/notifications?${q}`)
    if (newestAt && newestAt > nf.newestAt) $('#nfPill').hidden = false
  } catch {}
}

function nfName(p) {
  return `<b data-profile="${esc(p.did)}">${esc(p.displayName || p.handle)}</b>`
}

function nfAvatar(p, type) {
  const [icon, tone] = NF_ICONS[type] ?? ['•', 'muted']
  return `<div class="nf-avatar"><img class="avatar" data-profile="${esc(p.did)}" loading="lazy" src="${esc(p.avatar ?? '')}" alt=""><span class="nf-icon nf-${tone}">${icon}</span></div>`
}

function nfThumbs(post) {
  const e = post.embed
  const images = e?.images ?? e?.media?.images
  const blur = isSensitive(post.labels)
  if (images?.length) return `<div class="nf-thumbs">${images.slice(0, 2).map((i) => `<img loading="lazy" src="${esc(i.thumb)}" alt="${esc(i.alt)}" class="${blur ? 'blurred' : ''}">`).join('')}</div>`
  const thumb = e?.thumbnail ?? e?.media?.thumbnail
  return thumb ? `<div class="nf-thumbs"><img loading="lazy" src="${esc(thumb)}" alt="" class="${blur ? 'blurred' : ''}"></div>` : ''
}

// "A liked…", "A and B liked…" or "A and 24 others liked…". A pair is fully named, so it doesn't expand.
function nfSentence(g, verb) {
  const [first, second] = g.actors
  const others = g.count - 1
  if (others <= 0) return { html: `${nfName(first)} ${verb}`, expands: false }
  if (others === 1 && second) return { html: `${nfName(first)} and ${nfName(second)} ${verb}`, expands: false }
  return { html: `${nfName(first)} and <b>${others.toLocaleString()} ${others === 1 ? 'other' : 'others'}</b> ${verb}`, expands: true }
}

function nfActorList(g) {
  const actors = [...g.actors, ...(nf.extraActors.get(g.id) ?? [])]
  const left = g.actorDids.filter((d) => !actors.some((a) => a.did === d)).length
  return `<div class="nf-people">${actors.map((a) => `<div class="nf-person"><img class="avatar" data-profile="${esc(a.did)}" loading="lazy" src="${esc(a.avatar ?? '')}" alt="">
      <span>${nfName(a)}<small class="dim" data-profile="${esc(a.did)}">@${esc(a.handle)}</small></span></div>`).join('')}
    ${left ? `<button type="button" class="link-btn" data-nf="more" data-id="${esc(g.id)}">Show more</button>` : ''}</div>`
}

function nfAvatarRow(g, expandable) {
  const open = nf.expanded.has(g.id)
  if (!expandable) return ''
  return `<button type="button" class="nf-row-avatars" data-nf="expand" data-id="${esc(g.id)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} list of users">
    ${g.actors.slice(1, 8).map((a) => `<img src="${esc(a.avatar ?? '')}" alt="">`).join('')}<span class="nf-chevron">${open ? '▲' : '▼'}</span></button>`
}

function nfParent(g) {
  const p = g.parent
  if (!p) return ''
  const inReply = g.type !== 'reply'
  if (p.type !== 'post') {
    const what = p.type === 'blocked' ? 'a blocked post' : 'a deleted post'
    return `<div class="nf-context">${inReply ? 'in reply to' : 'replied to'} ${what}</div>`
  }
  const mine = p.post.author.did === state.accounts.find((a) => a.slot === state.actAs)?.did
  const who = mine ? '<b>you</b>' : nfName(p.post.author)
  const text = (p.post.record?.text ?? '').replace(/\s+/g, ' ').trim()
  return `<div class="nf-context">${inReply ? 'in reply to' : 'replied to'} ${who}${text ? `: ${esc(text)}` : ''}</div>`
}

// A notification about someone's post: who, what it answers, the post itself, and ways to respond
function nfPostRow(id, type, post, parentHolder, isRead, at) {
  const viewer = { [state.actAs]: { like: post.viewer?.like, repost: post.viewer?.repost } }
  state.posts.set(post.uri, { post, viewer })
  return `<article class="nf-item ${isRead ? '' : 'unread'}" data-nf-post="${esc(post.uri)}">
    ${nfAvatar(post.author, type)}
    <div class="nf-main">
      <div class="meta">${nfName(post.author).replace('<b ', '<span class="name" ').replace('</b>', '</span>')}
        <span class="handle" data-profile="${esc(post.author.did)}">@${esc(post.author.handle)}</span></div>
      ${nfParent(parentHolder)}
      <div class="text">${renderText(post.record?.text, post.record?.facets)}</div>
      ${renderEmbed(post)}
      <time class="nf-time" title="${esc(new Date(at).toLocaleString())}">${ago(at)}</time>
      ${renderActions(post, viewer)}
    </div></article>`
}

function nfProfileBio(p) {
  return p.description ? `<div class="nf-preview">${esc(p.description)}</div>` : ''
}

function renderNfItem(g) {
  const at = g.indexedAt
  const base = (type, primaryProfile, inner, attrs = '', trailing = '') => `<article class="nf-item ${g.isRead ? '' : 'unread'}" ${attrs}>
      ${nfAvatar(primaryProfile, type)}
      <div class="nf-main">${inner}<time class="nf-time" title="${esc(new Date(at).toLocaleString())}">${ago(at)}</time></div>${trailing}</article>`

  switch (g.type) {
    case 'reply':
    case 'quote':
    case 'mention':
      return nfPostRow(g.id, g.type, g.post, g, g.isRead, at)
    case 'subscribedPost':
      return g.items.map((i) => nfPostRow(g.id, 'subscribedPost', i.post, { type: 'reply', parent: i.parent }, g.isRead, at)).join('')
    case 'like':
    case 'repost':
    case 'likeViaRepost':
    case 'repostViaRepost': {
      const verb = { like: 'liked your post', repost: 'reposted your post', likeViaRepost: 'liked your repost', repostViaRepost: 'reposted your repost' }[g.type]
      const { html, expands } = nfSentence(g, verb)
      const preview = (g.post.record?.text ?? '').replace(/\s+/g, ' ').trim()
      return base(g.type, g.actors[0], `${nfAvatarRow(g, expands)}<div class="nf-sentence">${html}</div>
        ${preview ? `<div class="nf-preview">${esc(preview)}</div>` : ''}
        ${nf.expanded.has(g.id) ? nfActorList(g) : ''}`, `data-nf-open="${esc(g.post.uri)}"`, nfThumbs(g.post))
    }
    case 'multiPostLike':
    case 'multiPostRepost':
    case 'multiPostLikeViaRepost':
    case 'multiPostRepostViaRepost': {
      const verb = g.type.includes('Like') ? 'liked' : 'reposted'
      const noun = g.type.includes('ViaRepost') ? 'repost' : 'post'
      const open = nf.expanded.has(g.id)
      const preview = (g.posts[0].record?.text ?? '').replace(/\s+/g, ' ').trim()
      return base(g.type, g.actor, `<div class="nf-sentence">${nfName(g.actor)} ${verb} <b>${g.count}</b> of your ${noun}${g.count === 1 ? '' : 's'}
          <button type="button" class="nf-toggle" data-nf="expand" data-id="${esc(g.id)}" aria-expanded="${open}">${open ? '▲' : '▼'}</button></div>
        ${preview && !open ? `<div class="nf-preview">${esc(preview)}</div>` : ''}
        ${open ? `<div class="nf-people">${g.posts.map((p) => `<button type="button" class="nf-post-link" data-open-thread="${esc(p.uri)}">${esc((p.record?.text ?? '').replace(/\s+/g, ' ').trim() || 'Post with media')}</button>`).join('')}</div>` : ''}`, `data-nf-toggle="${esc(g.id)}"`)
    }
    case 'follow': {
      const { html, expands } = nfSentence(g, 'followed you')
      const via = g.starterPack ? `<div class="nf-preview">via starter pack ${esc(g.starterPack.record?.name ?? '')}</div>` : ''
      return base('follow', g.actors[0], `${nfAvatarRow(g, expands)}<div class="nf-sentence">${html}</div>${via}${nf.expanded.has(g.id) ? nfActorList(g) : ''}`,
        expands ? `data-nf-toggle="${esc(g.id)}"` : `data-nf-profile="${esc(g.actors[0].did)}"`)
    }
    case 'followBack':
      return base('followBack', g.actor, `<div class="nf-sentence">${nfName(g.actor)} followed you back! 🎉</div>${nfProfileBio(g.actor)}`, `data-nf-profile="${esc(g.actor.did)}"`)
    case 'verified':
      return base('verified', g.actor, `<div class="nf-sentence">${nfName(g.actor)} verified you</div>`, `data-nf-profile="${esc(g.actor.did)}"`)
    case 'unverified':
      return base('unverified', g.actor, `<div class="nf-sentence">${nfName(g.actor)} removed their verification from your account</div>`, `data-nf-profile="${esc(g.actor.did)}"`)
    case 'starterPackJoined':
      return base('starterPackJoined', g.actor, `<div class="nf-sentence">${nfName(g.actor)} joined Bluesky with your starter pack${g.starterPack?.record?.name ? ` ${esc(g.starterPack.record.name)}` : ''}</div>`, `data-nf-profile="${esc(g.actor.did)}"`)
    case 'contactMatch':
      return base('contactMatch', g.actor, `<div class="nf-sentence">${nfName(g.actor)}, from your contacts, is on Bluesky</div>${nfProfileBio(g.actor)}`, `data-nf-profile="${esc(g.actor.did)}"`)
    case 'generatorLike': {
      const { html, expands } = nfSentence(g, `liked your custom feed <b>${esc(g.generator.displayName ?? '')}</b>`)
      return base('generatorLike', g.actors[0], `${nfAvatarRow(g, expands)}<div class="nf-sentence">${html}</div>${nf.expanded.has(g.id) ? nfActorList(g) : ''}`, expands ? `data-nf-toggle="${esc(g.id)}"` : '')
    }
    default:
      return ''
  }
}

// The Follows tab is a list of people rather than a feed, so it has no times or Today/Earlier split
function renderFollowers() {
  const seen = new Set()
  const rows = []
  for (const g of nf.groups) {
    for (const a of g.type === 'follow' ? g.actors : g.actor ? [g.actor] : []) {
      if (seen.has(a.did)) continue
      seen.add(a.did)
      const following = !!a.viewer?.following
      rows.push(`<div class="nf-item nf-follower ${g.isRead ? '' : 'unread'}">
        <img class="avatar" data-profile="${esc(a.did)}" loading="lazy" src="${esc(a.avatar ?? '')}" alt="">
        <div class="nf-main">${nfName(a)}<small class="dim" data-profile="${esc(a.did)}">@${esc(a.handle)}</small></div>
        ${following ? '<span class="pc-btn nf-following">Following</span>' : `<button type="button" class="pc-btn follow" data-nf="follow" data-did="${esc(a.did)}">Follow</button>`}</div>`)
    }
  }
  return rows.length ? `<h3 class="nf-section">Followed you</h3>${rows.join('')}` : ''
}

function renderNotifications() {
  const list = $('#nfList')
  if (nf.feed === 'followers') {
    list.innerHTML = renderFollowers()
  } else {
    const isToday = (at) => new Date(at).toDateString() === new Date().toDateString()
    const hasToday = nf.groups.length > 0 && isToday(nf.groups[0].indexedAt)
    let addedEarlier = false
    let html = hasToday ? '<h3 class="nf-section">Today</h3>' : ''
    for (const g of nf.groups) {
      if (hasToday && !addedEarlier && !isToday(g.indexedAt)) {
        html += '<h3 class="nf-section">Earlier</h3>'
        addedEarlier = true
      }
      html += renderNfItem(g)
    }
    list.innerHTML = html
  }
  if (!nf.groups.length && !nf.cursor) {
    list.innerHTML = `<div class="feed-end">${nf.feed === 'activity'
      ? 'No posts here yet. Click the 🔔 bell icon on someone’s Bluesky profile to get notified when they post.'
      : "No notifications here yet."}</div>`
  }
}

$('#nfTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]')
  if (!b || nf.feed === b.dataset.value) return
  nf.feed = b.dataset.value
  loadNotifications(true)
  window.scrollTo({ top: 0 })
})
$('#nfAccount').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-slot]')
  if (b && Number(b.dataset.slot) !== state.actAs) setActAs(Number(b.dataset.slot))
})
$('#nfPill').addEventListener('click', () => {
  loadNotifications(true)
  window.scrollTo({ top: 0, behavior: 'smooth' })
})

$('#nfList').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-nf]')
  if (action) {
    const { nf: kind, id, did } = action.dataset
    action.disabled = true
    try {
      if (kind === 'expand') {
        nf.expanded.has(id) ? nf.expanded.delete(id) : nf.expanded.add(id)
        return renderNotifications()
      }
      if (kind === 'more') {
        const g = nf.groups.find((x) => x.id === id)
        const known = [...g.actors, ...(nf.extraActors.get(id) ?? [])]
        const next = g.actorDids.filter((d) => !known.some((a) => a.did === d)).slice(0, 25)
        const profiles = await api(`/api/notifications/profiles?slot=${state.actAs}&dids=${next.join(',')}`)
        nf.extraActors.set(id, [...(nf.extraActors.get(id) ?? []), ...profiles])
        return renderNotifications()
      }
      if (kind === 'follow') {
        const res = await api('/api/follows/follow', { dids: [did], slots: [state.actAs] })
        if (res.failed?.length) throw new Error(res.failed[0].error)
        toast(`Followed from ${acctName(state.actAs)}`)
        for (const g of nf.groups) {
          for (const a of g.actors ?? (g.actor ? [g.actor] : [])) if (a.did === did) a.viewer = { ...a.viewer, following: 'yes' }
        }
        return renderNotifications()
      }
    } catch (err) {
      toast(err.message)
    } finally {
      action.disabled = false
    }
    return
  }
  if (e.target.closest('a, button, [data-profile], .actions, .quote, .ext, .video, .images')) return
  const toggleRow = e.target.closest('[data-nf-toggle]')
  if (toggleRow) {
    const id = toggleRow.dataset.nfToggle
    nf.expanded.has(id) ? nf.expanded.delete(id) : nf.expanded.add(id)
    return renderNotifications()
  }
  const profileRow = e.target.closest('[data-nf-profile]')
  if (profileRow) return openProfileCard(profileRow.dataset.nfProfile, profileRow)
  const postRow = e.target.closest('[data-nf-open], [data-nf-post]')
  if (postRow) showThread(postRow.dataset.nfOpen ?? postRow.dataset.nfPost)
})

// ---------- language filter ----------

// One setting for every feed; there's a checkbox in the feed filters and one in the Trending controls
function syncEnglishBoxes() {
  document.querySelectorAll('.english-only').forEach((box) => (box.checked = state.englishOnly))
}
document.querySelectorAll('.english-only').forEach((box) =>
  box.addEventListener('change', () => {
    state.englishOnly = box.checked
    safeSet('englishOnly', state.englishOnly ? '1' : '0')
    syncEnglishBoxes()
    if (state.view === 'trending') {
      tr.topic = null
      showView('trending')
    } else loadFeed(true)
  }),
)
syncEnglishBoxes()

// ---------- theme ----------

// Cycles Auto (follow the system) → Light → Dark
const THEMES = { auto: ['◐', 'Theme: automatic (follows your system). Click for light'], light: ['☀', 'Theme: light. Click for dark'], dark: ['☾', 'Theme: dark. Click for automatic'] }
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  const [icon, label] = THEMES[t]
  $('#themeBtn').textContent = icon
  $('#themeBtn').title = label
  $('#themeBtn').setAttribute('aria-label', label)
}
let theme = ['light', 'dark'].includes(safeGet('theme')) ? safeGet('theme') : 'auto'
applyTheme(theme)
$('#themeBtn').addEventListener('click', () => {
  theme = { auto: 'light', light: 'dark', dark: 'auto' }[theme]
  safeSet('theme', theme)
  applyTheme(theme)
})

// ---------- header & status ----------

function renderActAs() {
  const el = $('#actAs')
  if (!state.accounts.length) return (el.innerHTML = '')
  el.innerHTML = '<span class="label">Act as</span>' + state.accounts
    .map((a) => `<button role="radio" class="acct-${a.slot}" aria-checked="${a.slot === state.actAs}" data-slot="${a.slot}" title="@${esc(a.handle)}">${badge(a.slot)}<span class="h">@${esc(a.handle)}</span></button>`)
    .join('')
}
function setActAs(slot) {
  state.actAs = slot
  safeSet('actAs', state.actAs)
  renderActAs()
  // Notifications belong to one account, so that tab follows whichever one you're acting as
  if (state.view === 'notifications') return loadNotifications(true)
  // Re-draw like/repost highlights for the newly selected account
  document.querySelectorAll('.actions[data-uri]').forEach((el) => {
    const known = state.posts.get(el.dataset.uri)
    if (known) el.outerHTML = renderActions(known.post, known.viewer)
  })
}
$('#actAs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-slot]')
  if (btn) setActAs(Number(btn.dataset.slot))
})

function renderWho(follows) {
  const el = $('#whoFilter')
  const opts = [['all', 'Everyone']]
  for (const a of state.accounts) opts.push([String(a.slot), `${LETTERS[a.slot]} follows`])
  if (state.accounts.length >= 2) opts.push(['both', `${allLabel()}${follows ? ` (${follows.both})` : ''}`])
  el.hidden = state.accounts.length < 2
  el.innerHTML = opts.map(([v, label]) => `<button data-value="${v}" class="${state.who === v ? 'on' : ''}">${esc(label)}</button>`).join('')
}

// ---------- accounts (Settings) ----------

let lastStatus = null

function renderAccounts() {
  const s = lastStatus
  if (!s) return
  $('#acList').innerHTML = s.accounts.length
    ? `<ul class="ac-list">${s.accounts.map((a) => `<li>
        ${badge(a.slot)} <b>@${esc(a.handle)}</b>
        ${a.ok ? '' : `<span class="err">${esc(a.error ?? 'Not signed in')}</span>`}
        ${a.source === 'dashboard'
          ? `<button type="button" class="pc-btn" data-ac-remove="${a.slot}">Remove</button>`
          : '<span class="dim" title="Set in the server settings file (.env)">server settings</span>'}
      </li>`).join('')}</ul>`
    : '<p class="dim">No accounts yet.</p>'
  const full = s.configured >= (s.maxAccounts ?? 4)
  $('#acForm').hidden = full
  if (full) $('#acList').insertAdjacentHTML('beforeend', `<p class="dim">That's the most Skydash handles (${s.maxAccounts}). Remove one to add another.</p>`)
}

function openAccounts() {
  $('#acError').textContent = ''
  $('#acRestarting').hidden = true
  renderAccounts()
  $('#accountsDialog').showModal()
}
$('#accountsBtn').addEventListener('click', openAccounts)

// After an add or remove the server restarts; wait for it to come back, then reload the page
async function waitForRestart() {
  $('#acForm').hidden = true
  $('#acRestarting').hidden = false
  await new Promise((r) => setTimeout(r, 4_000))
  for (let i = 0; i < 40; i++) {
    try {
      await api('/api/status')
      return location.reload()
    } catch {
      await new Promise((r) => setTimeout(r, 1_500))
    }
  }
  $('#acRestarting').textContent = 'Skydash is taking a while to come back. Reload this page in a minute.'
}

$('#acForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('#acAdd')
  btn.disabled = true
  $('#acError').textContent = ''
  try {
    await api('/api/accounts/add', { handle: $('#acHandle').value, appPassword: $('#acPassword').value })
    $('#acPassword').value = ''
    await waitForRestart()
  } catch (err) {
    $('#acError').textContent = err.message
  } finally {
    btn.disabled = false
  }
})

$('#acList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ac-remove]')
  if (!btn) return
  const slot = Number(btn.dataset.acRemove)
  const a = lastStatus?.accounts.find((x) => x.slot === slot)
  if (!confirm(`Remove @${a?.handle ?? slot} from Skydash? Its posts stay on Bluesky; you can add it again later.`)) return
  btn.disabled = true
  try {
    await api('/api/accounts/remove', { slot })
    await waitForRestart()
  } catch (err) {
    btn.disabled = false
    toast(err.message)
  }
})

function renderSetup(s) {
  const el = $('#setup')
  const failed = s.accounts.filter((a) => !a.ok)
  if (s.configured > 0 && failed.length === 0) return (el.hidden = true)
  el.hidden = false
  el.innerHTML = s.configured === 0
    ? `<h2>Add your accounts</h2>
       <p>Click <b>⚙</b> at the top right and add each account with an <b>app password</b>
       (Bluesky → Settings → Privacy and Security → App Passwords).</p>`
    : `<h2>Sign-in problem</h2>${failed.map((a) => `<p class="err">@${esc(a.handle)}: ${esc(a.error)}</p>`).join('')}
       <p>Open <b>⚙</b> at the top right to remove the account and add it again with a new app password.</p>`
}

async function refreshStatus() {
  try {
    const s = await api('/api/status')
    lastStatus = s
    state.feedHours = s.feedHours
    const c = s.collector
    const b = s.backfill
    let text = c.connected ? `Live · ${s.storedPosts.toLocaleString()} posts stored` : (c.error || 'Connecting…')
    if (b.running) text += ` · catching up ${b.done}/${b.total}`
    $('#status').innerHTML = `<span class="dot ${c.connected ? 'live' : 'down'}"></span><span class="status-text">${esc(text)}</span>`
    $('#status').title = s.version ? `Collector status · code version ${s.version}` : 'Collector status'
    return s
  } catch {
    $('#status').innerHTML = '<span class="dot down"></span><span class="status-text">Dashboard server is not running</span>'
    return null
  }
}

async function init() {
  const s = await refreshStatus()
  if (!s) return
  lastStatus = s
  state.accounts = s.accounts.filter((a) => a.ok)
  if (!state.accounts.some((a) => a.slot === state.actAs)) state.actAs = state.accounts[0]?.slot ?? 1
  renderSetup(s)
  renderActAs()
  renderWho(s.follows)
  $('#filters').hidden = state.accounts.length === 0
  document.querySelector('.tabs').hidden = state.accounts.length === 0
  if (state.accounts.length) showView(state.view)

  // While the first backfill runs, keep refreshing so posts appear as they arrive
  let wasRunning = s.backfill.running
  setInterval(async () => {
    const st = await refreshStatus()
    if (st && wasRunning && !st.backfill.running && state.view === 'following') loadFeed(true)
    if (st) wasRunning = st.backfill.running
    if (state.view === 'keywords') loadKeywords()
    // Keep the stats fresh while history is still being read (not while a dialog is open)
    if (state.view === 'follows' && st?.backfill.running && !$('#actionDialog').open) loadFollows()
  }, 10_000)
  setInterval(checkNew, 30_000)
  refreshUnread()
  setInterval(() => {
    refreshUnread()
    checkNewNotifications()
  }, 30_000)
}

init()
