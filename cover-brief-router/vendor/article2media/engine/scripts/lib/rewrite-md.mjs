// content.json (改写稿) → rewrite.md: the same rewrite as an article, so article-only layouts (公众号排版) can use it.
// Figures are captured as images by export.mjs and referenced here; panels become headed lists or quotes,
// takeaways become quotes. Front matter keeps the original article's source fields and the 公众号 title / digest.
import { plain, pad2 } from './markup.mjs';
import { LABELS, hasIllustrations } from './layout-long.mjs';
import { WX_LABELS, wechatMeta } from './layout-wechat.mjs';

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, (m, i, s) => (/[A-Za-z0-9]/.test(s[i - 1] || '') || /[A-Za-z0-9]/.test(s[i + m.length] || '') ? ' ' : ''));
// Text that would read as Markdown structure at the start of a line is escaped; inline **bold** is kept.
const safe = (s) => oneLine(s)
  .replace(/^(#|>|[-*+](?=\s)|`)/, '\\$1')
  .replace(/^(\d+)([.)])(?=\s)/, '$1\\$2');
const yaml = (v) => JSON.stringify(String(v ?? ''));

export function contentToMarkdown(c, { theme, figs = {}, hero = '', brand = {} } = {}) {
  const lang = c.lang === 'en' ? 'en' : 'zh';
  const L = LABELS[lang], W = WX_LABELS[lang];
  const s = c.source || {};
  const meta = wechatMeta(c);
  const editor = brand.editor || (lang === 'zh' ? '编者' : 'the editor');
  const fm = {
    kind: 'rewrite', lang, theme,
    title: meta.title, digest: meta.digest,
    cover_title: c.wechat?.coverTitle || c.title || '',
    square_title: c.cover?.title || c.title || '',
    kicker: c.wechat?.kicker ?? c.series ?? '',
    author: s.author, handle: s.handle, platform: s.platform, date: s.date, url: s.url, source_title: s.title,
    footnote: c.footnote || (c.source ? L.footnote(s, editor, hasIllustrations(c)) : ''),
    hero, source_content: 'content.json',
  };
  const out = [];
  const para = (t) => { if (t) out.push(safe(t)); };
  const figure = (f, id) => {
    if (!figs[id]) return;
    out.push(`![${L.fig} ${id}](${figs[id]})` + (f.caption ? `\n*${L.fig} ${id}　${plain(oneLine(f.caption)).replace(/\*/g, '＊')}*` : ''));
  };
  const panel = (p) => {
    if (!p) return;
    if (p.title) out.push(`#### ${oneLine(plain(p.title))}`);
    if (p.type === 'table') out.push((p.rows || []).map((r) => `- **${oneLine(plain(r[0]))}**：${oneLine(r[1])}`).join('\n'));
    if (p.type === 'cards') out.push((p.items || []).map((it) => `- **${oneLine(plain(it.title))}**${it.text ? `：${oneLine(it.text)}` : ''}`).join('\n'));
    if (p.type === 'quote') { out.push(`> ${oneLine(p.text)}`); para(p.note); }
  };

  out.push(`# ${meta.title}`);
  para(c.pages?.[0]?.intro);
  const points = c.cover?.points?.length ? c.cover.points : (c.pages || []).flatMap((pg) => (pg.sections || []).map((x) => plain(oneLine(x.heading))));
  if (points.length) out.push(`## ${W.toc}`, points.map((t, i) => `${i + 1}. ${oneLine(t)}`).join('\n'));

  let num = 0;
  (c.pages || []).forEach((pg, pi) => {
    if (pg.part) out.push(`## ${oneLine(plain(pg.part))}`);
    if (pi > 0) para(pg.intro);
    for (const sec of pg.sections || []) {
      num += 1;
      out.push(`### ${pad2(num)}　${oneLine(plain(sec.heading))}`);
      (sec.paragraphs || []).forEach(para);
      if (sec.kind === 'checklist') {
        for (const st of sec.stages || []) {
          out.push(`#### ${[st.label, st.title].filter(Boolean).map((x) => oneLine(plain(x))).join(' · ')}`);
          if (st.items?.length) out.push(st.items.map((it) => `- ${oneLine(it)}`).join('\n'));
          if (st.done) para(`${L.done}${st.done}`);
        }
        if (sec.guard) {
          const g = sec.guard;
          out.push(`#### ${[g.label || W.guard, g.title].filter(Boolean).map((x) => oneLine(plain(x))).join(' · ')}`);
          if (g.items?.length) out.push(g.items.map((it) => `- ${oneLine(it)}`).join('\n'));
          para(g.note);
        }
        para(sec.note);
        continue;
      }
      if (sec.bullets?.length) out.push(sec.bullets.map((b) => `- ${oneLine(b)}`).join('\n'));
      (sec.figures || []).slice(0, 2).forEach((f, j) => figure(f, `${num}${'AB'[j]}`));
      panel(sec.panel);
      if (sec.takeaway) out.push(`> **${oneLine(plain(sec.takeaway))}**`);
    }
    para(pg.closing);
  });

  const head = Object.entries(fm).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${yaml(v)}`).join('\n');
  return `---\n${head}\n---\n\n${out.join('\n\n')}\n`;
}
