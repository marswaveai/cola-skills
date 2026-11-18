// What a work directory (article2media-out/<slug>/) holds, read back from disk: the outputs that were rendered
// (form, theme, ratio, files, QA errors), the titles and captions that go with them, the publish.json record of
// where they were posted, and the publish.md checklist. Shared by stats.mjs and batch.mjs; nothing here renders.
import fs from 'node:fs';
import path from 'node:path';

export const PLATFORMS = { xhs: '小红书', wechat: '公众号', x: 'X', douyin: '抖音', channels: '视频号', weibo: '微博', other: '其他' };
const PLATFORM_ALIASES = {
  小红书: 'xhs', xiaohongshu: 'xhs', red: 'xhs', rednote: 'xhs', 公众号: 'wechat', 微信: 'wechat', gzh: 'wechat', mp: 'wechat', weixin: 'wechat',
  twitter: 'x', 推特: 'x', 抖音: 'douyin', tiktok: 'douyin', 视频号: 'channels', 微博: 'weibo', 其他: 'other',
};
export const platformId = (v) => {
  const k = String(v || '').trim().toLowerCase();
  return PLATFORMS[k] ? k : PLATFORM_ALIASES[k] || null;
};

// Metric keys are neutral; every platform has its own word for them.
export const METRICS = [
  { key: 'views', zh: '阅读/曝光' },
  { key: 'likes', zh: '点赞' },
  { key: 'saves', zh: '收藏' },
  { key: 'comments', zh: '评论' },
  { key: 'shares', zh: '转发' },
  { key: 'follows', zh: '涨粉' },
];
export const FORMS = {
  cards: '总结卡片', 'cards-original': '原文卡片', long: '总结长图', 'long-original': '原文长图',
  wechat: '公众号排版', video: '口播视频', whiteboard: '白板', comic: '漫画',
};
// Which forms a platform usually takes, most likely first (used to guess what a post was).
const PLATFORM_FORMS = {
  xhs: ['cards', 'cards-original', 'comic', 'video'],
  wechat: ['wechat'],
  x: ['long', 'long-original', 'cards', 'video'],
  douyin: ['video', 'cards'],
  channels: ['video'],
  weibo: ['long', 'cards', 'long-original'],
  other: Object.keys(FORMS),
};
export const LIMITS = { xhsTitle: 20, xhsBody: 1000, xhsImages: 18, wechatTitle: 64, wechatDigest: 120, xImages: 4 };

export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(new Date(s).getTime());
/** Length the way 小红书 counts a title: every code point is one, letters and spaces included (same as layout-card's xhsLen). */
export const cpLen = (t) => [...String(t ?? '')].length;
/** Inline marks and forced line breaks removed: "一个人\n指挥**AI 剧组**" → "一个人指挥AI 剧组". */
export const plainTitle = (t) => String(t ?? '').replace(/\*\*|==|__/g, '').replace(/\s*\n\s*/g, (m, i, s) => (/[A-Za-z0-9]/.test(s[i - 1] || '') || /[A-Za-z0-9]/.test(s[i + m.length] || '') ? ' ' : '')).trim();

/** Front matter of an article file as a flat object (values are JSON strings as fetch.mjs writes them, or bare). */
export function frontMatter(file) {
  const fm = readText(file).match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  const out = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch { out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  }
  return out;
}

// ---------- outputs ----------

const numbered = (files, stem) => files.filter((f) => new RegExp(`^${stem}-\\d+\\.(png|jpe?g)$`).test(f)).sort();

function classify(dir, name) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  const qaFile = files.includes('qa.json') ? 'qa.json' : files.includes('review.json') ? 'review.json' : null;
  const qa = qaFile ? readJson(path.join(dir, qaFile)) : null;
  const first = Array.isArray(qa) ? qa[0] : qa;
  const issues = (Array.isArray(qa) ? qa.flatMap((x) => x?.issues || []) : qa?.issues) || [];
  const cards = numbered(files, 'card');
  const pages = numbered(files, 'page');
  const fulls = files.filter((f) => /^full(-\d+)?\.png$/.test(f)).sort();
  const base = path.basename(name);
  const ratio = base.match(/(?:^|-)(\d+)x(\d+)(?:-|$)/);
  const o = {
    name, path: dir, form: null, theme: first?.theme || null, ratio: ratio ? `${ratio[1]}:${ratio[2]}` : null, files: [], cover: null,
    qa: qaFile ? (qa ? qaFile : 'unreadable') : null,
    errors: issues.filter((x) => x.level === 'error').length,
    warnings: issues.filter((x) => x.level !== 'error').length,
    mtime: fs.statSync(dir).mtimeMs,
  };
  const prefix = (re) => base.replace(re, '') || null;
  if (files.includes('video.mp4')) Object.assign(o, { form: 'video', theme: base, files: ['video.mp4'], cover: files.includes('cover.png') ? 'cover.png' : null, ratio: '9:16' });
  else if (files.includes('wechat.md') || files.includes('article-body.html')) Object.assign(o, { form: 'wechat', theme: o.theme || prefix(/-wechat.*$/), files: ['article.html'], cover: files.includes('cover-2.35x1.png') ? 'cover-2.35x1.png' : null, ratio: null });
  else if (files.includes('comic.png')) Object.assign(o, { form: 'comic', theme: null, files: cards.length ? cards : ['comic.png'], cover: cards[0] || 'comic.png', ratio: cards.length ? '3:4' : null });
  else if (files.includes('whiteboard.png')) Object.assign(o, { form: 'whiteboard', theme: null, files: ['whiteboard.png'], cover: 'whiteboard.png' });
  else if (cards.length) {
    const original = (qa && !Array.isArray(qa) && 'verify' in qa) || files.includes('ledger.json');
    Object.assign(o, { form: original ? 'cards-original' : 'cards', theme: original ? prefix(/-?full.*$/) : o.theme || prefix(/-\d+x\d+.*$/), files: cards, cover: cards[0] });
  } else if (pages.length) Object.assign(o, { form: 'long', theme: o.theme || base, files: pages, cover: pages[0] });
  else if (fulls.length) Object.assign(o, { form: 'long-original', theme: prefix(/-?full$/), files: fulls, cover: fulls[0] });
  else return null;
  if (qaFile && !qa) o.errors = 1; // an unreadable QA file is not a pass
  o.count = o.files.length;
  return o;
}

/** Every rendered output under a work directory, newest first. Videos live one level down (video/<theme>/). */
export function scanOutputs(dir) {
  const out = [];
  let subs;
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')); } catch { return out; }
  for (const d of subs) {
    const o = classify(path.join(dir, d.name), d.name);
    if (o) { out.push(o); continue; }
    if (!/^video/.test(d.name)) continue;
    for (const s of fs.readdirSync(path.join(dir, d.name), { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const v = classify(path.join(dir, d.name, s.name), `${d.name}/${s.name}`);
      if (v?.form === 'video') out.push(v);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export const contentTheme = (content, form) => {
  const t = content?.theme;
  if (!t) return null;
  if (typeof t === 'string') return t;
  return t[{ cards: 'cards', long: 'long', wechat: 'wechat' }[form]] || null;
};

/**
 * The output a post on `platform` most likely used. Explicit form / theme / ratio narrow it; among equals the
 * theme written in content.json wins, then the newest. Returns { output, others } — others are same-form alternates.
 */
export function pickOutput(outputs, { platform = 'other', form, theme, ratio, content } = {}) {
  const forms = form ? [form] : PLATFORM_FORMS[platform] || PLATFORM_FORMS.other;
  for (const f of forms) {
    let pool = outputs.filter((o) => o.form === f && (!theme || o.theme === theme) && (!ratio || o.ratio === ratio));
    if (!pool.length) continue;
    if (platform === 'xhs' && !ratio && pool.some((o) => o.ratio === '3:4')) pool = pool.filter((o) => o.ratio === '3:4');
    const want = contentTheme(content, f);
    const output = pool.find((o) => o.theme === want) || pool[0];
    return { output, others: pool.filter((o) => o !== output) };
  }
  return { output: null, others: [] };
}

/** Cover layout of designed cards (hook / number / versus / quote / image / toc), as the renderer resolves it. */
export async function coverStyleOf(content) {
  if (!content) return null;
  try {
    const { coverStyle } = await import('./layout-card.mjs');
    return coverStyle(content);
  } catch {
    const c = content.cover || {};
    return c.style || (c.illustration ? 'image' : c.number?.value ? 'number' : c.versus ? 'versus' : 'hook');
  }
}

// ---------- titles, captions ----------

// No `m` flag: `$` must mean the end of the text, or a section would stop at its first line.
const mdSection = (text, heading) => text.match(new RegExp(`(?:^|\\n)#{1,2} ${heading}[^\\n]*\\n+([\\s\\S]*?)(?=\\n#{1,2} |\\n---\\n|$)`))?.[1]?.trim() || '';

/** 小红书 post text: content.json's xhs field when written, otherwise what the renderer put in caption.md. */
export function xhsPost(content, output) {
  const cap = output ? readText(path.join(output.path, 'caption.md')) : '';
  const lines = mdSection(cap, '正文').split('\n');
  const tagLine = lines.findLast?.((l) => /^#\S+(\s+#\S+)*$/.test(l.trim())) || '';
  const capBody = lines.filter((l) => l !== tagLine).join('\n').trim();
  const x = content?.xhs || {};
  const tags = x.tags?.length ? x.tags.map((t) => '#' + String(t).replace(/^#/, '').replace(/\s+/g, '')) : tagLine.trim().split(/\s+/).filter(Boolean);
  return { title: x.title || mdSection(cap, '标题').split('\n')[0] || '', body: x.caption?.trim() || capBody, tags, auto: !x.caption };
}

export function wechatPost(content, output) {
  const notes = output ? readText(path.join(output.path, 'wechat.md')) : '';
  return {
    title: mdSection(notes, '标题').split('\n')[0] || content?.wechat?.title || '',
    digest: mdSection(notes, '摘要') || content?.wechat?.digest || '',
  };
}

export function videoPost(output) {
  const post = output ? readText(path.join(output.path, 'post.md')) : '';
  return { title: mdSection(post, '标题').split('\n')[0] || '', body: mdSection(post, '正文'), before: mdSection(post, '发布前') };
}

/** The title a post on this platform went out with, as far as the files tell. */
export function titleFor(dir, content, platform, output) {
  const article = frontMatter(path.join(dir, 'article.md')).title || '';
  if (output?.form === 'video') return videoPost(output).title || plainTitle(content?.title) || article;
  if (platform === 'xhs') return xhsPost(content, output).title || plainTitle(content?.title) || article;
  if (platform === 'wechat') return wechatPost(content, output).title || article;
  return plainTitle(content?.title) || article;
}

/**
 * publish.titles: alternates per platform, written by the model in content.json. Returns { errors, warnings }.
 * (The same rule belongs in lib/validate.mjs; it is checked here so the checklist never depends on a render.)
 */
export function validatePublishTitles(content) {
  const errors = [], warnings = [];
  const p = content?.publish;
  if (p === undefined) return { errors, warnings };
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { errors: ['publish 必须是对象，例如 {"titles": {"xhs": ["…", "…", "…"]}}'], warnings };
  const t = p.titles;
  if (t === undefined) return { errors, warnings };
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { errors: ['publish.titles 必须是对象：{"xhs": ["…"], "wechat": ["…"], "x": ["…"]}'], warnings };
  for (const [k, list] of Object.entries(t)) {
    const where = `publish.titles.${k}`;
    if (!PLATFORMS[k] || k === 'other') { warnings.push(`${where}：未知平台，可用 ${Object.keys(PLATFORMS).filter((x) => x !== 'other').join(' / ')}`); continue; }
    if (!Array.isArray(list) || !list.length || list.some((s) => typeof s !== 'string' || !s.trim())) { errors.push(`${where} 必须是非空字符串数组`); continue; }
    if (list.length > 5) warnings.push(`${where}：${list.length} 个候选太多，留 3 个最不一样的`);
    if (new Set(list.map((s) => s.trim())).size !== list.length) errors.push(`${where} 里有重复的标题`);
    list.forEach((s, i) => {
      if (/\n/.test(s)) errors.push(`${where}[${i}] 不能换行`);
      if (k === 'xhs' && cpLen(s) > LIMITS.xhsTitle) errors.push(`${where}[${i}]：小红书标题最多 ${LIMITS.xhsTitle} 个字符（字母、空格也算），当前 ${cpLen(s)} 个：「${s}」`);
      if (k === 'wechat' && s.length > LIMITS.wechatTitle) errors.push(`${where}[${i}]：公众号标题最多 ${LIMITS.wechatTitle} 字，当前 ${s.length} 字`);
    });
    const current = k === 'xhs' ? content.xhs?.title : k === 'wechat' ? content.wechat?.title : null;
    if (current && list.some((s) => s.trim() === String(current).trim())) warnings.push(`${where} 里有一个和 ${k}.title 相同：候选是另外的写法，不用重复`);
  }
  return { errors, warnings };
}

// ---------- publish.json ----------

export const publishFile = (dir) => path.join(dir, 'publish.json');
/** publish.json or an empty record; throws on a file that exists but cannot be used (never silently overwrite it). */
export function readPublish(dir) {
  const f = publishFile(dir);
  if (!fs.existsSync(f)) return { version: 1, posts: [] };
  const j = readJson(f);
  if (!j || !Array.isArray(j.posts)) throw new Error(`${f} 不是合法的发布记录（需要 {"version": 1, "posts": [...]}）：先修好或挪走它`);
  return j;
}
export function writePublish(dir, rec) {
  fs.writeFileSync(publishFile(dir), JSON.stringify(rec, null, 2) + '\n');
}
/** Newest snapshot of a post (by date; ties keep file order). */
export const latestSnapshot = (post) => [...(post.snapshots || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1) || null;

// ---------- publish.md ----------

/**
 * Build the publish checklist of one work directory. Pure: returns { md, checks, platforms } and writes nothing.
 * checks: [{ platform, level: 'ok' | 'warn' | 'error', text }]. `schedule` is the user's own plan ({ xhs: '周二 20:00' }).
 */
export function buildPublishKit(dir, { schedule = {}, statsCmd = 'stats.mjs' } = {}) {
  const content = readJson(path.join(dir, 'content.json'));
  const fm = frontMatter(path.join(dir, 'article.md'));
  const outputs = scanOutputs(dir);
  const titles = content?.publish?.titles || {};
  const checks = [];
  const out = [];
  const platforms = [];
  const mark = { ok: '✓', warn: '⚠', error: '✗' };
  const section = (platform, heading, output, others, build) => {
    platforms.push(platform);
    const mine = [];
    const add = (level, text) => { mine.push({ platform, level, text }); };
    const limit = (label, n, max, unit = '字') => add(n <= max ? 'ok' : 'error', `${label} ${n} / ${max} ${unit}${n <= max ? '' : `：超出 ${n - max} ${unit}`}`);
    const body = build({ add, limit });
    if (output.qa === null) add(output.form === 'comic' ? 'ok' : 'warn', output.form === 'comic' ? '漫画没有 qa.json（渲染时已检查对白边界）' : '没有找到检查结果（qa.json），重新渲染一次确认');
    else add(output.errors ? 'error' : 'ok', `版面检查 ${output.errors} 个错误${output.warnings ? `，${output.warnings} 个提示` : ''}${output.errors ? `：先修完 ${path.join(output.path, output.qa)} 里的错误再发` : ''}`);
    checks.push(...mine);
    out.push(`## ${heading}`, '');
    if (schedule[platform]) out.push(`计划发布时间（你在批次里设定的）：${schedule[platform]}`, '');
    out.push('### 检查', '', ...mine.map((c) => `- ${mark[c.level]} ${c.text}`), '', ...body);
    if (others.length) out.push('### 备选版本', '', ...others.map((o) => `- ${o.name}（${o.count} 个文件）：${o.path}`), '');
    out.push('### 发布后', '', '把链接和数据告诉我，或自己记一笔：', '', '```bash', `node ${statsCmd} add "${dir}" --platform ${platform} --url <帖子链接> --views <阅读> --likes <点赞> --saves <收藏> --comments <评论> --shares <转发> --follows <涨粉>`, '```', '');
  };
  const candidates = (platform, current, len, max) => {
    const list = [...new Set([current, ...(titles[platform] || [])].map((s) => String(s || '').trim()).filter(Boolean))];
    return list.map((s, i) => `${i + 1}. ${s}（${len(s)}${max ? ` / ${max}` : ''} 字${max ? (len(s) <= max ? ' ✓' : ' ✗') : ''}）${s === String(current || '').trim() ? '〔当前〕' : ''}`);
  };
  const uploads = (o) => [
    '### 上传顺序', '', `目录：${o.path}`, '',
    ...(o.count > 6 ? [`1–${o.count}. ${o.files[0]} … ${o.files.at(-1)}（按文件名顺序）`] : o.files.map((f, i) => `${i + 1}. ${f}`)),
    '', ...(o.cover ? [`封面：${path.join(o.path, o.cover)}`, ''] : []),
  ];
  const noAlternates = (platform, add) => { if (!(titles[platform] || []).length) add('warn', `没有备选标题：在 content.json 写 publish.titles.${platform}（3 个不同角度的写法）`); };

  // 小红书: fixed-ratio cards.
  let pick = pickOutput(outputs.filter((o) => ['cards', 'cards-original'].includes(o.form)), { platform: 'xhs', content });
  if (pick.output) {
    const o = pick.output;
    const post = xhsPost(content, o);
    section('xhs', `小红书（${o.name}，${o.count} 张 ${o.ratio || ''} 卡片）`, o, pick.others, ({ add, limit }) => {
      if (post.title) limit('标题', cpLen(post.title), LIMITS.xhsTitle, '字符'); else add('error', '没有标题：在 content.json 写 xhs.title');
      const withTags = cpLen(post.body) + (post.tags.length ? cpLen(post.tags.join(' ')) + 2 : 0);
      limit('正文', cpLen(post.body), LIMITS.xhsBody);
      if (cpLen(post.body) <= LIMITS.xhsBody && withTags > LIMITS.xhsBody) add('warn', `正文加上标签共 ${withTags} 字，超过 ${LIMITS.xhsBody}：标签也占正文字数，删几个标签或缩短正文`);
      limit('图片', o.count, LIMITS.xhsImages, '张');
      if (post.auto) add('warn', '正文是自动摘要：在 content.json 的 xhs.caption 里写一版');
      noAlternates('xhs', add);
      return [
        '### 标题候选', '', ...candidates('xhs', post.title, cpLen, LIMITS.xhsTitle), '',
        '### 正文', '', '```text', post.body, '```', '',
        '### 标签', '', post.tags.join(' ') || '（没有标签）', '',
        ...uploads(o),
      ];
    });
  }

  // 公众号: pasted article + two covers.
  pick = pickOutput(outputs, { platform: 'wechat', content });
  if (pick.output) {
    const o = pick.output;
    const post = wechatPost(content, o);
    section('wechat', `公众号（${o.name}）`, o, pick.others, ({ add, limit }) => {
      if (post.title) limit('标题', post.title.length, LIMITS.wechatTitle); else add('error', '没有标题');
      if (post.digest) limit('摘要', post.digest.length, LIMITS.wechatDigest); else add('warn', '没有摘要：用 --digest 或 wechat.digest 写一句');
      const covers = ['cover-2.35x1.png', 'cover-1x1.png'].filter((f) => fs.existsSync(path.join(o.path, f)));
      add(covers.length === 2 ? 'ok' : 'error', `封面 ${covers.length} / 2 张（头图 2.35:1、分享卡片 1:1）`);
      noAlternates('wechat', add);
      return [
        '### 标题候选', '', ...candidates('wechat', post.title, (s) => s.length, LIMITS.wechatTitle), '',
        '标题在公众号后台填写，换候选不用重新排版（头图上的标题要一起换时，用 --cover-title 重排）。', '',
        '### 摘要', '', post.digest || '（没有）', '',
        '### 文件', '',
        `1. 打开 ${path.join(o.path, 'article.html')}，点「复制到公众号」，粘贴进正文`,
        `2. 头图：${path.join(o.path, 'cover-2.35x1.png')}`,
        `3. 分享卡片 / 次条封面：${path.join(o.path, 'cover-1x1.png')}`,
        `4. 完整步骤：${path.join(o.path, 'wechat.md')}`, '',
      ];
    });
  }

  // X: long pages attached to a post.
  pick = pickOutput(outputs, { platform: 'x', form: outputs.some((o) => o.form === 'long') ? 'long' : 'long-original', content });
  if (pick.output) {
    const o = pick.output;
    const title = plainTitle(content?.title) || fm.title || '';
    section('x', `X（${o.name}，${o.count} 张长图）`, o, pick.others, ({ add }) => {
      add(o.count <= LIMITS.xImages ? 'ok' : 'warn', `图片 ${o.count} / ${LIMITS.xImages} 张${o.count <= LIMITS.xImages ? '' : '：单帖放不下，分成线程发'}`);
      noAlternates('x', add);
      return [
        '### 帖子文案候选', '', ...candidates('x', title, cpLen, 0), '',
        ...(fm.url ? ['原文链接（引用或放在回复里）：' + fm.url, ''] : []),
        ...uploads(o),
      ];
    });
  }

  // 视频号 / 抖音: the explainer video.
  pick = pickOutput(outputs, { platform: 'channels', content });
  if (pick.output) {
    const o = pick.output;
    const post = videoPost(o);
    section('channels', `视频号 / 抖音（${o.name}）`, o, pick.others, ({ add }) => {
      add(post.title ? 'ok' : 'warn', post.title ? `标题 ${cpLen(post.title)} 字` : '没有找到 post.md 里的标题');
      return [
        '### 标题候选', '', ...candidates('channels', post.title, cpLen, 0), ...(titles.douyin || []).map((s) => `- 抖音：${s}`), '',
        '### 正文', '', '```text', post.body, '```', '',
        '### 文件', '', `1. 视频：${path.join(o.path, 'video.mp4')}`, ...(o.cover ? [`2. 封面：${path.join(o.path, o.cover)}`] : []), '',
        ...(post.before ? ['### 发布前', '', post.before, ''] : []),
      ];
    });
  }

  const pt = validatePublishTitles(content);
  for (const e of pt.errors) checks.push({ platform: 'titles', level: 'error', text: e });
  for (const w of pt.warnings) checks.push({ platform: 'titles', level: 'warn', text: w });
  const nErr = checks.filter((c) => c.level === 'error').length;
  const nWarn = checks.filter((c) => c.level === 'warn').length;
  const head = [
    '# 发布清单', '',
    `- 标题：${plainTitle(content?.title) || fm.title || path.basename(dir)}`,
    `- 原文：${[fm.author, fm.platform, fm.date].filter(Boolean).join('，') || '—'}${fm.url ? `　${fm.url}` : ''}`,
    `- 工作目录：${dir}`,
    `- 发布检查：${nErr} 个错误，${nWarn} 个提示`, '',
    ...(pt.errors.length || pt.warnings.length ? ['## 备选标题（publish.titles）', '', ...pt.errors.map((e) => `- ✗ ${e}`), ...pt.warnings.map((w) => `- ⚠ ${w}`), ''] : []),
  ];
  if (!platforms.length) head.push('还没有可发布的产物：先出卡片、长图、公众号排版或视频。', '');
  return { md: [...head, ...out].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', checks, platforms, errors: nErr, warnings: nWarn };
}
