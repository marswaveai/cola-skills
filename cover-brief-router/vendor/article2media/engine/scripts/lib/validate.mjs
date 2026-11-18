// Validate content.json. Errors block rendering; warnings are advisory (mostly length limits).
import { vlen, plain } from './markup.mjs';
import { FIGURE_TYPES } from './figures.mjs';
import { planCards, ratioSpec, xhsLen, COVER_STYLES, CARD_STYLES } from './layout-card.mjs';
import { validatePublishTitles } from './workdir.mjs';

const LIMITS = {
  titleLine: 14,
  heading: 18,
  paragraph: 100,
  bullet: 34,
  takeaway: 30,
  caption: 28,
  note: 24,
  intro: 130,
  closing: 66,
  box: 11,
  tableKey: 11,
  tableVal: 56,
  cardTitle: 14,
  cardText: 44,
  quote: 180,
  stageItem: 34,
};

export function validate(c, { layout = 'long', ratio = '3:4' } = {}) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
  const len = (p, v, max, what) => {
    if (typeof v === 'string' && vlen(v) > max) warn(p, `${what}偏长（约 ${vlen(v)} 字，建议 ≤ ${max}）：「${v.slice(0, 24)}…」`);
  };
  const arr = (p, v, min, what) => {
    if (!Array.isArray(v) || v.length < min) { err(p, `${what}至少需要 ${min} 项`); return false; }
    return true;
  };
  const boxes = (p, list) => (list || []).forEach((t, i) => len(`${p}[${i}]`, typeof t === 'string' ? t : t?.title, LIMITS.box, '图内文字'));

  const info = {};
  if (!c || typeof c !== 'object') return { errors: ['根节点必须是对象'], warnings, info };
  if (!isStr(c.title)) err('title', '缺少大标题');
  else String(c.title).split('\n').forEach((l, i) => len(`title 第 ${i + 1} 行`, l, LIMITS.titleLine, '标题'));
  if (c.lang && !['zh', 'en'].includes(c.lang)) err('lang', '只能是 zh 或 en');
  const okTheme = (t) => typeof t === 'string' && /^[\w-]+$/.test(t);
  if (c.theme !== undefined && !(okTheme(c.theme) || (c.theme && typeof c.theme === 'object' && Object.entries(c.theme).every(([k, v]) => ['long', 'cards', 'wechat'].includes(k) && okTheme(v))))) {
    err('theme', 'theme 必须是主题名（如 "editorial"），或 {"long": "…", "cards": "…", "wechat": "…"}');
  }
  if (!c.source) warn('source', '缺少原文信息，页脚将没有来源行');
  if (!arr('pages', c.pages, 1, 'pages ')) return { errors, warnings, info };
  if (c.pages.length > 4) warn('pages', `共 ${c.pages.length} 页，建议不超过 4 页`);

  c.pages.forEach((pg, pi) => {
    const P = `pages[${pi}]`;
    len(`${P}.intro`, pg.intro, LIMITS.intro, '导语');
    len(`${P}.closing`, pg.closing, LIMITS.closing, '收束句');
    if (!arr(`${P}.sections`, pg.sections, 1, 'sections ')) return;
    const weight = pg.sections.reduce((a, s) => a + (s.kind === 'checklist' ? 2 : 1), 0);
    if (weight > 5) warn(`${P}.sections`, `本页内容较多（${weight} 个单位），渲染后可能过高`);

    pg.sections.forEach((s, si) => {
      const S = `${P}.sections[${si}]`;
      if (!isStr(s.heading)) err(S, '缺少 heading');
      len(`${S}.heading`, s.heading, LIMITS.heading, '小标题');
      (s.paragraphs || []).forEach((t, i) => len(`${S}.paragraphs[${i}]`, t, LIMITS.paragraph, '段落'));

      if (s.kind === 'checklist') {
        if (!arr(`${S}.stages`, s.stages, 1, 'stages ')) return;
        s.stages.forEach((st, j) => {
          if (!isStr(st.title)) err(`${S}.stages[${j}]`, '缺少 title');
          arr(`${S}.stages[${j}].items`, st.items, 1, 'items ');
          (st.items || []).forEach((t, i) => len(`${S}.stages[${j}].items[${i}]`, t, LIMITS.stageItem, '清单项'));
        });
        if (s.guard && !Array.isArray(s.guard.items)) err(`${S}.guard`, 'guard.items 必须是数组');
        // Each guard item sits behind a ✕: it names the mistake. "不写打斗" / "要如实标识" are rules to follow and read backwards.
        (s.guard?.items || []).forEach((t, i) => {
          if (/^(不(?!要)|要|应该?|必须|需要|先|记得|保持)|不超过|至少|如实/.test(plain(t).trim())) {
            warn(`${S}.guard.items[${i}]`, `「${plain(t).slice(0, 18)}」是该做的事，放在 ✕ 后面意思就反了：写成要避开的做法本身（"把对标照搬一遍"），或用"别……"（"别写打斗戏"）`);
          }
        });
        return;
      }
      if (s.kind && s.kind !== 'standard') err(`${S}.kind`, `未知类型 ${s.kind}（只能是 standard / checklist）`);
      (s.bullets || []).forEach((t, i) => len(`${S}.bullets[${i}]`, t, LIMITS.bullet, '要点'));
      len(`${S}.takeaway`, s.takeaway, LIMITS.takeaway, '金句');
      if ((s.figures || []).length > 2) warn(`${S}.figures`, '最多显示 2 张图，多余的会被忽略');
      if (!s.figures?.length && !s.panel) warn(S, '没有图也没有面板，这一节会只有文字');

      (s.figures || []).forEach((f, fi) => checkFigure(f, `${S}.figures[${fi}]`));

      const p = s.panel;
      if (p) {
        const PP = `${S}.panel`;
        if (!['table', 'cards', 'quote'].includes(p.type)) err(PP, `未知面板类型 ${p.type}（table / cards / quote）`);
        if (p.type === 'table' && arr(`${PP}.rows`, p.rows, 1, 'rows ')) {
          p.rows.forEach((r, i) => {
            if (!Array.isArray(r) || r.length < 2) err(`${PP}.rows[${i}]`, '每行必须是 [标签, 内容]');
            else { len(`${PP}.rows[${i}][0]`, r[0], LIMITS.tableKey, '表格标签'); len(`${PP}.rows[${i}][1]`, r[1], LIMITS.tableVal, '表格内容'); }
          });
        }
        if (p.type === 'cards' && arr(`${PP}.items`, p.items, 1, 'items ')) {
          p.items.forEach((it, i) => { len(`${PP}.items[${i}].title`, it.title, LIMITS.cardTitle, '卡片标题'); len(`${PP}.items[${i}].text`, it.text, LIMITS.cardText, '卡片正文'); });
        }
        if (p.type === 'quote') { if (!isStr(p.text)) err(PP, 'quote 面板缺少 text'); len(`${PP}.text`, p.text, LIMITS.quote, '引文'); }
      }
    });
  });

  const ASPECTS = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'];
  const cvIll = c.cover?.illustration;
  if (cvIll !== undefined) {
    const pr = typeof cvIll === 'string' ? cvIll : cvIll?.prompt;
    if (!isStr(pr)) err('cover.illustration', '封面插画需要 prompt：写成 {"prompt": "画面描述"} 或直接写字符串');
    if (cvIll?.aspect && !ASPECTS.includes(cvIll.aspect)) err('cover.illustration.aspect', `aspect 只能是 ${ASPECTS.join(' / ')}`);
  }

  function checkFigure(f, F) {
    if (!f || !FIGURE_TYPES.includes(f.type)) { err(F, `未知图表类型 ${f?.type}（可用：${FIGURE_TYPES.join(', ')}）`); return; }
    len(`${F}.caption`, f.caption, LIMITS.caption, '图注');
    len(`${F}.note`, f.note, LIMITS.note, '图内注释');
    switch (f.type) {
      case 'bar':
        if (arr(`${F}.data`, f.data, 2, 'data ')) f.data.forEach((d, i) => {
          const v = Array.isArray(d) ? d[1] : d?.value;
          if (!Number.isFinite(Number(v))) err(`${F}.data[${i}]`, '数值必须是数字');
        });
        break;
      case 'hbar':
        if (arr(`${F}.data`, f.data, 1, 'data ')) f.data.forEach((d, i) => {
          const ok = Array.isArray(d) ? Number.isFinite(Number(d[1])) : Number.isFinite(Number(d?.value)) || (Array.isArray(d?.range) && d.range.length === 2);
          if (!ok) err(`${F}.data[${i}]`, '需要 value（数字）或 range [低, 高]');
          len(`${F}.data[${i}].label`, Array.isArray(d) ? d[0] : d?.label, 6, '条形标签');
        });
        break;
      case 'stack': if (arr(`${F}.items`, f.items, 2, 'items ')) boxes(`${F}.items`, f.items); break;
      case 'flow': if (arr(`${F}.steps`, f.steps, 2, 'steps ')) { boxes(`${F}.steps`, f.steps); if (f.steps.length > 5) warn(`${F}.steps`, '超过 5 步，画布会很挤'); } break;
      case 'grid': if (arr(`${F}.items`, f.items, 2, 'items ')) { boxes(`${F}.items`, f.items); if (f.items.length > 9) warn(`${F}.items`, '超过 9 项，画布会很挤'); } break;
      case 'converge':
        if (arr(`${F}.sources`, f.sources, 2, 'sources ')) { boxes(`${F}.sources`, f.sources); if (f.sources.length > 6) warn(`${F}.sources`, '超过 6 项，画布会很挤'); }
        if (!isStr(f.target)) err(F, 'converge 缺少 target');
        break;
      case 'tree': if (!isStr(f.root)) err(F, 'tree 缺少 root'); if (arr(`${F}.children`, f.children, 1, 'children ')) boxes(`${F}.children`, f.children); break;
      case 'stats': if (arr(`${F}.items`, f.items, 1, 'items ')) f.items.forEach((it, i) => { if (!it?.value) err(`${F}.items[${i}]`, '缺少 value'); }); break;
      case 'equation': if (arr(`${F}.terms`, f.terms, 2, 'terms ')) f.terms.forEach((t, i) => { if (!t?.value) err(`${F}.terms[${i}]`, '缺少 value'); }); break;
      case 'path': arr(`${F}.points`, f.points, 2, 'points '); break;
      case 'compare': if (!f.left?.items || !f.right?.items) err(F, 'compare 需要 left.items 和 right.items'); break;
      case 'cycle': if (arr(`${F}.items`, f.items, 2, 'items ')) boxes(`${F}.items`, f.items); break;
      case 'quote': if (!isStr(f.text)) err(F, 'quote 缺少 text'); len(`${F}.text`, f.text, 40, '引语'); break;
      case 'image': if (!isStr(f.src)) err(F, 'image 缺少 src'); break;
      case 'illustration':
        if (!isStr(f.prompt)) err(F, 'illustration 缺少 prompt（画面描述）');
        if (f.aspect && !ASPECTS.includes(f.aspect)) err(`${F}.aspect`, `aspect 只能是 ${ASPECTS.join(' / ')}`);
        break;
      case 'svg':
        if (!isStr(f.svg) || !/<svg[^>]*viewBox/i.test(f.svg)) err(F, 'svg 必须是带 viewBox 的 <svg> 字符串');
        if (/<script|\son\w+=/i.test(f.svg || '')) warn(F, 'svg 中的脚本和事件属性会被移除');
        if (/#[0-9a-f]{3,8}\b|rgb\(/i.test(f.svg || '')) warn(F, 'svg 里写死了颜色，换主题时不会跟着变；请改用 f-acc / s-acc 等 class');
        break;
    }
  }

  // ---- 3:4 card layout (小红书) ----
  if (layout === 'card') {
    const spec = ratioSpec(ratio);
    const plan = planCards(c, ratio);
    // Checklist stages are packed optimistically and re-packed after measuring, so the real count can be one higher.
    const most = planCards(c, ratio, Math.round(spec.budget * 0.06)).length;
    info.cards = plan.length;
    info.cardsMax = Math.max(most, plan.length);
    if (plan.length > spec.limit) {
      err('cards', `将生成 ${plan.length} 张卡片，超过 ${spec.name} 单篇上限 ${spec.limit} 张：给次要的节加 "card": {"mode": "skip"}，或少用 split`);
    } else if (info.cardsMax > spec.limit) {
      warn('cards', `预计 ${plan.length} 张，但清单分页后可能变成 ${info.cardsMax} 张，超过 ${spec.name} 上限 ${spec.limit} 张：先 skip 一节次要的，留出余量`);
    }
    const cover = c.cover || {};
    String(cover.title || c.title || '').split('\n').forEach((l, i) => len(`cover.title 第 ${i + 1} 行`, l, 10, '封面标题'));
    // Cover layout and the data it needs.
    if (cover.style !== undefined && !COVER_STYLES.includes(cover.style)) err('cover.style', `封面版式只能是 ${COVER_STYLES.join(' / ')}`);
    if (cover.style === 'number' && !cover.number?.value) err('cover.number', 'style 为 number 时需要 cover.number: {"value": "413", "unit": "个文件", "label": "一句解释"}');
    if (cover.style === 'versus' && !(cover.versus?.left?.value && cover.versus?.right?.value)) err('cover.versus', 'style 为 versus 时需要 cover.versus: {"left": {"label", "value", "note"}, "right": {…}}');
    if (cover.style === 'image' && !cover.illustration) err('cover.illustration', 'style 为 image 时需要封面插画 cover.illustration');
    len('cover.number.value', cover.number?.value, 5, '封面大数字');
    len('cover.number.label', cover.number?.label, 24, '封面数字说明');
    for (const side of ['left', 'right']) {
      len(`cover.versus.${side}.value`, cover.versus?.[side]?.value, 4, '对比数值');
      len(`cover.versus.${side}.note`, cover.versus?.[side]?.note, 20, '对比说明');
    }
    (cover.points || []).slice(0, 4).forEach((t, i) => len(`cover.points[${i}]`, t, 12, '封面要点（hook 版式显示前 4 条）'));
    len('cover.subtitle', cover.subtitle, 60, '封面副标题');
    (cover.points || []).forEach((t, i) => len(`cover.points[${i}]`, t, 16, '封面要点'));
    if (!c.xhs) warn('xhs', '没有小红书文案（xhs.title / caption / tags），caption.md 会用自动摘要');
    if (!(c.publish?.titles?.xhs || []).length) warn('publish.titles', '没有备选标题：写 "publish": {"titles": {"xhs": ["…", "…", "…"]}}，3 个角度不同的（给结果、给数字、点反常识），发布清单会列出来让用户挑');
    else {
      if (xhsLen(c.xhs.title) > 20) err('xhs.title', `小红书标题最多 20 个字符（字母、空格也算），当前 ${xhsLen(c.xhs.title)} 个`);
      if ((c.xhs.caption || '').length > 1000) err('xhs.caption', `正文最多 1000 字，当前 ${c.xhs.caption.length} 字`);
      if ((c.xhs.tags || []).length > 10) warn('xhs.tags', '话题标签建议不超过 10 个');
    }
    c.pages.forEach((pg, pi) => (pg.sections || []).forEach((s, si) => {
      const S = `pages[${pi}].sections[${si}].card`;
      const cd = s.card;
      if (!cd) {
        len(`pages[${pi}].sections[${si}].paragraphs[0]（卡片默认正文）`, s.paragraphs?.[0], 90, '卡片正文');
        return;
      }
      if (cd.mode && !['single', 'split', 'skip'].includes(cd.mode)) err(`${S}.mode`, 'mode 只能是 single / split / skip');
      if (cd.style !== undefined) {
        if (!CARD_STYLES.includes(cd.style)) err(`${S}.style`, `整页卡型只能是 ${CARD_STYLES.join(' / ')}`);
        else if (cd.style === 'quote' && !(cd.quote || s.takeaway)) err(`${S}.style`, 'quote 卡需要 card.quote 或这一节的 takeaway');
        else if (cd.style === 'number' && !cd.number?.value) err(`${S}.number`, 'number 卡需要 card.number: {"value": "413", "unit": "个文件", "label": "一句解释"}');
        else if (cd.style === 'image' && !(s.figures || []).length) err(`${S}.style`, 'image 卡需要这一节有图（figures）');
        len(`${S}.quote`, cd.style === 'quote' ? cd.quote || s.takeaway : '', 26, '整页金句');
        // A full card without split replaces the section's card: its figure and panel never reach the carousel.
        if ((cd.style === 'quote' || cd.style === 'number') && cd.mode !== 'split' && s.panel) {
          warn(`${S}.style`, `整页卡会替换这一节的卡片，这一节的面板（${plain(s.panel.title || '').slice(0, 12)}）和图都不会出现在卡片上：做法在别的卡上讲过就保留；没讲过就写 "mode": "split"，整页卡后面再接一张正常的卡`);
        }
        len(`${S}.number.value`, cd.number?.value, 5, '整页大数字');
        len(`${S}.number.label`, cd.number?.label, 24, '数字说明');
      }
      if (cd.figure !== undefined && cd.figure !== 'none' && !(Number.isInteger(cd.figure) && (s.figures || [])[cd.figure])) err(`${S}.figure`, 'figure 必须是已有图的下标（0 或 1）或 "none"');
      len(`${S}.text`, cd.text ?? s.paragraphs?.[0], 90, '卡片正文');
      (cd.bullets || []).forEach((t, i) => len(`${S}.bullets[${i}]`, t, 26, '卡片要点'));
    }));
  }

  // publish.titles: per-platform title candidates for the publish checklist (same rule as batch.mjs checklist)
  if (c.publish !== undefined) {
    const r = validatePublishTitles(c);
    errors.push(...(r.errors || []));
    warnings.push(...(r.warnings || []));
  }

  // Optional fields for cover variants and the lighter forms
  if (c.cover?.alts !== undefined) {
    if (!Array.isArray(c.cover.alts) || c.cover.alts.some((a) => !a || typeof a !== 'object')) err('cover.alts', '封面备选要写成数组，每项是要替换的封面字段，例如 [{"title": "…", "style": "number"}]');
    else c.cover.alts.forEach((a, i) => {
      if (a.style !== undefined && !COVER_STYLES.includes(a.style)) err(`cover.alts[${i}].style`, `封面版式只能是 ${COVER_STYLES.join(' / ')}`);
      String(a.title || '').split('\n').forEach((l, j) => len(`cover.alts[${i}].title 第 ${j + 1} 行`, l, 10, '封面标题'));
    });
    if ((c.cover.alts || []).length > 4) warn('cover.alts', '封面备选建议不超过 4 个：挑差别大的写');
  }
  if (c.qa !== undefined) {
    if (!Array.isArray(c.qa) || c.qa.some((p) => !isStr(p?.q) || !isStr(p?.a))) err('qa', '问答要写成 [{"q": "问题", "a": "回答"}, …]，问题和回答都不能为空');
    else c.qa.forEach((p, i) => { len(`qa[${i}].q`, p.q, 24, '问题'); len(`qa[${i}].a`, p.a, 70, '回答'); });
  }
  if (c.quotes !== undefined) {
    if (!Array.isArray(c.quotes)) err('quotes', '金句要写成数组：["一句话", {"text": "一句话", "by": "谁说的"}]');
    else c.quotes.forEach((q, i) => len(`quotes[${i}]`, typeof q === 'string' ? q : q?.text, 26, '金句'));
  }
  (c.onepage?.points || []).forEach((p, i) => len(`onepage.points[${i}]`, typeof p === 'string' ? p : p?.text, 30, '一页看完的要点'));

  // Depth: panels and figures are where a summary carries more than its headings.
  const std = c.pages.flatMap((pg) => pg.sections || []).filter((s) => s.kind !== 'checklist');
  const nPanels = std.filter((s) => s.panel).length;
  const wantPanels = Math.max(1, Math.ceil(std.length / 2));
  if (std.length >= 3 && nPanels < wantPanels) {
    warn('panels', `${std.length} 节只有 ${nPanels} 个数据面板，建议至少 ${wantPanels} 个（每两节一个）：把原文里的对照、清单、原话、一组数字、具体做法放进 panel（table / cards / quote），标题写成「内容 · 出处」`);
  }
  std.forEach((s) => {
    if ((s.figures || []).length === 1) warn(`「${plain(s.heading).replace(/\n/g, '')}」`, '只有 1 张图：每节两张图互补，一张讲结构或数据，一张讲观点或对比');
  });

  // Thin text: a reader takes away the method only if the card says how, not just what.
  std.forEach((s) => {
    const name = `「${plain(s.heading).replace(/\n/g, '')}」`;
    const paras = (s.paragraphs || []).reduce((a, p) => a + vlen(p), 0);
    if (paras < 100) warn(name, `正文只有约 ${Math.round(paras)} 字，偏薄：写两段（每段 60–90 字），第一段讲作者的做法或观点，第二段讲理由、条件或例子`);
    const ct = s.card?.text ?? s.paragraphs?.[0];
    if (layout === 'card' && !s.card?.style && s.card?.mode !== 'skip' && ct && vlen(ct) < 55) {
      warn(`${name}.card`, `卡片正文只有约 ${Math.round(vlen(ct))} 字，读者带不走做法：写到 60–90 字，讲清怎么做（步骤、条件、例子、数字），不要只重复标题`);
    }
  });

  // The same sentence twice in one set reads as filler.
  const seen = new Map();
  const say = (where, t) => {
    const k = plain(t || '').replace(/[\s，。、：；！？,.:;!?“”"「」…—\-]/g, '');
    if (k.length < 6) return;
    for (const [k2, w2] of seen) {
      if (w2 !== where.split('.')[0] && (k === k2 || (k.length >= 10 && (k.includes(k2) || k2.includes(k))))) { warn(where, `和 ${w2} 说的是同一句话（「${plain(t).slice(0, 20)}」）：换一个角度写，或删掉一处`); return; }
    }
    seen.set(k, where);
  };
  std.forEach((s, i) => {
    const w = `第 ${i + 1} 节`;
    say(`${w}.takeaway`, s.takeaway);
    say(`${w}.card.quote`, s.card?.quote);
    say(`${w}.card.number.label`, s.card?.number?.label);
  });
  say('cover.summary', c.cover?.summary);

  // Production notes belong in the delivery reply, not in the picture.
  const notes = [['footnote', c.footnote], ['cover.summary', c.cover?.summary], ...c.pages.map((p, i) => [`pages[${i}].closing`, p.closing])];
  for (const [where, t] of notes) {
    if (typeof t === 'string' && /没(有)?抓(取)?到|未抓取|抓取不全|推广.{0,6}(略去|删|去掉)|(略去|删掉|去掉).{0,8}(推广|广告|个人介绍)|嵌入的推文/.test(t)) {
      warn(where, '写了制作过程（没抓到什么、删了推广）：图里只写来源和"编者整理了什么"，制作说明放在交付回复里');
    }
    if (where !== 'footnote' && typeof t === 'string' && /来源[:：]/.test(t)) warn(where, '收束句里混进了来源：来源只写在页脚 footnote');
  }

  // A full-card variant every 3–4 cards; a long carousel of identical cards reads flat.
  if (layout === 'card') {
    const secs = std.filter((s) => s.card?.mode !== 'skip');
    const styled = secs.filter((s) => s.card?.style).length;
    const want = Math.round(secs.length / 3.5);
    if (secs.length >= 5 && styled < want) {
      warn('cards', `${secs.length} 张内容卡里只有 ${styled} 张整页卡，建议 ${want} 张：每 3–4 张安排一张（"card": {"style": "quote"} 金句，或 "number" 大数字、"image" 整页图），选这一节本身就有那句话、那个数字的`);
    }
    // A big number has to answer its own heading ("每 30 分钟巡检" over "200+" reads as a mismatch).
    secs.filter((s) => s.card?.style === 'number' && s.card.number?.value).forEach((s) => {
      const h = plain(s.heading);
      const hn = h.match(/\d[\d,.]*/g) || [];
      const v = String(s.card.number.value).replace(/,/g, '');
      if (hn.length && !hn.some((n) => v.includes(n.replace(/,/g, '')))) {
        warn(`「${h.replace(/\n/g, '')}」.card.number`, `标题说的是 ${hn.join('、')}，大数字却是 ${s.card.number.value}：大数字要回答这一节的标题。换成标题里的数字，或把标题改成讲这个数字`);
      }
    });
  }

  // ---- 公众号 ----
  if (layout === 'wechat') {
    const w = c.wechat || {};
    if (w.title && String(w.title).length > 64) err('wechat.title', `公众号标题最多 64 字，当前 ${String(w.title).length} 字`);
    if (w.digest && String(w.digest).length > 120) err('wechat.digest', `公众号摘要最多 120 字，当前 ${String(w.digest).length} 字`);
    if (!w.title || !w.digest) warn('wechat', '没有写 wechat.title / wechat.digest，会用大标题和第一页导语自动生成');
  }

  return { errors, warnings, info };
}
