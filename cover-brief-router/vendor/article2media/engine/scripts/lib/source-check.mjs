// Checks that compare a content.json (改写稿) with the article it was written from.
// They catch what a model gets wrong while every layout check still passes: a number that is not in the
// article, the article's own pictures left out, someone else's story told in the first person, the article's
// specifics (numbers, names) left behind. All findings are warnings; render.mjs / check.mjs look for
// article.md (or article.zh.md) next to content.json.
import fs from 'node:fs';
import path from 'node:path';
import { plain } from './markup.mjs';

/** The article a content.json was written from, if it sits next to it. */
export function findSource(dir) {
  for (const f of ['article.md', 'article.zh.md']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return { path: p, text: fs.readFileSync(p, 'utf8') };
  }
  return null;
}

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };
// "三十五" → 35, "两千" → 2000.
function cnToNum(s) {
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN) cur = CN[ch];
    else if (ch in CN_UNIT) { total += (cur || 1) * CN_UNIT[ch]; cur = 0; }
    else if (ch === '万') { total = (total + cur) * 10000; cur = 0; }
  }
  return total + cur;
}
const EN = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, half: 50, dozen: 12, million: 1000000,
  // Months, so "December" backs "12 月".
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Every number the article states, as normalized strings ("2000", "1.5", "35", "12000"). */
export function sourceNumbers(text) {
  const set = new Set();
  const add = (n) => { if (Number.isFinite(n)) { set.add(String(n)); set.add(String(+n.toFixed(2))); } };
  const body = text.replace(/\(https?:[^)]*\)/g, ' '); // link targets carry ids, not facts
  for (const m of body.matchAll(/(\d[\d,，]*(?:\.\d+)?)\s*(万|千|k|K|亿|M|B)?/g)) {
    const raw = m[1].replace(/[,，]/g, '');
    set.add(raw);
    const n = Number(raw);
    add(n);
    if (m[2] === '万') add(n * 10000);
    if (m[2] === '千' || m[2] === 'k' || m[2] === 'K') add(n * 1000);
    if (m[2] === '亿') add(n * 1e8);
    if (m[2] === 'M') add(n * 1e6);
    if (m[2] === 'B') add(n * 1e9);
  }
  // Each run of digits on its own too: "10.12" is a date (October 12), "11:30" a time.
  for (const m of body.matchAll(/\d+/g)) add(Number(m[0]));
  for (const m of body.matchAll(/[零〇一二两三四五六七八九十百千万]{1,8}/g)) add(cnToNum(m[0]));
  for (const m of body.toLowerCase().matchAll(/\b[a-z]+\b/g)) if (m[0] in EN) add(EN[m[0]]);
  return set;
}

// Text fields that carry content (not ids, styles, links or the source credit).
const SKIP = new Set(['src', 'url', 'theme', 'style', 'type', 'mode', 'kind', 'fit', 'aspect', 'lang', 'date', 'handle', 'source', 'footnote', 'brand', 'issue', 'illustration', 'highlight', 'cols', 'leaves', 'index', 'max', 'figure', 'reverse', 'direction', 'voice']);
function* texts(o, where = '') {
  if (typeof o === 'string') { yield [where, o]; return; }
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) yield* texts(o[i], `${where}[${i}]`); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (!SKIP.has(k)) yield* texts(v, where ? `${where}.${k}` : k);
}
// A figure or panel that says its numbers are illustrative or the editor's own may carry them.
const DECLARED = /示意|编者|换算|估算|推算|核对/;
const declared = (c, where) => {
  const m = where.match(/^pages\[(\d+)\]\.sections\[(\d+)\]\.(figures\[\d+\]|panel)/);
  if (!m) return false;
  const s = c.pages?.[m[1]]?.sections?.[m[2]];
  const node = m[3] === 'panel' ? s?.panel : s?.figures?.[Number(m[3].match(/\d+/)[0])];
  return DECLARED.test(`${node?.note || ''} ${node?.title || ''}`);
};

// A rounded number matches a source number it rounds from: "97.8 万" ← 977,930, "4.3 万" ← 43,406.
function roundsFrom(n, raw, mult, known) {
  const decimals = (raw.split('.')[1] || '').length;
  const unit = Math.pow(10, -decimals) * mult;
  if (unit < 1 && mult === 1) return false; // plain decimals ("4.2") must match exactly
  for (const k of known) { const s = Number(k); if (Number.isFinite(s) && s > 0 && Math.abs(s - n) <= unit / 2) return true; }
  return false;
}

/** Numbers in the rewrite that the article never states. */
export function unsourcedNumbers(c, text) {
  const known = sourceNumbers(text);
  const out = new Map();
  for (const [where, s] of texts(c)) {
    // The set's own furniture ("这组 12 张图", "第 3 页", "第 12–14 张") is not a claim about the article.
    const t = plain(s)
      .replace(/第\s*\d+\s*[–\-~～到至]\s*\d+\s*(张|页|节)/g, '')
      .replace(/\d+\s*(张图|张卡|张|页|节|步|条|阶段)(读完|看完)?/g, (x, u) => (/张图|张卡|页|节/.test(u) ? '' : x))
      .replace(/第\s*\d+\s*(张|页|节)/g, '');
    for (const m of t.matchAll(/(\d[\d,，]*(?:\.\d+)?)\s*(万|千|k|K|亿)?/g)) {
      const raw = m[1].replace(/[,，]/g, '');
      if (raw.length < 2 || /^0\d$/.test(raw)) continue; // single digits and list numbers (01, 02) carry no claim
      let n = Number(raw);
      const mult = m[2] === '亿' ? 1e8 : m[2] === '万' ? 10000 : m[2] === '千' || m[2] === 'k' || m[2] === 'K' ? 1000 : 1;
      n *= mult;
      if (known.has(raw) || known.has(String(n)) || known.has(String(+n.toFixed(2)))) continue;
      if (roundsFrom(n, raw, mult, known)) continue;
      if (declared(c, where)) continue;
      if (!out.has(m[0].trim())) out.set(m[0].trim(), where);
    }
  }
  return [...out].map(([value, where]) => ({ value, where }));
}

/** Pictures in the article body (not avatars or emoji). */
export const sourceImages = (text) => [...text.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+|[^)\s]+\.(?:png|jpe?g|webp|gif))\)/gi)].map((m) => m[1]).filter((u) => !/profile_images|emoji|avatar/i.test(u));

// First person in a headline: 我 / 我们 / 我的 outside quotation marks.
const firstPerson = (s) => /我/.test(plain(s).replace(/「[^」]*」|“[^”]*”|"[^"]*"|『[^』]*』/g, ''));

const COMMON_EN = new Set('The This That They Then There These Those When What Where Which While With And But For From You Your Our Every Each Since Before After Besides Sometimes Because Almost Now Here Ready Please Similar Rather Whenever Otherwise Think Just Give Keep Let More Want Ask Not Its His Her She How Why Who All One Two Some Most Many Even Also Still Only Over Into About Like Than Will Can Could Would Should Don Doesn Isn Yes Image Images Video Note'.split(' '));

/** How much of the article's specifics the rewrite carries: the numbers it states and the names it repeats. */
export function coverage(c, text) {
  const body = text.replace(/^---[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/\([^)]*\)|https?:\S+/g, ' ');
  const all = [...texts(c)].map(([, s]) => plain(s)).join('\n');
  const have = new Set([...all.replace(/[,，]/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]));
  const nums = new Map();
  for (const m of body.matchAll(/\d[\d,，]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/[,，]/g, '');
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 2);
    // Section numbering ("1.1、", "2）", "3. ") is structure, not a fact; nor are parameter strings ("aecho=0.85:0.82|48").
    if (/^[、）)]|^\.\s/.test(after)) continue;
    if (/[=:|]/.test(body[m.index - 1] || '') || /^[:|]/.test(after)) continue;
    if (n.length < 2 || /^(19|20)\d\d$/.test(n) || /^0\d/.test(n) || nums.has(n)) continue;
    nums.set(n, body.slice(Math.max(0, m.index - 8), m.index + m[0].length + 6).replace(/\s+/g, ' ').trim());
  }
  const numMissing = [...nums].filter(([n]) => !have.has(n)).map(([n, ctx]) => ({ n, ctx }));
  // Names of people, tools and products the article repeats (bold Chinese phrases are mostly subheadings, so they don't count).
  const latin = {};
  for (const m of body.matchAll(/\b[A-Z][A-Za-z0-9+.-]{2,}\b/g)) latin[m[0]] = (latin[m[0]] || 0) + 1;
  const terms = [...new Set(Object.entries(latin).filter(([w, k]) => k >= 2 && !COMMON_EN.has(w)).map(([w]) => w.replace(/\.$/, '')))];
  const low = all.toLowerCase();
  const termMissing = terms.filter((t) => !low.includes(t.toLowerCase()) && !low.includes(t.toLowerCase().replace(/s$/, '')));
  return {
    numbers: { total: nums.size, missing: numMissing, share: nums.size ? 1 - numMissing.length / nums.size : 1 },
    terms: { total: terms.length, missing: termMissing, share: terms.length ? 1 - termMissing.length / terms.length : 1 },
  };
}

const cjkShare = (t) => { const s = t.replace(/\s/g, ''); return s.length ? (s.match(/[一-鿿]/g) || []).length / s.length : 0; };
const bigrams = (t) => { const c = (t.match(/[一-鿿]/g) || []).join(''); const out = new Set(); for (let i = 0; i < c.length - 1; i++) out.add(c.slice(i, i + 2)); return out; };

// Common English words left untranslated in a Chinese rewrite read as translationese ("transcript", "playbook").
const KEEP_EN = new Set('agent agents ai api app apps token tokens prompt prompts skill skills wiki bot bots pr prs ci cd ui ux ip mcp sdk cli gpu llm json html css'.split(' '));
export function stray(c, text) {
  const all = [...texts(c)].map(([w, s]) => (/^(source|footnote)/.test(w) ? '' : plain(s))).join(' ');
  if (cjkShare(all) < 0.5) return [];
  const zhSource = cjkShare(text) >= 0.5;
  // Names, handles and inline code from the article are fine; in a Chinese article every English word is the author's own term.
  const names = new Set([...text.matchAll(/\b[A-Z][A-Za-z0-9+.-]+\b|@[\w.]+|`[^`]+`/g)].map((m) => m[0].replace(/^[@`]|`$/g, '').toLowerCase()));
  if (zhSource) for (const m of text.matchAll(/[A-Za-z][A-Za-z-]{3,}/g)) names.add(m[0].toLowerCase());
  const words = new Set([...all.replace(/`[^`]*`|https?:\S+|\S+\.(?:md|mp4|json|py|js|png)\b/g, ' ').matchAll(/(?<![A-Za-z./_-])[a-z][a-z-]{3,}(?![A-Za-z./_-])/g)].map((m) => m[0]));
  return [...words].filter((w) => !KEEP_EN.has(w) && !names.has(w));
}

/**
 * Warnings for content.json measured against its article. brand: the resolved brand (to tell a user's own
 * article from someone else's).
 */
export function sourceChecks(c, text, { brand = {} } = {}) {
  const warnings = [];
  const warn = (p, m) => warnings.push(`${p}: ${m}`);

  // 1) Numbers must come from the article.
  const nums = unsourcedNumbers(c, text);
  for (const { value, where } of nums.slice(0, 8)) {
    warn(where, `数字「${value}」在原文里找不到：改成原文写的数字；是编者换算或示意的，在这张图或面板的 note 里写明"编者换算"或"示意"`);
  }
  if (nums.length > 8) warn('numbers', `还有 ${nums.length - 8} 个数字在原文里找不到，同上处理`);

  // 2) Someone else's article is not told in the first person.
  const author = c.source?.author || '';
  const own = c.voice === 'self' || (author && brand.name && (author.includes(brand.name) || brand.name.includes(author)));
  if (!own && author) {
    const heads = [
      ['title', c.title], ['cover.title', c.cover?.title], ['cover.subtitle', c.cover?.subtitle], ['xhs.title', c.xhs?.title], ['wechat.title', c.wechat?.title],
      ...(c.cover?.alts || []).map((a, i) => [`cover.alts[${i}].title`, a?.title]),
      ...Object.entries(c.publish?.titles || {}).flatMap(([k, list]) => (Array.isArray(list) ? list : []).map((t, i) => [`publish.titles.${k}[${i}]`, t])),
    ];
    for (const [where, t] of heads) {
      if (typeof t === 'string' && firstPerson(t)) {
        warn(where, `用了第一人称「我」，但原文作者是 ${author}：发出去读者会以为是你自己的经历。改成第三人称（他、她、作者、一位店主……）；原文就是你自己写的，在 content.json 顶层写 "voice": "self"`);
      }
    }
  }

  // 3) Coverage: the article's specifics (numbers it states, names it repeats) are what a reader saves the cards for.
  const cov = coverage(c, text);
  if (cov.numbers.total >= 5 && cov.numbers.missing.length && cov.numbers.share < 0.8) {
    warn('coverage', `原文写到的具体数字只用上了 ${Math.round(cov.numbers.share * 100)}%（${cov.numbers.total - cov.numbers.missing.length} / ${cov.numbers.total}）。这些还没出现：${cov.numbers.missing.slice(0, 8).map((n) => `「${n.ctx}」`).join('、')}。挑能支撑结论的补进正文、bullets、图或面板（不用全补，补到 80% 以上；面板最适合放一组数字）`);
  }
  if (cov.terms.total >= 4 && cov.terms.missing.length && cov.terms.share < 0.75) {
    warn('coverage', `原文反复出现的人名、工具名只用上了 ${Math.round(cov.terms.share * 100)}%（${cov.terms.total - cov.terms.missing.length} / ${cov.terms.total}）。这些还没出现：${cov.terms.missing.slice(0, 10).join('、')}。读者要的是具体的名字和做法，挑重要的写进去（补到 75% 以上）`);
  }

  // 3c) English words left in a Chinese rewrite.
  const en = stray(c, text);
  if (en.length >= 3) {
    warn('language', `中文里夹了这些英文普通词：${en.slice(0, 10).join('、')}。换成中文说法（transcript → 运行记录，playbook → 手册）；产品名、工具名、代码保留原样`);
  }

  // 4) The article's own pictures (screenshots, diagrams) are usually the best figures it has.
  const imgs = sourceImages(text);
  const used = (c.pages || []).some((p) => (p.sections || []).some((s) => (s.figures || []).some((f) => f?.type === 'image')));
  if (imgs.length >= 2 && !used) {
    warn('figures', `原文有 ${imgs.length} 张配图，改写稿一张都没用：截图、图解、产品界面这类配图，挑 1–3 张用 {"type": "image", "src": "<article.md 里的图片地址>", "caption": "…"} 放进讲同一件事的节（卡片上会优先显示原文配图）。先看图再选：有的文章图下面有一行「图：…」说明；没有说明就把图下载到工作目录（curl -sL "<地址>" -o assets/1.jpg）打开看。X 长文的配图常排在它所属章节的标题前面（上一章的末尾），按图的内容而不是位置判断它属于哪一节。只放你确定讲的是同一件事的图：放错节比不放更糟（卡片会优先显示它），拿不准就一张都不放，在交付里说明。纯装饰的头图不用`);
  }
  return warnings;
}
