#!/usr/bin/env node
// Export a content.json (改写稿) as an article: rewrite.md + figure images, for article-only layouts (公众号排版).
//
//   node export.mjs <content.json> [--theme 名称] [--out 目录] [--brand brand.json]
//
// → <dir>/rewrite.md, <dir>/rewrite-assets/fig-1A.png …（图表按主题截成 3 倍图）, hero.png（有封面插画时）
// The figure images carry the theme's colors, so render 公众号 with the same theme (written into the front matter).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validate } from './lib/validate.mjs';
import { buildWechatSource } from './lib/layout-wechat.mjs';
import { resolveIllustrations, resolveImageFigures } from './lib/illustrations.mjs';
import { qaInPage } from './lib/qa.mjs';
import { launchBrowser } from './lib/chrome.mjs';
import { contentToMarkdown } from './lib/rewrite-md.mjs';
import { loadArticle } from './lib/layout-full.mjs';
import { loadBrand } from './lib/brand.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readCss = (n) => fs.readFileSync(path.join(ROOT, 'layouts', n), 'utf8');
const CLI = process.env.A2M_CLI || 'export.mjs';
const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
  theme: { type: 'string', short: 't' }, out: { type: 'string', short: 'o' }, brand: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
if (opt.help || !positionals[0]) { console.error(`用法：node ${CLI} <content.json> [--theme 名称] [--out 目录]`); process.exit(opt.help ? 0 : 2); }

const contentPath = path.resolve(positionals[0]);
let content;
try { content = JSON.parse(fs.readFileSync(contentPath, 'utf8')); } catch (e) { console.error(`✗ 无法读取 ${contentPath}：${e.message}`); process.exit(1); }
const { errors, warnings } = validate(content, { layout: 'wechat' });
for (const w of warnings) console.log(`⚠ ${w}`);
if (errors.length) { for (const e of errors) console.log(`✗ ${e}`); console.log('content.json 有错误，先修正再导出'); process.exit(1); }

const dir = path.dirname(contentPath);
const outDir = path.resolve(opt.out || dir);
const theme = opt.theme || (typeof content.theme === 'object' && content.theme ? content.theme.wechat || content.theme.long : content.theme) || 'editorial';
const themePath = path.join(ROOT, 'themes', `${theme}.css`);
if (!fs.existsSync(themePath)) { console.error(`✗ 没有主题 "${theme}"`); process.exit(2); }
const themeCss = fs.readFileSync(themePath, 'utf8');
const nAcc = Math.max(1, new Set(themeCss.match(/--accent-\d+\s*:/g) || []).size);
const brand = { ...loadBrand({ file: opt.brand, dir }), ...(content.brand || {}) };
const ill = resolveIllustrations(content, theme, dir);
const missingImages = resolveImageFigures(content, dir);

const assets = path.join(outDir, 'rewrite-assets');
fs.mkdirSync(assets, { recursive: true });
for (const f of fs.readdirSync(assets)) if (/^(fig-.*|hero)\.png$/.test(f)) fs.rmSync(path.join(assets, f));
const srcPath = path.join(assets, 'figures.html');
fs.writeFileSync(srcPath, buildWechatSource({ content, brand, themeCss, componentsCss: readCss('components.css'), wechatCss: readCss('wechat.css'), nAcc }));

const issues = ill.missing.map((m) => ({ level: 'error', where: m.where, msg: 'AI 插画还没生成（导出的会是占位框）：先运行 illustrate.mjs，生成不了就去掉插画字段' }));
for (const m of missingImages) issues.push({ level: 'error', where: m.where, msg: `找不到图片文件 ${m.src}（路径相对 content.json 所在目录）` });
const figs = {};
let hero = '';
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  // Figures at 3x of the 公众号 column width (~340 px on 3x phone screens), as the old 公众号 layout did.
  await page.setViewport(375, 900, 3);
  await page.goto(pathToFileURL(srcPath).href);
  if ((await page.settle(25000)) === 'timeout') issues.push({ level: 'warn', where: '字体', msg: '等待网络字体超时，图表里的文字可能使用了回退字体' });
  const qa = await page.evaluate(qaInPage, { maxHeight: 1e9 });
  issues.push(...qa.issues.filter((i) => /^图 /.test(i.where)));
  const shots = await page.evaluate(() => {
    const col = document.getElementById('wx').getBoundingClientRect();
    return [...document.querySelectorAll('[data-shot]')].map((el) => {
      const r = el.getBoundingClientRect();
      const m = Math.min(10, r.left - col.left, col.right - r.right);
      return { id: el.dataset.shot, x: r.left - m + scrollX, y: r.top - m + scrollY, width: r.width + 2 * m, height: r.height + 2 * m };
    });
  });
  for (const s of shots) {
    if (s.id === 'hero' && ill.missing.some((m) => m.kind === 'cover')) continue;
    const file = path.join(assets, `${s.id}.png`);
    fs.writeFileSync(file, await page.screenshot({ clip: { x: s.x, y: s.y, width: s.width, height: s.height } }));
    const rel = path.relative(outDir, file).split(path.sep).join('/');
    if (s.id === 'hero') hero = rel; else figs[s.id.replace(/^fig-/, '')] = rel;
  }
  await page.close();
} finally {
  await browser.close();
}

const mdPath = path.join(outDir, 'rewrite.md');
fs.writeFileSync(mdPath, contentToMarkdown(content, { theme, figs, hero, brand }));
// The exported article must parse back to exactly its own text (no stray Markdown in the content).
const back = loadArticle(mdPath);
for (const x of back.issues) issues.push({ ...x, where: '导出文章' });
fs.rmSync(srcPath, { force: true });

console.log(`✓ 改写稿 → 文章：${mdPath}`);
console.log(`  ${back.ledger.length} 个正文块，${Object.keys(figs).length} 张图表图片${hero ? ' + 题图' : ''}（主题 ${theme}，在 ${path.relative(process.cwd(), assets) || assets}）`);
console.log(`  排公众号：wechat-layout 的 wechat.mjs ${path.relative(process.cwd(), mdPath)}（图表按 ${theme} 截的图，公众号也用 ${theme}；换主题先用 --theme 重新导出）`);
let nErr = 0, nWarn = 0;
for (const x of issues) { if (x.level === 'error') nErr++; else nWarn++; console.log(`  ${x.level === 'error' ? '✗' : '⚠'} ${x.where}：${x.msg}`); }
console.log(`\n版面检查：${nErr} 个错误，${nWarn} 个提示。`);
process.stdout.write('', () => process.exit(nErr ? 1 : 0));
