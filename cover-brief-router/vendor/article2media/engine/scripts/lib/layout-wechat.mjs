// "wechat" layout: a 公众号 article that can be pasted into the mp.weixin.qq.com editor.
//
// The editor drops <style>, classes, ids, external CSS, web fonts and scripts, so the pipeline is:
//   1. build a "source" page with classes (components.css + wechat.css + theme CSS), so every theme restyles it;
//   2. in headless Chrome, screenshot each figure card to a PNG;
//   3. inlineInPage(): copy the computed styles of every element into style="" (colors normalised to rgb,
//      web fonts removed from font stacks, static ::before/::after content turned into real spans),
//      and replace figure cards with <img> placeholders;
//   4. swap the placeholders for base64 data URIs and wrap the result in a preview page with a copy button.
import { esc, md, pad2, plain } from './markup.mjs';
import { renderFigure } from './figures.mjs';
import { LABELS, accVar, hasIllustrations } from './layout-long.mjs';
import { coverIllustrationSrc, coverIllustrationAspect } from './illustrations.mjs';
import { COVER_DECO } from './layout-card.mjs';

export const WX_LABELS = {
  zh: {
    toc: '本文要点',
    source: (s) => `原文：${[s.author && `${s.author}${s.handle ? `（${s.handle}）` : ''}`, s.platform, s.date].filter(Boolean).join(' · ')}`,
    link: '原文链接：',
    guard: '护栏',
    copy: '复制到公众号',
    copied: '已复制，去公众号编辑器粘贴（Ctrl/⌘ + V）',
    failed: '复制失败：请手动全选下方正文后复制',
  },
  en: {
    toc: 'Inside',
    source: (s) => `Source: ${[s.author && `${s.author}${s.handle ? ` (${s.handle})` : ''}`, s.platform, s.date].filter(Boolean).join(' · ')}`,
    link: 'Original: ',
    guard: 'Guardrails',
    copy: 'Copy for WeChat',
    copied: 'Copied — paste into the WeChat editor',
    failed: 'Copy failed — select the article below and copy manually',
  },
};

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, (m, i, s) => (/[A-Za-z0-9]/.test(s[i - 1] || '') || /[A-Za-z0-9]/.test(s[i + m.length] || '') ? ' ' : ''));

export function wechatMeta(c) {
  const w = c.wechat || {};
  const title = w.title || oneLine(plain(c.cover?.title && !c.title ? c.cover.title : c.title));
  const firstIntro = plain(c.pages?.[0]?.intro || '');
  const digest = w.digest || (firstIntro.length > 120 ? firstIntro.slice(0, 117) + '……' : firstIntro);
  return { title, digest, author: w.author || '' };
}

function figure(f, id, L) {
  return (
    `<section class="wx-fig">` +
    `<section class="fig-card" data-fig="${id}" data-shot="fig-${id}"><div class="fig-id">${L.fig} ${id}</div><div class="fig-canvas">${renderFigure(f)}</div></section>` +
    (f.caption ? `<p class="fig-cap">${md(f.caption)}</p>` : '') +
    `</section>`
  );
}

function panel(p) {
  if (!p) return '';
  const title = p.title ? `<p class="p-title">${md(p.title)}</p>` : '';
  if (p.type === 'table') {
    return `<section class="panel wx-panel p-table">${title}<table class="wx-table"><tbody>${(p.rows || [])
      .map((r) => `<tr><td class="wx-k">${md(r[0])}</td><td class="wx-v">${md(r[1])}</td></tr>`)
      .join('')}</tbody></table></section>`;
  }
  if (p.type === 'cards') {
    return `<section class="panel wx-panel p-cards">${title}${(p.items || [])
      .map((it) => `<section class="p-card"><p class="t">${md(it.title)}</p>${it.text ? `<p class="x">${md(it.text)}</p>` : ''}</section>`)
      .join('')}</section>`;
  }
  if (p.type === 'quote') {
    return `<section class="panel wx-panel p-quote">${title}<section class="q">${md(p.text)}</section>${p.note ? `<p class="n">${md(p.note)}</p>` : ''}</section>`;
  }
  return '';
}

function standard(s, num, k, nAcc, L) {
  return (
    `<section class="wx-sec acc" style="--acc:${accVar(k, nAcc)}">` +
    `<p class="sec-label">${pad2(num)} / ${md(s.label || '')}</p>` +
    `<p class="sec-h">${md(s.heading)}</p>` +
    (s.paragraphs || []).map((p) => `<p class="wx-p">${md(p)}</p>`).join('') +
    (s.bullets || []).map((b) => `<p class="wx-li"><span class="wx-dot">●</span>${md(b)}</p>`).join('') +
    (s.figures || []).slice(0, 2).map((f, j) => figure(f, `${num}${'AB'[j]}`, L)).join('') +
    panel(s.panel) +
    (s.takeaway ? `<p class="sec-take wx-take">${md(s.takeaway)}</p>` : '') +
    `</section>`
  );
}

function checklist(s, num, k, nAcc, L, W) {
  const stages = (s.stages || [])
    .map((st, j) =>
      `<section class="cl-card wx-cl acc" style="--acc:${accVar(k + j, nAcc)}">` +
      `<p class="cl-label">${md(st.label || '')}</p><p class="cl-title">${md(st.title)}</p>` +
      (st.items || []).map((it) => `<p class="wx-check"><span class="wx-box">☐</span>${md(it)}</p>`).join('') +
      (st.done ? `<p class="cl-done"><b>${esc(L.done)}</b>${md(st.done)}</p>` : '') +
      `</section>`)
    .join('');
  const g = s.guard;
  const guard = g
    ? `<section class="cl-card cl-guard wx-cl">` +
      `<p class="cl-label">${md(g.label || W.guard)}</p><p class="cl-title">${md(g.title)}</p>` +
      (g.items || []).map((it) => `<p class="wx-check"><span class="cl-x">✕</span>${md(it)}</p>`).join('') +
      (g.note ? `<p class="cl-guard-note">${md(g.note)}</p>` : '') +
      `</section>`
    : '';
  return (
    `<section class="wx-sec acc" style="--acc:${accVar(k, nAcc)}">` +
    `<p class="sec-label">${pad2(num)} / ${md(s.label || '')}</p>` +
    `<p class="sec-h">${md(s.heading)}</p>` +
    (s.paragraphs || []).map((p) => `<p class="wx-p">${md(p)}</p>`).join('') +
    stages + guard +
    (s.note ? `<p class="cl-note">${md(s.note)}</p>` : '') +
    `</section>`
  );
}

/** Source page (with classes) that the browser lays out and screenshots. */
export function buildWechatSource(ctx) {
  const { content: c, brand, themeCss, componentsCss, wechatCss, nAcc } = ctx;
  const lang = c.lang === 'en' ? 'en' : 'zh';
  const L = LABELS[lang];
  const W = WX_LABELS[lang];
  const editor = brand.editor || (lang === 'zh' ? '编者' : 'the editor');
  const footnote = c.footnote || (c.source ? L.footnote(c.source, editor, hasIllustrations(c)) : '');

  let num = 0;
  const headings = [];
  const body = (c.pages || [])
    .map((pg, pi) => {
      const firstK = num;
      const secs = (pg.sections || [])
        .map((s) => {
          num += 1;
          headings.push(oneLine(plain(s.heading)));
          return s.kind === 'checklist' ? checklist(s, num, num - 1, nAcc, L, W) : standard(s, num, num - 1, nAcc, L);
        })
        .join('');
      return (
        (pg.part ? `<section class="wx-part acc" style="--acc:${accVar(firstK, nAcc)}"><span class="wx-part-t">${md(pg.part)}</span></section>` : '') +
        (pi > 0 && pg.intro ? `<p class="wx-intro">${md(pg.intro)}</p>` : '') +
        secs +
        (pg.closing ? `<p class="pg-closing wx-closing">${md(pg.closing)}</p>` : '')
      );
    })
    .join('');

  const points = c.cover?.points?.length ? c.cover.points : headings;
  const toc = points.length
    ? `<section class="panel wx-toc acc" style="--acc:${accVar(0, nAcc)}"><p class="p-title">${esc(W.toc)}</p>${points
        .map((t, i) => `<p class="wx-toc-i"><span class="wx-toc-n">${pad2(i + 1)}</span>${md(t)}</p>`)
        .join('')}</section>`
    : '';
  const intro = c.pages?.[0]?.intro ? `<p class="wx-lead">${md(c.pages[0].intro)}</p>` : '';
  const meta = c.source ? `<p class="wx-meta">${esc(W.source(c.source))}</p>` : '';
  const heroSrc = coverIllustrationSrc(c);
  const hero = heroSrc ? `<section class="wx-hero" data-shot="hero"><img src="${esc(heroSrc)}" style="aspect-ratio:${coverIllustrationAspect(c)}" alt=""></section>` : '';
  const end =
    `<section class="wx-end">` +
    (footnote ? `<p class="wx-foot">${md(footnote)}</p>` : '') +
    (c.source?.url ? `<p class="wx-foot">${esc(W.link)}${esc(c.source.url)}</p>` : '') +
    (brand.name ? `<p class="wx-brand">${md([brand.name, brand.handle].filter(Boolean).join(' '))}</p>` : '') +
    `</section>`;

  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<title>${esc(wechatMeta(c).title)} · wechat source</title>
<style>${componentsCss}</style>
<style>${wechatCss}</style>
<style>${themeCss}</style>
</head><body>
<section class="wx acc" id="wx" style="--acc:${accVar(0, nAcc)}">${hero}${meta}${intro}${toc}${body}${end}</section>
</body></html>`;
}

/** Cover images for the article list: 2.35:1 头图 and a 1:1 thumbnail, drawn with the card cover styles. */
export function buildWechatCovers(ctx) {
  const { content: c, themeCss, componentsCss, cardCss, nAcc } = ctx;
  const lang = c.lang === 'en' ? 'en' : 'zh';
  const kicker = c.wechat?.kicker ?? (c.series || '');
  const wideTitle = c.wechat?.coverTitle || c.title;
  const squareTitle = c.cover?.title || c.title;
  const ill = coverIllustrationSrc(c);
  const box = (id, w, h, title, cls, withIll) =>
    `<div class="card c-cover wx-cover ${cls}${withIll ? ' has-ill' : ''}" id="${id}" style="--card-w:${w}px;--card-h:${h}px;--acc:${accVar(0, nAcc)}">` + (withIll ? '' : COVER_DECO) +
    `<div class="c-body">${kicker ? `<div class="cv-kicker">${md(kicker)}</div>` : ''}<h1 class="cv-title">${md(title)}</h1><div class="cv-rule"></div></div>` +
    (withIll ? `<div class="wx-cover-ill"><img src="${esc(ill)}" style="aspect-ratio:${coverIllustrationAspect(c)}" alt=""></div>` : '') +
    `</div>`;
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><title>wechat covers</title>
<style>${componentsCss}</style>
<style>${cardCss}</style>
<style>
.wx-covers { display: flex; gap: 24px; padding: 24px; align-items: flex-start; }
.wx-cover .c-body { justify-content: center; padding-top: 0 !important; gap: 0; position: relative; z-index: 1; }
.wx-cover.wide:not(.has-ill) .c-body { max-width: 59%; }
.wx-cover.wide { padding: 34px 56px; }
.wx-cover.square { padding: 30px 30px; }
.wx-cover .cv-rule { margin: 18px 0 0 !important; }
.wx-cover .cv-title { margin-top: 10px; }
.wx-cover.has-ill .c-body { max-width: 58%; position: relative; z-index: 1; }
.wx-cover-ill { position: absolute; right: 34px; top: 26px; bottom: 26px; width: 38%; }
</style>
<style>${themeCss}</style>
</head><body><main class="wx-covers">
${box('cv-wide', 900, 383, wideTitle, 'wide', !!ill)}
${box('cv-square', 383, 383, squareTitle, 'square', false)}
</main>
<script>
// Largest title that keeps the author's line breaks and fits the box; a title without breaks may wrap to 3 lines (4 on 1:1).
document.querySelectorAll('.wx-cover').forEach(function (card) {
  var t = card.querySelector('.cv-title'), body = card.querySelector('.c-body');
  var breaks = t.querySelectorAll('br').length;
  var want = breaks ? breaks + 1 : (card.classList.contains('wide') ? 3 : 4);
  var size = card.classList.contains('wide') ? 64 : 46;
  t.style.fontSize = size + 'px';
  var lh = function () { return parseFloat(getComputedStyle(t).lineHeight) || size * 1.16; };
  while (size > 20 && (t.getBoundingClientRect().height > want * lh() + 2 || body.scrollHeight > body.clientHeight + 1)) {
    size -= 2; t.style.fontSize = size + 'px';
  }
});
</script>
</body></html>`;
}

/**
 * Runs inside the source page. Returns paste-ready HTML (inline styles only) with
 * <img data-wx-fig="ID"> placeholders where the figure cards were.
 */
export function inlineInPage() {
  const root = document.getElementById('wx');
  const webFonts = new Set([...document.fonts].map((f) => f.family.replace(/^["']|["']$/g, '').toLowerCase()));
  const SERIF = "'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', serif";
  const SANS = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
  const MONO = "Menlo, Consolas, 'Courier New', monospace";

  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function color(c) {
    if (!c || /^rgba?\(/.test(c) || c === 'transparent') return c;
    if (colorCache.has(c)) return colorCache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const out = a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    colorCache.set(c, out);
    return out;
  }
  // Normalise every color token inside a value (gradients, shadows, borders).
  const colorsIn = (v) => v.replace(/(?:color|oklch|oklab|lab|lch|hwb|hsla?)\([^()]*(?:\([^()]*\)[^()]*)*\)/g, (m) => color(m));

  function fontFamily(v) {
    const fams = v.split(',').map((s) => s.trim()).filter(Boolean);
    const kept = fams.filter((f) => !webFonts.has(f.replace(/^["']|["']$/g, '').toLowerCase()));
    const generic = kept.find((f) => /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/.test(f));
    const named = kept.filter((f) => f !== generic);
    const wasSerif = generic === 'serif' || (!generic && /serif|song|ming|kai/i.test(fams[0] || '') && !/sans/i.test(fams[0] || ''));
    const base = generic === 'monospace' ? MONO : wasSerif ? SERIF : SANS;
    return named.length ? `${named.join(', ')}, ${base}` : base;
  }

  const INHERITED = ['color', 'font-size', 'font-weight', 'font-style', 'font-family', 'line-height', 'letter-spacing', 'text-align', 'text-indent'];
  const BLOCK_TEXT = new Set(['P', 'SECTION', 'TD']);
  const BOX = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const RADII = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];

  function decl(cs, parentCs, tag, isRoot, sized = false) {
    const out = [];
    // Gradient text (background-clip: text) can't be pasted: use the gradient's first color as a solid color.
    const clipped = cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
    const clipText = clipped ? (colorsIn(cs.backgroundImage).match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/i) || [color(cs.color)])[0] : null;
    const put = (k, v) => out.push(`${k}: ${v}`);
    const display = cs.display;
    if (display !== (tag === 'SPAN' || tag === 'B' ? 'inline' : 'block') && !/^table/.test(display) && display !== 'list-item') {
      put('display', display === 'flex' ? 'block' : display === 'inline-flex' ? 'inline-block' : display);
    }
    for (const p of INHERITED) {
      let v = cs.getPropertyValue(p);
      const pv = parentCs ? parentCs.getPropertyValue(p) : null;
      const always = isRoot || (BLOCK_TEXT.has(tag) && ['color', 'font-size', 'line-height'].includes(p));
      if (!always && v === pv) continue;
      if (p === 'color') v = color(v);
      if (p === 'font-family') {
        if (!isRoot && pv && fontFamily(v) === fontFamily(pv)) continue;
        v = fontFamily(v);
      }
      if (p === 'letter-spacing' && v === 'normal' && !isRoot) continue;
      if (p === 'text-indent' && v === '0px' && (!pv || pv === '0px')) continue;
      if (p === 'color' && clipText) v = clipText;
      if (p === 'text-align' && (v === 'start' || v === 'left') && !isRoot && pv && (pv === 'start' || pv === 'left')) continue;
      put(p, v);
    }
    const bg = cs.backgroundColor;
    if (!clipped && bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') put('background-color', color(bg));
    const bgi = cs.backgroundImage;
    if (!clipped && bgi && bgi !== 'none' && !/url\(/.test(bgi) && /gradient/.test(bgi)) {
      put('background-image', colorsIn(bgi));
      if (cs.backgroundSize !== 'auto') put('background-size', cs.backgroundSize);
      if (cs.backgroundRepeat !== 'repeat') put('background-repeat', cs.backgroundRepeat);
      if (cs.backgroundPosition !== '0% 0%') put('background-position', cs.backgroundPosition);
    }
    for (const p of BOX) {
      const v = cs.getPropertyValue(p);
      if (v && v !== '0px' && v !== 'auto') put(p, v);
    }
    const table = tag === 'TD' || tag === 'TABLE' || tag === 'TR';
    for (const sd of SIDES) {
      const w = cs.getPropertyValue(`border-${sd}-width`);
      const st = cs.getPropertyValue(`border-${sd}-style`);
      if (w !== '0px' && st !== 'none') put(`border-${sd}`, `${w} ${st} ${color(cs.getPropertyValue(`border-${sd}-color`))}`);
      else if (table) put(`border-${sd}`, 'none');
    }
    const radii = RADII.map((r) => cs.getPropertyValue(r));
    if (radii.some((r) => r !== '0px')) put('border-radius', radii.every((r) => r === radii[0]) ? radii[0] : radii.join(' '));
    if (cs.boxShadow && cs.boxShadow !== 'none') put('box-shadow', colorsIn(cs.boxShadow));
    if (cs.textDecorationLine && cs.textDecorationLine !== 'none') put('text-decoration', `${cs.textDecorationLine} ${color(cs.textDecorationColor)}`);
    if (Number(cs.opacity) < 1) put('opacity', cs.opacity);
    if (cs.verticalAlign && cs.verticalAlign !== 'baseline' && !table) put('vertical-align', cs.verticalAlign);
    if (tag === 'TABLE') { put('width', '100%'); put('border-collapse', 'collapse'); }
    if (tag === 'IMG') { put('max-width', '100%'); put('height', 'auto'); }
    if (tag === 'TD' && cs.getPropertyValue('--wx-w').trim()) put('width', cs.getPropertyValue('--wx-w').trim());
    // Only empty decorative boxes (dots, squares) keep a size; text boxes size themselves in the editor.
    if (sized && (display === 'inline-block' || /^block/.test(display))) {
      if (cs.width !== 'auto' && parseFloat(cs.width) < 80) put('width', cs.width);
      if (cs.height !== 'auto' && parseFloat(cs.height) < 80 && parseFloat(cs.height) > 0) put('height', cs.height);
    }
    if (isRoot || /^(SECTION|P)$/.test(tag)) {
      if (cs.wordBreak && cs.wordBreak !== 'normal') put('word-break', cs.wordBreak);
    }
    return out.join('; ');
  }

  // A static ::before/::after with string content becomes a real span (e.g. 「」 quotes, "SC." prefixes).
  function pseudoSpan(el, which, cs) {
    const ps = getComputedStyle(el, which);
    const content = ps.content;
    if (!content || content === 'none' || content === 'normal' || ps.display === 'none') return null;
    if (ps.position !== 'static' && ps.position !== 'relative') return null;
    const m = content.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (!m) return null;
    const text = m[1].replace(/\\(.)/g, '$1');
    const sized = /inline-block|block/.test(ps.display) && parseFloat(ps.width) > 0 &&
      ((ps.backgroundColor !== 'rgba(0, 0, 0, 0)') || parseFloat(ps.borderTopWidth) > 0);
    if (!text.trim() && !sized) return null;
    const span = document.createElement('span');
    span.textContent = text;
    span.setAttribute('style', decl(ps, cs, 'SPAN', false, !text.trim()));
    return span;
  }

  // Walk the live tree (computed styles exist only there), then apply to a clone in the same order.
  const live = [root, ...root.querySelectorAll('*')];
  const info = live.map((el) => {
    if (el.closest('[data-shot]') && !el.hasAttribute('data-shot')) return null;
    const cs = getComputedStyle(el);
    const parentCs = el === root ? null : getComputedStyle(el.parentElement);
    // Empty decorative boxes and short inline-block markers ("●", "12.") keep their width.
    const text = el.textContent.trim();
    const sized = (!text && !el.querySelector('img')) || (cs.display === 'inline-block' && text.length <= 3 && !el.children.length);
    return {
      style: decl(cs, parentCs, el.tagName, el === root, sized),
      before: pseudoSpan(el, '::before', cs),
      after: pseudoSpan(el, '::after', cs),
      fig: el.getAttribute('data-shot'),
    };
  });

  const clone = root.cloneNode(true);
  const copies = [clone, ...clone.querySelectorAll('*')];
  const replaced = [];
  copies.forEach((el, i) => {
    const it = info[i];
    if (!it) return;
    if (it.fig) {
      const img = document.createElement('img');
      img.setAttribute('data-wx-fig', it.fig);
      img.setAttribute('alt', it.fig.replace(/^fig-/, '图 '));
      img.setAttribute('style', 'display: block; width: 100%; height: auto; margin: 0 auto');
      replaced.push([el, img]);
      return;
    }
    if (it.style) el.setAttribute('style', it.style);
    if (it.before) el.insertBefore(it.before, el.firstChild);
    if (it.after) el.appendChild(it.after);
  });
  for (const [el, img] of replaced) el.replaceWith(img);
  // Drop classes and every data-* attribute (source-block ids, deco marks) except the figure placeholders.
  clone.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (a.name === 'class' || (a.name.startsWith('data-') && a.name !== 'data-wx-fig')) el.removeAttribute(a.name);
  });
  clone.removeAttribute('class');
  clone.removeAttribute('id');
  // <b> → <strong> (the editor keeps both, but strong survives every paste path).
  clone.querySelectorAll('b').forEach((b) => {
    const s = document.createElement('strong');
    for (const a of b.attributes) s.setAttribute(a.name, a.value);
    s.innerHTML = b.innerHTML;
    b.replaceWith(s);
  });
  return clone.outerHTML;
}

/** Preview page: phone-width column, copy button that puts text/html on the clipboard. */
export function buildWechatPreview({ content: c, articleHtml }) {
  const lang = c.lang === 'en' ? 'en' : 'zh';
  const W = WX_LABELS[lang];
  const { title, digest } = wechatMeta(c);
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 公众号排版</title>
<style>
body { margin: 0; background: #ededed; font: 14px/1.5 -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #333; }
.bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap;
  padding: 10px 16px; background: #fff; border-bottom: 1px solid #ddd; }
.bar button { font: inherit; font-weight: 600; color: #fff; background: #07c160; border: 0; border-radius: 6px; padding: 8px 18px; cursor: pointer; }
.bar .msg { color: #07c160; min-width: 1em; }
.phone { width: 390px; max-width: calc(100% - 24px); margin: 20px auto 60px; background: #fff; box-shadow: 0 2px 14px rgba(0,0,0,.08); }
.head { padding: 22px 16px 6px; }
.head h1 { font-size: 22px; line-height: 1.4; margin: 0 0 8px; color: #222; }
.head .d { font-size: 13px; color: #888; margin: 0 0 6px; }
#wx-content { padding: 6px 0 24px; }
</style></head><body>
<div class="bar"><button id="copy">${esc(W.copy)}</button><span class="msg" id="msg"></span></div>
<div class="phone">
<div class="head"><h1>${esc(title)}</h1>${digest ? `<p class="d">摘要：${esc(digest)}</p>` : ''}</div>
<div id="wx-content">${articleHtml}</div>
</div>
<script>
document.getElementById('copy').addEventListener('click', async function () {
  var el = document.getElementById('wx-content'), msg = document.getElementById('msg');
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([el.innerHTML], { type: 'text/html' }),
      'text/plain': new Blob([el.innerText], { type: 'text/plain' })
    })]);
    msg.textContent = ${JSON.stringify(W.copied)};
  } catch (e) {
    try {
      var r = document.createRange(); r.selectNodeContents(el);
      var s = getSelection(); s.removeAllRanges(); s.addRange(r);
      var ok = document.execCommand('copy'); s.removeAllRanges();
      msg.textContent = ok ? ${JSON.stringify(W.copied)} : ${JSON.stringify(W.failed)};
    } catch (e2) { msg.textContent = ${JSON.stringify(W.failed)}; }
  }
});
</script>
</body></html>`;
}

/** Notes for publishing: title, digest, cover files, steps. */
export function buildWechatNotes(c, files) {
  const { title, digest, author } = wechatMeta(c);
  const s = c.source || {};
  return `# 公众号发布信息

## 标题（${title.length} / 64 字）

${title}

## 摘要（${digest.length} / 120 字）

${digest}
${author ? `\n## 作者\n\n${author}\n` : ''}
## 原文

${[s.author, s.title && `《${s.title}》`, s.platform, s.date].filter(Boolean).join('，')}${s.url ? `\n${s.url}` : ''}

## 封面

- 头图（2.35:1）：${files.wide}
- 分享卡片 / 次条封面（1:1）：${files.square}

## 发布步骤

1. 用浏览器打开 article.html，点顶部的「复制到公众号」。
2. 在公众号后台新建图文，把光标放进正文区，粘贴（⌘/Ctrl + V）。图表是内嵌图片，粘贴时编辑器会自动上传。
3. 填标题、摘要，上传上面两张封面图。
4. 如果某张图没有粘过去，从 images/ 目录把对应的图拖进正文即可（文件名就是图号，如 fig-1A.png）。
5. 外链在公众号正文里不能点击，所以原文链接写成了纯文本。
`;
}
