// "whiteboard" layout (-w): how the author gets from a question to a conclusion, laid out as one vertical reasoning spine.
//
//   article.md ─▶ source inventory (src-01 … one per paragraph, hashed; built from the source, never from the ledger)
//   whiteboard.json (written by Claude): steps + relations + source_sections (every paragraph rendered or omitted with a reason)
//   ─▶ checks (inventory coverage, step/relation integrity) ─▶ HTML spine ─▶ DOM consistency ─▶ PNG
import crypto from 'node:crypto';
import { esc } from './markup.mjs';
import { frontMatter, parseBlocks } from './layout-full.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const md = (s) => esc(String(s ?? '')).replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

export const ROLES = { question: '问题', premise: '前提', evidence: '证据', tension: '矛盾', inference: '推理', turn: '转折', synthesis: '综合', conclusion: '结论', boundary: '边界' };
const KINDS = ['continue', 'deepen', 'contrast', 'question', 'branch', 'return', 'boundary'];
const STRUCTS = ['chain', 'branch', 'timeline', 'matrix', 'radial'];

/** Source inventory: one entry per text paragraph of the article (headings and list items included). */
export function inventory(raw) {
  const { meta, body } = frontMatter(raw);
  const blocks = parseBlocks(body, { title: meta.title }).filter((b) => b.text && !b.isTitle);
  return {
    version: 1, source_sha256: sha(raw), title: meta.title || '',
    sections: blocks.map((b, i) => ({ id: `src-${String(i + 1).padStart(2, '0')}`, kind: b.kind, sha: sha(b.text).slice(0, 12), text: b.text })),
  };
}

/** Structural checks of whiteboard.json against the inventory. Returns { errors, warnings }. */
export function checkWhiteboard(wb, inv) {
  const errors = [], warnings = [];
  const steps = wb.steps || [], rels = wb.relations || [];
  const stepIds = new Set(steps.map((s) => s.id));
  if (!steps.length) errors.push('steps 不能为空');
  if (inv && wb.source_sha256 && wb.source_sha256 !== inv.source_sha256) errors.push('source_sha256 与原文不符：原文改过，重新生成来源清单');
  // Every inventory paragraph appears in source_sections, in order: rendered (→ steps) or omitted (→ reason).
  if (inv) {
    const secs = wb.source_sections || [];
    const want = inv.sections.map((x) => x.id), have = secs.map((x) => x.id);
    const missing = want.filter((id) => !have.includes(id));
    const extra = have.filter((id) => !want.includes(id));
    if (missing.length) errors.push(`来源段落没有处置：${missing.join(', ')}（每段都要 rendered 或 omitted）`);
    if (extra.length) errors.push(`source_sections 有清单里没有的编号：${extra.join(', ')}`);
    if (!missing.length && !extra.length && want.join() !== have.join()) errors.push('source_sections 的顺序与原文不一致');
    for (const s of secs) {
      if (s.disposition === 'rendered') {
        if (!(s.step_ids || []).length) errors.push(`${s.id} 标为 rendered，但没有 step_ids`);
        for (const id of s.step_ids || []) if (!stepIds.has(id)) errors.push(`${s.id} 指向不存在的步骤 ${id}`);
      } else if (s.disposition === 'omitted') {
        if (!String(s.omission_reason || '').trim()) errors.push(`${s.id} 被省略，但没写 omission_reason`);
        if (/^(只是例子|不重要|略)$/.test(String(s.omission_reason).trim())) warnings.push(`${s.id} 的省略理由太笼统：说明这段的作用为什么不再需要`);
      } else errors.push(`${s.id} 的 disposition 只能是 rendered / omitted`);
    }
    const omitted = secs.filter((s) => s.disposition === 'omitted').length;
    if (omitted > inv.sections.length * 0.6) warnings.push(`省略了 ${omitted}/${inv.sections.length} 段，检查是否删掉了论证过程`);
  }
  const seen = new Set();
  steps.forEach((s, i) => {
    const W = `steps[${i}]（${s.id || '?'}）`;
    if (!s.id) errors.push(`${W} 缺少 id`);
    if (seen.has(s.id)) errors.push(`${W} id 重复`);
    seen.add(s.id);
    if (!ROLES[s.role]) errors.push(`${W} role 只能是 ${Object.keys(ROLES).join(' / ')}`);
    if (!String(s.claim || '').trim()) errors.push(`${W} 缺少 claim`);
    if (inv) for (const r of s.source_refs || []) if (!inv.sections.some((x) => x.id === r)) errors.push(`${W} 引用了不存在的来源 ${r}`);
    if (inv && !(s.source_refs || []).length) warnings.push(`${W} 没有 source_refs：这一步出自哪里？`);
    if (s.structure && !STRUCTS.includes(s.structure.type)) errors.push(`${W} structure.type 只能是 ${STRUCTS.join(' / ')}`);
  });
  const relIds = new Set();
  rels.forEach((r, i) => {
    const W = `relations[${i}]（${r.id || '?'}）`;
    if (relIds.has(r.id)) errors.push(`${W} id 重复`);
    relIds.add(r.id);
    if (!stepIds.has(r.from) || !stepIds.has(r.to)) errors.push(`${W} 端点不存在：${r.from} → ${r.to}`);
    if (!KINDS.includes(r.kind)) errors.push(`${W} kind 只能是 ${KINDS.join(' / ')}`);
    if (r.visibility === 'visible' && !String(r.bridge || '').trim()) errors.push(`${W} 是可见转折，需要一句完整的 bridge`);
    if (r.visibility === 'implicit' && String(r.bridge || '').trim()) errors.push(`${W} 是静默关系，bridge 必须为空`);
    if (/^(继续追问|再向前一步|进一步|接下来)/.test(String(r.bridge || ''))) warnings.push(`${W} 的 bridge 是空泛旁白：写出原文里具体的未解压力`);
    const from = steps.find((s) => s.id === r.from);
    if (r.visibility === 'visible' && from?.residue) warnings.push(`${W} 与 ${r.from} 的 residue 重复承载同一个转折：二选一`);
  });
  // The spine never breaks: consecutive steps are connected.
  for (let i = 1; i < steps.length; i++) {
    if (!rels.some((r) => r.from === steps[i - 1].id && r.to === steps[i].id)) warnings.push(`${steps[i - 1].id} → ${steps[i].id} 之间没有登记关系（主干会默认静默延续）`);
  }
  const visible = rels.filter((r) => r.visibility === 'visible').length;
  if (visible > Math.max(3, steps.length * 0.5)) warnings.push(`可见转折 ${visible} 处，偏多：普通延续应保持静默`);
  return { errors, warnings };
}

function structureHtml(st) {
  if (!st) return '';
  const items = (st.items || []).map((x) => (typeof x === 'string' ? { text: x } : x));
  switch (st.type) {
    case 'chain':
      return `<div class="wb-struct wb-chain">${items.map((x, i) => `${i ? '<i class="wb-arrow">→</i>' : ''}<span class="wb-node">${md(x.text)}</span>`).join('')}</div>`;
    case 'timeline':
      return `<ol class="wb-struct wb-timeline">${items.map((x) => `<li><b>${md(x.label || '')}</b><span>${md(x.text)}</span></li>`).join('')}</ol>`;
    case 'branch':
      return `<div class="wb-struct wb-branch">${st.root ? `<div class="wb-root">${md(st.root)}</div>` : ''}<div class="wb-forks">${items.map((x) => `<div class="wb-fork"><b>${md(x.label || '')}</b><span>${md(x.text)}</span></div>`).join('')}</div></div>`;
    case 'matrix': {
      const cols = st.cols || [], rows = st.rows || [];
      return `<table class="wb-struct wb-matrix"><thead><tr><th></th>${cols.map((c) => `<th>${md(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><th>${md(r.label)}</th>${(r.cells || []).map((c) => `<td>${md(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'radial':
      return `<div class="wb-struct wb-radial"><div class="wb-hub">${md(st.center || '')}</div><div class="wb-spokes">${items.map((x) => `<span class="wb-node">${md(x.text)}</span>`).join('')}</div></div>`;
  }
  return '';
}

/**
 * Map a theme's variables onto the whiteboard's. --ink / --muted have the same names in both, so the board must
 * inherit them (a `--ink: var(--ink)` declaration refers to itself and is invalid, which blanks the spine and dots).
 * The three marker colors carry roles; a theme whose first accents repeat (quiet has one, swiss two) keeps the
 * board's own blue / green, toned toward the theme's ink, so roles stay distinguishable.
 */
export function themeBridge(themeCss) {
  const acc = (n) => (themeCss.match(new RegExp(`--accent-${n}\\s*:\\s*([^;}]+)`)) || [])[1]?.trim().toLowerCase();
  const [a1, a2, a3] = [1, 2, 3].map(acc);
  const blue = a2 && a2 !== a1 ? 'var(--accent-2)' : 'color-mix(in srgb, #2D5FA8 78%, var(--ink))';
  const green = a3 && a3 !== a1 && a3 !== a2 ? 'var(--accent-3)' : 'color-mix(in srgb, #2F7D4F 78%, var(--ink))';
  return `html,body{background:var(--bg);}.wb-page{--board:var(--bg);--ink:inherit;--muted:inherit;--rule:color-mix(in srgb, var(--ink) 16%, transparent);` +
    `--red:var(--accent-1);--blue:${blue};--green:${green};--wb-on:var(--on-acc, #fff);--wb-paper:var(--card, color-mix(in srgb, var(--bg) 88%, var(--ink)));` +
    `--hand:var(--font-head);--text:var(--font-body);}`;
}

export function buildWhiteboard(wb, { css, themeCss, useTheme, images = {}, credit = '' }) {
  const steps = wb.steps || [];
  const rels = wb.relations || [];
  const relAfter = (s, next) => rels.find((r) => r.from === s.id && r.to === next?.id);
  let body = '';
  steps.forEach((s, i) => {
    const img = s.image && images[s.id];
    body +=
      `<article class="logic-step" data-step-id="${esc(s.id)}" data-role="${esc(s.role)}" data-source-refs="${esc((s.source_refs || []).join(' '))}">` +
      `<div class="step-marker" aria-hidden="true"><span class="step-depth">${String(i + 1).padStart(2, '0')}</span><span class="step-dot"></span></div>` +
      `<div class="step-panel"><span class="step-role">${ROLES[s.role]}</span>` +
      `<h2 class="step-claim">${md(s.claim)}</h2>` +
      (s.support ? `<p class="step-support">${md(s.support)}</p>` : '') +
      structureHtml(s.structure) +
      (s.learning ? `<div class="learning-material"><span class="learning-label">${md(s.learning.label || '原文实例')}</span><p>${md(s.learning.text)}</p></div>` : '') +
      (img ? `<figure class="wb-sketch" data-source-claim="${esc(s.id)}"><img src="${esc(img)}" alt="${esc(s.image.alt || s.claim)}"></figure>` : '') +
      (s.residue ? `<p class="step-residue">${md(s.residue)}</p>` : '') +
      `</div></article>`;
    const next = steps[i + 1];
    if (!next) return;
    const r = relAfter(s, next) || { id: `auto-${i}`, from: s.id, to: next.id, kind: 'continue', visibility: 'implicit', bridge: '' };
    body += r.visibility === 'visible'
      ? `<div class="logic-relation is-visible" data-relation-id="${esc(r.id)}" data-from="${esc(r.from)}" data-to="${esc(r.to)}" data-kind="${esc(r.kind)}" data-visibility="visible"><span class="relation-stem"></span><span class="relation-arrowhead"></span><p class="transition-sentence">${md(r.bridge)}</p></div>`
      : `<div class="logic-relation" data-relation-id="${esc(r.id)}" data-from="${esc(r.from)}" data-to="${esc(r.to)}" data-kind="${esc(r.kind)}" data-visibility="implicit" aria-hidden="true"></div>`;
  });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(wb.title || '白板')}</title>
<style>${css}</style>
${useTheme ? `<style>${themeCss}</style><style>${themeBridge(themeCss)}</style>` : ''}
</head><body><div class="wb-page">
<header class="wb-head"><h1 class="whiteboard-title">${md(wb.title)}</h1>${wb.question ? `<p class="whiteboard-question">${md(wb.question)}</p>` : ''}${wb.orientation ? `<p class="whiteboard-orientation">${md(wb.orientation)}</p>` : ''}</header>
<section class="reasoning-spine">${body}</section>
${wb.closing ? `<p class="wb-closing">${md(wb.closing)}</p>` : ''}
<footer class="wb-foot">${esc(credit)}</footer>
</div></body></html>`;
}

/** In-page: every ledger step and relation must exist in the DOM, in ledger order. */
export function domCheckInPage(arg) {
  const out = [];
  const ids = [...document.querySelectorAll('.reasoning-spine > .logic-step')].map((e) => e.dataset.stepId);
  if (ids.join() !== arg.steps.join()) out.push(`页面步骤与账本不一致：${ids.join(',')} ≠ ${arg.steps.join(',')}`);
  if (document.querySelectorAll('.reasoning-spine').length !== 1) out.push('reasoning-spine 必须且只能有一个');
  for (const r of document.querySelectorAll('.logic-relation.is-visible')) {
    if (!r.querySelector('.relation-stem') || !r.querySelector('.relation-arrowhead') || r.querySelectorAll('.transition-sentence').length !== 1) out.push(`可见转折 ${r.dataset.relationId} 缺少箭头或过渡句`);
  }
  for (const r of document.querySelectorAll('.logic-relation:not(.is-visible)')) if (r.textContent.trim()) out.push(`静默关系 ${r.dataset.relationId} 里有文字`);
  return out;
}
