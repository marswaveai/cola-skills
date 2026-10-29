/**
 * 页面模型：快照抽取、指纹、条件判定。
 * 这一层是通道无关的 —— CDP 和 ADB 产出的 PageState 结构一致。
 */
import { createHash } from 'node:crypto'

export function normText(s) {
  return String(s ?? '')
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .trim()
}

/** 在页面里跑的抽取脚本。返回结构化快照，不返回截图。 */
export const SNAPSHOT_JS = String.raw`(() => {
  const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00a0\u3000]+/g, ' ').trim();
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const cssPath = (el) => {
    if (el.id) return '#' + esc(el.id);
    // 唯一样式类优先：ref 可读、也更容易在页面小改后继续命中。
    const classes = [...(el.classList || [])].filter((c) => /^[a-zA-Z_][\w-]{1,40}$/.test(c));
    for (const c of classes) {
      if (document.getElementsByClassName(c).length === 1) return '.' + esc(c);
    }
    if (classes.length >= 2) {
      const two = '.' + esc(classes[0]) + '.' + esc(classes[1]);
      try { if (document.querySelectorAll(two).length === 1) return two; } catch (e) {}
    }
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let sel = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length && cur !== el) {
        const uc = [...cur.classList].find((c) => /^[a-zA-Z_][\w-]{1,40}$/.test(c) && document.getElementsByClassName(c).length === 1);
        if (uc) sel += '.' + esc(uc);
      }
      if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  };
  const SEL = 'a,button,input,select,textarea,label,[role=button],[role=link],[role=tab],[onclick],[contenteditable="true"]';
  const elements = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    elements.push({
      ref: 'css:' + cssPath(el),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      text: norm(el.innerText || el.value || el.placeholder || '').slice(0, 80),
      value: 'value' in el ? String(el.value == null ? '' : el.value) : null,
      id: el.id || null,
      href: el.getAttribute('href') || null,
      url: el.getAttribute('url') || el.getAttribute('data-url') || null,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }

  // 语义标签一个都没有时，退一步找「看起来能点」的元素（cursor:pointer 的最内层）。
  // 轮盘、canvas 装饰按钮这类 div 只有这条路径能看到。
  if (elements.length < 5) {
    const ptr = [];
    for (const el of document.querySelectorAll('div,span,li,img')) {
      if (ptr.length > 1200) break;
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      const cls = String(el.className || '');
      const looksClickable =
        getComputedStyle(el).cursor === 'pointer' || /btn|button|submit|tap|click|luck|draw/i.test(cls);
      if (!looksClickable) continue;
      if (elements.some((e) => e.ref === 'css:' + cssPath(el))) continue;
      ptr.push(el);
    }
    const inner = ptr.filter((el) => !ptr.some((o) => o !== el && el.contains(o)));
    for (const el of inner.slice(0, 30)) {
      const r = el.getBoundingClientRect();
      elements.push({
        ref: 'css:' + cssPath(el),
        role: 'clickable',
        text: norm(el.innerText).slice(0, 80),
        value: null,
        id: el.id || null,
        href: null,
        url: el.getAttribute('url') || el.getAttribute('data-url') || null,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
  }
  const raw = (document.body && document.body.innerText) || '';
  const lines = raw.split('\n').map(norm).filter(Boolean).slice(0, 400);
  return {
    url: location.href,
    title: document.title || '',
    text: norm(raw),
    lines,
    elements,
    readyState: document.readyState,
  };
})()`

/** 跨通道可比的页面指纹：标题 + 前若干可交互元素的 role/text。 */
export function signature(page) {
  const head = normText(page.title).slice(0, 40)
  const shape = (page.elements || [])
    .slice(0, 12)
    .map((e) => `${e.role}:${normText(e.text).slice(0, 12)}`)
    .join('|')
  return createHash('sha1').update(`${head}##${shape}`).digest('hex').slice(0, 16)
}

/** 按 ref 找元素。ref 支持 css: / id: / text: / text~: / ax: */
export function findElement(page, ref) {
  if (!ref) return null
  const els = page.elements || []
  if (ref.startsWith('css:') || ref.startsWith('ax:') || ref.startsWith('id:')) {
    return els.find((e) => e.ref === ref) ?? null
  }
  if (ref.startsWith('text~:')) {
    const t = ref.slice(6)
    return els.find((e) => normText(e.text).includes(t)) ?? null
  }
  if (ref.startsWith('text:')) {
    const t = ref.slice(5)
    return els.find((e) => normText(e.text) === t) ?? els.find((e) => normText(e.text).includes(t)) ?? null
  }
  // 裸字符串按 text: 处理
  return els.find((e) => normText(e.text) === ref) ?? null
}

/**
 * 把各种写法归一成 {kind, value, ref}。
 * 支持简写（{"textMatches":...}）和标准写法（{"kind":"textMatches","value":...}）。
 */
export function resolveCond(cond) {
  if (!cond || typeof cond !== 'object') throw new Error('条件必须是对象')
  if (cond.kind) {
    const kind = cond.kind
    const value = cond.value ?? cond.text ?? cond.url
    const ref = cond.ref ?? (kind === 'exists' || kind === 'gone' ? cond.text : undefined)
    return { kind, value, ref }
  }
  if (cond.textMatches != null) return { kind: 'textMatches', value: cond.textMatches }
  if (cond.urlMatches != null) return { kind: 'urlMatches', value: cond.urlMatches }
  if (cond.gone != null) return { kind: 'gone', ref: cond.gone }
  if (cond.value !== undefined) return { kind: 'value', value: cond.value, ref: cond.ref }
  if (cond.ref != null) return { kind: 'exists', ref: cond.ref }
  if (cond.url != null) return { kind: 'url', value: cond.url }
  if (cond.text != null) return { kind: 'text', value: cond.text }
  throw new Error(`无法判定的条件：${JSON.stringify(cond)}`)
}

/** 纯函数：给定快照判断条件是否成立。 */
export function checkCond(cond, page) {
  const { kind, value, ref } = resolveCond(cond)
  switch (kind) {
    case 'text':
      return normText(page.text).includes(normText(value))
    case 'textMatches':
      return new RegExp(value).test(page.text || '')
    case 'url':
      return String(page.url || '').includes(value)
    case 'urlMatches':
      return new RegExp(value).test(page.url || '')
    case 'title':
      return normText(page.title).includes(normText(value))
    case 'exists':
      return Boolean(findElement(page, ref))
    case 'gone':
      return !findElement(page, ref)
    case 'value': {
      const el = findElement(page, ref)
      return Boolean(el) && String(el.value ?? '') === String(value)
    }
    case 'js':
      // 只有 CDP 通道能执行，交给调用方处理
      return null
    default:
      throw new Error(`未知条件类型：${kind}`)
  }
}

/** 给 flow 用：把简短写法补全成标准结构。 */
export function normalizeCond(input, { timeout = 8 } = {}) {
  const base = typeof input === 'string' ? { text: input } : { ...input }
  const { kind, value, ref } = resolveCond(base)
  const cond = { ...base, kind }
  if (value !== undefined) cond.value = value
  if (ref !== undefined) cond.ref = ref
  cond.timeout = base.timeout ?? timeout
  return cond
}
