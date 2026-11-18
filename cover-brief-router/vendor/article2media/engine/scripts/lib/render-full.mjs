// Pipeline for the "full" layout (-f): lock the source, build the block ledger, render, verify verbatim, capture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './chrome.mjs';
import { loadArticle, articlePath, buildFullPage, readbackInPage, compareLedger, localizeImages, sha256, contrastInPage } from './layout-full.mjs';

const MAX_PAGE = 7400; // CSS px per PNG (×2 = 14 800 px, safely under the 16 384 px capture limit)

function loadBrand(dir) {
  for (const p of [path.join(dir, 'brand.json'), path.join(process.cwd(), 'article2media.brand.json'), path.join(os.homedir(), '.config', 'article2media', 'brand.json')]) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  return {};
}

export async function renderFullText(input, { opt, THEMES_DIR, readCss }) {
  // Input: article.md, or a content.json / directory next to one.
  const src = articlePath(input);
  if (!fs.existsSync(src)) { console.error(`[render] 原文长图需要文章：找不到 ${src}`); return 2; }
  const { raw, sha: hash0, meta, blocks, ledger, issues } = loadArticle(src);
  const dir = path.dirname(src);
  const useTheme = !!opt.theme;
  const theme = opt.theme || '';
  if (useTheme && !fs.existsSync(path.join(THEMES_DIR, `${theme}.css`))) { console.error(`[render] 没有主题 "${theme}"`); return 2; }
  const outDir = path.resolve(opt.out || path.join(dir, useTheme ? `${theme}-full` : 'full'));
  fs.mkdirSync(path.join(outDir, 'review'), { recursive: true });
  const images = await localizeImages(blocks, path.join(dir, 'source-images'), dir);
  const html = buildFullPage({ blocks, meta, images, brand: loadBrand(dir), useTheme, themeCss: useTheme ? fs.readFileSync(path.join(THEMES_DIR, `${theme}.css`), 'utf8') : '', fullCss: readCss('full.css') });
  const htmlPath = path.join(outDir, 'full.html');
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(path.join(outDir, 'ledger.json'), JSON.stringify({ version: 1, source: src, source_sha256: hash0, blocks: ledger }, null, 1));
  console.log(`全文：${path.basename(src)}，${ledger.length} 个原文块，${blocks.filter((b) => b.kind === 'figure').length} 张原文配图（生成图 0）${useTheme ? `，主题 ${theme}` : '，白底阅读面'}`);

  const browser = await launchBrowser();
  const pages = [];
  let fonts = {}, totalH = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport(540, 960, 2);
    await page.goto(pathToFileURL(htmlPath).href);
    const fontStatus = await page.settle(30000);
    if (fontStatus === 'timeout') issues.push({ level: 'warn', where: '字体', msg: '网络字体加载超时，部分文字用了回退字体' });

    // 1) Verbatim check: DOM text of every block equals the ledger.
    const rb = await page.evaluate(readbackInPage);
    for (const f of compareLedger(ledger, rb)) issues.push({ level: 'error', where: '全文校验', msg: f });
    const contrast = await page.evaluate(contrastInPage);
    if (contrast !== null && contrast < 4.5) issues.push({ level: 'error', where: '对比度', msg: `正文和底色对比度只有 ${contrast}:1（至少 4.5:1）` });

    // 2) Fonts actually used (not just declared) for body, title and section headings.
    await page.send('DOM.enable'); await page.send('CSS.enable');
    const { root } = await page.send('DOM.getDocument', { depth: -1 });
    for (const [label, sel] of [['正文', '.full-document p'], ['标题', '.full-document h1'], ['小标题', '.full-document h2']]) {
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      if (!nodeId) continue;
      const r = await page.send('CSS.getPlatformFontsForNode', { nodeId });
      fonts[label] = (r.fonts || []).sort((a, b) => b.glyphCount - a.glyphCount).map((f) => f.familyName)[0] || '?';
    }

    // 3) Images loaded, no horizontal overflow, body size.
    const m = await page.evaluate(() => {
      const imgs = [...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.alt);
      const p = document.querySelector('.full-document p');
      const cs = p ? getComputedStyle(p) : null;
      const kids = [...document.querySelector('.full-document').children].map((e) => { const r = e.getBoundingClientRect(); return [r.top + scrollY, r.bottom + scrollY]; });
      const page = document.querySelector('.full-page').getBoundingClientRect();
      return { broken: imgs, overflow: document.documentElement.scrollWidth > 541, fontSize: cs ? parseFloat(cs.fontSize) : 0, lineHeight: cs ? parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) : 0, kids, height: Math.ceil(page.height) };
    });
    if (m.broken.length) issues.push({ level: 'error', where: '配图', msg: `${m.broken.length} 张原文配图没有加载出来` });
    if (m.overflow) issues.push({ level: 'error', where: '版面', msg: '有内容横向溢出' });
    if (m.fontSize < 20 || m.lineHeight < 1.85) issues.push({ level: 'error', where: '正文字号', msg: `正文 ${m.fontSize * 2}px / ${m.lineHeight.toFixed(2)}，低于 40px / 1.9 的阅读下限` });
    totalH = m.height;

    // 4) Pages: cut only between top-level blocks, each page ≤ MAX_PAGE.
    const cuts = [0];
    let start = 0;
    for (let i = 0; i < m.kids.length; i++) {
      const [, bottom] = m.kids[i];
      if (bottom - start > MAX_PAGE && i > 0) {
        const cut = Math.round((m.kids[i - 1][1] + m.kids[i][0]) / 2);
        cuts.push(cut); start = cut;
      }
    }
    cuts.push(totalH);
    await page.setViewport(540, Math.min(totalH, 16000), 2);
    for (let k = 0; k < cuts.length - 1; k++) {
      const y = cuts[k], h = cuts[k + 1] - y;
      const name = cuts.length === 2 ? 'full.png' : `full-${String(k + 1).padStart(2, '0')}.png`;
      const buf = await page.screenshot({ clip: { x: 0, y, width: 540, height: h } });
      fs.writeFileSync(path.join(outDir, name), buf);
      pages.push({ file: path.join(outDir, name), height: h * 2 });
    }
    // 5) Overlapping review slices covering the whole height (for visual QA).
    const SL = 1200, OV = 150;
    let i = 0;
    for (let y = 0; y < totalH; y += SL - OV) {
      const h = Math.min(SL, totalH - y);
      fs.writeFileSync(path.join(outDir, 'review', `slice-${String(++i).padStart(2, '0')}.jpg`), await page.screenshot({ clip: { x: 0, y, width: 540, height: h, scale: 0.5 }, format: 'jpeg', quality: 80 }));
      if (y + h >= totalH) break;
    }
    await page.close();
  } finally {
    await browser.close();
  }
  const hash1 = sha256(fs.readFileSync(src));
  if (hash1 !== hash0) issues.push({ level: 'error', where: '原文', msg: '渲染期间原文文件被改动' });

  const report = { source: src, source_sha256: hash0, blocks: ledger.length, verify: issues.some((x) => x.where === '全文校验' || x.where === '原文解析') ? 'fail' : 'pass', fonts, pages, generated_images: 0, issues };
  fs.writeFileSync(path.join(outDir, 'qa.json'), JSON.stringify(report, null, 2));
  for (const p of pages) console.log(`→ ${p.file}（1080×${p.height}）`);
  console.log(`全文校验：${report.verify === 'pass' ? `通过（${ledger.length} / ${ledger.length} 块逐字一致）` : '未通过'}；实际字体：${Object.entries(fonts).map(([k, v]) => `${k} ${v}`).join('，')}`);
  console.log(`审片切片：${path.join(outDir, 'review')}（重叠切片覆盖全部高度）`);
  let nErr = 0, nWarn = 0;
  for (const x of issues) { if (x.level === 'error') nErr++; else nWarn++; console.log(`  ${x.level === 'error' ? '✗' : '⚠'} ${x.where}：${x.msg}`); }
  console.log(`\n版面检查：${nErr} 个错误，${nWarn} 个提示。`);
  return nErr ? 1 : 0;
}
