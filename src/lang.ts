// Decides whether a post is in English: by its language label when it has one,
// otherwise by looking at the text itself.

// Very common English words, and very common words in other Latin-script languages that are not
// also English words. A post is called non-English only on positive evidence of another language,
// so English headlines and job posts (few small words) are kept.
const ENGLISH = new Set(
  `the and to of a in is it you that for on with this be are was at as have not but they i my we your so what just he she
  from by or an will can all about if me do no has our their his her more out up get like one who now how when there been
  would don't it's i'm can't didn't isn't that's here new after over than then them us its were had did why any some only
  says said into off still too very you're we're they're being because`.split(/\s+/),
)
const OTHER = new Set(
  `el la los las del por para una uno que y es está están pero como más muy también sobre hasta desde porque
  der das und ist nicht mit auf ein eine einen zu für sich auch dem den des im ich wir sie werden wurde oder aber noch
  le les des et est une pour dans pas qui sur avec du au aux ce cette sont nous vous mais plus très ont été
  os não uma com mais pelo pela são foi também
  il di che è per della delle degli sono anche nel alla più
  het een van niet dat wat zijn maar ook voor`.split(/\s+/),
)

export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  // Emoji-only, link-only or very short posts carry no language signal; keep them
  if (letters.length < 3) return true
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length
  if (latin / letters.length < 0.5) return false // mostly Japanese, Arabic, Cyrillic, ...

  const words = (text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}][\p{L}'’]*/gu) ?? []).map((w) =>
    w.replace(/’/g, "'"),
  )
  const english = words.filter((w) => ENGLISH.has(w)).length
  const other = words.filter((w) => OTHER.has(w)).length
  if (other >= 2 && other > english) return false
  // Lots of accented letters (ä ö ü ß é ñ ç ã ...) with little English is another language
  const accented = letters.filter((c) => /[^a-z]/i.test(c) && /\p{Script=Latin}/u.test(c)).length
  if (accented / letters.length > 0.03 && english <= 1 && words.length >= 4) return false
  return true
}

// langs: the post's language labels (comma-separated as stored, or an array)
export function isEnglish(langs: string | string[] | null | undefined, text: string): boolean {
  const list = (Array.isArray(langs) ? langs : (langs ?? '').split(',')).map((l) => l.trim().toLowerCase()).filter(Boolean)
  if (list.length) return list.some((l) => l === 'en' || l.startsWith('en-'))
  return looksEnglish(text ?? '')
}
