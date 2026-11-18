// 公众号排版 for an article (Markdown): the original, a translation, or rewrite.md exported from content.json.
//
//   article.md ─ parseBlocks ─▶ ledger ─▶ source page (classes; every text block carries data-source-block)
//        └─ in Chrome: read back every block (must equal the ledger), then inlineInPage() copies computed styles
//           inline, and images become base64 — the same paste path as before, now fed by an article.
//
// The article's own title goes into the 公众号 title field, not the body. Byline, source credit, link and brand
// are page furniture outside the verified document.
import { esc } from './markup.mjs';
import { bylineOf } from './layout-full.mjs';

const brs = (html) => html.replace(/\n/g, '<br>');

/** Code keeps its line breaks and indentation without white-space styles (the editor strips them). */
function codeHtml(text) {
  return text
    .split('\n')
    .map((l) => esc(l).replace(/^ +/, (m) => '&nbsp;'.repeat(m.length)).replace(/ {2,}/g, (m) => ' ' + '&nbsp;'.repeat(m.length - 1)))
    .join('<br>');
}

/** Article blocks → paste-friendly markup (no ul/li, no grid; text blocks carry data-source-block). */
export function articleBodyHtml(blocks, { images = {} } = {}) {
  let out = '';
  const firstP = blocks.findIndex((b) => b.kind === 'p');
  const firstHeading = blocks.findIndex((b) => /^h[1-4]$/.test(b.kind) && !b.isTitle);
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    const attr = `data-source-block="${b.id}"`;
    switch (b.kind) {
      case 'h1': if (!b.isTitle) out += `<p class="wx-h1" ${attr}>${b.html}</p>`; break;
      case 'h2': out += `<p class="wx-h2" ${attr}>${b.html}</p>`; break;
      case 'h3': out += `<p class="wx-h3" ${attr}>${b.html}</p>`; break;
      case 'h4': out += `<p class="wx-h4" ${attr}>${b.html}</p>`; break;
      case 'p': {
        const lead = k === firstP && (firstHeading < 0 || k < firstHeading);
        out += `<p class="wx-p${lead ? ' wx-lead' : ''}" ${attr}>${brs(b.html)}</p>`;
        break;
      }
      case 'quote': out += `<section class="wx-quote" ${attr}>${brs(b.html)}</section>`; break;
      case 'li': {
        const marker = b.ordered ? `<span class="wx-num" data-deco>${esc(b.marker || '•')}</span>` : `<span class="wx-dot" data-deco>●</span>`;
        out += `<p class="wx-li${b.last ? ' wx-list-end' : ''}">${marker}<span ${attr}>${brs(b.html)}</span></p>`;
        break;
      }
      case 'code': out += `<section class="wx-code" ${attr}>${codeHtml(b.text)}</section>`; break;
      case 'th': case 'td': {
        const t = b.table, cells = [];
        while (k < blocks.length && blocks[k].table === t) cells.push(blocks[k++]);
        k--;
        const head = cells.filter((c) => c.kind === 'th');
        const rows = [];
        for (const c of cells.filter((c) => c.kind === 'td')) (rows[c.rowIndex] ||= []).push(c);
        out += `<section class="wx-tablewrap"><table class="wx-table"><tbody>` +
          `<tr>${head.map((c) => `<th data-source-block="${c.id}">${brs(c.html)}</th>`).join('')}</tr>` +
          rows.map((r) => `<tr>${r.map((c) => `<td data-source-block="${c.id}">${brs(c.html)}</td>`).join('')}</tr>`).join('') +
          `</tbody></table></section>`;
        break;
      }
      case 'figure': {
        const cap = blocks[k + 1]?.kind === 'caption' ? blocks[k + 1] : null;
        out += `<section class="wx-figure"><img src="${esc(images[b.src] || b.src)}" alt="${esc(b.alt || '配图')}">` +
          (cap ? `<p class="wx-cap" data-source-block="${cap.id}">${brs(cap.html)}</p>` : '') + `</section>`;
        if (cap) k++;
        break;
      }
      case 'caption': out += `<p class="wx-cap" ${attr}>${brs(b.html)}</p>`; break;
      case 'break': out += `<section class="wx-hr"></section>`; break;
    }
  }
  return out;
}

/** Title, digest and cover texts for an article, from flags, front matter, then the text itself. */
export function articleWechatMeta(meta, blocks, opt = {}) {
  const firstText = blocks.find((b) => b.kind === 'p')?.text?.replace(/\s+/g, ' ').trim() || '';
  const title = (opt.title || meta.wechat_title || meta.title || blocks.find((b) => b.isTitle)?.text || '').replace(/\s*\n\s*/g, '');
  const digestRaw = opt.digest || meta.digest || firstText;
  const digest = digestRaw.length > 120 ? digestRaw.slice(0, 117) + '……' : digestRaw;
  // A cover title typed on the command line carries "\n" as two characters.
  const cover = opt['cover-title'] ? String(opt['cover-title']).replace(/\\n/g, '\n') : '';
  return {
    title,
    digest,
    coverTitle: cover || meta.cover_title || title,
    squareTitle: cover || meta.square_title || meta.cover_title || title,
    kicker: opt.kicker ?? meta.kicker ?? '',
    author: opt.author || meta.wechat_author || '',
  };
}

/** A content.json-shaped object for the shared cover / preview / notes builders. */
export function pseudoContent(meta, wm, { heroSrc } = {}) {
  return {
    lang: meta.lang === 'en' ? 'en' : 'zh',
    title: wm.coverTitle,
    series: wm.kicker,
    cover: { title: wm.squareTitle, ...(heroSrc ? { illustration: { _src: heroSrc, aspect: meta.hero_aspect || '4:3' } } : {}) },
    wechat: { title: wm.title, digest: wm.digest, coverTitle: wm.coverTitle, kicker: wm.kicker, author: wm.author },
    source: { author: meta.author, handle: meta.handle, title: meta.source_title || (meta.kind === 'rewrite' ? '' : meta.title), platform: meta.platform === '本地文件' ? '' : meta.platform, date: meta.date, url: meta.url },
  };
}

/** Source page that the browser lays out, verifies and inlines. */
export function buildArticleSource({ blocks, meta, images, themeCss, componentsCss, articleCss, brand = {}, heroSrc }) {
  const lang = meta.lang === 'en' ? 'en' : 'zh';
  const byline = bylineOf(meta);
  const translated = meta.translated_from ? (lang === 'zh' ? '中文译文' : 'Translation') : '';
  const metaLine = byline || translated
    ? `<p class="wx-meta" data-deco>${esc([byline && (meta.kind === 'rewrite' || meta.translated_from ? `${lang === 'zh' ? '原文' : 'Source'}：${byline}` : byline), translated].filter(Boolean).join(' · '))}</p>`
    : '';
  const hero = heroSrc ? `<section class="wx-hero" data-deco><img src="${esc(heroSrc)}" alt=""></section>` : '';
  const end = [
    meta.footnote && `<p class="wx-foot">${esc(meta.footnote)}</p>`,
    meta.url && `<p class="wx-foot">${lang === 'zh' ? '原文链接：' : 'Original: '}${esc(meta.url)}</p>`,
    brand.name && `<p class="wx-brand">${esc([brand.name, brand.handle].filter(Boolean).join(' '))}</p>`,
  ].filter(Boolean).join('');
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<title>${esc(meta.title || '文章')} · wechat source</title>
<style>${componentsCss}</style>
<style>${articleCss}</style>
<style>${themeCss}</style>
</head><body>
<section class="wx acc" id="wx" style="--acc:var(--accent-1)">${hero}${metaLine}<section class="wx-doc">${articleBodyHtml(blocks, { images })}</section>${end ? `<section class="wx-end" data-deco>${end}</section>` : ''}</section>
</body></html>`;
}
