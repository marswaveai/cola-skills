// "card" layout: fixed-ratio cards for carousels (小红书 3:4, Instagram 4:5, 1:1, 9:16), 540 CSS px wide → 1080 px at 2x.
// Same content.json as the long layout; optional `cover`, `xhs` and per-section `card` hints refine it.
import { esc, md, pad2, plain, vlen } from './markup.mjs';
import { renderFigure } from './figures.mjs';
import { LABELS, accVar, panelBlock, hasIllustrations } from './layout-long.mjs';
import { coverIllustrationSrc, coverIllustrationAspect } from './illustrations.mjs';

export const RATIOS = {
  '3:4': { w: 540, h: 720, limit: 18, name: '小红书 / 3:4' }, // 小红书 allows at most 18 images per note
  '4:5': { w: 540, h: 675, limit: 20, name: 'Instagram / 4:5' },
  '1:1': { w: 540, h: 540, limit: 20, name: '方图 / 1:1' },
  '9:16': { w: 540, h: 960, limit: 20, name: '竖屏 / 9:16' },
};
export function ratioSpec(r = '3:4') {
  const spec = RATIOS[r];
  if (!spec) throw new Error(`不支持的比例 ${r}，可用：${Object.keys(RATIOS).join('、')}`);
  // Usable height of .c-body is the card height minus padding, header and footer (measured: 720 → 613).
  return { ...spec, key: r, slug: r.replace(':', 'x'), budget: spec.h - 124 };
}

// Rough height estimates (CSS px) used to pack checklist stages into cards.
// They mirror card.css; QA still measures the real layout afterwards.
const lines = (text, perLine) => Math.max(1, Math.ceil(vlen(text || '') / perLine));
const headH = (s, first) =>
  36 + // label pill + gap
  (first ? 37 : 28) * Math.max(String(s.heading || '').split('\n').length, lines(String(s.heading || '').replace(/\n/g, ''), first ? 16 : 21)) +
  12 +
  (first ? (s.paragraphs || []).slice(0, 1).reduce((h, p) => h + 29 * lines(p, 28) + 12, 0) : 0);
const stageH = (st) =>
  22 + 26 + (st.items || []).reduce((h, t) => h + 21.7 * lines(t, 29) + 4, 0) + (st.done ? 12 + 19 * lines(st.done, 33) : 0) + 10;
const guardH = (g) => 30 + 32 + (g.items || []).reduce((h, t) => h + 22.5 * lines(t, 27) + 8, 0) + (g.note ? 26 : 0) + 12;

// Split stages into the fewest cards that fit, then pick the most even split
// (the guard block, if any, rides on the last card). At most 6 stages, so brute force is cheap.
function packStages(s, num, k, budget) {
  const stages = s.stages || [];
  const hs = stages.map(stageH);
  const g = s.guard ? guardH(s.guard) : 0;
  // The estimates run a little high, which used to push a checklist onto one more (half-empty) card.
  // Pack against a slightly generous budget: render.mjs measures the real cards and re-packs with a
  // smaller budget if one overflows.
  budget = Math.round(budget * 1.05);
  const n = stages.length;
  const fill = (from, to, first, last) => headH(s, first) + hs.slice(from, to).reduce((a, b) => a + b, 0) + (last ? g : 0);

  // All ways to cut [0, n) into `parts` contiguous groups; the last group may be empty (guard only).
  function* cuts(parts, start = 0) {
    if (parts === 1) { yield [[start, n]]; return; }
    for (let end = start + 1; end <= n; end++) for (const rest of cuts(parts - 1, end)) yield [[start, end], ...rest];
  }

  for (let parts = 1; parts <= Math.max(1, n + (g ? 1 : 0)); parts++) {
    let best = null;
    for (const groups of cuts(parts)) {
      const used = groups.map(([a, b], i) => fill(a, b, i === 0, i === groups.length - 1));
      if (used.some((u) => u > budget)) continue;
      const spread = Math.max(...used) - Math.min(...used);
      if (!best || spread < best.spread) best = { groups, spread };
    }
    if (best) {
      return best.groups.map(([from, to], i) => ({
        kind: from === to ? 'guard' : 'stages', s, num, k, from, to, first: i === 0,
        guard: !!g && i === best.groups.length - 1 && from !== to,
      }));
    }
  }
  // Nothing fits (a single huge stage): one stage per card and let QA report the overflow.
  const out = stages.map((_, i) => ({ kind: 'stages', s, num, k, from: i, to: i + 1, first: i === 0 }));
  if (g) out.push({ kind: 'guard', s, num, k });
  return out.length ? out : [{ kind: 'stages', s, num, k, from: 0, to: 0, first: true }];
}

const CL = {
  zh: {
    kicker: (n) => `长文拆解 · ${n} 张图读完`,
    toc: '这组图讲了',
    cont: '续',
    recap: '全文要点',
    onepage: '一页看完',
    qa: '问答',
    quote: '金句',
    cta: '收藏这组图，用的时候翻出来',
    credit: (s) => `原文｜${[s.author, s.handle].filter(Boolean).join(' ')}${s.platform ? ` · ${s.platform}` : ''}`,
  },
  en: {
    kicker: (n) => `Long read · ${n} cards`,
    toc: 'Inside',
    cont: 'cont.',
    recap: 'Key takeaways',
    onepage: 'On one page',
    qa: 'Q & A',
    quote: 'Quote',
    cta: 'Save this for later',
    credit: (s) => `Source: ${[s.author, s.handle].filter(Boolean).join(' ')}${s.platform ? ` · ${s.platform}` : ''}`,
  },
};

/** Decide which cards to make, in order. Shared by the builder and the validator. */
export const FORMS = ['quotes', 'onepage', 'qa'];

/** Sentences for the 金句图 form: content.quotes, or every section's takeaway. */
export function quoteItems(c) {
  if (Array.isArray(c.quotes) && c.quotes.length) return c.quotes.map((q) => (typeof q === 'string' ? { text: q } : q)).filter((q) => q?.text);
  return (c.pages || []).flatMap((p) => (p.sections || []).filter((s) => s.takeaway || s.card?.quote).map((s) => ({ text: s.card?.quote || s.takeaway, from: plain(s.heading).replace(/\n/g, '') })));
}
/** Points for the 一页看完 form: content.onepage.points, or each standard section's heading + takeaway. */
export function onepagePoints(c) {
  const own = c.onepage?.points;
  if (Array.isArray(own) && own.length) return own.map((p) => (typeof p === 'string' ? { text: p } : p));
  return (c.pages || []).flatMap((p) => (p.sections || []).filter((s) => s.kind !== 'checklist' && s.takeaway).map((s) => ({ title: plain(s.heading).replace(/\n/g, ''), text: s.takeaway })));
}
// 问答 cards hold as many question-answer pairs as fit: packed by text volume, QA measures the real cards.
function packQa(pairs, budget, titleLines = 1) {
  const cost = (p) => 44 + 26 * Math.ceil(vlen(p.q || '') / 20) + 26 * Math.ceil(vlen(p.a || '') / 21) + 40;
  const out = [];
  let from = 0, used = 0;
  pairs.forEach((p, i) => {
    const h = cost(p), cap = budget - (out.length ? 0 : 60 + 43 * titleLines); // the first card also carries the title
    if (i > from && used + h > cap) { out.push({ kind: 'qa', from, to: i }); from = i; used = 0; }
    used += h;
  });
  if (pairs.length) out.push({ kind: 'qa', from, to: pairs.length });
  return out;
}

export function planCards(content, ratio = '3:4', budgetAdjust = 0, form = '') {
  const budget = ratioSpec(ratio).budget - budgetAdjust;
  if (form === 'quotes') return quoteItems(content).map((q, i) => ({ kind: 'quote', q, k: i }));
  if (form === 'onepage') return [{ kind: 'onepage' }];
  if (form === 'qa') return packQa(content.qa || [], budget, String(content.qaTitle || content.cover?.title || content.title || '').split('\n').length);
  const plan = [{ kind: 'cover' }];
  let num = 0;
  for (const pg of content.pages || []) {
    for (const s of pg.sections || []) {
      num += 1;
      const k = num - 1;
      if (s.kind === 'checklist') {
        plan.push(...packStages(s, num, k, budget));
        continue;
      }
      const mode = s.card?.mode || 'single';
      if (mode === 'skip') continue;
      plan.push({ kind: 'sec', s, num, k, part: 1, split: mode === 'split' });
      if (mode === 'split') plan.push({ kind: 'sec', s, num, k, part: 2, split: true });
    }
  }
  plan.push({ kind: 'end' });
  return plan;
}

// data-drop marks optional elements; window.__fit hides them in ascending order when a card overflows.
const drop = (order, name) => ` data-drop="${order}" data-drop-name="${name}"`;

function figBlock(f, id, capOrder = 2) {
  if (!f) return '';
  return (
    `<figure class="c-fig" data-fig="${id}"${drop(9, '图')}><div class="c-fig-card"><div class="c-fig-box"><div class="fig-canvas">${renderFigure(f)}</div></div></div>` +
    (f.caption ? `<figcaption class="c-cap" data-qa-text${drop(capOrder, '图注')}>${md(f.caption)}</figcaption>` : '') +
    `</figure>`
  );
}

// Brand chip: avatar, name and issue. Shown on the cover and on stand-alone forms so a reader can tell whose card this is.
const brandChip = (b) =>
  b?.name || b?.avatar
    ? `<span class="b-chip">${b.avatar ? `<img class="b-ava" src="${esc(b.avatar)}" alt="">` : ''}${b.name ? `<b>${md(b.name)}</b>` : ''}${b.issueLabel ? `<em>${esc(b.issueLabel)}</em>` : ''}</span>`
    : '';

function frame(inner, { idx, total, series, foot, cls = '', acc, kind, deco = '', chip = '' }) {
  return (
    `<section class="card acc ${cls}" data-card="${idx}" data-kind="${kind}" style="--acc:${acc}">` + deco +
    `<header class="c-top">${chip || `<span>${md(series)}</span>`}<span>${total > 1 ? `${pad2(idx)} / ${pad2(total)}` : ''}</span></header>` +
    `<div class="c-body">${inner}</div>` +
    `<footer class="c-foot"><span>${md(foot)}</span></footer>` +
    `</section>`
  );
}

export const COVER_STYLES = ['hook', 'number', 'versus', 'quote', 'image', 'toc'];
/** Which cover layout to draw: the requested one when its data is there, otherwise the best fit for what is. */
export function coverStyle(c) {
  const cover = c.cover || {};
  const has = {
    number: !!cover.number?.value,
    versus: !!(cover.versus?.left && cover.versus?.right),
    image: !!coverIllustrationSrc(c),
  };
  if (COVER_STYLES.includes(cover.style)) return has[cover.style] === false ? 'hook' : cover.style;
  return has.image ? 'image' : has.number ? 'number' : has.versus ? 'versus' : 'hook';
}

// Theme-drawn decoration behind a cover (three empty elements each theme shapes its own way).
export const COVER_DECO = '<div class="cv-deco" data-deco aria-hidden="true"><i></i><i></i><i></i></div>';

// A big figure with its unit: "413 个文件". The number shrinks until the row fits on one line.
const numBlock = (n, cls) =>
  `<div class="${cls}" data-fit-line><b>${md(n.value)}</b>${n.unit ? `<span>${md(n.unit)}</span>` : ''}</div>` +
  (n.label ? `<div class="${cls}-label" data-qa-text>${md(n.label)}</div>` : '');

function coverCard(c, L, total) {
  const cover = c.cover || {};
  const pages = c.pages || [];
  const style = coverStyle(c);
  const kicker = `<div class="cv-kicker">${md(cover.kicker || L.kicker(total))}</div>`;
  const title = `<h1 class="cv-title" data-qa-text>${md(cover.title || c.title)}</h1>`;
  const subText = cover.subtitle ?? pages[0]?.intro;
  const sub = subText ? `<p class="cv-sub" data-qa-text${drop(2, '封面副标题')}>${md(subText)}</p>` : '';

  if (style === 'toc') {
    let points = cover.points;
    if (!points) {
      points = pages.length > 1
        ? pages.map((p) => String(p.part || '').replace(/^[^·]*·\s*/, ''))
        : (pages[0]?.sections || []).map((s) => plain(s.heading).replace(/\n/g, '')).slice(0, 6);
    }
    return kicker + title + `<div class="cv-rule"></div>` + sub +
      `<div class="cv-toc"${drop(1, '封面目录')}><div class="cv-toc-h">${esc(L.toc)}</div><ol>${points
        .filter(Boolean)
        .map((p, i) => `<li><i>${pad2(i + 1)}</i><span data-qa-text>${md(p)}</span></li>`)
        .join('')}</ol></div>`;
  }
  if (style === 'image') {
    return kicker +
      `<div class="cv-ill"><img src="${esc(coverIllustrationSrc(c))}" style="aspect-ratio:${coverIllustrationAspect(c)}" alt=""></div>` +
      title + sub;
  }
  if (style === 'number') {
    return kicker + numBlock(cover.number, 'cv-num') + title + `<div class="cv-rule"></div>` + sub;
  }
  if (style === 'versus') {
    const col = (v, cls) =>
      `<div class="cv-vs-col ${cls}"><small>${md(v.label || '')}</small><div class="cv-vs-val" data-fit-line><b>${md(v.value || '')}</b></div>${v.note ? `<span data-qa-text>${md(v.note)}</span>` : ''}</div>`;
    return kicker + title +
      `<div class="cv-vs">${col(cover.versus.left, 'no')}<i class="cv-vs-mid">VS</i>${col(cover.versus.right, 'yes')}</div>` + sub;
  }
  if (style === 'quote') {
    const by = cover.by ?? [c.source?.author, c.source?.handle].filter(Boolean).join(' ');
    return kicker + `<div class="cv-qmark" data-deco>“</div>` + title + (by ? `<div class="cv-by">—— ${md(by)}</div>` : '') + `<div class="cv-rule"></div>` + sub;
  }
  // hook: the headline fills the card; subtitle and up to four short points sit in an accent band at the bottom.
  const points = (cover.points || []).filter(Boolean).slice(0, 4);
  const band = sub || points.length
    ? `<div class="cv-band">${sub}${points.length ? `<div class="cv-chips"${drop(1, '封面要点')}>${points.map((p) => `<span data-qa-text>${md(p)}</span>`).join('')}</div>` : ''}</div>`
    : '';
  return kicker + title + `<div class="cv-rule"></div>` + band;
}

// A full-card sentence breaks at its own punctuation (unless the author already placed the breaks).
const quoteLines = (q) => (/\n/.test(q) ? q : String(q).replace(/([，；：、,;:—])(?=[^\s*”’」』）)])/g, '$1\n'));

export const CARD_STYLES = ['quote', 'number', 'image'];
/** Full-card variant of a section, when its data is there ("quote" needs a sentence, "number" a value, "image" a figure). */
export function cardStyle(s) {
  const card = s.card || {};
  if (!CARD_STYLES.includes(card.style)) return ''; // with "mode": "split" the full card comes first, the section's own card second
  if (card.style === 'quote') return card.quote || s.takeaway ? 'quote' : '';
  if (card.style === 'number') return card.number?.value ? 'number' : '';
  return (s.figures || []).length && card.figure !== 'none' ? 'image' : '';
}

function secCard(it, L) {
  const s = it.s;
  const card = s.card || {};
  const figs = s.figures || [];
  const label = `<div class="sec-label">${pad2(it.num)} · ${md(s.label || '')}${it.part === 2 ? ` · ${esc(L.cont)}` : ''}</div>`;
  const heading = `<h2 class="sec-h${it.part === 2 ? ' cont' : ''}" data-qa-text>${md(s.heading)}</h2>`;
  // The one figure a card shows: card.figure, else the article's own picture if the section has one, else the first.
  const fi = card.figure === 'none' ? -1 : Number.isInteger(card.figure) ? card.figure : Math.max(0, figs.findIndex((f) => f?.type === 'image'));
  // "mode": "split" with a style: part 1 is the full card, part 2 is the section's ordinary card (text, figure, takeaway).
  const styledSplit = it.split && !!cardStyle(s);

  if (it.part === 2 && !styledSplit) {
    const other = figs.findIndex((_, j) => j !== fi);
    return label + heading + (other >= 0 ? figBlock(figs[other], `${it.num}${'AB'[other]}`, 1) : '') + panelBlock(s.panel);
  }
  const text = card.text ?? s.paragraphs?.[0];
  const style = it.part === 2 ? '' : cardStyle(s);
  // In a styled split the next card carries the text and takeaway, so neither card repeats the other; a quote card
  // that borrowed the takeaway already said it.
  const quoteIsTake = styledSplit && cardStyle(s) === 'quote' && !card.quote;
  const take = s.takeaway && !(styledSplit && it.part === 1 && style === 'number') && !(it.part === 2 && quoteIsTake)
    ? `<p class="c-take" data-qa-text>${md(s.takeaway)}</p>` : '';

  // Full-card variants: they break the "label, heading, text, figure, takeaway" rhythm of a long carousel.
  if (style === 'quote') {
    return label +
      `<div class="cq"><div class="cq-mark" data-deco>“</div><p class="cq-text" data-qa-text data-fit-lines>${md(quoteLines(card.quote || s.takeaway))}</p>` +
      `<div class="cq-from">${md(plain(s.heading).replace(/\n/g, ''))}</div></div>`;
  }
  if (style === 'number') {
    return label + `<h2 class="sec-h cont" data-qa-text>${md(s.heading)}</h2>` +
      `<div class="cn">${numBlock(card.number, 'cn-num')}</div>` +
      (text && !styledSplit ? `<p class="c-text" data-qa-text${drop(5, '正文')}>${md(text)}</p>` : '') + take;
  }
  if (style === 'image') {
    const f = figs[fi >= 0 ? fi : 0];
    const src = f.type === 'illustration' ? f._src : f.type === 'image' ? f.src : '';
    const pic = src
      ? `<figure class="c-pic"><img src="${esc(src)}" alt="">${f.caption ? `<figcaption class="c-cap" data-qa-text${drop(2, '图注')}>${md(f.caption)}</figcaption>` : ''}</figure>`
      : figBlock(f, `${it.num}${'AB'[Math.max(fi, 0)]}`);
    return label + heading + pic + take;
  }

  const bullets = card.bullets || [];
  // Optional extras ([data-fill]) appear only when the card has room left after its figure is at full size.
  const fillBullets = !bullets.length && card.fill !== false ? (s.bullets || []).slice(0, 3) : [];
  // A panel goes on a card only when asked for ("panel": true); the second card of a styled split is an ordinary card.
  const showPanel = s.panel && card.panel && (!it.split || styledSplit);
  return (
    label +
    heading +
    (text ? `<p class="c-text" data-qa-text${drop(5, '正文')}>${md(text)}</p>` : '') +
    (fi >= 0 && figs[fi] ? figBlock(figs[fi], `${it.num}${'AB'[fi]}`) : '') +
    (bullets.length ? `<ul class="c-bullets"${drop(1, '要点')}>${bullets.map((b) => `<li data-qa-text>${md(b)}</li>`).join('')}</ul>` : '') +
    (fillBullets.length ? `<ul class="c-bullets" data-fill="1" hidden>${fillBullets.map((b) => `<li data-qa-text>${md(b)}</li>`).join('')}</ul>` : '') +
    (showPanel ? `<div${drop(3, '数据面板')}>${panelBlock(s.panel)}</div>` : '') +
    take
  );
}

function guardBlock(g) {
  return (
    `<div class="c-guard"><div class="c-guard-h">${md(g.title)}</div>` +
    `<ul>${(g.items || []).map((t) => `<li><i class="c-x">✕</i><span data-qa-text>${md(t)}</span></li>`).join('')}</ul>` +
    (g.note ? `<div class="c-guard-note"${drop(1, '护栏说明')}>${md(g.note)}</div>` : '') +
    `</div>`
  );
}

function stagesCard(it, L, nAcc) {
  const s = it.s;
  const label = `<div class="sec-label">${pad2(it.num)} · ${md(s.label || '')}${it.first ? '' : ` · ${esc(L.cont)}`}</div>`;
  const heading = `<h2 class="sec-h${it.first ? '' : ' cont'}" data-qa-text>${md(s.heading)}</h2>`;
  const intro = it.first ? (s.paragraphs || []).slice(0, 1).map((p) => `<p class="c-text" data-qa-text${drop(1, '清单导语')}>${md(p)}</p>`).join('') : '';
  const stages = (s.stages || []).slice(it.from, it.to).map((st, j) =>
    `<div class="c-stage acc" style="--acc:${accVar(it.k + it.from + j, nAcc)}">` +
    `<div class="c-stage-h"><small>${md(st.label || '')}</small><b>${md(st.title)}</b></div>` +
    `<ul>${(st.items || []).map((t) => `<li><i class="c-box"></i><span data-qa-text>${md(t)}</span></li>`).join('')}</ul>` +
    (st.done ? `<div class="c-done" data-qa-text><b>${esc(L.done)}</b>${md(st.done)}</div>` : '') +
    `</div>`).join('');
  return label + heading + intro + `<div class="c-stages">${stages}</div>` + (it.guard && s.guard ? guardBlock(s.guard) : '');
}

function guardCard(it, L) {
  const s = it.s;
  return (
    `<div class="sec-label">${pad2(it.num)} · ${md(s.label || '')} · ${esc(L.cont)}</div>` +
    `<h2 class="sec-h cont" data-qa-text>${md(s.heading)}</h2>` +
    guardBlock(s.guard) +
    (s.note ? `<p class="c-note"${drop(2, '清单说明')}>${md(s.note)}</p>` : '')
  );
}

// Stand-alone sentence card (金句图).
function quoteOnlyCard(it, c) {
  return `<div class="cq"><div class="cq-mark" data-deco>“</div><p class="cq-text" data-qa-text data-fit-lines>${md(quoteLines(it.q.text))}</p>` +
    (it.q.from || it.q.by ? `<div class="cq-from">${md(it.q.by || it.q.from)}</div>` : '') + `</div>`;
}

// 一页看完: the whole piece on one card — headline, one line of context, the points.
function onepageCard(c, L) {
  const o = c.onepage || {};
  const pts = onepagePoints(c).slice(0, 9);
  // A full list leaves no room for the context line: only an explicit onepage.subtitle is kept then.
  const sub = o.subtitle ?? (pts.length > 6 ? '' : c.cover?.subtitle ?? c.pages?.[0]?.intro);
  return (
    `<div class="cv-kicker">${md(o.kicker || L.onepage)}</div>` +
    `<h1 class="op-title" data-qa-text>${md(o.title || c.cover?.title || c.title)}</h1>` +
    (sub ? `<p class="op-sub" data-qa-text${drop(1, '导语')}>${md(sub)}</p>` : '') +
    `<ol class="op-list" data-shrink>${pts.map((p, i) => `<li><i>${pad2(i + 1)}</i><div>${p.title ? `<b data-qa-text>${md(p.title)}</b>` : ''}<span data-qa-text>${md(p.text || '')}</span></div></li>`).join('')}</ol>`
  );
}

// 问答: a chat thread, question bubbles on the right, answers on the left.
function qaCard(it, c, L, first) {
  const pairs = (c.qa || []).slice(it.from, it.to);
  return (
    (first ? `<div class="cv-kicker">${md(c.qaKicker || L.qa)}</div><h1 class="qa-title" data-qa-text>${md(c.qaTitle || c.cover?.title || c.title)}</h1>` : '') +
    `<div class="qa-thread">${pairs.map((p) => `<div class="qa-q"><p data-qa-text>${md(p.q)}</p></div><div class="qa-a"><p data-qa-text>${md(p.a)}</p></div>`).join('')}</div>`
  );
}

function endBrand(b) {
  if (!b?.name && !b?.avatar) return '';
  return `<div class="end-brand"${drop(3, '品牌栏')}>${b.avatar ? `<img class="b-ava" src="${esc(b.avatar)}" alt="">` : ''}<div><b>${md([b.name, b.handle].filter(Boolean).join(' '))}</b>${b.tagline ? `<span>${md(b.tagline)}</span>` : ''}</div></div>`;
}

function endCard(c, L, footnote, brand) {
  const takeaways = (c.pages || []).flatMap((p) => (p.sections || []).map((s) => s.takeaway).filter(Boolean));
  const lastClosing = c.pages?.[c.pages.length - 1]?.closing;
  const summary = c.cover?.summary || lastClosing || '';
  return (
    `<div class="sec-label">${esc(L.recap)}</div>` +
    (summary ? `<h2 class="end-h" data-qa-text>${md(summary)}</h2>` : '') +
    `<ol class="end-list${takeaways.length > 9 ? ' dense' : ''}" data-shrink>${takeaways
      .map((t, i) => `<li><i>${pad2(i + 1)}</i><span data-qa-text>${md(t)}</span></li>`)
      .join('')}</ol>` +
    `<div class="end-src"${drop(1, '来源说明')}>${md(footnote)}</div>` + endBrand(brand) +
    `<div class="end-cta"${drop(2, '收藏提示')}>${esc(c.cover?.cta || brand?.follow || L.cta)}</div>`
  );
}

/**
 * Build one HTML document holding every card in a grid (also used as a contact sheet).
 * ctx: { content, brand, themeCss, componentsCss, layoutCss, nAcc, ratio, form, covers }
 *   form    '' (the full set) | 'quotes' | 'onepage' | 'qa'  — lighter stand-alone forms from the same content
 *   covers  array of cover objects: draw only the cover, once per variant (for choosing between them)
 */
export function coverVariants(c) {
  const cover = c.cover || {};
  if (Array.isArray(cover.alts) && cover.alts.length) return [cover, ...cover.alts.map((a) => ({ ...cover, ...a }))].map(({ alts, ...cv }) => cv);
  const has = { number: !!cover.number?.value, versus: !!(cover.versus?.left && cover.versus?.right), image: !!coverIllustrationSrc(c) };
  return COVER_STYLES.filter((st) => has[st] !== false).map((style) => ({ ...cover, alts: undefined, style }));
}

export function buildCards(ctx) {
  const { content: c, brand, themeCss, componentsCss, layoutCss, nAcc } = ctx;
  const R = ratioSpec(ctx.ratio || '3:4');
  const lang = c.lang === 'en' ? 'en' : 'zh';
  const L = { ...LABELS[lang], ...CL[lang] };
  const full = planCards(c, R.key, ctx.budgetAdjust || 0);
  const plan = ctx.covers ? ctx.covers.map((cover) => ({ kind: 'cover', cover })) : ctx.form ? planCards(c, R.key, ctx.budgetAdjust || 0, ctx.form) : full;
  const total = plan.length;
  const chip = brandChip(brand);
  const series = c.series || brand.series || '';
  const editor = brand.editor || (lang === 'zh' ? '编者' : 'the editor');
  const footnote = c.footnote || (c.source ? L.footnote(c.source, editor, hasIllustrations(c)) : '');
  const credit = c.source ? L.credit(c.source) : '';
  const brandLine = [brand.name, brand.handle].filter(Boolean).join(' ');
  // When the piece is the brand owner's own, the source credit already names them.
  const brandFoot = credit && ((brand.handle && credit.includes(brand.handle)) || (brand.name && credit.includes(brand.name))) ? '' : brandLine;

  const cards = plan.map((it, i) => {
    const idx = i + 1;
    const base = { idx, total, series, foot: credit, kind: it.kind };
    switch (it.kind) {
      case 'cover': {
        // A cover variant shows the real set's card count in its kicker and has no "01 / 18" of its own.
        const cc = it.cover ? { ...c, cover: it.cover } : c;
        const st = coverStyle(cc);
        return frame(coverCard(cc, L, full.length), { ...base, total: it.cover ? 1 : total, cls: `c-cover ${st === 'toc' ? 'cv-contents' : `cv-${st}`}`, acc: accVar(0, nAcc), foot: [credit, chip ? '' : brandFoot].filter(Boolean).join('　'), deco: st === 'image' ? '' : COVER_DECO, chip });
      }
      case 'quote':
        return frame(`<div class="sec-label">${esc(L.quote)}${total > 1 ? ` · ${pad2(idx)}` : ''}</div>` + quoteOnlyCard(it, c), { ...base, cls: 'c-sec c-quote', acc: accVar(it.k, nAcc), foot: brandLine || credit, chip });
      case 'onepage':
        return frame(onepageCard(c, L), { ...base, cls: 'c-onepage', acc: accVar(0, nAcc), foot: [credit, chip ? '' : brandFoot].filter(Boolean).join('　'), deco: COVER_DECO, chip });
      case 'qa':
        return frame(qaCard(it, c, L, i === 0), { ...base, cls: 'c-qa', acc: accVar(i, nAcc), foot: [credit, brandFoot].filter(Boolean).join('　'), chip: i === 0 ? chip : '' });
      case 'sec': {
        const st = it.part === 2 ? '' : cardStyle(it.s);
        return frame(secCard(it, L), { ...base, cls: `c-sec${it.part === 2 ? ' c-sec-2' : ''}${st ? ` c-${st}` : ''}`, acc: accVar(it.k, nAcc) });
      }
      case 'stages':
        return frame(stagesCard(it, L, nAcc), { ...base, cls: 'c-list', acc: accVar(it.k, nAcc) });
      case 'guard':
        return frame(guardCard(it, L), { ...base, cls: 'c-list', acc: accVar(it.k, nAcc) });
      case 'end':
        return frame(endCard(c, L, footnote, brand), { ...base, cls: 'c-end', acc: accVar(0, nAcc), foot: brandLine || credit });
    }
    return '';
  });

  const html = `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<title>${esc(plain(c.title).replace(/\n/g, ' '))} · cards</title>
<style>${componentsCss}</style>
<style>${layoutCss}</style>
<style>${themeCss}</style>
</head><body><main class="sheet r-${R.slug}" style="--card-w:${R.w}px;--card-h:${R.h}px">
${cards.join('\n')}
</main>
<script>
// Fit each card (also runs when this file is opened directly; safe to call again):
// 1) scale every figure to the space its card leaves for it, measured on what is actually drawn
//    (a short comparison no longer floats in the middle of a tall, empty canvas);
// 2) if the card still overflows, or its figure would be too small to read, hide optional
//    elements ([data-drop]) in ascending order and record what was dropped in data-dropped;
// 3) if the card has room left, use it: larger type (.roomy), then optional extras ([data-fill]);
// 4) shrink the figure panel to its figure and spread what is left between the blocks.
window.__fit = function () {
  var MAXZ = 1.7;
  // Bounds of what a figure draws, relative to its (untransformed) canvas.
  function drawn(cv) {
    cv.style.transform = 'none';
    var c = cv.getBoundingClientRect(), l = 1e9, t = 1e9, r = -1e9, b = -1e9;
    cv.querySelectorAll('*').forEach(function (el) {
      var solid = el.matches('.box, .cmp-col, .hb-row, .hb-axis, img, .ill-missing, .fx-note, .p-card');
      if (!solid && (el.children.length || el.tagName.toLowerCase() === 'svg')) return;
      var e = el.getBoundingClientRect();
      if (e.width < 1 || e.height < 1) return;
      l = Math.min(l, e.left); t = Math.min(t, e.top); r = Math.max(r, e.right); b = Math.max(b, e.bottom);
    });
    if (r < l) return { x: 0, y: 0, w: c.width, h: c.height };
    var pad = 5;
    l = Math.max(c.left, l - pad); t = Math.max(c.top, t - pad); r = Math.min(c.right, r + pad); b = Math.min(c.bottom, b + pad);
    return { x: l - c.left, y: t - c.top, w: r - l, h: b - t };
  }
  function scale(root) {
    root.querySelectorAll('.c-fig-box').forEach(function (box) {
      var cv = box.querySelector('.fig-canvas');
      if (!cv) return;
      var bw = box.clientWidth, bh = box.clientHeight;
      if (!bw || !bh) { box.dataset.scale = '0'; return; }
      var d = drawn(cv);
      var z = Math.max(0.3, Math.min(MAXZ, bw / d.w, bh / d.h));
      cv.style.transform = 'translate(' + ((bw - d.w * z) / 2 - d.x * z).toFixed(1) + 'px, ' + ((bh - d.h * z) / 2 - d.y * z).toFixed(1) + 'px) scale(' + z.toFixed(3) + ')';
      box.dataset.scale = z.toFixed(2);
      box.dataset.need = Math.ceil(d.h * z);
      box.dataset.wide = (z >= Math.min(MAXZ, bw / d.w) - 0.02) ? '1' : '';
    });
  }
  // One-line rows (big numbers): shrink the number until the row fits its width.
  function fitLines(root) {
    root.querySelectorAll('[data-fit-line]').forEach(function (row) {
      var b = row.querySelector('b');
      b.style.fontSize = '';
      var size = parseFloat(getComputedStyle(b).fontSize);
      while (size > 30 && row.scrollWidth > row.clientWidth + 1) { size -= 3; b.style.fontSize = size + 'px'; }
    });
  }
  document.querySelectorAll('.card').forEach(function (card) {
    var body = card.querySelector('.c-body');
    var over = function () { return body.scrollHeight > body.clientHeight + 1; };
    var drops = Array.prototype.slice.call(card.querySelectorAll('[data-drop]'));
    var fills = Array.prototype.slice.call(card.querySelectorAll('[data-fill]'));
    // Reset everything an earlier run changed.
    card.classList.remove('roomy');
    body.style.gap = '';
    drops.forEach(function (e) { e.hidden = false; });
    fills.forEach(function (e) { e.hidden = true; });
    card.querySelectorAll('.c-fig').forEach(function (f) { var fc = f.querySelector('.c-fig-card'); f.style.flex = ''; fc.style.flex = ''; fc.style.height = ''; });
    card.querySelectorAll('[data-fit-lines]').forEach(function (e) { e.style.fontSize = ''; });
    drops.sort(function (a, b) { return a.dataset.drop - b.dataset.drop; });
    fills.sort(function (a, b) { return a.dataset.fill - b.dataset.fill; });
    fitLines(card);

    // Cover title: as large as possible while keeping the author's line breaks.
    var t = card.querySelector('.cv-title');
    if (t) {
      t.style.fontSize = '';
      var want = t.querySelectorAll('br').length + 1;
      var size = parseFloat(getComputedStyle(t).fontSize);
      var lh = function () { return parseFloat(getComputedStyle(t).lineHeight) || size * 1.16; };
      while (size > 36 && t.getBoundingClientRect().height > want * lh() + 2) { size -= 2; t.style.fontSize = size + 'px'; }
    }
    // Full-card sentences: as large as possible while keeping their line breaks and fitting the card.
    card.querySelectorAll('[data-fit-lines]').forEach(function (e) {
      var want = e.querySelectorAll('br').length + 1;
      var size = parseFloat(getComputedStyle(e).fontSize);
      var lh = function () { return parseFloat(getComputedStyle(e).lineHeight) || size * 1.3; };
      while (size > 26 && (e.getBoundingClientRect().height > want * lh() + 2 || over())) { size -= 2; e.style.fontSize = size + 'px'; }
    });

    // A cover gives up headline size (down to 70%) before it drops its subtitle or points.
    if (t && over()) {
      var t0 = parseFloat(getComputedStyle(t).fontSize), tmin = t0 * 0.7;
      while (over() && parseFloat(t.style.fontSize || t0) > tmin) t.style.fontSize = (parseFloat(t.style.fontSize || t0) - 2) + 'px';
    }
    scale(card);
    var box = card.querySelector('.c-fig-box');
    var shown = function () { return box && !box.closest('[hidden]'); };
    function bad() { return over() || !!(shown() && Number(box.dataset.scale) < 1); }
    // First try compacting ([data-shrink] → .shrink), then start dropping.
    var shr = card.querySelectorAll('[data-shrink]');
    shr.forEach(function (e) { e.classList.remove('shrink'); });
    if (bad()) shr.forEach(function (e) { e.classList.add('shrink'); });
    var dropped = [];
    for (var i = 0; i < drops.length && bad(); i++) {
      drops[i].hidden = true;
      dropped.push(drops[i].dataset.dropName);
      scale(card);
    }
    card.dataset.dropped = dropped.join('、');
    // A cover whose headline still does not fit gives up type size last.
    if (t) { var ts = parseFloat(getComputedStyle(t).fontSize); while (ts > 30 && over()) { ts -= 2; t.style.fontSize = ts + 'px'; } }

    // Room left? A figure at full width with spare height, or a text card with spare height.
    var spare = function () {
      if (shown()) return box.dataset.wide ? box.clientHeight - Number(box.dataset.need) : 0;
      var last = body.lastElementChild, first = body.firstElementChild;
      if (!last || !first) return 0;
      var used = 0;
      Array.prototype.forEach.call(body.children, function (c) { if (!c.hidden) used += c.getBoundingClientRect().height; });
      return body.clientHeight - used - parseFloat(getComputedStyle(body).paddingTop) - (body.children.length - 1) * parseFloat(getComputedStyle(body).rowGap || 0);
    };
    var keeps = function () { scale(card); return !bad() && (!shown() || !!box.dataset.wide); };
    if (!dropped.length && !card.classList.contains('c-cover') && spare() > 44) {
      card.classList.add('roomy');
      if (!keeps()) { card.classList.remove('roomy'); scale(card); }
    }
    if (!dropped.length) {
      for (var j = 0; j < fills.length && spare() > 40; j++) {
        fills[j].hidden = false;
        if (!keeps()) { fills[j].hidden = true; scale(card); break; }
      }
    }
    // Figure panel hugs its figure; leftover height goes between the blocks (up to 2.4x the normal gap).
    if (shown() && box.dataset.wide) {
      var fig = box.closest('.c-fig'), fc = fig.querySelector('.c-fig-card');
      var extra = box.clientHeight - Number(box.dataset.need);
      if (extra > 6) {
        fc.style.height = (fc.getBoundingClientRect().height - extra) + 'px';
        fc.style.flex = 'none';
        fig.style.flex = 'none';
        scale(card);
      }
    }
    if (!card.classList.contains('c-cover')) {
      var n = 0;
      Array.prototype.forEach.call(body.children, function (c) { if (!c.hidden) n++; });
      var gap = parseFloat(getComputedStyle(body).rowGap || 0), sp = spare();
      if (shown()) { var u = 0; Array.prototype.forEach.call(body.children, function (c) { if (!c.hidden) u += c.getBoundingClientRect().height; }); sp = body.clientHeight - u - parseFloat(getComputedStyle(body).paddingTop) - (n - 1) * gap; }
      var inner = Math.max(0, card.querySelectorAll('.c-stage').length - 1); // .c-stages inherits the gap
      if (n + inner > 1 && sp > 4) body.style.gap = Math.min(gap * 2.4, gap + sp / (n - 1 + inner)).toFixed(1) + 'px';
      if (over()) body.style.gap = '';
    }
    // How much of an ordinary content card its content actually covers (full-card variants are meant to be airy).
    card.dataset.fill = '';
    if (card.classList.contains('c-sec') && !card.matches('.c-quote, .c-number, .c-image')) {
      var used2 = 0;
      Array.prototype.forEach.call(body.children, function (c) {
        if (c.hidden) return;
        var fc2 = c.querySelector && c.querySelector('.c-fig-box');
        // A figure counts for what it draws, not for the box it was given.
        used2 += fc2 && fc2.dataset.need ? c.getBoundingClientRect().height - fc2.clientHeight + Number(fc2.dataset.need) : c.getBoundingClientRect().height;
      });
      card.dataset.fill = (used2 / (body.clientHeight - parseFloat(getComputedStyle(body).paddingTop))).toFixed(2);
    }
  });
};
window.__fit();
document.fonts.ready.then(window.__fit);
</script>
</body></html>`;
  return { html, count: total, styles: ctx.covers ? plan.map((it) => coverStyle({ ...c, cover: it.cover })) : null };
}

// 小红书 titles are capped at 20 characters. Count every character as 1 (letters and spaces too)
// and cut at a natural break rather than mid-word.
export const xhsLen = (t) => [...String(t || '')].length;
function autoTitle(t) {
  const s = plain(t).replace(/\n/g, '').trim();
  if (xhsLen(s) <= 20) return s;
  const ch = [...s].slice(0, 20);
  // Prefer punctuation boundaries, then whitespace.
  for (const re of [/[：:，,、·—|｜]/, /\s/]) {
    for (let i = ch.length - 1; i >= 8; i--) if (re.test(ch[i])) return ch.slice(0, i).join('').trim();
  }
  return ch.slice(0, 19).join('') + '…';
}

/** Text for the 小红书 post itself (title, body, tags). */
export function buildCaption(c, count) {
  const x = c.xhs || {};
  const title = x.title || autoTitle(c.cover?.title || c.title);
  let body = x.caption;
  if (!body) {
    const heads = (c.pages || []).flatMap((p) => (p.sections || []).map((s) => plain(s.heading).replace(/\n/g, '')));
    body = [plain(c.pages?.[0]?.intro || ''), '', ...heads.map((h, i) => `${pad2(i + 1)} ${h}`)].join('\n');
  }
  // 小红书 hashtags end at whitespace, so strip it inside each tag.
  const tags = (x.tags || []).map((t) => '#' + String(t).replace(/^#/, '').replace(/\s+/g, '')).join(' ');
  // Hand-written captions credit the author themselves; only the auto summary gets a source line.
  const src = !x.caption && c.source
    ? `内容整理自 ${[c.source.author, c.source.handle && `（${c.source.handle}）`].filter(Boolean).join('')}${c.source.title ? `《${c.source.title}》` : ''}`
    : '';
  return [
    '# 标题', '', title, '',
    '# 正文', '', body.trim(), '', src, '', tags, '',
    '---', `图片：card-01.png … card-${pad2(count)}.png，按顺序上传。`,
    x.caption ? '' : '（正文为自动生成：建议在 content.json 的 xhs 字段里写一版更适合小红书的文案。）',
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
