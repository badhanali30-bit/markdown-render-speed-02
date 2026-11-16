// parse.js — an original, dependency-free Markdown-to-HTML renderer.
//
// parse(markdown) returns, for every string, exactly the HTML that marked
// 18.1.3 renders with its default options (gfm on, breaks off, pedantic off,
// async off). It is a from-scratch implementation: a single-pass block scanner
// that emits HTML directly (no token objects, no second parse pass), an inline
// renderer that works on strings, and a one-pass text escaper that folds
// entity decoding and HTML escaping into a single scan. Nothing is cached
// between calls; parse is stateless per call.

const CARET = /(^|[^[])(\^)/g;

// Small regex composer: builds one pattern out of named placeholders, in
// order, the way a grammar is usually written (a sub-pattern's own ^ anchor
// is dropped when it is embedded).
function compose(src, flags) {
  let t = typeof src === 'string' ? src : src.source;
  const api = {
    rep(pat, rep) {
      let o = typeof rep === 'string' ? rep : rep.source;
      o = o.replace(/(^|[^[])(\^)/g, '$1');
      t = t.replace(pat, o);
      return api;
    },
    rx(f) {
      const fl = f || flags || '';
      // A sticky pattern matches only at the scan position, so a leading ^
      // anchor would never fire there; drop it when one is present.
      if (fl.includes('y') && t.startsWith('^')) t = t.slice(1);
      return new RegExp(t, fl);
    },
  };
  return api;
}

// ---------------------------------------------------------------- helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML, encode=true escapes every &; encode=false leaves a & alone
// when it starts a valid character or entity reference.
const ESC_TEST = /[&<>"']/;
const ESC_REP = /[&<>"']/g;
const ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REP_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function esc(html, encode) {
  if (encode) {
    if (ESC_TEST.test(html)) return html.replace(ESC_REP, (c) => ESC_MAP[c]);
  } else if (ESC_TEST_NOENC.test(html)) {
    return html.replace(ESC_REP_NOENC, (c) => ESC_MAP[c]);
  }
  return html;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references the way the reference does: 0, above
// the Unicode range and surrogates become U+FFFD; 38 becomes "&amp;".
function unescapeNumeric(str) {
  if (!NUM_REF.test(str)) return str;
  return str.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Single-pass text escaper: decodes numeric character references (unless
// raw, i.e. inside a <pre>/<code>/<script> style raw span) and escapes HTML
// in the same scan, so a text run is touched once instead of twice.
function escText(run, raw) {
  let out = '';
  let i = 0;
  const n = run.length;
  let start = 0;
  const flush = (to) => {
    if (to > start) out += run.slice(start, to);
  };
  while (i < n) {
    const c = run.charCodeAt(i);
    if (c === 38) { // &
      // Try a numeric character reference: &#123; or &#x1F600;
      let j = i + 1;
      let numEnd = -1;
      let cp = 0;
      if (run.charCodeAt(j) === 35) { // #
        j++;
        let hex = false;
        if (run.charCodeAt(j) === 120 || run.charCodeAt(j) === 88) { hex = true; j++; }
        const d0 = j;
        while (j < n) {
          const d = run.charCodeAt(j);
          const ok = hex
            ? (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)
            : d >= 48 && d <= 57;
          if (!ok) break;
          j++;
        }
        const digits = j - d0;
        if (digits >= 1 && digits <= (hex ? 6 : 7) && run.charCodeAt(j) === 59) {
          numEnd = j + 1;
          cp = parseInt(run.slice(d0, j), hex ? 16 : 10);
        }
      }
      if (numEnd > 0) {
        flush(i);
        if (raw) {
          out += run.slice(i, numEnd);
        } else if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          out += '\uFFFD';
        } else if (cp === 38) {
          out += '&amp;';
        } else {
          const ch = String.fromCodePoint(cp);
          out += ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
        }
        i = numEnd;
        start = i;
        continue;
      }
      // A & that starts a valid reference is left alone; any other & is &amp;
      let k = i + 1;
      let valid = false;
      if (run.charCodeAt(k) === 35) { // #
        k++;
        if (run.charCodeAt(k) === 120 || run.charCodeAt(k) === 88) {
          k++;
          const d0 = k;
          while (k < n) {
            const d = run.charCodeAt(k);
            if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102))) break;
            k++;
          }
          valid = k - d0 >= 1 && k - d0 <= 6 && run.charCodeAt(k) === 59;
        } else {
          const d0 = k;
          while (k < n && run.charCodeAt(k) >= 48 && run.charCodeAt(k) <= 57) k++;
          valid = k - d0 >= 1 && k - d0 <= 7 && run.charCodeAt(k) === 59;
        }
      } else {
        const w0 = k;
        while (k < n) {
          const d = run.charCodeAt(k);
          if (!((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95)) break;
          k++;
        }
        valid = k > w0 && run.charCodeAt(k) === 59;
      }
      if (valid) { i++; continue; }
      flush(i);
      out += '&amp;';
      i++;
      start = i;
      continue;
    }
    if (c === 60) { flush(i); out += '&lt;'; i++; start = i; continue; } // <
    if (c === 62) { flush(i); out += '&gt;'; i++; start = i; continue; } // >
    if (c === 34) { flush(i); out += '&quot;'; i++; start = i; continue; } // "
    if (c === 39) { flush(i); out += '&#39;'; i++; start = i; continue; } // '
    i++;
  }
  flush(n);
  return out;
}

// encodeURI, with %25 put back to %; null when encodeURI throws (lone
// surrogates in the href).
function cleanUrl(href) {
  try {
    const u = encodeURI(href);
    return u.indexOf('%25') === -1 ? u : u.replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Length in code units of the first code point of s.
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF ? 2 : 1;
}

// Split a table row on unescaped pipes, trimming cells and dropping a
// leading/trailing empty cell from edge pipes.
function splitCells(row, count) {
  const cells = row.replace(/\|/g, (m, off, s) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && s[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  }).split(' |');
  let i = 0;
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Trim trailing characters: with `other` unset, trims trailing `ch`; with
// it set, trims trailing characters that are not `ch`.
function rtrim(str, ch, other) {
  const n = str.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n;) {
    const c = str.charAt(n - s - 1);
    if (c === ch && !other) s++;
    else if (c !== ch && other) s++;
    else break;
  }
  return str.slice(0, n - s);
}

// Does `raw` end with two blank lines (`\n[ \t]*\n[ \t]*$`)? Only the tail
// can matter, so walk it instead of scanning the whole string.
function hasDoubleBlank(raw) {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
  if (end === 0 || raw[end - 1] !== '\n') return false;
  let start = end - 1;
  while (start > 0 && (raw[start - 1] === ' ' || raw[start - 1] === '\t')) start--;
  return start > 0 && raw[start - 1] === '\n';
}

// Drop trailing blank lines from a block, keeping at most one.
const BLANK_LINE = /^[ \t]*$/;
function trimBlankTail(str) {
  const lines = str.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && BLANK_LINE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? str : lines.slice(0, t + 1).join('\n');
}

// Normalize a link label: trim, collapse inner whitespace, fold case.
const MULTI_SPACE = /\s+/g;
function normLabel(label) {
  return label.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the closing bracket that balances the opening one, skipping escapes.
// -1: no bracket at all (or balanced with no unmatched close), -2: unclosed.
function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Blank line test equivalent to `!s.trim()` for the whitespace a list line
// can realistically hold (space, tab, \v, \f, \r, nbsp), without allocating.
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 11 && c !== 12 && c !== 13 && c !== 160) return false;
  }
  return true;
}

// Expand tabs to spaces, counting from column `col`.
function expandTabs(str, col) {
  let t = col || 0;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const w = 4 - (t % 4);
      out += ' '.repeat(w);
      t += w;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Is a single character punctuation or whitespace (but not * or _)?
const PUNCT_START = /^((?![*_])[\s\p{P}\p{S}])/u;
function isPunctSpace(ch) {
  return PUNCT_START.test(ch);
}
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// ------------------------------------------------------------------ regexes
// Block grammar (GFM). Patterns are composed from named pieces; a trailing
// `y` makes them sticky so they match only at the current scan position.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)';
const HTML_BEGIN_SRC =
  ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const BULL_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const COMMENT_SRC = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const RE_NEWLINE = /(?:[ \t]*(?:\n|$))+/y;
const RE_INDENT_CODE = /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y;
const RE_FENCES = / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y;
const RE_HR = compose(HR_SRC, 'y').rx();
const RE_HEADING = / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y;
const RE_LIST_START = compose('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)').rep(/bull/g, BULL_SRC).rx('y');
const RE_HTML_BLOCK = compose(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'iy',
)
  .rep('comment', COMMENT_SRC)
  .rep('tag', BLOCK_TAGS)
  .rep('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .rx();

// Link label: anything but a blank line inside brackets, escapes allowed.
const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_SRC = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const RE_DEF = compose(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)',
)
  .rep('label', LABEL_INNER)
  .rep('title', TITLE_SRC)
  .rx('y');

// Setext heading: a paragraph-like run followed by = or - underline.
const LHEADING_BASE =
  '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
// Blank line OR first line that could be a setext underline (group 1);
// one exec finds whichever comes first in the paragraph.
const RE_SETEXT_OR_BLANK = /\n[ \t]*(?:\n|$)|(\n {0,3}[=-])/g;
const RE_LHEADING = compose(LHEADING_BASE)
  .rep(/bull/g, BULL_SRC)
  .rep(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .rep(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .rep(/blockquote/g, / {0,3}>/)
  .rep(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .rep(/hr/g, HR_SRC)
  .rep(/html/g, / {0,3}<[^\n>]+>\n/)
  .rep(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .rx('y');

// GFM table: header line, delimiter line, then body rows.
const RE_TABLE = compose(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
)
  .rep('hr', HR_SRC)
  .rep('heading', HEADING_SRC)
  .rep('blockquote', BLOCKQUOTE_SRC)
  .rep('code', /(?: {4}| {0,3}\t)[^\n]/)
  .rep('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .rep('list', / {0,3}(?:[*+-]|1[.)])[ \t]/)
  .rep('html', HTML_BEGIN_SRC)
  .rep('tag', BLOCK_TAGS)
  .rx('y');

// Paragraph (GFM): lines until a blank line or an interrupting construct.
// Note the list pattern: only a bullet, or an ordered marker starting at 1,
// interrupts a paragraph.
const PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const RE_PARAGRAPH = compose(PARA_BASE)
  .rep('hr', HR_SRC)
  .rep('heading', HEADING_SRC)
  .rep('|lheading', '')
  .rep('table', RE_TABLE)
  .rep('blockquote', BLOCKQUOTE_SRC)
  .rep('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .rep('list', / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/)
  .rep('html', HTML_BEGIN_SRC)
  .rep('tag', BLOCK_TAGS)
  .rx('y');

const RE_TEXT_LINE = /[^\n]+/y;

// Blockquote: groups of > lines; the paragraph pattern is embedded so lazy
// continuation lines are recognised.
const RE_BLOCKQUOTE = compose(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+',
)
  .rep('paragraph', compose(PARA_BASE)
    .rep('hr', HR_SRC)
    .rep('heading', HEADING_SRC)
    .rep('|lheading', '')
    .rep('|table', '')
    .rep('blockquote', BLOCKQUOTE_SRC)
    .rep('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
    .rep('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
    .rep('html', HTML_BEGIN_SRC)
    .rep('tag', BLOCK_TAGS)
    .rx('y'))
  .rx('y');

// Helpers used inside list / blockquote processing.
const RE_BLOCKQUOTE_START = /^ {0,3}>/;
const RE_BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_ANY_LINE = /\n.*\n/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
// A table delimiter line, tested sticky at the second line's start.
const RE_TABLE_DELIM_LINE = / {0,3}[:| \-]*-[ :|\-]*(?:\n|$)/y;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RE_TABLE_ROW_TAIL = /\n[ \t]*$/;
const RE_TABLE_ALIGN_R = /^ *-+: *$/;
const RE_TABLE_ALIGN_C = /^ *:-+: *$/;
const RE_TABLE_ALIGN_L = /^ *:-+ *$/;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;
const RE_BEGIN_SPACE = /^\s+/;
const RE_ENDING_HASH = /#$/;
const RE_ENDING_SPACE_TAB = /[ \t]$/;
const RE_NON_SPACE = /[^ ]/;
const RE_LEADING_SPACE_TAB = /^[ \t]+/;
const RE_INDENT_CODE_COMP = /^(\s+)(?:```)/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
// Indent-indexed regexes are built for indent-1, clamped to 0..3, and cached.
const indentIdx = (i) => Math.max(0, Math.min(3, i - 1));
const _indCache = [[], [], [], []];
const _indRegex = (slot, indent, make) => {
  const i = indentIdx(indent);
  return _indCache[slot][i] || (_indCache[slot][i] = make(i));
};
const listNextBullet = (indent) => _indRegex(0, indent, (i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`));
const listHr = (indent) => _indRegex(1, indent, (i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`));
const listFencesBegin = (indent) => _indRegex(2, indent, (i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const listHeadingBegin = (indent) => _indRegex(3, indent, (i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const _htmlCache = [];
const listHtmlBegin = (indent) => {
  const i = indentIdx(indent);
  return _htmlCache[i] || (_htmlCache[i] = new RegExp(`^ {0,${i}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
};
const _bqCache = [];
const listBlockquoteBegin = (indent) => {
  const i = indentIdx(indent);
  return _bqCache[i] || (_bqCache[i] = new RegExp(`^ {0,${i}}>`));
};
const _itemCache = new Map();
const RE_LIST_ITEM_CACHED = (bull) => {
  let r = _itemCache.get(bull);
  if (!r) { r = new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`); _itemCache.set(bull, r); }
  return r;
};
const RE_SPACE_LINE = /^ +$/gm;
const RE_ENDING_NEWLINE = /\n$/;
const RE_TAB_GLOBAL = /\t/g;
const RE_NEWLINE_GLOBAL = /\n/g;
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;

// ---------------------------------------------------------------- inline
// Inline grammar (GFM). The emphasis delimiter regexes follow the reference's
// construction: punctuation classes differ for * / _ / ~, and the right
// delimiter search skips over text that cannot hold a closer.

const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_NO_TILDE = '(?!~)[\\p{P}\\p{S}]';
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_NO_TILDE = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_TILDE = '(?:[^\\s\\p{P}\\p{S}]|~)';

const RE_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const RE_CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const RE_BR = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const RE_AUTOLINK = compose(
  /^<(scheme:[^\s\x00-\x1f<>]*|email)>/,
)
  .rep('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .rep('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .rx('y');
const RE_TAG = compose(
  "comment|</[a-zA-Z][a-zA-Z0-9-]*\\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|<\\?[\\s\\S]*?\\?>|<![a-zA-Z]+\\s[\\s\\S]*?>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
)
  .rep('comment', compose(COMMENT_SRC).rep('(?:-->|$)', '-->').rx())
  .rep('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .rx('y');

// Link label contents, balanced brackets and code spans allowed.
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LINK_LABEL = compose(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .rep('brackets', BRACKETED)
  .rx();
const RE_LINK = compose(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .rep('label', LINK_LABEL)
  .rep('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .rep('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .rx('y');
const RE_REFLINK = compose(/^!?\[(label)\]\[(ref)\]/)
  .rep('label', LINK_LABEL)
  .rep('ref', LABEL_INNER)
  .rx('y');
const RE_NOLINK = compose(/^!?\[(ref)\](?:\[\])?/).rep('ref', LABEL_INNER).rx('y');

// Emphasis left delimiters (GFM: ~ is not punctuation for * and _).
const EM_L_DELIM_SRC =
  '(?:\\*+(?:((?!\\*)punct)|([^\\s*]))?)|_+(?:((?!_)punct)|([^\\s_]))?';
const RE_EM_L_DELIM = compose(EM_L_DELIM_SRC, 'u').rep(/punct/g, PUNCT_NO_TILDE).rx('yu');

// Right delimiter search patterns for * and _ (GFM). Note _ uses the
// non-GFM punctuation classes and has no rule-6 alternative: `a___a`
// cannot close as emphasis.
const RDELIM_AST_SRC =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const RDELIM_UND_SRC =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const RE_EM_R_DELIM_AST = compose(RDELIM_AST_SRC, 'gu')
  .rep(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE)
  .rep(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
  .rep(/punct/g, PUNCT_NO_TILDE)
  .rx();
const RE_EM_R_DELIM_UND = compose(RDELIM_UND_SRC, 'gu')
  .rep(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .rep(/punctSpace/g, PUNCT_SPACE)
  .rep(/punct/g, PUNCT)
  .rx();

// Strikethrough delimiters.
const RE_DEL_L_DELIM = compose(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').rep(/punct/g, PUNCT).rx('yu');
const DEL_RDELIM_SRC =
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const RE_DEL_R_DELIM = compose(DEL_RDELIM_SRC, 'gu')
  .rep(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .rep(/punctSpace/g, PUNCT_SPACE)
  .rep(/punct/g, PUNCT)
  .rx();

// Extended autolinks (GFM): scheme://, www., and bare email addresses.
const RE_SCHEME = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const RE_EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_EMAIL_PROTO = compose(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .rep(/email/g, RE_EMAIL_LOCAL)
  .rx();
const RE_URL = compose(/emailProtocol|((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|email/)
  .rep('emailProtocol', RE_EMAIL_PROTO)
  .rep('protocol', RE_SCHEME)
  .rep('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .rx('y');
const RE_URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Masks used to hide links, code spans and HTML from the emphasis search.
const RE_BLOCK_SKIP = compose(/link|precode-code|html/, 'g')
  .rep('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .rep('precode-', '(?<!`)()')
  .rep('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .rep('html', /<(?! )[^<>]*?>/)
  .rx();
const RE_REFLINK_SEARCH = compose('reflink|nolink(?!\\()', 'g')
  .rep('reflink', compose(/^!?\[(label)\]\[(ref)\]/).rep('label', compose(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).rep('brackets', BRACKETED).rx()).rep('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/).rx())
  .rep('nolink', compose(/^!?\[(ref)\](?:\[\])?/).rep('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/).rx())
  .rx();
const RE_PUNCT_OUTSIDE_CODE = compose(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .rep(/punct/g, PUNCT)
  .rx();

// Inline text: a run up to the next construct. The lazy match stops before
// emphasis, links, code, tags, hard breaks, autolink starts and emails.
const RE_TEXT = compose(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
)
  .rep('protocol', RE_SCHEME)
  .rep(/emailProtocol/g, /(?:mailto|xmpp):/)
  .rep('wwwStart', '(?<![^\\s*_~(])www\\.')
  .rx('y');

// Anything that can start an inline construct, for the fast-path scan.
const RE_INLINE_SPECIAL = /[*_`~\[\\<>&]| {2,}\n|www\.|mailto:|xmpp:|https?:\/\/|ftp:\/\//;

// ------------------------------------------------------- additional regexes
const RE_ANY_PUNCT = compose(/\\(punct)/, 'gu').rep(/punct/g, PUNCT).rx();
const RE_OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const RE_CARRIAGE = /\r\n|\r/g;
const RE_NOT_SPACE_START = /^\S*/;

// ------------------------------------------------------------------- Lexer
// A faithful port of marked 18.1.3's Lexer/Tokenizer algorithms (MIT,
// credited in README.md), restructured for this entry: block tokens are
// produced the same way, inline runs are queued and tokenized after the
// block pass, and rendering emits HTML directly from the tokens.

function outputLink(cap, link, raw, lx, runTextMode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(RE_OUTPUT_LINK_REPLACE, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = lx.state.inLink;
  const outerLinkEmitted = lx.state.linkEmitted;
  const outerInRawBlock = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  // An image's label is always plain text (it becomes the alt attribute); a
  // link's label follows the run it is in.
  const inner = lx.inlineTokens(text, isImage || runTextMode);
  const textHasLink = lx.state.linkEmitted;
  lx.state.linkEmitted = outerLinkEmitted;
  lx.state.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      lx.state.inRawBlock = outerInRawBlock;
      return undefined;
    }
    lx.state.linkEmitted = true;
  }
  if (runTextMode) return { type: isImage ? 'image' : 'link', raw, href, title, text, html: inner };
  if (!isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { type: 'link', raw, href, title, text, html: inner };
    let o = '<a href="' + esc(cleanHref) + '"';
    if (title) o += ' title="' + esc(title) + '"';
    return { type: 'link', raw, href, title, text, html: o + '>' + inner + '</a>' };
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { type: 'image', raw, href, title, text, html: esc(inner) };
  let o = `<img src="${esc(cleanHref)}" alt="${esc(inner)}"`;
  if (title) o += ` title="${esc(title)}"`;
  return { type: 'image', raw, href, title, text, html: o + '>' };
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(RE_INDENT_CODE_COMP);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(RE_BEGIN_SPACE);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      RE_CODE_SPAN.lastIndex = 0;
      const code = RE_CODE_SPAN.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    RE_TAG.lastIndex = 0;
    RE_AUTOLINK.lastIndex = 0;
    const token = RE_TAG.exec(tokenSrc) || RE_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Last `*` / `_` / `~` runs that can close emphasis or strikethrough, scanned
// once per inline pass and shared by every opener in it. A regex finds the
// runs; only the character before each run is inspected.
const RE_CLOSER_RUNS = /([*_~])\1*/g;
function scanClosers(src) {
  const frame = { maskedSrc: src, ast: -1, und: -1, del: -1 };
  RE_CLOSER_RUNS.lastIndex = 0;
  let m;
  while ((m = RE_CLOSER_RUNS.exec(src)) !== null) {
    const prev = m.index === 0 ? '\n' : src[m.index - 1];
    if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f') continue;
    const ch = m[1];
    if (ch === '~') frame.del = m.index;
    else if (ch === '*') frame.ast = m.index;
    else frame.und = m.index;
  }
  return frame;
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.links = this.tokens.links;
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.maskStack = [];
    this.inlineQueue = [];
  }

  lex(src) {
    if (src.includes('\r')) src = src.replace(RE_CARRIAGE, '\n');
    this.blockTokens(src, this.tokens);
    this.hasLinks = Object.keys(this.links).length > 0;
    // Inline runs render only now: a link reference definition may follow
    // its use, so the links table is complete only after the block pass.
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const p = this.inlineQueue[i];
      this.state.inRawBlock = false;
      p.out = (p.prefix || '') + this.inlineTokens(p.src, false);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], lastParagraphClipped = false) {
    let srcLength = Infinity;
    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      }
      let token;
      if (token = this.tokSpace(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (token = this.tokCode(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          lastToken.html.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (token = this.tokFences(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokHeading(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokHr(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokBlockquote(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokList(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokHtml(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokDef(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          lastToken.html.src = lastToken.text;
        } else {
          if (!this.links[token.tag]) {
            this.links[token.tag] = { href: token.href, title: token.title };
          }
          tokens.push(token);
        }
        continue;
      }
      // A table's delimiter is its second line: only run the table pattern
      // when that line is made of | : - and spaces and contains a dash.
      const tnl = src.indexOf('\n');
      if (tnl !== -1) {
        RE_TABLE_DELIM_LINE.lastIndex = tnl + 1;
        if (RE_TABLE_DELIM_LINE.test(src) && (token = this.tokTable(src))) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }
      // A setext underline is a line of = or - before the next blank line.
      // One scan finds whichever comes first: a blank line (no underline
      // in this paragraph) or a candidate underline line.
      RE_SETEXT_OR_BLANK.lastIndex = 0;
      const sb = RE_SETEXT_OR_BLANK.exec(src);
      if (sb && sb[1] !== undefined && (token = this.tokLheading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      const cutSrc = src;
      if (this.state.top && (token = this.tokParagraph(cutSrc))) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          lastToken.html.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = cutSrc.length !== src.length;
        src = src.substring(token.raw.length);
        continue;
      }
      if (token = this.tokText(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          lastToken.html.src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  // A top-level inline run: deferred to lex(), after the block pass has
  // collected every link reference definition. Returns a placeholder whose
  // .out lex() fills; .src may be retargeted (paragraph merges, task
  // checkboxes) and .prefix prepended before it renders.
  inline(src) {
    const p = { src, prefix: '', out: null };
    this.inlineQueue.push(p);
    return p;
  }
}

// ------------------------------------------------- block tokenizer methods
Lexer.prototype.tokSpace = function (src) {
  RE_NEWLINE.lastIndex = 0;
  const cap = RE_NEWLINE.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
};

Lexer.prototype.tokCode = function (src) {
  RE_INDENT_CODE.lastIndex = 0;
  const cap = RE_INDENT_CODE.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE_CODE_REMOVE_INDENT, '') };
  }
};

Lexer.prototype.tokFences = function (src) {
  RE_FENCES.lastIndex = 0;
  const cap = RE_FENCES.exec(src);
  if (cap) {
    return {
      type: 'code', raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(RE_ANY_PUNCT, '$1') : cap[2],
      text: indentCodeCompensation(cap[0], cap[3] || ''),
    };
  }
};

Lexer.prototype.tokHeading = function (src) {
  RE_HEADING.lastIndex = 0;
  const cap = RE_HEADING.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (RE_ENDING_HASH.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || RE_ENDING_SPACE_TAB.test(trimmed)) text = trimmed.trim();
    }
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, html: this.inline(text) };
  }
};

Lexer.prototype.tokHr = function (src) {
  RE_HR.lastIndex = 0;
  const cap = RE_HR.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
};

Lexer.prototype.tokBlockquote = function (src) {
  RE_BLOCKQUOTE.lastIndex = 0;
  const cap = RE_BLOCKQUOTE.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (RE_BLOCKQUOTE_START.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(RE_BLOCKQUOTE_MARKER_WS, (_, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(RE_BLOCKQUOTE_SETEXT, '\n    $1')
        .replace(RE_BLOCKQUOTE_SETEXT2, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;
      const top = this.state.top;
      this.state.top = true;
      this.blockTokens(currentText, tokens, true);
      this.state.top = top;
      if (lines.length === 0) break;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
        break;
      } else if (lastToken?.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(RE_BLOCKQUOTE_SETEXT2, '');
        const newToken = this.tokBlockquote(newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && RE_BLOCKQUOTE_START.test(lines[0])) continue;
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = this.tokList(newText);
        tokens[tokens.length - 1] = newToken;
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
};

Lexer.prototype.tokHtml = function (src) {
  RE_HTML_BLOCK.lastIndex = 0;
  const cap = RE_HTML_BLOCK.exec(src);
  if (cap) {
    const raw = trimBlankTail(cap[0]);
    return { type: 'html', block: true, raw, pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style', text: raw };
  }
};

Lexer.prototype.tokDef = function (src) {
  RE_DEF.lastIndex = 0;
  const cap = RE_DEF.exec(src);
  if (cap) {
    if (!RE_START_ANGLE.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    const tag = normLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(RE_HREF_BRACKETS, '$1').replace(RE_ANY_PUNCT, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(RE_ANY_PUNCT, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
};

Lexer.prototype.tokTable = function (src) {
  RE_TABLE.lastIndex = 0;
  const cap = RE_TABLE.exec(src);
  if (!cap) return;
  if (!RE_TABLE_DELIM.test(cap[2])) return;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(RE_TABLE_ALIGN_CHARS, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(RE_TABLE_ROW_TAIL, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (RE_TABLE_ALIGN_R.test(align)) item.align.push('right');
    else if (RE_TABLE_ALIGN_C.test(align)) item.align.push('center');
    else if (RE_TABLE_ALIGN_L.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], html: this.inline(headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell, html: this.inline(cell), header: false, align: item.align[i],
    })));
  }
  return item;
};

Lexer.prototype.tokLheading = function (src) {
  RE_LHEADING.lastIndex = 0;
  const cap = RE_LHEADING.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text, html: this.inline(text) };
  }
};

Lexer.prototype.tokParagraph = function (src) {
  RE_PARAGRAPH.lastIndex = 0;
  const cap = RE_PARAGRAPH.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, html: this.inline(text) };
  }
};

Lexer.prototype.tokText = function (src) {
  RE_TEXT_LINE.lastIndex = 0;
  const cap = RE_TEXT_LINE.exec(src);
  if (cap) return { type: 'text', raw: cap[0], text: cap[0], html: this.inline(cap[0]) };
};

Lexer.prototype.tokList = function (src) {
  RE_LIST_START.lastIndex = 0;
  let cap = RE_LIST_START.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;
    const list = { type: 'list', raw: '', ordered: isordered, start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = RE_LIST_ITEM_CACHED(bull);
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      itemRegex.lastIndex = 0;
      if (!(cap = itemRegex.exec(src))) break;
      RE_HR.lastIndex = 0;
      if (RE_HR.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const ni = cap[2].indexOf('\n');
      const firstLine = ni === -1 ? cap[2] : cap[2].slice(0, ni);
      const bulletIndent = cap[1].length;
      let line = firstLine;
      const lead0 = RE_LEADING_SPACE_TAB.exec(firstLine);
      if (lead0 && lead0[0].includes('\t')) line = expandTabs(lead0[0], bulletIndent) + firstLine.slice(lead0[0].length);
      const nli = src.indexOf('\n');
      let nextLine = nli === -1 ? src : src.slice(0, nli);
      let blankLine = isBlankLine(line);
      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(RE_NON_SPACE);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }
      if (blankLine && BLANK_LINE.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }
      if (!endEarly) {
        const nextBulletRegex = listNextBullet(indent);
        const hrRegex = listHr(indent);
        const fencesBeginRegex = listFencesBegin(indent);
        const headingBeginRegex = listHeadingBegin(indent);
        const htmlBeginRegex = listHtmlBegin(indent);
        const blockquoteBeginRegex = listBlockquoteBegin(indent);
        while (src) {
          const nl = src.indexOf('\n');
          const rawLine = nl === -1 ? src : src.slice(0, nl);
          nextLine = rawLine;
          // Expand a leading tab only when one is present; spaces expand to
          // themselves.
          let nextLineWithoutTabs = nextLine;
          const lead = RE_LEADING_SPACE_TAB.exec(nextLine);
          if (lead && lead[0].includes('\t')) {
            nextLineWithoutTabs = expandTabs(lead[0]) + nextLine.slice(lead[0].length);
          }
          const ns = nextLineWithoutTabs.search(RE_NON_SPACE);
          const blank = isBlankLine(nextLineWithoutTabs);
          const first = ns === -1 ? '' : nextLineWithoutTabs[ns];
          // None of the six break tests can match unless the first
          // non-space character starts one of them.
          if (first === '`' || first === '~' || first === '#' || first === '<' || first === '>' ||
              first === '*' || first === '-' || first === '+' || first === '_' ||
              (first >= '0' && first <= '9')) {
            if (fencesBeginRegex.test(nextLine)) break;
            if (headingBeginRegex.test(nextLine)) break;
            if (htmlBeginRegex.test(nextLine)) break;
            if (blockquoteBeginRegex.test(nextLine)) break;
            if (nextBulletRegex.test(nextLine)) break;
            if (hrRegex.test(nextLine)) break;
          }
          if (ns >= indent || blank) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            if ((line.includes('\t') ? line.replace(RE_TAB_GLOBAL, '    ') : line).search(RE_NON_SPACE) >= 4) break;
            if (fencesBeginRegex.test(line)) break;
            if (headingBeginRegex.test(line)) break;
            if (htmlBeginRegex.test(line)) break;
            if (hrRegex.test(line)) break;
            RE_LHEADING.lastIndex = 0;
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && RE_LHEADING.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = blank;
          src = src.slice(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!list.loose) {
        if (endsWithBlankLine) list.loose = true;
        else if (hasDoubleBlank(raw)) endsWithBlankLine = true;
      }
      list.items.push({ type: 'list_item', raw, task: RE_LIST_IS_TASK.test(itemContents), loose: false, text: itemContents, tokens: [] });
    }
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        for (const t of item.tokens) {
          if (t.type === 'space' && RE_ANY_LINE.test(t.raw)) { list.loose = true; break; }
        }
      }
    }
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(RE_LIST_TASK, '');
        itemToken.raw = itemToken.raw.replace(RE_LIST_TASK, '');
        itemToken.text = itemToken.text.replace(RE_LIST_TASK, '');
        // The first token's inline HTML was rendered with the marker in it;
        // re-render it from the stripped text.
        itemToken.html.src = itemToken.text;
        const taskRaw = RE_LIST_CHECKBOX.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = { type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
          const checkboxHtml = '<input ' + (checkboxToken.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'html' in item.tokens[0]) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              item.tokens[0].html.prefix = checkboxHtml;
            } else {
              const p = { src: '', prefix: checkboxHtml, out: null };
              this.inlineQueue.push(p);
              item.tokens.unshift({ type: 'paragraph', raw: checkboxToken.raw, text: checkboxToken.raw, html: p });
            }
          } else {
            item.tokens.unshift(checkboxToken);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') token.type = 'paragraph';
        }
      }
    }
    return list;
  }
};

// ------------------------------------------------ inline tokenizer methods
Lexer.prototype.linkInText = function (text) {
  if (!text.includes('[')) return false;
  RE_BLOCK_SKIP.lastIndex = 0;
  for (const match of text.matchAll(RE_BLOCK_SKIP)) {
    RE_LINK.lastIndex = 0;
    if (RE_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  RE_REFLINK_SEARCH.lastIndex = 0;
  for (const match of text.matchAll(RE_REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(this.links, normLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
};

Lexer.prototype.maskSrc = function (src) {
  let maskedSrc = src;
  if (this.hasLinks && src.includes('[')) {
    const reflinkSearch = RE_REFLINK_SEARCH;
    const self = this;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(self.links, normLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (self.linkInText(text)) {
          return '[' + text.replace(reflinkSearch, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(RE_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(RE_BLOCK_SKIP, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
};

Lexer.prototype.inlineTokens = function (src, textMode = false) {
  const prevLinkParenPossible = this.state.linkParenPossible;
  this.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return this.inlineTokensInner(src, textMode);
  } finally {
    this.state.linkParenPossible = prevLinkParenPossible;
  }
};

Lexer.prototype.inlineTokensInner = function (src, textMode) {
  // The masked source and closer scan are built lazily: many runs hold a
  // `*`, `_` or `~` that never reaches emStrong/del (inside a link or code
  // span), and building the mask costs three full-string passes.
  this.maskStack.push({ src, masked: null, frame: null });
  try {
    return this.tokenizeInlines(src, textMode);
  } finally {
    this.maskStack.pop();
  }
};

Lexer.prototype.getMasked = function () {
  const ctx = this.maskStack.at(-1);
  if (ctx.masked === null) {
    ctx.masked = (ctx.src.includes('*') || ctx.src.includes('_') || ctx.src.includes('~'))
      ? this.maskSrc(ctx.src)
      : ctx.src;
  }
  return ctx.masked;
};

Lexer.prototype.getFrame = function (maskedSrc) {
  const ctx = this.maskStack.at(-1);
  if (!ctx.frame || ctx.frame.maskedSrc !== maskedSrc) ctx.frame = scanClosers(maskedSrc);
  return ctx.frame;
};

Lexer.prototype.cachedEmCloser = function (maskedSrc, delim) {
  return this.getFrame(maskedSrc)[delim === '*' ? 'ast' : 'und'];
};

Lexer.prototype.cachedDelCloser = function (maskedSrc) {
  return this.getFrame(maskedSrc).del;
};

Lexer.prototype.tokenizeInlines = function (src, textMode) {
  let out = '';
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    let token;
    // Dispatch on the first character: at any position at most two of the
    // inline tokenizers can match, so the rest need not run. The order
    // inside each branch is marked's order.
    const ch = src[0];
    if (ch === '\\') {
      if (token = this.tokEscape(src)) {
        src = src.substring(token.raw.length);
        out += textMode ? token.text : esc(token.text);
        continue;
      }
      if (token = this.tokBr(src)) {
        src = src.substring(token.raw.length);
        out += textMode ? '' : '<br>';
        continue;
      }
    } else if (ch === '<') {
      if (token = this.tokTag(src)) {
        src = src.substring(token.raw.length);
        out += token.text;
        continue;
      }
      if (token = this.tokAutolink(src)) {
        src = src.substring(token.raw.length);
        out += textMode ? token.text : token.html;
        continue;
      }
    } else if (ch === '[' || ch === '!') {
      if (token = this.tokLink(src, textMode)) {
        src = src.substring(token.raw.length);
        out += token.html;
        continue;
      }
      if (token = this.tokReflink(src, textMode)) {
        src = src.substring(token.raw.length);
        out += token.type === 'text' ? (textMode ? token.text : esc(token.text)) : token.html;
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      if (token = this.tokEmStrong(src, prevChar, textMode)) {
        src = src.substring(token.raw.length);
        out += textMode ? token.html : (token.type === 'em' ? `<em>${token.html}</em>` : `<strong>${token.html}</strong>`);
        continue;
      }
    } else if (ch === '`') {
      if (token = this.tokCodespan(src)) {
        src = src.substring(token.raw.length);
        out += textMode ? token.text : `<code>${esc(token.text, true)}</code>`;
        continue;
      }
    } else if (ch === '~') {
      if (token = this.tokDel(src, prevChar, textMode)) {
        src = src.substring(token.raw.length);
        out += textMode ? token.html : `<del>${token.html}</del>`;
        continue;
      }
    } else if (ch === ' ') {
      if (token = this.tokBr(src)) {
        src = src.substring(token.raw.length);
        out += textMode ? '' : '<br>';
        continue;
      }
    }
    // An extended autolink or bare email can only start on a letter, a
    // digit, or one of . _ + -.
    const cc = src.charCodeAt(0);
    if (!this.state.inLink &&
        ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
         cc === 46 || cc === 95 || cc === 43 || cc === 45) &&
        (token = this.tokUrl(src))) {
      src = src.substring(token.raw.length);
      out += textMode ? token.text : token.html;
      continue;
    }
    if (token = this.tokInlineText(src)) {
      src = src.substring(token.raw.length);
      if (token.raw.charCodeAt(token.raw.length - 1) !== 95) prevChar = token.raw[token.raw.length - 1];
      keepPrevChar = true;
      out += textMode || token.escaped || token.clean ? token.text : esc(token.text);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return out;
};

const RE_START_SPACE = /^ /;
const RE_END_SPACE = / $/;

Lexer.prototype.tokEscape = function (src) {
  RE_ESCAPE.lastIndex = 0;
  const cap = RE_ESCAPE.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
};

Lexer.prototype.tokTag = function (src) {
  RE_TAG.lastIndex = 0;
  const cap = RE_TAG.exec(src);
  if (cap) {
    if (!this.state.inLink && RE_START_A.test(cap[0])) this.state.inLink = true;
    else if (this.state.inLink && RE_END_A.test(cap[0])) this.state.inLink = false;
    if (!this.state.inRawBlock && RE_START_PRE.test(cap[0])) this.state.inRawBlock = true;
    else if (this.state.inRawBlock && RE_END_PRE.test(cap[0])) this.state.inRawBlock = false;
    return { type: 'html', raw: cap[0], inLink: this.state.inLink, inRawBlock: this.state.inRawBlock, block: false, text: cap[0] };
  }
};

Lexer.prototype.tokLink = function (src, textMode) {
  if (this.state.linkParenPossible === false) return undefined;
  RE_LINK.lastIndex = 0;
  const cap = RE_LINK.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const trimmedUrl = cap[2].trim();
    if (RE_START_ANGLE.test(trimmedUrl)) {
      if (!RE_END_ANGLE.test(trimmedUrl)) return;
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) return;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (RE_START_ANGLE.test(href)) href = href.slice(1, -1);
    return outputLink(cap, {
      href: href ? href.replace(RE_ANY_PUNCT, '$1') : href,
      title: title ? title.replace(RE_ANY_PUNCT, '$1') : title,
    }, cap[0], this, textMode);
  }
};

Lexer.prototype.tokReflink = function (src, textMode) {
  let cap;
  RE_REFLINK.lastIndex = 0;
  if ((cap = RE_REFLINK.exec(src)) || (RE_NOLINK.lastIndex = 0, cap = RE_NOLINK.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const link = this.links[normLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(cap, link, cap[0], this, textMode);
  }
};

Lexer.prototype.tokEmStrong = function (src, prevChar = '', textMode) {
  RE_EM_L_DELIM.lastIndex = 0;
  let match = RE_EM_L_DELIM.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  let maskedSrc = this.getMasked();
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  let runPrevChar = '';
  if (runStart > 0) {
    const c = maskedSrc.charCodeAt(runStart - 1);
    runPrevChar = (c >= 0xDC00 && c <= 0xDFFF && runStart >= 2 &&
      maskedSrc.charCodeAt(runStart - 2) >= 0xD800 && maskedSrc.charCodeAt(runStart - 2) <= 0xDBFF)
      ? maskedSrc.slice(runStart - 2, runStart)
      : maskedSrc[runStart - 1];
  }
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCT_START.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCT_START.exec(prevChar);
  if (match[4] && prevChar.match(UNICODE_ALNUM)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const m0 = match[0]; const lLength = m0.length - 1 - (m0.charCodeAt(m0.length - 1) >= 0xDC00 && m0.charCodeAt(m0.length - 1) <= 0xDFFF ? 1 : 0);
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? RE_EM_R_DELIM_AST : RE_EM_R_DELIM_UND;
    const lastPossible = this.cachedEmCloser(maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = firstCpLen(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, html: this.inlineTokens(text, textMode) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, html: this.inlineTokens(text, textMode) };
    }
  }
};

Lexer.prototype.tokCodespan = function (src) {
  RE_CODE_SPAN.lastIndex = 0;
  const cap = RE_CODE_SPAN.exec(src);
  if (cap) {
    let text = cap[2].replace(RE_NEWLINE_GLOBAL, ' ');
    const hasNonSpaceChars = RE_NON_SPACE.test(text);
    const hasSpaceCharsOnBothEnds = RE_START_SPACE.test(text) && RE_END_SPACE.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
};

Lexer.prototype.tokBr = function (src) {
  RE_BR.lastIndex = 0;
  const cap = RE_BR.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
};

Lexer.prototype.tokDel = function (src, prevChar = '', textMode) {
  RE_DEL_L_DELIM.lastIndex = 0;
  let match = RE_DEL_L_DELIM.exec(src);
  if (!match) return;
  let maskedSrc = this.getMasked();
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || PUNCT_START.exec(prevChar)) {
    const m0 = match[0]; const lLength = m0.length - 1 - (m0.charCodeAt(m0.length - 1) >= 0xDC00 && m0.charCodeAt(m0.length - 1) <= 0xDFFF ? 1 : 0);
    let rDelim, rLength, delimTotal = lLength;
    const endReg = RE_DEL_R_DELIM;
    const lastPossible = this.cachedDelCloser(maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = firstCpLen(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, html: this.inlineTokens(text, textMode) };
    }
  }
};

Lexer.prototype.tokAutolink = function (src) {
  RE_AUTOLINK.lastIndex = 0;
  const cap = RE_AUTOLINK.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    const cleanHref = cleanUrl(href);
    const html = cleanHref === null ? esc(text, true) : `<a href="${esc(cleanHref, true)}">${esc(text, true)}</a>`;
    return { type: 'link', raw: cap[0], text, href, autolink: true, html };
  }
};

Lexer.prototype.tokUrl = function (src) {
  RE_URL.lastIndex = 0;
  let cap = RE_URL.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = RE_URL_BACKPEDAL.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      if (cap[1] === 'www.') href = 'http://' + cap[0];
      else href = cap[0];
    }
    const cleanHref = cleanUrl(href);
    const html = cleanHref === null ? esc(text, true) : `<a href="${esc(cleanHref, true)}">${esc(text, true)}</a>`;
    return { type: 'link', raw: cap[0], text, href, autolink: true, html };
  }
};

// A run with no inline-construct starter is plain text; the full text
// pattern is only needed when one may be present.
const RE_FAST_TEXT = /^[^\\<!\[`*~_\n]+/;

Lexer.prototype.tokInlineText = function (src) {
  const fast = RE_FAST_TEXT.exec(src);
  if (fast) {
    let chunk = fast[0];
    // Two trailing spaces before a newline are a hard break, not text.
    if (src[chunk.length] === '\n') {
      const t = chunk.replace(/ {2,}$/, '');
      if (t.length === 0) return this.tokInlineTextSlow(src);
      chunk = t;
    }
    if (chunk.indexOf('@') === -1 && chunk.indexOf('www.') === -1 &&
        chunk.indexOf('://') === -1 && chunk.indexOf('mailto:') === -1 && chunk.indexOf('xmpp:') === -1) {
      const escaped = this.state.inRawBlock;
      // No & < > " ' anywhere: unescapeNumeric and esc are both identity.
      if (chunk.indexOf('&') === -1 && chunk.indexOf('<') === -1 && chunk.indexOf('>') === -1 &&
          chunk.indexOf('"') === -1 && chunk.indexOf("'") === -1) {
        return { type: 'text', raw: chunk, text: chunk, escaped, clean: true };
      }
      return { type: 'text', raw: chunk, text: escaped ? chunk : unescapeNumeric(chunk), escaped };
    }
  }
  return this.tokInlineTextSlow(src);
};

Lexer.prototype.tokInlineTextSlow = function (src) {
  RE_TEXT.lastIndex = 0;
  const cap = RE_TEXT.exec(src);
  if (cap) {
    const escaped = this.state.inRawBlock;
    return { type: 'text', raw: cap[0], text: escaped ? cap[0] : unescapeNumeric(cap[0]), escaped };
  }
};

// ------------------------------------------------------------------ renderer
function renderTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${t.depth}>${t.html.out}</h${t.depth}>\n`;
        break;
      case 'code': {
        const langString = (t.lang || '').match(RE_NOT_SPACE_START)?.[0];
        const code = t.text ? t.text.replace(RE_ENDING_NEWLINE, '') + '\n' : '';
        if (!langString) out += '<pre><code>' + esc(code, true) + '</code></pre>\n';
        else out += '<pre><code class="language-' + esc(langString) + '">' + esc(code, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (const h of t.header) cell += tableCell(h);
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (const row of t.rows) {
          cell = '';
          for (const c of row) cell += tableCell(c);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderTokens(t.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let body = '';
        for (const item of t.items) body += `<li>${renderTokens(item.tokens)}</li>\n`;
        const type = t.ordered ? 'ol' : 'ul';
        const startAttr = (t.ordered && t.start !== 1) ? (' start="' + t.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += t.text;
        break;
      case 'paragraph':
        out += `<p>${t.html.out}</p>\n`;
        break;
      case 'text':
        out += t.html.out;
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function tableCell(token) {
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + token.html.out + `</${type}>\n`;
}

export function parse(markdown) {
  const lx = new Lexer();
  return renderTokens(lx.lex(markdown));
}
