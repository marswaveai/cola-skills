// "comic" layout (-c): black-and-white comic panels. Generated images make actions and results visible;
// HTML writes every word (narration, speech bubbles, sound effects, terms, sources) — the images carry no text.
import { esc } from './markup.mjs';

const md = (s) => esc(String(s ?? '')).replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

export const ROLES = ['最小案例', '零号模型', '缺口', '补位', '重跑', '回收', '边界'];

export function checkComic(c) {
  const errors = [], warnings = [];
  if (!c.title) errors.push('缺少 title');
  if (!c.bible?.character) errors.push('缺少 bible.character（固定角色设定：年龄、发型、服装、关键道具）');
  if (!c.bible?.style) warnings.push('没有 bible.style：默认用「静谧电影线描」黑白漫画');
  const panels = c.panels || [];
  if (panels.length < 2) errors.push('panels 至少 2 格');
  const ids = new Set();
  panels.forEach((p, i) => {
    const W = `panels[${i}]（${p.id || '?'}）`;
    if (!p.id) errors.push(`${W} 缺少 id`);
    if (ids.has(p.id)) errors.push(`${W} id 重复`);
    ids.add(p.id);
    if (!String(p.scene || '').trim()) errors.push(`${W} 缺少 scene（可见动作与结果，写给出图模型）`);
    if (p.role && !ROLES.includes(p.role)) warnings.push(`${W} role「${p.role}」不在 ${ROLES.join('/')} 里`);
    if (!['wide', 'half', 'tall'].includes(p.size || 'wide')) errors.push(`${W} size 只能是 wide / half / tall`);
    if (/[“"「」]|对白|字幕|文字|text|caption|speech bubble/i.test(p.scene || '')) warnings.push(`${W} 的 scene 提到了文字或对白：图里不画字，文字写进 narration / bubbles`);
    (p.bubbles || []).forEach((b, k) => { if (String(b.text || '').length > 18) warnings.push(`${W} 对白 ${k + 1} 超过 18 字，气泡会很挤`); });
    if (String(p.narration || '').length > 60) warnings.push(`${W} 旁白超过 60 字：旁白只点明缺口、命名概念或校准证据`);
    if (!p.narration && !(p.bubbles || []).length) warnings.push(`${W} 没有旁白也没有对白：确认画面能独立读懂`);
  });
  const halves = panels.filter((p) => p.size === 'half').length;
  if (halves % 2) warnings.push('half 格数量是奇数：最后一格会单独占半行');
  if (c.anchor && !ids.has(c.anchor)) errors.push(`anchor ${c.anchor} 不是已有的分格`);
  return { errors, warnings };
}

const NEG = 'No speech bubbles, no panel borders, no caption boxes, no sound-effect lettering, no page numbers, no readable text, letters or numbers anywhere, ' +
  'no logo, no watermark, no color, no photorealism, no glossy 3D, no extra characters, no cropped key subject (face, hands, key prop).';

export function panelPrompt(c, p) {
  const style = c.bible?.style || 'quiet cinematic line art comic, mid shots, environmental storytelling, low-density screentone';
  return [
    'Black-and-white manga panel art on a clean white paper background.',
    `Scene: ${p.scene.trim()}`,
    `Composition: ${p.size === 'half' ? 'square panel' : p.size === 'tall' ? 'portrait panel' : 'wide panel'}; single readable action; visible cause-and-effect result; ${p.safe ? `keep the ${p.safe} of the frame visually quiet for overlaid caption boxes` : 'leave the top-left corner visually quiet for a caption box'}.`,
    `Recurring character (must stay identical in every panel): ${c.bible.character}.`,
    c.bible.setting ? `Setting continuity: ${c.bible.setting}.` : '',
    `Series style: ${style}; controlled screentone and ink mass; coherent line weight.`,
    'Do not depict real, identifiable people.',
    NEG,
  ].filter(Boolean).join('\n');
}
export const panelAspect = (p) => (p.size === 'half' ? '1:1' : p.size === 'tall' ? '2:3' : '3:2');

function bubbles(p) {
  return (p.bubbles || []).map((b) => {
    const x = b.x ?? 58, y = b.y ?? 10;
    const short = [...String(b.text)].length <= 10 ? ' short' : '';
    return `<div class="bubble tail-${esc(b.tail || 'left')}${short}" style="left:${x}%;top:${y}%"><span>${md(b.text)}</span></div>`;
  }).join('');
}

function panelFig(p, img) {
  return (
    `<figure class="panel panel-${esc(p.size || 'wide')}" data-panel-id="${esc(p.id)}">` +
    `<div class="panel-art">${img ? `<img src="${esc(img)}" alt="${esc(p.alt || p.scene)}">` : '<div class="panel-missing">分格待生成</div>'}` +
    (p.narration ? `<div class="narration">${md(p.narration)}</div>` : '') +
    bubbles(p) +
    (p.sfx ? `<div class="sfx" style="left:${p.sfx_x ?? 70}%;top:${p.sfx_y ?? 60}%">${esc(p.sfx)}</div>` : '') +
    `</div>${p.caption ? `<figcaption>${md(p.caption)}</figcaption>` : ''}</figure>`
  );
}

export function buildComicPage(c, { css, themeCss, images, credit }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(c.title)}</title>
<style>${css}</style><style>${themeCss || ''}</style></head><body>
<div class="comic-page acc" style="--acc:var(--accent-1, #B6533F)">
<header class="comic-head">${c.kicker ? `<div class="comic-kicker">${md(c.kicker)}</div>` : ''}<h1 class="comic-title">${md(c.title)}</h1>${c.subtitle ? `<p class="comic-sub">${md(c.subtitle)}</p>` : ''}</header>
<main class="comic-grid">${(c.panels || []).map((p) => panelFig(p, images[p.id])).join('')}</main>
${c.closing ? `<p class="comic-closing">${md(c.closing)}</p>` : ''}
<footer class="comic-foot"><span>${esc(credit)}</span><span>画面由 AI 生成 · 人物为示意</span></footer>
</div></body></html>`;
}

/** 3:4 carousel: cover, one card per panel, an end card with the takeaways. */
export function buildComicCards(c, { css, themeCss, images, credit }) {
  const panels = c.panels || [];
  const total = panels.length + 2;
  const top = (i) => `<div class="cc-top"><span>${md(c.kicker || '')}</span><span>${String(i).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></div>`;
  const anchor = images[c.anchor || panels[0]?.id];
  const cover = `<section class="ccard ccard-cover" data-card="1">${top(1)}<h1 class="comic-title">${md(c.cover_title || c.title)}</h1>${c.subtitle ? `<p class="comic-sub">${md(c.subtitle)}</p>` : ''}${anchor ? `<div class="cc-cover-art"><img src="${esc(anchor)}" alt=""></div>` : ''}<div class="cc-foot">${esc(credit)}</div></section>`;
  const cards = panels.map((p, i) =>
    `<section class="ccard" data-card="${i + 2}">${top(i + 2)}<div class="cc-panel">${panelFig({ ...p, narration: '' }, images[p.id])}</div>${p.narration ? `<p class="cc-text">${md(p.narration)}</p>` : ''}</section>`).join('');
  const end = `<section class="ccard ccard-end" data-card="${total}">${top(total)}<h2 class="cc-end-h">${md(c.recap_title || '这组漫画讲了')}</h2><ol class="cc-recap">${(c.recap || []).map((t) => `<li>${md(t)}</li>`).join('')}</ol>${c.closing ? `<p class="cc-text">${md(c.closing)}</p>` : ''}<div class="cc-foot">${esc(credit)} · 画面由 AI 生成</div></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(c.title)} · cards</title>
<style>${css}</style><style>${themeCss || ''}</style></head><body class="cards"><main class="ccards acc" style="--acc:var(--accent-1, #B6533F)">${cover}${cards}${end}</main></body></html>`;
}
