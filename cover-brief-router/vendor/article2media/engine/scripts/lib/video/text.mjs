// Narration text helpers: written form (what captions show) → spoken form (what the voice reads),
// keeping an index map so word timestamps on the spoken text can be projected back onto the written text.
//
//   "三个月，粉丝从 100 涨到 2380" → "三个月，粉丝从一百涨到两千三百八十"
//
// Explicit `say` entries win (longest key first); remaining digits are read by simple, predictable rules.

const DIG = '零一二三四五六七八九';
const LIANG_UNITS = '个种条件次天年位张本周名项步招点块份句段';

function four(x) {
  const units = ['千', '百', '十', ''];
  const ds = String(x).padStart(4, '0').split('').map(Number);
  let s = '', zero = false;
  ds.forEach((d, i) => {
    if (d === 0) { zero = !!s; return; }
    if (zero) s += '零';
    zero = false;
    s += DIG[d] + units[i];
  });
  return s;
}

/** Integer → Chinese reading (0 … 9999 9999 9999). */
export function intToZh(n) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return '零';
  const parts = [];
  const groups = [n % 10000, Math.floor(n / 10000) % 10000, Math.floor(n / 1e8)];
  const names = ['', '万', '亿'];
  let out = '';
  for (let g = groups.length - 1; g >= 0; g--) {
    const v = groups[g];
    if (!v) { if (out && !out.endsWith('零')) out += '零'; continue; }
    if (out && v < 1000 && !out.endsWith('零')) out += '零';
    out += four(v) + names[g];
  }
  out = out.replace(/零+$/, '').replace(/零+/g, '零');
  if (/^一十/.test(out)) out = out.slice(1); // 十五, 十万
  void parts;
  return out;
}

const digitsZh = (s) => [...s].map((d) => DIG[Number(d)]).join('');

/** Read one numeric token (as matched by NUM_RE) in context. */
function readNumber(m, next) {
  let [, cur, intPart, frac, mag, plus, pct] = m;
  const raw = intPart.replace(/,/g, '');
  let out;
  if (/^0\d/.test(raw)) out = digitsZh(raw); // 007
  else if (raw.length === 4 && !frac && !mag && next === '年') out = digitsZh(raw); // 2026年
  else {
    let n = Number(raw);
    if (mag === 'k' || mag === 'K') { n = n * 1000 + (frac ? Math.round(Number('0' + frac) * 1000) : 0); frac = ''; mag = ''; }
    out = intToZh(n);
    if (raw === '2' && !frac && !mag && LIANG_UNITS.includes(next || '')) out = '两';
    if (frac) out += '点' + digitsZh(frac.slice(1));
    if (mag === 'w' || mag === 'W' || mag === '万') out += '万';
    if (mag === '亿') out += '亿';
  }
  if (pct) out = '百分之' + out;
  if (plus) out += '多';
  if (cur === '$' && !/^\s*(刀|美元|美金)/.test(next || '')) out += '美元';
  if (cur === '¥' || cur === '￥') out += '元';
  return out;
}

const NUM_RE = /([$¥￥]?)(\d[\d,]*)(\.\d+)?([kKwW万亿]?)(\+?)(%?)/y;

/**
 * Written → spoken. Returns { spoken, map } where map[i] = index in `written` of the token that produced spoken[i].
 * `say`: { 写法: 读法 } applied first (case-insensitive for Latin words, longest first).
 */
export function toSpoken(written, say = {}) {
  const keys = Object.keys(say).sort((a, b) => b.length - a.length);
  let spoken = '';
  const map = [];
  const push = (s, at) => { for (const ch of s) { spoken += ch; map.push(at); } };
  let i = 0;
  while (i < written.length) {
    const k = keys.find((key) => written.substr(i, key.length).toLowerCase() === key.toLowerCase() &&
      !(/^[A-Za-z]/.test(key) && /[A-Za-z]/.test(written[i - 1] || '')) &&
      !(/[A-Za-z]$/.test(key) && /[A-Za-z]/.test(written[i + key.length] || '')));
    if (k) { push(say[k], i); i += k.length; continue; }
    NUM_RE.lastIndex = i;
    const m = /[$¥￥\d]/.test(written[i]) ? NUM_RE.exec(written) : null;
    if (m && m[2]) {
      const after = written.slice(i + m[0].length).replace(/^\s+/, '');
      push(readNumber(m, after[0]), i);
      i += m[0].length;
      continue;
    }
    push(written[i], i);
    i += 1;
  }
  return { spoken, map };
}

/** Characters that carry sound (CJK, Latin letters, digits). */
export const isVoiced = (ch) => /[㐀-鿿豈-﫿A-Za-z0-9]/.test(ch);
export const voicedOnly = (s) => [...s].filter(isVoiced).join('');

/**
 * Spoken length in 字 for pacing. A CJK character is one; a Latin word counts by its syllables, not its letters
 * (about one per three letters; a short all-caps acronym is spelled out, one per letter); a digit is one.
 */
export function speechUnits(s) {
  const str = String(s ?? '');
  const cjk = (str.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const digits = (str.match(/\d/g) || []).length;
  let latin = 0;
  for (const w of str.match(/[A-Za-z]+/g) || []) latin += w.length <= 5 && w === w.toUpperCase() ? w.length : Math.max(1, w.length / 3);
  return cjk + latin + digits;
}

/** Strip **markup** (keywords) and return [{text, key}] spans. */
export function spans(s) {
  const out = [];
  String(s).split(/(\*\*[^*]+\*\*)/).forEach((p) => {
    if (!p) return;
    if (/^\*\*[^*]+\*\*$/.test(p)) out.push({ text: p.slice(2, -2), key: true });
    else out.push({ text: p, key: false });
  });
  return out;
}
export const plainText = (s) => String(s ?? '').replace(/\*\*/g, '');

/** Display width of caption text in CJK cells (Latin letters, digits and spaces are about half a cell). */
export const capWidth = (s) => [...String(s)].reduce((w, ch) => w + (/[\x20-\x7e]/.test(ch) ? 0.55 : 1), 0);

/**
 * Split a written line into caption phrases, one line of ≤ maxLen cells each.
 * Splits at punctuation, then merges neighbours inside a sentence while they still fit, so captions change less often
 * (a caption that changes every second reads as flicker). Returns [{text, from, to}] with indices into the plain line;
 * trailing ，。、；： are dropped and inner ，、；： become spaces (Chinese subtitle convention).
 */
export function captionPhrases(line, maxLen = 13) {
  const text = plainText(line);
  const out = [];
  let start = 0;
  const flush = (end) => {
    let seg = text.slice(start, end);
    const lead = seg.length - seg.trimStart().length;
    seg = seg.trim();
    if (seg) out.push({ from: start + lead, to: end });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    // "1,935" and "10:30" are one number, not two phrases.
    if (/[，。！？；：、,!?;:…]/.test(text[i]) && !(/[,:]/.test(text[i]) && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || ''))) flush(i + 1);
  }
  flush(text.length);
  const shown = (a, b) => text.slice(a, b).replace(/[，。、；：,;:\s]+$/, '').trim();
  // Split long phrases evenly.
  const res = [];
  for (const p of out) {
    const w = capWidth(shown(p.from, p.to));
    if (w <= maxLen) { res.push(p); continue; }
    const n = Math.ceil(w / maxLen);
    // Even cuts, moved to the nearest boundary that is not inside a Latin word or a number ("Anthropi|c", "1,9|35").
    const inside = (i) => /[A-Za-z0-9]/.test(text[i - 1] || '') && /[A-Za-z0-9.,%]/.test(text[i] || '') && (/[A-Za-z0-9]/.test(text[i] || '') || /[0-9]/.test(text[i + 1] || ''));
    const cuts = [p.from];
    for (let k = 1; k < n; k++) {
      // Cut by display width, not by character count (Latin letters are about half a cell wide).
      let c = p.from, acc = 0;
      while (c < p.to && acc < (w * k) / n) acc += capWidth(text[c++]);
      if (inside(c)) {
        let a = c, b = c;
        while (a > p.from && inside(a)) a--;
        while (b < p.to && inside(b)) b++;
        const prev = cuts[cuts.length - 1];
        c = a > prev && (c - a <= b - c || b >= p.to) ? a : b < p.to ? b : a;
      }
      if (c > cuts[cuts.length - 1] && c < p.to) cuts.push(c);
    }
    cuts.push(p.to);
    for (let k = 0; k + 1 < cuts.length; k++) res.push({ from: cuts[k], to: cuts[k + 1] });
  }
  // Merge neighbours within a sentence while the result fits on one line (very short scraps may run 2 cells over).
  const merged = [];
  for (const p of res) {
    const prev = merged[merged.length - 1];
    const endsSentence = prev && /[。！？!?…]\s*$/.test(text.slice(prev.from, prev.to));
    const w = prev ? capWidth(shown(prev.from, p.to)) : 0;
    const tiny = prev && voicedOnly(text.slice(prev.from, prev.to)).length < 4;
    if (prev && !endsSentence && (w <= maxLen || (tiny && w <= maxLen + 2))) prev.to = p.to;
    else merged.push({ ...p });
  }
  return merged.map((p) => {
    const raw = text.slice(p.from, p.to);
    const lead = raw.length - raw.trimStart().length;
    const body = shown(p.from, p.to).replace(/[，、；：;]|[,:](?!\d)|(?<!\d)[,:]/g, ' ');
    return { from: p.from + lead, to: p.to, text: body };
  });
}

/**
 * A narration line may start with a style instruction for the voice, e.g. "(极度愤怒，东北话)注意看！这个男人叫小壮！".
 * Returns { style, text }: the instruction goes to VoxCPM2's controllable cloning; captions show only the text.
 */
export function splitStyle(line) {
  const m = String(line ?? '').match(/^\s*[(（]([^()（）]{1,40})[)）]\s*/);
  return m ? { style: m[1].trim(), text: String(line).slice(m[0].length) } : { style: '', text: String(line ?? '') };
}

/** Latin words in a text (for checking that English terms were actually pronounced). */
export const latinWords = (s) => (String(s).match(/[A-Za-z][A-Za-z0-9.+#-]*/g) || []).filter((w) => w.length >= 1);
