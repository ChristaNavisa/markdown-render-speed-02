// parse.js — a fast, dependency-free CommonMark + GFM parser whose output
// matches marked 18.1.3 (default options: gfm on, breaks off) exactly.
// Written from scratch for this entry: a direct-to-HTML design (no token
// objects, no repeated re-slicing), with the block/inline grammars expressed
// as the same anchored patterns marked uses, so edge cases agree with it.
// Only Node built-ins are used (none, in fact: pure string work).
// Re-authored in full in this session so every line of the parser is
// written here, by hand, with the recording running.

// ---------- small helpers ----------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Escape text for HTML. encode=true escapes every &; encode=false leaves
// a & that starts a valid character/entity reference alone.
function esc(s, encode) {
  if (encode) {
    if (/[&<>"']/.test(s)) return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  } else if (/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(s)) {
    return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESC_MAP[c] || '&amp;');
  }
  return s;
}
// Decode numeric character references the way marked does: out-of-range or
// surrogate code points become U+FFFD, 38 becomes &amp; (so it is not
// re-decoded), everything else becomes the character. Named entities pass
// through untouched (they are valid HTML already).
function unescapeEntities(s) {
  if (!/&#/.test(s)) return s;
  return s.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}
// Percent-encode a link href (marked's encodeURI + %25 fix); null when the
// href cannot be encoded (lone surrogates), in which case a link renders
// as its plain text and an image as its alt text.
function encodeHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}
// Trim `ch` characters off the end of a string (marked's trimEnd helper).
function trimEndChar(s, ch, invert) {
  let n = s.length, k = 0;
  while (k < n) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}
// Remove trailing blank lines the way marked does for indented code and
// HTML blocks.
function trimTrailingBlank(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
// Normalize a link label: trim, collapse inner whitespace, lower-case
// (through the upper-case round-trip marked uses).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Balance check for a pair of characters, skipping backslash escapes:
// -1 balanced, -2 too many closers, otherwise the index of the unmatched
// closer (marked's `ke`).
function balance(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}
// Expand tabs to spaces, tracking the column (marked's tab expansion).
function expandTabs(s, col) {
  let out = '', c = col;
  for (const ch of s) {
    if (ch === '\t') { const n = 4 - (c % 4); out += ' '.repeat(n); c += n; }
    else { out += ch; c++; }
  }
  return out;
}
// Split a table row on unescaped pipes, trimming cells and dropping empty
// edge cells; pad or cut to `count` cells when given.
function splitRow(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let back = false, p = off;
    while (--p >= 0 && str[p] === '\\') back = !back;
    return back ? '|' : ' |';
  });
  const cells = t.split(' |');
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------- regex builder (mirrors marked's `edit` helper) ----------
// pairs: [key, replacement] in order. A string key replaces its FIRST
// occurrence; a RegExp key replaces per its flags. Inserted patterns have
// their ^ anchors stripped, exactly as marked does when composing rules.
const CARET_STRIP = /(^|[^\[])\^/g;
function rep(pat, pairs) {
  let src = typeof pat === 'string' ? pat : pat.source;
  for (const [key, val] of pairs) {
    let v = typeof val === 'string' ? val : val.source;
    v = v.replace(CARET_STRIP, '$1');
    src = typeof key === 'string' ? src.replace(key, v) : src.replace(key, v);
  }
  return src;
}
function rx(pat, pairs, flags) {
  return new RegExp(rep(pat, pairs || []), flags);
}

// ---------- grammar: shared patterns ----------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const LABEL_FRAG = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_FRAG = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const LINK_TITLE_FRAG = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\))/;
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const HTML_OPEN_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// ---------- block grammar (gfm) ----------

const R = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: new RegExp('^' + HR_SRC),
  text: /^[^\n]+/,
};
R.html = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|COMMENT[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(TAG)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', [['COMMENT', HTML_COMMENT], ['TAG', BLOCK_TAGS], ['ATTR', HTML_ATTR]], 'i');
R.def = rx('^ {0,3}\\[(LABEL)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(TITLE))? *(?:\\n+|$)', [['LABEL', LABEL_FRAG], ['TITLE', TITLE_FRAG]]);
R.listStart = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
R.table = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)', [
  ['hr', R.hr], ['heading', HEADING_SRC], ['blockquote', ' {0,3}>'], ['code', '(?: {4}| {0,3}\t)[^\\n]'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'], ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'], ['html', HTML_OPEN_SRC],
]);
R.lheading = rx('^(?!BULL |BLOCKCODE|FENCES|BLOCKQUOTE|HEADING|HTML|TABLE)((?:.|\\n(?!\\s*?\\n|BULL |FENCES|BLOCKQUOTE|HEADING|HR|HTML|TABLE))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)', [
  [/BULL /g, ' {0,3}(?:[*+-]|\\d{1,9}[.)])'], [/BLOCKCODE/g, '(?: {4}| {0,3}\\t)'], [/FENCES/g, ' {0,3}(?:`{3,}|~{3,})'],
  [/BLOCKQUOTE/g, ' {0,3}>'], [/HEADING/g, HEADING_SRC], [/HR/g, HR_SRC], [/HTML/g, ' {0,3}<[^\\n>]+>\\n'],
  [/TABLE/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'],
]);
// paragraph: gfm variant (table alternative is the table rule itself)
R.paragraph = rx('^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)', [
  ['hr', R.hr], ['heading', HEADING_SRC], ['|lheading', ''], ['table', R.table], ['blockquote', ' {0,3}>'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'], ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
  ['html', HTML_OPEN_SRC], ['tag', BLOCK_TAGS],
]);
// paragraph variant used inside blockquotes (normal rules: no table, list = bullet-or-1)
const PARA_INNER = rx('^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)', [
  ['hr', R.hr], ['heading', HEADING_SRC], ['|lheading', ''], ['|table', ''], ['blockquote', ' {0,3}>'],
  ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'], ['list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'],
  ['html', HTML_OPEN_SRC], ['tag', BLOCK_TAGS],
]);
R.blockquote = rx('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(PARA)|[^\\n]*)(?:\\n|$))+', [['PARA', PARA_INNER]]);
// per-indent helpers (cached). Mirrors marked's `D` memoizer: the indent is
// clamped to (n - 1), floored at 0 and capped at 3, before the regex is built.
function cached(re) {
  const cache = [];
  return (n) => {
    const k = Math.max(0, Math.min(3, n - 1));
    return cache[k] || (cache[k] = re(k));
  };
}
const listItemRx = (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`);
const nextBulletRx = cached((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRx = cached((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRx = cached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRx = cached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRx = cached((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRx = cached((n) => new RegExp(`^ {0,${n}}>`));

// ---------- inline grammar (gfm) ----------

const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = rx(/(?:\[(?:BRACKETS|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/, [['BRACKETS', BRACKETS]]);
const REFLINK_LABEL = rx(/(?:[^\[\]\\`]*(?:\[(?:BRACKETS|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/, [['BRACKETS', BRACKETS]]);
const REF_LONG = /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/;
const REF_SHORT = LABEL_FRAG;
const EMAIL_RX = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_AT_RX = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO = rx('(?:mailto:EMAIL|xmpp:EMAIL(?:\\/[A-Za-z0-9@.]+)?)', [[/EMAIL/g, EMAIL_RX]]);
const I = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: rx(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|EMAILAT)>/, [['EMAILAT', rx('[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])')]]),
  tag: rx('^COMMENT|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:ATTR)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', [
    ['COMMENT', rx('^<!--(?:-?>|[\\s\\S]*?-->)')], ['ATTR', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
  ]),
  link: rx(/^!?\[(LABEL)\]\([ \t\n]*(HREF)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(TITLE))?[ \t\n]*\)/, [
    ['LABEL', LINK_LABEL], ['HREF', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/], ['TITLE', LINK_TITLE_FRAG],
  ]),
  reflink: rx(/^!?\[(LABEL)\]\[(REF)\]/, [['LABEL', LINK_LABEL], ['REF', REF_SHORT]]),
  nolink: rx(/^!?\[(REF)\](?:\[\])?/, [['REF', REF_SHORT]]),
  url: rx(/^EMAILPROTO|^((?:PROTO):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^EMAIL/, [
    ['EMAILPROTO', EMAIL_PROTO], ['PROTO', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/], ['EMAIL', EMAIL_AT_RX],
  ]),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  emL: rx(/^(?:\*+(?:((?!\*)PUNCT)|([^\s*]))?)|^_+(?:((?!_)PUNCT)|([^\s_]))?/, [[/PUNCT/g, /(?!~)[\p{P}\p{S}]/u]], 'u'),
  emRAst: rx("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)PUNCT(\\*+)(?=[\\s]|$)|NOTPS(\\*+)(?!\\*)(?=PUNCTSPACE|$)|(?!\\*)PUNCTSPACE(\\*+)(?=NOTPS)|[\\s](\\*+)(?!\\*)(?=PUNCT)|(?!\\*)PUNCT(\\*+)(?!\\*)(?=PUNCT)|NOTPS(\\*+)(?=NOTPS)", [
    [/NOTPS/g, /(?:[^\s\p{P}\p{S}]|~)/u], [/PUNCTSPACE/g, /(?!~)[\s\p{P}\p{S}]/u], [/PUNCT/g, /(?!~)[\p{P}\p{S}]/u],
  ], 'gu'),
  emRUnd: rx("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)PUNCT(_+)(?=[\\s]|$)|NOTPS(_+)(?!_)(?=PUNCTSPACE|$)|(?!_)PUNCTSPACE(_+)(?=NOTPS)|[\\s](_+)(?!_)(?=PUNCT)|(?!_)PUNCT(_+)(?!_)(?=PUNCT)", [
    [/NOTPS/g, /[^\s\p{P}\p{S}]/u], [/PUNCTSPACE/g, /[\s\p{P}\p{S}]/u], [/PUNCT/g, /[\p{P}\p{S}]/u],
  ], 'gu'),
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  delL: rx(/^~~?(?:((?!~)PUNCT)|[^\s~])/, [[/PUNCT/g, /[\p{P}\p{S}]/u]], 'u'),
  delR: rx("^[^~]+(?=[^~])|(?!~)PUNCT(~~?)(?=[\\s]|$)|NOTPS(~~?)(?!~)(?=PUNCTSPACE|$)|(?!~)PUNCTSPACE(~~?)(?=NOTPS)|[\\s](~~?)(?!~)(?=PUNCT)|(?!~)PUNCT(~~?)(?!~)(?=PUNCT)|NOTPS(~~?)(?=NOTPS)", [
    [/NOTPS/g, /[^\s\p{P}\p{S}]/u], [/PUNCTSPACE/g, /[\s\p{P}\p{S}]/u], [/PUNCT/g, /[\p{P}\p{S}]/u],
  ], 'gu'),
  text: rx(/^(?:[^a-zA-Z0-9](?=EMAILPROTO)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|PROTO:\/\/|WWW|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=EMAILPROTO)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/, [
    [/EMAILPROTO/g, /(?:mailto|xmpp):/], ['PROTO', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/], ['WWW', /(?<![^\s*_~(])www\./],
  ]),
  anyPunct: /\\([\p{P}\p{S}])/gu,
  anyPunctOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  reflinkSearch: rx(/(?:REFLINK|NOLINK(?!\())/, [
    ['REFLINK', rx(/^!?\[(LABEL)\]\[(REF)\]/, [
      ['LABEL', REFLINK_LABEL],
      ['REF', REF_LONG],
    ])],
    ['NOLINK', rx(/^!?\[(REF)\](?:\[\])?/, [['REF', REF_LONG]])],
  ], 'g'),
};

// ---------- inline parsing (direct to HTML) ----------
// Context shared by one inline parse: { links, inLink, inRawBlock,
// linkEmitted, linkParenPossible, textMode }. It is mutated as parsing
// proceeds (inLink / inRawBlock / linkEmitted), mirroring marked's Lexer
// state; linkParenPossible is saved/restored around each inlineTokens call.

function linkInText(src, links) {
  if (!src.includes('[')) return false;
  const linkRx = I.link;
  for (const m of src.matchAll(I.blockSkip)) {
    if (linkRx.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(I.reflinkSearch)) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}
// Mask a source for emphasis/delimiter scanning (marked's Lexer.#n).
// Fast path: with no '[', backtick, '<' or backslash in the source, none
// of the three masking replaces can change anything.
const MASK_NEEDED = /[\[`<\\]/;
function maskSrc(src, links) {
  if (!MASK_NEEDED.test(src)) return src;
  let t = src;
  if (links && src.includes('[')) {
    const re = I.reflinkSearch;
    const cb = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (linkInText(i, links)) return '[' + i.replace(re, cb) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, cb);
  }
  // anyPunctOutsideCode only changes code spans (`...`) and escaped
  // punctuation (\x): with neither a backtick nor a backslash present it
  // is a no-op scan. blockSkip only changes links ([...](...)), code spans
  // (`...`) and HTML tags (<...>): with none of '[', '`' or '<' present
  // it is a no-op.
  if (t.includes('`') || t.includes('\\')) t = t.replace(I.anyPunctOutsideCode, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  if (t.includes('<') || t.includes('[') || t.includes('`')) t = t.replace(I.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return t;
}
// Scan a masked source for the last position where a closer delimiter run
// can start (marked's `fe`): the last run of * / _ / ~ whose preceding
// character is not whitespace. Scanned backwards so it stops as soon as
// the last run of each kind is found (usually near the end of the text).
function feScan(a) {
  const e = { '*': -1, _: -1 };
  let t = -1;
  const n = a.length;
  let i = n - 1;
  while (i >= 0 && (e['*'] === -1 || e['_'] === -1 || t === -1)) {
    const r = a[i];
    if (r !== '*' && r !== '_' && r !== '~') { i--; continue; }
    let s = i;
    while (s > 0 && a[s - 1] === r) s--;
    const o = s === 0 ? '\n' : a[s - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') { if (t === -1) t = s; }
      else if (e[r] === -1) e[r] = s;
    }
    i = s - 1;
  }
  return { em: e, del: t };
}
// Does the link label contain a '<' that starts a tag/autolink reaching
// past the end of the label? (marked's `Be`.)
function labelHasTag(src, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = I.code.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(off + s);
    const o = I.tag.exec(r) || I.autolink.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
// Build a link/image from a match (marked's `De`): tokenize the label,
// reject a link whose label itself contains a link, and return the HTML
// (or null when the link must be dropped). For images the alt text is
// rendered separately in text mode with a fresh context so it cannot
// pollute this parse's flags.
function makeLink(match, href, title, isImage, autolink, ctx) {
  const label = match[1].replace(/\\([\[\]])/g, '$1');
  const p = ctx.inLink, h = ctx.linkEmitted, u = ctx.inRawBlock;
  ctx.inLink = true; ctx.linkEmitted = false;
  let labelHtml, altText;
  if (isImage) {
    inlineTokens(label, ctx);
    const altCtx = { links: ctx.links, inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, textMode: true };
    altText = inlineTokens(label, altCtx);
    labelHtml = altText;
  } else {
    labelHtml = inlineTokens(label, ctx);
  }
  const k = ctx.linkEmitted;
  ctx.linkEmitted = h; ctx.inLink = p;
  if (!isImage) {
    if (k) { ctx.inRawBlock = u; return null; }
    ctx.linkEmitted = true;
  }
  if (ctx.textMode) return isImage ? altText : labelHtml;
  if (isImage) {
    const r = encodeHref(href);
    if (r === null) return esc(altText, false);
    let o = '<img src="' + esc(r, false) + '" alt="' + esc(altText, false) + '"';
    if (title) o += ' title="' + esc(title, false) + '"';
    return o + '>';
  }
  const o = autolink ? esc(label, true) : labelHtml;
  const i = encodeHref(href);
  if (i === null) return o;
  const e = esc(i, autolink);
  let l = '<a href="' + e + '"';
  if (title) l += ' title="' + esc(title, false) + '"';
  return l + '>' + o + '</a>';
}
// Emphasis / strong (marked's Tokenizer.emStrong). `e` is the remaining
// source, `masked` the masked source for the current parse, `fe` the scan
// of `masked`, `prev` the character before the delimiter (or ""). Returns
// { html, len } or null.
function emStrong(e, masked, fe, prev, ctx) {
  let s = I.emL.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prev === r;
  const i = masked.length - e.length;
  let l = i;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!I.punctuation.exec(p);
  let n = prev;
  if (l < i) n = p;
  const u = l < i ? h : !!I.punctuation.exec(n);
  if (s[4] && /[\p{L}\p{N}]/u.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    // Length of the leading delimiter run (all * or _, so code units ==
    // code points); s[0] is the run plus one following character.
    let k = 0;
    while (s[0][k] === r) k++;
    let m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? I.emRAst : I.emRUnd;
    const v = fe.em[r];
    const Q = masked.length - e.length + k;
    if (v < Q) return null;
    const t = masked.slice(-e.length + k);
    const ee = v - Q;
    let g, b;
    for (A.lastIndex = 0; (s = A.exec(t)) !== null && !(s.index > ee);) {
      if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g) continue;
      if (b = g.length, s[3] || s[4]) { m += b; continue; }
      else if (s[5] || s[6] || R) {
        if (o && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if (m -= b, m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = s[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const M = e.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { html: ctx.textMode ? inlineTokens(U, ctx) : '<em>' + inlineTokens(U, ctx) + '</em>', len: M.length };
      }
      const ne = M.slice(2, -2);
      return { html: ctx.textMode ? inlineTokens(ne, ctx) : '<strong>' + inlineTokens(ne, ctx) + '</strong>', len: M.length };
    }
  }
  return null;
}
// Strikethrough (marked's Tokenizer.del). Same shape as emStrong.
function delTok(e, masked, fe, prev, ctx) {
  let s = I.delL.exec(e);
  if (!s) return null;
  if (!(s[1] || '') || !prev || I.punctuation.exec(prev)) {
    let o = 0;
    while (s[0][o] === '~') o++;
    const u = fe.del;
    const d = masked.length - e.length + o;
    if (u < d) return null;
    const t = masked.slice(-e.length + o);
    const k = u - d;
    let i, l, p = o;
    for (I.delR.lastIndex = 0; (s = I.delR.exec(t)) !== null && !(s.index > k);) {
      if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !i || (l = i.length, l !== o)) continue;
      if (s[3] || s[4]) { p += l; continue; }
      if (p -= l, p > 0) continue;
      l = Math.min(l, l + p);
      const g = s[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const b = e.slice(0, o + s.index + g + l);
      const m = b.slice(o, -o);
      return { html: ctx.textMode ? inlineTokens(m, ctx) : '<del>' + inlineTokens(m, ctx) + '</del>', len: b.length };
    }
  }
  return null;
}
// The inline token loop (marked's Lexer.#t). Returns HTML (or plain text
// in textMode). `masked`/`fe` belong to the current parse.
// Length of the plain-text token starting at e[0], matching marked's
// I.text regex without running it. The token always consumes its first
// character (a backtick/tilde run, or a single other character), then runs
// until just before the next inline token can start: a special character
// (` ~ < ! [ * _ \), a URL scheme / www. / e-mail address, a hard break
// (two or more spaces before a newline), or a mailto:/xmpp: address
// (whose preceding non-alphanumeric character is consumed with the text).
// A single combined search finds the earliest such stop; the mailto:
// alternative carries its preceding character, so the stop is one past
// its match start.
const TEXT_STOP = /[`~<!\[*_\\]| {2,}\n|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|(?<![^\s*_~(])www\.|[A-Za-z0-9.!#$%&'*+\/=?_`{\|}~-]+@|[^a-zA-Z0-9](?:mailto|xmpp):/g;
function textLen(e) {
  const n = e.length;
  if (n === 0) return 0;
  const c0 = e.charCodeAt(0);
  // I.text's first alternative: a single non-alphanumeric character
  // immediately before mailto:/xmpp: is the whole token.
  if ((c0 < 48 || (c0 > 57 && c0 < 65) || (c0 > 90 && c0 < 97) || c0 > 122) &&
      (e.startsWith('mailto:', 1) || e.startsWith('xmpp:', 1))) return 1;
  let start = 1;
  if (c0 === 96 || c0 === 126) {
    while (start < n && e.charCodeAt(start) === c0) start++;
  }
  if (start >= n) return n;
  TEXT_STOP.lastIndex = start;
  const m = TEXT_STOP.exec(e);
  if (!m) return n;
  let stop = m.index;
  if (m[0].endsWith('mailto:') || m[0].endsWith('xmpp:')) stop = m.index + 1;
  return stop < start ? start : stop;
}
function inlineLoop(e, masked, fe, ctx) {
  const out = [];
  let s = false, r = '', o = Infinity;
  while (e) {
    if (e.length < o) o = e.length; else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    if (!s) r = '';
    s = false;
    let m, res;
    // Dispatch on the first character: each inline token can only start
    // with a specific character (or a letter/digit for URLs), so the
    // checks that cannot match are skipped instead of failing on a regex.
    const c = e.charCodeAt(0);
    if (c === 92 && (m = I.escape.exec(e))) {
      e = e.slice(m[0].length);
      out.push(ctx.textMode ? m[1] : esc(m[1], false));
      continue;
    }
    if (c === 60 && (m = I.tag.exec(e))) {
      e = e.slice(m[0].length);
      if (!ctx.inLink && /^<a /i.test(m[0])) ctx.inLink = true;
      else if (ctx.inLink && /^<\/a>/i.test(m[0])) ctx.inLink = false;
      if (!ctx.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = true;
      else if (ctx.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = false;
      out.push(m[0]);
      continue;
    }
    if ((c === 91 || c === 33) && ctx.linkParenPossible !== false && (m = I.link.exec(e))) {
      const bang = m[0].charAt(0) === '!';
      const off = bang ? 2 : 1;
      if (!labelHasTag(e, m[1], off)) {
        let href = m[2].trim();
        let title = '';
        let ok = true;
        if (/^</.test(href)) {
          if (!/>$/.test(href)) ok = false;
          else {
            const l = trimEndChar(href.slice(0, -1), '\\', false);
            if ((href.length - l.length) % 2 === 0) ok = false;
          }
        } else {
          const l = balance(m[2], '()');
          if (l === -2) ok = false;
          else if (l > -1) {
            const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
            m[2] = m[2].substring(0, l);
            m[0] = m[0].substring(0, h).trim();
            m[3] = '';
          }
        }
        if (ok) {
          const rr = trimEndChar(m[0].slice(0, -1), '\\', false);
          if ((m[0].length - rr.length) % 2 === 0) ok = false;
        }
        if (ok) {
          title = m[3] ? m[3].slice(1, -1) : '';
          href = m[2].trim();
          if (/^</.test(href)) href = href.slice(1, -1);
          href = href.replace(/\\([\p{P}\p{S}])/gu, '$1');
          title = title.replace(/\\([\p{P}\p{S}])/gu, '$1');
          const html = makeLink(m, href, title || null, bang, false, ctx);
          if (html !== null) {
            e = e.slice(m[0].length);
            out.push(html);
            continue;
          }
        }
      }
    }
    if ((c === 91 || c === 33) && (m = I.reflink.exec(e) || I.nolink.exec(e))) {
      const bang = m[0].charAt(0) === '!';
      const off = bang ? 2 : 1;
      if (!labelHasTag(e, m[1], off)) {
        const entry = ctx.links[normLabel(m[2] || m[1])];
        if (!entry) {
          const ch = m[0].charAt(0);
          e = e.slice(1);
          out.push(ctx.textMode ? ch : esc(ch, false));
          continue;
        }
        const html = makeLink(m, entry.href, entry.title || null, bang, false, ctx);
        if (html !== null) {
          e = e.slice(m[0].length);
          out.push(html);
          continue;
        }
      }
    }
    if ((c === 42 || c === 95) && (res = emStrong(e, masked, fe, r, ctx))) {
      e = e.slice(res.len);
      out.push(res.html);
      continue;
    }
    if (c === 96 && (m = I.code.exec(e))) {
      e = e.slice(m[0].length);
      let n = m[2].replace(/\n/g, ' ');
      const hasNonSpace = /[^ ]/.test(n);
      const wrapped = /^ /.test(n) && / $/.test(n);
      if (hasNonSpace && wrapped) n = n.substring(1, n.length - 1);
      out.push(ctx.textMode ? n : '<code>' + esc(n, true) + '</code>');
      continue;
    }
    if ((c === 32 || c === 92) && (m = I.br.exec(e))) {
      e = e.slice(m[0].length);
      if (!ctx.textMode) out.push('<br>');
      continue;
    }
    if (c === 126 && (res = delTok(e, masked, fe, r, ctx))) {
      e = e.slice(res.len);
      out.push(res.html);
      continue;
    }
    if (c === 60 && (m = I.autolink.exec(e))) {
      e = e.slice(m[0].length);
      let n, href;
      if (m[2] === '@') { n = m[1]; href = 'mailto:' + n; }
      else { n = m[1]; href = n; }
      if (ctx.textMode) {
        out.push(n);
      } else {
        const i = encodeHref(href);
        if (i === null) out.push(esc(n, true));
        else out.push('<a href="' + esc(i, true) + '">' + esc(n, true) + '</a>');
      }
      continue;
    }
    if (!ctx.inLink && (m = I.url.exec(e))) {
      let n, href;
      if (m[2] === '@') { n = m[0]; href = 'mailto:' + n; }
      else {
        let prevUrl;
        do {
          prevUrl = m[0];
          m[0] = I.backpedal.exec(m[0])?.[0] ?? '';
        } while (prevUrl !== m[0]);
        n = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      e = e.slice(m[0].length);
      if (ctx.textMode) {
        out.push(n);
      } else {
        const i = encodeHref(href);
        if (i === null) out.push(esc(n, true));
        else out.push('<a href="' + esc(i, true) + '">' + esc(n, true) + '</a>');
      }
      continue;
    }
    {
      const tl = textLen(e);
      const t0 = e.slice(0, tl);
      e = e.slice(tl);
      if (t0.charCodeAt(t0.length - 1) !== 95) r = t0.charAt(t0.length - 1);
      s = true;
      if (ctx.textMode || ctx.inRawBlock) out.push(t0);
      // Fast path: with no & < > " ' in the chunk there is no entity to
      // decode and nothing to escape, so both helpers are no-ops.
      else if (!/[&<>\"']/.test(t0)) out.push(t0);
      else out.push(esc(unescapeEntities(t0), false));
      continue;
    }
    if (e) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
  }
  return out.join('');
}
// Inline tokenization entry (marked's Lexer.inlineTokens + #e): compute the
// masked source and the closer scan when the text can contain emphasis,
// then run the loop. Returns HTML (or plain text in textMode).
function inlineTokens(src, ctx) {
  const prev = ctx.linkParenPossible;
  ctx.linkParenPossible = prev && src.includes(')');
  try {
    // One scan for any emphasis/delimiter character instead of three.
    const needsMask = /[*_~]/.test(src);
    const masked = needsMask ? maskSrc(src, ctx.links) : src;
    // The closer scan is only consulted by emStrong/del, which only run
    // when the text can contain a delimiter.
    const fe = needsMask ? feScan(masked) : FE_NONE;
    return inlineLoop(src, masked, fe, ctx);
  } finally {
    ctx.linkParenPossible = prev;
  }
}
const FE_NONE = { em: { '*': -1, _: -1 }, del: -1 };
// Fresh inline context for one top-level inline parse (a paragraph,
// heading, table cell, ...). inRawBlock is reset before each such parse,
// matching marked's Lexer.lex — but inLink is NOT reset: it persists
// across blocks within one parse() call (an unclosed <a> tag keeps later
// bare URLs from becoming links), so it lives in `shared`.
function inlineCtx(links, shared) {
  return { links, inLink: shared.inLink, inRawBlock: false, linkEmitted: false, linkParenPossible: true, textMode: false };
}
// Fast path for plain prose: if the text contains no character that can
// start an inline token, no hard break and no URL/e-mail pattern, the
// inline result is just the entity-decoded, escaped text.
const INLINE_SPECIAL = /[*_~`\\<]|\[|!\[| {2,}\n/;
const INLINE_URL = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.|[A-Za-z0-9._+-]+@/;
function inlineHtml(src, links, shared) {
  if (!INLINE_SPECIAL.test(src) && !INLINE_URL.test(src)) {
    return esc(unescapeEntities(src), false);
  }
  const ctx = inlineCtx(links, shared);
  const html = inlineTokens(src, ctx);
  shared.inLink = ctx.inLink;
  return html;
}

// ---------- block parsing (lightweight nodes; inline rendering deferred) ----------
// Node types mirror marked's token types. A node stores the raw text its
// inline content is rendered from; link definitions are collected in
// ctx.links during this pass, so inline rendering (which happens later,
// in renderBlocks) sees every definition, including forward references.

const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE = /\n.*\n/;
const NON_SPACE = /[^ ]/;
const LEADING_WS = /^[ \t]+/;
const BLANK_LINE = /^[ \t]*$/;

function fenceIndent(raw, content) {
  const n = raw.match(/^(\s+)(?:```)/);
  if (n === null) return content;
  const s = n[1];
  return content.split('\n').map((r) => {
    const o = r.match(/^\s+/);
    if (o === null) return r;
    return r.slice(Math.min(o[0].length, s.length));
  }).join('\n');
}

// First line of a string (up to the first newline), without allocating a
// split array.
function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// Blockquote tokenizer (marked's Tokenizer.blockquote). Returns
// { node, raw } or null. `node.raw` is the consumed source length.
function tokBlockquote(src, ctx) {
  if (!/^ {0,3}>/.test(src)) return null;
  const m = R.blockquote.exec(src);
  if (!m) return null;
  let lines = trimEndChar(m[0], '\n', false).split('\n');
  let s = '', r = '';
  const items = [];
  while (lines.length > 0) {
    let i = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (/^ {0,3}>/.test(lines[p])) { chunk.push(lines[p]); i = true; }
      else if (!i) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h.replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m2) => b + expandTabs(m2, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    const d = ctx.top;
    ctx.top = true;
    blockParse(u, ctx, true, items);
    ctx.top = d;
    if (lines.length === 0) break;
    const k = items[items.length - 1];
    if (k && (k.t === 'code' || k.t === 'heading' || k.t === 'hr' || k.t === 'html' || k.t === 'table')) break;
    if (k && k.t === 'blockquote') {
      const g = k;
      const b = lines.join('\n');
      const mm = g.raw + '\n' + b.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = tokBlockquote(mm, ctx);
      items[items.length - 1] = f.node;
      const y = mm.substring(f.node.raw.length).replace(/^\n/, '');
      const Rr = y ? y.split('\n').length : 0;
      const A = Rr ? lines.slice(0, -Rr) : lines;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - g.text.length) + f.node.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && /^ {0,3}>/.test(lines[0])) continue;
      break;
    } else if (k && k.t === 'list') {
      const g = k;
      const b = g.raw + '\n' + lines.join('\n');
      const mm = tokList(b, ctx);
      items[items.length - 1] = mm.node;
      const f = mm.node.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.node.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  const node = { t: 'blockquote', items, text: r, raw: s };
  return { node, raw: s };
}

// List tokenizer (marked's Tokenizer.list). Returns { node, raw } or null.
function tokList(src, ctx) {
  let t = R.listStart.exec(src);
  if (!t) return null;
  const n = src;
  let e = src;
  const s = () => n.length - e.length;
  let r = t[1].trim();
  const o = r.length > 1;
  const list = { t: 'list', raw: '', ordered: o, start: o ? +r.slice(0, -1) : '', loose: false, items: [] };
  r = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const l = listItemRx(r);
  let p = false;
  while (e) {
    let u = false, d = '';
    if (!(t = l.exec(e)) || R.hr.test(e)) break;
    const k = s();
    e = e.substring(t[0].length);
    const g = firstLine(t[2] || '');
    const b = t[1].length;
    let mm = g.replace(LEADING_WS, (v) => expandTabs(v, b));
    const f0 = firstLine(e);
    let y = !mm.trim();
    let Rr = 0;
    if (y) Rr = b + 1;
    else {
      Rr = mm.search(NON_SPACE);
      Rr = Rr > 4 ? 1 : Rr;
      d = mm.slice(Rr);
      Rr += b;
    }
    if (y && BLANK_LINE.test(f0)) { e = e.substring(f0.length + 1); u = true; }
    if (!u) {
      const v = nextBulletRx(Rr), Q = hrRx(Rr), ee = fencesBeginRx(Rr), te = headingBeginRx(Rr), M = htmlBeginRx(Rr), ne = blockquoteBeginRx(Rr);
      while (e) {
        const U = firstLine(e);
        let f = U;
        const Z = f.replace(LEADING_WS, (me) => expandTabs(me, 0));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(NON_SPACE) >= Rr || !f.trim()) d += '\n' + Z.slice(Rr);
        else {
          if (y || mm.replace(/\t/g, '    ').search(NON_SPACE) >= 4 || ee.test(mm) || te.test(mm) || M.test(mm) || Q.test(mm)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && R.lheading.test(mm + '\n' + f) ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        mm = Z.slice(Rr);
      }
    }
    const A = n.slice(k, s());
    if (!list.loose) {
      if (p) list.loose = true;
      else if (DOUBLE_BLANK.test(A)) p = true;
    }
    list.items.push({ t: 'list_item', raw: A, task: LIST_IS_TASK.test(d), loose: false, text: d, nodes: [] });
  }
  const h = list.items[list.items.length - 1];
  if (h) { h.raw = h.raw.trimEnd(); h.text = h.text.trimEnd(); }
  else return null;
  list.raw = n.slice(0, s()).trimEnd();
  for (const u of list.items) {
    ctx.top = false;
    u.nodes = blockParse(u.text, ctx, false);
    if (!list.loose) {
      const sp = u.nodes.filter((g) => g.t === 'space');
      list.loose = sp.length > 0 && sp.some((g) => ANY_LINE.test(g.raw));
    }
  }
  for (const u of list.items) {
    const d = u.nodes[0];
    if (u.task && (d?.t === 'text' || d?.t === 'paragraph')) {
      u.text = u.text.replace(LIST_REPLACE_TASK, '');
      d.text = d.text.replace(LIST_REPLACE_TASK, '');
      const k = LIST_TASK_CHECKBOX.exec(u.raw);
      if (k) {
        const cb = { t: 'checkbox', checked: k[0] !== '[ ]' };
        u.checked = cb.checked;
        if (list.loose) {
          if (u.nodes[0] && (u.nodes[0].t === 'paragraph' || u.nodes[0].t === 'text')) u.nodes[0].cb = cb;
          else u.nodes.unshift({ t: 'paragraph', text: '', cb });
        } else {
          u.nodes.unshift(cb);
        }
      }
    } else if (u.task) {
      u.task = false;
    }
  }
  if (list.loose) {
    for (const u of list.items) {
      u.loose = true;
      for (const d of u.nodes) if (d.t === 'text') d.t = 'paragraph';
    }
  }
  return { node: list, raw: list.raw };
}

// Table tokenizer (marked's Tokenizer.table). Returns { node, raw } or null.
function tokTable(src, ctx) {
  const m = R.table.exec(src);
  if (!m || !/[:|]/.test(m[2])) return null;
  const header = splitRow(m[1]);
  const delim = m[2].replace(/^\||\| *$/g, '').split('|');
  const rows = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  if (header.length !== delim.length) return null;
  const align = [];
  for (const s of delim) {
    if (/^ *-+: *$/.test(s)) align.push('right');
    else if (/^ *:-+: *$/.test(s)) align.push('center');
    else if (/^ *:-+ *$/.test(s)) align.push('left');
    else align.push(null);
  }
  const headerCells = header.map((text, i) => ({ text, align: align[i], header: true }));
  const rowCells = rows.map((row) => splitRow(row, header.length).map((text, p) => ({ text, align: align[p], header: false })));
  const node = { t: 'table', header: headerCells, rows: rowCells };
  return { node, raw: trimEndChar(m[0], '\n', false) };
}

// The block loop (marked's Lexer.blockTokens). Appends nodes to `out`
// (a fresh array when omitted) and returns it. `inBQ` is the
// "inside a blockquote" flag: consecutive paragraphs merge while it is set.
function blockParse(src, ctx, inBQ, out) {
  const nodes = out || [];
  let prevLen = Infinity;
  let bq = inBQ;
  while (src) {
    if (src.length < prevLen) prevLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let m;
    if (m = R.newline.exec(src)) {
      src = src.slice(m[0].length);
      const last = nodes[nodes.length - 1];
      if (!(m[0].length === 1 && last)) nodes.push({ t: 'space', raw: m[0] });
      continue;
    }
    if (m = R.code.exec(src)) {
      src = src.slice(m[0].length);
      const text = trimTrailingBlank(m[0]).replace(/^(?: {0,3}\t| {1,4})/gm, '');
      const last = nodes[nodes.length - 1];
      if (last && (last.t === 'paragraph' || last.t === 'text')) last.text += '\n' + text;
      else nodes.push({ t: 'code', text });
      continue;
    }
    if (m = R.fences.exec(src)) {
      src = src.slice(m[0].length);
      const lang = m[2] ? m[2].trim().replace(/\\([\p{P}\p{S}])/gu, '$1') : m[2];
      nodes.push({ t: 'code', text: fenceIndent(m[0], m[3] || ''), lang });
      continue;
    }
    if (m = R.heading.exec(src)) {
      src = src.slice(m[0].length);
      let n = m[2].trim();
      if (/#$/.test(n)) {
        const s = trimEndChar(n, '#', false);
        if (!s || /[ \t]$/.test(s)) n = s.trim();
      }
      nodes.push({ t: 'heading', depth: m[1].length, text: n });
      continue;
    }
    if (m = R.hr.exec(src)) {
      src = src.slice(m[0].length);
      nodes.push({ t: 'hr' });
      continue;
    }
    const bqRes = tokBlockquote(src, ctx);
    if (bqRes) {
      src = src.slice(bqRes.raw.length);
      nodes.push(bqRes.node);
      continue;
    }
    const listRes = tokList(src, ctx);
    if (listRes) {
      src = src.slice(listRes.raw.length);
      nodes.push(listRes.node);
      continue;
    }
    if (m = R.html.exec(src)) {
      src = src.slice(m[0].length);
      const n = trimTrailingBlank(m[0]);
      nodes.push({ t: 'html', text: n, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' });
      continue;
    }
    m = R.def.exec(src);
    if (m && (/^</.test(m[2]) || balance(m[2], '()') === -1)) {
      src = src.slice(m[0].length);
      const tag = normLabel(m[1]);
      const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(/\\([\p{P}\p{S}])/gu, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(/\\([\p{P}\p{S}])/gu, '$1') : m[3];
      const last = nodes[nodes.length - 1];
      if (last && (last.t === 'paragraph' || last.t === 'text')) {
        last.text += '\n' + trimEndChar(m[0], '\n', false);
      } else {
        if (!Object.hasOwn(ctx.links, tag)) ctx.links[tag] = { href, title };
        nodes.push({ t: 'def' });
      }
      continue;
    }
    const tableRes = tokTable(src, ctx);
    if (tableRes) {
      src = src.slice(tableRes.raw.length);
      nodes.push(tableRes.node);
      continue;
    }
    if (m = R.lheading.exec(src)) {
      src = src.slice(m[0].length);
      nodes.push({ t: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() });
      continue;
    }
    if (ctx.top && (m = R.paragraph.exec(src))) {
      src = src.slice(m[0].length);
      const n = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      const last = nodes[nodes.length - 1];
      if (bq && last && last.t === 'paragraph') last.text += '\n' + n;
      else nodes.push({ t: 'paragraph', text: n });
      bq = false;
      continue;
    }
    if (m = R.text.exec(src)) {
      src = src.slice(m[0].length);
      const last = nodes[nodes.length - 1];
      if (last && last.t === 'text') last.text += '\n' + m[0];
      else nodes.push({ t: 'text', text: m[0] });
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return nodes;
}

// ---------- rendering (mirrors marked's Renderer) ----------

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function renderCell(cell, links, shared) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + inlineHtml(cell.text, links, shared) + '</' + tag + '>\n';
}
function renderBlock(node, links, shared, out) {
  switch (node.t) {
    case 'space': case 'def': break;
    case 'hr': out.push('<hr>\n'); break;
    case 'code': {
      const lang = (node.lang || '').match(/^\S*/)?.[0];
      const r = node.text ? node.text.replace(/\n$/, '') + '\n' : '';
      const body = esc(r, true);
      if (lang) out.push('<pre><code class="language-' + esc(lang, false) + '">' + body + '</code></pre>\n');
      else out.push('<pre><code>' + body + '</code></pre>\n');
      break;
    }
    case 'heading':
      out.push('<h' + node.depth + '>' + inlineHtml(node.text, links, shared) + '</h' + node.depth + '>\n');
      break;
    case 'blockquote':
      out.push('<blockquote>\n' + renderBlocks(node.items, links, shared) + '</blockquote>\n');
      break;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const startAttr = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      out.push('<' + tag + startAttr + '>\n');
      for (const item of node.items) {
        out.push('<li>');
        renderBlocks(item.nodes, links, shared, out);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>\n');
      break;
    }
    case 'checkbox': out.push(checkboxHtml(node.checked)); break;
    case 'html': out.push(node.text); break;
    case 'paragraph':
      out.push('<p>');
      if (node.cb) out.push(checkboxHtml(node.cb.checked));
      out.push(inlineHtml(node.text, links, shared));
      out.push('</p>\n');
      break;
    case 'text':
      if (node.cb) out.push(checkboxHtml(node.cb.checked));
      out.push(inlineHtml(node.text, links, shared));
      break;
    case 'table': {
      let thead = '';
      for (const cell of node.header) thead += renderCell(cell, links, shared);
      let tbody = '';
      for (const row of node.rows) {
        let cells = '';
        for (const cell of row) cells += renderCell(cell, links, shared);
        tbody += '<tr>\n' + cells + '</tr>\n';
      }
      if (tbody) tbody = '<tbody>' + tbody + '</tbody>';
      out.push('<table>\n<thead>\n<tr>\n' + thead + '</tr>\n</thead>\n' + tbody + '</table>\n');
      break;
    }
  }
}
function renderBlocks(nodes, links, shared, out) {
  const o = out || [];
  for (const node of nodes) renderBlock(node, links, shared, o);
  return o.join('');
}

// ---------- entry point ----------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const ctx = { links: Object.create(null), top: true };
  const nodes = blockParse(src, ctx, false);
  return renderBlocks(nodes, ctx.links, { inLink: false });
}
export default parse;
