// parse.js — dependency-free CommonMark 0.31.2 + GFM renderer.
// Written from scratch to match the HTML marked 18.1.3 produces with its
// default options (GFM on, breaks off). Renders straight to HTML: the block
// phase builds a light token list (link reference definitions have to be
// collected before any inline text is rendered), the inline phase turns each
// text span into HTML directly. No caching across calls, no I/O, no clock.

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const WS_RE = /\s/;
const NUMREF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMREF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_NOENC_REPLACE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
const BLANK_RE = /^[ \t]*$/;
const NONSPACE_RE = /[^ ]/;

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (c) => ESC_MAP[c];

// Escape &, <, >, ", ' (full).
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_REPLACE, escChar);
}

// Escape <, >, ", ' and only those & that do not start a valid entity.
function escNoEnc(s) {
  if (!ESC_NOENC_TEST.test(s)) return s;
  return s.replace(ESC_NOENC_REPLACE, escChar);
}

// Decode numeric character references; a bare & that does not start a valid
// reference becomes &amp;. Named entities are left untouched.
function decodeEntities(s) {
  // Fast path: numeric refs always contain '&#'; without it the only thing
  // the replace would do is turn bare & into &amp;, which the caller's
  // escNoEnc does identically, so there is nothing to do here.
  if (s.indexOf('&#') === -1) return s;
  if (!NUMREF_RE.test(s)) return s;
  return s.replace(NUMREF_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// encodeURI with %25 restored (marked's cleanUrl).
function cleanUrl(u) {
  try { return encodeURI(u).replace(/%25/g, '%'); } catch { return null; }
}

// Strip `n` trailing chars equal to `ch` from a string (marked's `L` with t undefined).
function stripTrail(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Remove trailing blank lines, keeping at most one (marked's `ge`).
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_RE.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// Normalise a link label / reference (marked's `F`).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces, tab stops every 4 columns starting at `start` (marked's `J`).
function expandTabs(s, start) {
  let out = '', col = start;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
    } else { out += c; col++; }
  }
  return out;
}

// Is the character at `i` of `s` a backslash-escaped position? Count the
// backslashes immediately before `i`: odd means escaped.
function isEscaped(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return (n % 2) === 1;
}

// Unescape backslash + punctuation (marked's anyPunctuation replace).
function unescapePunct(s) {
  return s.indexOf('\\') === -1 ? s : s.replace(ANY_PUNCT_RE, '$1');
}

// Parenthesis balance check (marked's `ke`): -1 balanced, -2 unclosed open,
// otherwise the index of the first unmatched close paren.
function parenCheck(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row into cells (marked's `de`).
function splitCells(row, count) {
  // Replace unescaped | with " |", then split on " |".
  let t = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '|') { t += isEscaped(row, i) ? '|' : ' |'; }
    else t += c;
  }
  const parts = t.split(' |');
  if (parts.length > 0 && !parts[0].trim()) parts.shift();
  if (parts.length > 0 && !parts[parts.length - 1].trim()) parts.pop();
  if (count !== undefined) {
    if (parts.length > count) parts.splice(count);
    else while (parts.length < count) parts.push('');
  }
  for (let i = 0; i < parts.length; i++) parts[i] = parts[i].trim().replace(/\\\|/g, '|');
  return parts;
}

// Single-character class tests (Unicode aware). ASCII chars are decided by
// char-code ranges (regex tests on 1-char strings are comparatively slow
// and these run in the emphasis hot path); non-ASCII falls back to regex.
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  return PUNCT_RE.test(ch);
}
function isAlnumCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return ALNUM_RE.test(ch);
}
function isSpaceCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return WS_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Inline matching helpers
// ---------------------------------------------------------------------------

function isWordCh(c) {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_');
}
function isAlnumAscii(c) {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'));
}
function isDigitCh(c) { return c !== undefined && c >= '0' && c <= '9'; }

// Match a code span starting at src[i] === '`'.
// Returns {end, text} (end = index just past the closing run) or null.
function matchCodeSpan(src, i) {
  const n = src.length;
  let k = 0;
  while (i + k < n && src[i + k] === '`') k++;
  if (k === 0) return null;
  // Find the next maximal backtick run of length exactly k.
  let j = i + k;
  while (j < n) {
    if (src[j] !== '`') { j++; continue; }
    let m = 0;
    while (j + m < n && src[j + m] === '`') m++;
    if (m === k) {
      const content = src.slice(i + k, j);
      if (content.length === 0) return null;
      return { end: j + m, text: content };
    }
    j += m;
  }
  return null;
}

// Nested bracket pair starting at src[j] === '[': '[' inner ']' where
// inner holds escapes, non-bracket chars, or one more level of bracket
// pair. Returns the index of the inner ']' or -1.
function scanNestedPair(src, j) {
  const n = src.length;
  let k = j + 1;
  while (k < n) {
    const d = src[k];
    if (d === ']') return k;
    if (d === '\\') { k += 2; continue; }
    if (d === '[') {
      // One more level: a pair with no brackets inside.
      let m = k + 1, ok2 = false;
      while (m < n) {
        const e2 = src[m];
        if (e2 === ']') { ok2 = true; break; }
        if (e2 === '[') break;
        if (e2 === '\\') { m += 2; continue; }
        m++;
      }
      if (!ok2) return -1;
      k = m + 1; continue;
    }
    k++;
  }
  return -1;
}

// Candidate closing-']' positions for a link label starting just after
// '[' at `i`, in the order marked's label regex would try them (at most
// `max`). This mirrors the regex engine's backtracking: at a backtick
// run, alt 3 (code span: opening run, non-backtick content, closing run
// of any length) is tried first; if the label cannot complete after
// that span, the engine backtracks and tries alt 4 (a run of 2+
// backticks immediately before ']') as literal backticks. That is why
// `[less `` a ` b ``](./docs/value.md)` (doc-33) IS a link -- the `` `` ``
// before ']' is literal on backtrack -- while `[cache _an `` a ` b ``_
// escape](./docs/some.md ...)` (doc-23) and `[first heading `` a ` b ``
// of](...)` (doc-30) are NOT: the `` `` `` there is before `_` / ` `,
// so alt 4 cannot apply and the label is invalid.
function scanLabelCandidates(src, i, max) {
  const n = src.length;
  const out = [];
  function rec(j) {
    if (out.length >= max) return;
    while (j < n) {
      const c = src[j];
      if (c === ']') {
        if (!out.includes(j)) out.push(j); // at most `max` (<=4) entries: linear check beats a Set allocation
        return;
      }
      if (c === '\\') { j += 2; continue; }
      if (c === '`') {
        let k = 0;
        while (j + k < n && src[j + k] === '`') k++;
        let p = j + k;
        while (p < n && src[p] !== '`') {
          if (src[p] === '\\') p += 2;
          else p++;
        }
        if (p < n) {
          let m = 0;
          while (p + m < n && src[p + m] === '`') m++;
          rec(p + m);
          if (out.length >= max) return;
        }
        if (k >= 2 && j + k < n && src[j + k] === ']') {
          rec(j + k);
          if (out.length >= max) return;
        }
        return;
      }
      if (c === '[') {
        const inner = scanNestedPair(src, j);
        if (inner === -1) return;
        j = inner + 1; continue;
      }
      j++;
    }
  }
  rec(i);
  return out;
}

// Scan a link label starting just after '[' at `i`.
// Returns the index of the closing ']' or -1.
function scanLabel(src, i) {
  const cands = scanLabelCandidates(src, i, 1);
  return cands.length ? cands[0] : -1;
}

// Scan a reference (link label inside [..][ref] or [ref]) starting at `i`.
// Returns the index just past the closing ']' or -1.
function scanRef(src, i) {
  const n = src.length;
  let j = i;
  if (j >= n || src[j] === ']') return -1;
  while (j < n) {
    const c = src[j];
    if (c === ']') return j + 1;
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') {
      // Newline allowed unless the next line is blank.
      let k = j + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= n || src[k] === '\n') return -1;
      j = k; continue;
    }
    if (c === '[') return -1;
    j++;
  }
  return -1;
}

// Match an inline HTML tag starting at src[i] === '<'.
// Returns the index just past the tag, or -1.
function matchTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return i + 5;
    if (src.startsWith('<!--->', i)) return i + 6;
    const end = src.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (src[i + 1] === '!') {
    let j = i + 2;
    if (j >= n || !((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) return -1;
    while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) j++;
    if (j >= n || (src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '\r' && src[j] !== '\f')) return -1;
    const end = src.indexOf('>', j);
    return end === -1 ? -1 : end + 1;
  }
  if (src[i + 1] === '/') {
    let j = i + 2;
    if (j >= n || !((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) return -1;
    while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '-')) j++;
    while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
    if (j < n && src[j] === '>') return j + 1;
    return -1;
  }
  // Open tag.
  let j = i + 1;
  if (j >= n || !((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) return -1;
  while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '-')) j++;
  while (true) {
    // Attribute: whitespace + name + optional =value.
    let k = j;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r' || src[k] === '\f')) k++;
    if (k === j) break;
    const ns = k;
    if (k >= n || !((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || src[k] === '_' || src[k] === ':')) break;
    k++;
    while (k < n && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '_' || src[k] === ':' || src[k] === '.' || src[k] === '-')) k++;
    // Optional value.
    let m = k;
    while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
    if (m < n && src[m] === '=') {
      m++;
      while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
      if (m < n && src[m] === '"') {
        const q = src.indexOf('"', m + 1);
        if (q === -1) break;
        m = q + 1;
      } else if (m < n && src[m] === "'") {
        const q = src.indexOf("'", m + 1);
        if (q === -1) break;
        m = q + 1;
      } else {
        let v = m;
        while (v < n && src[v] !== ' ' && src[v] !== '\t' && src[v] !== '\n' && src[v] !== '\r' && src[v] !== '\f' && src[v] !== '"' && src[v] !== "'" && src[v] !== '=' && src[v] !== '<' && src[v] !== '>' && src[v] !== '`') v++;
        if (v === m) break;
        m = v;
      }
      k = m;
    }
    j = k;
    void ns;
  }
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r' || src[j] === '\f')) j++;
  if (j < n && src[j] === '/') j++;
  if (j < n && src[j] === '>') return j + 1;
  return -1;
}

// Match an email address inside an autolink <...> starting at `i`.
// Returns the index just past it, or -1.
function matchEmailAutolink(src, i) {
  const n = src.length;
  let j = i;
  const lp = ".!#$%&'*+/=?^_`{|}~-";
  while (j < n) {
    const c = src[j];
    if (isAlnumAscii(c) || lp.indexOf(c) !== -1) j++;
    else break;
  }
  if (j === i || j >= n || src[j] !== '@') return -1;
  j++;
  // Domain labels: alnum, then up to 61 alnum/dash, then alnum; at least one dot.
  const label = () => {
    const s = j;
    if (j >= n || !isAlnumAscii(src[j])) return false;
    j++;
    let m = j;
    while (m < n && m - j < 62 && (isAlnumAscii(src[m]) || src[m] === '-')) m++;
    while (m > j && src[m - 1] === '-') m--;
    j = m;
    return j > s;
  };
  if (!label()) return -1;
  let dots = 0;
  while (j < n && src[j] === '.') {
    const save = j;
    j++;
    if (!label()) { j = save; break; }
    dots++;
  }
  if (dots === 0) return -1;
  if (j < n && (src[j] === '-' || src[j] === '_')) return -1;
  return j;
}

// Match a GFM bare email (or the email inside mailto:/xmpp:) starting at `i`.
// Returns the index just past it, or -1.
function matchEmail(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    // alnum ASCII or . _ + -
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 46 || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return -1; // '@'
  j++;
  const ds = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95) j++;
    else break;
  }
  if (j === ds) return -1;
  let dots = 0;
  while (j < n && src.charCodeAt(j) === 46) {
    let k = j + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95) k++;
      else break;
    }
    if (k === j + 1) break; // empty label
    const lc = src.charCodeAt(k - 1);
    if (!((lc >= 97 && lc <= 122) || (lc >= 65 && lc <= 90) || (lc >= 48 && lc <= 57))) break; // label must end with alnum
    dots++;
    j = k;
  }
  if (dots === 0) return -1;
  if (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45) return -1;
  }
  return j;
}

// Match an autolink <...> starting at src[i] === '<'.
// Returns {end, text, href} or null.
function matchAutolink(src, i) {
  const n = src.length;
  // Scheme: <scheme:...>
  let j = i + 1;
  if (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) {
    let k = j + 1, count = 1;
    while (k < n && count < 32 && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '+' || src[k] === '.' || src[k] === '-')) { k++; count++; }
    if (k < n && src[k] === ':' && count >= 2) {
      let m = k + 1;
      while (m < n) {
        const c = src[m];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c === '>' || c.charCodeAt(0) < 0x20) break;
        m++;
      }
      if (m < n && src[m] === '>') {
        const text = src.slice(i + 1, m);
        return { end: m + 1, text, href: text, email: false };
      }
    }
  }
  // Email: <foo@bar.baz>
  const e = matchEmailAutolink(src, i + 1);
  if (e !== -1 && e < n && src[e] === '>') {
    const text = src.slice(i + 1, e);
    return { end: e + 1, text, href: 'mailto:' + text, email: true };
  }
  return null;
}

// Trim a GFM extended autolink the way marked's _backpedal regex does.
const BACKPEDAL_PUNCT = '?!.,:;*\'"~)';
const BACKPEDAL_SAFE_EXCL = '?!.,:;*\'"~()&';
function backpedal(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const j = s.indexOf(')', i + 1);
      if (j === -1) break;
      i = j + 1; continue;
    }
    if (c === '&') {
      let k = i + 1;
      while (k < n && isAlnumAscii(s[k])) k++;
      if (k > i + 1 && k < n && s[k] === ';' && k + 1 === n) break;
      i++; continue;
    }
    if (BACKPEDAL_PUNCT.indexOf(c) !== -1) {
      let j = i;
      while (j < n && BACKPEDAL_PUNCT.indexOf(s[j]) !== -1) j++;
      if (j === n) break;
      i = j; continue;
    }
    let j = i;
    while (j < n && BACKPEDAL_SAFE_EXCL.indexOf(s[j]) === -1) j++;
    i = j;
  }
  return s.slice(0, i);
}

// Match a GFM extended autolink (www./scheme/email/mailto:/xmpp:) at `i`.
// Returns {end, text, href} or null.
function matchUrl(src, i) {
  const n = src.length;
  // mailto: / xmpp: + email
  const c0 = src.charCodeAt(i);
  if (c0 === 109 || c0 === 120) { // 'm' or 'x'
    if ((c0 === 109 && src.startsWith('mailto:', i)) || (c0 === 120 && src.startsWith('xmpp:', i))) {
      const proto = c0 === 109 ? 7 : 5;
      const e = matchEmail(src, i + proto);
      if (e !== -1) {
        let end = e;
        if (c0 === 120 && end < n && src.charCodeAt(end) === 47) {
          let k = end + 1;
          while (k < n && (isAlnumAscii(src[k]) || src[k] === '@' || src[k] === '.')) k++;
          end = k;
        }
        const raw = src.slice(i, end);
        const t = backpedal(raw);
        return { end: i + t.length, text: t, href: t };
      }
      return null;
    }
  }
  // scheme:// or www. (case-insensitive, no slice/toLowerCase)
  let j = i, scheme = '';
  if (c0 === 104 || c0 === 72 || c0 === 102 || c0 === 70) { // h/H/f/F
    const a = src.charCodeAt(i + 1) | 32, b = src.charCodeAt(i + 2) | 32, d = src.charCodeAt(i + 3) | 32;
    if ((c0 | 32) === 104 && a === 116 && b === 116 && d === 112) {
      const e = src.charCodeAt(i + 4) | 32;
      if (e === 58 && src.charCodeAt(i + 5) === 47 && src.charCodeAt(i + 6) === 47) { scheme = 'http://'; j = i + 7; }
      else if (e === 115 && src.charCodeAt(i + 5) === 58 && src.charCodeAt(i + 6) === 47 && src.charCodeAt(i + 7) === 47) { scheme = 'https://'; j = i + 8; }
    } else if ((c0 | 32) === 102 && a === 116 && b === 112 && d === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47) {
      scheme = 'ftp://'; j = i + 6;
    }
  } else if (c0 === 119 && src.charCodeAt(i + 1) === 119 && src.charCodeAt(i + 2) === 119 && src.charCodeAt(i + 3) === 46) {
    scheme = 'www.'; j = i + 4;
  }
  if (scheme !== '') {
    // Domain labels: (alnum/dash+ .?)+
    let k = j, any = false;
    while (k < n) {
      const ls = k;
      while (k < n && (isAlnumAscii(src[k]) || src[k] === '-')) k++;
      if (k === ls) break;
      any = true;
      if (k < n && src[k] === '.') k++;
      else break;
    }
    if (!any) return null;
    // Tail: [^\s<]*
    let m = k;
    while (m < n && src[m] !== ' ' && src[m] !== '\t' && src[m] !== '\n' && src[m] !== '\r' && src[m] !== '<' && src[m] !== '\f' && src[m] !== '\v') m++;
    const raw = src.slice(i, m);
    const t = backpedal(raw);
    if (t.length === 0) return null;
    return { end: i + t.length, text: t, href: scheme === 'www.' ? 'http://' + t : t };
  }
  // Bare email.
  const e = matchEmail(src, i);
  if (e !== -1) {
    const text = src.slice(i, e);
    return { end: e, text, href: 'mailto:' + text };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Link parsing
// ---------------------------------------------------------------------------

// Parse a link title starting at src[i] ('"', "'", or '(').
// Returns {end, title} or null.
function parseTitle(src, i) {
  const n = src.length;
  const q = src[i];
  if (q === '"') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '\n' && src[j + 1] === '\n') return null;
      if (src[j] === '"') return { end: j + 1, title: src.slice(i + 1, j) };
      j++;
    }
    return null;
  }
  if (q === "'") {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '\n' && src[j + 1] === '\n') return null;
      if (src[j] === "'") return { end: j + 1, title: src.slice(i + 1, j) };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === ')') return { end: j + 1, title: src.slice(i + 1, j) };
      j++;
    }
    return null;
  }
  return null;
}

// Try to match an inline link [..](..) at src[i] ('[' or '![').
// Returns {end, label, href, title, isImage} or null (no syntactic match).
function matchInlineLink(src, i) {
  const n = src.length;
  const isImage = src[i] === '!';
  const lb = isImage ? i + 2 : i + 1;
  if (src[lb - 1] !== '[') return null;
  // The label may end at more than one ']' (backtracking over a code
  // span vs literal backticks); try each candidate in regex order and
  // take the first that yields a complete link.
  for (const labelEnd of scanLabelCandidates(src, lb, 4)) {
    const r = tryInlineLinkAt(src, i, lb, labelEnd, isImage);
    if (r) return r;
  }
  return null;
}

// Try to match an inline link whose label ends at `labelEnd`.
function tryInlineLinkAt(src, i, lb, labelEnd, isImage) {
  const n = src.length;
  if (labelEnd + 1 >= n || src[labelEnd + 1] !== '(') return null;
  let j = labelEnd + 2;
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  // href: <...> form, bare form, or empty before ')'.
  let href = '', hrefEnd = j;
  if (j < n && src[j] === '<') {
    let k = j + 1, ok = false;
    while (k < n) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '\n' || src[k] === '<') break;
      if (src[k] === '>') { ok = k > j + 1; break; }
      k++;
    }
    if (ok) { href = src.slice(j, k + 1); hrefEnd = k + 1; }
    else {
      let k2 = j, depth = 0;
      while (k2 < n) {
        const c = src[k2];
        if (c === '\\') { k2 += 2; continue; }
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c.charCodeAt(0) < 0x20) break;
        if (c === '(') depth++;
        else if (c === ')') { if (depth === 0) break; depth--; }
        k2++;
      }
      href = src.slice(j, k2); hrefEnd = k2;
      if (href === '' && !(k2 < n && src[k2] === ')')) return null;
    }
  } else {
    let k = j, depth = 0;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c.charCodeAt(0) < 0x20) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      k++;
    }
    href = src.slice(j, k); hrefEnd = k;
    if (href === '' && !(k < n && src[k] === ')')) return null;
  }
  // Optional title.
  let title = '', end = hrefEnd;
  let t = hrefEnd;
  let sep = false;
  if (t < n && (src[t] === ' ' || src[t] === '\t')) {
    sep = true;
    while (t < n && (src[t] === ' ' || src[t] === '\t')) t++;
    if (t < n && src[t] === '\n') { t++; while (t < n && (src[t] === ' ' || src[t] === '\t')) t++; }
  } else if (t < n && src[t] === '\n') {
    sep = true;
    t++;
    while (t < n && (src[t] === ' ' || src[t] === '\t')) t++;
  }
  if (sep) {
    const tp = parseTitle(src, t);
    if (tp) { title = tp.title; end = tp.end; }
  }
  let k = end;
  while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  if (k >= n || src[k] !== ')') return null;
  const rawEnd = k + 1;
  let raw = src.slice(i, rawEnd);
  let hrefStr = href;
  // Angle-bracket href checks / paren balance.
  const s = hrefStr.trim();
  if (s.charCodeAt(0) === 60) { // '<'
    if (s.charCodeAt(s.length - 1) !== 62) return null; // must end with '>'
    const l = stripTrail(s.slice(0, -1), 92);
    if ((s.length - l.length) % 2 === 0) return null; // '>' is escaped
  } else {
    const l = parenCheck(hrefStr);
    if (l === -2) return null;
    if (l > -1) {
      const h = (isImage ? 5 : 4) + (labelEnd - lb) + l;
      hrefStr = hrefStr.substring(0, l);
      raw = src.slice(i, i + h).trim();
      title = '';
    }
  }
  // The closing ')' must not be escaped.
  const r = stripTrail(raw.slice(0, -1), 92);
  if ((raw.length - r.length) % 2 === 0) return null;
  hrefStr = hrefStr.trim();
  if (hrefStr.charCodeAt(0) === 60) hrefStr = hrefStr.slice(1, -1);
  const label = src.slice(lb, labelEnd);
  if (labelHasOpenTag(src, lb, label, label.length)) return null;
  return {
    end: i + raw.length,
    label,
    href: unescapePunct(hrefStr),
    title: title ? unescapePunct(title) : '',
    isImage,
  };
}

// Does the label contain an unclosed <...> that runs past the label's end?
// (marked's `Be`.)
function labelHasOpenTag(src, labelStart, label, labelLen) {
  if (label.indexOf('<') === -1) return false;
  for (let s = 0; s < labelLen; s++) {
    const c = label[s];
    if (c === '\\') { s++; continue; }
    if (c === '`') {
      const cs = matchCodeSpan(label, s);
      if (cs) { s += cs.end - s - 1; continue; }
    }
    if (c !== '<') continue;
    const r = src.slice(labelStart + s);
    const tg = matchTag(r, 0);
    if (tg !== -1) {
      if (tg > labelLen - s) return true;
      s += tg - 1; continue;
    }
    const al = matchAutolink(r, 0);
    if (al) {
      if (al.end > labelLen - s) return true;
      s += al.end - 1;
    }
  }
  return false;
}

// Try to match a reference link [..][..] / [..][] / [..] at src[i].
// Returns {end, label, href, title, isImage, found} where found=false means
// the label is not a known reference (caller emits one literal char).
function matchRefLink(src, i, links) {
  const n = src.length;
  const isImage = src[i] === '!';
  const lb = isImage ? i + 2 : i + 1;
  if (src[lb - 1] !== '[') return null;
  const labelEnd = scanLabel(src, lb);
  if (labelEnd === -1) return null;
  const label = src.slice(lb, labelEnd);
  let ref = null, end = -1;
  if (labelEnd + 1 < n && src[labelEnd + 1] === '[') {
    const refEnd = scanRef(src, labelEnd + 2);
    if (refEnd !== -1) {
      ref = src.slice(labelEnd + 2, refEnd - 1);
      end = refEnd;
    }
  }
  if (ref === null) {
    // Nolink: [label] or [label][].
    if (labelEnd + 2 < n && src[labelEnd + 1] === '[' && src[labelEnd + 2] === ']') {
      ref = label; end = labelEnd + 3;
    } else {
      ref = label; end = labelEnd + 1;
    }
  }
  if (labelHasOpenTag(src, lb, label, label.length)) return null;
  const def = links[normLabel(ref === '' ? label : ref)];
  if (!def) return { found: false, end: i + 1, isImage };
  return { found: true, end, label, href: def.href, title: def.title || '', isImage };
}

// Match a reference-link search construct ([..][..] / [..][] / [..]) at `i`.
// Returns {end, ref, text, isImage, sep} or null. `sep` is the index of the
// '[' that starts the ref part (relative to the match start), or -1.
function matchRefSearch(src, i) {
  const n = src.length;
  const isImage = src[i] === '!';
  const lb = isImage ? i + 2 : i + 1;
  if (src[lb - 1] !== '[') return null;
  const labelEnd = scanLabel(src, lb);
  if (labelEnd === -1) return null;
  const label = src.slice(lb, labelEnd);
  if (labelEnd + 1 < n && src[labelEnd + 1] === '[') {
    const refEnd = scanRef(src, labelEnd + 2);
    if (refEnd !== -1) {
      return { end: refEnd, ref: src.slice(labelEnd + 2, refEnd - 1), text: label, isImage, sep: labelEnd + 1 - i };
    }
  }
  // Nolink, optionally followed by [] — but not by '('.
  if (labelEnd + 1 < n && src[labelEnd + 1] === '(') return null;
  if (labelEnd + 2 < n && src[labelEnd + 1] === '[' && src[labelEnd + 2] === ']') {
    return { end: labelEnd + 3, ref: label, text: label, isImage, sep: -1 };
  }
  return { end: labelEnd + 1, ref: label, text: label, isImage, sep: -1 };
}

// Does `s` contain a link (inline or reference) that is not an image?
// (marked's `linkInText`.)
function linkInText(s, links) {
  if (s.indexOf('[') === -1) return false;
  const n = s.length;
  // Part 1: inline links (code spans and html tags are skipped over).
  for (let i = 0; i < n;) {
    const c = s[i];
    if (c === '`') { const cs = matchCodeSpan(s, i); if (cs) { i = cs.end; continue; } i++; continue; }
    if (c === '<') {
      const tg = matchTag(s, i);
      if (tg !== -1) { i = tg; continue; }
      const al = matchAutolink(s, i);
      if (al) { i = al.end; continue; }
      i++; continue;
    }
    if (c === '[') {
      const m = matchInlineLink(s, i);
      if (m) {
        if (i > 0 && s[i - 1] === '!') { i = m.end; continue; }
        return true;
      }
      i++; continue;
    }
    i++;
  }
  // Part 2: reference links.
  for (let i = 0; i < n;) {
    const c = s[i];
    if (c !== '[' && !(c === '!' && s[i + 1] === '[')) { i++; continue; }
    const m = matchRefSearch(s, i);
    if (!m) { i++; continue; }
    if (m.isImage) { i = m.end; continue; }
    if (!Object.hasOwn(links, normLabel(m.ref === '' ? m.text : m.ref))) { i = m.end; continue; }
    if (m.sep > 1 && m.text !== null && linkInText(m.text, links)) { i = m.end; continue; }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Emphasis / strikethrough delimiter machinery
// ---------------------------------------------------------------------------

// BlockSkip's html alternative: < (not followed by space) [^<>]*? >
function matchBlockSkipHtml(src, i) {
  if (src[i] !== '<' || src[i + 1] === ' ') return -1;
  const end = src.indexOf('>', i + 1);
  if (end === -1) return -1;
  if (src.indexOf('<', i + 1) !== -1 && src.indexOf('<', i + 1) < end) return -1;
  return end + 1;
}

// BlockSkip's link alternative: [label](dest) with a label that holds no
// nested brackets (code spans allowed inside it).
function matchBlockSkipLink(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === ']') break;
    if (c === '[') return -1;
    if (c === '`') {
      const cs = matchCodeSpan(src, j);
      if (!cs) return -1;
      j = cs.end; continue;
    }
    if (c === '\\') { j += 2; continue; }
    j++;
  }
  if (j >= n || src[j] !== ']' || j + 1 >= n || src[j + 1] !== '(') return -1;
  let k = j + 2;
  while (k < n) {
    const c = src[k];
    if (c === ')') return k + 1;
    if (c === '\\') { k += 2; continue; }
    if (c === '(') {
      let m = k + 1, ok = false;
      while (m < n) {
        if (src[m] === '\\') { m += 2; continue; }
        if (src[m] === ')') { ok = true; break; }
        if (src[m] === '(') break;
        m++;
      }
      if (!ok) return -1;
      k = m + 1; continue;
    }
    k++;
  }
  return -1;
}

// If an inline construct that hides emphasis delimiters starts at src[i],
// return the index just past it; otherwise return -1.
function skipHidden(src, i, links) {
  const c = src[i];
  if (c === '\\' && i + 1 < src.length && isPunctCh(src[i + 1])) return i + 2;
  if (c === '`') {
    if (i > 0 && src[i - 1] === '`') return -1;
    const cs = matchCodeSpan(src, i);
    return cs ? cs.end : -1;
  }
  if (c === '<') {
    const h = matchBlockSkipHtml(src, i);
    return h === -1 ? -1 : h;
  }
  if (c === '[' || (c === '!' && src[i + 1] === '[')) {
    const l = matchBlockSkipLink(src, i === 0 || src[i] === '[' ? i : i + 1);
    if (l !== -1) return l;
    const rm = matchRefSearch(src, i);
    if (rm && Object.hasOwn(links, normLabel(rm.ref === '' ? rm.text : rm.ref))) {
      // A reflink whose label contains a (non-image) link is dropped by
      // makeLink, so its contents are visible to emphasis: do not skip it.
      if (!rm.isImage && linkInText(rm.text, links)) return -1;
      return rm.end;
    }
    return -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Masked source for emphasis (marked's `#n` / `fe`)
// ---------------------------------------------------------------------------
//
// marked scans for emphasis closers on a MASKED copy of the inline text,
// where link / image / code-span / html contents are replaced by
// same-length filler so their `*` / `_` / `~` cannot act as closers.
// The mask sees constructs that OPEN BEFORE the emphasis opener -- e.g. a
// code span that starts inside a link label and runs past it (doc-16:
// the backtick after `guide` opens a span that swallows `*small release
// **same***`, so marked leaves it literal; doc-28: the backtick after
// `small` opens a span that swallows `__issues most__`). A forward-only
// skip in the closer scan cannot see those, so the mask is built once
// per inline unit and the closer scan walks the mask instead. All
// replacements preserve length, so indices line up with the original.

// Pass 1 of the mask: defined reference links become `[aaa...]`
// (marked's reflinkSearch replace).
const linksNonEmptyCache = new WeakMap();
function linksNonEmpty(links) {
  let v = linksNonEmptyCache.get(links);
  if (v === undefined) {
    v = Object.keys(links).length > 0;
    linksNonEmptyCache.set(links, v);
  }
  return v;
}
function maskReflinkText(s, links) {
  if (s.indexOf('[') === -1) return s;
  let out = '', i = 0;
  const n = s.length;
  while (i < n) {
    const j = s.indexOf('[', i);
    if (j === -1) { out += s.slice(i); break; }
    // An image reflink starts at the '!' just before '['.
    const start = (j > i && s[j - 1] === '!') ? j - 1 : j;
    if (start > i) out += s.slice(i, start);
    const rm = matchRefSearch(s, start);
    if (!rm) { out += s[start]; i = start + 1; continue; }
    const m = s.slice(start, rm.end);
    const key = normLabel(rm.ref === '' ? rm.text : rm.ref);
    if (!Object.hasOwn(links, key)) { out += m; i = rm.end; continue; }
    if (rm.sep > 0 && !rm.isImage && linkInText(rm.text, links)) {
      // Label part recursively masked, ref part blanked.
      out += '[' + maskReflinkText(rm.text, links) + '][' + 'a'.repeat(m.length - rm.sep - 2) + ']';
    } else {
      out += '[' + 'a'.repeat(m.length - 2) + ']';
    }
    i = rm.end;
  }
  return out;
}

// Passes 2+3 of the mask in one forward scan (marked's
// anyPunctuationOutsideCode + blockSkip replaces): escapes become `++`,
// code spans keep their opening backticks and become `` `[aaa]` ``,
// inline links and html tags become `[aaa...]`. The scan jumps between
// interesting characters with indexOf instead of walking char by char.
function maskRest(t) {
  const n = t.length;
  let out = '';
  let i = 0;
  while (i < n) {
    // Jump to the next interesting char with native indexOf (no per-iteration
    // array allocation).
    let j = n;
    let k = t.indexOf('`', i); if (k !== -1 && k < j) j = k;
    k = t.indexOf('[', i); if (k !== -1 && k < j) j = k;
    k = t.indexOf('<', i); if (k !== -1 && k < j) j = k;
    k = t.indexOf('\\', i); if (k !== -1 && k < j) j = k;
    if (j > i) { out += t.slice(i, j); i = j; }
    if (i >= n) break;
    const c = t[i];
    if (c === '\\' && i + 1 < n && isPunctCh(t[i + 1])) { out += '++'; i += 2; continue; }
    if (c === '`') {
      const cs = matchCodeSpan(t, i);
      // blockSkip's code alternative carries a (?<!`) lookbehind: a span
      // whose opening run is immediately preceded by a backtick is NOT
      // masked (doc-04: in `` ``if`__ ... `` the `` `if` `` starting at
      // the second backtick is not a blockSkip code span, so the runaway
      // span from the backtick after `if` is what masks `__ ... **`).
      // Such a run is left literal and the scan moves on by one char.
      if (cs && (i === 0 || t[i - 1] !== '`')) {
        let k = 0;
        while (i + k < n && t[i + k] === '`') k++;
        out += t.slice(i, i + k) + '[' + 'a'.repeat(cs.end - i - k - 2) + ']';
        i = cs.end; continue;
      }
      out += c; i++; continue;
    }
    if (c === '[') {
      const l = matchBlockSkipLink(t, i);
      if (l !== -1) {
        out += '[' + 'a'.repeat(l - i - 2) + ']';
        i = l; continue;
      }
      out += c; i++; continue;
    }
    if (c === '<') {
      const h = matchBlockSkipHtml(t, i);
      if (h !== -1) {
        out += '[' + 'a'.repeat(h - i - 2) + ']';
        i = h; continue;
      }
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// The masked source for an inline unit (same length as `src`).
function maskSrc(src, links) {
  let t = src;
  if (links && linksNonEmpty(links) && t.indexOf('[') !== -1) {
    t = maskReflinkText(t, links);
  }
  return maskRest(t);
}

// Last index where a run of `ch` starts whose preceding char is not one of
// space/tab/newline/CR/FF (marked's `fe`, on the masked view of the string).
// Jumps between runs with native indexOf instead of walking char by char.
function lastCloser(msk, ch) {
  const n = msk.length;
  let last = -1;
  let i = msk.indexOf(ch);
  while (i !== -1) {
    const prev = i === 0 ? '\n' : msk[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') last = i;
    let j = i + 1;
    while (j < n && msk[j] === ch) j++;
    i = msk.indexOf(ch, j);
  }
  return last;
}

// GFM punctuation (punct except '~') and plain punctuation.
function isPunctGfm(ch) { return ch !== '~' && isPunctCh(ch); }

// Classify a delimiter run by its neighbours (the RDelim regex groups).
// Returns 0 (no group matches) or 1..6.
function classifyRun(prev, next, isPunct) {
  const prevWs = prev !== '' && isSpaceCh(prev);
  const prevPu = prev !== '' && isPunct(prev);
  const prevNps = prev !== '' && !prevWs && !prevPu;
  const nextWs = next !== '' && isSpaceCh(next);
  const nextPu = next !== '' && isPunct(next);
  const nextNps = next !== '' && !nextWs && !nextPu;
  if (prevPu && (next === '' || nextWs)) return 1;
  if (prevNps && (next === '' || nextWs || nextPu)) return 2;
  if ((prevWs || prevPu) && nextNps) return 3;
  if (prevWs && nextPu) return 4;
  if (prevPu && nextPu) return 5;
  if (prevNps && nextNps) return 6;
  return 0;
}

// The initial `__...*...__` (for '*') / `**..._...**` (for '_') skip that the
// RDelim regexes apply at the start of the search string.
// Returns the index to skip to (relative to `start`), or 0. Works on the
// masked string in place -- no slice of the tail is made.
function initialSkip(t, start, ch) {
  const other = ch === '*' ? '_' : '*';
  const n = t.length;
  let i = start;
  while (i < n && t[i] !== '*' && t[i] !== '_') i++;
  if (i + 1 >= n || t[i] !== other || t[i + 1] !== other) return 0;
  let j = i + 2;
  while (j < n && t[j] !== '*' && t[j] !== '_') j++;
  if (j >= n || t[j] !== ch) return 0;
  let k = j + 1;
  while (k < n && t[k] !== '*' && t[k] !== '_') k++;
  if (k + 1 >= n || t[k] !== other || t[k + 1] !== other) return 0;
  return k - start;
}

// Try to form emphasis/strong starting at src[i] (a run of `ch`).
// The opener and the raw match come from `src`; the closer scan walks
// the masked source `getMask()` (hidden regions are already filler
// there, so no forward skip is needed -- and a region that opened
// before the opener is hidden too). Returns {end, inner, strong} or null.
function tryEmStrong(src, i, prevChar, ch, state, links, plain, getLast, getMask, getRawLast) {
  const n = src.length;
  // Run start (we may be mid-run after a failed attempt consumed one char).
  let l = i;
  while (l > 0 && src[l - 1] === ch) l--;
  const p = l > 0 ? src[l - 1] : '';
  let nn = prevChar;
  if (l < i) nn = p;
  const o = nn === ch;
  // Run length from i, and the char after the run.
  let runFromI = 0;
  while (i + runFromI < n && src[i + runFromI] === ch) runFromI++;
  const after = i + runFromI < n ? src[i + runFromI] : '';
  // LDelim: the char after the run must be punctuation or a non-space,
  // non-delimiter char (otherwise this run cannot open).
  const isPu = ch === '~' ? isPunctCh : isPunctGfm;
  let d = '';
  if (after !== '' && isPu(after)) d = after;
  else if (after === '' || isSpaceCh(after) || after === ch) return null;
  // Gate: proceed unless the char after is punctuation, a previous char
  // exists, and that previous char is not punctuation.
  const u = nn !== '' && (isSpaceCh(nn) || isPunctCh(nn));
  const h = p === '*' || p === '_' || (p !== '' && isPunctCh(p));
  if (d !== '' && nn !== '' && !u) return null;
  if (ch === '_' && d === '' && nn !== '' && isAlnumCh(nn) && after !== '' && isAlnumCh(after)) return null;
  const k = runFromI; // opener length from i
  const y = (i - l) + k; // full run length
  const R = p !== '' && !isSpaceCh(p) && (d !== '' || (ch === '*' && !h));
  const Q = i + k;
  // The mask only hides delimiters, never reveals new ones, so if the raw
  // text has no closer run at/after the opener, the mask cannot either --
  // and the (expensive) mask need not be built for this attempt at all.
  if (getRawLast(ch) < Q) return null;
  const v = getLast(ch);
  if (v < Q) return null;
  const ee = v - Q;
  const msk = getMask();
  // Scan for closers starting just after the opener run, jumping between
  // runs of `ch` with native indexOf instead of walking char by char.
  let m = k, f = 0;
  let pos = Q;
  // Initial __ / ** skip.
  const sk0 = initialSkip(msk, Q, ch);
  if (sk0 > 0) pos = Q + sk0;
  pos = msk.indexOf(ch, pos);
  while (pos !== -1 && pos < n) {
    // A run of ch at pos.
    let runLen = 0;
    while (pos + runLen < n && msk[pos + runLen] === ch) runLen++;
    const prev = pos > 0 ? msk[pos - 1] : '';
    const next = pos + runLen < n ? msk[pos + runLen] : '';
    const group = classifyRun(prev, next, isPu);
    const sIdx = (pos - 1) - Q; // match start in t coordinates
    if (sIdx > ee) break;
    if (group === 0) { pos = msk.indexOf(ch, pos + runLen); continue; }
    if (ch === '_' && group === 6) { pos = msk.indexOf(ch, pos + runLen); continue; } // intraword _ cannot close
    if (group === 3 || group === 4) { m += runLen; pos = msk.indexOf(ch, pos + runLen); continue; }
    if (group === 5 || group === 6 || R) {
      if (o && (group === 5 || group === 6)) break;
      if (y % 3 !== 0 && (y + runLen) % 3 === 0) { f += runLen; pos = msk.indexOf(ch, pos + runLen); continue; }
    }
    m -= runLen;
    if (m > 0) { pos = msk.indexOf(ch, pos + runLen); continue; }
    let b = Math.min(runLen, runLen + m + f);
    const rawEnd = pos + b;
    const M = src.slice(i, rawEnd);
    if (Math.min(k, b) % 2 === 1) {
      return { end: rawEnd, inner: M.slice(1, -1), strong: false };
    }
    return { end: rawEnd, inner: M.slice(2, -2), strong: true };
  }
  return null;
}

// Try to form strikethrough starting at src[i] (a run of '~').
// The closer scan walks the masked source (see tryEmStrong).
// Returns {end, inner} or null.
function tryDel(src, i, prevChar, state, links, plain, getLast, getMask, getRawLast) {
  const n = src.length;
  let runLen = 0;
  while (i + runLen < n && src[i + runLen] === '~') runLen++;
  if (runLen > 2) return null;
  const after = i + runLen < n ? src[i + runLen] : '';
  let s1 = '';
  if (after !== '' && isPunctCh(after) && after !== '~') s1 = after;
  else if (after === '' || isSpaceCh(after) || after === '~') return null;
  const nn = prevChar;
  if (s1 !== '' && nn !== '' && !isSpaceCh(nn) && !isPunctCh(nn)) return null;
  const o = runLen;
  const d = i + o;
  if (getRawLast('~') < d) return null; // mask only hides delimiters (see tryEmStrong)
  const u = getLast('~');
  if (u < d) return null;
  const k = u - d;
  const msk = getMask();
  let p = o;
  let pos = msk.indexOf('~', i + o);
  while (pos !== -1 && pos < n) {
    let run = 0;
    while (pos + run < n && msk[pos + run] === '~') run++;
    const prev = pos > 0 ? msk[pos - 1] : '';
    const next = pos + run < n ? msk[pos + run] : '';
    const group = classifyRun(prev, next, isPunctCh);
    const sIdx = (pos - 1) - (i + o);
    if (sIdx > k) break;
    if (group === 0 || run !== o) { pos = msk.indexOf('~', pos + run); continue; }
    if (group === 3 || group === 4) { p += run; pos = msk.indexOf('~', pos + run); continue; }
    p -= run;
    if (p > 0) { pos = msk.indexOf('~', pos + run); continue; }
    const l = Math.min(run, run + p);
    const rawEnd = pos + l;
    const b = src.slice(i, rawEnd);
    return { end: rawEnd, inner: b.slice(o, -o) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

const ASCII_PUNCT_STR = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isAsciiPunct(c) { return ASCII_PUNCT_STR.indexOf(c) !== -1; }

const RAW_TAGS = new Set(['pre', 'code', 'kbd', 'script', 'textarea', 'style']);

// Tag name + following char of a matched tag raw string.
function tagInfo(raw) {
  let i = 1, close = false;
  if (raw.charCodeAt(1) === 47) { close = true; i = 2; }
  let j = i;
  while (j < raw.length) {
    const c = raw.charCodeAt(j);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  return { close, name: raw.slice(i, j).toLowerCase(), after: raw[j] || '' };
}

// Update inLink / inRawBlock for a matched tag (marked's tag tokenizer).
// <a + space sets inLink; </a> (no space) clears it. A raw-block tag whose
// name is exactly pre|code|kbd|script|textarea|style followed by whitespace
// or '>' opens (or closes) a raw block.
function updateTagState(raw, state) {
  const c1 = raw.charCodeAt(1);
  if (c1 === 97 || c1 === 65) {
    if (raw.charCodeAt(2) === 32) state.inLink = true;
  } else if (c1 === 47) {
    const c2 = raw.charCodeAt(2);
    if ((c2 === 97 || c2 === 65) && raw.charCodeAt(3) === 62) state.inLink = false;
  }
  const t = tagInfo(raw);
  if (!RAW_TAGS.has(t.name)) return;
  const a = t.after;
  if (a !== ' ' && a !== '\t' && a !== '\n' && a !== '\r' && a !== '\f' && a !== '>') return;
  if (!t.close) state.inRawBlock = true;
  else state.inRawBlock = false;
}

// Render a matched link / image (marked's `De`): parse the label text, drop
// a non-image link whose label already contains a link, and set
// linkEmitted for kept non-image links (so an enclosing link is dropped too).
function makeLink(m, state, links, plain) {
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  state.linkEmitted = false;
  state.inLink = true;
  const inner = parseInline(m.label, state, links, plain || m.isImage);
  const nested = state.linkEmitted;
  state.inLink = savedInLink;
  if (!m.isImage && nested) {
    state.linkEmitted = true; // a link was emitted inside; propagate out
    return null; // caller drops the outer link: only '[' stays literal
  }
  if (plain) {
    // Plain mode (image alt text): no tags, just the text. A nested image
    // contributes its alt text; a link contributes its text (cm-520).
    // A non-image link formed here still counts as a link for the outer
    // nested-link drop, so set linkEmitted instead of restoring it.
    if (!m.isImage) state.linkEmitted = true;
    else state.linkEmitted = savedEmitted;
    return inner;
  }
  if (m.isImage) {
    state.linkEmitted = savedEmitted;
    const href = cleanUrl(m.href);
    if (href === null) return escNoEnc(inner);
    let out = '<img src="' + escNoEnc(href) + '" alt="' + escNoEnc(inner) + '"';
    if (m.title) out += ' title="' + escNoEnc(m.title) + '"';
    return out + '>';
  }
  const href = cleanUrl(m.href);
  if (href === null) {
    state.linkEmitted = savedEmitted;
    return inner;
  }
  state.linkEmitted = true;
  let out = '<a href="' + escNoEnc(href) + '"';
  if (m.title) out += ' title="' + escNoEnc(m.title) + '"';
  return out + '>' + inner + '</a>';
}

// Is src[from..] all whitespace to the end?
function allWsToEnd(src, from) {
  for (let i = from; i < src.length; i++) {
    if (!isSpaceCh(src[i])) return false;
  }
  return true;
}

function isEmailLocalCh(c) {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '+' || c === '-');
}

// Find the end of a text chunk starting at `i` (the first char is always
// consumed). Stops before: \ < ![ [ ` * _ ~, hard-break starts, and URL /
// email starts (www. only after whitespace or '(', mailto:/xmpp: only after
// a non-word char, scheme anywhere, email at a local-part run start).
//
// The scan jumps between candidates with one native regex instead of
// walking char by char: plain prose has no candidate for long stretches,
// so the regex engine skips it in C. Candidates that need context (www.,
// mailto:, space runs, newlines) are validated here exactly as the old
// loop did; a bare email before the stop is found with an indexOf('@')
// sweep plus a scan back to its local-part run start (only run starts
// are ever email starts, and a run starting at or before `i` was already
// tried by parseInline, so it is skipped).
const TEXT_STOP_RE = /!\[|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:| {2,}(?=\n)|\n|[\\<\[`*_~]/g;
function scanTextEnd(src, i) {
  const n = src.length;
  TEXT_STOP_RE.lastIndex = i + 1;
  let stop = n;
  let m;
  while ((m = TEXT_STOP_RE.exec(src)) !== null) {
    const p = m.index, s = m[0];
    const c0 = s.charCodeAt(0);
    if (c0 === 32) { // run of 2+ spaces immediately before '\n'
      if (!allWsToEnd(src, p + s.length + 1)) { stop = p; break; }
      TEXT_STOP_RE.lastIndex = p + s.length + 1; // past the '\n'
      continue;
    }
    if (c0 === 10) { // '\n': hard break only if 2+ spaces precede it
      let k = p - 1, sp = 0;
      while (k > i && src.charCodeAt(k) === 32) { sp++; k--; }
      if (k === i && src.charCodeAt(k) === 32) sp++;
      if (sp >= 2 && !allWsToEnd(src, p + 1)) { stop = k + 1; break; }
      continue;
    }
    if (s === 'www.') {
      const prev = src.charCodeAt(p - 1);
      if (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12 || prev === 11 || prev === 40) { stop = p; break; }
      TEXT_STOP_RE.lastIndex = p + 1;
      continue;
    }
    if (s === 'mailto:' || s === 'xmpp:') {
      const prev = src[p - 1];
      if (!isWordCh(prev) && matchEmail(src, p + s.length) !== -1) { stop = p; break; }
      TEXT_STOP_RE.lastIndex = p + 1;
      continue;
    }
    // \ < [ ` * _ ~ ![ http:// https:// ftp:// : always a stop.
    stop = p;
    break;
  }
  // Bare email at a local-part run start before `stop`.
  let at = src.indexOf('@', i + 1);
  while (at !== -1 && at < stop) {
    let r = at;
    while (r > i && isEmailLocalCh(src[r - 1])) r--;
    if (r > i && matchEmail(src, r) !== -1) return r;
    at = src.indexOf('@', at + 1);
  }
  return stop;
}

// Match a hard break starting at src[i] (' ' run or '\' + '\n').
// Returns the index just past it (including trailing spaces/tabs), or -1.
function matchBr(src, i) {
  const n = src.length;
  let j = i;
  if (src[j] === '\\') {
    if (src[j + 1] !== '\n') return -1;
    j += 2;
  } else {
    let k = j;
    while (k < n && src[k] === ' ') k++;
    if (k - j < 2 || src[k] !== '\n') return -1;
    j = k + 1;
  }
  if (allWsToEnd(src, j)) return -1;
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  return j;
}

// Render an inline span straight to HTML. `plain` renders the span as plain
// text (image alt text): emphasis / links / code spans contribute only their
// inner text, hard breaks contribute nothing. `state` is shared across the
// recursive calls of one top-level inline render:
// {inLink, inRawBlock, linkEmitted}.
function parseInline(src, state, links, plain) {
  const n = src.length;
  const out = [];
  let i = 0;
  let prevChar = '';
  const lastCache = {};
  const rawLastCache = {};
  let maskCache = null;
  const getMask = () => {
    if (maskCache === null) {
      // Fast path: no construct that can hide a delimiter.
      if (src.indexOf('`') === -1 && src.indexOf('[') === -1 && src.indexOf('<') === -1 && src.indexOf('\\') === -1) maskCache = src;
      else maskCache = maskSrc(src, links);
    }
    return maskCache;
  };
  const getLast = (ch) => {
    let v = lastCache[ch];
    if (v === undefined) { v = lastCloser(getMask(), ch); lastCache[ch] = v; }
    return v;
  };
  // Last closer run of `ch` in the RAW text (mask-free). The mask only
  // hides delimiters, so this is an upper bound for the masked one.
  const getRawLast = (ch) => {
    let v = rawLastCache[ch];
    if (v === undefined) { v = lastCloser(src, ch); rawLastCache[ch] = v; }
    return v;
  };
  const pushText = (t) => {
    if (t === '') return;
    // Fast path: no escapable char at all means both decodeEntities and
    // escNoEnc are the identity (numeric refs always contain '&').
    if (state.inRawBlock) out.push(t);
    else if (!ESC_TEST.test(t)) out.push(t);
    else out.push(escNoEnc(decodeEntities(t)));
    const last = t[t.length - 1];
    if (last !== '_') prevChar = last;
  };
  while (i < n) {
    const c = src[i];
    // escape: backslash + ASCII punctuation
    if (c === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) {
      out.push(esc(src[i + 1]));
      i += 2; prevChar = '';
      continue;
    }
    // tag / autolink
    if (c === '<') {
      const tg = matchTag(src, i);
      if (tg !== -1) {
        const raw = src.slice(i, tg);
        updateTagState(raw, state);
        out.push(raw);
        i = tg; prevChar = '';
        continue;
      }
      const al = matchAutolink(src, i);
      if (al) {
        const href = cleanUrl(al.href);
        if (plain || href === null) out.push(esc(al.text));
        else out.push('<a href="' + esc(href) + '">' + esc(al.text) + '</a>');
        i = al.end; prevChar = '';
        continue;
      }
    }
    // link / image / reference link (any link needs a ']' ahead; without
    // one both matchers fail after scanning the label, so skip them)
    if ((c === '[' || (c === '!' && src[i + 1] === '[')) && src.indexOf(']', i) !== -1) {
      const m = matchInlineLink(src, i);
      if (m) {
        const html = makeLink(m, state, links, plain);
        if (html === null) {
          // Outer link dropped (it contains a link): only '[' stays as
          // literal text; the rest is parsed normally (cm-518, cm-520).
          out.push('[');
          i = i + 1; prevChar = '[';
          continue;
        }
        out.push(html);
        i = m.end; prevChar = '';
        continue;
      }
      const r = matchRefLink(src, i, links);
      if (r && r.found) {
        const html = makeLink(r, state, links, plain);
        if (html === null) {
          out.push('[');
          i = i + 1; prevChar = '[';
          continue;
        }
        out.push(html);
        i = r.end; prevChar = '';
        continue;
      }
    }
    // emphasis / strong
    if (c === '*' || c === '_') {
      const em = tryEmStrong(src, i, prevChar, c, state, links, plain, getLast, getMask, getRawLast);
      if (em) {
        if (plain) out.push(parseInline(em.inner, state, links, true));
        else out.push((em.strong ? '<strong>' : '<em>') + parseInline(em.inner, state, links, plain) + (em.strong ? '</strong>' : '</em>'));
        i = em.end; prevChar = '';
        continue;
      }
    }
    // code span
    if (c === '`') {
      const cs = matchCodeSpan(src, i);
      if (cs) {
        let t = cs.text.replace(/\n/g, ' ');
        if (t.length > 1 && t[0] === ' ' && t[t.length - 1] === ' ' && /[^ ]/.test(t)) t = t.slice(1, -1);
        out.push(plain ? esc(t) : '<code>' + esc(t) + '</code>');
        i = cs.end; prevChar = '';
        continue;
      }
      // No matching closer: the whole backtick run is literal text, so we
      // do not retry a code span mid-run (cm-347: ```foo`` has no closer).
      let k = i;
      while (k < n && src[k] === '`') k++;
      out.push(src.slice(i, k));
      i = k; prevChar = '`';
      continue;
    }
    // hard break
    if (c === ' ' || c === '\\') {
      const br = matchBr(src, i);
      if (br !== -1) {
        if (!plain) out.push('<br>');
        i = br; prevChar = '';
        continue;
      }
    }
    // strikethrough
    if (c === '~') {
      const d = tryDel(src, i, prevChar, state, links, plain, getLast, getMask, getRawLast);
      if (d) {
        if (plain) out.push(parseInline(d.inner, state, links, true));
        else out.push('<del>' + parseInline(d.inner, state, links, plain) + '</del>');
        i = d.end; prevChar = '';
        continue;
      }
    }
    // extended autolink (not inside a link). Only attempt when the char
    // can start a URL/email: a scheme letter, www., mailto:/xmpp:, or a
    // bare email at a word boundary (prev char not an email-local char).
    if (!state.inLink) {
      const cc = c.charCodeAt(0);
      const isUrlStart = cc === 104 || cc === 72 || cc === 102 || cc === 70 || cc === 119 || cc === 109 || cc === 120;
      let tryUrl = isUrlStart;
      if (!tryUrl) {
        const pc = prevChar === '' ? -1 : prevChar.charCodeAt(0);
        const prevLocal = pc !== -1 && ((pc >= 97 && pc <= 122) || (pc >= 65 && pc <= 90) || (pc >= 48 && pc <= 57) || pc === 46 || pc === 95 || pc === 43 || pc === 45);
        const curLocal = (cc >= 97 && cc <= 122) || (cc >= 65 && cc <= 90) || (cc >= 48 && cc <= 57) || cc === 46 || cc === 95 || cc === 43 || cc === 45;
        tryUrl = curLocal && !prevLocal;
      }
      if (tryUrl) {
        const u = matchUrl(src, i);
        if (u) {
          const href = cleanUrl(u.href);
          if (plain || href === null) out.push(esc(u.text));
          else out.push('<a href="' + esc(href) + '">' + esc(u.text) + '</a>');
          i = u.end; prevChar = '';
          continue;
        }
      }
    }
    // text
    const end = scanTextEnd(src, i);
    pushText(src.slice(i, end));
    i = end;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp('^<\\/?(?:' + BLOCK_TAGS + ')(?:[ \\t>]|\\/>|$)');
const RAW_OPEN_RE = /^<(pre|script|style|textarea)(?:[ \t>]|$)/i;

function isBlank(text) { return /^[ \t]*$/.test(text); }

// Indent of a line in columns (tabs expand to the next multiple of 4),
// and the index where the content starts.
function indentOf(text) {
  let col = 0, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, idx: i };
}

// Remove `n` columns of indentation from the start of a line (tabs expand;
// a partially consumed tab leaves spaces behind).
function stripIndent(text, n) {
  let col = 0, i = 0, out = '';
  while (i < text.length && col < n) {
    const c = text[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else { out = ' '.repeat(col + w - n); i++; col = n; break; }
    } else break;
  }
  return out + text.slice(i);
}

function expandLeadingWs(line) {
  let i = 0, col = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') col += 4 - (col % 4), i++;
    else { col++; i++; }
  }
  if (i === 0) return line;
  return ' '.repeat(col) + line.slice(i);
}

// Is this raw line a thematic break (0-3 leading spaces, then 3+ of
// -, _, or * separated by spaces/tabs)?
function isHRLine(line) {
  const { col, idx } = indentOf(line);
  if (col > 3) return false;
  const s = line.slice(idx);
  const c0 = s.charCodeAt(0);
  if (c0 !== 45 && c0 !== 95 && c0 !== 42) return false; // -, _, *
  return /^(?:-[ \t]*){3,}$/.test(s) || /^(?:_[ \t]*){3,}$/.test(s) || /^(?:\*[ \t]*){3,}$/.test(s);
}

function isSetextUnderline(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 61 && c0 !== 45) return false; // space (indent), =, -
  return /^ {0,3}(=+|-+)[ \t]*$/.test(line);
}

function isFenceStart(s) {
  const m = /^(```+|~~~+)/.exec(s);
  if (!m) return false;
  if (m[1][0] === '`' && s.slice(m[1].length).includes('`')) return false;
  return true;
}

// Does this line start an HTML block of type 1-6 (types that can interrupt
// a paragraph)? Type 7 cannot interrupt.
function isHTMLInterrupt(s) {
  if (RAW_OPEN_RE.test(s)) return true;
  if (s.startsWith('<!--') || s.startsWith('<?') || /^<![A-Za-z]/.test(s) || s.startsWith('<![CDATA[')) return true;
  if (BLOCK_TAG_RE.test(s)) return true;
  return false;
}

// Does this line start a list item that can interrupt a paragraph?
// Bullets always; ordered only when starting with 1. Empty items never do.
function isListInterrupt(s) {
  if (/^[*+-][ \t]+[^ \t]/.test(s)) return true;
  if (/^1[.)][ \t]+[^ \t]/.test(s)) return true;
  return false;
}

function interruptsParagraph(line) {
  const { col, idx } = indentOf(line);
  if (col >= 4) return false;
  const s = line.slice(idx);
  if (s === '') return false;
  const c0 = s.charCodeAt(0);
  if (c0 === 35 && /^#{1,6}(?:[ \t]+|[ \t]*$)/.test(s)) return true; // '#'
  if ((c0 === 96 || c0 === 126) && isFenceStart(s)) return true; // ` ~
  if ((c0 === 45 || c0 === 95 || c0 === 42) && isHRLine(line)) return true; // - _ *
  if (c0 === 62) return true; // '>'
  if ((c0 === 42 || c0 === 43 || c0 === 45 || (c0 >= 48 && c0 <= 57)) && isListInterrupt(s)) return true;
  if (c0 === 60 && isHTMLInterrupt(s)) return true; // '<'
  return false;
}

// Parse a list marker at the start of `line` (after indent).
// Returns null, or {indent, ordered, bullet, delim, num, markerWidth,
// afterIdx} where afterIdx is the index just past the marker.
function parseMarker(line) {
  const { col, idx } = indentOf(line);
  if (col > 3) return null;
  const s = line.slice(idx);
  let m = /^([*+-])(?:[ \t]+|$)/.exec(s);
  if (m) return { indent: col, ordered: false, bullet: m[1], delim: '', num: 0, markerWidth: 1, afterIdx: idx + 1 };
  m = /^(\d{1,9})([.)])(?:[ \t]+|$)/.exec(s);
  if (m) return { indent: col, ordered: true, bullet: '', delim: m[2], num: parseInt(m[1], 10), markerWidth: m[1].length + 1, afterIdx: idx + m[1].length + 1 };
  return null;
}

// Content indent R for a list item, and the index where the content starts.
// The whitespace run after the marker is tab-expanded (J) from the column
// just after the marker; R = indent + markerWidth + spaces (1-4 spaces),
// or +1 when 5+ spaces follow the marker (or the item is empty).
function markerContent(line, mk) {
  const base = mk.indent + mk.markerWidth;
  let k = mk.afterIdx;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  if (line.slice(k) === '') return { R: base + 1, contentIdx: k, contentPrefix: '', empty: true };
  const ws = expandTabs(line.slice(mk.afterIdx, k), base);
  const spaces = ws.length;
  if (spaces >= 5) return { R: base + 1, contentIdx: k, contentPrefix: ws.slice(1), empty: false };
  return { R: base + spaces, contentIdx: k, contentPrefix: '', empty: false };
}

// Try to match a fenced code block starting at lines[li].
function tryFenced(lines, li, src) {
  const line = lines[li].text;
  const { col, idx } = indentOf(line);
  if (col > 3) return null;
  const s = line.slice(idx);
  const m = /^(```+|~~~+)/.exec(s);
  if (!m) return null;
  const fence = m[1], ch = fence[0];
  const info = s.slice(fence.length);
  if (ch === '`' && info.includes('`')) return null;
  const closeRe = new RegExp('^' + (ch === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$');
  let end = li + 1, closed = false;
  while (end < lines.length) {
    const lt = lines[end].text;
    const ind = indentOf(lt);
    if (ind.col <= 3 && closeRe.test(lt.slice(ind.idx))) { closed = true; break; }
    end++;
  }
  const lastContent = closed ? end - 1 : lines.length - 1;
  const contentLines = [];
  // marked's indentCodeCompensation is /^(\s+)(?:```)/: it only applies
  // to BACKTICK fences. A tilde fence keeps its content lines exactly
  // as-is (doc-22/doc-29: `~~~` inside a blockquote keeps the 2-3 space
  // indent on every content line). A backtick fence strips the opening
  // fence's indent counting a tab as ONE column (unlike indented code's
  // partial-tab expansion): a leading tab is removed whole, then up to
  // `col` leading space/tab chars in total.
  for (let k = li + 1; k <= lastContent; k++) {
    const lt = lines[k].text;
    if (ch !== '`') { contentLines.push(lt); continue; }
    let i = 0;
    while (i < lt.length && i < col && (lt[i] === ' ' || lt[i] === '\t')) i++;
    contentLines.push(lt.slice(i));
  }
  const infoTrim = info.trim();
  const lang = infoTrim === '' ? '' : unescapePunct(infoTrim.split(/\s+/)[0]);
  const rawEnd = closed ? lines[end].end : src.length;
  return { token: { t: 'code', fenced: true, text: contentLines.join('\n'), lang }, nextLi: closed ? end + 1 : lines.length };
}

// Try to match an indented code block starting at lines[li].
function tryIndented(lines, li, src) {
  if (indentOf(lines[li].text).col < 4) return null;
  const contentLines = [];
  let cur = li;
  while (cur < lines.length) {
    const lt = lines[cur].text;
    if (isBlank(lt)) {
      let j = cur;
      while (j < lines.length && isBlank(lines[j].text)) j++;
      if (j < lines.length && indentOf(lines[j].text).col >= 4) {
        for (let k = cur; k < j; k++) contentLines.push(stripIndent(lines[k].text, 4));
        cur = j;
        continue;
      }
      break;
    }
    if (indentOf(lt).col < 4) break;
    contentLines.push(stripIndent(lt, 4));
    cur++;
  }
  return { token: { t: 'code', fenced: false, text: contentLines.join('\n'), lang: '' }, nextLi: cur };
}

// Try to match an ATX heading starting at lines[li].
function tryATX(lines, li, src) {
  const line = lines[li].text;
  const { col, idx } = indentOf(line);
  if (col > 3) return null;
  const s = line.slice(idx);
  const m = /^(#{1,6})(?:[ \t]+|[ \t]*$)/.exec(s);
  if (!m) return null;
  // Text after the hash run only (the space after the hashes belongs to the
  // closing-sequence check, so "### ###" closes to empty).
  let text = s.slice(m[1].length);
  text = text.replace(/[ \t]+#+[ \t]*$/, '');
  text = text.replace(/^[ \t]+|[ \t]+$/g, '');
  return { token: { t: 'heading', depth: m[1].length, text }, nextLi: li + 1 };
}

// Try to match a thematic break starting at lines[li].
function tryHR(lines, li, src) {
  if (isHRLine(lines[li].text)) {
    return { token: { t: 'hr' }, nextLi: li + 1 };
  }
  return null;
}

// Try to match an HTML block starting at lines[li].
function tryHTML(lines, li, src) {
  const line = lines[li].text;
  const { col, idx } = indentOf(line);
  if (col > 3) return null;
  const s = line.slice(idx);
  // Raw text runs to the end of `last` (whole line) plus any following
  // truly-empty lines, so `ge` can trim a trailing blank line (cm-183).
  // A whitespace-only line (tab/spaces) after the end construct is NOT
  // consumed: the trailing newline is kept (doc-15: `-->\n` + tab line).
  // `nextLi` is the line after the last empty line included.
  const rawTo = (last) => {
    let e = last;
    while (e + 1 < lines.length && lines[e + 1].text === '') e++;
    return { text: trimBlankTail(src.slice(lines[li].start, lines[e].end)), nextLi: e + 1 };
  };
  // Type 1: pre | script | style | textarea — ends at the matching end tag.
  let m = /^<(pre|script|style|textarea)(?:[ \t>]|$)/i.exec(s);
  if (m) {
    const tag = m[1].toLowerCase();
    const endRe = new RegExp('</' + tag + '\\s*>', 'i');
    let end = li, found = false;
    while (end < lines.length) {
      if (endRe.test(lines[end].text)) { found = true; break; }
      end++;
    }
    if (!found) {
      const last = lines.length - 1;
      return { token: { t: 'html', text: trimBlankTail(src.slice(lines[li].start, lines[last].end)) }, nextLi: last + 1 };
    }
    const r = rawTo(end);
    return { token: { t: 'html', text: r.text }, nextLi: r.nextLi };
  }
  // Type 2: comment — ends at -->.
  if (s.startsWith('<!--')) {
    let end = li, found = false;
    while (end < lines.length) {
      if (lines[end].text.includes('-->')) { found = true; break; }
      end++;
    }
    if (!found) {
      const last = lines.length - 1;
      return { token: { t: 'html', text: trimBlankTail(src.slice(lines[li].start, lines[last].end)) }, nextLi: last + 1 };
    }
    const r = rawTo(end);
    return { token: { t: 'html', text: r.text }, nextLi: r.nextLi };
  }
  // Type 3: processing instruction — ends at ?>.
  if (s.startsWith('<?')) {
    let end = li, found = false;
    while (end < lines.length) {
      if (lines[end].text.includes('?>')) { found = true; break; }
      end++;
    }
    if (!found) {
      const last = lines.length - 1;
      return { token: { t: 'html', text: trimBlankTail(src.slice(lines[li].start, lines[last].end)) }, nextLi: last + 1 };
    }
    const r = rawTo(end);
    return { token: { t: 'html', text: r.text }, nextLi: r.nextLi };
  }
  // Type 4: declaration <! + letter — ends at >.
  if (/^<![A-Za-z]/.test(s)) {
    let end = li, found = false;
    while (end < lines.length) {
      if (lines[end].text.includes('>')) { found = true; break; }
      end++;
    }
    if (!found) {
      const last = lines.length - 1;
      return { token: { t: 'html', text: trimBlankTail(src.slice(lines[li].start, lines[last].end)) }, nextLi: last + 1 };
    }
    const r = rawTo(end);
    return { token: { t: 'html', text: r.text }, nextLi: r.nextLi };
  }
  // Type 5: CDATA — ends at ]]>.
  if (s.startsWith('<![CDATA[')) {
    let end = li, found = false;
    while (end < lines.length) {
      if (lines[end].text.includes(']]>')) { found = true; break; }
      end++;
    }
    if (!found) {
      const last = lines.length - 1;
      return { token: { t: 'html', text: trimBlankTail(src.slice(lines[li].start, lines[last].end)) }, nextLi: last + 1 };
    }
    const r = rawTo(end);
    return { token: { t: 'html', text: r.text }, nextLi: r.nextLi };
  }
  // Types 6 and 7: consume until a blank line (the blank line is included
  // in the raw so `ge` can trim it).
  const untilBlank = () => {
    let end = li;
    while (end < lines.length && !isBlank(lines[end].text)) end++;
    const rawEnd = end < lines.length ? lines[end].end : lines[lines.length - 1].end;
    return { raw: src.slice(lines[li].start, rawEnd), nextLi: end + (end < lines.length ? 1 : 0) };
  };
  if (BLOCK_TAG_RE.test(s)) {
    const r = untilBlank();
    return { token: { t: 'html', text: trimBlankTail(r.raw) }, nextLi: r.nextLi };
  }
  // Type 7: a complete tag alone on the line (not a pre/script/style/textarea open tag).
  const tm = matchTag(s, 0);
  if (tm !== -1 && /^[ \t]*$/.test(s.slice(tm))) {
    const info = tagInfo(s.slice(0, tm));
    if (info.close || !RAW_TAGS.has(info.name)) {
      const r = untilBlank();
      return { token: { t: 'html', text: trimBlankTail(r.raw) }, nextLi: r.nextLi };
    }
  }
  return null;
}

// Try to match a link reference definition starting at lines[li].
// Registers it in `links` (first wins) and returns a def token.
function tryDef(lines, li, src, links) {
  const line = lines[li].text;
  const { col, idx } = indentOf(line);
  if (col > 3) return null;
  const s = line.slice(idx);
  if (!s.startsWith('[')) return null;
  const base = lines[li].start + idx; // src offset of '['
  // The label may span lines (cm-208), so scan it in the raw source.
  const labelEnd = scanLabel(src, base + 1);
  if (labelEnd === -1) return null;
  const labelText = src.slice(base + 1, labelEnd);
  if (/\n[ \t]*\n/.test(labelText)) return null;
  // A def label cannot contain unescaped [ or ] (marked's def regex), and
  // cannot be empty or whitespace-only (cm-547/548/551/552/590).
  if (normLabel(labelText) === '') return null;
  for (let c = 0; c < labelText.length; c++) {
    if (labelText[c] === '\\') { c++; continue; }
    if (labelText[c] === '[' || labelText[c] === ']') return null;
  }
  let p = labelEnd + 1; // just past ']'
  if (src[p] !== ':') return null;
  p++;
  // Skip spaces/tabs; the dest may sit on the next line.
  let q = p;
  while (q < src.length && (src[q] === ' ' || src[q] === '\t')) q++;
  if (src[q] === '\n') {
    let r = q + 1;
    while (r < src.length && (src[r] === ' ' || src[r] === '\t')) r++;
    if (r >= src.length || src[r] === '\n') return null;
    q = r;
  }
  // Parse the dest (single line only).
  let dest = '', destEnd = q;
  if (src[q] === '<') {
    let k = q + 1;
    while (k < src.length && src[k] !== '>' && src[k] !== '<' && src[k] !== '\n') k++;
    if (k >= src.length || src[k] !== '>') return null;
    dest = src.slice(q + 1, k);
    destEnd = k + 1;
  } else {
    let k = q, depth = 0;
    while (k < src.length) {
      const c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      if (c === '\\') { k += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth < 0) break; }
      k++;
    }
    if (depth !== 0) return null;
    dest = src.slice(q, k);
    destEnd = k;
    if (dest === '') return null;
  }
  // Optional title: must be preceded by whitespace (spaces, or a newline
  // so it can sit on the next line). A title right after the dest with no
  // whitespace is not a title, so the def fails (cm-201).
  let title = '', endPos = destEnd;
  let k = destEnd, hadWs = false;
  while (k < src.length && (src[k] === ' ' || src[k] === '\t')) { k++; hadWs = true; }
  if (k >= src.length) {
    endPos = k;
  } else if (src[k] === '\n') {
    let r = k + 1;
    while (r < src.length && (src[r] === ' ' || src[r] === '\t')) r++;
    if (r < src.length && src[r] !== '\n') {
      const tp = parseTitle(src, r);
      if (tp) {
        let m2 = tp.end;
        while (m2 < src.length && (src[m2] === ' ' || src[m2] === '\t')) m2++;
        if (m2 >= src.length || src[m2] === '\n') { title = tp.title; endPos = m2; }
        else endPos = k; // title followed by junk: no title, def ends at dest
      } else {
        endPos = k;
      }
    } else {
      endPos = k;
    }
  } else {
    if (!hadWs) return null;
    const tp = parseTitle(src, k);
    if (!tp) return null;
    let m2 = tp.end;
    while (m2 < src.length && (src[m2] === ' ' || src[m2] === '\t')) m2++;
    if (m2 < src.length && src[m2] !== '\n') return null;
    title = tp.title;
    endPos = m2;
  }
  const label = labelText;
  const key = normLabel(label);
  if (!Object.hasOwn(links, key)) {
    links[key] = { href: unescapePunct(dest), title: title ? unescapePunct(title) : '' };
  }
  // The def ends on the first line whose end is past endPos.
  let nextLi = li;
  if (endPos >= src.length) nextLi = lines.length;
  else {
    while (nextLi < lines.length && lines[nextLi].end <= endPos) nextLi++;
    nextLi = nextLi + 1;
  }
  if (nextLi > lines.length) nextLi = lines.length;
  return { token: { t: 'def' }, nextLi };
}

// Try to match a GFM table starting at lines[li].
function tryTable(lines, li, src) {
  if (li + 1 >= lines.length) return null;
  if (indentOf(lines[li].text).col > 3 || indentOf(lines[li + 1].text).col > 3) return null;
  const delimLine = lines[li + 1].text;
  const dParts = delimLine.split('|');
  if (dParts.length > 0 && dParts[0].trim() === '') dParts.shift();
  if (dParts.length > 0 && dParts[dParts.length - 1].trim() === '') dParts.pop();
  if (dParts.length === 0) return null;
  const aligns = [];
  let hasPipe = delimLine.includes('|'), hasColon = false;
  for (const part of dParts) {
    const c = part.trim();
    const mm = /^(:?)-+(:?)$/.exec(c);
    if (!mm) return null;
    if (mm[1] === ':' || mm[2] === ':') hasColon = true;
    aligns.push(mm[1] === ':' && mm[2] === ':' ? 'center' : mm[1] === ':' ? 'left' : mm[2] === ':' ? 'right' : null);
  }
  if (!hasPipe && !hasColon) return null; // otherwise it is a setext underline
  const header = splitCells(lines[li].text);
  if (aligns.length !== header.length) return null; // gfm-203: delimiter must match header cell count
  const rows = [];
  let cur = li + 2;
  while (cur < lines.length) {
    const lt = lines[cur].text;
    if (isBlank(lt)) {
      // A whitespace-only line containing a tab is a table row of empty
      // cells (the table continues); a spaces-only or empty line ends it.
      // A trailing tab line at EOF (no newline after) is trimmed, not a row.
      if (lt.includes('\t') && !(cur === lines.length - 1 && !src.endsWith('\n'))) {
        rows.push(splitCells(lt, header.length));
        cur++;
        continue;
      }
      break;
    }
    if (indentOf(lt).col >= 4) break;
    if (interruptsParagraph(lt)) break;
    rows.push(splitCells(lt, header.length));
    cur++;
  }
  return { token: { t: 'table', header, align: aligns, rows }, nextLi: cur };
}

// Lex a paragraph (or a setext heading) starting at lines[li].
function lexParagraph(lines, li, src, top = true) {
  const textLines = [lines[li].text];
  let cur = li + 1;
  // A whitespace-only line breaks a paragraph, unless it is the last line
  // and the source does not end with a newline: then the paragraph regex's
  // `[ \t]+\n` exclusion does not apply and it is a continuation (cm-241).
  const srcEndsNL = src.length > 0 && src[src.length - 1] === '\n';
  while (cur < lines.length) {
    const lt = lines[cur].text;
    if (isBlank(lt)) {
      if (cur === lines.length - 1 && !srcEndsNL) {
        textLines.push(lt);
        cur++;
        continue;
      }
      break;
    }
    if (isSetextUnderline(lt)) {
      const depth = lt.trim()[0] === '=' ? 1 : 2;
      const htext = textLines.join('\n').replace(/^[ \t]+|[ \t]+$/g, '');
      return { token: { t: 'heading', depth, text: htext }, nextLi: cur + 1 };
    }
    if (interruptsParagraph(lt)) break;
    // Inside a list item (top=false) a paragraph is single-line (marked's
    // text tokenizer): any list marker starts a new block (doc-09/10/11/02:
    // 0., 0), 63480., 49. inside a list item are nested lists).
    if (!top && parseMarker(lt)) break;
    // Inside a list item (top=false) a line indented 4+ is indented code,
    // not a paragraph continuation: stop so it is lexed as code and merged
    // into the paragraph (marked's code-merging, cm-291/cm-312).
    if (!top && indentOf(lt).col >= 4) break;
    textLines.push(lt);
    cur++;
  }
  return { token: { t: 'paragraph', text: textLines.join('\n') }, nextLi: cur };
}

// Does this token list end with an open paragraph (a paragraph/text token,
// or a blockquote/list whose last token does)? Used for lazy continuations,
// which can continue a paragraph nested inside blockquotes/lists.
function endsWithOpenParagraph(tokens) {
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1];
  if (last.t === 'paragraph' || last.t === 'text') return true;
  if (last.t === 'blockquote') return endsWithOpenParagraph(last.tokens);
  if (last.t === 'list' && last.items.length > 0) {
    return endsWithOpenParagraph(last.items[last.items.length - 1].tokens);
  }
  return false;
}

// Is `lt` a lazy paragraph continuation inside a blockquote/list item whose
// content so far is `contentLines`? The content must end with an open
// paragraph, and the line must not start an interrupting block.
function isLazyContinuation(contentLines, lt, links, top = true) {
  if (contentLines.length === 0) return false;
  if (contentLines[contentLines.length - 1] === '') return false;
  const toks = lexBlocks(contentLines.join('\n'), links, top);
  if (!endsWithOpenParagraph(toks)) return false;
  if (interruptsParagraph(lt)) return false;
  return true;
}

// Merge one chunk's tokens into a blockquote's token list, following marked:
// a paragraph/text or indented-code chunk that follows a paragraph/text
// merges into it (its text appended with '\n'); anything else is appended.
function mergeChunkTokens(acc, chunkTokens) {
  for (let k = 0; k < chunkTokens.length; k++) {
    const tk = chunkTokens[k];
    const last = acc[acc.length - 1];
    if (k === 0 && last && (last.t === 'paragraph' || last.t === 'text')) {
      if (tk.t === 'paragraph' || tk.t === 'text') {
        last.text += '\n' + tk.text;
        continue;
      }
      if (tk.t === 'code' && !tk.fenced) {
        last.text += '\n' + tk.text;
        continue;
      }
    }
    acc.push(tk);
  }
}

// Strip a blockquote '>' marker (0-3 leading spaces, '>', then one optional
// space, with the whitespace after '>' tab-expanded from the column after '>').
function stripBQPrefix(line) {
  const { col, idx } = indentOf(line);
  let j = idx + 1, k = j;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  if (k === j) return line.slice(j);
  return expandTabs(line.slice(j, k), col + 1).slice(1) + line.slice(k);
}

// Lex a blockquote starting at lines[li].
function lexBlockquote(lines, li, src, links) {
  const tokens = [];
  let cur = li;
  // Chunks: a chunk is lazy lines (before any '>' line) then '>' lines. A
  // lazy line after a '>' line starts a new chunk, which is lexed separately
  // and merged into the accumulated tokens (paragraph/code merging).
  let chunkLines = [];
  let chunkHasGT = false;
  const flushChunk = () => {
    if (chunkLines.length === 0) return;
    // Indent setext-like lines that follow a newline by 4 spaces, so a lazy
    // setext line stays paragraph text (blockquoteSetextReplace).
    const h = chunkLines.join('\n');
    const u = h.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    mergeChunkTokens(tokens, lexBlocks(u, links));
    chunkLines = [];
    chunkHasGT = false;
  };
  while (cur < lines.length) {
    const lt = lines[cur].text;
    const m = /^ {0,3}>/.exec(lt);
    if (m) {
      chunkLines.push(stripBQPrefix(lt));
      chunkHasGT = true;
      cur++;
      continue;
    }
    if (isBlank(lt)) break; // a truly blank line ends the blockquote
    if (!isLazyContinuation(chunkLines, lt, links)) break;
    if (chunkHasGT && indentOf(lt).col >= 4) {
      // A lazy line indented 4+ is indented code: it starts a new chunk so
      // it is lexed as code and merged into the paragraph (cm-238).
      flushChunk();
      chunkLines.push(lt);
    } else {
      // Otherwise the lazy line joins the current chunk, so it propagates
      // into nested blockquotes when re-lexed (cm-250).
      chunkLines.push(lt);
    }
    cur++;
  }
  flushChunk();
  return { token: { t: 'blockquote', tokens }, nextLi: cur };
}

// Is there an unclosed fenced code block at the end of these (already
// content-stripped) lines? Used by lexList so a fence's content lines,
// which may have any indent (even 0), stay part of the list item.
function stripFenceIndent(lt, n) {
  let i = 0;
  while (i < lt.length && i < n && lt[i] === ' ') i++;
  return lt.slice(i);
}

// Lex a list starting at lines[li].
function lexList(lines, li, src, links) {
  const first = parseMarker(lines[li].text);
  if (!first) return null;
  const ordered = first.ordered;
  const items = [];
  let loose = false;
  let cur = li;
  while (cur < lines.length) {
    const mk = parseMarker(lines[cur].text);
    if (!mk || mk.ordered !== ordered || (ordered ? mk.delim !== first.delim : mk.bullet !== first.bullet)) break;
    if (isHRLine(lines[cur].text)) break;
    const mc = markerContent(lines[cur].text, mk);
    const R = mc.R;
    const itemLines = [mc.empty ? '' : (mc.contentPrefix || '') + lines[cur].text.slice(mc.contentIdx)];
    cur++;
    // An empty item followed by a blank line ends immediately (marked skips
    // the continuation loop); the blank line is consumed (cm-280). If a
    // same-kind item follows, the blank line separates two items: loose.
    let skipContinuation = false;
    if (mc.empty && cur < lines.length && isBlank(lines[cur].text)) {
      cur++;
      skipContinuation = true;
      if (cur < lines.length) {
        const nm2 = parseMarker(lines[cur].text);
        if (nm2 && nm2.ordered === ordered && (ordered ? nm2.delim === first.delim : nm2.bullet === first.bullet) && nm2.indent <= 3) loose = true;
      }
    }
    // Incremental fence tracking for this item: scanning the whole
    // item on every line is O(n^2); instead scan each pushed line once.
    let fenceOpen = null; // {ch, len, openIdx} or null
    let fenceScanned = 0;
    const fenceStatus = () => {
      for (; fenceScanned < itemLines.length; fenceScanned++) {
        const fl = itemLines[fenceScanned];
        const m = /^( {0,3})(`{3,}|~{3,})/.exec(fl);
        if (!m) continue;
        const ch = m[2][0], len = m[2].length;
        const rest = fl.slice(m[0].length);
        if (!fenceOpen) {
          if (ch === '`' && rest.includes('`')) continue;
          fenceOpen = { ch, len, openIdx: fenceScanned };
        } else if (ch === fenceOpen.ch && len >= fenceOpen.len && /^[ \t]*$/.test(rest)) {
          fenceOpen = null;
        }
      }
      if (!fenceOpen) return null;
      // A fence that just opened (no content line yet) captures nothing
      // (doc-17); once it has a content line it captures every line,
      // even at indent 0 (doc-02).
      return { hasContent: itemLines.length - 1 > fenceOpen.openIdx };
    };
    // Collect the item's remaining lines.
    while (!skipContinuation && cur < lines.length) {
      const lt = lines[cur].text;
      if (isBlank(lt)) {
        let j = cur;
        while (j < lines.length && isBlank(lines[j].text)) j++;
        if (j >= lines.length) { cur = j; break; }
        const nextLine = lines[j].text;
        const Zn = expandLeadingWs(nextLine);
        if (Zn.search(/[^ ]/) >= R) {
          for (let k = cur; k < j; k++) itemLines.push('');
          itemLines.push(Zn.slice(R));
          cur = j + 1;
          continue;
        }
        const nm = parseMarker(nextLine);
        if (nm && nm.ordered === ordered && (ordered ? nm.delim === first.delim : nm.bullet === first.bullet) && nm.indent <= 3) {
          loose = true;
          cur = j;
          break;
        }
        // The blank line is not part of this item and does not separate two
        // items: leave it for the outer lexer so it becomes a space token
        // (which is what makes the enclosing list loose, cm-325).
        break;
      }
      const Z = expandLeadingWs(lt);
      if (Z.search(/[^ ]/) >= R) {
        itemLines.push(Z.slice(R));
        cur++;
        continue;
      }
      // A fenced code block's content lines may have any indent (even 0),
      // but only once the fence already has a content line (doc-02); a
      // fence that just opened captures nothing (doc-17).
      const uf = fenceStatus();
      if (uf && uf.hasContent) {
        itemLines.push(lt);
        cur++;
        continue;
      }
      const nm = parseMarker(lt);
      if (nm && nm.ordered === ordered && (ordered ? nm.delim === first.delim : nm.bullet === first.bullet) && nm.indent <= 3) break;
      if (parseMarker(lt)) break; // any list marker ends the item (cm-302)
      if (isLazyContinuation(itemLines, lt, links, false)) {
        // A lazy line that looks like a setext underline is indented by 4
        // spaces so it stays paragraph text.
        const sm = /^ {0,3}((?:=+|-+)[ \t]*)$/.exec(lt);
        itemLines.push(sm ? '    ' + sm[1] : lt);
        cur++;
        continue;
      }
      break;
    }
    const contentSrc = itemLines.join('\n');
    const itemTokens = lexBlocks(contentSrc, links, false);
    let task = false, checked = false;
    if (itemTokens.length > 0 && (itemTokens[0].t === 'paragraph' || itemTokens[0].t === 'text')) {
      const tm = /^\[[ xX]\](?:[ \t]+|\n[ \t]*|$)/.exec(itemTokens[0].text);
      if (tm) {
        task = true;
        checked = itemTokens[0].text[1] === 'x' || itemTokens[0].text[1] === 'X';
        itemTokens[0].text = itemTokens[0].text.slice(tm[0].length);
      }
    }
    for (let k = 0; k + 1 < itemTokens.length; k++) {
      if (itemTokens[k].t === 'space') {
        let hasBefore = false, hasAfter = false;
        for (let a = 0; a < k; a++) if (itemTokens[a].t !== 'space') { hasBefore = true; break; }
        for (let a = k + 1; a < itemTokens.length; a++) if (itemTokens[a].t !== 'space') { hasAfter = true; break; }
        if (hasBefore && hasAfter) { loose = true; break; }
      }
    }
    items.push({ tokens: itemTokens, task, checked });
    if (cur >= lines.length) break;
    const nm2 = parseMarker(lines[cur].text);
    if (!nm2 || nm2.ordered !== ordered || (ordered ? nm2.delim !== first.delim : nm2.bullet !== first.bullet) || nm2.indent > 3) break;
  }
  if (!loose) {
    for (const it of items) {
      for (const tk of it.tokens) if (tk.t === 'paragraph') tk.t = 'text';
    }
  }
  return { token: { t: 'list', ordered, start: ordered ? first.num : null, loose, items }, nextLi: cur };
}

// Main block lexer: turns a source string into a token list, collecting
// link reference definitions into `links`. `top` is false inside list items
// (marked's state.top), where a paragraph is single-line and indented code
// merges into a preceding paragraph.
function lexBlocks(src, links, top = true) {
  const lines = [];
  let p = 0;
  while (p < src.length) {
    const nl = src.indexOf('\n', p);
    if (nl === -1) { lines.push({ text: src.slice(p), start: p, end: src.length }); break; }
    lines.push({ text: src.slice(p, nl), start: p, end: nl + 1 });
    p = nl + 1;
  }
  const tokens = [];
  let li = 0;
  while (li < lines.length) {
    const line = lines[li].text;
    if (isBlank(line)) {
      let end = li;
      while (end < lines.length && isBlank(lines[end].text)) end++;
      tokens.push({ t: 'space', raw: src.slice(lines[li].start, lines[end - 1].end) });
      li = end;
      continue;
    }
    let r = tryFenced(lines, li, src) || tryIndented(lines, li, src) || tryATX(lines, li, src) || tryHR(lines, li, src);
    if (!r && /^ {0,3}>/.test(line)) r = lexBlockquote(lines, li, src, links);
    if (!r) r = lexList(lines, li, src, links);
    if (!r) r = tryHTML(lines, li, src);
    if (!r) r = tryDef(lines, li, src, links);
    if (!r) r = tryTable(lines, li, src);
    if (!r) r = lexParagraph(lines, li, src, top);
    // An indented code block that immediately follows a paragraph/text
    // merges into it (its text appended with '\n'), it is not a code block.
    if (r.token.t === 'code' && !r.token.fenced) {
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.text += '\n' + r.token.text;
        li = r.nextLi;
        continue;
      }
    }
    tokens.push(r.token);
    li = r.nextLi;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// Render one inline span with a fresh state (inRawBlock reset per span;
// inLink is shared document-wide through `doc`).
function inline(text, links, doc) {
  const state = { inLink: doc.inLink, inRawBlock: false, linkEmitted: false };
  const out = parseInline(text, state, links, false);
  doc.inLink = state.inLink;
  return out;
}

function renderToken(tk, links, doc) {
  switch (tk.t) {
    case 'space': case 'def': return '';
    case 'code': {
      const langAttr = tk.lang ? ' class="language-' + escNoEnc(tk.lang) + '"' : '';
      let text = tk.text;
      if (text !== '' && !text.endsWith('\n')) text += '\n';
      return '<pre><code' + langAttr + '>' + esc(text) + '</code></pre>\n';
    }
    case 'heading':
      return '<h' + tk.depth + '>' + inline(tk.text, links, doc) + '</h' + tk.depth + '>\n';
    case 'hr': return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(tk.tokens, links, doc) + '</blockquote>\n';
    case 'list': {
      const tag = tk.ordered ? 'ol' : 'ul';
      const startAttr = tk.ordered && tk.start !== 1 ? ' start="' + tk.start + '"' : '';
      let out = '<' + tag + startAttr + '>\n';
      for (const it of tk.items) {
        out += '<li>';
        const cb = it.task ? '<input' + (it.checked ? ' checked=""' : '') + ' disabled="" type="checkbox">' : '';
        let first = true;
        for (const t2 of it.tokens) {
          if (first && it.task && (t2.t === 'paragraph' || t2.t === 'text')) {
            out += t2.t === 'paragraph'
              ? '<p>' + cb + ' ' + inline(t2.text, links, doc) + '</p>\n'
              : cb + ' ' + inline(t2.text, links, doc);
            first = false;
          } else if (first && it.task) {
            out += cb + ' ' + renderToken(t2, links, doc);
            first = false;
          } else {
            out += renderToken(t2, links, doc);
          }
        }
        out += '</li>\n';
      }
      return out + '</' + tag + '>\n';
    }
    case 'html': return tk.text;
    case 'table': {
      const alignAttr = (a) => a ? ' align="' + a + '"' : '';
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < tk.header.length; c++) {
        out += '<th' + alignAttr(tk.align[c]) + '>' + inline(tk.header[c], links, doc) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (tk.rows.length > 0) {
        out += '<tbody>';
        for (const row of tk.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            out += '<td' + alignAttr(tk.align[c]) + '>' + inline(row[c], links, doc) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    case 'paragraph':
      return '<p>' + inline(tk.text, links, doc) + '</p>\n';
    case 'text':
      return inline(tk.text, links, doc);
    default: return '';
  }
}

function renderBlocks(tokens, links, doc) {
  let out = '';
  for (const tk of tokens) out += renderToken(tk, links, doc);
  return out;
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const links = {};
  const doc = { inLink: false };
  const tokens = lexBlocks(src, links);
  return renderBlocks(tokens, links, doc);
}
