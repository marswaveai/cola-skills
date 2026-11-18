// Original-text cards (image-cards with an article as input): the article, verbatim, flowed into fixed-ratio cards.
//
//   article.md ─ parseBlocks ─▶ blocksHtml (the full-text reading surface) ─▶ flowInPage(): move blocks into cards
//   one by one; a paragraph, quote, code block, list or table that does not fit is split at a line / item / row
//   boundary and continues on the next card (same data-source-block id, joined again by the read-back check).
import { esc } from './markup.mjs';
import { blocksHtml, bylineOf } from './layout-full.mjs';

export function buildCardsArticle({ blocks, meta, spec, fullCss, cardsCss, themeCss, useTheme, images, brand = {} }) {
  const all = blocks.map((b) => b.text || '').join('');
  const cjk = (all.match(/[㐀-鿿豈-﫿]/g) || []).length, latin = (all.match(/[A-Za-z]/g) || []).length;
  const isLatin = latin > 0 && cjk < latin * 0.1;
  const fp = `full-page${isLatin ? ' full-latin' : ''}`;
  const byline = bylineOf(meta);
  const brandLine = [brand.name, brand.handle].filter(Boolean).join(' ');
  const title = meta.title || blocks.find((b) => b.isTitle)?.text || '';
  const hasTitleBlock = blocks[0]?.isTitle;
  return `<!doctype html>
<html lang="${isLatin ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><title>${esc(title || '原文')} · 原文卡片</title>
<style>${fullCss}</style>
${useTheme ? `<style>${themeCss}</style><style>.full-page{--paper:var(--bg);--ink:inherit;--muted:inherit;--rule:inherit;--faint:var(--muted);--accent:var(--acc-text-override, var(--accent-1));--display:var(--font-head);--body:var(--font-body);}</style>` : ''}
<style>${cardsCss}</style>
<style>:root{--card-w:${spec.w}px;--card-h:${spec.h}px}</style>
</head><body>
<template id="ac-tpl"><section class="ac-card ${fp}"><header class="ac-head" data-deco><span class="ac-title">${esc(title)}</span><span class="ac-no"></span></header><main class="full-document ac-body"></main><footer class="ac-foot" data-deco><span class="ac-src">${esc(byline)}</span>${brandLine ? `<span class="ac-brand">${esc(brandLine)}</span>` : ''}</footer></section></template>
<template id="ac-byline"><div class="ac-byline" data-deco>${esc(byline)}<span class="ac-count"></span></div></template>
${hasTitleBlock || !title ? '' : `<template id="ac-cover-title"><h1 class="full-title" data-deco>${esc(title)}</h1></template>`}
<div id="ac-src" class="ac-card ${fp}" style="position:absolute;left:-9999px;top:0;height:auto"><main class="full-document">${blocksHtml(blocks, { images })}</main></div>
<div class="ac-deck ratio-${spec.slug}" id="ac-deck"></div>
</body></html>`;
}

/** Runs in the page: flow the staged blocks into cards. Returns the card boxes and any blocks that could not fit. */
export function flowInPage() {
  const src = document.querySelector('#ac-src .full-document');
  const deck = document.getElementById('ac-deck');
  const tpl = document.getElementById('ac-tpl');
  const cards = [];
  const issues = [];
  const newCard = (cls) => {
    const c = tpl.content.firstElementChild.cloneNode(true);
    if (cls) c.classList.add(cls);
    deck.appendChild(c);
    cards.push(c);
    return c.querySelector('.ac-body');
  };
  const fits = (body) => body.scrollHeight <= body.clientHeight + 1;
  const isHeading = (el) => /^H[1-4]$/.test(el.tagName);
  const items = [...src.children];

  // Cover: the article's own title (a source block), or the front-matter title as decoration, plus the byline.
  const coverTitle = items[0] && items[0].classList.contains('full-title') ? items.shift() : document.getElementById('ac-cover-title')?.content.firstElementChild.cloneNode(true);
  if (coverTitle) {
    const cb = newCard('ac-cover');
    cb.appendChild(coverTitle);
    cb.appendChild(document.getElementById('ac-byline').content.firstElementChild.cloneNode(true));
    // Long titles step down until title + byline fit.
    let size = parseFloat(getComputedStyle(coverTitle).fontSize);
    while (!fits(cb) && size > 26) { size -= 2; coverTitle.style.fontSize = size + 'px'; }
  }

  // ---- splitting helpers ----
  const textNodes = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const out = [];
    let n;
    while ((n = w.nextNode())) if (!n.parentElement.closest('[data-deco]')) out.push(n);
    return out;
  };
  const locate = (nodes, k) => { let i = 0; while (i < nodes.length - 1 && k >= nodes[i].length) { k -= nodes[i].length; i++; } return [nodes[i], k]; };
  const range = document.createRange();
  const charBox = (nodes, k) => {
    const [node, off] = locate(nodes, k);
    if (!node || off >= node.length) return null;
    range.setStart(node, off); range.setEnd(node, off + 1);
    const rs = range.getClientRects();
    for (let i = rs.length - 1; i >= 0; i--) if (rs[i].height) return rs[i];
    return null;
  };
  // Split a text block so that its head ends above `limit`. Returns the continuation element, or null when fewer
  // than `minLines` lines would stay on this card.
  function splitText(el, limit, minLines) {
    const nodes = textNodes(el);
    const total = nodes.reduce((a, n) => a + n.length, 0);
    if (!total) return null;
    const bottomAt = (k) => { for (let j = k; j < total; j++) { const r = charBox(nodes, j); if (r) return r.bottom; } return Infinity; };
    const lineH = parseFloat(getComputedStyle(el).lineHeight) || 36;
    // A glyph box is shorter than its line box: the line reaches half the leading below the glyph.
    const g0 = charBox(nodes, 0);
    const halfLead = g0 ? Math.max(0, (lineH - g0.height) / 2) : 0;
    let lo = 0, hi = total;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bottomAt(mid) + halfLead > limit) hi = mid; else lo = mid + 1; }
    let k = lo;
    if (k <= 0 || k >= total) return null;
    let lines = Math.round((bottomAt(k - 1) - bottomAt(0)) / lineH) + 1;
    // Widow control: never leave a single line to start the next card — break one line earlier instead.
    const tailLines = Math.round((bottomAt(total - 1) - bottomAt(k)) / lineH) + 1;
    if (tailLines < 2 && lines >= Math.max(3, minLines + 1)) {
      const lastTop = bottomAt(k - 1) - lineH / 2;
      let a = 0, b = k - 1;
      while (a < b) { const mid = (a + b) >> 1; if (bottomAt(mid) > lastTop) b = mid; else a = mid + 1; }
      k = a;
      lines -= 1;
    }
    if (lines < minLines) return null;
    const [node, off] = locate(nodes, k);
    const r = document.createRange();
    r.setStart(node, off);
    r.setEnd(el, el.childNodes.length);
    const tail = el.cloneNode(false);
    tail.appendChild(r.extractContents());
    tail.classList.remove('ac-cut', 'opening');
    tail.classList.add('ac-cont');
    el.classList.add('ac-cut');
    return tail;
  }
  function splitList(list, limit) {
    const lis = [...list.children];
    let i = lis.findIndex((li) => li.getBoundingClientRect().bottom > limit);
    if (i < 0) return null;
    const span = lis[i].querySelector('[data-source-block]');
    const tailSpan = span ? splitText(span, limit, i === 0 ? 2 : 1) : null;
    if (!tailSpan && i === 0) return null;
    const rest = list.cloneNode(false);
    if (tailSpan) {
      const li = lis[i].cloneNode(false);
      li.classList.add('ac-cont');
      li.appendChild(tailSpan);
      rest.appendChild(li);
      i++;
    }
    for (const li of lis.slice(i)) rest.appendChild(li);
    return rest;
  }
  function splitTable(wrap, limit) {
    const table = wrap.querySelector('table');
    const rows = [...table.tBodies[0].rows];
    const i = rows.findIndex((tr) => tr.getBoundingClientRect().bottom > limit);
    if (i <= 0) return null;
    const rest = wrap.cloneNode(false), t2 = table.cloneNode(false);
    const head = table.tHead.cloneNode(true);
    head.setAttribute('data-deco', '');
    head.querySelectorAll('[data-source-block]').forEach((c) => c.removeAttribute('data-source-block'));
    const tb = document.createElement('tbody');
    rows.slice(i).forEach((r) => tb.appendChild(r));
    t2.append(head, tb);
    rest.appendChild(t2);
    return rest;
  }

  // ---- flow ----
  let body = newCard();
  let steps = 0;
  while (items.length) {
    // Every step places, splits or moves a block; a runaway loop means a layout bug — stop and report it.
    if (++steps > 50000) { issues.push({ card: cards.length, what: 'flow', text: '分页没有收敛' }); break; }
    const el = items.shift();
    if (el.tagName === 'HR' && !body.children.length) continue; // a section break at the top of a card is the card break
    body.appendChild(el);
    if (fits(body)) continue;
    if (el.tagName === 'HR') { el.remove(); body = newCard(); continue; }
    const limit = body.getBoundingClientRect().top + body.clientHeight - 1;
    const alone = body.children.length === 1;
    let rest = null;
    if (/^(P|BLOCKQUOTE|PRE)$/.test(el.tagName) && el.hasAttribute('data-source-block')) rest = splitText(el, limit, alone ? 1 : 2);
    else if (/^(UL|OL)$/.test(el.tagName)) rest = splitList(el, limit);
    else if (el.classList.contains('full-table')) rest = splitTable(el, limit);
    if (rest) { body = newCard(); items.unshift(rest); continue; }
    if (!alone) {
      // Nothing of it fits here: move it (and any headings right above it) to the next card.
      el.remove();
      const carry = [];
      while (body.children.length > 1 && isHeading(body.lastElementChild)) carry.unshift(body.removeChild(body.lastElementChild));
      body = newCard();
      carry.forEach((c) => body.appendChild(c));
      items.unshift(el);
      continue;
    }
    // Alone on an empty card and still too big.
    if (el.tagName === 'FIGURE') {
      const img = el.querySelector('img');
      const over = body.scrollHeight - body.clientHeight;
      if (img) { img.style.maxHeight = Math.max(160, img.getBoundingClientRect().height - over - 2) + 'px'; }
    }
    if (!fits(body)) issues.push({ card: cards.length, what: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 24) });
    body = newCard();
  }
  // A section break at the bottom of a card is the card break itself; drop it, then any card left empty.
  for (const c of cards) { const b = c.querySelector('.ac-body'); while (b.lastElementChild && b.lastElementChild.tagName === 'HR') b.lastElementChild.remove(); }
  for (let i = cards.length - 1; i >= 0; i--) if (!cards[i].querySelector('.ac-body').children.length) cards.splice(i, 1)[0].remove();
  document.getElementById('ac-src').remove();

  const n = cards.length;
  cards.forEach((c, i) => { c.querySelector('.ac-no').textContent = `${i + 1} / ${n}`; });
  const count = deck.querySelector('.ac-count');
  if (count) count.textContent = document.documentElement.lang === 'en' ? `${n} cards · full text` : `全文 ${n} 张`;
  const boxes = cards.map((c, i) => {
    const r = c.getBoundingClientRect();
    const b = c.querySelector('.ac-body');
    return { idx: i + 1, x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, over: Math.max(0, b.scrollHeight - b.clientHeight) };
  });
  const d = deck.getBoundingClientRect();
  return { boxes, issues, deck: { width: Math.ceil(d.width), height: Math.ceil(d.height) } };
}
