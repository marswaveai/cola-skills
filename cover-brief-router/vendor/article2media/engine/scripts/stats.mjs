#!/usr/bin/env node
// Publishing feedback: record where an output was posted and how it did, then compare themes, cover styles,
// forms and platforms across every work directory.
//
//   node stats.mjs add <工作目录> --platform xhs [--url …] [--views 1200 --likes 80 --saves 150 --comments 9 --shares 12 --follows 5]
//                      [--date 快照日期] [--published 发布日期] [--form … --theme … --cover … --title … --count N] [--post id] [--note …]
//   node stats.mjs list <工作目录>
//   node stats.mjs report [根目录=./article2media-out] [--sort engagement|save_rate|views|likes|saves] [--json]
//
// add creates the post record on first use (what was published is read from content.json and the output folders),
// and appends a metric snapshot afterwards. report writes <根目录>/stats-report.md.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  PLATFORMS, METRICS, FORMS, platformId, readJson, today, isDate, scanOutputs, pickOutput, coverStyleOf, titleFor,
  readPublish, writePublish, publishFile, latestSnapshot,
} from './lib/workdir.mjs';

const CLI = process.env.A2M_CLI || 'stats.mjs';
const MIN_N = 5; // below this a group is marked 样本不足
const USAGE = [
  `用法：node ${CLI} add <工作目录> --platform xhs|wechat|x|douyin|channels|weibo|other [--url 链接] [数据…]`,
  `      node ${CLI} list <工作目录>`,
  `      node ${CLI} report [根目录=./article2media-out] [--sort engagement|save_rate|views|likes|saves] [--json]`,
  '',
  '数据（都可选，可以写 1.2万 / 3k）：--views 阅读/曝光  --likes 点赞  --saves 收藏  --comments 评论  --shares 转发  --follows 涨粉',
  '  --date 2026-11-12       这组数据是哪天看的（默认今天；同一天再记一次会覆盖）',
  '  --published 2026-11-11  发布日期（第一次登记时默认今天）',
  '  --form / --theme / --cover / --title / --count   覆盖自动识别的形式、主题、封面版式、标题、张数',
  '  --post <id>             同一平台发了多条时，指明记到哪一条；--new 强制新建一条',
].join('\n');

let opt, positionals;
try {
  ({ values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      platform: { type: 'string', short: 'p' }, url: { type: 'string' }, post: { type: 'string' }, new: { type: 'boolean', default: false },
      date: { type: 'string' }, published: { type: 'string' }, note: { type: 'string' },
      form: { type: 'string' }, theme: { type: 'string' }, cover: { type: 'string' }, title: { type: 'string' }, count: { type: 'string' }, ratio: { type: 'string' },
      views: { type: 'string' }, impressions: { type: 'string' }, likes: { type: 'string' }, saves: { type: 'string' }, collects: { type: 'string' },
      comments: { type: 'string' }, shares: { type: 'string' }, follows: { type: 'string' },
      sort: { type: 'string', default: 'engagement' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  console.error(`✗ ${e.message}\n\n${USAGE}`);
  process.exit(2);
}
const [cmd, target] = positionals;
if (opt.help || !cmd) { console.error(USAGE); process.exit(opt.help ? 0 : 2); }
const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };

/** "1200", "1,200", "1.2万", "3k", "1.5w" → a non-negative number, or NaN. */
function parseCount(v) {
  const m = String(v).trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*(万|w|k|千|亿)?$/i);
  if (!m) return NaN;
  const mul = { 万: 1e4, w: 1e4, k: 1e3, 千: 1e3, 亿: 1e8 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(Number(m[1]) * mul);
}
const fmt = (n) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (r) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`);
const normUrl = (u) => String(u || '').trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();

function workDir(t) {
  if (!t) die(`缺少工作目录\n\n${USAGE}`, 2);
  const dir = path.resolve(t);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`工作目录不存在：${dir}`);
  if (!fs.existsSync(path.join(dir, 'article.md')) && !fs.existsSync(path.join(dir, 'content.json'))) die(`${dir} 不像一个工作目录（没有 article.md 或 content.json）`);
  return dir;
}

// ---------- add ----------
async function add() {
  const dir = workDir(target);
  const platform = platformId(opt.platform);
  if (!platform) die(`--platform 必填，可用：${Object.entries(PLATFORMS).map(([k, v]) => `${k}（${v}）`).join('、')}`, 2);
  for (const k of ['date', 'published']) if (opt[k] && !isDate(opt[k])) die(`--${k} 要写成 YYYY-MM-DD，收到「${opt[k]}」`, 2);
  if (opt.form && !FORMS[opt.form]) die(`--form 可用：${Object.keys(FORMS).join(' / ')}`, 2);

  const snap = {};
  const given = { ...opt, views: opt.views ?? opt.impressions, saves: opt.saves ?? opt.collects };
  for (const { key, zh } of METRICS) {
    if (given[key] === undefined) continue;
    const n = parseCount(given[key]);
    if (Number.isNaN(n)) die(`--${key}（${zh}）要是非负数字，收到「${given[key]}」`, 2);
    snap[key] = n;
  }

  let rec;
  try { rec = readPublish(dir); } catch (e) { die(e.message); }
  const same = rec.posts.filter((p) => p.platform === platform);
  let post = null;
  if (opt.post) {
    post = rec.posts.find((p) => p.id === opt.post);
    if (!post) die(`没有 id 为 ${opt.post} 的发布记录；已有：${rec.posts.map((p) => p.id).join('、') || '（空）'}`);
  } else if (!opt.new) {
    if (opt.url) post = same.find((p) => normUrl(p.url) === normUrl(opt.url)) || (same.length === 1 && !same[0].url ? same[0] : null);
    else if (same.length === 1) post = same[0];
    else if (same.length > 1) die(`${PLATFORMS[platform]}已有 ${same.length} 条发布记录，说明记到哪一条：--post ${same.map((p) => p.id).join(' | ')}（或用 --url）`, 2);
  }

  const created = !post;
  if (created) {
    const content = readJson(path.join(dir, 'content.json'));
    const outputs = scanOutputs(dir);
    const { output, others } = pickOutput(outputs, { platform, form: opt.form, theme: opt.theme, ratio: opt.ratio, content });
    if (!output && !opt.form) console.log(`⚠ 没有找到${PLATFORMS[platform]}常用形式的产物，形式、主题留空：用 --form / --theme 补上，否则这条不进主题对比`);
    if (others.length) console.log(`⚠ 同一形式有 ${others.length + 1} 个版本，记为 ${output.name}（content.json 写的主题优先，否则取最新）；发的是别的版本（${others.map((o) => o.name).join('、')}）就加 --theme <主题> 重记`);
    const form = opt.form || output?.form || null;
    let n = same.length + 1;
    while (rec.posts.some((p) => p.id === `${platform}-${n}`)) n++;
    post = {
      id: `${platform}-${n}`, platform, url: opt.url || '', published_at: opt.published || today(),
      form, theme: opt.theme || output?.theme || null,
      cover: opt.cover || (form === 'cards' ? await coverStyleOf(content) : null),
      ratio: opt.ratio || output?.ratio || null,
      count: opt.count ? Number(opt.count) : output && !['wechat', 'video'].includes(output.form) ? output.count : null,
      title: opt.title || titleFor(dir, content, platform, output) || '',
      output: output?.name || null,
      snapshots: [],
    };
    rec.posts.push(post);
  } else {
    // Explicit flags correct an existing record; auto-detected values are never re-guessed.
    if (opt.url) post.url = opt.url;
    if (opt.published) post.published_at = opt.published;
    for (const k of ['form', 'theme', 'cover', 'title', 'ratio']) if (opt[k]) post[k] = opt[k];
    if (opt.count) post.count = Number(opt.count);
  }
  if (opt.note) post.note = opt.note;

  let replaced = false;
  if (Object.keys(snap).length) {
    const date = opt.date || today();
    if (date < post.published_at) die(`数据日期 ${date} 早于发布日期 ${post.published_at}`, 2);
    const old = post.snapshots.find((s) => s.date === date);
    if (old) { Object.assign(old, snap); replaced = true; } else post.snapshots.push({ date, ...snap });
    post.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  }
  writePublish(dir, rec);

  const what = [FORMS[post.form] || '形式未知', post.theme && `主题 ${post.theme}`, post.cover && `封面 ${post.cover}`, post.count && `${post.count} 张`].filter(Boolean).join('，');
  console.log(`✓ ${created ? '新建发布记录' : '更新发布记录'} ${post.id}：${PLATFORMS[platform]}，${what}${post.title ? `，标题「${post.title}」` : ''}`);
  if (Object.keys(snap).length) {
    const s = post.snapshots.find((x) => x.date === (opt.date || today()));
    console.log(`✓ ${replaced ? '覆盖' : '记下'} ${s.date} 的数据：${METRICS.filter((m) => s[m.key] !== undefined).map((m) => `${m.zh} ${s[m.key]}`).join('，')}（共 ${post.snapshots.length} 次快照）`);
  } else console.log('⚠ 这次没有数据，只登记了发布；有数据后再运行一次 add');
  if (!post.url) console.log('⚠ 没有帖子链接：下次加 --url，方便回看');
  console.log(`  ${publishFile(dir)}`);
}

// ---------- list ----------
function list() {
  const dir = workDir(target);
  let rec;
  try { rec = readPublish(dir); } catch (e) { die(e.message); }
  if (!rec.posts.length) { console.log(`还没有发布记录：${dir}\n发布后运行 node ${CLI} add "${dir}" --platform <平台> --url <链接>`); return; }
  for (const p of rec.posts) {
    console.log(`${p.id}　${PLATFORMS[p.platform] || p.platform}　${p.published_at}　${[FORMS[p.form] || '形式未知', p.theme, p.cover && `封面 ${p.cover}`, p.count && `${p.count} 张`].filter(Boolean).join(' · ')}`);
    if (p.title) console.log(`  标题：${p.title}`);
    if (p.url) console.log(`  链接：${p.url}`);
    if (!p.snapshots?.length) console.log('  （还没有数据）');
    let prev = null;
    for (const s of p.snapshots || []) {
      const cells = METRICS.filter((m) => s[m.key] !== undefined).map((m) => `${m.zh} ${s[m.key]}${prev && prev[m.key] !== undefined && s[m.key] !== prev[m.key] ? `（${s[m.key] > prev[m.key] ? '+' : ''}${s[m.key] - prev[m.key]}）` : ''}`);
      const r = rates(s);
      console.log(`  ${s.date}　${cells.join('，')}${r.save_rate != null ? `　收藏率 ${pct(r.save_rate)}` : ''}${r.engagement != null ? `　互动率 ${pct(r.engagement)}` : ''}`);
      prev = s;
    }
  }
}

// ---------- report ----------
/** 收藏率 = saves / views; 互动率 = (likes + saves + comments + shares) / views. Null without views. */
function rates(s) {
  if (!s || !(s.views > 0)) return { save_rate: null, engagement: null };
  const parts = ['likes', 'saves', 'comments', 'shares'].filter((k) => s[k] !== undefined);
  return {
    save_rate: s.saves !== undefined ? s.saves / s.views : null,
    engagement: parts.length ? parts.reduce((a, k) => a + s[k], 0) / s.views : null,
  };
}
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const summary = (xs) => (xs.length ? { n: xs.length, median: median(xs), best: Math.max(...xs) } : null);

function groupBy(records, key) {
  const map = new Map();
  for (const r of records) {
    const v = r[key] || '（未记录）';
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(r);
  }
  const rateKey = { engagement: 'engagement', save_rate: 'save_rate' }[opt.sort];
  const sortVal = (g) => (rateKey ? g.rates[rateKey]?.median : g.metrics[opt.sort]?.median) ?? -1;
  return [...map].map(([value, rs]) => ({
    value, n: rs.length, small: rs.length < MIN_N,
    metrics: Object.fromEntries(METRICS.map(({ key: k }) => [k, summary(rs.map((r) => r.latest?.[k]).filter((x) => x !== undefined))])),
    rates: { save_rate: summary(rs.map((r) => r.rates.save_rate).filter((x) => x != null)), engagement: summary(rs.map((r) => r.rates.engagement).filter((x) => x != null)) },
  })).sort((a, b) => a.small - b.small || sortVal(b) - sortVal(a) || (b.metrics.views?.median ?? -1) - (a.metrics.views?.median ?? -1) || b.n - a.n || String(a.value).localeCompare(String(b.value)));
}

function table(label, groups, name = (v) => v) {
  const cell = (s, f = fmt) => (s ? `${f(s.median)} / ${f(s.best)}` : '—');
  return [
    `| ${label} | n | ${METRICS.map((m) => m.zh).join(' | ')} | 收藏率 | 互动率 | 备注 |`,
    `|---|---|${METRICS.map(() => '---').join('|')}|---|---|---|`,
    ...groups.map((g) => `| ${name(g.value)} | ${g.n} | ${METRICS.map((m) => cell(g.metrics[m.key])).join(' | ')} | ${cell(g.rates.save_rate, pct)} | ${cell(g.rates.engagement, pct)} | ${g.small ? `样本不足（n<${MIN_N}），仅供参考` : ''} |`),
  ];
}

function report() {
  if (!['engagement', 'save_rate', ...METRICS.map((m) => m.key)].includes(opt.sort)) die(`--sort 可用：engagement、save_rate、${METRICS.map((m) => m.key).join('、')}`, 2);
  const root = path.resolve(target || 'article2media-out');
  if (!fs.existsSync(root)) die(`根目录不存在：${root}`);
  const records = [];
  const broken = [];
  let dirs = 0;
  for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory() && x.name !== 'batches' && !x.name.startsWith('.'))) {
    const dir = path.join(root, d.name);
    if (!fs.existsSync(publishFile(dir))) continue;
    let rec;
    try { rec = readPublish(dir); } catch (e) { broken.push(e.message); continue; }
    dirs++;
    for (const p of rec.posts) {
      const latest = latestSnapshot(p);
      const days = latest && isDate(latest.date) && isDate(p.published_at) ? Math.round((new Date(latest.date) - new Date(p.published_at)) / 864e5) : null;
      records.push({ dir: d.name, id: p.id, platform: p.platform, form: p.form, theme: p.theme, cover: p.cover, title: p.title, url: p.url, published_at: p.published_at, snapshots: p.snapshots?.length || 0, latest, days, rates: rates(latest) });
    }
  }
  for (const b of broken) console.error(`⚠ 跳过：${b}`);
  const measured = records.filter((r) => r.latest);
  const caveats = [];
  if (records.length > measured.length) caveats.push(`${records.length - measured.length} 条只登记了发布、还没有数据，不计入下表。`);
  const fresh = measured.filter((r) => r.days !== null && r.days < 3).length;
  if (fresh) caveats.push(`${fresh} 条的最新数据是发布后 3 天内看的，数字多半还会涨：和发布更久的帖子放在一起比会偏低。`);
  caveats.push(`每条帖子只取最新一次快照。n<${MIN_N} 的组标了「样本不足」：两三条帖子的差别多半来自选题和发布时机，不来自主题或封面。`);
  caveats.push('不同平台的阅读、曝光口径不一样，「全部平台」的表只看个大概；选主题、封面时看「分平台」的表。');

  const out = {
    root, generated_at: new Date().toISOString(), min_n: MIN_N, sort: opt.sort, dirs, posts: records.length, measured: measured.length, caveats,
    overall: { platform: groupBy(measured, 'platform'), form: groupBy(measured, 'form'), theme: groupBy(measured, 'theme'), cover: groupBy(measured.filter((r) => r.cover), 'cover') },
    by_platform: Object.fromEntries([...new Set(measured.map((r) => r.platform))].map((p) => {
      const rs = measured.filter((r) => r.platform === p);
      return [p, { n: rs.length, theme: groupBy(rs, 'theme'), cover: groupBy(rs.filter((r) => r.cover), 'cover'), form: groupBy(rs, 'form') }];
    })),
    records,
  };
  if (!measured.length) {
    if (opt.json) console.log(JSON.stringify(out, null, 2));
    else console.log(`${root} 里还没有带数据的发布记录（${records.length} 条已登记）。发布后运行：node ${CLI} add <工作目录> --platform <平台> --url <链接> --views … --likes …`);
    return;
  }

  const pName = (v) => PLATFORMS[v] || v;
  const fName = (v) => (FORMS[v] ? `${FORMS[v]}（${v}）` : v);
  const md = [
    '# 发布效果报告', '',
    `${today()} · ${dirs} 篇内容 · ${measured.length} 条有数据的发布${records.length > measured.length ? `（另有 ${records.length - measured.length} 条未记数据）` : ''}`, '',
    '单元格是「中位数 / 最高」，取每条帖子最新一次快照。收藏率 = 收藏 ÷ 阅读，互动率 =（点赞 + 收藏 + 评论 + 转发）÷ 阅读；没有阅读数的帖子不算比率。', '',
    ...caveats.map((c) => `- ${c}`), '',
    '## 分平台', '',
    ...Object.entries(out.by_platform).sort((a, b) => b[1].n - a[1].n).flatMap(([p, g]) => [
      `### ${pName(p)}（${g.n} 条${g.n < MIN_N ? `，样本不足` : ''}）`, '',
      ...table('主题', g.theme), '',
      ...(g.cover.length ? [...table('封面版式', g.cover), ''] : []),
      ...(g.form.length > 1 ? [...table('形式', g.form, fName), ''] : []),
    ]),
    '## 全部平台', '',
    ...table('平台', out.overall.platform, pName), '',
    ...table('形式', out.overall.form, fName), '',
    ...table('主题', out.overall.theme), '',
    ...(out.overall.cover.length ? [...table('封面版式', out.overall.cover), ''] : []),
    '## 明细', '',
    '| 内容 | 平台 | 发布 | 形式 | 主题 | 封面 | 标题 | 快照 | 最新数据 | 收藏率 | 互动率 |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...measured.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))).map((r) => `| ${r.dir} | ${pName(r.platform)} | ${r.published_at} | ${r.form || '—'} | ${r.theme || '—'} | ${r.cover || '—'} | ${String(r.title || '').replace(/\|/g, '｜')} | ${r.snapshots} 次${r.days !== null ? `，第 ${r.days} 天` : ''} | ${METRICS.filter((m) => r.latest[m.key] !== undefined).map((m) => `${m.zh} ${r.latest[m.key]}`).join('，')} | ${pct(r.rates.save_rate)} | ${pct(r.rates.engagement)} |`),
    '',
  ].join('\n');
  const file = path.join(root, 'stats-report.md');
  fs.writeFileSync(file, md);
  if (opt.json) console.log(JSON.stringify({ ...out, report: file }, null, 2));
  else {
    console.log(md);
    const enough = Object.entries(out.by_platform).flatMap(([p, g]) => [...g.theme, ...g.cover].filter((x) => !x.small).map((x) => `${pName(p)} ${x.value}（n=${x.n}）`));
    console.log(enough.length ? `✓ 样本够用（n≥${MIN_N}）的组：${enough.join('、')}` : `⚠ 还没有任何主题或封面版式在单个平台上攒够 ${MIN_N} 条：这份报告只能看个大概，不要据此换主题`);
    console.log(`✓ 报告：${file}`);
  }
}

if (cmd === 'add') await add();
else if (cmd === 'list') list();
else if (cmd === 'report') report();
else { console.error(`✗ 未知命令 "${cmd}"\n\n${USAGE}`); process.exit(2); }
