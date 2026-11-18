#!/usr/bin/env node
// Shared renderer behind the long-image, image-cards, wechat-layout and logic-whiteboard skills.
// The input decides the pipeline: an article (.md) is laid out verbatim; a content.json (改写稿) is designed.
//
//   node render.mjs <content.json | article.md> [--layout long|card|wechat|whiteboard] [--ratio 3:4|4:5|1:1|9:16]
//                   [--theme 名称|a,b|all] [--out DIR] [--check] …
//   node render.mjs --list            # list themes
//
//   long  + content.json  手机长图（单栏，1080 px 宽；--wide 为 1200 双栏杂志版）→ <dir>/<theme>/page-01.png …
//   long  + article.md    原文长图：一字不改，逐块校验          → <dir>/full/full.png（过长时 full-01.png …）
//   card  + content.json  固定比例卡片（--ratio，默认 3:4）    → <dir>/<theme>-3x4/card-01.png …, overview.jpg, caption.md
//   card  + article.md    原文卡片：原文分页成卡片，逐块校验     → <dir>/full-3x4/card-01.png …
//   wechat + article.md   公众号排版（只接受文章；改写稿先 export 成 rewrite.md）→ <dir>/<theme>-wechat/article.html …
//   whiteboard            白板论证：article.md → 来源清单；whiteboard.json → whiteboard/whiteboard.png
// 主题：--theme 优先；不传时用 content.json 的 "theme"（文章用 front matter 的 theme）；都没有时用 editorial。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validate } from './lib/validate.mjs';
import { buildPage } from './lib/layout-long.mjs';
import { buildCards, buildCaption, ratioSpec, coverVariants, FORMS } from './lib/layout-card.mjs';
import { resolveBrand, brandCss } from './lib/brand.mjs';
import { findSource, sourceChecks } from './lib/source-check.mjs';
import { resolveIllustrations, resolveImageFigures } from './lib/illustrations.mjs';
import { qaInPage } from './lib/qa.mjs';
import { launchBrowser } from './lib/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIR = path.join(ROOT, 'themes');
const readCss = (name) => fs.readFileSync(path.join(ROOT, 'layouts', name), 'utf8');
const COMPONENTS_CSS = readCss('components.css');

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    layout: { type: 'string', short: 'l' },
    ratio: { type: 'string', short: 'r' },
    theme: { type: 'string', short: 't' },
    out: { type: 'string', short: 'o' },
    scale: { type: 'string', default: '2' },
    format: { type: 'string', default: 'png' },
    quality: { type: 'string', default: '90' },
    page: { type: 'string' },
    'max-height': { type: 'string' },
    wide: { type: 'boolean', default: false },
    form: { type: 'string' },
    covers: { type: 'boolean', default: false },
    issue: { type: 'string' },
    brand: { type: 'string' },
    title: { type: 'string' },
    digest: { type: 'string' },
    'cover-title': { type: 'string' },
    kicker: { type: 'string' },
    author: { type: 'string' },
    hero: { type: 'string' },
    check: { type: 'boolean', default: false },
    'html-only': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

// themes/catalog.json splits the themes into the main set (listed, recommended, what "all" means) and
// legacy ones, which still render by name and point at the main theme that replaces them.
const CATALOG = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, 'catalog.json'), 'utf8'));
function listThemes() {
  return fs
    .readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith('.css'))
    .map((f) => {
      const css = fs.readFileSync(path.join(THEMES_DIR, f), 'utf8');
      const desc = css.match(/^\/\*\s*[\w-]+\s*\|\s*([\s\S]*?)\*\//)?.[1]?.trim() || '';
      const name = f.replace(/\.css$/, '');
      return { name, desc, legacy: CATALOG.legacy[name] || '' };
    })
    .sort((a, b) => !!a.legacy - !!b.legacy || CATALOG.main.indexOf(a.name) - CATALOG.main.indexOf(b.name) || a.name.localeCompare(b.name));
}

if (opt.list) {
  const all = listThemes();
  for (const t of all.filter((x) => !x.legacy)) console.log(`${t.name.padEnd(12)} ${t.desc}`);
  console.log(`\n经典主题（仍可按名字使用，不再主推）：`);
  for (const t of all.filter((x) => x.legacy)) console.log(`${t.name.padEnd(12)} ${t.desc.split('：')[0]}　→ 建议改用 ${t.legacy}`);
  process.exit(0);
}
const CLI = process.env.A2M_CLI || 'render.mjs';
if (opt.help || !positionals[0]) {
  console.error(`用法：node ${CLI} <content.json | article.md> [--ratio 3:4|4:5|1:1|9:16] [--wide] [--form quotes|onepage|qa] [--covers] [--theme 名称|a,b|all] [--out 目录] [--check] [--list]`);
  process.exit(opt.help ? 0 : 2);
}

// Default is the long page; a ratio (or --layout xhs/card) switches to fixed-ratio cards.
const layout = opt.layout
  ? { long: 'long', magazine: 'long', wide: 'long', xhs: 'card', card: 'card', cards: 'card', wechat: 'wechat', mp: 'wechat', gzh: 'wechat', full: 'full', fulltext: 'full', whiteboard: 'whiteboard', wb: 'whiteboard' }[opt.layout]
  : opt.ratio ? 'card' : 'long';
if (!layout) {
  console.error(`[render] 未知版式 "${opt.layout}"，可用：long、card、wechat、whiteboard（或用 --ratio 指定比例）`);
  process.exit(2);
}
if (['long', 'wechat', 'full', 'whiteboard'].includes(layout) && opt.ratio) {
  console.error(`[render] ${{ long: '长图', full: '原文长图', wechat: '公众号排版', whiteboard: '白板' }[layout]}没有固定比例；要出卡片请用卡片（--ratio）`);
  process.exit(2);
}
const ratio = layout === 'card' ? String(opt.ratio || '3:4').replace(/[x×/]/i, ':') : null;
let spec = null;
if (ratio) {
  try { spec = ratioSpec(ratio); } catch (e) { console.error('[render] ' + e.message); process.exit(2); }
}

// ---- article-driven pipelines: the input is an article (.md / folder), laid out verbatim ----
const input = path.resolve(positionals[0]);
const isArticle = /\.(md|markdown|txt)$/i.test(input) || (fs.existsSync(input) && fs.statSync(input).isDirectory());
async function runPipeline(modPath, fnName, extra = {}) {
  const mod = await import(modPath);
  const code = await mod[fnName](input, { opt, THEMES_DIR, readCss, listThemes, ...extra });
  process.stdout.write('', () => process.exit(code));
  await new Promise(() => {});
}
if (layout === 'whiteboard') await runPipeline('./lib/render-whiteboard.mjs', 'renderWhiteboard');
if (layout === 'wechat') await runPipeline('./lib/render-wechat-article.mjs', 'renderWechatArticle');
if (layout === 'full' || (layout === 'long' && isArticle)) await runPipeline('./lib/render-full.mjs', 'renderFullText');
if (layout === 'card' && isArticle) await runPipeline('./lib/render-cards-article.mjs', 'renderCardsArticle', { spec });

const contentPath = path.resolve(positionals[0]);
let content;
try {
  content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
} catch (e) {
  console.error(`[render] 无法读取 ${contentPath}：${e.message}`);
  process.exit(1);
}

// ---- brand ----
function loadBrand() {
  const candidates = [
    opt.brand,
    path.join(path.dirname(contentPath), 'brand.json'),
    path.join(process.cwd(), 'article2media.brand.json'),
    path.join(os.homedir(), '.config', 'article2media', 'brand.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return { ...JSON.parse(fs.readFileSync(p, 'utf8')), _from: p }; } catch { console.log(`⚠ brand 文件无法解析：${p}`); }
    }
  }
  return {};
}
const brand = resolveBrand({ ...loadBrand(), ...(content.brand || {}) }, { issue: opt.issue ?? content.issue });

// ---- validate ----
const { errors, warnings, info } = validate(content, { layout, ratio: ratio || '3:4' });
// Compared with the article it was written from (article.md next to content.json): numbers, voice, pictures.
const source = findSource(path.dirname(contentPath));
if (source && Array.isArray(content.pages)) warnings.push(...sourceChecks(content, source.text, { brand }));
for (const m of Array.isArray(content.pages) ? resolveImageFigures(content, path.dirname(contentPath)) : []) errors.push(`${m.where}：找不到图片文件 ${m.src}（本地图片的路径相对 content.json 所在目录）`);
if (warnings.length) {
  console.log(`⚠ 内容提示（${warnings.length}）：`);
  for (const w of warnings) console.log('  - ' + w);
}
if (errors.length) {
  console.log(`✗ 内容错误（${errors.length}），请修正 content.json：`);
  for (const e of errors) console.log('  - ' + e);
  if (opt.check) console.log(`\n内容检查：${errors.length} 个错误，${warnings.length} 个提示。`);
  process.exit(1);
}
const nSec = content.pages.reduce((a, p) => a + p.sections.length, 0);
const layoutDesc = layout === 'card' ? (opt.covers ? '，只出封面的各个版本' : opt.form ? `，形态：${opt.form}` : `，将生成 ${info.cards === info.cardsMax ? info.cards : `${info.cards}–${info.cardsMax}`} 张 ${spec.name} 卡片${info.cards === info.cardsMax ? '' : '（清单分页出图时才定）'}`) : `，版式：${opt.wide || ['magazine', 'wide'].includes(opt.layout) ? '宽版杂志长图（1200）' : '手机长图（1080 宽）'}`;
console.log(`✓ content.json 校验通过：${content.pages.length} 页，${nSec} 节${layoutDesc}`);
if (opt.check) {
  if (warnings.length) console.log(`还有 ${warnings.length} 条提示：逐条处理到 0，再出图。`);
  else console.log(`脚本查不了、要你自己看一遍的：
  - 每个 heading 是一个判断或动作，不是话题名；
  - 正文转述作者用"他说 / 她认为 / 作者说"（不确定性别就用名字或"作者"），你自己归纳的面板标题写"· 编者归纳"；
  - 每张大数字卡、金句卡，说的正是这一节标题讲的那件事。`);
  if (!source) console.log('（没找到同目录的 article.md，跳过了和原文的比对：数字来源、配图、人称。）');
  console.log(`\n内容检查：0 个错误，${warnings.length} 个提示。`);
  process.exit(0);
}

// Lighter forms and cover variants are cut from the same content.json as the full card set.
const form = opt.form ? { quotes: 'quotes', quote: 'quotes', '金句': 'quotes', onepage: 'onepage', 'one-page': 'onepage', '一页': 'onepage', qa: 'qa', '问答': 'qa' }[opt.form] : '';
if (opt.form && !form) { console.error(`[render] 未知形态 "${opt.form}"，可用：${FORMS.join('、')}`); process.exit(2); }
if ((form || opt.covers) && layout !== 'card') { console.error('[render] --form / --covers 只用于卡片（加 --ratio，或用 image-cards 的 cards.mjs）'); process.exit(2); }
if (form === 'qa' && !(Array.isArray(content.qa) && content.qa.length)) { console.error('[render] 问答形态需要 content.json 里的 "qa": [{"q": "问题", "a": "回答"}, …]'); process.exit(1); }

// ---- themes ----
const available = listThemes().map((t) => t.name);
const themeKey = { card: 'cards', long: 'long' }[layout];
const contentTheme = typeof content.theme === 'object' && content.theme ? content.theme[themeKey] || content.theme.long : content.theme;
const themeArg = opt.theme || contentTheme || 'editorial';
const themeSource = opt.theme ? '' : contentTheme ? '（content.json 指定）' : '（默认）';
const themes = themeArg === 'all' ? CATALOG.main : themeArg === 'legacy' ? Object.keys(CATALOG.legacy) : themeArg.split(',').map((s) => s.trim()).filter(Boolean);
for (const t of themes) {
  if (!available.includes(t)) {
    console.error(`[render] 没有主题 "${t}"。可用：${available.join(', ')}`);
    process.exit(2);
  }
}
if (themeSource) console.log(`主题：${themes.join(', ')}${themeSource}`);

const scale = Math.max(1, Math.min(4, Number(opt.scale) || 2));
const format = opt.format === 'jpeg' || opt.format === 'jpg' ? 'jpeg' : 'png';
const ext = format === 'jpeg' ? 'jpg' : 'png';
const quality = Number(opt.quality);
// Long pages: phone width (one column) unless --wide / --layout magazine asks for the 1200 px two-column page.
const wide = opt.wide || ['magazine', 'wide'].includes(opt.layout);
const longW = wide ? 1200 : 540;
const maxHeight = Number(opt['max-height']) || (layout === 'long' && !wide ? 7600 : 4400);
const pageFilter = opt.page ? new Set(opt.page.split(',').map((n) => Number(n.trim()))) : null;
const baseOut = path.resolve(opt.out || path.dirname(contentPath));
const outDirFor = (theme) => {
  const sub = layout === 'card' ? `${theme}-${spec.slug}${opt.covers ? '-covers' : form ? `-${form}` : ''}` : theme;
  return themes.length > 1 || !opt.out ? path.join(baseOut, sub) : baseOut;
};

async function renderLong(browser, theme, themeCss, nAcc, outDir, report) {
  const layoutCss = COMPONENTS_CSS + '\n' + readCss('long.css') + (wide ? '' : '\n' + readCss('long-mobile.css'));
  for (let pi = 0; pi < content.pages.length; pi++) {
    if (pageFilter && !pageFilter.has(pi + 1)) continue;
    const name = `page-${String(pi + 1).padStart(2, '0')}`;
    const htmlPath = path.join(outDir, `${name}.html`);
    fs.writeFileSync(htmlPath, buildPage(pi, { content, brand, themeCss, layoutCss, nAcc, wide }));
    const entry = { theme, label: `第 ${pi + 1} 页`, html: htmlPath };
    if (browser) {
      const page = await browser.newPage();
      try {
        await page.setViewport(longW, 1600, scale);
        await page.goto(pathToFileURL(htmlPath).href);
        const fontStatus = await page.settle(25000);
        const qa = await page.evaluate(qaInPage, { maxHeight });
        // Chrome cannot capture more than ~16000 device px in one image: a taller page is captured at a lower scale.
        const shot = Math.min(scale, Math.floor((16000 / qa.height) * 100) / 100);
        if (shot < scale) qa.issues.push({ level: 'warn', where: '整页', msg: `页面太高，按 ${shot} 倍输出（宽 ${Math.round(qa.width * shot)}px）：拆成两页可恢复 ${scale} 倍清晰度` });
        await page.setViewport(qa.width, qa.height, shot);
        const buf = await page.screenshot({ clip: { x: 0, y: 0, width: qa.width, height: qa.height }, format, quality });
        const imgPath = path.join(outDir, `${name}.${ext}`);
        fs.writeFileSync(imgPath, buf);
        if (fontStatus === 'timeout') qa.issues.push({ level: 'warn', where: '字体', msg: '等待网络字体超时，部分文字可能使用了回退字体' });
        Object.assign(entry, { image: imgPath, size: `${Math.round(qa.width * shot)}×${Math.round(qa.height * shot)}`, kb: Math.round(buf.length / 1024), issues: qa.issues });
      } finally {
        await page.close();
      }
    }
    report.push(entry);
  }
}

async function renderCards(browser, theme, themeCss, nAcc, outDir, report) {
  const htmlPath = path.join(outDir, 'cards.html');
  const build = (budgetAdjust) => {
    const r = buildCards({ content, brand, themeCss, componentsCss: COMPONENTS_CSS, layoutCss: readCss('card.css'), nAcc, ratio, budgetAdjust, form, covers: opt.covers ? coverVariants(content) : null });
    fs.writeFileSync(htmlPath, r.html);
    styles = r.styles;
    return r.count;
  };
  let styles = null; // cover variants: the layout of each one, for file names
  const stem = opt.covers ? 'cover' : form === 'quotes' ? 'quote' : form === 'onepage' ? 'onepage' : form === 'qa' ? 'qa' : 'card';
  const fileOf = (idx) => `${stem}-${String(idx).padStart(2, '0')}${styles ? `-${styles[idx - 1]}` : ''}.${ext}`;
  const what = opt.covers ? '个封面版本' : form === 'quotes' ? `张 ${ratio} 金句图` : form === 'onepage' ? `张 ${ratio} 一页看完` : form === 'qa' ? `张 ${ratio} 问答卡` : `张 ${ratio} 卡片`;
  let count = build(0);
  const captionPath = path.join(outDir, 'caption.md');
  const entry = { theme, label: `${count} ${what}`, html: htmlPath, ...(form || opt.covers ? {} : { caption: captionPath }) };
  if (browser) {
    const page = await browser.newPage();
    try {
      await page.setViewport(1800, 1200, scale);
      // Checklist stages are packed into cards by estimated height. If a packed card still overflows,
      // shrink the packing budget by the measured overflow and rebuild (at most 3 passes).
      let qa, fontStatus, adjust = 0;
      for (let pass = 0; pass < 3; pass++) {
        await page.goto(pathToFileURL(htmlPath).href);
        fontStatus = await page.settle(25000);
        qa = await page.evaluate(qaInPage, { maxHeight });
        const over = Math.max(0, ...qa.cards.filter((c) => c.kind === 'stages' || c.kind === 'guard' || c.kind === 'qa').map((c) => c.over));
        if (over <= 1) break;
        adjust += over + 8;
        count = build(adjust);
      }
      entry.label = `${count} ${what}`;
      await page.setViewport(qa.width, qa.height, scale);
      let kb = 0;
      for (const c of qa.cards) {
        if (pageFilter && !pageFilter.has(c.idx)) continue;
        const buf = await page.screenshot({ clip: { x: c.x, y: c.y, width: c.width, height: c.height }, format, quality });
        fs.writeFileSync(path.join(outDir, fileOf(c.idx)), buf);
        kb += buf.length / 1024;
      }
      // Contact sheet: every card in one small image, for a quick visual review.
      const overview = await page.screenshot({ clip: { x: 0, y: 0, width: qa.width, height: qa.height, scale: 0.6 / scale }, format: 'jpeg', quality: 82 });
      const overviewPath = path.join(outDir, 'overview.jpg');
      fs.writeFileSync(overviewPath, overview);
      if (fontStatus === 'timeout') qa.issues.push({ level: 'warn', where: '字体', msg: '等待网络字体超时，部分文字可能使用了回退字体' });
      Object.assign(entry, {
        image: count > 1 ? path.join(outDir, `${fileOf(1)} … ${fileOf(count)}`) : path.join(outDir, fileOf(1)),
        overview: overviewPath,
        size: `${spec.w * scale}×${spec.h * scale}`,
        kb: Math.round(kb),
        issues: qa.issues,
      });
    } finally {
      await page.close();
    }
  }
  if (!form && !opt.covers) fs.writeFileSync(captionPath, buildCaption(content, count));
  // Remove stale images from an earlier run that produced more cards (or differently named variants).
  const keep = new Set(Array.from({ length: count }, (_, i) => fileOf(i + 1)));
  for (const f of fs.readdirSync(outDir)) {
    if (new RegExp(`^${stem}-\\d+.*\\.(png|jpg)$`).test(f) && browser && !keep.has(f) && !pageFilter) fs.rmSync(path.join(outDir, f));
  }
  report.push(entry);
}

const report = [];
let browser;
try {
  if (!opt['html-only']) browser = await launchBrowser();
  for (const theme of themes) {
    const themeCss = fs.readFileSync(path.join(THEMES_DIR, `${theme}.css`), 'utf8') + brandCss(brand);
    const nAcc = Math.max(1, new Set(themeCss.match(/--accent-\d+\s*:/g) || []).size);
    const outDir = outDirFor(theme);
    fs.mkdirSync(outDir, { recursive: true });
    // AI illustrations: point each one at this theme's cached image (or another theme's, or a placeholder).
    const ill = resolveIllustrations(content, theme, path.dirname(contentPath));
    const before = report.length;
    if (layout === 'card') await renderCards(browser, theme, themeCss, nAcc, outDir, report);
    else await renderLong(browser, theme, themeCss, nAcc, outDir, report);
    const illIssues = [
      ...ill.missing.map((m) => ({ level: 'warn', where: m.where, msg: 'AI 插画还没生成，图里是占位框：先运行 article-rewrite 的 illustrate.mjs' })),
      ...ill.borrowed.map((b) => ({ level: 'warn', where: b.where, msg: `借用了 ${b.from} 主题的插画；要画风一致，运行 article-rewrite 的 illustrate.mjs --theme ${theme}` })),
    ];
    if (illIssues.length && report[before]) (report[before].issues ||= []).push(...illIssues);
  }
} catch (e) {
  console.error('[render] 失败：' + e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}

// ---- report ----
let nErr = 0, nWarn = 0;
for (const r of report) {
  const sizeNote = r.size ? `  (${r.size}${/张图/.test(r.size) ? '' : 'px'}, ${r.kb} KB)` : '';
  console.log(`\n[${r.theme}] ${r.label} → ${r.image || r.html}${sizeNote}`);
  if (r.overview) console.log(`  总览：${r.overview}`);
  if (r.covers) console.log(`  封面：${r.covers}`);
  if (r.notes) console.log(`  发布信息：${r.notes}`);
  if (r.caption) console.log(`  文案：${r.caption}`);
  for (const i of r.issues || []) {
    if (i.level === 'error') nErr++; else nWarn++;
    console.log(`  ${i.level === 'error' ? '✗' : '⚠'} ${i.where}：${i.msg}`);
  }
}
if (report.length) {
  const qaPath = path.join(path.dirname(report[0].html), 'qa.json');
  fs.writeFileSync(qaPath, JSON.stringify(report, null, 2));
  console.log(`\n版面检查：${nErr} 个错误，${nWarn} 个提示。${nErr ? '错误必须修复后重新渲染。' : ''}`);
}
// Exit explicitly: a half-closed DevTools socket can otherwise keep the event loop alive after Chrome quits.
// Wait for stdout to drain first (pipes are asynchronous on macOS).
process.stdout.write('', () => process.exit(process.exitCode ?? 0));
