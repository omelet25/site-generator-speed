// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns for the same input — every path it
// writes and that file's text, byte for byte — written as one dependency-free ES module. The build is a straight-line
// pipeline over the case in hand: sources sorted and read, front matter parsed, permalinks assigned, Markdown
// rendered, collections and tags built, every page laid out, statics placed and the report written. All state lives
// inside one run() call; nothing is kept from one case to the next.
//
// Where the reference walks text a character at a time through small helpers, this module scans with index-based
// loops, bulk-copies plain runs, compiles each template to a JavaScript function once per case and counts words
// without allocating them. The dialect itself — front matter, Markdown subset, slug rule, template language, report —
// is makefun-site's own, implemented here rule for rule.

/* ------------------------------------------------------------------ text */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ANY_ESCAPE_RE = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ANY_ESCAPE_RE.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

const NON_ASCII_RE = /[^\x00-\x7F]/;
const MARKS_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII text is already NFKD-invariant and holds no combining marks, so it skips the normaliser.
 */
function slugifyRaw(text) {
  const plain = NON_ASCII_RE.test(text) ? text.normalize('NFKD').replace(MARKS_RE, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      if (gap) out += '-';
      gap = false;
      out += plain[i];
    } else if (code >= 65 && code <= 90) {
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(code + 32);
    } else {
      gap = out.length > 0;
    }
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, 63);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a code unit is JavaScript whitespace (the \s class), for word counting and link targets. */
function isWsCode(code) {
  if (code > 32) {
    if (code < 128) return false;
    return (
      code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
      code === 0x3000 || code === 0xfeff
    );
  }
  return code === 32 || (code >= 9 && code <= 13);
}

/** The number of words in `text`: its runs of characters other than whitespace, counted without allocating them. */
function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/* ------------------------------------------------------------ front matter */

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a slug: a-z and 0-9, single "-" between. */
function isSlugText(raw) {
  let seg = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) seg++;
    else if (code === 45) {
      if (seg === 0) return false;
      seg = 0;
    } else return false;
  }
  return seg > 0;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const code = raw.charCodeAt(i);
          if (code < 48 || code > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        if (!((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug':
      return raw.length <= 64 && isSlugText(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The lines are scanned in place; the body is the text after the closing line, never re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  const fmLines = [];
  let bodyStart = -1;
  if (text !== '---') {
    let pos = 4;
    while (pos <= text.length) {
      const nl = text.indexOf('\n', pos);
      const end = nl === -1 ? text.length : nl;
      if (text.slice(pos, end) === '---') {
        bodyStart = nl === -1 ? text.length : nl + 1;
        break;
      }
      fmLines.push(text.slice(pos, end));
      if (nl === -1) break;
      pos = nl + 1;
    }
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const code = line.charCodeAt(k);
      if ((code >= 97 && code <= 122) || code === 95) k++;
      else break;
    }
    let raw;
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

/* --------------------------------------------------------------- markdown */

/** The language of a fence opening line ("" when it has none), or null when `line` opens no fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const code = line.charCodeAt(j);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 43 || code === 45) j++;
    else break;
  }
  const langEnd = j;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else return null;
  }
  return line.slice(3, langEnd);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let j = 0;
  while (line.charCodeAt(j) === 35) j++;
  if (j === 0 || j > 6) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let start = j;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === start) return null;
  return { depth: j, text: line.slice(start, end) };
}

/** Whether `line` is a thematic break: "---" or "***", then spaces or tabs only. */
function isHR(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const code = line.charCodeAt(j);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

/** A bullet item's text (after "- " or "* "), or null when `line` opens no bullet item. */
function bulletText(line) {
  const a = line.charCodeAt(0);
  return (a === 45 || a === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item's number and text (after "N. "), or null when `line` opens no ordered item. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const code = line.charCodeAt(j);
    if (code >= 48 && code <= 57) j++;
    else break;
  }
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWsCode(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Code units that need work inline: the Markdown specials and the HTML-escapable characters. */
const INTEREST = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '[', '&', '<', '>', '"', "'"]) INTEREST[ch.charCodeAt(0)] = 1;

/** The first index in [from, hi) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds a whitespace character (the \s class). */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * `s` in [lo, hi) rendered inline, appended to `out`; `link(target)` is a link's href. Plain runs between special
 * characters are copied whole: none of them holds a character the escaper would change.
 */
function inlineInto(s, lo, hi, link, out) {
  let i = lo;
  let run = lo;
  const flush = (end) => {
    if (end > run) out.push(s.slice(run, end));
  };
  while (i < hi) {
    const code = s.charCodeAt(i);
    if (code >= 128 || INTEREST[code] === 0) {
      i++;
      continue;
    }
    const c = s[i];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      flush(i);
      out.push(ESCAPES[c]);
      i++;
      run = i;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      let j = s.indexOf('`', i + 1);
      if (j >= hi) j = -1;
      if (j > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1, hi);
        if (j > i + 1) {
          flush(i);
          out.push('<em>');
          inlineInto(s, i + 1, j, link, out);
          out.push('</em>');
          i = j + 1;
          run = i;
        } else i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1, hi);
    let m = -1;
    if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
      m = s.indexOf(')', k + 2);
      if (m >= hi) m = -1;
    }
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWs(target)) {
      flush(i);
      out.push('<a href="', escapeHtml(link(target)), '">');
      inlineInto(s, i + 1, k, link, out);
      out.push('</a>');
      i = m + 1;
      run = i;
    } else i++;
  }
  flush(hi);
}

/** `s` rendered inline; `link(target)` is a link's href. */
function renderInline(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block followed by "\n"), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * `slugify` is the caller's per-case cached slug rule, for heading ids.
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        const bodyStart = i;
        while (i < n && !fenceClose(lines[i])) i++;
        let block = `<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>`;
        for (let k = bodyStart; k < i; k++) block += `${escapeHtml(lines[k])}\n`;
        blocks.push(`${block}</code></pre>`);
        i++;
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = renderInline(h.text, link);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let s = lines[i].slice(1);
        if (s.charCodeAt(0) === 32) s = s.slice(1);
        const t = trimLine(s);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${renderInline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    let bullet = null;
    let ord = null;
    if (c0 === 45 || c0 === 42) bullet = bulletText(line);
    else if (c0 >= 48 && c0 <= 57) ord = orderedOf(line);
    if (bullet !== null || ord !== null) {
      const isOrd = ord !== null;
      const start = isOrd ? ord.num : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        let cap = null;
        if (isOrd) {
          const o = orderedOf(l);
          if (o !== null) cap = o.text;
        } else cap = bulletText(l);
        if (cap !== null) {
          items.push([trimLine(cap)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      let block = `${isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`}\n`;
      for (const parts of items) block += `<li>${renderInline(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${block}</${tag}>`);
      continue;
    }
    const bodyLines = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      bodyLines.push(trimLine(lines[i]));
      i++;
    }
    const html = renderInline(bodyLines.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

/* -------------------------------------------------------------- templates */

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function resolveScope(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** An include, rendered into `out`: the named template in the same scope, at most INCLUDE_DEPTH deep. */
function includeRender(out, scope, ctx, depth, name) {
  const t = ctx.tpl.get(name);
  if (t !== undefined && depth < INCLUDE_DEPTH) t(out, scope, ctx, depth + 1);
}

/** The node walker: renders `nodes` into `out`. The compiler's fallback, and its semantic reference. */
function walkNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(resolveScope(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(resolveScope(scope, n.path)));
        break;
      case 'if': {
        const branch = truthy(resolveScope(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) walkNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = resolveScope(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          walkNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include':
        includeRender(out, scope, ctx, depth, n.name);
        break;
    }
  }
}

/**
 * A template's nodes compiled to a render function (out, scope, ctx, depth): the tree is turned into straight-line
 * JavaScript once per case, so rendering pays no per-node dispatch. If the generated code cannot be built, the node
 * walker renders the same tree instead.
 */
function compileTemplate(nodes) {
  let uid = 0;
  // Each distinct path is materialised once, in the factory's constants, not as a fresh array at every lookup.
  const pathConsts = new Map();
  const pathRef = (path) => {
    const key = JSON.stringify(path);
    let ref = pathConsts.get(key);
    if (ref === undefined) {
      ref = `P${pathConsts.size}`;
      pathConsts.set(key, ref);
    }
    return ref;
  };
  const gen = (list, sc) => {
    let code = '';
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          code += `o.push(${JSON.stringify(n.text)});\n`;
          break;
        case 'var':
          code += `o.push(E(T(R(${sc},${pathRef(n.path)}))));\n`;
          break;
        case 'raw':
          code += `o.push(T(R(${sc},${pathRef(n.path)})));\n`;
          break;
        case 'if':
          code += `if (TR(R(${sc},${pathRef(n.path)})) !== ${n.not}) {\n${gen(n.then, sc)}}`;
          if (n.else !== null) code += ` else {\n${gen(n.else, sc)}}`;
          code += '\n';
          break;
        case 'for': {
          const id = uid++;
          const xs = `xs${id}`;
          const ln = `ln${id}`;
          const k = `k${id}`;
          const sc2 = `sc${id}`;
          code +=
            `{ const ${xs} = R(${sc},${pathRef(n.path)}); if (Array.isArray(${xs})) { const ${ln} = ${xs}.length; ` +
            `for (let ${k} = 0; ${k} < ${ln}; ${k}++) { const ${sc2} = { vars: { [${JSON.stringify(n.name)}]: ${xs}[${k}], ` +
            `loop: { index: ${k} + 1, first: ${k} === 0, last: ${k} === ${ln} - 1, length: ${ln} } }, parent: ${sc} };\n` +
            `${gen(n.body, sc2)}} } }\n`;
          break;
        }
        case 'include':
          code += `INC(o,${sc},ctx,depth,${JSON.stringify(n.name)});\n`;
          break;
      }
    }
    return code;
  };
  try {
    const body = gen(nodes, 'sc');
    const consts = [...pathConsts.keys()].map((key, i) => `const P${i} = ${key};`).join('\n');
    const factory = new Function('R', 'T', 'E', 'TR', 'INC', `${consts}\nreturn function (o, sc, ctx, depth) {\n${body}};`);
    return factory(resolveScope, textOf, escapeHtml, truthy, includeRender);
  } catch {
    return (o, sc, ctx, depth) => walkNodes(nodes, sc, ctx, depth, o);
  }
}

/* ------------------------------------------------------------------ build */

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory split `baseParts`, or null when it climbs out of the root. */
function resolveLinkPath(baseParts, rel) {
  const parts = baseParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (https:, mailto: ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's answer for `input`. */
export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const tpl = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      tpl.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const ctx = { tpl };
  const base = input.site.base_url.replace(/\/+$/, '');

  // Slugs repeat across a case's titles, headings and tags; the rule is pure, so each distinct text is slugged once.
  const slugCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // Sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft. The checks run in the dialect's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!tpl.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug, made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's rendering, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveLinkPath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs, then the statics.
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  function cardOf(s) {
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const f = tpl.get(name);
    if (f === undefined) return null;
    const o = [];
    f(o, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
    return o.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const o = [];
    const f = tpl.get('tag');
    if (f !== undefined) {
      f(o, { vars: { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } }, parent: null }, ctx, 0);
      output[`tags/${t.slug}/index.html`] = o.join('');
    }
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
