// Parametric figure components. Each returns HTML for the inside of a .fig-canvas.
// Colors come exclusively from CSS variables (--acc, --ink, --muted, ...) so every theme restyles them.
import { esc, md, vlen } from './markup.mjs';

const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? ''));
const asItem = (it) => (typeof it === 'string' ? { title: it } : it || {});

const wrap = (type, body, note) =>
  `<div class="fx fx-${type}"><div class="fx-body">${body}</div>${note ? `<div class="fx-note">${md(note)}</div>` : ''}</div>`;

const ARROW_DOWN = '<svg viewBox="0 0 12 10" class="arr"><path d="M6 0v7M2.5 4.5 6 8l3.5-3.5" class="s-acc" fill="none" stroke-width="1.4"/></svg>';
const ARROW_RIGHT = '<svg viewBox="0 0 10 12" class="arr"><path d="M0 6h7M4.5 2.5 8 6l-3.5 3.5" class="s-acc" fill="none" stroke-width="1.4"/></svg>';

function svgText(x, y, text, cls, anchor = 'middle') {
  const lines = String(text).split('\n');
  if (lines.length === 1) return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${esc(text)}</text>`;
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${lines
    .map((l, i) => `<tspan x="${x}" dy="${i ? '1.2em' : 0}">${esc(l)}</tspan>`)
    .join('')}</text>`;
}

const FIG = {
  bar(f) {
    const data = (f.data || []).map((d) =>
      Array.isArray(d) ? { label: d[0], value: Number(d[1]), display: d[2] ?? fmt(d[1]) } : { ...d, value: Number(d.value), display: d.display ?? fmt(d.value) });
    const n = data.length;
    const max = Number(f.max) || Math.max(...data.map((d) => d.value), 0) || 1;
    let hl = f.highlight ?? 'last';
    if (hl === 'last') hl = n - 1;
    else if (hl === 'max') hl = data.findIndex((d) => d.value === Math.max(...data.map((x) => x.value)));
    else if (hl === 'none') hl = -1;
    const dense = n > 8;
    const W = 280, H = 168, top = 22, base = dense ? 150 : 140;
    const slot = (W - 16) / n;
    const bw = Math.min(44, slot * (dense ? 0.62 : 0.56));
    let s = `<svg viewBox="0 0 ${W} ${H}" class="fig-svg" preserveAspectRatio="xMidYMid meet">`;
    s += `<line x1="6" x2="${W - 6}" y1="${base + 0.5}" y2="${base + 0.5}" class="s-muted" stroke-width="0.6"/>`;
    data.forEach((d, i) => {
      const h = Math.max(1.5, (d.value / max) * (base - top));
      const x = 8 + i * slot + (slot - bw) / 2;
      const y = base - h;
      const isHl = i === hl;
      const op = isHl || hl === -1 ? 1 : 0.3 + 0.4 * (i / Math.max(1, n - 1));
      s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" class="f-acc" style="opacity:${op.toFixed(2)}"/>`;
      if (!dense || isHl) s += svgText((x + bw / 2).toFixed(1), (y - 5).toFixed(1), d.display, 't-val');
      if (!dense) s += svgText((x + bw / 2).toFixed(1), base + 13, d.label, 't-sm');
    });
    if (f.annotate && data[f.annotate.index]) {
      const i = f.annotate.index;
      const h = (data[i].value / max) * (base - top);
      const x = 8 + i * slot + (slot - bw) / 2;
      const right = x + bw + 5 < W - 60;
      s += svgText(right ? x + bw + 5 : x - 5, (base - h + 10).toFixed(1), f.annotate.text, 't-sm', right ? 'start' : 'end');
    }
    if (dense && f.axis) {
      s += svgText(8, base + 13, f.axis[0], 't-sm', 'start');
      s += svgText(W - 8, base + 13, f.axis[1], 't-sm', 'end');
    }
    s += '</svg>';
    return wrap('bar', s, f.note);
  },

  hbar(f) {
    const rows = (f.data || []).map((d) => (Array.isArray(d) ? { label: d[0], value: Number(d[1]), display: d[2] } : d));
    const max = Number(f.max) || Math.max(...rows.map((r) => (r.range ? Number(r.range[1]) : Number(r.value)))) || 1;
    const SPAN = 70; // % of track used by the longest bar; the rest holds the value label
    const body = rows
      .map((r, i) => {
        const lo = r.range ? Number(r.range[0]) : 0;
        const hi = r.range ? Number(r.range[1]) : Number(r.value);
        const left = (lo / max) * SPAN;
        const width = Math.max(1.5, ((hi - lo) / max) * SPAN);
        const soft = f.highlight !== undefined && f.highlight !== i ? ' soft' : '';
        const display = r.display ?? fmt(r.value);
        // Long bars carry their label inside (the track is ~185px wide); short ones put it after the bar.
        const inside = display && left + width > 45 && (width / 100) * 185 > vlen(display) * 11 + 12;
        const val = display ? `<span class="hb-val${inside ? ' in' : ''}">${md(display)}</span>` : '';
        return `<div class="hb-row"><div class="hb-label"><b>${md(r.label)}</b>${r.sub ? `<small>${md(r.sub)}</small>` : ''}</div>` +
          `<div class="hb-track"><div class="hb-bar${soft}" style="margin-left:${left.toFixed(1)}%;width:${width.toFixed(1)}%">${inside ? val : ''}</div>` +
          `${inside ? '' : val}</div></div>`;
      })
      .join('');
    const axis = f.axis
      ? `<div class="hb-row hb-axis-row"><div></div><div class="hb-axis"><span style="left:0">${esc(f.axis[0])}</span><span style="left:${SPAN}%">${esc(f.axis[1])}</span></div></div>`
      : '';
    return wrap('hbar', `<div class="hb">${body}${axis}</div>`, f.note);
  },

  stack(f) {
    const items = (f.items || []).map(asItem);
    const hl = f.highlight ?? -1;
    const body =
      (f.header ? `<div class="st-head">${md(f.header)}</div>` : '') +
      `<div class="st-list">${items
        .map((it, i) => `<div class="box${i === hl ? ' hl' : ''}"><span>${md(it.title)}</span>${it.note ? `<small>${md(it.note)}</small>` : ''}</div>`)
        .join('')}</div>` +
      (f.footer ? `<div class="st-foot">${md(f.footer)}</div>` : '');
    return wrap('stack', body, f.note);
  },

  flow(f) {
    const steps = f.steps || [];
    const hl = f.highlight ?? steps.length - 1;
    const dir = f.direction === 'right' ? 'right' : 'down';
    const arrow = `<div class="fl-arrow">${dir === 'down' ? ARROW_DOWN : ARROW_RIGHT}</div>`;
    const body = `<div class="fl fl-${dir} n${steps.length}">${steps
      .map((s, i) => (i ? arrow : '') + `<div class="box${i === hl ? ' hl' : ''}">${md(s)}</div>`)
      .join('')}</div>`;
    return wrap('flow', body, f.note);
  },

  grid(f) {
    const items = f.items || [];
    const cols = f.cols || (items.length <= 4 ? 2 : 3);
    const hls = Array.isArray(f.highlight) ? f.highlight : f.highlight !== undefined ? [f.highlight] : [];
    const body = `<div class="gr" style="grid-template-columns:repeat(${cols},1fr)">${items
      .map((t, i) => `<div class="box${hls.includes(i) ? ' hl' : ''}">${md(t)}</div>`)
      .join('')}</div>`;
    return wrap('grid', body, f.note);
  },

  converge(f) {
    const src = f.sources || [];
    const n = src.length;
    const rev = !!f.reverse;
    const ys = src.map((_, i) => ((i + 0.5) / n) * 100);
    const sx = rev ? 61 : 39; // source edge facing the target
    const tx = rev ? 39 : 61; // target edge
    const c = (sx + tx) / 2;
    const paths = ys
      .map((y) => `<path d="M${sx} ${y.toFixed(1)} C ${c} ${y.toFixed(1)}, ${c} 50, ${tx} 50" class="s-acc" fill="none" stroke-width="1.1" vector-effect="non-scaling-stroke"/>`)
      .join('');
    const body =
      `<div class="cv">` +
      `<svg class="cv-lines" viewBox="0 0 100 100" preserveAspectRatio="none">${paths}</svg>` +
      src.map((t, i) => `<div class="box cv-src" style="top:${ys[i].toFixed(1)}%;${rev ? 'right' : 'left'}:0">${md(t)}</div>`).join('') +
      `<div class="box hl cv-tgt" style="top:50%;${rev ? 'left' : 'right'}:0">${md(f.target)}</div>` +
      `</div>`;
    return wrap('converge', body, f.note);
  },

  tree(f) {
    const ch = f.children || [];
    const n = ch.length;
    const leaves = Math.max(0, Math.min(6, Number(f.leaves ?? 0)));
    const xs = ch.map((_, i) => ((i + 0.5) / n) * 100);
    const rootY = 15, midY = 30, childY = 46;
    let lines = `<path d="M50 ${rootY + 9} V${midY}" class="s-acc" stroke-width="1.1" vector-effect="non-scaling-stroke" fill="none"/>`;
    lines += `<path d="M${xs[0]} ${midY} H${xs[n - 1]}" class="s-acc" stroke-width="1.1" vector-effect="non-scaling-stroke" fill="none"/>`;
    for (const x of xs) {
      lines += `<path d="M${x} ${midY} V${childY - 8}" class="s-acc" stroke-width="1.1" vector-effect="non-scaling-stroke" fill="none"/>`;
      if (leaves) lines += `<path d="M${x} ${childY + 9} V${childY + 20}" class="s-muted" stroke-width="0.8" vector-effect="non-scaling-stroke" fill="none"/>`;
    }
    const dots = leaves
      ? xs.map((x) => `<div class="tr-dots" style="left:${x}%">${'<i></i>'.repeat(leaves)}</div>`).join('')
      : '';
    const body =
      `<div class="tr"><svg class="cv-lines" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>` +
      `<div class="box hl tr-root" style="top:${rootY}%">${md(f.root)}</div>` +
      ch.map((t, i) => `<div class="box tr-child" style="left:${xs[i]}%;top:${childY}%;width:${Math.min(30, 92 / n)}%">${md(t)}</div>`).join('') +
      dots +
      `</div>`;
    return wrap('tree', body, f.note);
  },

  stats(f) {
    const items = f.items || [];
    const body = `<div class="ss n${items.length}">${items
      .map((it) => `<div class="ss-item"><div class="ss-label">${md(it.label)}</div><div class="ss-val">${md(it.value)}</div>${it.note ? `<div class="ss-note">${md(it.note)}</div>` : ''}</div>`)
      .join('')}</div>`;
    return wrap('stats', body, f.note);
  },

  equation(f) {
    const terms = f.terms || [];
    const ops = f.ops || terms.slice(1).map(() => '+');
    const row = terms
      .map((t, i) => (i ? `<span class="eq-op">${esc(ops[i - 1] ?? '')}</span>` : '') +
        `<div class="box eq-term"><b>${md(t.value)}</b>${t.label ? `<small>${md(t.label)}</small>` : ''}</div>`)
      .join('');
    const res = f.result ? `<div class="fl-arrow">${ARROW_DOWN}</div><div class="box hl eq-res">${md(f.result)}</div>` : '';
    return wrap('equation', `<div class="eq"><div class="eq-row">${row}</div>${res}</div>`, f.note);
  },

  path(f) {
    const pts = f.points || [];
    const n = pts.length;
    const pos = pts.map((_, i) => {
      const t = n === 1 ? 1 : i / (n - 1);
      return { x: 8 + t * 82, y: 66 - t * 38 - Math.sin(t * Math.PI) * 3 };
    });
    const d = pos.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const body =
      `<div class="pa"><svg class="cv-lines" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${d}" class="s-acc" stroke-width="1.3" stroke-dasharray="4 3" fill="none" vector-effect="non-scaling-stroke"/></svg>` +
      pos.map((p, i) => {
        const align = i === 0 ? 'start' : 'end';
        return `<i class="pa-dot${i === n - 1 ? ' hl' : ''}" style="left:${p.x.toFixed(1)}%;top:${p.y.toFixed(1)}%"></i>` +
          `<div class="pa-label ${align}" style="left:${p.x.toFixed(1)}%;top:${p.y.toFixed(1)}%"><b>${md(pts[i].label)}</b>${pts[i].note ? `<small>${md(pts[i].note)}</small>` : ''}</div>`;
      }).join('') +
      `</div>`;
    return wrap('path', body, f.note);
  },

  compare(f) {
    const col = (side, mark, cls) =>
      `<div class="cmp-col ${cls}"><div class="cmp-title">${md(side?.title)}</div><ul>${(side?.items || [])
        .map((it) => `<li><i>${mark}</i><span>${md(it)}</span></li>`)
        .join('')}</ul></div>`;
    const marks = f.marks || ['✓', '✗'];
    return wrap('compare', `<div class="cmp">${col(f.left, marks[0], 'ok')}${col(f.right, marks[1], 'no')}</div>`, f.note);
  },

  cycle(f) {
    const items = f.items || [];
    const n = items.length;
    const W = 280, H = 168, cx = 140, cy = 82, rx = 92, ry = 56;
    const ang = (i) => -Math.PI / 2 + (i / n) * Math.PI * 2;
    let s = `<svg viewBox="0 0 ${W} ${H}" class="fig-svg" preserveAspectRatio="xMidYMid meet">`;
    s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" class="s-acc" fill="none" stroke-width="1.1" stroke-dasharray="3 3"/>`;
    for (let i = 0; i < n; i++) {
      const t = ang(i + 0.5);
      const x = cx + rx * Math.cos(t), y = cy + ry * Math.sin(t);
      const rot = (Math.atan2(ry * Math.cos(t), -rx * Math.sin(t)) * 180) / Math.PI;
      s += `<path d="M-4 -3.5 L3 0 L-4 3.5 Z" class="f-acc" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)})"/>`;
    }
    items.forEach((it, i) => {
      const t = ang(i);
      const x = cx + rx * Math.cos(t), y = cy + ry * Math.sin(t);
      const label = String(it);
      const w = Math.max(40, [...label].reduce((a, ch) => a + (/[⺀-￿]/.test(ch) ? 11.5 : 6.5), 0) + 16);
      const hl = f.highlight === i;
      s += `<rect x="${(x - w / 2).toFixed(1)}" y="${(y - 11).toFixed(1)}" width="${w.toFixed(1)}" height="22" rx="4" class="${hl ? 'f-acc' : 'f-card'} s-acc" stroke-width="1.1"/>`;
      s += svgText(x.toFixed(1), (y + 4).toFixed(1), label, hl ? 't-on' : 't-box');
    });
    if (f.center) s += svgText(cx, cy + 4, f.center, 't-val');
    s += '</svg>';
    return wrap('cycle', s, f.note);
  },

  quote(f) {
    const body = `<div class="qt"><div class="qt-mark">“</div><div class="qt-text">${md(f.text)}</div>${f.by ? `<div class="qt-by">— ${md(f.by)}</div>` : ''}</div>`;
    return wrap('quote', body, f.note);
  },

  image(f) {
    const fit = f.fit === 'contain' ? 'contain' : 'cover';
    return wrap('image', `<img class="im" src="${esc(f.src)}" style="object-fit:${fit}" alt="">`, f.note);
  },

  // AI illustration: the image is generated by illustrate.mjs and resolved by render.mjs (f._src).
  illustration(f) {
    const body = f._src
      ? `<img class="ill" src="${esc(f._src)}" alt="">`
      : `<div class="ill-missing"><b>插画待生成</b><span>${esc(String(f.prompt || '').slice(0, 60))}</span></div>`;
    return wrap('illustration', body, f.note);
  },

  svg(f) {
    const clean = String(f.svg || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href\s*=\s*["'])(?!#)[^"']*(["'])/gi, '$1#$2')
      .replace(/<svg\b/i, '<svg class="fig-svg" preserveAspectRatio="xMidYMid meet"');
    return wrap('svg', clean, f.note);
  },
};

export const FIGURE_TYPES = Object.keys(FIG);

export function renderFigure(f) {
  const fn = FIG[f?.type];
  if (!fn) return `<div class="fx-error">未知图表类型：${esc(f?.type)}</div>`;
  return fn(f);
}
