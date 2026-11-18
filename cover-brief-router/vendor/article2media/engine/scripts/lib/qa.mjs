// Layout QA that runs inside the rendered page. Must be self-contained (it is serialized via toString()).
export function qaInPage(opts) {
  const issues = [];
  const where = (el) => {
    const card = el.closest('[data-card]');
    const pre = card ? `卡 ${String(card.dataset.card).padStart(2, '0')} · ` : '';
    const fig = el.closest('[data-fig]');
    if (fig) return `${pre}图 ${fig.dataset.fig}`;
    const sec = el.closest('[data-sec]');
    if (sec) return `${pre}第 ${sec.dataset.sec} 节`;
    if (el.closest('.pg-closing')) return '页尾收束句';
    if (el.closest('.pg-intro')) return '导语';
    if (el.closest('.pg-title')) return '大标题';
    if (card) return pre.replace(/ · $/, '') + (el.classList.contains('c-body') ? '' : ` · ${el.className || el.tagName}`);
    return el.className || el.tagName;
  };
  const snippet = (el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 22);

  // Distinct line tops of an element's text.
  const lineTops = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const tops = [];
    for (const rect of r.getClientRects()) {
      if (rect.width < 1) continue;
      if (!tops.some((t) => Math.abs(t - rect.top) < 4)) tops.push(rect.top);
    }
    return tops.sort((a, b) => a - b);
  };

  // Characters sitting on the last line (non-space, non-punctuation).
  const lastLineChars = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const chars = [];
    let n;
    while ((n = walker.nextNode())) for (let i = 0; i < n.data.length; i++) chars.push([n, i]);
    const range = document.createRange();
    let lastTop = null, count = 0, text = '';
    for (let k = chars.length - 1; k >= 0; k--) {
      const [node, i] = chars[k];
      const ch = node.data[i];
      if (/\s/.test(ch)) continue;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rects = range.getClientRects();
      if (!rects.length) continue;
      const top = rects[0].top;
      if (lastTop === null) lastTop = top;
      if (Math.abs(top - lastTop) > 4) break;
      text = ch + text;
      if (!/[\p{P}\p{S}]/u.test(ch)) count++;
    }
    return { count, text };
  };

  // 1) Figure canvases
  for (const c of document.querySelectorAll('.fig-canvas')) {
    const r = c.getBoundingClientRect();
    let worst = 0;
    for (const el of c.querySelectorAll('*')) {
      if (el.closest('svg') && !['text', 'tspan', 'rect'].includes(el.tagName)) continue;
      if (el.tagName === 'svg') continue;
      const e = el.getBoundingClientRect();
      if (!e.width && !e.height) continue;
      worst = Math.max(worst, r.left - e.left, e.right - r.right, r.top - e.top, e.bottom - r.bottom);
    }
    if (worst > 2) issues.push({ level: 'error', where: where(c), msg: `图内内容超出画布 ${Math.round(worst)}px：缩短图内文字或减少项目` });

    for (const el of c.querySelectorAll('.box, .hb-label, .ss-val, .qt-text, .pa-label, .cmp-col')) {
      // Clipped boxes: any overflow hides text. Unclipped ones: only horizontal overflow matters
      // (tall glyphs legitimately exceed a tight line-height without being cut off).
      const clipped = getComputedStyle(el).overflow !== 'visible';
      if (el.scrollWidth > el.clientWidth + 1 || (clipped && el.scrollHeight > el.clientHeight + 1)) {
        issues.push({ level: 'error', where: where(el), msg: `文字被截断：「${snippet(el)}」` });
      }
    }
    for (const el of c.querySelectorAll('.box')) {
      const lines = lineTops(el).length;
      if (lines > 2) issues.push({ level: 'warn', where: where(el), msg: `图内方框文字折成 ${lines} 行：「${snippet(el)}」，建议缩短` });
    }
    // Overlapping boxes inside one figure
    const boxes = [...c.querySelectorAll('.box, .pa-label')].map((b) => [b, b.getBoundingClientRect()]);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i][1], b = boxes[j][1];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 3 && oy > 3) {
        issues.push({ level: 'error', where: where(boxes[i][0]), msg: `图内元素重叠：「${snippet(boxes[i][0])}」与「${snippet(boxes[j][0])}」` });
      }
    }
  }

  // 2) Orphans: a single character alone on the last line (body text and boxes inside figures)
  // (boxes with a <small> sub-label break lines on purpose, so they are skipped)
  for (const el of document.querySelectorAll('[data-qa-text], .fig-canvas .box:not(:has(small))')) {
    if (lineTops(el).length < 2) continue;
    const { count, text } = lastLineChars(el);
    if (count <= 1) issues.push({ level: 'warn', where: where(el), msg: `末行只剩「${text}」：改写这句，增减两三个字` });
  }

  // 3) Headings that wrap into too many lines
  for (const el of document.querySelectorAll('.sec-h')) {
    const n = lineTops(el).length;
    if (n > 3) issues.push({ level: 'warn', where: where(el), msg: `小标题占了 ${n} 行，建议缩短或调整 \\n 断行` });
  }

  // 4) Broken images, failed fonts
  for (const img of document.images) {
    if (!img.naturalWidth) issues.push({ level: 'error', where: where(img), msg: `图片加载失败：${img.src.slice(0, 80)}` });
  }
  // Web fonts, per declared family (a partial fallback used to be silent). A family counts as not loaded when
  //   - its stylesheet did not load (no @font-face for a family the @import names, or a local sheet that is empty), or
  //   - some of its faces failed or are still loading.
  // Faces left "unloaded" are fine: no text on the page needs that slice. Families nothing on the page uses are skipped.
  {
    const norm = (s) => String(s).replace(/^\s*['"]|['"]\s*$/g, '').trim();
    const faces = {}; // family → { loaded, error, loading }
    for (const f of document.fonts) { const k = norm(f.family); (faces[k] ||= { loaded: 0, error: 0, loading: 0, unloaded: 0 })[f.status]++; }
    const declared = new Set(), known = new Set(), deadSheets = [];
    const walk = (sheet) => {
      let rules;
      try { rules = sheet.cssRules; } catch { return null; } // a cross-origin sheet cannot be read
      for (const r of rules) {
        if (r instanceof CSSFontFaceRule) { const k = norm(r.style.getPropertyValue('font-family')); declared.add(k); known.add(k); }
        if (!(r instanceof CSSImportRule)) continue;
        let named = [];
        try { named = new URL(r.href, location.href).searchParams.getAll('family').map((v) => v.split(':')[0].trim()).filter(Boolean); } catch {}
        for (const k of named) { declared.add(k); known.add(k); } // Google Fonts urls name their families
        const inner = r.styleSheet ? walk(r.styleSheet) : 0;
        if (inner === 0) deadSheets.push(r.href); // readable (local) but without a single rule: the file is missing
        if (inner === null && !named.length) {
          // A remote sheet that does not name its families: resource timing tells whether it arrived.
          const e = performance.getEntriesByName(r.href)[0];
          if (e && (e.responseStatus >= 400 || (!e.responseStatus && !e.decodedBodySize))) deadSheets.push(r.href);
        }
      }
      return rules.length;
    };
    for (const sheet of document.styleSheets) walk(sheet);
    for (const k of Object.keys(faces)) declared.add(k);
    // A face from a sheet we could not read means that sheet did load: do not blame unreadable remote sheets then.
    const unexplained = Object.keys(faces).some((k) => !known.has(k));
    const used = new Set();
    const seen = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      const ff = getComputedStyle(el).fontFamily;
      if (seen.has(ff)) continue;
      seen.add(ff);
      for (const k of ff.split(',')) used.add(norm(k).toLowerCase());
    }
    const gone = [], partial = [];
    for (const k of declared) {
      if (!used.has(k.toLowerCase())) continue;
      const f = faces[k];
      if (!f) gone.push(k);
      else if (f.error || f.loading) (f.loaded ? partial : gone).push(f.loaded ? `${k}（${f.error + f.loading} 个分片没加载）` : k);
    }
    const tip = '先运行 article2media 的 fonts.mjs 把字体下载到本地，出图就不再依赖网络';
    if (gone.length) issues.push({ level: 'warn', where: '字体', msg: `字体没有加载：${gone.join('、')}，这些字已回退到系统字体，版面会和样张不同。${tip}` });
    if (partial.length) issues.push({ level: 'warn', where: '字体', msg: `字体只加载了一部分：${partial.join('、')}，部分文字回退到了系统字体。${tip}` });
    const dead = deadSheets.filter((h) => !/^https?:/.test(h) || !unexplained);
    if (dead.length && !gone.length) issues.push({ level: 'warn', where: '字体', msg: `字体样式表没有加载：${dead.map((h) => decodeURIComponent(h.split('/').slice(-2).join('/')).slice(0, 60)).join('、')}，相关文字已回退到系统字体。${tip}` });
  }

  // 5a) Card figures that had to shrink below a readable scale
  if (typeof window.__fit === 'function') window.__fit();
  for (const card of document.querySelectorAll('[data-card][data-dropped]')) {
    if (card.dataset.dropped && card.dataset.dropped !== '图注') {
      const fix = card.dataset.kind === 'cover' ? '想保留就缩短 cover.subtitle、减少 cover.points，或把标题写短' : card.dataset.kind === 'end' ? '想保留就缩短各节的 takeaway 或 cover.summary' : card.dataset.kind === 'stages' || card.dataset.kind === 'guard' ? '想保留就缩短清单项或 paragraphs[0]' : '想保留就缩短 card.text，或用 "mode": "split"';
      issues.push({ level: 'warn', where: where(card.querySelector('.c-body')), msg: `放不下，已自动省略：${card.dataset.dropped}（${fix}）` });
    }
  }
  for (const card of document.querySelectorAll('[data-card][data-fill]')) {
    const f = Number(card.dataset.fill);
    if (card.dataset.fill && f < 0.6) issues.push({ level: 'warn', where: where(card.querySelector('.c-body')), msg: `内容只占了卡片的 ${Math.round(f * 100)}%，有一大块空着：把这张卡的正文写满做法（card.text 60–90 字）、加 1–2 条 bullets，或换一张能画得更满的图` });
  }
  for (const box of document.querySelectorAll('.c-fig-box[data-scale]')) {
    if (box.closest('[hidden]')) continue;
    const z = Number(box.dataset.scale);
    if (z < 1.05) issues.push({ level: 'warn', where: where(box), msg: `图只放大到 ${z.toFixed(2)} 倍，手机上文字偏小：缩短 card.text、去掉 bullets，或改用 split` });
  }

  // 5) Fixed-size cards: content must fit
  const cards = [...document.querySelectorAll('[data-card]')].map((card) => {
    const body = card.querySelector('.c-body');
    const over = body ? body.scrollHeight - body.clientHeight : 0;
    if (over > 1) {
      issues.push({ level: 'error', where: where(body), msg: `卡片内容超出 ${over}px：缩短 card.text、减少 bullets，或改用 "mode": "split"` });
    }
    const r = card.getBoundingClientRect();
    return { idx: Number(card.dataset.card), kind: card.dataset.kind, over: Math.max(0, over), x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  });

  // 6) Page height (long layout)
  const page = document.querySelector('.page') || document.querySelector('.sheet') || document.querySelector('.wx') || document.body;
  const height = Math.ceil(page.getBoundingClientRect().height);
  const width = Math.ceil(page.getBoundingClientRect().width);
  if (!cards.length && height > opts.maxHeight) issues.push({ level: 'warn', where: '整页', msg: `页面高 ${height}px，超过建议上限 ${opts.maxHeight}px：删减内容或拆成两页` });

  return { height, width, issues, cards };
}
