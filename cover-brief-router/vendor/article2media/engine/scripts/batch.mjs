#!/usr/bin/env node
// Batch pipeline: fetch a list of links into the usual work directories, keep a queue whose status is always
// recomputed from what is on disk, tell the model the next step, and write the publish checklist.
//
//   node batch.mjs init <links.txt | url | 文件 …> [--name 本周] [--spec "cards:3:4,long,wechat"] [--theme 名称]
//                       [--schedule "xhs=周二 20:00,wechat=周四 08:00"] [--root 目录] [--refetch] [--no-proxy]
//   node batch.mjs status <批次>             重新读盘，更新 queue.json / queue.md 并打印看板
//   node batch.mjs next <批次>               下一条要做的内容和确切的下一步
//   node batch.mjs confirm|skip <批次> <序号…> [--reason 原因]
//   node batch.mjs checklist <批次 | 工作目录>   写 publish.md（上传顺序、标题候选、文案、平台硬性限制）
//
// Queue: <root>/batches/<批次>/queue.json + queue.md. Rewriting is model work; this script never writes content.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detectVideoInput } from './lib/media/transcript.mjs';
import { PLATFORMS, platformId, readJson, readText, today, scanOutputs, readPublish, buildPublishKit } from './lib/workdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..', '..', '..');
const CLI = process.env.A2M_CLI || 'batch.mjs';
const SELF = fs.existsSync(path.join(SKILLS, 'article2media', 'scripts', 'batch.mjs')) ? path.join(SKILLS, 'article2media', 'scripts', 'batch.mjs') : path.join(HERE, 'batch.mjs');
const STATS = fs.existsSync(path.join(SKILLS, 'article2media', 'scripts', 'stats.mjs')) ? path.join(SKILLS, 'article2media', 'scripts', 'stats.mjs') : path.join(HERE, 'stats.mjs');
const wrapper = (skill, name) => path.join(SKILLS, skill, 'scripts', `${name}.mjs`);

const USAGE = [
  `用法：node ${CLI} init <links.txt | 链接 | 文件 …> [--name 批次名] [--spec "cards:3:4,long,wechat"] [--theme 主题] [--schedule "xhs=周二 20:00"] [--refetch] [--no-proxy]`,
  `      node ${CLI} status <批次>      重新读盘并打印看板`,
  `      node ${CLI} next <批次>        下一条内容和确切的下一步`,
  `      node ${CLI} confirm <批次> <序号…>            确认照常做（正文偏短、疑似付费墙的条目）`,
  `      node ${CLI} skip <批次> <序号…> [--reason 原因]  这一条不做了`,
  `      node ${CLI} checklist <批次 | 工作目录>         写发布清单 publish.md`,
  '',
  '--spec 用逗号分隔：cards[:3:4|4:5|1:1|9:16] 总结卡片、long 总结长图、wechat 公众号排版（原文）、wechat-rewrite 公众号总结、',
  '       full 原文长图、full-cards[:比例] 原文卡片、video 口播视频、whiteboard 白板、comic 漫画。默认 long。',
  '--theme 整批固定一个主题；不传时每篇按内容选。--root 输出根目录（默认 ./article2media-out）。',
  'links.txt 每行一个链接或本地文件，# 开头的行是注释。已抓过的链接（同一个目录里有 article.md）会跳过，--refetch 重抓。',
].join('\n');

// What each spec entry needs and which skill makes it. `rewrite`: needs content.json; `model`: the skill writes its own script.
const SPEC = {
  cards: { form: 'cards', ratio: true, rewrite: true, themed: true, skill: 'image-cards', script: 'cards' },
  long: { form: 'long', rewrite: true, themed: true, skill: 'long-image', script: 'long' },
  wechat: { form: 'wechat', themed: true, skill: 'wechat-layout', script: 'wechat' },
  'wechat-rewrite': { form: 'wechat', rewrite: true, themed: true, skill: 'wechat-layout', script: 'wechat' },
  full: { form: 'long-original', skill: 'long-image', script: 'long' },
  'full-cards': { form: 'cards-original', ratio: true, skill: 'image-cards', script: 'cards' },
  video: { form: 'video', themed: true, model: true, skill: 'explainer-video' },
  whiteboard: { form: 'whiteboard', model: true, skill: 'logic-whiteboard' },
  comic: { form: 'comic', model: true, skill: 'article-comic' },
};
const SPEC_ZH = { cards: '总结卡片', long: '总结长图', wechat: '公众号排版', 'wechat-rewrite': '公众号总结', full: '原文长图', 'full-cards': '原文卡片', video: '口播视频', whiteboard: '白板', comic: '漫画' };
const RATIOS = ['3:4', '4:5', '1:1', '9:16'];
const SHORT_CHARS = 500; // below this an "article" is probably a teaser, a paywall stub or a media post
const PAYWALL = /(subscribe to (continue|read|unlock)|sign in to (continue|read)|for (paid|paying) subscribers|登录后(查看|阅读|继续)|付费(阅读|内容|解锁)|开通会员|试读结束|剩余\s*\d+\s*%)/i;

let opt, positionals;
try {
  ({ values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string', short: 'n' }, spec: { type: 'string' }, theme: { type: 'string', short: 't' }, schedule: { type: 'string' },
      root: { type: 'string' }, refetch: { type: 'boolean', default: false }, 'no-proxy': { type: 'boolean', default: false },
      reason: { type: 'string' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  console.error(`✗ ${e.message}\n\n${USAGE}`);
  process.exit(2);
}
const [cmd, ...rest] = positionals;
if (opt.help || !cmd) { console.error(USAGE); process.exit(opt.help ? 0 : 2); }
const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };
const ROOT = path.resolve(opt.root || 'article2media-out');
const batchDir = (name) => path.join(ROOT, 'batches', name);
const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

// ---------- spec ----------
function parseSpec(raw) {
  const forms = String(raw || 'long').split(/[,，]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [key, ...r] = s.split(':');
    const def = SPEC[key];
    if (!def) die(`--spec 里的 "${s}" 不认识，可用：${Object.keys(SPEC).join('、')}`, 2);
    const ratio = r.join(':').replace(/[x×/]/i, ':') || null;
    if (ratio && !def.ratio) die(`--spec：${key} 没有比例（只有 cards / full-cards 可以写 :3:4 这类比例）`, 2);
    if (ratio && !RATIOS.includes(ratio)) die(`--spec：比例 "${ratio}" 不支持，可用 ${RATIOS.join(' / ')}`, 2);
    return { id: def.ratio ? `${key}:${ratio || '3:4'}` : key, key, ratio: def.ratio ? ratio || '3:4' : null };
  });
  if (!forms.length) die('--spec 是空的', 2);
  if (new Set(forms.map((f) => f.id)).size !== forms.length) die('--spec 里有重复的形式', 2);
  return forms;
}
function parseSchedule(raw) {
  const out = {};
  for (const part of String(raw || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([^=＝]+)[=＝](.+)$/);
    const p = m && platformId(m[1]);
    if (!p) die(`--schedule 写成 "平台=时间"，例如 "xhs=周二 20:00,wechat=周四 08:00"；平台可用 ${Object.keys(PLATFORMS).join(' / ')}`, 2);
    out[p] = m[2].trim();
  }
  return out;
}

// ---------- queue file ----------
function loadQueue(name) {
  if (!name) die(`缺少批次名\n\n${USAGE}`, 2);
  const f = path.join(batchDir(name), 'queue.json');
  if (!fs.existsSync(f)) {
    const have = fs.existsSync(path.join(ROOT, 'batches')) ? fs.readdirSync(path.join(ROOT, 'batches')).filter((d) => fs.existsSync(path.join(ROOT, 'batches', d, 'queue.json'))) : [];
    die(`没有批次「${name}」（${f}）。${have.length ? `已有：${have.join('、')}` : `先运行 node ${CLI} init <links.txt> --name ${name}`}`);
  }
  const queue = readJson(f);
  if (!queue || !Array.isArray(queue.items)) die(`${f} 读不了：不是合法的队列文件`);
  return queue;
}
const itemDir = (it) => (it.slug ? path.join(ROOT, it.slug) : null);

// ---------- status (always from disk) ----------
function articleStats(dir) {
  const md = readText(path.join(dir, 'article.md'));
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s*# .*\n/, '');
  const text = body.replace(/!?\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '');
  const chars = text.replace(/\s/g, '').length;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9’'-]+/g) || []).length;
  return { chars, cjk, words, paywall: PAYWALL.test(chars < 1500 ? text : text.slice(-400)), foreign: chars > 0 && cjk / chars < 0.2 };
}

function refresh(queue) {
  const { forms, theme } = queue.spec;
  const needsRewrite = forms.some((f) => SPEC[f.key].rewrite);
  for (const it of queue.items) {
    const dir = itemDir(it);
    const st = { fetched: false, rewritten: needsRewrite ? false : null, rendered: {}, checked: false, kit: false, published: false };
    it.stages = st;
    it.problems = [];
    it.step = null;
    st.fetched = !!dir && fs.existsSync(path.join(dir, 'article.md'));
    if (st.fetched) {
      const meta = readJson(path.join(dir, 'meta.json')) || {};
      const a = articleStats(dir);
      Object.assign(it, { title: meta.title || it.title || '', author: meta.author || it.author || '', platform: meta.platform || it.platform || '', chars: a.chars, words: a.cjk + a.words, foreign: a.foreign });
      it.flags = [
        ...(a.chars < SHORT_CHARS ? [`正文只有约 ${a.cjk + a.words} 字：可能只抓到摘要、被登录墙截断，或内容在图 / 视频里`] : []),
        ...(a.paywall ? ['正文里有付费 / 登录提示，疑似付费墙，内容可能不全'] : []),
      ];
      delete it.error;
    } else it.flags = [];

    const content = st.fetched ? readJson(path.join(dir, 'content.json')) : null;
    const hasContent = st.fetched && fs.existsSync(path.join(dir, 'content.json'));
    if (needsRewrite) st.rewritten = !!content?.pages;
    const outputs = st.fetched ? scanOutputs(dir) : [];
    const found = {};
    for (const f of forms) {
      const def = SPEC[f.key];
      const pool = outputs.filter((o) => o.form === def.form && (!f.ratio || o.ratio === f.ratio) && (!theme || !def.themed || o.theme === theme));
      const ok = f.key === 'wechat-rewrite' && !fs.existsSync(path.join(dir || '', 'rewrite.md')) ? [] : pool;
      const o = ok.find((x) => !x.errors) || ok[0] || null;
      found[f.id] = o;
      st.rendered[f.id] = !o ? 'todo' : o.errors ? 'errors' : 'done';
    }
    st.checked = st.fetched && forms.every((f) => st.rendered[f.id] === 'done');
    st.kit = st.fetched && fs.existsSync(path.join(dir, 'publish.md'));
    try { st.published = st.fetched && readPublish(dir).posts.length > 0; } catch (e) { it.problems.push(e.message); }

    // The one next step, in pipeline order.
    const step = (stage, text, cmd) => { it.step = { stage, text, ...(cmd ? { cmd } : {}) }; };
    const themeArg = theme ? ` --theme ${theme}` : '';
    if (it.skipped) it.state = 'skipped';
    else if (!st.fetched && it.kind === 'video') {
      it.state = 'todo';
      step('视频转文字', '这是视频：用 video-transcript 转成逐字稿文章，输出到这一条的工作目录', `node ${q(wrapper('video-transcript', 'transcribe'))} ${q(it.source)} --out ${q(dir)}`);
    } else if (!st.fetched) {
      it.state = 'failed';
      it.problems.push(`抓取失败：${it.error || 'article.md 不存在'}`);
    } else if (it.flags.length && !it.confirmed) {
      it.state = 'confirm';
      it.problems.push(...it.flags);
    } else if (needsRewrite && !st.rewritten) {
      it.state = 'todo';
      step('改写', hasContent ? 'content.json 读不了或没有 pages：修好它' : `用 article-rewrite 把 article.md 改写成 content.json（${theme ? `主题固定 ${theme}` : '主题按 styles.md 选'}${forms.some((f) => f.key === 'cards') ? '；写 cover、xhs 和 publish.titles.xhs' : ''}${forms.some((f) => /^wechat/.test(f.key)) ? '；写 wechat 和 publish.titles.wechat' : ''}）`);
    } else {
      const f = forms.find((x) => st.rendered[x.id] !== 'done');
      if (!f) it.state = st.published ? 'published' : 'ready';
      else {
        it.state = 'todo';
        const def = SPEC[f.key];
        const o = found[f.id];
        const zh = `${SPEC_ZH[f.key]}${f.ratio ? ` ${f.ratio}` : ''}`;
        const article = fs.existsSync(path.join(dir, 'article.zh.md')) ? 'article.zh.md' : 'article.md';
        if (o?.errors) step(`修 ${f.id}`, `${o.name} 的检查有 ${o.errors} 个错误（${path.join(o.path, o.qa || 'qa.json')}）：按提示改内容后重新渲染`);
        else if (def.model) step(f.id, `按 ${def.skill} 的 SKILL.md 做${zh}（输入 ${path.join(dir, article)}${theme && def.themed ? `，主题 ${theme}` : ''}）`);
        else if (def.rewrite && f.key !== 'wechat-rewrite') step(f.id, `渲染${zh}`, `node ${q(wrapper(def.skill, def.script))} ${q(path.join(dir, 'content.json'))}${f.ratio ? ` --ratio ${f.ratio}` : ''}${themeArg}`);
        else if (f.key === 'wechat-rewrite') step(f.id, '导出改写稿为 rewrite.md，再排公众号', `node ${q(wrapper('article-rewrite', 'export'))} ${q(path.join(dir, 'content.json'))}${themeArg} && node ${q(wrapper('wechat-layout', 'wechat'))} ${q(path.join(dir, 'rewrite.md'))}${themeArg}`);
        else if (it.foreign && article === 'article.md') step(f.id, `原文是外文：先用 article-translate 译成 article.zh.md，再出${zh}`);
        else step(f.id, `渲染${zh}（一字不改）`, `node ${q(wrapper(def.skill, def.script))} ${q(path.join(dir, article))}${f.ratio ? ` --ratio ${f.ratio}` : ''}${themeArg}`);
      }
    }
  }
  queue.updated_at = new Date().toISOString();
  return queue;
}

const STATE_ZH = { published: '已发布', ready: '待发布', todo: '进行中', confirm: '待确认', failed: '失败', skipped: '已跳过' };
const count = (queue, s) => queue.items.filter((it) => it.state === s).length;
const progress = (queue) => `${queue.items.length} 条：${Object.keys(STATE_ZH).map((s) => [STATE_ZH[s], count(queue, s)]).filter(([, n]) => n).map(([l, n]) => `${l} ${n}`).join('，') || '空'}`;

function board(queue) {
  const { forms } = queue.spec;
  const sym = (v) => (v === true || v === 'done' ? '✓' : v === 'errors' ? '✗' : v === null ? '—' : '·');
  const cell = (s) => String(s || '').replace(/\|/g, '｜').replace(/\n/g, ' ');
  const lines = [
    `# 批次：${queue.name}`, '',
    `- 规格：${forms.map((f) => f.id).join('、')}　主题：${queue.spec.theme || '每篇按内容选'}`,
    ...(Object.keys(queue.spec.schedule || {}).length ? [`- 计划发布时间（自己设定的）：${Object.entries(queue.spec.schedule).map(([p, t]) => `${PLATFORMS[p]} ${t}`).join('；')}`] : []),
    `- 进度：${progress(queue)}`,
    `- 更新：${queue.updated_at.replace('T', ' ').slice(0, 16)} UTC（由 batch.mjs status 从磁盘重新计算，不要手改）`, '',
    `| # | 标题 | 字数 | 状态 | 抓取 | 改写 | ${forms.map((f) => f.id).join(' | ')} | 检查 | 清单 | 发布 | 下一步 |`,
    `|---|---|---|---|---|---|${forms.map(() => '---').join('|')}|---|---|---|---|`,
    ...queue.items.map((it) => {
      const s = it.stages;
      const title = it.title || it.source;
      const nextCell = it.state === 'skipped' ? `跳过：${it.skipped}` : it.problems.length ? it.problems[0] : it.step ? `${it.step.stage}` : it.state === 'ready' ? (s.kit ? '发布，然后记数据' : '写发布清单') : it.state === 'published' ? '回填数据' : '';
      return `| ${it.n} | ${cell(title.length > 34 ? title.slice(0, 33) + '…' : title)} | ${it.words ?? '—'} | ${STATE_ZH[it.state]} | ${s.fetched ? '✓' : it.kind === 'video' && it.state !== 'failed' ? '·' : '✗'} | ${sym(s.rewritten)} | ${forms.map((f) => sym(s.rendered[f.id])).join(' | ')} | ${sym(s.checked)} | ${sym(s.kit)} | ${sym(s.published)} | ${cell(nextCell)} |`;
    }),
    '',
  ];
  const blocked = queue.items.filter((it) => ['failed', 'confirm'].includes(it.state));
  if (blocked.length) {
    lines.push('## 需要你确认', '');
    for (const it of blocked) lines.push(`- **#${it.n}** ${it.title || it.source}`, ...it.problems.map((p) => `  - ${p.replace(/\n\s*/g, '；')}`), `  - 来源：${it.source}`, it.state === 'confirm' ? `  - 照常做：\`node ${CLI} confirm ${queue.name} ${it.n}\`；不做了：\`node ${CLI} skip ${queue.name} ${it.n}\`` : `  - 换链接重新 init，或把正文粘贴给我；不做了：\`node ${CLI} skip ${queue.name} ${it.n}\``);
    lines.push('');
  }
  lines.push('## 工作目录', '', ...queue.items.map((it) => `${it.n}. ${itemDir(it) || '（未抓取）'}　← ${it.source}`), '');
  return lines.join('\n');
}

function save(queue) {
  const dir = batchDir(queue.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(queue, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'queue.md'), board(queue));
  return dir;
}

// ---------- init ----------
// Same rule as slugify() in fetch.mjs, which is a script and cannot be imported (the test suite compares the two).
function slugify(meta) {
  if (meta.source === 'x') return `x-${meta.id}`;
  const ascii = (meta.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  if (ascii.length >= 8) return ascii;
  const h = [...(meta.url || meta.title || String(Date.now()))].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `article-${h.toString(36)}`;
}
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
const normUrl = (u) => String(u || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');

function readLinks(args) {
  const links = [];
  for (const a of args) {
    if (fs.existsSync(a) && fs.statSync(a).isFile() && /\.(txt|list|urls)$/i.test(a)) {
      const lines = fs.readFileSync(a, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const base = path.dirname(path.resolve(a));
      const resolved = lines.map((l) => (/^https?:\/\//.test(l) ? l : fs.existsSync(path.resolve(base, l)) ? path.resolve(base, l) : fs.existsSync(l) ? path.resolve(l) : null));
      // A .txt whose lines are all links or files is a list; anything else is treated as an article itself.
      if (lines.length && resolved.every(Boolean)) { links.push(...resolved); continue; }
      if (lines.length && lines.every((l) => !/\s/.test(l) || detectVideoInput(l))) { links.push(...lines); continue; }
    }
    links.push(fs.existsSync(a) ? path.resolve(a) : a);
  }
  return [...new Set(links)];
}

function fetchOne(link, slugHint) {
  const tmp = path.join(ROOT, `.fetch-${process.pid}-${hash(link)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync(process.execPath, [path.join(HERE, 'fetch.mjs'), link, '--kind', 'article', '--out', tmp, ...(opt['no-proxy'] ? ['--no-proxy'] : [])], { encoding: 'utf8', timeout: 300000 });
  const done = (res) => { fs.rmSync(tmp, { recursive: true, force: true }); return res; };
  if (r.status !== 0 || !fs.existsSync(path.join(tmp, 'article.md'))) {
    const err = r.stderr || '';
    const reason = r.error?.code === 'ETIMEDOUT' || r.signal ? '抓取超时（5 分钟）' : (err.match(/\[fetch\] 失败：([\s\S]*)$/)?.[1] || err.match(/\[fetch\] (这[\s\S]*)$/)?.[1] || err.trim().split('\n').slice(-3).join(' ') || `退出码 ${r.status}`).trim().replace(/[：:]?\s*\n\s*/g, '：');
    return done({ ok: false, reason });
  }
  const meta = readJson(path.join(tmp, 'meta.json')) || {};
  const slug = slugHint || slugify(meta);
  const dir = path.join(ROOT, slug);
  const existed = fs.existsSync(path.join(dir, 'article.md'));
  if (existed && !opt.refetch) return done({ ok: true, slug, existed: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['article.md', 'meta.json']) fs.copyFileSync(path.join(tmp, f), path.join(dir, f));
  return done({ ok: true, slug, refetched: existed, hint: (r.stderr.match(/^⚠ (.*)$/m) || [])[1] });
}

function init() {
  if (!rest.length) die(`缺少链接：给一个 links.txt，或直接写几个链接 / 文件\n\n${USAGE}`, 2);
  const name = (opt.name || today()).replace(/[\\/:*?"<>|\s]+/g, '-');
  const file = path.join(batchDir(name), 'queue.json');
  const fresh = !fs.existsSync(file);
  const queue = fresh
    ? { version: 1, name, created_at: new Date().toISOString(), updated_at: '', root: ROOT, spec: { forms: parseSpec(opt.spec), theme: opt.theme || null, schedule: parseSchedule(opt.schedule) }, items: [] }
    : loadQueue(name);
  if (!fresh) {
    // Adding links to an existing batch keeps its spec unless a new one is given explicitly.
    if (opt.spec) queue.spec.forms = parseSpec(opt.spec);
    if (opt.theme) queue.spec.theme = opt.theme;
    if (opt.schedule) queue.spec.schedule = { ...queue.spec.schedule, ...parseSchedule(opt.schedule) };
  }
  fs.mkdirSync(ROOT, { recursive: true });
  // Links fetched before: X posts by id, everything else by the url recorded in meta.json.
  const byUrl = new Map();
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true }).filter((x) => x.isDirectory() && x.name !== 'batches' && !x.name.startsWith('.'))) {
    const url = readJson(path.join(ROOT, d.name, 'meta.json'))?.url;
    if (url && fs.existsSync(path.join(ROOT, d.name, 'article.md'))) byUrl.set(normUrl(url), d.name);
  }
  const links = readLinks(rest);
  const tally = { fetched: 0, existing: 0, video: 0, failed: 0 };
  links.forEach((link, i) => {
    const tag = `[${i + 1}/${links.length}]`;
    let it = queue.items.find((x) => x.source === link);
    if (!it) { it = { n: queue.items.length + 1, source: link, kind: 'article', slug: null }; queue.items.push(it); }
    const isFile = fs.existsSync(link);
    const video = detectVideoInput(link, { isFile });
    const xId = !isFile && link.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/[^/]+\/(?:status(?:es)?|article)\/(\d+)/)?.[1];
    const known = xId && fs.existsSync(path.join(ROOT, `x-${xId}`, 'article.md')) ? `x-${xId}` : byUrl.get(normUrl(link));
    if (video) {
      it.kind = 'video';
      it.slug = known || it.slug || `video-${hash(link)}`;
      const have = fs.existsSync(path.join(ROOT, it.slug, 'article.md'));
      tally[have ? 'existing' : 'video']++;
      console.log(have ? `✓ ${tag} 已有逐字稿，跳过：${it.slug}` : `⚠ ${tag} 是视频，批量抓取不转写：记为待转写（下一步用 video-transcript）　${link}`);
      return;
    }
    if (known && !opt.refetch) {
      it.slug = known;
      tally.existing++;
      console.log(`✓ ${tag} 已抓过，跳过（--refetch 重抓）：${known}`);
      return;
    }
    const r = fetchOne(link, known);
    if (!r.ok) {
      it.error = r.reason;
      tally.failed++;
      console.log(`✗ ${tag} 抓取失败：${r.reason.replace(/\n\s*/g, '；')}　${link}`);
      return;
    }
    it.slug = r.slug;
    delete it.error;
    if (r.existed) { tally.existing++; console.log(`✓ ${tag} 已抓过，跳过（--refetch 重抓）：${r.slug}`); return; }
    tally.fetched++;
    const meta = readJson(path.join(ROOT, r.slug, 'meta.json')) || {};
    console.log(`✓ ${tag} ${meta.title || r.slug}（${[meta.platform, `${(meta.cjk || 0) + (meta.words || 0)} 字`].filter(Boolean).join('，')}）→ ${r.slug}`);
    if (r.refetched && fs.existsSync(path.join(ROOT, r.slug, 'content.json'))) console.log(`  ⚠ 重抓覆盖了 article.md，但 content.json 是按旧原文写的：核对后决定要不要重写`);
    if (r.hint) console.log(`  ⚠ ${r.hint}`);
  });
  refresh(queue);
  for (const it of queue.items.filter((x) => x.state === 'confirm')) console.log(`⚠ #${it.n} ${it.title || it.source}：${it.problems.join('；')}`);
  const dir = save(queue);
  console.log(`\n批次「${name}」${fresh ? '已建立' : '已更新'}：${progress(queue)}（本次新抓 ${tally.fetched}，已有 ${tally.existing}，待转写 ${tally.video}，失败 ${tally.failed}）`);
  console.log(`规格：${queue.spec.forms.map((f) => f.id).join('、')}　主题：${queue.spec.theme || '每篇按内容选'}`);
  console.log(`看板：${path.join(dir, 'queue.md')}\n下一步：node ${CLI} next ${name}`);
  process.exit(tally.failed ? 1 : 0);
}

// ---------- status / next / confirm / skip ----------
function status() {
  const queue = refresh(loadQueue(rest[0]));
  const dir = save(queue);
  if (opt.json) { console.log(JSON.stringify(queue, null, 2)); return; }
  console.log(board(queue));
  console.log(`看板：${path.join(dir, 'queue.md')}`);
}

function next() {
  const queue = refresh(loadQueue(rest[0]));
  save(queue);
  const it = queue.items.find((x) => x.state === 'todo');
  const blocked = queue.items.filter((x) => ['failed', 'confirm'].includes(x.state));
  const ready = queue.items.filter((x) => x.state === 'ready');
  if (opt.json) { console.log(JSON.stringify({ name: queue.name, progress: progress(queue), item: it || null, blocked: blocked.map((x) => ({ n: x.n, source: x.source, problems: x.problems })), ready: ready.map((x) => x.n) }, null, 2)); return; }
  console.log(`批次「${queue.name}」${progress(queue)}`);
  if (it) {
    console.log(`\n▶ #${it.n} ${it.title || it.source}`);
    console.log(`  来源：${it.source}`);
    console.log(`  工作目录：${itemDir(it)}`);
    console.log(`  规格：${queue.spec.forms.map((f) => f.id).join('、')}　主题：${queue.spec.theme || '按 styles.md 选'}`);
    console.log(`  下一步（${it.step.stage}）：${it.step.text}`);
    if (it.step.cmd) console.log(`  命令：${it.step.cmd}`);
    console.log(`  做完后：node ${q(SELF)} next ${queue.name}${opt.root ? ` --root ${q(ROOT)}` : ''}`);
  } else {
    console.log(`\n✓ 能做的都做完了。`);
    if (ready.length) console.log(`  待发布 ${ready.length} 条（#${ready.map((x) => x.n).join('、#')}）：node ${q(SELF)} checklist ${queue.name}${opt.root ? ` --root ${q(ROOT)}` : ''}`);
  }
  if (blocked.length) {
    console.log(`\n⚠ ${blocked.length} 条等用户确认（不要自己决定）：`);
    for (const b of blocked) console.log(`  #${b.n} ${b.title || b.source}：${b.problems.join('；').replace(/\n\s*/g, '；')}`);
  }
}

function mark(kind) {
  const queue = loadQueue(rest[0]);
  const ns = rest.slice(1).map(Number);
  if (!ns.length || ns.some((n) => !queue.items.some((it) => it.n === n))) die(`写出要${kind === 'skip' ? '跳过' : '确认'}的序号（1–${queue.items.length}），例如：node ${CLI} ${kind} ${queue.name} 2`, 2);
  for (const it of queue.items.filter((x) => ns.includes(x.n))) {
    if (kind === 'skip') it.skipped = opt.reason || '用户决定不做';
    else { it.confirmed = true; delete it.skipped; }
    console.log(`✓ #${it.n} ${kind === 'skip' ? `已跳过（${it.skipped}）` : '已确认，照常做'}：${it.title || it.source}`);
  }
  save(refresh(queue));
}

// ---------- checklist ----------
function checklist() {
  const target = rest[0];
  if (!target) die(`缺少批次名或工作目录\n\n${USAGE}`, 2);
  const asDir = path.resolve(target);
  const single = fs.existsSync(asDir) && fs.statSync(asDir).isDirectory() && (fs.existsSync(path.join(asDir, 'article.md')) || fs.existsSync(path.join(asDir, 'content.json')));
  let queue = null;
  let dirs;
  if (single) dirs = [{ dir: asDir, label: path.basename(asDir) }];
  else {
    queue = refresh(loadQueue(target));
    dirs = queue.items.filter((it) => ['ready', 'published'].includes(it.state)).map((it) => ({ dir: itemDir(it), label: `#${it.n} ${it.title || it.slug}` }));
    for (const it of queue.items.filter((x) => !['ready', 'published', 'skipped'].includes(x.state))) console.log(`⚠ #${it.n} ${it.title || it.source}：${STATE_ZH[it.state]}，还没做完，不写清单`);
  }
  let nErr = 0, nWarn = 0;
  for (const { dir, label } of dirs) {
    const kit = buildPublishKit(dir, { schedule: queue?.spec.schedule || {}, statsCmd: q(STATS) });
    if (!kit.platforms.length) { console.log(`✗ ${label}：没有可发布的产物（卡片、长图、公众号排版、视频都没有）`); nErr++; continue; }
    const file = path.join(dir, 'publish.md');
    fs.writeFileSync(file, kit.md);
    nErr += kit.errors; nWarn += kit.warnings;
    console.log(`${kit.errors ? '✗' : '✓'} ${label}：${kit.platforms.map((p) => PLATFORMS[p]).join('、')} → ${file}`);
    for (const c of kit.checks.filter((x) => x.level !== 'ok')) console.log(`  ${c.level === 'error' ? '✗' : '⚠'} ${PLATFORMS[c.platform] || '备选标题'}：${c.text}`);
  }
  if (queue) save(refresh(queue));
  console.log(`发布检查：${nErr} 个错误，${nWarn} 个提示`);
  process.exit(nErr ? 1 : 0);
}

if (cmd === 'init') init();
else if (cmd === 'status') status();
else if (cmd === 'next') next();
else if (cmd === 'confirm' || cmd === 'skip') mark(cmd);
else if (cmd === 'checklist') checklist();
else { console.error(`✗ 未知命令 "${cmd}"\n\n${USAGE}`); process.exit(2); }
