#!/usr/bin/env node
// Comic (-c): director's panel script (comic.json) → generated black-and-white panels → long comic PNG + 3:4 carousel.
//
//   node comic.mjs check  <comic.json>
//   node comic.mjs images <comic.json> [--fresh] [--provider codex|openai|gemini] [--parallel 3]
//   node comic.mjs render <comic.json> [--theme 名称]
//   node comic.mjs make   <comic.json>          # images + render
//
// The anchor panel (comic.anchor, default the first) is generated first and passed as a reference image to every
// other panel, so the character and the line style stay the same — on every provider (Codex: -i, OpenAI: images/edits,
// Gemini: an inline image part). Without an image provider the comic cannot be made.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { launchBrowser } from './lib/chrome.mjs';
import { generateImage, imageConfig, pickImageProvider } from './lib/imagegen.mjs';
import { checkComic, panelPrompt, panelAspect, buildComicPage, buildComicCards } from './lib/layout-comic.mjs';
import { frontMatter } from './lib/layout-full.mjs';

const MAX_PAGE = 7400; // CSS px per PNG (×2 = 14 800 px, under the 16 384 px capture limit); same as the verbatim long image

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
  theme: { type: 'string' }, fresh: { type: 'boolean', default: false }, provider: { type: 'string' }, parallel: { type: 'string', default: '3' },
} });
const [cmd, file] = positionals;
if (!cmd || !file) { console.error('用法：node comic.mjs <check|images|render|make> <comic.json>'); process.exit(2); }
const cPath = path.resolve(file);
const c = JSON.parse(fs.readFileSync(cPath, 'utf8'));
const dir = path.dirname(cPath);
const panelDir = path.join(dir, 'comic-panels');

const { errors, warnings } = checkComic(c);
for (const w of warnings) console.log(`⚠ ${w}`);
for (const e of errors) console.log(`✗ ${e}`);
if (errors.length) process.exit(1);
console.log(`✓ ${c.panels.length} 格（${c.panels.map((p) => p.role || p.id).join(' → ')}）`);
if (cmd === 'check') process.exit(0);

const fileOf = (p) => path.join(panelDir, `${p.id}.png`);

async function images() {
  let provider;
  try { provider = pickImageProvider(opt.provider); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
  if (!provider) { console.error('✗ 漫画需要出图能力：安装并登录 Codex CLI（codex login），或设置 OPENAI_API_KEY / GEMINI_API_KEY'); process.exit(2); }
  fs.mkdirSync(panelDir, { recursive: true });
  const anchor = c.panels.find((p) => p.id === c.anchor) || c.panels[0];
  let cropSaid = false;
  const gen = async (p, refs = []) => {
    const f = fileOf(p);
    if (fs.existsSync(f) && !opt.fresh) return;
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await generateImage(provider, panelPrompt(c, p), panelAspect(p), { refs });
        fs.writeFileSync(f, r.buf);
        console.log(`  ✓ ${p.id}（${p.role || ''}，${((Date.now() - t0) / 1000).toFixed(0)}s${refs.length ? '，参考 ' + anchor.id : ''}${r.provider !== provider ? `，由 ${r.provider} / ${r.model} 生成` : ''}）`);
        if (r.crop && !cropSaid) { cropSaid = true; console.log(`  ⚠ ${r.crop}`); }
        return;
      } catch (e) {
        console.log(`  ⚠ ${p.id} 第 ${attempt} 次失败：${e.message.slice(0, 160)}`);
        // A refusal, a missing login or an empty quota will not change on a second try.
        if (e.kind === 'refused') throw new Error(`${p.id} 的内容被拒绝（没有换别的服务重试）：改写这一格的画面描述`);
        if (['auth', 'quota'].includes(e.kind)) throw new Error(`${p.id} 没生成出来：${e.message.slice(0, 200)}`);
      }
    }
    throw new Error(`${p.id} 两次都没生成出来`);
  };
  console.log(`出图：${provider} / ${imageConfig().models[provider] || ''}，先生成锚点格 ${anchor.id} 校准角色与画风`);
  await gen(anchor);
  const rest = c.panels.filter((p) => p !== anchor);
  const refs = [{ path: fileOf(anchor), note: 'the recurring main character and the series line / screentone style' }];
  const pool = Math.max(1, Number(opt.parallel) || 3);
  for (let i = 0; i < rest.length; i += pool) await Promise.all(rest.slice(i, i + pool).map((p) => gen(p, refs)));
}

async function render() {
  const missing = c.panels.filter((p) => !fs.existsSync(fileOf(p)));
  if (missing.length) { console.error(`✗ 还有 ${missing.length} 格没生成：先运行 node comic.mjs images ${file}`); process.exit(1); }
  const theme = opt.theme || c.theme || '';
  const themeCss = theme ? fs.readFileSync(path.join(ROOT, 'themes', `${theme}.css`), 'utf8') : '';
  const css = fs.readFileSync(path.join(ROOT, 'layouts', 'comic.css'), 'utf8');
  const imgs = Object.fromEntries(c.panels.map((p) => [p.id, pathToFileURL(fileOf(p)).href]));
  let credit = c.credit || '';
  if (!credit && c.source && fs.existsSync(path.resolve(dir, c.source))) {
    const { meta } = frontMatter(fs.readFileSync(path.resolve(dir, c.source), 'utf8'));
    const platform = meta.platform || '';
    credit = `改编自 ${[meta.author, meta.handle].filter(Boolean).join(' ')} 的${/^[A-Za-z0-9]/.test(platform) ? ' ' : ''}${platform}`;
  }
  const outDir = path.join(dir, theme ? `${theme}-comic` : 'comic');
  fs.mkdirSync(path.join(outDir, 'review'), { recursive: true });
  const longHtml = path.join(outDir, 'comic.html'), cardsHtml = path.join(outDir, 'cards.html');
  fs.writeFileSync(longHtml, buildComicPage(c, { css, themeCss, images: imgs, credit }));
  fs.writeFileSync(cardsHtml, buildComicCards(c, { css, themeCss, images: imgs, credit }));
  const issues = [];
  const longFiles = [];
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // Long comic page.
    await page.setViewport(540, 960, 2);
    await page.goto(pathToFileURL(longHtml).href);
    await page.settle(30000);
    const m = await page.evaluate(() => ({
      h: Math.ceil(document.querySelector('.comic-page').getBoundingClientRect().height),
      // Panels' vertical extents: a long comic is cut only between panels.
      kids: [...document.querySelectorAll('.comic-page .panel')].map((e) => { const r = e.getBoundingClientRect(); return [r.top + scrollY, r.bottom + scrollY]; }),
      broken: [...document.images].filter((i) => !i.complete || !i.naturalWidth).length,
      overflow: [...document.querySelectorAll('.bubble, .narration, .sfx')].filter((b) => { const r = b.getBoundingClientRect(), p = b.closest('.panel-art').getBoundingClientRect(); return r.left < p.left - 1 || r.right > p.right + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1; }).map((b) => b.closest('.panel').dataset.panelId),
    }));
    if (m.broken) issues.push({ level: 'error', where: '分格', msg: `${m.broken} 张分格图没有加载` });
    for (const id of m.overflow) issues.push({ level: 'error', where: id, msg: '对白或旁白超出了分格：调整 x / y 或缩短文字' });
    await page.setViewport(540, Math.min(m.h, 16000), 2);
    // One PNG while it fits; a longer comic is split between panels (each part ≤ MAX_PAGE, under Chrome's capture limit).
    const cuts = [0];
    // gap = the last row boundary seen (half panels sit side by side, so not every panel starts a row).
    for (let k = 1, start = 0, gap = 0, floor = m.kids[0]?.[1] ?? 0; k < m.kids.length; k++) {
      if (m.kids[k][0] >= floor - 1) gap = Math.round((floor + m.kids[k][0]) / 2);
      if (m.kids[k][1] - start > MAX_PAGE && gap > start) { cuts.push(gap); start = gap; }
      floor = Math.max(floor, m.kids[k][1]);
    }
    cuts.push(m.h);
    for (const f of fs.readdirSync(outDir)) if (/^comic(-\d+)?\.png$/.test(f)) fs.rmSync(path.join(outDir, f));
    for (let k = 0; k + 1 < cuts.length; k++) {
      const name = cuts.length === 2 ? 'comic.png' : `comic-${String(k + 1).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(outDir, name), await page.screenshot({ clip: { x: 0, y: cuts[k], width: 540, height: cuts[k + 1] - cuts[k] } }));
      longFiles.push(name);
    }
    let i = 0;
    for (let y = 0; y < m.h; y += 1050) { const h = Math.min(1200, m.h - y); fs.writeFileSync(path.join(outDir, 'review', `slice-${String(++i).padStart(2, '0')}.jpg`), await page.screenshot({ clip: { x: 0, y, width: 540, height: h, scale: 0.5 }, format: 'jpeg', quality: 80 })); if (y + h >= m.h) break; }
    // 3:4 carousel.
    await page.setViewport(1800, 1200, 2);
    await page.goto(pathToFileURL(cardsHtml).href);
    await page.settle(30000);
    const cards = await page.evaluate(() => [...document.querySelectorAll('.ccard')].map((e) => { const r = e.getBoundingClientRect(); return { idx: Number(e.dataset.card), x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, over: e.scrollHeight - e.clientHeight }; }));
    const sheet = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    await page.setViewport(sheet.w, sheet.h, 2);
    for (const k of cards) {
      if (k.over > 1) issues.push({ level: 'error', where: `卡 ${k.idx}`, msg: `内容超出 ${k.over}px：缩短旁白` });
      fs.writeFileSync(path.join(outDir, `card-${String(k.idx).padStart(2, '0')}.png`), await page.screenshot({ clip: { x: k.x, y: k.y, width: k.w, height: k.h } }));
    }
    // Clip the overview to the card grid (plus the same margin on the right as on the left), not the whole viewport.
    const left = Math.min(...cards.map((k) => k.x)), right = Math.max(...cards.map((k) => k.x + k.w));
    const ow = Math.min(sheet.w, Math.ceil(right + left));
    fs.writeFileSync(path.join(outDir, 'overview.jpg'), await page.screenshot({ clip: { x: 0, y: 0, width: ow, height: sheet.h, scale: 0.3 }, format: 'jpeg', quality: 82 }));
    await page.close();
  } finally { await browser.close(); }
  console.log(`→ ${path.join(outDir, longFiles[0])}${longFiles.length > 1 ? ` … ${longFiles.at(-1)}（长漫画，超长分成 ${longFiles.length} 张）` : '（长漫画）'}`);
  console.log(`→ ${path.join(outDir, 'card-01.png')} …（${c.panels.length + 2} 张 3:4 卡片），总览 overview.jpg`);
  let nErr = 0;
  for (const x of issues) { if (x.level === 'error') nErr++; console.log(`  ${x.level === 'error' ? '✗' : '⚠'} ${x.where}：${x.msg}`); }
  console.log(`\n版面检查：${nErr} 个错误，生成图 ${c.panels.length} 张。`);
  return nErr ? 1 : 0;
}

let code = 0;
if (cmd === 'images' || cmd === 'make') { try { await images(); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); } }
if (cmd === 'render' || cmd === 'make') code = await render();
process.stdout.write('', () => process.exit(code));
